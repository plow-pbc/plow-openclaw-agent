import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { checkpointUid, websocketFixture } from "./ws-fixture.ts";
import fs, { mkdir, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { listen, DeliveryUnknownError, recover, findOwnerChat, ownerChat, invalidateContextualizedHistory, postMessage, isSilent, type Account, type Chat, type Message } from "../plugin/transport.ts";

const account = { apiBase: "http://fixture", accountId: "chat" } as Account;
const message = (uid: string) => ({ uid }) as Message;
const acceptedChat = (uid: string) => ({
  uid, status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }],
});
const inbound = (uid: string) => ({ uid, direction: "inbound", sender: { type: "member" } });

for (const interruption of ["incomplete", "error", "abort-before-admission"] as const) test(`a speaker change cannot checkpoint past an unadopted next message: ${interruption}`, async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/home`, JSON.stringify({ uid: "old", recent: ["old"] }));
  const owner = { type: "member" as const, uid: "owner", role: "owner", provider_key: "+15550000001" };
  const guest = { ...owner, uid: "guest", role: "member", provider_key: "+15550000002" };
  const chat: Chat = { uid: "home", status: "active", trusted: true, participants: [owner, guest,
    { type: "agent", relationship: "self", line: { uid: "line" } }] };
  const message = (uid: string, sender = owner): Message => ({ uid, sender, direction: "inbound", body: uid, attachments: [], created_at: new Date().toISOString() });
  const first = message("first"), next = message("next", guest);
  const frame = (message: Message) => JSON.stringify({ event_type: "message_received", event_id: message.uid, chat_id: chat.uid, data: { message } });
  let boot = 0;
  server.on("connection", socket => { if (boot === 0) socket.send(frame(first)); });
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(
    url.endsWith("/chats") ? { data: [chat], has_more: false } : url.endsWith("/chats/home") ? chat :
    url.includes("/messages?") ? { data: url.includes("limit=20") ? [] : boot ? [next, first, message("old")] : [message("old")], has_more: false } : { ticket: "ticket" }));
  const turns: string[] = [];
  for (; boot < 2; boot++) {
    const controller = abortAfter();
    await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, text => {
      if (boot === 0 && text.includes("message=first") && text.startsWith("buffered ")) for (const socket of server.clients) socket.send(frame(next));
      if (boot === 0 && text.startsWith("turn incomplete chat=home message=next")) controller.abort();
      if (boot === 1 && text.startsWith("acked chat=home message=next")) controller.abort();
    }, async (_chat, message, _first, _history, ingress) => {
      turns.push(message.uid);
      if (message.uid === "first") {
        await ingress.onAdopted();
        if (boot === 0 && interruption === "abort-before-admission") controller.abort();
      }
      if (message.uid === "next" && boot === 0 && interruption === "error") throw new Error("interrupted before adoption");
      return message.uid === "next" && boot === 0 ? "incomplete" : "completed";
    }, { messages: { inbound: { byChannel: { plow: 50 } } } });
    if (boot === 0) {
      const saved = JSON.parse(await readFile(`${root}/plow-checkpoints/home`, "utf8"));
      assert.equal(saved.uid, "old");
      assert.ok(saved.recent.includes("first"));
      assert.ok(!saved.recent.includes("next"));
    }
  }
  assert.deepEqual(turns, interruption === "abort-before-admission" ? ["first", "next"] : ["first", "next", "next"]);
});

test("recovery pages beyond 50 messages to the checkpoint and preserves inclusive replay", async t => {
  process.env.PLOW_AGENT_TOKEN = "test-token";
  const urls: string[] = [];
  const newest = Array.from({ length: 50 }, (_, i) => message(`new-${49 - i}`));
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(url);
    return Response.json(url.includes("starting_after=")
      ? { data: [message("older-unread"), message("acked"), message("already-read")], has_more: true }
      : { data: newest, has_more: true });
  });
  assert.deepEqual((await recover(account, "chat", "acked")).map(m => m.uid), ["older-unread", ...newest.map(m => m.uid).reverse()]);
  assert.deepEqual(urls, ["http://fixture/v1/chats/chat/messages?limit=50", "http://fixture/v1/chats/chat/messages?limit=50&starting_after=new-0"]);
  assert.deepEqual((await recover(account, "chat", "first:acked")).map(m => m.uid), ["acked", "older-unread", ...newest.map(m => m.uid).reverse()]);
});

test("first contact recovers an owner backlog beyond 50 through its answered boundary", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const sender = { type: "member", uid: "owner", role: "owner", provider_key: "+15550000001" };
  const chat = { ...acceptedChat("home"), participants: [...acceptedChat("home").participants, sender] };
  const backlog = Array.from({ length: 60 }, (_, i) => ({ ...inbound(`missed-${i}`), sender }));
  const older = [...backlog.slice(0, 10).reverse(), { ...inbound("answered"), direction: "outbound" }, inbound("old-history")];
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(url);
    return Response.json(url.endsWith("/chats") ? { data: [chat], has_more: false } :
      url.endsWith("/chats/home") ? chat : url.includes("limit=1") ? { data: [backlog.at(-1)], has_more: true } :
      url.includes("starting_after=missed-10") ? { data: older, has_more: false } :
      url.includes("limit=50") ? { data: backlog.slice(10).reverse(), has_more: true } : { ticket: "ticket" });
  });
  const received: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, () => {}, async (_chat, message, _first, _history, ingress) => {
    received.push(message.uid);
    ingress.onSubmitted();
    if (message.uid === "missed-59") controller.abort();
    return "completed";
  });
  assert.deepEqual(received, backlog.map(m => m.uid));
  assert.equal(await checkpointUid(`${root}/plow-checkpoints/home`), "missed-59");
  assert.ok(urls.some(url => url.includes("starting_after=missed-10")));
});

test("a non-advancing history page fails instead of advancing past unread work", async t => {
  process.env.PLOW_AGENT_TOKEN = "test-token";
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [message("same")], has_more: true }));
  await assert.rejects(recover(account, "chat", "missing"), /pagination did not advance/);
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

test("recovery beyond the seen cache does not replay buffered frames or rewind the checkpoint", async t => {
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
    const remaining = cursor ? history.slice(history.findIndex(m => m.uid === cursor) + 1) : history;
    return Response.json(url.endsWith("/chats") ? { data: [chat], has_more: false } : url.endsWith("/chats/group") ? chat :
      url.includes("/messages?") ? { data: url.includes("limit=20") ? [] : remaining.slice(0, 50), has_more: !url.includes("limit=20") && remaining.length > 50 } : { ticket: "ticket" });
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
  assert.deepEqual(received, [...messages.map(message => message.uid), "live"]);
  assert.equal(await checkpointUid(`${root}/plow-checkpoints/group`), "live");
});

test("an interrupted backlog beyond 512 does not replay adopted sources across three boots", async t => {
  const { root, apiBase, abortAfter } = await websocketFixture(t);
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/chat`, JSON.stringify({ uid: "old", recent: [] }));
  const chat = acceptedChat("chat");
  const messages = Array.from({ length: 514 }, (_, i) => inbound(`source-${i}`));
  const history = [...messages].reverse().concat([{ uid: "old" }]);
  t.mock.method(globalThis, "fetch", async (url: string) => {
    const cursor = new URL(url).searchParams.get("starting_after");
    const start = cursor ? history.findIndex(message => message.uid === cursor) + 1 : 0;
    return Response.json(url.endsWith("/chats") ? { data: [chat], has_more: false } : url.endsWith("/chats/chat") ? chat :
      url.includes("limit=50") ? { data: history.slice(start, start + 50), has_more: start + 50 < history.length } :
      url.includes("/messages?") ? { data: [], has_more: false } : { ticket: "ticket" });
  });
  const calls: string[] = [];
  for (let boot = 0; boot < 3; boot++) {
    const controller = abortAfter();
    await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, text => {
      if (boot === 0 && text.startsWith("acked chat=chat message=source-513 ")) controller.abort();
    }, async (_chat, message, _first, _history, ingress) => {
      calls.push(message.uid);
      ingress.onSubmitted();
      if (boot === 0 && message.uid === "source-0") {
        await new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
        return "incomplete";
      }
      return "completed";
    });
    if (boot === 0) {
      const checkpoint = JSON.parse(await readFile(`${root}/plow-checkpoints/chat`, "utf8"));
      assert.equal(checkpoint.uid, "old");
      assert.equal(checkpoint.recent.length, 513, "every adoption behind the pinned cursor must survive restart");
    }
  }
  assert.equal(calls.filter(uid => uid === "source-0").length, 2);
  for (const message of messages.slice(1)) assert.equal(calls.filter(uid => uid === message.uid).length, 1, message.uid);
  assert.equal(await checkpointUid(`${root}/plow-checkpoints/chat`), "source-513");
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
  const fresh = { ...messages[1], uid: "Z", body: "Z" };
  let boot = 0;
  let controller: AbortController;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if ((!boot && url.endsWith("limit=1")) || (boot && url.endsWith("/chats"))) {
      for (const socket of server.clients) {
        // On restart, a fresh frame follows the duplicate and proves both were consumed.
        for (const message of boot ? [messages[0], fresh] : [messages[0]]) {
          socket.send(JSON.stringify({ event_type: "message_received", event_id: `${message.uid}-${boot}`,
            chat_id: chat.uid, data: { message } }));
        }
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
    controller = abortAfter(30_000);
    await listen(fixture, controller.signal, text => {
      if (text.startsWith(`acked chat=home message=${boot ? "Z" : "Y"} `)) controller.abort();
    }, async (_chat, message) => {
      turns.push(message.uid);
      return "completed";
    });
    assert.notEqual(controller.signal.reason?.name, "TimeoutError", "wait for the final checkpoint, not a deadline");
    assert.deepEqual(turns, boot ? ["X", "Y", "Z"] : ["X", "Y"], "buffered input precedes the newer HTTP baseline and neither replays on restart");
    assert.equal(await checkpointUid(`${root}/plow-checkpoints/home`), boot ? "Z" : "Y");
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
    assert.equal(await checkpointUid(`${root}/plow-checkpoints/chat`), "second");
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
      assert.notEqual(await checkpointUid(`${root}/plow-checkpoints/slow`), "later");
    }
  }
  assert.deepEqual(interrupted, ["slow"]);
  assert.deepEqual([...completed].sort(), ["fast", "later", "slow"]);
  assert.equal(await checkpointUid(`${root}/plow-checkpoints/slow`), "later");
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

