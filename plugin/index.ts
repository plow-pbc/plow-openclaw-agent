import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { createHash } from "node:crypto";
import { defineChannelPluginEntry, type ChannelPlugin, type PluginRuntime, type OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { createChannelMessageReplyPipeline, buildOutboundSessionContext, sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import { hasVisibleChannelTurnDispatch } from "openclaw/plugin-sdk/channel-message";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { request, listen, accepts, findOwnerChat, ownerChat, invalidateContextualizedHistory, HttpError, DeliveryUnknownError, type Account, type Chat, type Message, type TurnOutcome, type TurnIngress } from "./transport.ts";

let runtime: PluginRuntime;

function normalizedHandle(handle: string): string {
  const compact = handle.trim().replace(/[\s().-]/g, "");
  return /^\+\d{10,15}$/.test(compact) ? compact : handle.trim().toLowerCase();
}

type Requester = Pick<OpenClawPluginToolContext, "sessionKey" | "messageChannel" | "agentAccountId" | "nativeChannelId" | "requesterSenderId" | "senderIsOwner">;
async function ownerDmTurn(account: Account, context: Requester): Promise<{ chat: Chat }> {
  if (context.sessionKey !== "agent:main:main" || context.messageChannel !== "plow" || !context.senderIsOwner
    || context.agentAccountId !== "chat" || !context.nativeChannelId || !context.requesterSenderId) throw new Error("This action requires the owner's main Plow DM.");
  const chat = await request<Chat>(account, `/chats/${encodeURIComponent(context.nativeChannelId)}`);
  if (findOwnerChat(account, [chat]) !== chat) throw new Error("This action requires the owner's main Plow DM.");
  return { chat };
}

async function requestDelivery<T>(account: Account, path: string, body: unknown, method: "POST" | "PUT" = "POST"): Promise<T> {
  try { return await request<T>(account, path, body, undefined, method); }
  catch (error) {
    if (!(error instanceof HttpError) || [408, 424].includes(error.status) || error.status >= 500) {
      throw new DeliveryUnknownError();
    }
    throw error;
  }
}

async function send(account: Account, to: string, text: string, mediaUrls: string[] = []) {
  to = to.replace(/^plow:/i, "");
  if (to === "plow-owner") to = (await ownerChat(account)).uid;
  if (!accepts(account, await request<Chat>(account, `/chats/${to}`))) {
    throw new Error("Plow account does not serve this conversation");
  }
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
  const sent = await requestDelivery<{ uid: string }>(account, `/chats/${to}/messages`, { body: text, attachment_uids: attachments });
  return { channel: "plow" as const, messageId: sent.uid };
}

async function durableSend(cfg: OpenClawConfig, route: { agentId: string; sessionKey: string }, accountId: string, to: string, routeTo: string, text: string, kind: "direct" | "group") {
  await runtime.channel.session.updateLastRoute({
    storePath: runtime.channel.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId }),
    sessionKey: route.sessionKey, channel: "plow", accountId, to: routeTo, createIfMissing: true,
  });
  const result = await sendDurableMessageBatch({
    cfg, channel: "plow", accountId, to, payloads: [{ text }],
    session: buildOutboundSessionContext({ cfg, ...route, conversationType: kind }),
    mirror: route, skipQueue: true,
  });
  if (result.status !== "sent") {
    throw new DeliveryUnknownError();
  }
  return result.results[0].messageId;
}

