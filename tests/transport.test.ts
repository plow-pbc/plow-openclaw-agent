import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { checkpointUid, websocketFixture } from "./ws-fixture.ts";
import fs, { mkdir, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { listen, DeliveryUnknownError, recover, findOwnerChat, ownerChat, invalidateContextualizedHistory, postMessage, type Account, type Chat, type Message } from "../plugin/transport.ts";

const account = { apiBase: "http://fixture", accountId: "chat" } as Account;
const message = (uid: string) => ({ uid }) as Message;
const acceptedChat = (uid: string) => ({
  uid, status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }],
});
const inbound = (uid: string) => ({ uid, direction: "inbound", sender: { type: "member" } });

test("catch-up reads only the newest 50 and warns when older unread counts are unavailable", async t => {
  process.env.PLOW_AGENT_TOKEN = "test-token";
  const urls: string[] = [], logs: string[] = [];
  const newest = Array.from({ length: 50 }, (_, i) => message(`new-${49 - i}`));
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(url);
    return Response.json(url.includes("starting_after=")
      ? { data: [message("acked")], has_more: false }
      : { data: newest, has_more: true });
  });
  assert.deepEqual((await recover(account, "chat", "acked", text => logs.push(text))).map(m => m.uid), [...newest].reverse().map(m => m.uid));
  assert.deepEqual(urls, ["http://fixture/v1/chats/chat/messages?limit=50"]);
  assert.match(logs.join("\n"), /warning.*chat=chat.*fetched=50.*older_unread_skipped=unknown/);
  urls.length = logs.length = 0;
  assert.deepEqual((await recover(account, "chat", "new-47", text => logs.push(text))).map(m => m.uid), ["new-48", "new-49"]);
  assert.equal(urls.length, 1);
  assert.deepEqual(logs, []);
});

test("empty first-install checkpoint still recovers the first missed message", async t => {
  process.env.PLOW_AGENT_TOKEN = "test-token";
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [message("first")], has_more: false }));
  assert.deepEqual((await recover(account, "chat", "")).map(m => m.uid), ["first"]);
});

test("a failed history read cannot masquerade as an empty recovery", async t => {
  process.env.PLOW_AGENT_TOKEN = "test-token";
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  await assert.rejects(recover(account, "chat", "acked"), /HTTP 503/);
});

test("a truncated chat listing warns and keeps recovery and live delivery on the same connection", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/group`, "old");
  const chat = { uid: "group", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }] };
  const missed = { uid: "missed", direction: "inbound", sender: { type: "member" } };
  let connections = 0;
  let liveSent = false;
  server.on("connection", () => { connections++; });
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: true } :
    url.endsWith("/chats/group") ? chat :
    url.endsWith("/messages?limit=50") ? { data: [...(liveSent ? [{ ...missed, uid: "live" }] : []), missed, { uid: "old" }], has_more: false } :
    url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  const received: string[] = [];
  const logs: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, text => logs.push(text), async (_chat, message) => {
    received.push(message.uid);
    if (message.uid === "missed") {
      liveSent = true;
      for (const socket of server.clients) socket.send(JSON.stringify({
        event_type: "message_received", event_id: "live", chat_id: chat.uid, data: { message: { ...missed, uid: "live" } },
      }));
    } else controller.abort();
    return "completed";
  });
  assert.deepEqual(received, ["missed", "live"]);
  assert.equal(await checkpointUid(`${root}/plow-checkpoints/group`), "live");
  assert.equal(connections, 1);
  assert.ok(logs.some(text => text.includes("warning") && text.includes("truncated")));
  assert.ok(!logs.some(text => text.startsWith("transport stopped:")));
});

for (const owner of [false, true]) test(`a frame arriving while a synthesized checkpoint is written is recovered: owner=${owner}`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const chat = { uid: "group", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }, ...(owner ? [{ type: "member", uid: "owner", role: "owner" }] : [])] };
  const message = { uid: "arriving", direction: "inbound", sender: { type: "member" } };
  const baseline = owner ? { ...message, uid: "pending" } : message;
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } : url.endsWith("/chats/group") ? chat :
    url.includes("/messages?") ? { data: injected && owner ? [message, baseline] : [baseline], has_more: false } : { ticket: "ticket" }));
  const originalWrite = fs.writeFile;
  let injected = false;
  const writer = t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    if (!injected && String(args[0]).endsWith("/group.tmp") && JSON.parse(String(args[1])).uid === (owner ? `first:${baseline.uid}` : baseline.uid)) {
      injected = true;
      for (const socket of server.clients) {
        socket.send(JSON.stringify({ event_type: "message_received", event_id: "event", chat_id: chat.uid, data: { message } }));
        await new Promise<void>(resolve => { socket.once("pong", resolve); socket.ping(); });
      }
    }
    return originalWrite(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { writer.mock.restore(); syncBuiltinESMExports(); });
  const received: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, () => {}, async (_chat, message) => {
    received.push(message.uid);
    if (message.uid === "arriving") controller.abort();
    return "completed";
  });
  assert.equal(injected, true);
  assert.deepEqual(received, owner ? ["pending", "arriving"] : ["arriving"]);
  assert.equal(await checkpointUid(`${root}/plow-checkpoints/group`), message.uid);
});

test("bounded recovery does not replay buffered frames or rewind the checkpoint", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/group`, "old");
  const controller = abortAfter(30_000);
  const chat = acceptedChat("group");
  const messages = Array.from({ length: 514 }, (_, i) => inbound(`message-${i}`));
  let buffered = false, live = false;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("limit=50") && !buffered) {
      buffered = true;
      for (const socket of server.clients) socket.send(JSON.stringify({ event_type: "message_received", event_id: "duplicate", chat_id: chat.uid, data: { message: messages.at(-1) } }));
    }
    const cursor = new URL(url).searchParams.get("starting_after");
    const history = [...(live ? [inbound("live")] : []), ...[...messages].reverse(), { uid: "old" }];
    return Response.json(url.endsWith("/chats") ? { data: [chat], has_more: false } : url.endsWith("/chats/group") ? chat :
      url.includes("/messages?") ? { data: url.includes("limit=20") ? [] : cursor ? history.slice(history.findIndex(m => m.uid === cursor) + 1) : history.slice(0, 50), has_more: history.length > 50 } : { ticket: "ticket" });
  });
  const received: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, text => {
    if (text.startsWith("acked chat=group message=message-513 ")) {
      live = true;
      for (const socket of server.clients) socket.send(JSON.stringify({ event_type: "message_received", event_id: "live", chat_id: chat.uid, data: { message: inbound("live") } }));
    }
    if (text.startsWith("acked chat=group message=live ")) controller.abort();
  }, async (_chat, message) => { received.push(message.uid); return "completed"; });
  assert.notEqual(controller.signal.reason?.name, "TimeoutError");
  assert.deepEqual(received, [...messages.slice(-50).map(message => message.uid), "live"]);
  assert.equal(await checkpointUid(`${root}/plow-checkpoints/group`), "live");
});

