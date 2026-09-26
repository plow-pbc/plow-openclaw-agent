import assert from "node:assert/strict";
import { test } from "node:test";
import { linkOwner, startOwnerLink } from "../boot/owner-link.ts";

test("sign-in links the Plow identity and assigns the main session once across restarts", async () => {
  const writes: { method: string; params: object; user?: string }[] = [];
  let signedIn = false;
  let sessionExists = false;
  let linked = false;
  let assigned = false;
  const call = async (method: string, params: object, user?: string): Promise<unknown> => {
    if (method === "users.list") return { profiles: signedIn ? [{ id: "profile", emails: ["owner-uid"] }] : [] };
    if (method === "users.listChannelIdentities") return { links: linked ? [{ identity: { channelId: "plow", accountId: "chat", senderId: "plow-owner" } }] : [] };
    if (method === "sessions.describe") return { session: sessionExists ? { key: "agent:main:main", ...(assigned ? { owner: { actor: { type: "human", id: "profile" } } } : {}) } : null };
    writes.push({ method, params, user });
    if (method === "users.linkChannelIdentity") linked = true;
    if (method === "sessions.assignOwner") assigned = true;
    return {};
  };
  assert.equal(await linkOwner(call), false);
  signedIn = true;
  assert.equal(await linkOwner(call), false);
  sessionExists = true;
  assert.equal(await linkOwner(call), true);
  assert.equal(await linkOwner(call), true);
  assert.deepEqual(writes, [
    { method: "users.linkChannelIdentity", params: { profileId: "profile", identity: { channelId: "plow", accountId: "chat", senderId: "plow-owner" } }, user: undefined },
    { method: "sessions.assignOwner", params: { key: "agent:main:main", owner: { type: "human", id: "profile" } }, user: "owner-uid" },
  ]);
});

test("owner link polls every five minutes until sign-in and assignment", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  startOwnerLink(async method => {
    if (method === "users.list") { calls++; return { profiles: calls > 1 ? [{ id: "profile", emails: ["owner-uid"] }] : [] }; }
    if (method === "users.listChannelIdentities") return { links: [] };
    if (method === "sessions.describe") return { session: { key: "agent:main:main", owner: { actor: { type: "human", id: "profile" } } } };
    return {};
  });
  t.mock.timers.tick(300_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  t.mock.timers.tick(300_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  t.mock.timers.tick(300_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
});
