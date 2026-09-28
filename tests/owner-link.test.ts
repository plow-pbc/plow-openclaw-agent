import assert from "node:assert/strict";
import { test } from "node:test";
import { linkOwner, startOwnerLink } from "../boot/owner-link.ts";

test("sign-in links the Plow identity and assigns the main session once across restarts", async () => {
  const writes: { method: string; params: object }[] = [];
  let signedIn = false;
  let sessionExists = false;
  let linked = false;
  let assigned = false;
  const call = async (method: string, params: object): Promise<unknown> => {
    if (method === "users.list") return { profiles: signedIn ? [{ id: "profile" }] : [] };
    if (method === "users.listChannelIdentities") return { links: linked ? [{ identity: { channelId: "plow", accountId: "chat", senderId: "plow-owner" } }] : [] };
    if (method === "sessions.describe") return { session: sessionExists ? { key: "agent:main:main", ...(assigned ? { owner: { actor: { type: "human", id: "profile" } } } : {}) } : null };
    writes.push({ method, params });
    if (method === "users.linkChannelIdentity") linked = true;
    if (method === "tools.invoke") { assigned = true; return { ok: true }; }
    return {};
  };
  assert.equal(await linkOwner(call), false);
  signedIn = true;
  assert.equal(await linkOwner(call), false);
  sessionExists = true;
  assert.equal(await linkOwner(call), true);
  assert.equal(await linkOwner(call), true);
  assert.deepEqual(writes, [
    { method: "users.linkChannelIdentity", params: { profileId: "profile", identity: { channelId: "plow", accountId: "chat", senderId: "plow-owner" } } },
    { method: "tools.invoke", params: { name: "sessions", sessionKey: "agent:main:main", args: { action: "assign_owner", sessionKey: "agent:main:main", ownerType: "human", ownerId: "profile" } } },
  ]);
});

test("failed owner assignment is reported so the next poll can retry", async () => {
  const call = async (method: string): Promise<unknown> => {
    if (method === "users.list") return { profiles: [{ id: "profile" }] };
    if (method === "users.listChannelIdentities") return { links: [{ identity: { channelId: "plow", accountId: "chat", senderId: "plow-owner" } }] };
    if (method === "sessions.describe") return { session: { key: "agent:main:main" } };
    if (method === "tools.invoke") return { ok: false, error: { code: "forbidden", message: "assignment denied" } };
    throw new Error(`unexpected method ${method}`);
  };
  await assert.rejects(linkOwner(call), /assignment denied/);
});

test("owner link polls every five minutes until sign-in and assignment", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  startOwnerLink(async method => {
    if (method === "users.list") { calls++; return { profiles: calls > 1 ? [{ id: "profile" }] : [] }; }
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