for (const outcome of ["completed", "incomplete"] as const) test(`unknown delivery advances once; next turn ${outcome} during abort`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const fixture = { ...account, apiBase, lineUid: "line" };
  const chat = { uid: "chat", status: "active", trusted: false, participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }] };
  const fetch = t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } :
    url.endsWith("/chats/chat") ? chat : url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  server.on("connection", (socket: { send: (text: string) => void }) => {
    for (const uid of ["uncertain", "next"]) socket.send(JSON.stringify({ event_type: "message_received", event_id: uid, chat_id: "chat", data: { message: { uid, direction: "inbound", sender: { type: "member" } } } }));
  });
  const calls: string[] = [];
  await listen(fixture, controller.signal, () => {}, async (_chat, message) => {
    calls.push(message.uid);
    if (message.uid === "uncertain") throw new DeliveryUnknownError();
    controller.abort();
    return outcome;
  });
  assert.deepEqual(calls, ["uncertain", "next"]);
  assert.equal(fetch.mock.calls.filter(call => String(call.arguments[0]).endsWith("/messages")).length, 0, "unknown delivery never sends another message");
  assert.equal(await checkpointUid(`${root}/plow-checkpoints/chat`), outcome === "completed" ? "next" : "uncertain");
});

for (const scenario of ["waited", "pending", "buffered", "buffered-before-read", "buffered-after-read", "two-during-baseline", "two-during-history", "unanswered-before-connect", "newer-during-baseline", "interrupted", "answered", "peer", "group", "fresh"]) test(`first contact and restart: ${scenario}`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  if (scenario === "waited") {
    await mkdir(`${root}/plow-checkpoints`);
    await writeFile(`${root}/plow-checkpoints/home`, "");
  }
  const fixture = { ...account, apiBase, lineUid: "line" };
  const sender = { type: "member", uid: "owner", role: "owner", display_name: "Owner" };
  const chat = { uid: "home", status: "active", participants: [sender, { type: "agent", relationship: "self", line: { uid: "line" } }, ...(scenario === "group" ? [{ ...sender, uid: "guest", role: "member" }] : [])] };
  const first = { uid: "first", body: "What is 17 + 25?", direction: scenario === "answered" ? "outbound" : "inbound",
    sender: scenario === "peer" ? { type: "agent", relationship: "peer", line: { uid: "peer" } } : sender };
  const older = { ...first, uid: "older", direction: "outbound" };
  const newer = { ...first, uid: "newer" };
  const twoMessages = ["buffered-before-read", "buffered-after-read", "two-during-baseline", "two-during-history", "unanswered-before-connect", "newer-during-baseline"].includes(scenario);
  let boot = 0;
  if (["buffered", "fresh", "interrupted"].includes(scenario)) server.on("connection", (socket: { send: (text: string) => void }) => {
    if (scenario !== "interrupted" || !boot) socket.send(JSON.stringify({ event_type: "message_received", event_id: "first", chat_id: "home", data: { message: first } }));
  });
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (!boot && (((scenario === "buffered-before-read" || scenario === "newer-during-baseline") && url.endsWith("/chats")) ||
      (scenario === "buffered-after-read" && url.includes("limit=1")) ||
      (scenario === "two-during-baseline" && url.includes("limit=1")) ||
      (scenario === "two-during-history" && url.includes("limit=20")))) {
      for (const socket of server.clients) {
        for (const message of ["buffered-after-read", "newer-during-baseline"].includes(scenario) ? [newer] : [first, newer]) {
          socket.send(JSON.stringify({ event_type: "message_received", event_id: message.uid, chat_id: "home", data: { message } }));
        }
        // A pong confirms the client has processed the preceding frames.
        const pong = once(socket, "pong");
        socket.ping();
        await pong;
      }
    }
    return Response.json(
      url.endsWith("/chats") ? { data: scenario === "fresh" || (scenario === "interrupted" && !boot) ? [] : [chat], has_more: false } :
      url.endsWith("/chats/home") ? chat : url.includes("/messages?") ? {
        data: url.includes("limit=1") ? [["buffered-before-read", "two-during-baseline", "unanswered-before-connect", "newer-during-baseline"].includes(scenario) ? newer : first] :
          scenario === "waited" ? [first] : twoMessages ? [newer, first, older] : [first, older], has_more: false,
      } : { ticket: "ticket" });
  });
  const turns: { uid: string; firstContact: boolean }[] = [];
  for (; boot < 2; boot++) {
    const controller = abortAfter();
    await listen(fixture, controller.signal, () => {}, async (_chat, message, firstContact) => {
      turns.push({ uid: message.uid, firstContact });
      if (scenario === "interrupted") { controller.abort(); return boot ? "completed" : "incomplete"; }
      return "completed";
    });
    assert.equal(await checkpointUid(`${root}/plow-checkpoints/home`), scenario === "interrupted" && !boot ? "first:first" : twoMessages ? "newer" : "first");
  }
  assert.deepEqual(turns, scenario === "interrupted" ? [{ uid: "first", firstContact: true }, { uid: "first", firstContact: true }] : twoMessages ? [{ uid: "first", firstContact: true }, { uid: "newer", firstContact: false }] : ["waited", "pending", "buffered", "fresh"].includes(scenario) ? [{ uid: "first", firstContact: true }] : []);
});