test("a guest's reply that arrived while disconnected, in a chat with no checkpoint yet, is delivered on reconnect", async t => {
  const { root, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const guest = { type: "member", uid: "guest", role: "member", display_name: "Mary" };
  const self = { type: "agent", relationship: "self", line: { uid: "line" } };
  const owner = { type: "member", uid: "owner", role: "owner", display_name: "Sam" };
  const started = { uid: "started", status: "active", participants: [owner, guest, self] };
  const quiet = { uid: "quiet", status: "active", participants: [owner, guest, self] };
  // Newest first, as the API returns them.
  const history: Record<string, object[]> = {
    started: [{ uid: "reply", body: "1", direction: "inbound", sender: guest, created_at: "2026-10-05T17:03:20Z" },
      { uid: "vcard", body: "", direction: "outbound", sender: self, created_at: "2026-10-05T17:02:48Z" },
      { uid: "intro", body: "Hi Mary", direction: "outbound", sender: self, created_at: "2026-10-05T17:02:08Z" }],
    quiet: [{ uid: "old", body: "see you", direction: "inbound", sender: guest, created_at: "2026-09-01T10:00:00Z" }],
  };
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/chats")) return Response.json({ data: [started, quiet], has_more: false });
    for (const chat of [started, quiet]) {
      if (url.endsWith(`/chats/${chat.uid}`)) return Response.json(chat);
      if (url.includes(`/chats/${chat.uid}/messages?`)) {
        const rows = history[chat.uid]!;
        const after = new URL(url).searchParams.get("starting_after");
        const limit = Number(new URL(url).searchParams.get("limit"));
        return Response.json({ data: (after ? rows.slice(rows.findIndex(m => (m as Message).uid === after) + 1) : rows).slice(0, limit), has_more: false });
      }
    }
    return Response.json({ ticket: "ticket" });
  });
  // Listening since before the thread started; the outage came later.
  await writeFile(`${root}/plow-listening-since`, "2026-10-05T16:27:31Z");
  const turns: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, () => {}, async (chat, message) => {
    turns.push(`${chat.uid}/${message.uid}`);
    controller.abort();
    return "completed";
  });
  assert.deepEqual(turns, ["started/reply"]);
  assert.equal(await checkpointUid(`${root}/plow-checkpoints/started`), "reply");
  assert.equal(await checkpointUid(`${root}/plow-checkpoints/quiet`), "old", "history from before the agent first listened stays unanswered");
});

