import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import entry from "../plugin/index.ts";
import { websocketFixture } from "./ws-fixture.ts";

type Payload = { text?: string; mediaUrls?: string[] };
type Channel = {
  gateway: { startAccount: (ctx: object) => Promise<void> };
  outbound: { sendMedia: (ctx: object) => Promise<unknown> };
};

// A fake Plow with its outbound checks: Linq's content types (here, the ones these files use) and four attachments a message.
async function plow(t: Parameters<Parameters<typeof test>[1]>[0], finals: Payload[]) {
  const { root, server, apiBase, abortAfter } = await websocketFixture(t);
  const controller = abortAfter();
  const owner = { type: "member", uid: "owner", role: "owner", display_name: "Owner", provider_key: "+15550000001" };
  const chat = { uid: "chat", status: "active", trusted: false, participants: [owner, { type: "agent", relationship: "self", line: { uid: "line" } }] };
  const workspace = `${root}/workspace`;
  await mkdir(workspace);
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
  for (const name of ["one", "two", "three", "four"]) await writeFile(`${workspace}/${name}.png`, png);
  await writeFile(`${workspace}/memo.wav`, Buffer.concat([Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt ", "latin1"), Buffer.alloc(32)]));
  await writeFile(`${workspace}/notes.yaml`, "a: 1\n");
  const declared: { filename: string; content_type?: string }[] = [];
  const posted: { body: string; attachment_uids: string[] }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL, init?: RequestInit) => {
    const path = String(url);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (path.endsWith("/chats/chat/attachments")) {
      declared.push(body);
      if (!["image/png", "audio/x-wav"].includes(body.content_type)) return Response.json({}, { status: 415 });
      return Response.json({ uid: `att_${declared.length}`, upload_url: `https://upload.fixture/${declared.length}`, upload_headers: {} }, { status: 201 });
    }
    if (path.startsWith("https://upload.fixture/")) return new Response(null, { status: 200 });
    if (path.endsWith("/chats/chat/messages") && init?.method === "POST") {
      if (body.attachment_uids.length > 4) return Response.json({}, { status: 422 });
      posted.push(body);
      return Response.json({ uid: `msg_${posted.length}` }, { status: 201 });
    }
    return Response.json(path.endsWith("/ws/ticket") ? { ticket: "ticket" } : path.endsWith("/chats") ? { data: [chat], has_more: false }
      : path.endsWith("/chats/chat") ? chat : { data: [], has_more: false });
  });
  const message = { uid: "inbound", direction: "inbound", sender: owner, body: "send them", attachments: [], created_at: new Date().toISOString() };
  server.on("connection", socket => socket.send(JSON.stringify({ event_type: "message_received", chat_id: "chat", data: { message } })));
  let channel: Channel | undefined;
  const logs: string[] = [];
  entry.register({ registrationMode: "full", registerTool() {}, logger: { info() {} }, on() {},
    registerChannel(value: { plugin: Channel }) { channel = value.plugin; },
    runtime: { channel: {
      routing: { resolveAgentRoute: () => ({ sessionKey: "main" }) },
      inbound: {
        buildContext: async () => ({}),
        dispatch: async ({ delivery }: { delivery: { deliver: (payload: Payload) => Promise<unknown> } }) => {
          for (const payload of finals) await delivery.deliver(payload);
          controller.abort();
          return { dispatched: true, dispatchResult: { counts: { final: finals.length } } };
        },
      },
    } },
  });
  const account = { apiBase, accountId: "chat", lineUid: "line" };
  return {
    workspace, declared, posted, logs,
    run: () => channel!.gateway.startAccount({ account, cfg: {}, abortSignal: controller.signal, log: { info: (line: string) => logs.push(line) } }),
    sendMedia: (mediaUrl: string) => channel!.outbound.sendMedia({ cfg: { channels: { plow: account } }, accountId: "chat", to: "chat", text: "", mediaUrl }),
  };
}

test("outbound attachments: a WAV goes as Linq's audio/x-wav, and past four they continue in a second message", async t => {
  const finals: Payload[] = [];
  const fixture = await plow(t, finals);
  finals.push({ text: "All five", mediaUrls: ["one", "two", "three", "four"].map(name => `${fixture.workspace}/${name}.png`).concat(`${fixture.workspace}/memo.wav`) });
  await fixture.run();
  assert.deepEqual(fixture.declared.map(d => d.content_type), ["image/png", "image/png", "image/png", "image/png", "audio/x-wav"]);
  assert.deepEqual(fixture.posted, [
    { body: "All five", attachment_uids: ["att_1", "att_2", "att_3", "att_4"] },
    { body: "", attachment_uids: ["att_5"] },
  ]);
});

test("a file Plow won't take: the message tool is told why, and a final reply still sends its text", async t => {
  const finals: Payload[] = [];
  const fixture = await plow(t, finals);
  finals.push({ text: "Here are the notes", mediaUrls: [`${fixture.workspace}/notes.yaml`] });
  await fixture.run();
  assert.deepEqual(fixture.posted, [{ body: "Here are the notes\n\n(I couldn't attach notes.yaml.)", attachment_uids: [] }]);
  assert.ok(fixture.logs.some(line => line.includes("Couldn't attach notes.yaml: Plow can't send application/yaml files; sending the text alone")));
  await assert.rejects(fixture.sendMedia(`${fixture.workspace}/notes.yaml`), /^Error: Couldn't attach notes\.yaml: Plow can't send application\/yaml files$/);
});
