import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { defineChannelPluginEntry, type ChannelPlugin, type PluginRuntime, type OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { buildOutboundSessionContext, sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import { hasVisibleChannelTurnDispatch } from "openclaw/plugin-sdk/channel-message";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { request, listen, accepts, findOwnerChat, ownerChat, invalidateContextualizedHistory, HttpError, DeliveryUnknownError, type Account, type Chat, type Message, type Page, type TurnOutcome } from "./transport.ts";
import { emailHeader, emailTurnPrompt, originOf, recordOrigin } from "./email.ts";

let runtime: PluginRuntime;
// The pinned runtime keeps direct replies audible: an email turn that ends with NO_REPLY
// comes back as one of these notices, which on email mean there is nothing for the owner.
const NO_ANSWER_NOTICES = ["⚠️ Agent couldn't generate a response.", "⚠️ OpenClaw couldn't produce or deliver a reply."];
type ActiveTurn = { chat: Chat; accountId: string; messageUid: string; senderIsOwner: boolean; senderName: string; senderRole: string; deliveryUnknown?: boolean };
type SendPermit = { accountId: string; to: string; text: string };
const shared = globalThis as typeof globalThis & { plowActiveTurn?: AsyncLocalStorage<ActiveTurn>; plowActiveTurns?: Map<string, ActiveTurn>; plowDurableSendPermits?: Set<SendPermit> };
const activeTurn = (shared.plowActiveTurn ??= new AsyncLocalStorage<ActiveTurn>());
const activeTurns = (shared.plowActiveTurns ??= new Map<string, ActiveTurn>());
// The SDK loads the outbound adapter separately, so durable dispatch grants one exact send across module instances.
const durableSendPermits = (shared.plowDurableSendPermits ??= new Set<SendPermit>());
function consumeDurablePermit(accountId: string | null | undefined, to: string, text: string) {
  for (const permit of durableSendPermits) if (permit.accountId === accountId && permit.to === to && permit.text === text) {
    durableSendPermits.delete(permit);
    return true;
  }
  return false;
}

function normalizedHandle(handle: string): string {
  const compact = handle.trim().replace(/[\s().-]/g, "");
  return /^\+\d{10,15}$/.test(compact) ? compact : handle.trim().toLowerCase();
}

function ownerDmTurn(account: Account, context: { sessionKey?: string; messageChannel?: string; agentAccountId?: string; nativeChannelId?: string }): ActiveTurn {
  const turn = context.sessionKey ? activeTurns.get(context.sessionKey) : undefined;
  if (context.sessionKey !== "agent:main:main" || context.messageChannel !== "plow"
    || context.agentAccountId !== "chat" || !turn || !turn.senderIsOwner
    || context.nativeChannelId !== turn.chat.uid || findOwnerChat(account, [turn.chat]) !== turn.chat) {
    throw new Error("This action requires an active message in the owner's main Plow DM.");
  }
  return turn;
}

async function requestWithDeliveryState<T>(account: Account, path: string, body: unknown, turn = activeTurn.getStore(), method: "POST" | "PUT" = "POST"): Promise<T> {
  if (turn?.deliveryUnknown) throw new DeliveryUnknownError();
  try { return await request<T>(account, path, body, undefined, method); }
  catch (error) {
    if (!(error instanceof HttpError) || [408, 424].includes(error.status) || error.status >= 500) {
      if (turn) turn.deliveryUnknown = true;
      throw new DeliveryUnknownError();
    }
    throw error;
  }
}

async function send(account: Account, to: string, text: string, mediaUrls: string[] = [], durable = false, turn = activeTurn.getStore()) {
  to = to.replace(/^plow:/i, "");
  // Email leaves only through plow_send_email; the delivery paths that reach a thread are durable.
  if (!durable && account.accountId === "email") throw new Error("Email is sent with plow_send_email, not message.");
  const outside = !durable && (!turn || account.accountId !== turn.accountId ||
    (to !== turn.chat.uid && !(to === "plow-owner" && turn.senderIsOwner && findOwnerChat(account, [turn.chat]) === turn.chat)));
  if (outside && (!turn || to === "plow-owner")) throw new Error("Native Plow sends must stay in the current conversation.");
  if (to === "plow-owner") to = (await ownerChat(account)).uid;
  const chat = await request<Chat>(account, `/chats/${to}`);
  if (!durable && chat.participants.some(p => p.type === "agent" && p.relationship === "self" && p.line.uid === account.emailLineUid)) {
    throw new Error("Email is sent with plow_send_email, not message.");
  }
  if (outside) throw new Error("Native Plow sends must stay in the current conversation.");
  if (!accepts(account, chat)) {
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
  const sent = await requestWithDeliveryState<{ uid: string }>(account, `/chats/${to}/messages`, { body: text, attachment_uids: attachments }, turn);
  return { channel: "plow" as const, messageId: sent.uid };
}

// The session a conversation's turns run in, so a send into it from elsewhere is mirrored there.
function sessionRoute(cfg: OpenClawConfig, account: Account, chat: Chat) {
  const kind = account.accountId === "email" || chat.participants.length === 2 ? "direct" : "group";
  const peer = chat.participants.find(p => p.type === "member" || p.relationship !== "self");
  const peerId = account.accountId === "email" || kind === "group" ? chat.uid
    : findOwnerChat(account, [chat]) === chat ? "plow-owner"
    : peer?.type === "member" ? chat.uid : peer?.line.uid;
  if (!peerId) throw new Error("Plow conversation has no peer");
  const route = runtime.channel.routing.resolveAgentRoute({ cfg, channel: "plow", accountId: account.accountId, peer: { kind, id: peerId } });
  return { kind, route, routeTo: peerId === "plow-owner" ? peerId : chat.uid } as const;
}

async function durableSend(cfg: OpenClawConfig, turn: ActiveTurn, route: { agentId: string; sessionKey: string }, accountId: string, to: string, routeTo: string, text: string, kind: "direct" | "group") {
  await runtime.channel.session.updateLastRoute({
    storePath: runtime.channel.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId }),
    sessionKey: route.sessionKey, channel: "plow", accountId, to: routeTo, createIfMissing: true,
  });
  const permit = { accountId, to, text };
  let result;
  try {
    result = await activeTurn.run(turn, () => sendDurableMessageBatch({
      cfg, channel: "plow", accountId, to, payloads: [{ text }],
      session: buildOutboundSessionContext({ cfg, ...route, conversationType: kind }),
      mirror: route, skipQueue: true, onPlatformSendDispatch: async () => { durableSendPermits.add(permit); },
    }));
  } finally { durableSendPermits.delete(permit); }
  if (result.status !== "sent") {
    turn.deliveryUnknown = true;
    throw new DeliveryUnknownError();
  }
  return result.results[0].messageId;
}

async function receive(account: Account, cfg: OpenClawConfig, chat: Chat, message: Message, firstContact: boolean, history: Message[], log: (text: string) => void): Promise<TurnOutcome> {
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
  const email = account.accountId === "email";
  // On email the agent is its mailbox's persona; phone turns keep the configured name.
  const selfName = cfg.agents?.entries?.[route.agentId]?.identity?.name;
  const persona = (email && account.emailName) || selfName;
  const participants = chat.participants.map(p => ({
    ...(p.type === "agent" && p.relationship === "self" ? { name: persona } : { name: (p.type === "member" ? p.display_name : p.line.display_name) || "unnamed member" }),
    type: p.type, role: p.type === "member" ? p.role : p.relationship,
  }));
  const phone = { ...account, accountId: "chat" };
  const origin = email ? await originOf(chat.uid) : undefined;
  const ctxPayload = await runtime.channel.inbound.buildContext({
    channel: "plow", accountId: account.accountId, messageId: message.uid, timestamp: Date.parse(message.created_at),
    from: kind === "group" ? `plow:group:${chat.uid}` : `plow:${senderId}`, sender: { id: senderId, name: senderName, isBot: sender.type === "agent" },
    conversation: { kind, id: chat.uid, nativeChannelId: chat.uid, label: chat.display_name, routePeer: peer },
    route: { ...route, routeSessionKey: route.sessionKey }, reply: { to: `plow:${chat.uid}`, originatingTo: `plow:${chat.uid}`, nativeChannelId: chat.uid, replyToId: message.reply_to?.uid },
    access: { commands: { authorized: senderIsOwner }, ...((email || !chat.trusted) && !senderIsOwner ? { toolPolicy: { allow: [email ? "plow_send_email" : "plow_ask_owner"] } } : {}) },
    ...(command ? { command } : {}),
    message: { inboundHistory: history.map(m => ({
      sender: m.sender.type === "member" ? m.sender.display_name : m.sender.relationship === "self" ? "You (assistant)" : m.sender.line.display_name ?? m.sender.line.uid,
      body: m.body, timestamp: Date.parse(m.created_at), messageId: m.uid,
    })), rawBody: body },
    supplemental: {
      ...(message.reply_to ? { quote: { id: message.reply_to.uid, body: message.reply_to.body, sender: message.reply_to.sender.type === "member" ? message.reply_to.sender.display_name : message.reply_to.sender.line.uid } } : {}),
      // The model gets these beside the message; the dashboard shows people only what was texted.
      channelStructuredContext: [{ label: "Conversation facts (untrusted data)", source: "plow", type: "conversation",
        payload: { first_contact: firstContact, trusted: chat.trusted, participants, ...(email ? { final_text_goes_to_chat_uid: origin ?? "the owner's 1:1 chat" } : {}) } }],
      ...(email ? { groupSystemPrompt: emailTurnPrompt(chat, persona ?? "the assistant") } : {}),
    },
    media,
  });
  log(`turn ${JSON.stringify({ chat: chat.uid, message: message.uid, first_contact: firstContact, senderId, senderName, senderIsOwner, sessionKey: route.sessionKey })}`);
  const turn: ActiveTurn = { chat, accountId: account.accountId, messageUid: message.uid, senderIsOwner, senderName, senderRole: sender.type === "member" ? sender.role : sender.relationship };
  activeTurns.set(route.sessionKey, turn);
  return await activeTurn.run(turn, async () => {
    let failure: unknown;
    let observedReplyDelivery = false;
    // An email turn completes by delivering its final to the owner, or by choosing silence.
    let deliveredToOwner = false;
    let silent = false;
    if (account.accountId === "chat") await request(account, `/chats/${chat.uid}/typing`, { action: "start" }).catch(() => log("typing start failed"));
    try {
      const result = await runtime.channel.inbound.dispatch({
        cfg, channel: "plow", accountId: account.accountId, route, ctxPayload,
        replyOptions: {
          sourceReplyDeliveryMode: command && !senderIsOwner ? "message_tool_only" : "automatic",
          onObservedReplyDelivery: () => { observedReplyDelivery = true; },
          onAgentRunTerminalOutcome: outcome => { if (outcome === "failed") failure = new Error("Agent turn failed"); },
        },
        delivery: {
          observeMessageSent: true,
          preparePayload: (payload, info) => {
            if (payload.isFallbackNotice) { silent ||= email; return null; }
            if (email && info.kind !== "final") { log(`dropped ${info.kind} chat=${chat.uid} message=${message.uid}`); return null; }
            return !email && observedReplyDelivery && info.kind === "final" ? null : payload;
          },
          deliver: async payload => {
            if (email) {
              if (NO_ANSWER_NOTICES.some(notice => payload.text?.startsWith(notice))) {
                log(`silent chat=${chat.uid} message=${message.uid}`);
                silent = true;
                return { messageIds: [] };
              }
              // A recorded origin still gets the final only while it is the owner's DM or a trusted group.
              // An origin this agent can no longer read is a lost origin: the 1:1 gets the final.
              const recorded = origin ? await request<Chat>(phone, `/chats/${origin}`).catch(error => {
                if (error instanceof HttpError && [403, 404].includes(error.status)) return undefined;
                throw error;
              }) : undefined;
              const target = recorded && accepts(phone, recorded) && (recorded.trusted || findOwnerChat(phone, [recorded]) === recorded) ? recorded
                : await ownerChat(phone).catch(error => { log(`no owner chat: ${(error as Error).message}`); return undefined; });
              deliveredToOwner = true;
              if (!target) {
                log(`dropped final chat=${chat.uid} message=${message.uid}: nowhere to deliver`);
                return { messageIds: [] };
              }
              // Durable, so the final is also recorded in the session of the chat it lands in. Trimmed,
              // because the durable send trims its text and its permit matches the exact text.
              const { kind, route, routeTo } = sessionRoute(cfg, phone, target);
              const sent = await durableSend(cfg, activeTurn.getStore()!, route, "chat", target.uid, routeTo, `${emailHeader(chat, sender)}\n\n${payload.text ?? ""}`.trim(), kind);
              log(`delivered chat=${chat.uid} to=${target.uid} message=${sent}`);
              return { messageIds: [sent] };
            }
            const sent = await send(account, chat.uid, payload.text ?? "", payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []));
            log(`delivered chat=${chat.uid} message=${sent.messageId}`);
            return { messageIds: [sent.messageId] };
          },
          onError: error => { failure = error; },
        },
      });
      if (activeTurn.getStore()!.deliveryUnknown) throw new DeliveryUnknownError();
      if (failure && !silent) throw failure;
      if (!result.dispatched) throw new Error("Turn was not dispatched");
      const dispatchResult = result.dispatchResult;
      if (dispatchResult.deferredToActiveRun) log(`deferred chat=${chat.uid} message=${message.uid} mode=${dispatchResult.deferredToActiveRun}`);
      const outcome = deliveredToOwner || silent || hasVisibleChannelTurnDispatch(dispatchResult, { observedReplyDelivery })
        || dispatchResult.deferredToActiveRun || dispatchResult.deliberateSilentTerminalReply ? "completed" : "incomplete";
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
  agentPrompt: { messageToolHints: () => ["Reply normally in the current conversation; use message(action=send) only in the current conversation and omit target there. Use plow_reply_to with the chat uid for an owner-approved reply to another conversation; email goes only through plow_send_email."] },
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
    sendText: ctx => send(plugin.config.resolveAccount(ctx.cfg, ctx.accountId), ctx.to, ctx.text, [],
      typeof ctx.onPlatformSendDispatch === "function" && consumeDurablePermit(ctx.accountId, ctx.to, ctx.text)),
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
      description: "From the owner's main Plow DM, start a group text with the owner and the supplied phone numbers. The configured group trust mode controls trusted; ask mode requires an explicit owner choice. Sends the first message and returns the chat uid; use plow_reply_to with that uid for follow-ups. Accepts phone numbers, not chat ids or email addresses.",
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
        const turn = ownerDmTurn(account, context);
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
        const turn = ownerDmTurn(account, context);
        const target = await request<Chat>(account, `/chats/${encodeURIComponent(args.chat_uid)}`);
        if (!accepts(account, target) || target.participants.length <= 2) throw new Error("Target must be a served Plow group.");
        const result = await requestWithDeliveryState<{ trusted: boolean }>(account, `/chats/${encodeURIComponent(args.chat_uid)}/trusted`, { trusted: args.trusted }, turn, "PUT");
        const details = { chat_uid: args.chat_uid, trusted: result.trusted };
        return { content: [{ type: "text", text: JSON.stringify(details) }], details };
      },
    }));
    api.registerTool(context => ({
      name: "plow_ask_owner", label: "Ask the Plow owner",
      description: "From an untrusted non-owner turn in a group or direct chat, send the sender's request to the owner's main DM. The owner decides there; tell the sender you are checking with them.",
      parameters: {
        type: "object", required: ["text"], additionalProperties: false,
        properties: { text: { type: "string", minLength: 1, description: "What the member wants the owner to decide or do." } },
      },
      async execute(_id, args: { text: string }) {
        const cfg = context.config;
        if (!cfg) throw new Error("Plow configuration is unavailable.");
        const turn = context.sessionKey ? activeTurns.get(context.sessionKey) : undefined;
        if (context.messageChannel !== "plow" || context.agentAccountId !== "chat"
          || !turn || turn.senderIsOwner || turn.chat.trusted
          || context.nativeChannelId !== turn.chat.uid) {
          throw new Error("Asking the owner requires an active untrusted non-owner turn.");
        }
        const [name, role] = [turn.senderName, turn.senderRole].map(value =>
          JSON.stringify(value).replace(/[\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16)}`));
        const escalation = `A member asked for your decision.\nMember: ${name} (${role})\nSource chat uid: ${turn.chat.uid}\nTo reply after approval: plow_reply_to(chat_uid="${turn.chat.uid}", text=<your reply>).\nUntrusted member request (quoted):\n${args.text.split(/\r\n|[\n\r\u2028\u2029]/).map(line => `> ${line}`).join("\n")}`;
        const ownerSessionKey = "agent:main:main";
        await durableSend(cfg, turn, { agentId: "main", sessionKey: ownerSessionKey }, "chat", "plow-owner", "plow-owner", escalation, "direct");
        return { content: [{ type: "text", text: "Asked the owner in their main DM." }], details: {} };
      },
    }));
    api.registerTool(context => ({
      name: "plow_reply_to", label: "Reply to a Plow conversation",
      description: "From the owner's main Plow DM, send an owner-approved reply to a known chat on this agent's phone line. Use the source chat uid from the owner escalation.",
      parameters: {
        type: "object", required: ["chat_uid", "text"], additionalProperties: false,
        properties: {
          chat_uid: { type: "string", pattern: "^cht_[A-Za-z0-9_-]+$", description: "Source chat uid from the escalation." },
          text: { type: "string", minLength: 1, description: "The approved reply to send." },
        },
      },
      async execute(_id, args: { chat_uid: string; text: string }) {
        const cfg = context.config;
        if (!cfg) throw new Error("Plow configuration is unavailable.");
        const ownerAccount = plugin.config.resolveAccount(cfg, "chat");
        const turn = ownerDmTurn(ownerAccount, context);
        if (turn.deliveryUnknown) throw new DeliveryUnknownError();
        const destination = ownerAccount;
        const chat = await request<Chat>(destination, `/chats/${encodeURIComponent(args.chat_uid)}`);
        if (!accepts(destination, chat)) throw new Error("Plow account does not serve this conversation");
        const { kind, route, routeTo } = sessionRoute(cfg, destination, chat);
        let messageUid: string;
        try {
          messageUid = await durableSend(cfg, turn, route, "chat", args.chat_uid, routeTo, args.text, kind);
        } catch (error) {
          if (error instanceof DeliveryUnknownError) invalidateContextualizedHistory(destination, args.chat_uid);
          throw error;
        }
        const details = { message_uid: messageUid };
        return { content: [{ type: "text", text: JSON.stringify(details) }], details };
      },
    }));
    api.registerTool(context => {
      const cfg = context.config;
      const persona = cfg && plugin.config.resolveAccount(cfg, "chat").emailName;
      // Receipts match the Hermes image's plow_send_email: failures are {success: false, error, …}.
      const refuse = (error: string, extra: object = {}) => {
        const result = { success: false, error, ...extra };
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
      };
      const receipt = (result: object) => ({ content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result });
      type Args = { action?: "send" | "list"; to?: string | string[]; subject?: string; body?: string };
      async function sendEmail(args: Args) {
        if (!cfg) return refuse("Plow configuration is unavailable.");
        const phone = plugin.config.resolveAccount(cfg, "chat");
        const mailbox = { ...phone, accountId: "email" };
        if (!phone.emailLineUid) return refuse("You have no mailbox.");
        const turn = context.sessionKey ? activeTurns.get(context.sessionKey) : undefined;
        if (context.messageChannel !== "plow" || !turn || context.nativeChannelId !== turn.chat.uid) return refuse("Sending email requires an active Plow message.");
        if (turn.deliveryUnknown) throw new DeliveryUnknownError();
        const emailTurn = turn.accountId === "email";
        if (emailTurn && !turn.senderIsOwner) {
          if ((args.action ?? "send") !== "send" || args.to !== turn.chat.uid) {
            return refuse(`This email is not from the owner, so plow_send_email can only reply in this thread (to "${turn.chat.uid}"). Your final text reaches the owner.`);
          }
        } else if (!turn.senderIsOwner && !turn.chat.trusted) {
          return refuse("plow_send_email needs the owner's authority: the owner's own chat, a trusted group, or the owner's own email.");
        }
        if (args.action === "list") {
          const listing = await request<Page<Chat>>(mailbox, "/chats");
          const threads = [];
          for (const chat of listing.data.filter(chat => accepts(mailbox, chat))) {
            const newest = (await request<Page<Message>>(mailbox, `/chats/${chat.uid}/messages?limit=1`)).data[0];
            threads.push({
              chat_uid: chat.uid, subject: chat.display_name ?? null, last_activity: newest?.created_at ?? null,
              participants: chat.participants.flatMap(p => p.type === "member" ? [{ name: p.display_name, email: p.provider_key ?? null, role: p.role }] : []),
            });
          }
          return receipt({ threads, has_more: listing.has_more });
        }
        if (!args.body) return refuse("body is required.");
        if (typeof args.to === "string") {
          const chat = await request<Chat>(mailbox, `/chats/${encodeURIComponent(args.to)}`);
          if (!accepts(mailbox, chat)) return refuse(`${args.to} is not one of your email threads.`);
          if (args.to === turn.chat.uid) await requestWithDeliveryState(mailbox, `/chats/${args.to}/messages`, { body: args.body }, turn);
          else {
            // From another conversation, a durable send also records the reply in the thread's session.
            const { kind, route, routeTo } = sessionRoute(cfg, mailbox, chat);
            await durableSend(cfg, turn, route, "email", args.to, routeTo, args.body, kind);
          }
          api.logger.info(`plow sent email chat=${args.to}`);
          return receipt({ sent: true, chat_uid: args.to });
        }
        if (!args.to?.length || !args.subject) return refuse("A new thread needs to (email addresses) and a subject.");
        const sent = await requestWithDeliveryState<{ status: string; chat_uid?: string | null; chat_unrecorded_reason?: string | null }>(
          mailbox, "/chats", { line_uid: phone.emailLineUid, members: args.to, subject: args.subject, body: args.body }, turn);
        // A thread started from an email turn reports to the owner's 1:1, the default.
        // The mail is out: a lost origin only sends later finals to the owner's 1:1, so it never fails the send.
        if (sent.chat_uid && !emailTurn) await recordOrigin(sent.chat_uid, turn.chat.uid).catch(error => api.logger.info(`plow origin not recorded chat=${sent.chat_uid}: ${(error as Error).name}`));
        api.logger.info(`plow started email status=${sent.status} chat=${sent.chat_uid ?? "none"}`);
        if (sent.chat_uid) return receipt({ sent: true, chat_uid: sent.chat_uid });
        return receipt({ sent: sent.status === "sent" ? true : "unknown", chat_uid: null, chat_unrecorded_reason: sent.chat_unrecorded_reason ?? null,
          note: "Plow has no chat id for this thread. Do not resend and do not guess a chat id." });
      }
      return {
        name: "plow_send_email", label: "Send email from your Plow mailbox",
        description: `Send email from your own mailbox, or list your email threads. To reply in a thread, set to to its chat uid (cht_…); to start a new thread, set to to a list of email addresses and give a subject. body is the email itself, from you as the owner's assistant: refer to the owner in the third person and sign it as ${persona || "yourself"}, never as the owner. Returns the thread's chat_uid. Your final text in an email thread goes privately to the owner, never to the thread.`,
        parameters: {
          type: "object", additionalProperties: false,
          properties: {
            action: { type: "string", enum: ["send", "list"], description: "send (the default) or list." },
            // The chat-uid pattern makes OpenClaw read a JSON-encoded address list as the array it is.
            to: { anyOf: [{ type: "string", pattern: "^cht_[A-Za-z0-9_-]+$" }, { type: "array", minItems: 1, items: { type: "string" } }],
              description: "An email thread's chat uid to reply in it, or a list of email addresses to start a new thread." },
            subject: { type: "string", minLength: 1, description: "Required when starting a new thread; not used on a reply." },
            body: { type: "string", minLength: 1, description: "The email body." },
          },
        },
        async execute(_id: string, args: Args) {
          try { return await sendEmail(args); }
          catch (error) {
            if (error instanceof DeliveryUnknownError) return refuse(`${error.message}. Do NOT retry; check the thread.`, { delivery_unknown: true });
            if (error instanceof HttpError) return refuse(`${error.message}; nothing was sent`, { status: error.status });
            throw error;
          }
        },
      };
    });
  },
});