test("first-contact recovery includes its message and newer arrivals, excluding older history", async t => {
  process.env.PLOW_AGENT_TOKEN = "test-token";
  t.mock.method(globalThis, "fetch", async () => Response.json({
    data: [message("newer"), message("pending"), message("old")], has_more: false,
  }));
  assert.deepEqual((await recover(account, "home", "first:pending")).map(m => m.uid), ["pending", "newer"]);
});

for (const failure of ["incomplete", "throws"] as const) test(`a turn that ${failure} after adoption is not replayed and does not disconnect later turns`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const fixture = { ...account, apiBase, lineUid: "line" };
  const chats = ["home", "other"].map(uid => ({ uid, status: "active", participants: [
    { type: "agent", relationship: "self", line: { uid: "line" } },
  ] }));
  const messages = ["unfinished", "later"].map(uid => ({ uid, direction: "inbound", sender: { type: "member" } }));
  let recovering = false;
  let notices = 0;
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    if (options.method === "POST" && url.endsWith("/messages")) {
      notices++;
      return Response.json({ uid: "notice" });
    }
    return Response.json(
    url.endsWith("/chats") ? { data: chats, has_more: false } :
    url.includes("/messages?") ? { data: recovering && url.includes("/home/") ? [...messages].reverse() : [], has_more: false } :
    chats.find(chat => url.endsWith(`/chats/${chat.uid}`)) ?? { ticket: "ticket" });
  });
  let connections = 0;
  server.on("connection", (socket: { send: (text: string) => void }) => {
    connections++;
    if (recovering) return;
    for (const [chat, message] of [["home", messages[0]], ["home", messages[1]], ["other", { ...messages[1], uid: "other-reply" }]] as const) {
      socket.send(JSON.stringify({ event_type: "message_received", event_id: `event-${message.uid}`, chat_id: chat, data: { message } }));
    }
  });
  for (const phase of ["live", "recovery"]) {
    recovering = phase === "recovery";
    const controller = abortAfter();
    const calls: string[] = [];
    const logs: string[] = [];
    const priorCheckpoints: string[] = [];
    await listen(fixture, controller.signal, text => {
      logs.push(text);
      if (text.startsWith("transport stopped") || (logs.some(line => line.startsWith("acked chat=home message=later")) && logs.some(line => line.startsWith("acked chat=other message=other-reply")))) controller.abort();
    }, async (_chat, message, _first, _history, ingress) => {
      await ingress!.onAdopted();
      calls.push(message.uid);
      if (message.uid === "later") priorCheckpoints.push(await checkpointUid(`${root}/plow-checkpoints/home`));
      if (!recovering && message.uid === "unfinished") {
        if (failure === "throws") throw new Error("turn failed");
        return "incomplete";
      }
      if (recovering && message.uid === "later") controller.abort();
      return "completed";
    });
    assert.deepEqual([...calls].sort(), recovering ? [] : ["later", "other-reply", "unfinished"]);
    if (!recovering) assert.ok(calls.indexOf("unfinished") < calls.indexOf("later"));
    assert.deepEqual(priorCheckpoints, recovering ? [] : ["later"]);
    assert.equal(await checkpointUid(`${root}/plow-checkpoints/home`), "later");
    assert.equal(await checkpointUid(`${root}/plow-checkpoints/other`), "other-reply");
    assert.equal(connections, recovering ? 2 : 1);
    assert.equal(notices, 0, "OpenClaw owns fallback delivery");
    assert.ok(!logs.some(text => text.startsWith("transport stopped")));
    if (!recovering) assert.ok(logs.some(text => text.includes("turn incomplete chat=home message=unfinished")));
  }
});

