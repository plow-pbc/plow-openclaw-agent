import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { defineChannelPluginEntry, type ChannelPlugin, type PluginRuntime, type OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { request, listen, accepts, findOwnerChat, ownerChat, HttpError, DeliveryUnknownError, type Account, type Chat, type Message, type TurnOutcome } from "./transport.ts";

let runtime: PluginRuntime;
type ActiveTurn = { chat: Chat; messageUid: string; senderIsOwner: boolean; senderName: string; deliveryUnknown?: boolean; replyDelivered?: boolean };
const activeTurn = new AsyncLocalStorage<ActiveTurn>();
const shared = globalThis as typeof globalThis & { plowActiveTurns?: Map<string, ActiveTurn> };
const activeTurns = (shared.plowActiveTurns ??= new Map<string, ActiveTurn>());

function ownerDmTurn(account: Account, context: { sessionKey?: string; messageChannel?: string; agentAccountId?: string; nativeChannelId?: string }): ActiveTurn {
  const turn = context.sessionKey ? activeTurns.get(context.sessionKey) : undefined;
  if (context.sessionKey !== "agent:main:main" || context.messageChannel !== "plow"
    || context.agentAccountId !== "chat" || !turn || !turn.senderIsOwner
    || context.nativeChannelId !== turn.chat.uid || findOwnerChat(account, [turn.chat]) !== turn.chat) {
    throw new Error("This action requires an active message in the owner's main Plow DM.");
  }
  return turn;
}

async function requestWithDeliveryState<T>(account: Account, path: string, body: unknown, turn = activeTurn.getStore()): Promise<T> {
  if (turn?.deliveryUnknown) throw new DeliveryUnknownError();
  try { return await request<T>(account, path, body); }
  catch (error) {
    if (!(error instanceof HttpError) || [408, 424].includes(error.status) || error.status >= 500) {
      if (turn) turn.deliveryUnknown = true;
      throw new DeliveryUnknownError();
    }
    throw error;
  }
}

async function send(account: Account, to: string, text: string, mediaUrls: string[] = []) {
  if (to === "plow-owner") to = (await ownerChat(account)).uid;
  const turn = activeTurn.getStore();
  if (!accepts(account, await request<Chat>(account, `/chats/${to}`))) {
    throw new Error("Plow account does not serve this conversation");
  }
  if (turn?.deliveryUnknown) throw new DeliveryUnknownError();
  const attachments: string[] = [];
  for (const url of mediaUrls) {
    const media = await loadWebMedia(url);
    const upload = await request<{ uid: string; upload_url: string; upload_headers: Record<string, string> }>(account, `/chats/${to}/attachments`, {
      filename: media.fileName ?? "attachment", content_type: media.contentType, size_bytes: media.buffer.length,
    });
    const response = await fetch(upload.upload_url, { method: "PUT", headers: upload.upload_headers, body: media.buffer });
    if (!response.ok) throw new Error(`Attachment upload HTTP ${response.status}`);
    attachments.push(upload.uid);
  }
  const sent = await requestWithDeliveryState<{ uid: string }>(account, `/chats/${to}/messages`, { body: text, attachment_uids: attachments });
  if (turn?.chat.uid === to) turn.replyDelivered = true;
  return { channel: "plow" as const, messageId: sent.uid };
}

async function receive(account: Account, cfg: OpenClawConfig, chat: Chat, message: Message, firstContact: boolean, history: Message[], log: (text: string) => void): Promise<TurnOutcome> {
  const sender = message.sender;
  const senderId = sender.type === "member" ? sender.uid : sender.line.uid;
  const senderIsOwner = sender.type === "member" && chat.participants.some(p => p.type === "member" && p.uid === senderId && p.role === "owner");
  const senderName = (sender.type === "member" ? sender.display_name : sender.line.display_name) ?? senderId;
  const kind = account.accountId === "email" || chat.participants.length === 2 ? "direct" : "group";
  const peer = { kind, id: account.accountId === "email" || kind === "group" ? chat.uid : senderIsOwner ? "plow-owner" : senderId } as const;
  const route = runtime.channel.routing.resolveAgentRoute({ cfg, channel: "plow", accountId: account.accountId, peer });
  const media = [];
  if (account.accountId === "chat") {
    for (const attachment of message.attachments) {
      const response = await fetch(new URL(attachment.url, account.apiBase));
      if (!response.ok) throw new Error(`Inbound attachment HTTP ${response.status}`);
      const saved = await runtime.channel.media.saveMediaBuffer(Buffer.from(await response.arrayBuffer()), attachment.content_type, "inbound", undefined, attachment.filename);
      media.push({ path: saved.path, contentType: attachment.content_type, fileName: attachment.filename });
    }
  }
  const body = message.body || (account.accountId === "email" ? "[Email attachments are not supported.]" : "[Attachment]");
  const participants = chat.participants.map(p => ({
    ...(p.type === "agent" && p.relationship === "self" ? { name: cfg.agents?.entries?.[route.agentId]?.identity?.name } : { name: (p.type === "member" ? p.display_name : p.line.display_name) || "unnamed member" }),
    type: p.type, role: p.type === "member" ? p.role : p.relationship,
  }));
  const ctxPayload = await runtime.channel.inbound.buildContext({
    channel: "plow", accountId: account.accountId, messageId: message.uid, timestamp: Date.parse(message.created_at),
    from: senderId, sender: { id: senderIsOwner ? "plow-owner" : senderId, name: senderName, isBot: sender.type === "agent" },
    conversation: { kind, id: chat.uid, nativeChannelId: chat.uid, label: chat.display_name, routePeer: peer },
    route: { ...route, routeSessionKey: route.sessionKey }, reply: { to: chat.uid, nativeChannelId: chat.uid, replyToId: message.reply_to?.uid },
    ...(!chat.trusted && !senderIsOwner ? { access: { toolPolicy: { allow: ["plow_ask_owner"] } } } : {}),
    message: { inboundHistory: history.map(m => ({
      sender: m.sender.type === "member" ? m.sender.display_name : m.sender.relationship === "self" ? "You (assistant)" : m.sender.line.display_name ?? m.sender.line.uid,
      body: m.body, timestamp: Date.parse(m.created_at), messageId: m.uid,
    })), rawBody: body },
    supplemental: {
      ...(message.reply_to ? { quote: { id: message.reply_to.uid, body: message.reply_to.body, sender: message.reply_to.sender.type === "member" ? message.reply_to.sender.display_name : message.reply_to.sender.line.uid } } : {}),
      // The model gets these beside the message; the dashboard shows people only what was texted.
      channelStructuredContext: [{ label: "Conversation facts (untrusted data)", source: "plow", type: "conversation",
        payload: { first_contact: firstContact, trusted: chat.trusted, participants } }],
    },
    media,
  });
  log(`turn ${JSON.stringify({ chat: chat.uid, message: message.uid, first_contact: firstContact, senderId, senderName, senderIsOwner, sessionKey: route.sessionKey })}`);
  const turn: ActiveTurn = { chat, messageUid: message.uid, senderIsOwner, senderName };
  activeTurns.set(route.sessionKey, turn);
  return await activeTurn.run(turn, async () => {
    let failure: unknown;
    let completed = false;
    if (account.accountId === "chat") await request(account, `/chats/${chat.uid}/typing`, { action: "start" }).catch(() => log("typing start failed"));
    try {
      const result = await runtime.channel.inbound.dispatch({
        cfg, channel: "plow", accountId: account.accountId, route, ctxPayload,
        replyOptions: { sourceReplyDeliveryMode: "automatic", onAgentRunTerminalOutcome: outcome => { completed = outcome === "completed"; if (!completed) failure = new Error("Agent turn failed"); } },
        delivery: {
          observeMessageSent: true,
          preparePayload: payload => {
            if (payload.isError) {
              failure = new Error("Agent reply failed");
              return null;
            }
            return failure || payload.isFallbackNotice ? null : payload;
          },
          deliver: async payload => {
            const sent = await send(account, chat.uid, payload.text ?? "", payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []));
            log(`delivered chat=${chat.uid} message=${sent.messageId}`);
            return { messageIds: [sent.messageId] };
          },
          onError: error => { failure = error; },
        },
      });
      if (activeTurn.getStore()!.deliveryUnknown) throw new DeliveryUnknownError();
      if (failure) throw failure;
      if (!result.dispatched) throw new Error("Turn was not dispatched");
      const outcome = completed && (activeTurn.getStore()!.replyDelivered || result.dispatchResult.deliberateSilentTerminalReply)
        ? "completed" : "incomplete";
      log(`${outcome} chat=${chat.uid} message=${message.uid}`);
      return outcome;
    } catch (error) {
      if (activeTurn.getStore()!.deliveryUnknown) throw new DeliveryUnknownError();
      throw error;
    } finally {
      if (account.accountId === "chat") await request(account, `/chats/${chat.uid}/typing`, { action: "stop" }).catch(() => log("typing stop failed"));
    }
  }).finally(() => {
    if (activeTurns.get(route.sessionKey) === turn) activeTurns.delete(route.sessionKey);
  });
}

