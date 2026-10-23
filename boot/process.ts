import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { Server } from "node:net";
import { startFront } from "./front.ts";

// Nothing outside this process restarts the gateway (exe.dev's init does not), so it does.
const GATEWAY_RESTART_MS = 1_000;
const GATEWAY_RESTART_MAX_MS = 60_000;
const GATEWAY_HEALTHY_MS = 5 * 60_000;
// A standby that is not warm by then is stopped, and the running gateway keeps serving.
const STANDBY_WARM_MS = 180_000;

export type GatewayOptions = {
  // The public port. With it the gateway listens on one of `ports` behind it, and SIGUSR2 hands over
  // to a standby gateway on the other (#110): the standby warms up beside the running gateway, which
  // stops only once it is warm.
  frontPort?: number;
  ports?: [number, number];
  // Runs before a standby starts, to write the config and prompt it boots with.
  prepare?: () => Promise<void>;
  warmModules?: string;
  entry?: string;
};

export async function startGateway(captureOutput = false, mcpUrl?: string, writeLog?: (chunk: Buffer) => void, options: GatewayOptions = {}) {
  const entry = options.entry ?? "/app/openclaw.mjs";
  // Loopback, beside the MCP bridge's 18790, clear of the dev dashboard's 3001.
  const ports = options.ports ?? [18801, 18802];
  const children = new Set<ChildProcess>();
  let stopping = false;
  let restartTimer: NodeJS.Timeout | undefined;
  let gatewayTimer: NodeJS.Timeout | undefined;
  let gatewayDelay = GATEWAY_RESTART_MS;
  let timer: NodeJS.Timeout | undefined;
  let front: Server | undefined;
  let port = ports[0];
  // The gateway that owns the state, or will once the one it replaced exits.
  let current: ChildProcess | undefined;
  let standby: ChildProcess | undefined;
  let takingOver = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(restartTimer);
    clearTimeout(gatewayTimer);
    front?.close();
    for (const child of children) child.kill("SIGTERM");
    timer = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, 30_000);
    if (!children.size) release();
  };
  const release = () => {
    clearTimeout(timer);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    process.off("SIGUSR2", takeover);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const launch = (label: string, args: string[], options: SpawnOptions) => {
    const child = spawn(process.execPath, args, options);
    const startedAt = Date.now();
    children.add(child);
    if (!captureOutput) {
      child.stdout?.on("data", (chunk: Buffer) => { process.stdout.write(chunk); writeLog?.(chunk); });
      child.stderr?.on("data", (chunk: Buffer) => { process.stderr.write(chunk); writeLog?.(chunk); });
    } else if (writeLog) {
      child.stdout?.on("data", writeLog);
      child.stderr?.on("data", writeLog);
    }
    child.on("error", error => console.error(error));
    child.on("close", (code, signal) => {
      children.delete(child);
      if (label === "bridge" && !stopping) {
        console.error(`plow-boot: bridge exited code=${code} signal=${signal}; restarting in 1s`);
        restartTimer = setTimeout(startBridge, 1000);
        return;
      }
      if (label !== "bridge" && child !== current) {
        // A gateway a takeover replaced, or a standby that never took over: the current one serves on.
        if (child === standby) { standby = undefined; takingOver = false; }
        console.error(`plow-boot: ${label === "standby" ? "standby" : "replaced"} gateway exited code=${code} signal=${signal}`);
        if (stopping && !children.size) release();
        return;
      }
      if (label !== "bridge" && !stopping) {
        current = undefined;
        if (Date.now() - startedAt >= GATEWAY_HEALTHY_MS) gatewayDelay = GATEWAY_RESTART_MS;
        console.error(`plow-boot: gateway exited code=${code} signal=${signal}; restarting in ${gatewayDelay / 1000}s`);
        gatewayTimer = setTimeout(startGatewayProcess, gatewayDelay);
        gatewayDelay = Math.min(gatewayDelay * 2, GATEWAY_RESTART_MAX_MS);
        return;
      }
      if (label !== "bridge") console.error(`plow-boot: gateway exited code=${code} signal=${signal}`);
      stop();
      if (!children.size) release();
    });
    return child;
  };
  const startBridge = () => launch("bridge", ["/opt/plow/boot/mcp-bridge.js"], {
    stdio: captureOutput ? ["ignore", "inherit", "inherit", "ipc"] : ["ignore", "pipe", "pipe", "ipc"],
    env: { PLOW_MCP_URL: mcpUrl!, PLOW_AGENT_TOKEN: process.env.PLOW_AGENT_TOKEN, PLOW_MCP_BRIDGE_TOKEN: process.env.PLOW_MCP_BRIDGE_TOKEN },
  });
  const gatewayArgs = (listen: number) => front ? [entry, "gateway", "--port", String(listen)] : [entry, "gateway"];
  const startGatewayProcess = () => current = launch("gateway", gatewayArgs(port), {
    stdio: ["ignore", "pipe", "pipe"], env: process.env,
  });
  async function takeover() {
    if (stopping || takingOver || !current) return;
    takingOver = true;
    try {
      await options.prepare?.();
    } catch (error) {
      console.error(`plow-boot: takeover not started: ${error instanceof Error ? error.message : String(error)}`);
      takingOver = false;
      return;
    }
    if (stopping) return;
    const next = port === ports[0] ? ports[1] : ports[0];
    const child = standby = launch("standby", gatewayArgs(next), {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, OPENCLAW_GATEWAY_STANDBY: "1", OPENCLAW_GATEWAY_WARM_MODULES: options.warmModules },
    });
    console.error(`plow-boot: standby gateway starting on :${next}`);
    const notWarm = setTimeout(() => {
      console.error(`plow-boot: standby gateway not warm after ${STANDBY_WARM_MS / 1000}s; keeping the gateway on :${port}`);
      child.kill("SIGTERM");
    }, STANDBY_WARM_MS);
    child.once("close", () => clearTimeout(notWarm));
    // Sent once by the patched OpenClaw as it starts waiting on the state lock.
    child.once("message", () => {
      clearTimeout(notWarm);
      if (stopping || standby !== child) return;
      // From here new connections wait in the front for the standby, which takes the state lock
      // the moment the old gateway exits. A restart pending for a gateway that died meanwhile is
      // the standby's to take.
      const old = current;
      console.error(`plow-boot: standby gateway warm on :${next}; ${old ? `stopping the gateway on :${port}` : "taking over"}`);
      clearTimeout(gatewayTimer);
      current = child;
      standby = undefined;
      takingOver = false;
      port = next;
      if (!old) return;
      old.kill("SIGTERM");
      const kill = setTimeout(() => old.kill("SIGKILL"), 30_000);
      old.once("close", () => clearTimeout(kill));
    });
  }
  if (options.frontPort !== undefined) {
    front = await startFront(options.frontPort, () => port);
    process.on("SIGUSR2", takeover);
  }
  if (mcpUrl) {
    const bridge = startBridge();
    await new Promise(resolve => { bridge.once("message", resolve); bridge.once("close", resolve); });
    if (stopping) return bridge;
  }
  return startGatewayProcess();
}