test("a new chat's message arriving during listing is buffered by the socket", async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const chat = { uid: "new-chat", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }] };
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/chats")) {
      for (const socket of server.clients) socket.send(JSON.stringify({
        event_type: "message_received", event_id: "new-event", chat_id: chat.uid,
        data: { message: { uid: "new-message", direction: "inbound", sender: { type: "member" } } },
      }));
      return Response.json({ data: [], has_more: false });
    }
    return Response.json(url.endsWith(`/chats/${chat.uid}`) ? chat : url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" });
  });
  const received: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, () => {}, async (_chat, message) => {
    received.push(message.uid);
    controller.abort();
    return "completed";
  });
  assert.deepEqual(received, ["new-message"]);
});

for (const count of [1, 2]) for (const arrival of ["listing", "baseline"] as const) test(`${count} existing chat frames arriving during ${arrival} are delivered in order without replaying history`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const chat = { uid: "group", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }] };
  const messages = ["old", "first", "second"].slice(0, count + 1).map(uid => ({ uid, direction: "inbound", sender: { type: "member" } }));
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (arrival === "listing" ? url.endsWith("/chats") : url.includes("limit=1")) {
      for (const socket of server.clients) {
        for (const message of messages.slice(1)) socket.send(JSON.stringify({ event_type: "message_received", event_id: message.uid, chat_id: chat.uid, data: { message } }));
        // Wait for a round trip so the frames reach the client before the snapshot.
        await new Promise<void>(resolve => { socket.once("pong", resolve); socket.ping(); });
      }
    }
    return Response.json(url.endsWith("/chats") ? { data: [chat], has_more: false } :
      url.endsWith(`/chats/${chat.uid}`) ? chat : url.includes("/messages?")
        ? { data: url.includes("limit=1") ? messages.slice(-1) : [...messages].reverse(), has_more: false } : { ticket: "ticket" });
  });
  const received: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, () => {}, async (_chat, message) => {
    received.push(message.uid);
    if (received.length === count) controller.abort();
    return "completed";
  });
  assert.deepEqual(received, messages.slice(1).map(message => message.uid));
  assert.equal(await checkpointUid(`${root}/plow-checkpoints/group`), messages.at(-1)!.uid);
});