test("a dropped socket reconnects while a turn is still running, and replays it if that turn ends incomplete", async t => {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  await mkdir(`${root}/plow-checkpoints`);
  await writeFile(`${root}/plow-checkpoints/chat`, JSON.stringify({ uid: "old", recent: [] }));
  const chat = acceptedChat("chat");
  let tickets = 0;
  let running = false;
  const reconnected = Promise.withResolvers<void>();
  const recovering = Promise.withResolvers<void>();
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/ws/ticket")) {
      if (++tickets === 2) {
        assert.equal(running, true, "reconnect must not wait for the turn");
        reconnected.resolve();
      }
      return Response.json({ ticket: "ticket" });
    }
    return Response.json(url.endsWith("/chats") ? { data: [chat], has_more: false } :
      url.endsWith("/chats/chat") ? chat :
      url.includes("limit=50") ? (tickets === 2 && recovering.resolve(), { data: [inbound("slow"), { uid: "old", direction: "outbound", sender: { type: "agent" } }], has_more: false }) :
      { data: [], has_more: false });
  });
  server.once("connection", socket => socket.send(JSON.stringify({ event_type: "message_received", chat_id: chat.uid,
    data: { message: inbound("slow") } })));
  const dispatches: string[] = [];
  await listen({ ...account, apiBase, lineUid: "line" }, controller.signal, () => {}, async (_chat, message, _first, _history, ingress) => {
    dispatches.push(message.uid);
    ingress.onSubmitted();
    if (dispatches.length > 1) {
      controller.abort();
      return "completed";
    }
    running = true;
    // The socket drops while the model is still retrying; the retry backoff runs on mock time.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const socket of server.clients) socket.terminate();
    while (tickets < 2 && !controller.signal.aborted) {
      t.mock.timers.tick(1_000);
      await new Promise(resolve => setImmediate(resolve));
    }
    t.mock.timers.reset();
    await reconnected.promise;
    // Finish only after the reconnect has read this message back for replay.
    await recovering.promise;
    await new Promise(resolve => setTimeout(resolve, 50));
    running = false;
    return "incomplete";
  });
  assert.equal(tickets, 2);
  assert.deepEqual(dispatches, ["slow", "slow"], "the reconnect's replay waits for the running turn, then retries what it left unfinished");
});


