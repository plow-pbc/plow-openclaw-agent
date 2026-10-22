import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { test, type TestContext } from "node:test";
import { startFront } from "../boot/front.ts";

// A backend that answers each line with "<name>:<line>".
async function backend(t: TestContext, name: string, port = 0) {
  const server = net.createServer(socket => socket.on("data", data => socket.write(`${name}:${data}`)));
  await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { server, port: (server.address() as net.AddressInfo).port };
}
const freePort = async () => {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise(resolve => server.close(resolve));
  return port;
};
async function ask(port: number, line: string) {
  const socket = net.connect(port, "127.0.0.1");
  socket.write(line);
  const [reply] = await once(socket, "data");
  socket.destroy();
  return String(reply);
}
async function front(t: TestContext, target: () => number, holdMs?: number) {
  const server = await startFront(0, target, holdMs);
  t.after(() => server.close());
  return (server.address() as net.AddressInfo).port;
}

test("the front forwards to the current gateway, and new connections follow a switch", async t => {
  const a = await backend(t, "a");
  const b = await backend(t, "b");
  let target = a.port;
  const port = await front(t, () => target);
  assert.equal(await ask(port, "hi"), "a:hi");
  target = b.port;
  assert.equal(await ask(port, "hi"), "b:hi");
});

test("a connection that arrives between gateways waits for the next one, bytes included", async t => {
  const next = await freePort();
  const port = await front(t, () => next);
  const socket = net.connect(port, "127.0.0.1");
  socket.write("early");
  await new Promise(resolve => setTimeout(resolve, 300));
  await backend(t, "b", next);
  const [reply] = await once(socket, "data");
  socket.destroy();
  assert.equal(String(reply), "b:early");
});

test("the front drops a waiting connection when no gateway comes back in time", async t => {
  const port = await front(t, () => 1, 200);
  const socket = net.connect(port, "127.0.0.1");
  socket.on("error", () => {});
  const started = Date.now();
  await once(socket, "close");
  assert.ok(Date.now() - started >= 150, "it waited before giving up");
});