test("an omitted checkpointed chat recovers before its first live frame advances progress", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/omitted`, "old");
  const chat = { uid: "omitted", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }] };
  const incoming = (uid: string) => ({ uid, direction: "inbound", sender: { type: "member" } });
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [], has_more: true } :
    url.endsWith("/chats/omitted") ? chat :
    url.includes("starting_after=old") ? { data: [], has_more: false } :
    url.includes("limit=50") ? { data: [incoming("live"), incoming("missed"), incoming("old")], has_more: false } :
    url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  server.on("connection", (socket: { send: (text: string) => void }) => socket.send(JSON.stringify({
    event_type: "message_received", event_id: "live-event", chat_id: chat.uid, data: { message: incoming("live") },
  })));
  const delivered: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, () => {}, async (_chat, message) => {
    delivered.push(message.uid);
    if (message.uid === "live") controller.abort();
    return "completed";
  });
  assert.deepEqual(delivered, ["missed", "live"]);
  assert.equal(await checkpointUid(`${root}/plow-checkpoints/omitted`), "live");
});

test("optional history failure still dispatches the message with empty history", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const chat = { uid: "chat", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }] };
  const inbound = { uid: "inbound", direction: "inbound", sender: { type: "member" } };
  let historyReads = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("limit=20")) return ++historyReads === 1
      ? new Response(null, { status: 503 })
      : Response.json({ data: [inbound], has_more: false });
    return Response.json(url.endsWith("/chats") ? { data: [chat], has_more: false } :
      url.endsWith("/chats/chat") ? chat : url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" });
  });
  server.on("connection", (socket: { send: (text: string) => void }) => socket.send(JSON.stringify({
    event_type: "message_received", event_id: "event", chat_id: chat.uid, data: { message: inbound },
  })));
  const delivered: string[] = [];
  const histories: Message[][] = [];
  const logs: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, text => {
    logs.push(text);
    if (text.startsWith("acked") && delivered.length === 2) controller.abort();
  }, async (_chat, message, _first, history) => {
    delivered.push(message.uid);
    histories.push(history);
    if (delivered.length === 1) for (const socket of server.clients) socket.send(JSON.stringify({
      event_type: "message_received", event_id: "second", chat_id: chat.uid, data: { message: { ...inbound, uid: "second" } },
    }));
    return "completed";
  });
  assert.deepEqual(delivered, ["inbound", "second"]);
  assert.equal(historyReads, 2);
  assert.deepEqual(histories, [[], [inbound]]);
  assert.ok(logs.some(text => text.includes("history") && text.includes("failed")));
  assert.equal(await checkpointUid(`${root}/plow-checkpoints/chat`), "second");
});

test("invalidation during a contextualized turn reloads history on the next turn", { timeout: 40_000 }, async t => {
  const { server, apiBase } = await websocketFixture(t);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35_000);
  t.after(() => { clearTimeout(timeout); controller.abort(); });
  const chat = { uid: "chat", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }] };
  let historyReads = 0;
  let connections = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("limit=20")) historyReads++;
    return Response.json(url.endsWith("/chats") ? { data: [chat], has_more: false } :
      url.endsWith("/chats/chat") ? chat : url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" });
  });
  server.on("connection", (socket: { send: (text: string) => void }) => {
    const uid = String(++connections);
    socket.send(JSON.stringify({ event_type: "message_received", event_id: uid, chat_id: chat.uid,
      data: { message: { uid, direction: "inbound", sender: { type: "member" } } } }));
  });
  const delivered: string[] = [];
  const listeningAccount = { ...account, apiBase, lineUid: "line" };
  await listen(listeningAccount, controller.signal, text => {
    if (text.startsWith("acked chat=chat message=2")) {
      for (const socket of server.clients) socket.send(JSON.stringify({ event_type: "message_received", event_id: "3", chat_id: chat.uid,
        data: { message: { uid: "3", direction: "inbound", sender: { type: "member" } } } }));
    }
  }, async (_chat, message) => {
    delivered.push(message.uid);
    if (delivered.length === 1) for (const socket of server.clients) socket.close();
    if (message.uid === "2") {
      assert.equal(historyReads, 1);
      invalidateContextualizedHistory(listeningAccount, chat.uid);
    }
    if (delivered.length === 3) controller.abort();
    return "completed";
  });
  assert.deepEqual(delivered, ["1", "2", "3"]);
  assert.equal(historyReads, 2);
});

test("owner discovery requires the unique active self-line DM with an owner", async t => {
  const fixture = { ...account, lineUid: "line" };
  const home: Chat = { uid: "home", status: "active", trusted: true, participants: [
    { type: "agent", relationship: "self", line: { uid: "line" } },
    { type: "member", uid: "owner", role: "owner", display_name: "Owner" },
  ] };
  const others: Chat[] = [
    { ...home, uid: "inactive", status: "inactive" },
    { ...home, uid: "group", participants: [...home.participants, home.participants[1]] },
    { ...home, uid: "email", participants: [{ type: "agent", relationship: "self", line: { uid: "email" } }, home.participants[1]] },
    { ...home, uid: "peer", participants: [{ type: "agent", relationship: "peer", line: { uid: "line" } }, home.participants[1]] },
    { ...home, uid: "member", participants: [home.participants[0], { type: "member", uid: "member", role: "member", display_name: "Member" }] },
  ];
  assert.equal(findOwnerChat(fixture, others), undefined);
  assert.equal(findOwnerChat(fixture, [...others, home]), home);
  assert.throws(() => findOwnerChat(fixture, [home, { ...home, uid: "second" }]), /found 2/);
  process.env.PLOW_AGENT_TOKEN = "test-token";
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [home], has_more: true }));
  await assert.rejects(ownerChat(fixture), /truncated/);
});

test("ambiguous owner chats stop until restart instead of repeatedly discovering them", async t => {
  const { apiBase } = await websocketFixture(t);
  const controller = new AbortController();
  const logs: string[] = [];
  const participants = [
    { type: "agent", relationship: "self", line: { uid: "line" } },
    { type: "member", uid: "owner", role: "owner" },
  ];
  let tickets = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/ws/ticket")) { tickets++; return Response.json({ ticket: "ticket" }); }
    return Response.json({ data: ["first", "second"].map(uid => ({ uid, status: "active", participants })), has_more: false });
  });
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, text => {
    logs.push(text);
    if (text.includes("stopped")) queueMicrotask(() => controller.abort());
  }, async () => {
    assert.fail("Ambiguous owner chats must not dispatch");
  });
  assert.ok(logs.includes("Expected one owner's chat; found 2; stopped until restart"));
  assert.equal(tickets, 1);
});

test("a stalled WebSocket upgrade times out and reconnects after backoff", { timeout: 55_000 }, async t => {
  const { abortAfter } = await websocketFixture(t);
  const controller = abortAfter(50_000);
  const server = createServer();
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  let upgrades = 0;
  let firstClosed = false;
  const started = Date.now();
  server.on("upgrade", (_request, socket) => {
    upgrades++;
    if (upgrades === 1) socket.on("end", () => { firstClosed = true; socket.end(); });
    else controller.abort();
    // Read EOF so the fixture observes the client aborting the pending upgrade.
    socket.resume();
    // Accept TCP, but deliberately never answer the HTTP upgrade.
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address() as import("node:net").AddressInfo;
  t.mock.method(globalThis, "fetch", async () => Response.json({ ticket: "ticket" }));
  const logs: string[] = [];
  await listen({ ...account, apiBase: `http://127.0.0.1:${address.port}` }, controller.signal,
    text => logs.push(text), async () => assert.fail("An unopened socket cannot dispatch"));
  assert.equal(upgrades, 2, "must retry the stalled upgrade");
  assert.equal(firstClosed, true, "must abort the stalled connection");
  assert.ok(Date.now() - started >= 45_000, "15s handshake bound plus normal 30s backoff");
  assert.ok(logs.some(text => text.startsWith("transport stopped:")));
});