async function receive(account: Account, cfg: OpenClawConfig, chat: Chat, message: Message, firstContact: boolean, history: Message[], ingress: TurnIngress, log: (text: string) => void): Promise<TurnOutcome> {
  const sender = message.sender;
  const senderIsOwner = sender.type === "member" && chat.participants.some(p => p.type === "member" && p.uid === sender.uid && p.role === "owner");
  const senderId = sender.type === "member" ? senderIsOwner ? "plow-owner" : normalizedHandle(sender.provider_key) : sender.line.uid;
  const senderName = (sender.type === "member" ? sender.display_name : sender.line.display_name) ?? senderId;
  const kind = account.accountId === "email" || chat.participants.length === 2 ? "direct" : "group";
  const peer = { kind, id: account.accountId === "email" || kind === "group" || (sender.type === "member" && !senderIsOwner) ? chat.uid : senderId } as const;
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
  const command = account.accountId === "chat" && body.startsWith("/") ? { kind: "text-slash" as const, authorized: senderIsOwner, body } : undefined;
  const participants = chat.participants.map(p => ({
    ...(p.type === "agent" && p.relationship === "self" ? { name: cfg.agents?.entries?.[route.agentId]?.identity?.name } : { name: (p.type === "member" ? p.display_name : p.line.display_name) || "unnamed member" }),
    type: p.type, role: p.type === "member" ? p.role : p.relationship,
  }));
  const ctxPayload = await runtime.channel.inbound.buildContext({
    channel: "plow", accountId: account.accountId, messageId: message.uid, timestamp: Date.parse(message.created_at),
    from: kind === "group" ? `plow:group:${chat.uid}` : `plow:${senderId}`, sender: { id: senderId, name: senderName, isBot: sender.type === "agent" },
    conversation: { kind, id: chat.uid, nativeChannelId: chat.uid, label: chat.display_name, routePeer: peer },
    route: { ...route, routeSessionKey: route.sessionKey }, reply: { to: `plow:${chat.uid}`, originatingTo: `plow:${chat.uid}`, nativeChannelId: chat.uid, replyToId: message.reply_to?.uid },
    access: { commands: { authorized: senderIsOwner } },
    ...(command ? { command } : {}),
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
  const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
    cfg, agentId: route.agentId, channel: "plow", accountId: account.accountId,
    typing: account.accountId === "chat" ? {
      start: () => request<void>(account, `/chats/${chat.uid}/typing`, { action: "start" }),
      stop: () => request<void>(account, `/chats/${chat.uid}/typing`, { action: "stop" }),
      keepaliveIntervalMs: 8_000, maxDurationMs: 10 * 60_000,
      onStartError: () => log("typing start failed"), onStopError: () => log("typing stop failed"),
    } : undefined,
  });
  let failure: unknown;
  let observedReplyDelivery = false;
  const dispatched = runtime.channel.inbound.dispatch({
    cfg, channel: "plow", accountId: account.accountId, route, ctxPayload,
    dispatcherOptions: replyPipeline,
    replyOptions: {
      turnAdoptionLifecycle: ingress,
      onModelSelected,
      onAgentRunStart: runId => log(`run started chat=${chat.uid} message=${message.uid} run=${runId}`),
      ...(!chat.trusted && !senderIsOwner ? { disableTools: true } : {}),
      sourceReplyDeliveryMode: command && !senderIsOwner && chat.trusted ? "message_tool_only" : "automatic",
      onObservedReplyDelivery: () => { observedReplyDelivery = true; },
      onAgentRunTerminalOutcome: outcome => { if (outcome === "failed") failure = new Error("Agent turn failed"); },
    },
    delivery: {
      observeMessageSent: true,
      preparePayload: (payload, info) => payload.isFallbackNotice || (observedReplyDelivery && info.kind === "final") ? null : payload,
      deliver: async payload => {
        const sent = await send(account, chat.uid, payload.text ?? "", payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []));
        log(`delivered chat=${chat.uid} message=${sent.messageId}`);
        return { messageIds: [sent.messageId] };
      },
      onError: error => { failure = error; },
    },
  });
  ingress.onSubmitted();
  const result = await dispatched;
  if (failure) throw failure;
  if (!result.dispatched) throw new Error("Turn was not dispatched");
  const dispatchResult = result.dispatchResult;
  if (dispatchResult.deferredToActiveRun) log(`deferred chat=${chat.uid} message=${message.uid} mode=${dispatchResult.deferredToActiveRun}`);
  const outcome = dispatchResult.deferredToActiveRun ? "deferred" : hasVisibleChannelTurnDispatch(dispatchResult, { observedReplyDelivery })
    || dispatchResult.deliberateSilentTerminalReply ? "completed" : "incomplete";
  log(`${outcome} chat=${chat.uid} message=${message.uid}`);
  return outcome;
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
  agentPrompt: { messageToolHints: () => ["Reply normally in the current conversation; use message(action=send) only in the current conversation and omit target there. Use plow_reply_to with the account and chat uid for an follow-up to another conversation."] },
  messaging: {
    inferTargetChatType: ({ to }) => to === "plow-owner" ? "direct" : undefined,
    normalizeTarget: raw => raw.trim().replace(/^plow:/i, ""),
    targetResolver: { looksLikeId: (raw, normalized) => (normalized ?? raw.trim().replace(/^plow:/i, "")) === "plow-owner" || /^cht_[A-Za-z0-9_-]+$/.test(normalized ?? raw.trim().replace(/^plow:/i, "")), hint: "Use a Plow chat uid (cht_…)." },
  },
  gateway: {
    startAccount: async ctx => {
      const log = (text: string) => ctx.log?.info(text);
      await listen(ctx.account, ctx.abortSignal, log, (chat, message, firstContact, history, ingress) => receive(ctx.account, ctx.cfg, chat, message, firstContact, history, ingress, log));
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
      description: "From the owner's main Plow DM, start a group text with the owner and the supplied phone numbers. The configured group trust mode controls trusted; ask mode requires an explicit owner choice. Sends the first message and returns the chat uid; use plow_reply_to with account chat and that uid for follow-ups. Accepts phone numbers, not chat ids or email addresses.",
      parameters: {
        type: "object", required: ["members", "body"], additionalProperties: false,
        properties: {
          members: { type: "array", minItems: 1, items: { type: "string", pattern: "^\\+[1-9][0-9]{1,14}$" }, description: "Recipient phone numbers in E.164 format. The owner is included automatically." },
          body: { type: "string", minLength: 1, description: "The first message to send." },
          trusted: { type: "boolean", description: "The owner's full-trust choice, required in ask mode. Preset modes enforce their configured choice." },
        },
      },
      async execute(_id, args: { members: string[]; body: string; trusted?: boolean }) {
        if (!context.config) return {
          isError: true, content: [{ type: "text", text: "Plow configuration is unavailable." }], details: {},
        };
        const account = plugin.config.resolveAccount(context.config, "chat");
        const turn = await ownerDmTurn(account, context);
        const owner = turn.chat.participants.find(p => p.type === "member" && p.role === "owner");
        if (owner?.type !== "member" || !owner.provider_key) throw new Error("The owner's chat has no owner handle");
        const members = [...new Set([owner.provider_key, ...args.members])].sort();
        if (account.threadTrust !== "ask" && account.threadTrust !== "trusted" && account.threadTrust !== "untrusted") {
          throw new Error("Plow group trust mode is unavailable.");
        }
        if (account.threadTrust === "ask" && typeof args.trusted !== "boolean") {
          throw new Error("Starting a group requires an explicit trust choice.");
        }
        const trusted = account.threadTrust === "trusted" || (account.threadTrust === "ask" && args.trusted === true);
        const idempotencyKey = createHash("sha256").update(JSON.stringify([account.lineUid, _id, members, args.body, trusted])).digest("hex");
        const chat = await requestDelivery<{ uid: string }>(account, "/chats", {
          line_uid: account.lineUid, members,
          body: args.body, trusted, idempotency_key: idempotencyKey,
        });
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
          trusted: { type: "boolean", description: "True grants all members full tools; false restricts non-owner members to replies only." },
        },
      },
      async execute(_id, args: { chat_uid: string; trusted: boolean }) {
        if (!context.config) throw new Error("Plow configuration is unavailable.");
        const account = plugin.config.resolveAccount(context.config, "chat");
        await ownerDmTurn(account, context);
        const target = await request<Chat>(account, `/chats/${encodeURIComponent(args.chat_uid)}`);
        if (!accepts(account, target) || target.participants.length <= 2) throw new Error("Target must be a served Plow group.");
        const result = await requestDelivery<{ trusted: boolean }>(account, `/chats/${encodeURIComponent(args.chat_uid)}/trusted`, { trusted: args.trusted }, "PUT");
        const details = { chat_uid: args.chat_uid, trusted: result.trusted };
        return { content: [{ type: "text", text: JSON.stringify(details) }], details };
      },
    }));
    api.registerTool(context => ({
      name: "plow_reply_to", label: "Reply to a Plow conversation",
      description: "From the owner's main Plow DM, send a follow-up to a known chat or email conversation on this agent's line. Use the known source account and chat uid.",
      parameters: {
        type: "object", required: ["account", "chat_uid", "text"], additionalProperties: false,
        properties: {
          account: { type: "string", enum: ["chat", "email"], description: "Source account for the conversation." },
          chat_uid: { type: "string", pattern: "^cht_[A-Za-z0-9_-]+$", description: "Known source chat uid." },
          text: { type: "string", minLength: 1, description: "The follow-up text to send." },
        },
      },
      async execute(_id, args: { account: "chat" | "email"; chat_uid: string; text: string }) {
        const cfg = context.config;
        if (!cfg) throw new Error("Plow configuration is unavailable.");
        const ownerAccount = plugin.config.resolveAccount(cfg, "chat");
        await ownerDmTurn(ownerAccount, context);
        const destination = plugin.config.resolveAccount(cfg, args.account);
        const chat = await request<Chat>(destination, `/chats/${encodeURIComponent(args.chat_uid)}`);
        if (!accepts(destination, chat)) throw new Error("Plow account does not serve this conversation");
        const kind = destination.accountId === "email" || chat.participants.length === 2 ? "direct" : "group";
        const peer = chat.participants.find(p => p.type === "member" || p.relationship !== "self");
        const peerId = destination.accountId === "email" || kind === "group" ? chat.uid
          : findOwnerChat(destination, [chat]) === chat ? "plow-owner"
          : peer?.type === "member" ? chat.uid : peer?.line.uid;
        if (!peerId) throw new Error("Plow conversation has no peer");
        const route = runtime.channel.routing.resolveAgentRoute({ cfg, channel: "plow", accountId: args.account, peer: { kind, id: peerId } });
        let messageUid: string;
        try {
          messageUid = await durableSend(cfg, route, args.account, args.chat_uid,
            peerId === "plow-owner" ? peerId : args.chat_uid, args.text, kind);
        } catch (error) {
          if (error instanceof DeliveryUnknownError) invalidateContextualizedHistory(destination, args.chat_uid);
          throw error;
        }
        const details = { message_uid: messageUid };
        return { content: [{ type: "text", text: JSON.stringify(details) }], details };
      },
    }));
  },
});
