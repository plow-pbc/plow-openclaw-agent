import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { listen, type Account, type Chat, type Message } from "../plugin/transport.ts";
import { websocketFixture, checkpointUid } from "./ws-fixture.ts";

const sender = { type: "member" as const, uid: "owner", role: "owner", display_name: "Owner", provider_key: "+15550000001" };
const chat: Chat = { uid: "home", status: "active", trusted: true, participants: [sender, { type: "agent", relationship: "self", line: { uid: "line" } }] };
const inbound = (uid: string): Message => ({ uid, direction: "inbound", sender, body: uid, attachments: [], created_at: "2026-09-29T12:00:00Z" });
const frame = (message: Message) => JSON.stringify({ event_type: "message_received", event_id: `event-${message.uid}`, chat_id: chat.uid, data: { message } });

for (const persistence of ["saved", "write-failed", "rename-failed"] as const) test(`completion during reconnect pagination cannot replay adopted sources evicted from both caches; checkpoint=${persistence}`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/home`, JSON.stringify({ uid: "old", recent: [] }));
  const controller = abortAfter(60_000), release = Promise.withResolvers<void>(), adopted = Promise.withResolvers<void>();
  const persistenceFailed = Promise.withResolvers<void>();
  controller.signal.addEventListener("abort", () => { release.resolve(); adopted.resolve(); persistenceFailed.resolve(); }, { once: true });
  const timeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => timeout(fn, ms === 30_000 ? 0 : ms, ...args));
  const messages = Array.from({ length: 514 }, (_, i) => inbound(`source-${i}`));
  const history = messages.toReversed().concat([inbound("old")]);
  let connections = 0, completedDuringPagination = false, checkpointFailed = false;
  if (persistence !== "saved") {
    const original = fs.writeFile, originalRename = fs.rename;
    const fail = (path: unknown, data: unknown) => {
      if (!checkpointFailed && String(path).endsWith("/plow-checkpoints/home.tmp") && typeof data === "string" && JSON.parse(data).uid === "source-513") {
        checkpointFailed = true;
        persistenceFailed.resolve();
        throw new Error("checkpoint disk failure");
      }
    };
    const writer = t.mock.method(fs, "writeFile", async (path, data, ...options) => {
      if (persistence === "write-failed") fail(path, data);
      return original(path, data, ...options);
    });
    const mover = t.mock.method(fs, "rename", async (from, to) => {
      if (persistence === "rename-failed") fail(from, await readFile(from, "utf8"));
      return originalRename(from, to);
    });
    syncBuiltinESMExports();
    t.after(() => { writer.mock.restore(); mover.mock.restore(); syncBuiltinESMExports(); });
  }
  server.on("connection", () => { connections++; });
  t.mock.method(globalThis, "fetch", async (url: string) => {
    const cursor = new URL(url).searchParams.get("starting_after");
    if (connections === 2 && url.includes("limit=50") && cursor && !completedDuringPagination) {
      completedDuringPagination = true;
      for (const socket of server.clients) socket.send(frame(messages[1]));
      release.resolve();
      await (persistence === "saved" ? adopted.promise : persistenceFailed.promise);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(await checkpointUid(`${root}/plow-checkpoints/home`), persistence === "saved" ? "source-513" : "old");
    }
    const start = cursor ? history.findIndex(message => message.uid === cursor) + 1 : 0;
    if (connections === 2 && url.includes("limit=50") && start + 50 >= history.length) {
      for (const socket of server.clients) socket.send(frame(inbound("after-reconnect")));
    }
    if (connections === 3 && url.endsWith("/chats")) for (const socket of server.clients) socket.send(frame(inbound("after-reconnect")));
    return Response.json(url.endsWith("/chats") ? { data: [chat], has_more: false } : url.endsWith("/chats/home") ? chat :
      url.includes("limit=50") ? { data: history.slice(start, start + 50), has_more: start + 50 < history.length } :
      url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" });
  });
  const calls: string[] = [];
  await listen({ apiBase, accountId: "chat", lineUid: "line" }, controller.signal, text => {
    if (connections === 1 && text.startsWith("acked chat=home message=source-513 ")) for (const socket of server.clients) socket.close();
    if (connections === 2 && text.startsWith("acked chat=home message=source-0 ")) adopted.resolve();
    if (text.startsWith("acked chat=home message=after-reconnect ")) controller.abort();
  }, async (_chat, message, _first, _history, ingress) => {
    calls.push(message.uid);
    ingress.onSubmitted();
    if (message.uid === "source-0") await release.promise;
    return "completed";
  });
  assert.equal(completedDuringPagination, true);
  assert.equal(checkpointFailed, persistence !== "saved");
  assert.notEqual(controller.signal.reason?.name, "TimeoutError");
  const duplicated = calls.filter((uid, index) => calls.indexOf(uid) !== index);
  assert.equal(calls.length, 515, `cache eviction must not dispatch adopted sources again; duplicates=${duplicated.join(",")}`);
  assert.deepEqual(calls, [...messages.map(message => message.uid), "after-reconnect"], "each external action must occur once, including the buffered older frame");
});

for (const unfinished of ["pending", "incomplete"] as const) test(`a later outbound acknowledgement cannot skip ${unfinished} inbound work across restart`, async t => {
  const { root, apiBase, abortAfter } = await websocketFixture(t);
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/home`, JSON.stringify({ uid: "old", recent: ["old"] }));
  const outbound: Message = { ...inbound("outbound"), direction: "outbound", sender: chat.participants[1] };
  const messages = [outbound, inbound("unfinished"), inbound("old")];
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } :
    url.endsWith("/chats/home") ? chat :
    url.includes("/messages?") ? { data: url.includes("limit=20") ? [] : messages, has_more: false } : { ticket: "ticket" }));
  const account: Account = { apiBase, accountId: "chat", lineUid: "line" };
  const turns: string[] = [];
  const logs: string[] = [];
  for (let boot = 0; boot < 3; boot++) {
    const controller = abortAfter(200);
    await listen(account, controller.signal, text => {
      logs.push(text);
      if (boot === 0 && text === "acked chat=home message=outbound") controller.abort();
      if (boot === 1 && text.startsWith("acked chat=home message=unfinished ")) controller.abort();
    }, async (_chat, message, _first, _history, ingress) => {
      turns.push(message.uid);
      if (boot === 0) {
        if (unfinished === "pending") {
          ingress.onSubmitted();
          await new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
        }
        return "incomplete";
      }
      return "completed";
    });
    if (boot === 0) {
      const saved = JSON.parse(await readFile(`${root}/plow-checkpoints/home`, "utf8"));
      assert.equal(saved.uid, "old", "recovery must stay before the unfinished source");
      assert.ok(saved.recent.includes("outbound"), "later handled rows must remain deduplicated");
      assert.ok(!saved.recent.includes("unfinished"));
    }
  }
  assert.deepEqual(turns, ["unfinished", "unfinished"]);
  assert.equal(logs.filter(text => text === "acked chat=home message=outbound").length, 1);
  assert.equal(logs.filter(text => text.startsWith("acked chat=home message=unfinished ")).length, 1);
});

