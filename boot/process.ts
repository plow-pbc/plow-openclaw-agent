import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

// Nothing outside this process restarts the gateway (exe.dev's init does not), so it does.
const GATEWAY_RESTART_MS = 1_000;
const GATEWAY_RESTART_MAX_MS = 60_000;
const GATEWAY_HEALTHY_MS = 5 * 60_000;

export async function startGateway(captureOutput = false, mcpUrl?: string, writeLog?: (chunk: Buffer) => void) {
  const children = new Set<ChildProcess>();
  let stopping = false;
  let restartTimer: NodeJS.Timeout | undefined;
  let gatewayTimer: NodeJS.Timeout | undefined;
  let gatewayDelay = GATEWAY_RESTART_MS;
  let timer: NodeJS.Timeout | undefined;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(restartTimer);
    clearTimeout(gatewayTimer);
    for (const child of children) child.kill("SIGTERM");
    timer = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, 30_000);
    if (!children.size) release();
  };
  const release = () => {
    clearTimeout(timer);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
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
    }
    child.on("error", error => console.error(error));
    child.on("close", (code, signal) => {
      children.delete(child);
      if (label === "bridge" && !stopping) {
        console.error(`plow-boot: bridge exited code=${code} signal=${signal}; restarting in 1s`);
        restartTimer = setTimeout(startBridge, 1000);
        return;
      }
      if (label === "gateway" && !stopping) {
        if (Date.now() - startedAt >= GATEWAY_HEALTHY_MS) gatewayDelay = GATEWAY_RESTART_MS;
        console.error(`plow-boot: gateway exited code=${code} signal=${signal}; restarting in ${gatewayDelay / 1000}s`);
        gatewayTimer = setTimeout(startGatewayProcess, gatewayDelay);
        gatewayDelay = Math.min(gatewayDelay * 2, GATEWAY_RESTART_MAX_MS);
        return;
      }
      if (label === "gateway") console.error(`plow-boot: gateway exited code=${code} signal=${signal}`);
      stop();
      if (!children.size) release();
    });
    return child;
  };
  const startBridge = () => launch("bridge", ["/opt/plow/boot/mcp-bridge.js"], {
    stdio: captureOutput ? ["ignore", "inherit", "inherit", "ipc"] : ["ignore", "pipe", "pipe", "ipc"],
    env: { PLOW_MCP_URL: mcpUrl!, PLOW_AGENT_TOKEN: process.env.PLOW_AGENT_TOKEN, PLOW_MCP_BRIDGE_TOKEN: process.env.PLOW_MCP_BRIDGE_TOKEN },
  });
  const startGatewayProcess = () => launch("gateway", ["/app/openclaw.mjs", "gateway"], {
    stdio: ["ignore", "pipe", "pipe"], env: process.env,
  });
  if (mcpUrl) {
    const bridge = startBridge();
    await new Promise(resolve => { bridge.once("message", resolve); bridge.once("close", resolve); });
    if (stopping) return bridge;
  }
  return startGatewayProcess();
}
