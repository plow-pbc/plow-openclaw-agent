import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { identityFromApi } from "../boot/identity.ts";

for (const status of [0, 429, 503]) test(`owner-chat wait tolerates repeated transient identity failures: ${status}`, async t => {
  let calls = 0;
  const identity = { line: { uid: "line" }, chats: [] };
  t.mock.method(globalThis, "fetch", async () => {
    if (++calls > 12) return Response.json(identity);
    if (!status) throw new TypeError("offline");
    return new Response(null, { status });
  });
  for (let poll = 0; poll < 12; poll++) {
    assert.equal(await identityFromApi("http://fixture", "test-token", true), undefined);
    assert.equal(calls, poll + 1);
  }
  assert.deepEqual(await identityFromApi("http://fixture", "test-token", true), identity);
});

test("the initial fetch still stops after ten transient failures", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  syncBuiltinESMExports();
  t.after(() => { t.mock.timers.reset(); syncBuiltinESMExports(); });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new TypeError("offline"); });
  const check = assert.rejects(identityFromApi("http://fixture", "test-token"), /after 10 attempts/);
  for (let attempt = 0; attempt < 10; attempt++) { await setImmediate(); t.mock.timers.tick(3_000); }
  await check;
  assert.equal(calls, 10);
});

for (const status of [401, 403]) test(`waiting still refuses HTTP ${status} after the auth window`, async t => {
  let now = 0;
  t.mock.method(Date, "now", () => (now += 120_001));
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status }));
  await assert.rejects(identityFromApi("http://fixture", "test-token", true), new RegExp(`HTTP ${status}`));
});

test("waiting does not swallow malformed JSON", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("not JSON"));
  await assert.rejects(identityFromApi("http://fixture", "test-token", true), SyntaxError);
});

for (const body of ["null", "{}"])
  test(`waiting refuses malformed identity shape: ${body}`, async t => {
    t.mock.method(globalThis, "fetch", async () => new Response(body));
    await assert.rejects(identityFromApi("http://fixture", "test-token", true), TypeError);
  });
