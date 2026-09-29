import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { defineChannelPluginEntry, type ChannelPlugin, type PluginRuntime, type OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { hasVisibleChannelTurnDispatch } from "openclaw/plugin-sdk/channel-message";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { request, listen, accepts, ownerChat, HttpError, DeliveryUnknownError, type Account, type Chat, type Message, type Page, type TurnOutcome } from "./transport.ts";
import { addNote, emailHeader, emailTurnPrompt, originOf, recordOrigin, takeNotes } from "./email.ts";

let runtime: PluginRuntime;
// The pinned runtime keeps direct replies audible: an email turn that ends with NO_REPLY
// comes back as one of these notices, which on email mean there is nothing for the owner.
const NO_ANSWER_NOTICES = ["⚠️ Agent couldn't generate a response.", "⚠️ OpenClaw couldn't produce or deliver a reply."];
// nonOwnerEmail marks a turn on mail from anyone but the owner: it sends nothing but its own thread's reply.
type DeliveryState = { unknown: boolean; nonOwnerEmail?: boolean };
const outboundDeliveryState = new AsyncLocalStorage<DeliveryState>();

async function requestWithDeliveryState<T>(account: Account, path: string, body: unknown, state?: DeliveryState): Promise<T> {
  if (state?.unknown) throw new DeliveryUnknownError();
  try { return await request<T>(account, path, body); }
  catch (error) {
    if (!(error instanceof HttpError) || [408, 424].includes(error.status) || error.status >= 500) {
      if (state) state.unknown = true;
      throw new DeliveryUnknownError();
    }
    throw error;
  }
}

async function send(account: Account, to: string, text: string, mediaUrls: string[] = [], state?: DeliveryState) {
  to = to.replace(/^plow:/i, "");
  if (to === "plow-owner") to = (await ownerChat(account)).uid;
  if (!accepts(account, await request<Chat>(account, `/chats/${to}`))) {
    throw new Error("Plow account does not serve this conversation");
  }
  if (state?.unknown) throw new DeliveryUnknownError();
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
  const sent = await requestWithDeliveryState<{ uid: string }>(account, `/chats/${to}/messages`, { body: text, attachment_uids: attachments }, state);
  return { channel: "plow" as const, messageId: sent.uid };
}

// The message tool's path only: a turn's own final text is delivered by receive, not here.
async function toolSend(cfg: OpenClawConfig, accountId: string | null | undefined, to: string, text: string, mediaUrls: string[]) {
  const state = outboundDeliveryState.getStore();
  if (state?.nonOwnerEmail) throw new Error("This email is not from the owner, so this turn sends nothing except a plow_send_email reply to its own thread. Your final text reaches the owner.");
  const account = plugin.config.resolveAccount(cfg, accountId);
  const target = to.replace(/^plow:/i, "");
  if (account.accountId === "email" || (target !== "plow-owner" && account.emailLineUid &&
    accepts({ ...account, accountId: "email" }, await request<Chat>(account, `/chats/${target}`)))) {
    throw new Error("Email is sent with plow_send_email, not message.");
  }
  return send(account, to, text, mediaUrls, state);
}

async function receive(account: Account, cfg: OpenClawConfig, chat: Chat, message: Message, firstContact: boolean, history: Message[], log: (text: string) => void): Promise<TurnOutcome> {
  const sender = message.sender;
  const senderId = sender.type === "member" ? sender.uid : sender.line.uid;
  const senderIsOwner = sender.type === "member" && chat.participants.some(p => p.type === "member" && p.uid === senderId && p.role === "owner");
  const senderName = sender.type === "member" ? sender.display_name : sender.line.display_name;
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
  const command = account.accountId === "chat" && body.startsWith("/") ? { kind: "text-slash" as const, authorized: senderIsOwner, body } : undefined;
  const email = account.accountId === "email";
  // On email the agent is its mailbox's persona; phone turns keep the configured name.
  const selfName = cfg.agents?.entries?.[route.agentId]?.identity?.name;
  const self = chat.participants.find(p => p.type === "agent" && p.relationship === "self");
  const persona = (email && self?.type === "agent" && self.line.display_name) || selfName;
  const participants = chat.participants.map(p => ({
    ...(p.type === "agent" && p.relationship === "self" ? { name: persona } : { name: (p.type === "member" ? p.display_name : p.line.display_name) || "unnamed member" }),
    type: p.type, role: p.type === "member" ? p.role : p.relationship,
  }));
  const phone = { ...account, accountId: "chat" };
  const origin = email ? await originOf(chat.uid) : undefined;
  const notes = await takeNotes(chat.uid);
  const ctxPayload = await runtime.channel.inbound.buildContext({
    channel: "plow", accountId: account.accountId, messageId: message.uid, timestamp: Date.parse(message.created_at),
    from: kind === "group" ? `plow:group:${chat.uid}` : `plow:${senderId}`, sender: { id: senderIsOwner ? "plow-owner" : senderId, name: senderName, isBot: sender.type === "agent" },
    conversation: { kind, id: chat.uid, label: chat.display_name, routePeer: peer },
    route: { ...route, routeSessionKey: route.sessionKey }, reply: { to: `plow:${chat.uid}`, originatingTo: `plow:${chat.uid}`, replyToId: message.reply_to?.uid },
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
        payload: { first_contact: firstContact, trusted: chat.trusted, participants, ...(email ? { final_text_goes_to_chat_uid: origin ?? "the owner's 1:1 chat" } : {}) } },
        ...(notes.length ? [{ label: "Email finals you delivered here since the last turn (your own record)", source: "plow", type: "conversation", payload: notes }] : [])],
      ...(email ? { groupSystemPrompt: emailTurnPrompt(chat, persona ?? "the assistant") } : {}),
    },
    media,
  });
  log(`turn ${JSON.stringify({ chat: chat.uid, message: message.uid, first_contact: firstContact, senderId, senderName, senderIsOwner, sessionKey: route.sessionKey })}`);
  const deliveryState: DeliveryState = { unknown: false, nonOwnerEmail: email && !senderIsOwner };
  let failure: unknown;
  let observedReplyDelivery = false;
  // An email turn completes by delivering its final to the owner, or by choosing silence.
  let deliveredToOwner = false;
  let silent = false;
  if (account.accountId === "chat") await request(account, `/chats/${chat.uid}/typing`, { action: "start" }).catch(() => log("typing start failed"));
  try {
    const result = await outboundDeliveryState.run(deliveryState, () => runtime.channel.inbound.dispatch({
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
          const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
          if (email) {
            if (NO_ANSWER_NOTICES.some(notice => payload.text?.startsWith(notice))) {
              log(`silent chat=${chat.uid} message=${message.uid}`);
              silent = true;
              return { messageIds: [] };
            }
            const target = origin ?? await ownerChat(phone).then(owner => owner.uid, error => { log(`no owner chat: ${(error as Error).message}`); return undefined; });
            if (!target) {
              log(`dropped final chat=${chat.uid} message=${message.uid}: nowhere to deliver`);
              deliveredToOwner = true;
              return { messageIds: [] };
            }
            const sent = await send(phone, target, `${emailHeader(chat, sender)}\n\n${payload.text ?? ""}`, mediaUrls, deliveryState);
            deliveredToOwner = true;
            await addNote(target, { thread_chat_uid: chat.uid, subject: chat.display_name ?? null, text: payload.text ?? "" });
            log(`delivered chat=${chat.uid} to=${target} message=${sent.messageId}`);
            return { messageIds: [sent.messageId] };
          }
          const sent = await send(account, chat.uid, payload.text ?? "", mediaUrls, deliveryState);
          log(`delivered chat=${chat.uid} message=${sent.messageId}`);
          return { messageIds: [sent.messageId] };
        },
        onError: error => { failure = error; },
      },
    }));
    if (deliveryState.unknown) throw new DeliveryUnknownError();
    if (failure && !silent) throw failure;
    if (!result.dispatched) throw new Error("Turn was not dispatched");
    const dispatchResult = result.dispatchResult;
    if (dispatchResult.deferredToActiveRun) log(`deferred chat=${chat.uid} message=${message.uid} mode=${dispatchResult.deferredToActiveRun}`);
    const outcome = deliveredToOwner || silent || hasVisibleChannelTurnDispatch(dispatchResult, { observedReplyDelivery })
      || dispatchResult.deferredToActiveRun || dispatchResult.deliberateSilentTerminalReply
      ? "completed" : "incomplete";
    log(`${outcome} chat=${chat.uid} message=${message.uid}`);
    return outcome;
  } catch (error) {
    if (deliveryState.unknown) throw new DeliveryUnknownError();
    throw error;
  } finally {
    if (account.accountId === "chat") await request(account, `/chats/${chat.uid}/typing`, { action: "stop" }).catch(() => log("typing stop failed"));
  }
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
  agentPrompt: { messageToolHints: () => ["Reply normally in the current conversation; omit target when using message(action=send) there. Use a Plow chat uid (cht_…) as target to message another conversation on your line."] },
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
    sendText: ctx => toolSend(ctx.cfg, ctx.accountId, ctx.to, ctx.text, []),
    sendMedia: ctx => toolSend(ctx.cfg, ctx.accountId, ctx.to, ctx.text, ctx.mediaUrl ? [ctx.mediaUrl] : []),
  },
};