test("a buffered message preceding the HTTP baseline runs first without replay after restart", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const fixture = { ...account, apiBase, lineUid: "line" };
  const sender = { type: "member", uid: "owner", role: "owner", display_name: "Owner" };
  const chat = { uid: "home", status: "active", participants: [
    sender, { type: "agent", relationship: "self", line: { uid: "line" } },
  ] };
  // Equal timestamps still have a stable order in the API's history.
  const messages = ["X", "Y"].map(uid => ({
    uid, body: uid, direction: "inbound", sender, created_at: "2026-09-22T12:00:00Z",
  }));
  let boot = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if ((!boot && url.endsWith("limit=1")) || (boot && url.endsWith("/chats"))) {
      for (const socket of server.clients) {
        socket.send(JSON.stringify({ event_type: "message_received", event_id: `X-${boot}`,
          chat_id: chat.uid, data: { message: messages[0] } }));
        const pong = once(socket, "pong");
        socket.ping();
        await pong;
      }
    }
    if (url.endsWith("/chats")) return Response.json({ data: [chat], has_more: false });
    if (url.endsWith("/chats/home")) return Response.json(chat);
    if (url.includes("/messages?")) {
      const cursor = new URL(url).searchParams.get("starting_after");
      const newestFirst = [...messages].reverse();
      return Response.json({ data: url.endsWith("limit=1") ? [messages[1]] :
        cursor ? newestFirst.slice(newestFirst.findIndex(m => m.uid === cursor) + 1) : newestFirst,
        has_more: false });
    }
    return Response.json({ ticket: "ticket" });
  });
  const turns: string[] = [];
  for (; boot < 2; boot++) {
    await listen(fixture, abortAfter().signal, () => {}, async (_chat, message) => {
      turns.push(message.uid);
      return "completed";
    });
    assert.deepEqual(turns, ["X", "Y"], "buffered input precedes the newer HTTP baseline and neither replays on restart");
    assert.equal(await checkpointUid(`${root}/plow-checkpoints/home`), "Y");
  }
});

test("acknowledgement records its cursor without fetching history", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/chat`, JSON.stringify({ uid: "old", recent: [] }));
  const chat = acceptedChat("chat");
  let adopting = false;
  let acknowledgementReads = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (adopting && url.includes("limit=50")) acknowledgementReads++;
    return Response.json(url.endsWith("/chats") ? { data: [chat], has_more: false } :
      url.endsWith("/chats/chat") ? chat : url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" });
  });
  server.on("connection", socket => socket.send(JSON.stringify({ event_type: "message_received", chat_id: chat.uid,
    data: { message: inbound("new") } })));
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, text => {
    if (text.startsWith("acked chat=chat message=new ")) controller.abort();
  }, async (_chat, _message, _first, _history, ingress) => {
    adopting = true;
    await ingress.onAdopted();
    return "completed";
  });
  assert.equal(await checkpointUid(`${root}/plow-checkpoints/chat`), "new");
  assert.equal(acknowledgementReads, 0);
});

test("reconnect recovers at most four chats concurrently", async t => {
  const { root, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const chats = Array.from({ length: 5 }, (_, i) => acceptedChat(`chat-${i}`));
  await mkdir(`${root}/plow-checkpoints`);
  for (const chat of chats) await writeFile(`${root}/plow-checkpoints/${chat.uid}`, JSON.stringify({ uid: "old", recent: [] }));
  const release = Promise.withResolvers<void>();
  let active = 0, peak = 0, started = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("limit=50")) {
      active++;
      peak = Math.max(peak, active);
      if (++started === 4) setTimeout(release.resolve, 25);
      await release.promise;
      active--;
      if (started === 5) controller.abort();
      return Response.json({ data: [], has_more: false });
    }
    return Response.json(url.endsWith("/chats") ? { data: chats, has_more: false } : { ticket: "ticket" });
  });
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, () => {}, async () => assert.fail("Empty recovery cannot dispatch"));
  assert.equal(started, 5);
  assert.equal(peak, 4);
});

test("out-of-order adoption records its cursor and remembers both sources across restart", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/chat`, "old");
  const chat = acceptedChat("chat"), messages = [inbound("first"), inbound("second")];
  let boot = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    const history = [...messages].reverse().concat([{ uid: "old" }]);
    const cursor = new URL(url).searchParams.get("starting_after");
    return Response.json(url.endsWith("/chats") ? { data: [chat], has_more: false } : url.endsWith("/chats/chat") ? chat :
      url.includes("/messages?") ? { data: url.includes("limit=20") ? [] : cursor ? history.slice(history.findIndex(m => m.uid === cursor) + 1) : history, has_more: false } : { ticket: "ticket" });
  });
  const secondAdopted = Promise.withResolvers<void>();
  const calls: string[] = [];
  for (; boot < 2; boot++) {
    const controller = abortAfter();
    await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, text => {
      if (text.startsWith("acked chat=chat message=first ")) controller.abort();
    }, async (_chat, message, _first, _history, ingress) => {
      calls.push(message.uid);
      ingress.onSubmitted();
      if (message.uid === "first") await secondAdopted.promise;
      await ingress!.onAdopted();
      if (message.uid === "second") secondAdopted.resolve();
      return "completed";
    });
    assert.equal(await checkpointUid(`${root}/plow-checkpoints/chat`), "first");
  }
  assert.deepEqual(calls, ["first", "second"]);
});