test("only the phone listener records when the agent first listened", async t => {
  const { root, apiBase, abortAfter } = await websocketFixture(t);
  await fs.rm(`${root}/plow-listening-since`);
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(url.endsWith("/chats") ? { data: [], has_more: false } : { ticket: "ticket" }));
  const email = abortAfter(200);
  await listen({ ...account, apiBase, accountId: "email", lineUid: "line" } as Account, email.signal, () => {}, async () => "completed");
  await assert.rejects(readFile(`${root}/plow-listening-since`, "utf8"), { code: "ENOENT" });
  const phone = abortAfter(200);
  await listen({ ...account, apiBase, lineUid: "line" }, phone.signal, () => {}, async () => "completed");
  assert.ok(Number.isFinite(Date.parse(await readFile(`${root}/plow-listening-since`, "utf8"))));
});

test("a reply ending in NO_REPLY is never posted, and heartbeat sends say what they are", async t => {
  process.env.PLOW_AGENT_TOKEN = "test-token";
  const posts: { url: string; kind: string | null; body: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    posts.push({ url, kind: new Headers(init.headers).get("Plow-Message-Kind"), body: JSON.parse(String(init.body)) });
    return Response.json({ uid: "msg_1" });
  });
  for (const silent of ["No active subagents, nothing pending.\n\nNO_REPLY", "NO_REPLY", "Done here.\n\n*NO_REPLY*", "All clear.\n.NO_REPLY\n"]) {
    assert.deepEqual(await postMessage(account, "chat", silent), { channel: "plow", messageId: "", outcome: "not_sent" });
  }
  assert.equal(posts.length, 0, "silence reaches no one");
  assert.deepEqual(await postMessage(account, "chat", "I'll reply with a bare NO_REPLY when there's nothing new."), { channel: "plow", messageId: "msg_1" });
  assert.deepEqual(await postMessage(account, "chat", "1. You: hi\n2. Me: NO_REPLY\n3. You: test"), { channel: "plow", messageId: "msg_1" }, "a transcript quoting the marker still sends");
  await postMessage(account, "chat", "Your recap is ready.", [], "heartbeat");
  assert.deepEqual(posts.map(p => p.kind), [null, null, "heartbeat"]);
  assert.deepEqual(posts[2], { url: "http://fixture/v1/chats/chat/messages", kind: "heartbeat", body: { body: "Your recap is ready.", attachment_uids: [] } });
});

// Shared verbatim with hermes-plugin-plow (tests/test_adapter.py) and Plow's server-side guard. Keep the
// three lists identical.
const SILENCE_MARKER_CASES: [string, boolean][] = [
  ["No active subagents, nothing pending.\n\nNO_REPLY", true],
  ["NO_REPLY", true],
  ["*NO_REPLY*", true],
  [".NO_REPLY", true],
  ["`NO_REPLY`", true],
  ["Done here.\n\n_NO_REPLY_\n", true],
  ["NO_REPLY!", false],
  ["I'll reply with a bare NO_REPLY when there's nothing new.", false],
  ["1. You: hi\n2. Me: NO_REPLY\n3. You: test", false],
  ["", false],
];

test("the silence marker follows Hermes' grammar, case for case", () => {
  for (const [text, silent] of SILENCE_MARKER_CASES) assert.equal(isSilent(text), silent, JSON.stringify(text));
});
