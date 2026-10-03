import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { defineChannelPluginEntry, type ChannelPlugin, type PluginRuntime, type OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { createChannelMessageReplyPipeline, buildOutboundSessionContext, sendDurableMessageBatch, resolveOutboundSendDep } from "openclaw/plugin-sdk/channel-outbound";
import { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
// @ts-expect-error The pinned SDK ships this runtime entry without type declarations.
import { appendAssistantMirrorMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { createChannelInboundDebouncer, shouldDebounceTextInbound } from "openclaw/plugin-sdk/channel-inbound";
import { hasVisibleChannelTurnDispatch } from "openclaw/plugin-sdk/channel-message";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { request, requestDelivery, postMessage, isSilent, listen, accepts, findOwnerChat, ownerChat, invalidateContextualizedHistory, HttpError, DeliveryUnknownError, type Account, type Chat, type Message, type Page, type TurnOutcome, type TurnIngress } from "./transport.ts";
import { emailFooter, emailLabel, emailTurnPrompt, originOf, recordOrigin } from "./email.ts";

let runtime: PluginRuntime;
// The pinned runtime keeps direct replies audible: an email turn that ends with NO_REPLY can come
// back as its no-reply fallback, which on email means there is nothing for the owner.
const NO_REPLY_FALLBACK = "⚠️ OpenClaw couldn't produce or deliver a reply.";

function normalizedHandle(handle: string): string {
  const compact = handle.trim().replace(/[\s().-]/g, "");
  return /^\+\d{10,15}$/.test(compact) ? compact : handle.trim().toLowerCase();
}

type Requester = Pick<OpenClawPluginToolContext, "sessionKey" | "messageChannel" | "agentAccountId" | "nativeChannelId" | "deliveryContext" | "requesterSenderId" | "senderIsOwner">;
function conversationUid(context: Requester): string | undefined {
  // Collected follow-ups retain their delivery route without a native conversation id.
  return (context.nativeChannelId ?? context.deliveryContext?.to)?.replace(/^plow:/i, "");
}
async function ownerDmTurn(account: Account, context: Requester): Promise<{ chat: Chat }> {
  const chatUid = conversationUid(context);
  if (context.sessionKey !== "agent:main:main" || context.messageChannel !== "plow" || !context.senderIsOwner
    || context.agentAccountId !== "chat" || !chatUid || !context.requesterSenderId) throw new Error("This action requires the owner's main Plow DM.");
  const chat = await request<Chat>(account, `/chats/${encodeURIComponent(chatUid)}`);
  if (findOwnerChat(account, [chat]) !== chat) throw new Error("This action requires the owner's main Plow DM.");
  return { chat };
}

async function send(account: Account, to: string, text: string, mediaUrls: string[] = []) {
  to = to.replace(/^plow:/i, "");
  if (account.accountId === "email") throw new Error("Email is sent with plow_send_email, not message.");
  // Heartbeats are routed to their own alias (boot/config.ts) so their sends can be marked.
  const heartbeat = to === "plow-heartbeat";
  if (to === "plow-owner" || heartbeat) to = (await ownerChat(account)).uid;
  const chat = await request<Chat>(account, `/chats/${to}`);
  if (chat.participants.some(p => p.type === "agent" && p.relationship === "self" && p.line.uid === account.emailLineUid)) {
    throw new Error("Email is sent with plow_send_email, not message.");
  }
  if (!accepts(account, chat)) {
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
  return await postMessage(account, to, text, attachments, heartbeat ? "heartbeat" : undefined);
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

// With sessionText, an existing session the send lands in records that text instead of what people saw.
async function durableSend(cfg: OpenClawConfig, route: { agentId: string; sessionKey: string }, accountId: string, to: string, routeTo: string, text: string, kind: "direct" | "group", sessionText?: string) {
  await runtime.channel.session.updateLastRoute({
    storePath: runtime.channel.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId }),
    sessionKey: route.sessionKey, channel: "plow", accountId, to: routeTo, createIfMissing: true,
  });
  const sessionId = sessionText ? getSessionEntry({ agentId: route.agentId, sessionKey: route.sessionKey })?.sessionId : undefined;
  const result = await sendDurableMessageBatch({
    cfg, channel: "plow", accountId, to, payloads: [{ text }],
    session: buildOutboundSessionContext({ cfg, ...route, conversationType: kind }),
    mirror: sessionId ? undefined : route, skipQueue: true,
    ...(accountId === "email" ? { deps: { plow: async (account: Account, to: string, text: string) => await postMessage(account, to, text) } } : {}),
  });
  if (result.status !== "sent") throw new DeliveryUnknownError();
  if (sessionId) await appendAssistantMirrorMessageByIdentity({ ...route, sessionId, text: sessionText, config: cfg });
  return result.results[0].messageId;
}

async function receive(account: Account, cfg: OpenClawConfig, chat: Chat, message: Message, firstContact: boolean, history: Message[], ingress: TurnIngress, log: (text: string) => void): Promise<TurnOutcome> {
  chat = await request<Chat>(account, `/chats/${encodeURIComponent(chat.uid)}`);
  if (!accepts(account, chat)) return "incomplete";
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
    access: { commands: { authorized: senderIsOwner }, ...(email ? { toolPolicy: { deny: ["automations"], ...(!senderIsOwner ? { allow: ["plow_send_email"] } : {}) } } : {}) },
    ...(command ? { command } : {}),
    message: { inboundHistory: history.map(m => ({
      sender: m.sender.type === "member" ? m.sender.display_name : m.sender.relationship === "self" ? "You (assistant)" : m.sender.line.display_name ?? m.sender.line.uid,
      body: m.body, timestamp: Date.parse(m.created_at), messageId: m.uid,
    })), rawBody: body },
    supplemental: {
      ...(message.reply_to ? { quote: { id: message.reply_to.uid, body: message.reply_to.body, sender: message.reply_to.sender.type === "member" ? message.reply_to.sender.display_name : message.reply_to.sender.line.uid } } : {}),
      // The model gets these beside the message; the dashboard shows people only what was texted.
      channelStructuredContext: [{ label: "Conversation facts (untrusted data)", source: "plow", type: "conversation",
        payload: { first_contact: firstContact, trusted: chat.trusted, participants, ...(email ? { final_text_goes_to: origin ? `chat ${origin} while it is the owner's DM or a trusted group, else the owner's 1:1 chat` : "the owner's 1:1 chat" } : {}) } }],
      ...(email ? { groupSystemPrompt: emailTurnPrompt(chat, persona ?? "the assistant") } : {}),
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
  // An email turn completes by delivering its final to the owner, or by choosing silence.
  let deliveredToOwner = false;
  let silent = false;
  const dispatched = runtime.channel.inbound.dispatch({
    cfg, channel: "plow", accountId: account.accountId, route, ctxPayload,
    dispatcherOptions: replyPipeline,
    replyOptions: {
      turnAdoptionLifecycle: ingress,
      onModelSelected,
      onAgentRunStart: runId => log(`run started chat=${chat.uid} message=${message.uid} run=${runId}`),
      // Untrusted non-owners get no tools; on email a non-owner keeps only plow_send_email, for its own thread.
      ...(!email && !chat.trusted && !senderIsOwner ? { disableTools: true } : {}),
      sourceReplyDeliveryMode: command && !senderIsOwner && chat.trusted ? "message_tool_only" : "automatic",
      onObservedReplyDelivery: () => { observedReplyDelivery = true; },
      onAgentRunTerminalOutcome: outcome => { if (outcome === "failed") failure = new Error("Agent turn failed"); },
    },
    delivery: {
      durable: email ? false : { to: chat.uid, replyToId: null },
      observeMessageSent: true,
      preparePayload: (payload, info) => {
        if (payload.isFallbackNotice) { silent ||= email; return null; }
        if (email && info.kind !== "final") { log(`dropped ${info.kind} chat=${chat.uid} message=${message.uid}`); return null; }
        if (!email && observedReplyDelivery && info.kind === "final") return null;
        // Plow sends unquoted replies; implicit quote targets would bypass durable delivery.
        return email ? payload : { ...payload, replyToId: undefined, replyToCurrent: false };
      },
      deliver: async payload => {
        if (email) {
          // A NO_REPLY line the model left beside its text, decorated or not, is the silence marker, not words
          // for the owner. Same predicate as delivery, so a marker kept here can't later drop the whole digest.
          const text = (payload.text ?? "").split("\n").filter(line => !isSilent(line)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
          // Only the no-reply fallback is silence; an error notice is a real failure and reaches the owner.
          if (!text || (!payload.isError && text.startsWith(NO_REPLY_FALLBACK))) {
            log(`silent chat=${chat.uid} message=${message.uid}`);
            silent = true;
            return { messageIds: [] };
          }
          // A recorded origin still gets the final only while it is the owner's DM or a trusted group.
          // An origin this agent can no longer read is a lost origin: the 1:1 gets the final.
          const resolveTarget = async () => {
            const recorded = origin ? await request<Chat>(phone, `/chats/${origin}`).catch(error => {
              if (error instanceof HttpError && [403, 404].includes(error.status)) return undefined;
              throw error;
            }) : undefined;
            return recorded && accepts(phone, recorded) && (recorded.trusted || findOwnerChat(phone, [recorded]) === recorded) ? recorded
              // Read fresh: a cached roster can be stale, and a failed read is not proof there is no 1:1.
              : findOwnerChat(phone, (await request<Page<Chat>>(phone, "/chats")).data);
          };
          // Nothing has been sent yet, so a failed lookup is safe to retry; the email listener has no replay.
          let target: Chat | undefined;
          for (let attempt = 1; ; attempt++) {
            try { target = await resolveTarget(); break; }
            catch (error) { if (attempt === 3) throw error; await delay(500); }
          }
          deliveredToOwner = true;
          if (!target) {
            log(`dropped final chat=${chat.uid} message=${message.uid}: nowhere to deliver`);
            return { messageIds: [] };
          }
          // Durable, so the final is also recorded in the session of the chat it lands in.
          const { kind, route, routeTo } = sessionRoute(cfg, phone, target);
          const label = emailLabel(chat, sender);
          // People see no chat ids; that chat's session copy keeps the thread's, to reply there.
          const sent = await durableSend(cfg, route, "chat", target.uid, routeTo, `${label}:\n${text}`, kind,
            `${label} (thread ${chat.uid}):\n${text}`);
          log(`delivered chat=${chat.uid} to=${target.uid} message=${sent}`);
          return { messageIds: [sent] };
        }
        const sent = await send(account, chat.uid, payload.text ?? "", payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []));
        if ("outcome" in sent && sent.outcome === "not_sent") {
          log(`silent chat=${chat.uid} message=${message.uid}`);
          silent = true;
          return { messageIds: [] };
        }
        log(`delivered chat=${chat.uid} message=${sent.messageId}`);
        return { messageIds: [sent.messageId] };
      },
      onError: error => { failure = error; },
    },
  });
  ingress.onSubmitted();
  const result = await dispatched;
  if (failure && !silent) throw failure;
  if (!result.dispatched) throw new Error("Turn was not dispatched");
  const dispatchResult = result.dispatchResult;
  if (dispatchResult.deferredToActiveRun) log(`deferred chat=${chat.uid} message=${message.uid} mode=${dispatchResult.deferredToActiveRun}`);
  const outcome = dispatchResult.deferredToActiveRun ? "deferred" : deliveredToOwner || silent || hasVisibleChannelTurnDispatch(dispatchResult, { observedReplyDelivery })
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
  agentPrompt: { messageToolHints: () => ["Reply normally in the current conversation; use message(action=send) only in the current conversation and omit target there. Use plow_reply_to with the chat uid for a follow-up to another conversation; email goes only through plow_send_email."] },
  messaging: {
    inferTargetChatType: ({ to }) => to === "plow-owner" || to === "plow-heartbeat" ? "direct" : undefined,
    normalizeTarget: raw => raw.trim().replace(/^plow:/i, ""),
    targetResolver: { looksLikeId: (raw, normalized) => ["plow-owner", "plow-heartbeat"].includes(normalized ?? raw.trim().replace(/^plow:/i, "")) || /^cht_[A-Za-z0-9_-]+$/.test(normalized ?? raw.trim().replace(/^plow:/i, "")), hint: "Use a Plow chat uid (cht_…)." },
  },
  gateway: {
    startAccount: async ctx => {
      const log = (text: string) => ctx.log?.info(text);
      type Inbound = { chat: Chat; message: Message; firstContact: boolean; history: Message[]; ingress: TurnIngress; resolve: (outcome: TurnOutcome) => void; reject: (error: unknown) => void };
      const pending = new Set<Inbound>();
      const lastSpeaker = new Map<string, string>();
      const key = (item: Inbound) => `${item.chat.uid}/${item.message.sender.type === "member" ? item.message.sender.uid : item.message.sender.line.uid}`;
      const { debouncer } = createChannelInboundDebouncer<Inbound>({
        cfg: ctx.cfg, channel: "plow",
        buildKey: key,
        shouldDebounce: item => ctx.account.accountId === "chat" && shouldDebounceTextInbound({
          cfg: ctx.cfg, text: item.message.body, hasMedia: item.message.attachments.length > 0,
        }),
        onFlush: items => {
          const first = items[0], last = items.at(-1)!;
          let submitted!: () => void;
          const admission = new Promise<void>(resolve => { submitted = resolve; });
          const completion = (async () => {
            const outcome = ctx.abortSignal.aborted ? "incomplete" : await receive(ctx.account, ctx.cfg, first.chat,
              { ...last.message, body: items.map(item => item.message.body).join("\n") }, first.firstContact, first.history,
              { abortSignal: ctx.abortSignal, onSubmitted: () => { for (const item of items) item.ingress.onSubmitted(); submitted(); },
                onAdopted: async () => { for (const item of items) await item.ingress.onAdopted(); } }, log);
            for (const item of items) item.resolve(outcome);
          })().finally(submitted);
          return { admission, completion };
        },
        onError: (error, items) => { for (const item of items) item.reject(error); },
        onCancel: items => { for (const item of items) item.resolve("incomplete"); },
      });
      const cancel = () => { for (const item of pending) debouncer.cancelKey(key(item)); };
      ctx.abortSignal.addEventListener("abort", cancel, { once: true });
      try {
        await listen(ctx.account, ctx.abortSignal, log, async (chat, message, firstContact, history, ingress) => {
          let resolve!: Inbound["resolve"], reject!: Inbound["reject"];
          const outcome = new Promise<TurnOutcome>((done, failed) => { resolve = done; reject = failed; });
          const item = { chat, message, firstContact, history, ingress, resolve, reject };
          const previous = lastSpeaker.get(chat.uid);
          if (previous && previous !== key(item)) await debouncer.flushKey(previous);
          if (ctx.abortSignal.aborted) return "incomplete";
          lastSpeaker.set(chat.uid, key(item));
          pending.add(item);
          // Release transport intake while waiting for the rest of a text burst.
          if (debouncer.shouldBuffer(item)) ingress.onSubmitted();
          void debouncer.enqueue(item).catch(reject);
          return outcome.finally(() => pending.delete(item));
        });
      } finally {
        ctx.abortSignal.removeEventListener("abort", cancel);
        await debouncer.drain();
      }
    },
  },
  outbound: {
    deliveryMode: "direct",
    deliveryCapabilities: { durableFinal: { text: true, media: true, messageSendingHooks: true } },
    sendText: ctx => (resolveOutboundSendDep<typeof send>(ctx.deps, "plow") ?? send)(plugin.config.resolveAccount(ctx.cfg, ctx.accountId), ctx.to, ctx.text),
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
        // A thread's first message is a delivery like any other: the silence marker opens nothing.
        if (isSilent(args.body)) throw new Error("Nothing was sent: the message is the NO_REPLY silence marker.");
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
      description: "From the owner's main Plow DM, send a follow-up to a known chat on this agent's phone line. Use the known chat uid.",
      parameters: {
        type: "object", required: ["chat_uid", "text"], additionalProperties: false,
        properties: {
          chat_uid: { type: "string", pattern: "^cht_[A-Za-z0-9_-]+$", description: "Known source chat uid." },
          text: { type: "string", minLength: 1, description: "The follow-up text to send." },
        },
      },
      async execute(_id, args: { chat_uid: string; text: string }) {
        const cfg = context.config;
        if (!cfg) throw new Error("Plow configuration is unavailable.");
        if (isSilent(args.text)) throw new Error("Nothing was sent: the text is the NO_REPLY silence marker.");
        const ownerAccount = plugin.config.resolveAccount(cfg, "chat");
        await ownerDmTurn(ownerAccount, context);
        const destination = ownerAccount;
        const chat = await request<Chat>(destination, `/chats/${encodeURIComponent(args.chat_uid)}`);
        if (!accepts(destination, chat)) throw new Error("Plow account does not serve this conversation");
        const { kind, route, routeTo } = sessionRoute(cfg, destination, chat);
        let messageUid: string;
        try {
          messageUid = await durableSend(cfg, route, "chat", args.chat_uid, routeTo, args.text, kind);
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
        const chatUid = conversationUid(context);
        if (context.messageChannel !== "plow" || !context.sessionKey || !chatUid || !context.requesterSenderId
          || (context.agentAccountId !== "chat" && context.agentAccountId !== "email")) return refuse("Sending email requires an active Plow message.");
        const account = plugin.config.resolveAccount(cfg, context.agentAccountId);
        const chat = await request<Chat>(account, `/chats/${encodeURIComponent(chatUid)}`);
        if (!accepts(account, chat)) return refuse("Sending email requires an active Plow message.");
        const turn = { chat, accountId: context.agentAccountId, senderIsOwner: context.senderIsOwner === true };
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
        // Checked before the footer is added: after it, the marker no longer ends the text.
        if (isSilent(args.body)) return refuse("Nothing was sent: the body is the NO_REPLY silence marker.");
        // Every mail carries a footer saying who wrote it, with the body trimmed for durable delivery.
        const owner = turn.chat.participants.find(p => p.type === "member" && p.role === "owner");
        const body = `${args.body.trim()}\n\n${emailFooter(persona, owner?.type === "member" ? owner.display_name : undefined)}`;
        if (typeof args.to === "string") {
          const chat = await request<Chat>(mailbox, `/chats/${encodeURIComponent(args.to)}`);
          if (!accepts(mailbox, chat)) return refuse(`${args.to} is not one of your email threads.`);
          if (args.to === turn.chat.uid) await postMessage(mailbox, args.to, body);
          else {
            // From another conversation, a durable send also records the reply in the thread's session.
            const { kind, route, routeTo } = sessionRoute(cfg, mailbox, chat);
            await durableSend(cfg, route, "email", args.to, routeTo, body, kind);
          }
          api.logger.info(`plow sent email chat=${args.to}`);
          return receipt({ sent: true, chat_uid: args.to });
        }
        if (!args.to?.length || !args.subject) return refuse("A new thread needs to (email addresses) and a subject.");
        const sent = await requestDelivery<{ status: string; chat_uid?: string | null; chat_unrecorded_reason?: string | null }>(
          mailbox, "/chats", { line_uid: phone.emailLineUid, members: args.to, subject: args.subject, body });
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
        description: `Send email from your own mailbox, or list your email threads. To reply in a thread, set to to its chat uid (cht_…); to start a new thread, set to to a list of email addresses and give a subject. body is the email itself, from you as the owner's assistant: refer to the owner in the third person, even for 'from me' or an approved draft. The tool adds a footer naming you as the owner's AI assistant on Plow; sign however you like. Mail in the owner's own name must use their Gmail, arranged in chat with their approval. Returns the thread's chat_uid. Your final text in an email thread goes privately to the owner, never to the thread.`,
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
