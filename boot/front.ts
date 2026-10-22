import net from "node:net";

const RETRY_MS = 50;

// The gateway's public port (the owner's web page and the CLI) in front of whichever gateway is
// current, so a takeover only changes where new connections go. A connection that arrives while no
// gateway listens waits for one, up to holdMs, instead of being refused.
export async function startFront(port: number, target: () => number, holdMs = 30_000, host = "127.0.0.1") {
  const server = net.createServer(client => {
    client.pause();
    const deadline = Date.now() + holdMs;
    let upstream: net.Socket | undefined;
    client.on("error", () => upstream?.destroy());
    client.on("close", () => upstream?.destroy());
    const connect = () => {
      if (client.destroyed) return;
      const socket = net.connect(target(), host);
      socket.once("connect", () => {
        upstream = socket;
        socket.on("error", () => client.destroy());
        socket.on("close", () => client.destroy());
        client.pipe(socket).pipe(client);
        client.resume();
      });
      socket.once("error", () => {
        if (upstream === socket) return;
        if (Date.now() < deadline) setTimeout(connect, RETRY_MS);
        else client.destroy();
      });
    };
    connect();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
  return server;
}