for (const inclusive of [false, true]) test(`legacy checkpoints deduplicate buffered older frames before replay; inclusive=${inclusive}`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/home`, `${inclusive ? "first:" : ""}boundary`);
  const messages = [inbound("new"), inbound("boundary"), inbound("old")];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/chats")) {
      for (const socket of server.clients) {
        socket.send(frame(inbound("old")));
        socket.send(frame(inbound("boundary")));
        socket.send(frame(inbound("new")));
      }
      return Response.json({ data: [chat], has_more: false });
    }
    if (url.includes("/messages?")) {
      const after = new URL(url).searchParams.get("starting_after");
      return Response.json({ data: after ? messages.slice(messages.findIndex(message => message.uid === after) + 1) : messages, has_more: false });
    }
    return Response.json(url.endsWith("/chats/home") ? chat : { ticket: "ticket" });
  });
  const turns: string[] = [];
  const account: Account = { apiBase, accountId: "chat", lineUid: "line" };
  await listen(account, abortAfter().signal, () => {}, async (_chat, message) => {
    turns.push(message.uid);
    return "completed";
  });
  assert.deepEqual(turns, inclusive ? ["boundary", "new"] : ["new"]);
  const saved = JSON.parse(await readFile(`${root}/plow-checkpoints/home`, "utf8"));
  assert.ok(saved.recent.includes("old"));
  await listen(account, abortAfter().signal, () => {}, async (_chat, message) => {
    turns.push(message.uid);
    return "completed";
  });
  assert.deepEqual(turns, inclusive ? ["boundary", "new"] : ["new"]);
});
// The inbound clock lags the outbound clock; HTTP history orders them by timestamp.
test("a late frame older than the checkpoint is deduplicated across restart", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/home`, "outbound");
  const outbound: Message = { ...inbound("outbound"), direction: "outbound", sender: chat.participants[1] };
  const messages = [outbound, inbound("old")];
  const recovered = Promise.withResolvers<void>();
  let historyReads = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("/messages?") && ++historyReads === 1) recovered.resolve();
    return Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } :
    url.endsWith("/chats/home") ? chat :
    url.includes("/messages?") ? { data: url.includes("limit=20") ? [] : messages, has_more: false } : { ticket: "ticket" });
  });
  const controller = abortAfter();
  const turns: string[] = [];
  const fixture: Account = { apiBase, accountId: "chat", lineUid: "line" };
  const running = listen(fixture, controller.signal, text => {
    if (text.startsWith("acked chat=home message=late")) controller.abort();
  }, async (_chat, message) => { turns.push(message.uid); return "completed"; });
  await recovered.promise;
  const late = { ...inbound("late"), created_at: "2026-09-29T11:59:59Z" };
  messages.splice(1, 0, late);
  for (const socket of server.clients) socket.send(frame(late));
  await running;
  assert.deepEqual(turns, ["late"]);
  await listen(fixture, abortAfter(200).signal, () => {}, async (_chat, message) => { turns.push(message.uid); return "completed"; });
  assert.deepEqual(turns, ["late"]);
});
