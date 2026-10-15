import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { identityFromApi } from "../boot/identity.ts";

function mockClock(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  syncBuiltinESMExports();
  t.after(() => { t.mock.timers.reset(); syncBuiltinESMExports(); });
}

for (const status of [401, 403, 429, 503, "network"]) test(`identity retries temporary failure: ${status}`, async t => {
  mockClock(t);
  t.mock.method(console, "log", () => {});
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++calls > 1) return Response.json({ line: { uid: "line" }, chats: [] });
    if (status === "network") throw new TypeError("fetch failed");
    return new Response(null, { status });
  });
  const result = identityFromApi("http://fixture", "test-token");
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(3_000);
  assert.equal((await result)?.line.uid, "line");
  assert.equal(calls, 2);
});

for (const status of [401, 403]) test(`identity parks on HTTP ${status} after 120 seconds, even after transient failures`, async t => {
  mockClock(t);
  t.mock.method(console, "log", () => {});
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++calls <= 3) throw new TypeError("fetch failed");
    return new Response(null, { status });
  });
  const result = assert.rejects(identityFromApi("http://fixture", "test-token"), new RegExp(`refused: HTTP ${status}`));
  for (let i = 0; i <= 60; i++) {
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(3_000);
  }
  await result;
  const parkedAt = calls;
  t.mock.timers.tick(10 * 60_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, parkedAt, "a parked boot stops asking");
});

test("identity parks on HTTP 404 at once", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(null, { status: 404 }); });
  await assert.rejects(identityFromApi("http://fixture", "test-token"), /refused: HTTP 404/);
  assert.equal(calls, 1);
});

for (const status of [429, 503, "network"]) test(`identity keeps retrying a transient failure, backing off to a minute: ${status}`, async t => {
  mockClock(t);
  const logs: string[] = [];
  t.mock.method(console, "log", (line: string) => { logs.push(line); });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++calls > 30) return Response.json({ line: { uid: "line" }, chats: [] });
    if (status === "network") throw new TypeError("fetch failed");
    return new Response(null, { status });
  });
  const result = identityFromApi("http://fixture", "test-token");
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(60_000);
  }
  assert.equal((await result).line.uid, "line");
  assert.equal(calls, 31);
  assert.deepEqual(logs.slice(0, 7).map(line => line.split("retrying in ")[1]), ["3s", "6s", "12s", "24s", "48s", "60s", "60s"]);
});

test("identity logs why a request failed", async t => {
  mockClock(t);
  const logs: string[] = [];
  t.mock.method(console, "log", (line: string) => { logs.push(line); });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++calls > 1) return Response.json({ line: { uid: "line" }, chats: [] });
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND fixture"), { code: "ENOTFOUND" }) });
  });
  const result = identityFromApi("http://fixture", "test-token");
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(3_000);
  await result;
  assert.deepEqual(logs, ["plow-boot: identity request failed: fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND fixture); retrying in 3s"]);
});

test("identity does not swallow malformed JSON", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("not JSON"));
  await assert.rejects(identityFromApi("http://fixture", "test-token"), SyntaxError);
});

for (const body of ["null", "{}"])
  test(`identity refuses malformed shape: ${body}`, async t => {
    t.mock.method(globalThis, "fetch", async () => new Response(body));
    await assert.rejects(identityFromApi("http://fixture", "test-token"), TypeError);
  });

test("boot uses the identity endpoint that includes agent.name", async t => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(url, "http://fixture/v1/agents/me");
    return Response.json({ agent: { name: "Juniper" }, line: { uid: "line" }, chats: [] });
  });
  assert.equal((await identityFromApi("http://fixture", "test-token"))?.agent?.name, "Juniper");
});

test("identity rejects an empty line UID", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ line: { uid: "" }, chats: [] }));
  await assert.rejects(identityFromApi("http://fixture", "test-token"), /missing line uid/);
});