for (const listed of [true, false]) test(`restart mid-turn replays unfinished chats once; listed=${listed}`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const chats = ["slow", "fast"].map(acceptedChat);
  let boot = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: listed || boot > 0 ? chats : [], has_more: !listed } :
    url.includes("limit=50") ? { data: url.includes("/slow/") ? [inbound("later"), inbound("slow")] : [inbound("fast")], has_more: false } :
    url.includes("/messages?") ? { data: [], has_more: false } :
    chats.find(chat => url.endsWith(`/chats/${chat.uid}`)) ?? { ticket: "ticket" }));
  server.on("connection", (socket: { send: (text: string) => void }) => {
    if (boot === 2) return;
    for (const uid of ["slow", "fast"]) socket.send(JSON.stringify({ event_type: "message_received", event_id: uid, chat_id: uid, data: { message: inbound(uid) } }));
  });
  const completed: string[] = [];
  const interrupted: string[] = [];
  for (; boot < 3; boot++) {
    const controller = abortAfter();
    await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, text => {
      if (boot === 0 && completed.includes("fast") && completed.includes("later") && text.startsWith("acked")) controller.abort();
    }, async (_chat, message, _first, _history, ingress) => {
      ingress.onSubmitted();
      if (boot === 0 && message.uid === "slow") {
        await new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
        interrupted.push(message.uid);
        return "incomplete";
      }
      completed.push(message.uid);
      return "completed";
    });
    if (boot === 0) {
      assert.deepEqual([...completed].sort(), ["fast", "later"]);
      assert.notEqual(await checkpointUid(`${root}/plow-checkpoints/slow`), "slow");
    }
  }
  assert.deepEqual(interrupted, ["slow"]);
  assert.deepEqual([...completed].sort(), ["fast", "later", "slow"]);
  assert.equal(await checkpointUid(`${root}/plow-checkpoints/slow`), "slow");
  assert.equal(await checkpointUid(`${root}/plow-checkpoints/fast`), "fast");
});

for (const stage of ["adoption", "terminal"] as const) test(`checkpoint failure at ${stage} stops transport without advancing durable progress`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/chat`, "old");
  const chat = acceptedChat("chat");
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } :
    url.endsWith("/chats/chat") ? chat : url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  const writer = t.mock.method(fs, "writeFile", async () => { throw new Error("disk failure"); });
  syncBuiltinESMExports();
  t.after(() => { writer.mock.restore(); syncBuiltinESMExports(); });
  server.on("connection", (socket: { send: (text: string) => void }) => {
    for (const uid of ["first", "later"]) socket.send(JSON.stringify({ event_type: "message_received", event_id: uid, chat_id: chat.uid,
      data: { message: inbound(uid) } }));
  });
  const calls: string[] = [];
  const logs: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, text => {
    logs.push(text);
    if (text.startsWith("transport stopped")) controller.abort();
  }, async (_chat, message, _first, _history, ingress) => {
    calls.push(message.uid);
    if (stage === "adoption") await ingress!.onAdopted();
    return "completed";
  });
  assert.ok(calls.includes("first"));
  assert.equal(await checkpointUid(`${root}/plow-checkpoints/chat`), "old");
  assert.ok(logs.some(text => text.startsWith("transport stopped")));
});

test("a failed adoption write does not poison a later in-flight acknowledgement", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/chat`, "old");
  const chat = acceptedChat("chat");
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } : url.endsWith("/chats/chat") ? chat :
    url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  const laterRequested = Promise.withResolvers<void>();
  controller.signal.addEventListener("abort", () => laterRequested.resolve());
  const originalWrite = fs.writeFile;
  let failed = false;
  const writer = t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    if (!failed) { failed = true; await laterRequested.promise; throw new Error("disk failure"); }
    return originalWrite(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { writer.mock.restore(); syncBuiltinESMExports(); });
  server.on("connection", socket => {
    for (const uid of ["first", "later"]) socket.send(JSON.stringify({ event_type: "message_received", event_id: uid,
      chat_id: chat.uid, data: { message: inbound(uid) } }));
  });
  const logs: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, text => {
    logs.push(text);
    if (text.startsWith("transport stopped")) controller.abort();
  }, async (_chat, message, _first, _history, ingress) => {
    ingress.onSubmitted();
    if (message.uid === "later") laterRequested.resolve();
    await ingress.onAdopted();
    return "completed";
  });
  assert.equal(await checkpointUid(`${root}/plow-checkpoints/chat`), "later");
  assert.ok(logs.some(text => text.startsWith("transport stopped")));
  assert.equal(logs.filter(text => text.startsWith("acked chat=chat message=later ")).length, 1);
  assert.equal(logs.filter(text => text.startsWith("acked chat=chat message=first ")).length, 0);
  const saved = JSON.parse(await readFile(`${root}/plow-checkpoints/chat`, "utf8"));
  assert.ok(saved.recent.includes("first"), "the next durable write must retain the already-adopted source");
  assert.ok(saved.recent.includes("later"));
});