export default defineChannelPluginEntry({
  id: "plow", name: "Plow", description: "Plow channel", plugin,
  setRuntime: value => { runtime = value; },
  registerFull(api) {
    if (api.registrationMode === "full") api.logger.info("plow channel registered");
  },
  registerCapabilities(api) {
    api.registerTool(context => {
      const deliveryState: DeliveryState = { unknown: false };
      return {
        name: "plow_start_thread", label: "Start a Plow group thread",
        description: "Start a group text on your own Plow line with the owner and the supplied phone numbers. Sends the first message and returns the chat uid; use message with action send, channel plow, accountId chat and that uid as target for follow-ups. Accepts phone numbers, not chat ids or email addresses.",
        parameters: {
          type: "object", required: ["members", "body"], additionalProperties: false,
          properties: {
            members: { type: "array", minItems: 1, items: { type: "string", pattern: "^\\+[1-9][0-9]{1,14}$" }, description: "Recipient phone numbers in E.164 format. The owner is included automatically." },
            body: { type: "string", minLength: 1, description: "The first message to send." },
          },
        },
        async execute(_id, args: { members: string[]; body: string }) {
          if (!context.config) return {
            isError: true, content: [{ type: "text", text: "Plow configuration is unavailable." }], details: {},
          };
          if (deliveryState.unknown) throw new DeliveryUnknownError();
          const account = plugin.config.resolveAccount(context.config, "chat");
          const currentChatUid = context.deliveryContext?.channel === "plow" ? context.deliveryContext.to?.replace(/^plow:/i, "") : undefined;
          if (!currentChatUid || !context.sessionId) throw new Error("Starting a thread requires an active Plow message");
          const currentChat = await request<Chat>(account, `/chats/${currentChatUid}`);
          if (!accepts(account, currentChat)) throw new Error("Plow account does not serve this conversation");
          const owner = currentChat.participants.find(p => p.type === "member" && p.role === "owner")
            ?? (await ownerChat(account)).participants.find(p => p.type === "member" && p.role === "owner");
          if (owner?.type !== "member" || !owner.provider_key) throw new Error("The owner's chat has no owner handle");
          const members = [...new Set([owner.provider_key, ...args.members])].sort();
          const idempotencyKey = createHash("sha256").update(JSON.stringify([account.lineUid, context.sessionId, _id, members, args.body])).digest("hex");
          const chat = await requestWithDeliveryState<{ uid: string }>(account, "/chats", {
            line_uid: account.lineUid, members,
            body: args.body, trusted: true, idempotency_key: idempotencyKey,
          }, deliveryState);
          api.logger.info(`plow started thread chat=${chat.uid}`);
          const result = { chat_uid: chat.uid, message_sent: true };
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        },
      };
    });
    api.registerTool(context => {
      const deliveryState: DeliveryState = { unknown: false };
      // Receipts match the Hermes image's plow_send_email: failures are {success: false, error, …}.
      const refuse = (error: string, extra: object = {}) => {
        const result = { success: false, error, ...extra };
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
      };
      const receipt = (result: object) => ({ content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result });
      return {
        name: "plow_send_email", label: "Send email from your Plow mailbox",
        description: "Send email from your own mailbox, or list your email threads. To reply in a thread, set to to its chat uid (cht_…); to start a new thread, set to to a list of email addresses and give a subject. body is the email itself, from you as the owner's assistant: refer to the owner in the third person and sign with your own name, never theirs. Returns the thread's chat_uid. Your final text in an email thread goes privately to the owner, never to the thread.",
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
        async execute(_id, args: { action?: "send" | "list"; to?: string | string[]; subject?: string; body?: string }) {
          try { return await sendEmail(args); }
          catch (error) {
            if (error instanceof DeliveryUnknownError) return refuse(`${error.message}. Do NOT retry; check the thread.`, { delivery_unknown: true });
            if (error instanceof HttpError) return refuse(`${error.message}; nothing was sent`, { status: error.status });
            throw error;
          }
        },
      };
      async function sendEmail(args: { action?: "send" | "list"; to?: string | string[]; subject?: string; body?: string }) {
        if (!context.config) return refuse("Plow configuration is unavailable.");
        if (deliveryState.unknown) throw new DeliveryUnknownError();
        const phone = plugin.config.resolveAccount(context.config, "chat");
        const mailbox = { ...phone, accountId: "email" };
        if (!phone.emailLineUid) return refuse("You have no mailbox.");
        const current = context.deliveryContext?.channel === "plow" ? context.deliveryContext.to?.replace(/^plow:/i, "") : undefined;
        if (!current) return refuse("Sending email requires an active Plow message.");
        const emailTurn = context.deliveryContext?.accountId === "email";
        if (emailTurn && !context.senderIsOwner) {
          if ((args.action ?? "send") !== "send" || args.to !== current) {
            return refuse(`This email is not from the owner, so plow_send_email can only reply in this thread (to "${current}"). Your final text reaches the owner.`);
          }
        } else if (!context.senderIsOwner && (emailTurn || !(await request<Chat>(phone, `/chats/${current}`)).trusted)) {
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
          if (!accepts(mailbox, await request<Chat>(mailbox, `/chats/${args.to}`))) return refuse(`${args.to} is not one of your email threads.`);
          await requestWithDeliveryState(mailbox, `/chats/${args.to}/messages`, { body: args.body }, deliveryState);
          api.logger.info(`plow sent email chat=${args.to}`);
          return receipt({ sent: true, chat_uid: args.to });
        }
        if (!args.to?.length || !args.subject) return refuse("A new thread needs to (email addresses) and a subject.");
        const sent = await requestWithDeliveryState<{ status: string; chat_uid?: string | null; chat_unrecorded_reason?: string | null }>(
          mailbox, `/email-lines/${phone.emailLineUid}/messages`, { to: args.to, subject: args.subject, body: args.body }, deliveryState);
        // A thread started from an email turn reports to the owner's 1:1, the default.
        if (sent.chat_uid && !emailTurn) await recordOrigin(sent.chat_uid, current);
        api.logger.info(`plow started email status=${sent.status} chat=${sent.chat_uid ?? "none"}`);
        if (sent.chat_uid) return receipt({ sent: true, chat_uid: sent.chat_uid });
        return receipt({ sent: sent.status === "sent" ? true : "unknown", chat_uid: null, chat_unrecorded_reason: sent.chat_unrecorded_reason ?? null,
          note: "Plow has no chat id for this thread. Do not resend and do not guess a chat id." });
      }
    });
  },
});
