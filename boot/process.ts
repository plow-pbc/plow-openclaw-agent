import { spawn } from "node:child_process";

export function startGateway(captureOutput = false) {
  const child = spawn(process.execPath, ["/app/openclaw.mjs", "gateway"], {
    stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit", env: process.env,
  });
  let timer: NodeJS.Timeout | undefined;
  const stop = () => {
    if (timer) return;
    child.kill("SIGTERM");
    timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  child.on("error", error => { console.error(error); process.exitCode = 1; });
  child.on("exit", (code, signal) => {
    clearTimeout(timer);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  return child;
}