for (const listed of [false, true]) test(`traversal chat IDs keep checkpoint reads and writes inside their directory; listed=${listed}`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const chat = acceptedChat("../outside");
  await writeFile(`${root}/outside`, "first:later");
  await writeFile(`${root}/outside.tmp`, "untouched");
  let boot = 0;
  server.on("connection", socket => {
    socket.send(JSON.stringify({ event_type: "message_received", event_id: `event-${boot}`,
      chat_id: chat.uid, data: { message: inbound("first") } }));
  });
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: listed ? [chat] : [], has_more: false } :
    url.endsWith(`/chats/${chat.uid}`) ? chat :
    url.endsWith("limit=50") ? { data: [inbound("later"), inbound("first")], has_more: false } :
    url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  const turns: string[] = [];
  for (; boot < 2; boot++) {
    const controller = abortAfter();
    await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, text => {
      if (text.startsWith(`acked chat=${chat.uid} message=later`)) controller.abort();
    }, async (_chat, message) => { turns.push(message.uid); return "completed"; });
    assert.deepEqual(turns, ["first", "later"]);
    assert.equal(await readFile(`${root}/outside`, "utf8"), "first:later");
    assert.equal(await readFile(`${root}/outside.tmp`, "utf8"), "untouched");
    assert.equal(await checkpointUid(`${root}/plow-checkpoints/${encodeURIComponent(chat.uid)}`), "later");
  }
});

test("email chats run concurrently and drain received work after socket close", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const chats = ["slow-email", "fast-email"].map(acceptedChat);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  controller.signal.addEventListener("abort", () => { started.resolve(); release.resolve(); });
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: chats, has_more: false } :
    url.includes("/messages?") ? { data: [], has_more: false } : chats.find(chat => url.endsWith(`/chats/${chat.uid}`)) ?? { ticket: "ticket" }));
  server.on("connection", socket => {
    for (const [chat, uid] of [["slow-email", "first"], ["slow-email", "later"], ["fast-email", "fast"]]) socket.send(JSON.stringify({
      event_type: "message_received", event_id: uid, chat_id: chat, data: { message: inbound(uid) },
    }));
  });
  const turns: string[] = [];
  const completed: string[] = [];
  const running = listen({ ...account, apiBase, accountId: "email", emailLineUid: "line" }, controller.signal, text => {
    if (text.startsWith("acked chat=slow-email message=first")) controller.abort();
  }, async (_chat, message, _first, _history, ingress) => {
    ingress.onSubmitted();
    turns.push(message.uid);
    if (message.uid === "first") await release.promise;
    if (message.uid === "fast") started.resolve();
    completed.push(message.uid);
    return "completed";
  });
  await started.promise;
  for (const socket of server.clients) {
    if (controller.signal.aborted) break;
    const pong = once(socket, "pong");
    socket.ping();
    await pong;
    const closed = once(socket, "close");
    socket.close();
    await closed;
  }
  await new Promise(resolve => setTimeout(resolve, 50));
  release.resolve();
  await running;
  assert.deepEqual([...turns].sort(), ["fast", "first", "later"]);
  assert.ok(turns.indexOf("first") < turns.indexOf("later"));
  assert.deepEqual(completed.slice(0, 2).sort(), ["fast", "later"]);
  assert.equal(completed[2], "first");
  assert.notEqual(controller.signal.reason?.name, "TimeoutError");
  assert.deepEqual(await fs.readdir(`${root}/plow-checkpoints`), []);
});

for (const listed of [false, true]) test(`empty and dot-segment chat IDs are rejected before checkpoint discovery; listed=${listed}`, async t => {
  const { server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const invalid = ["", ".", ".."];
  const chat = acceptedChat("valid");
  server.on("connection", socket => {
    for (const uid of [...invalid, chat.uid]) socket.send(JSON.stringify({
      event_type: "message_received", event_id: `event-${uid}`, chat_id: uid, data: { message: inbound(`message-${uid}`) },
    }));
  });
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: listed ? [...invalid.map(acceptedChat), chat] : [], has_more: false } :
    url.endsWith("/chats/valid") ? chat :
    url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" }));
  const logs: string[] = [];
  const turns: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, text => {
    logs.push(text);
    if (text.startsWith("transport stopped") || text.startsWith("acked chat=valid message=message-valid")) controller.abort();
  }, async (_chat, message) => { turns.push(message.uid); return "completed"; });
  assert.deepEqual(turns, ["message-valid"]);
  assert.ok(!logs.some(text => text.startsWith("transport stopped")));
  assert.notEqual(controller.signal.reason?.name, "TimeoutError");
});

test("a reply ending in NO_REPLY is never posted, and heartbeat sends say what they are", async t => {
  process.env.PLOW_AGENT_TOKEN = "test-token";
  const posts: { url: string; kind: string | null; body: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    posts.push({ url, kind: new Headers(init.headers).get("Plow-Message-Kind"), body: JSON.parse(String(init.body)) });
    return Response.json({ uid: "msg_1" });
  });
  for (const silent of ["No active subagents, nothing pending.\n\nNO_REPLY", "NO_REPLY", "Already handled. NO_REPLY\n"]) {
    assert.deepEqual(await postMessage(account, "chat", silent), { channel: "plow", messageId: "", outcome: "not_sent" });
  }
  assert.equal(posts.length, 0, "silence reaches no one");
  assert.deepEqual(await postMessage(account, "chat", "I'll reply with a bare NO_REPLY when there's nothing new."), { channel: "plow", messageId: "msg_1" });
  await postMessage(account, "chat", "Your recap is ready.", [], "heartbeat");
  assert.deepEqual(posts.map(p => p.kind), [null, "heartbeat"]);
  assert.deepEqual(posts[1], { url: "http://fixture/v1/chats/chat/messages", kind: "heartbeat", body: { body: "Your recap is ready.", attachment_uids: [] } });
});