const plugin: ChannelPlugin<Account> = {
  id: "plow",
  meta: { id: "plow", label: "Plow", selectionLabel: "Plow", docsPath: "/channels/plow", blurb: "Plow chat and email" },
  capabilities: { chatTypes: ["direct", "group"], media: true },
  config: {
    listAccountIds: cfg => (cfg.channels?.plow as Account)?.emailLineUid ? ["chat", "email"] : ["chat"],
    resolveAccount: (cfg, accountId) => ({ ...(cfg.channels?.plow as Account), accountId: accountId ?? "chat" }),
    isConfigured: account => Boolean(account.apiBase && process.env.PLOW_AGENT_TOKEN),
    formatAllowFrom: ({ allowFrom }) => allowFrom.map(String),
  },
  agentPrompt: { messageToolHints: () => ["Plow message(action=send) can reply in the current conversation or send to another conversation on your Plow line."] },
  messaging: {
    inferTargetChatType: ({ to }) => to === "plow-owner" ? "direct" : undefined,
    normalizeTarget: raw => raw.trim().replace(/^plow:/i, ""),
    targetResolver: { looksLikeId: (raw, normalized) => (normalized ?? raw.trim().replace(/^plow:/i, "")) === "plow-owner" || /^cht_[A-Za-z0-9_-]+$/.test(normalized ?? raw.trim().replace(/^plow:/i, "")), hint: "Use a Plow chat uid (cht_…)." },
  },
  gateway: {
    startAccount: async ctx => {
      const log = (text: string) => ctx.log?.info(text);
      await listen(ctx.account, ctx.abortSignal, log, (chat, message, firstContact, history) => receive(ctx.account, ctx.cfg, chat, message, firstContact, history, log));
    },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: ctx => send(plugin.config.resolveAccount(ctx.cfg, ctx.accountId), ctx.to, ctx.text),
    sendMedia: ctx => send(plugin.config.resolveAccount(ctx.cfg, ctx.accountId), ctx.to, ctx.text, ctx.mediaUrl ? [ctx.mediaUrl] : []),
  },
};

