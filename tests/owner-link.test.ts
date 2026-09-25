import assert from "node:assert/strict";
import { test } from "node:test";
import { linkOwner, startOwnerLink } from "../boot/owner-link.ts";

test("owner link waits for sign-in and the owner DM, then survives restart without duplicate writes", async () => {
  const calls: { method: string; params: object; user?: string }[] = [];
  let signedIn = false;
  let sessionExists = false;
  let linked = false;
  let assigned = false;
  const call = async (method: string, params: object, user?: string): Promise<unknown> => {
    calls.push({ method, params, user });
    if (method === "users.list") return { profiles: signedIn ? [{ id: "profile", emails: ["plow-uid"] }] : [] };
    if (method === "users.listChannelIdentities") return { links: linked ? [{ profileId: "profile", identity: { channelId: "plow", accountId: "chat", senderId: "plow-owner" } }] : [] };
    if (method === "users.linkChannelIdentity") { linked = true; return {}; }
    if (method === "sessions.describe") return { session: sessionExists ? { key: "agent:main:main", isMain: true, channel: "plow", origin: { accountId: "chat" }, ...(assigned ? { owner: { actor: { type: "human", id: "profile" } } } : {}) } : null };
    if (method === "sessions.assignOwner") { assigned = true; return {}; }
    throw new Error(method);
  };
  assert.equal(await linkOwner(call), false);
  signedIn = true;
  assert.equal(await linkOwner(call), false);
  assert.equal(linked, true);
  sessionExists = true;
  assert.equal(await linkOwner(call), true);
  assert.deepEqual(calls.find(call => call.method === "users.linkChannelIdentity"), {
    method: "users.linkChannelIdentity", params: { profileId: "profile", identity: { channelId: "plow", accountId: "chat", senderId: "plow-owner" } }, user: undefined,
  });
  assert.deepEqual(calls.find(call => call.method === "sessions.assignOwner"), {
    method: "sessions.assignOwner", params: { key: "agent:main:main", owner: { type: "human", id: "profile" } }, user: "plow-uid",
  });
  assert.equal(calls.find(call => call.method === "sessions.describe")?.user, "plow-uid");
  assert.equal(await linkOwner(call), true);
  assert.equal(calls.filter(call => call.method === "users.linkChannelIdentity").length, 1);
  assert.equal(calls.filter(call => call.method === "sessions.assignOwner").length, 1);
});

test("owner linking polls at five minutes and stops after a permanent profile error", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: string[] = [];
  startOwnerLink(async method => {
    calls.push(method);
    if (calls.length === 1) return { profiles: [] };
    return { profiles: [{ id: "first", emails: ["one"] }, { id: "second", emails: ["two"] }] };
  });
  t.mock.timers.tick(299_999);
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["users.list"]);
  t.mock.timers.tick(300_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["users.list", "users.list"]);
  t.mock.timers.tick(300_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["users.list", "users.list"]);
});