export default defineChannelPluginEntry({
  id: "plow", name: "Plow", description: "Plow channel", plugin,
  setRuntime: value => { runtime = value; },
  registerFull(api) {
    if (api.registrationMode === "full") api.logger.info("plow channel registered");
  },
  registerCapabilities(api) {
    api.registerTool(context => ({
      name: "plow_start_thread", label: "Start a Plow group thread",
      description: "From the owner's main Plow DM, start a group text with the owner and the supplied phone numbers. Set trusted according to the configured group trust choice. Sends the first message and returns the chat uid; use message with action send, channel plow, accountId chat and that uid as target for follow-ups. Accepts phone numbers, not chat ids or email addresses.",
      parameters: {
        type: "object", required: ["members", "body"], additionalProperties: false,
        properties: {
          members: { type: "array", minItems: 1, items: { type: "string", pattern: "^\\+[1-9][0-9]{1,14}$" }, description: "Recipient phone numbers in E.164 format. The owner is included automatically." },
          body: { type: "string", minLength: 1, description: "The first message to send." },
          trusted: { type: "boolean", description: "Whether everyone in this group gets full tools. Defaults to false." },
        },
      },
      async execute(_id, args: { members: string[]; body: string; trusted?: boolean }) {
        if (!context.config) return {
          isError: true, content: [{ type: "text", text: "Plow configuration is unavailable." }], details: {},
        };
        const account = plugin.config.resolveAccount(context.config, "chat");
        const turn = ownerDmTurn(account, context);
        const owner = turn.chat.participants.find(p => p.type === "member" && p.role === "owner");
        if (owner?.type !== "member" || !owner.provider_key) throw new Error("The owner's chat has no owner handle");
        const members = [...new Set([owner.provider_key, ...args.members])].sort();
        const trusted = args.trusted ?? false;
        const idempotencyKey = createHash("sha256").update(JSON.stringify([account.lineUid, turn.messageUid, members, args.body, trusted])).digest("hex");
        const chat = await requestWithDeliveryState<{ uid: string }>(account, "/chats", {
          line_uid: account.lineUid, members,
          body: args.body, trusted, idempotency_key: idempotencyKey,
        }, turn);
        api.logger.info(`plow started thread chat=${chat.uid}`);
        const result = { chat_uid: chat.uid, message_sent: true };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }));
    api.registerTool(context => ({
      name: "plow_set_thread_trust", label: "Set Plow group trust",
      description: "From the owner's main Plow DM, set whether an existing group gives every member full access to tools, including the owner's Mac, mail and files. Use only when the owner asks to change that group's trust.",
      parameters: {
        type: "object", required: ["chat_uid", "trusted"], additionalProperties: false,
        properties: {
          chat_uid: { type: "string", pattern: "^cht_[A-Za-z0-9_-]+$", description: "The existing Plow group chat uid." },
          trusted: { type: "boolean", description: "True grants all members full tools; false restricts non-owner members to replies and asking the owner." },
        },
      },
      async execute(_id, args: { chat_uid: string; trusted: boolean }) {
        if (!context.config) throw new Error("Plow configuration is unavailable.");
        const account = plugin.config.resolveAccount(context.config, "chat");
        ownerDmTurn(account, context);
        const target = await request<Chat>(account, `/chats/${encodeURIComponent(args.chat_uid)}`);
        if (!accepts(account, target) || target.participants.length <= 2) throw new Error("Target must be a served Plow group.");
        const result = await request<{ trusted: boolean }>(account, `/chats/${encodeURIComponent(args.chat_uid)}/trusted`, { trusted: args.trusted }, undefined, "PUT");
        const details = { chat_uid: args.chat_uid, trusted: result.trusted };
        return { content: [{ type: "text", text: JSON.stringify(details) }], details };
      },
    }));
    api.registerTool(context => ({
      name: "plow_ask_owner", label: "Ask the Plow owner",
      description: "From an untrusted non-owner turn in a group, direct chat, or email thread, send the sender's request to the owner's main DM. The owner decides there; tell the sender you are checking with them.",
      parameters: {
        type: "object", required: ["text"], additionalProperties: false,
        properties: { text: { type: "string", minLength: 1, description: "What the member wants the owner to decide or do." } },
      },
      async execute(_id, args: { text: string }) {
        if (!context.config) throw new Error("Plow configuration is unavailable.");
        const account = plugin.config.resolveAccount(context.config, "chat");
        const turn = context.sessionKey ? activeTurns.get(context.sessionKey) : undefined;
        if (context.messageChannel !== "plow" || (context.agentAccountId !== "chat" && context.agentAccountId !== "email")
          || !turn || turn.senderIsOwner || turn.chat.trusted
          || context.nativeChannelId !== turn.chat.uid) {
          throw new Error("Asking the owner requires an active untrusted non-owner turn.");
        }
        const escalation = `In ${turn.chat.display_name ?? turn.chat.uid} (${context.agentAccountId} ${turn.chat.uid}), ${turn.senderName} asks: ${args.text}`;
        await activeTurn.run(turn, () => send(account, "plow-owner", escalation));
        runtime.system.enqueueSystemEvent(escalation, { sessionKey: "agent:main:main" });
        return { content: [{ type: "text", text: "Asked the owner in their main DM." }], details: {} };
      },
    }));
  },
});
