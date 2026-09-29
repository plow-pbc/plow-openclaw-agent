/*
 * Checkpoints advance at adoption, not turn completion. A short history overlap
 * and durable recent UIDs cover the inbound and outbound providers' different
 * clocks. Unadopted shutdown work remains recoverable; adopted work belongs to
 * OpenClaw even if its dispatch promise is still running.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { on, once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { createChannelInboundDebouncer, shouldDebounceTextInbound } from "openclaw/plugin-sdk/channel-inbound";
import { combineMessages } from "./coalesce.ts";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";

export type Member = { type: "member"; uid: string; display_name: string; role: string; provider_key: string };
export type Agent = { type: "agent"; relationship: string; line: { uid: string; display_name?: string } };
export type Chat = { uid: string; status: string; trusted: boolean; display_name?: string; participants: (Member | Agent)[] };
export type Message = {
  uid: string; direction: string; body: string; sender: Member | Agent; created_at: string;
  attachments: { url: string; content_type: string; filename: string }[];
  reply_to?: Message;
};
export type TurnOutcome = "completed" | "incomplete";
type ReplyOptions = NonNullable<Parameters<PluginRuntime["channel"]["inbound"]["dispatch"]>[0]["replyOptions"]>;
type AdoptionLifecycle = NonNullable<ReplyOptions["turnAdoptionLifecycle"]>;
export type TurnAdoption = AdoptionLifecycle & Required<Pick<AdoptionLifecycle, "abortSignal" | "onAdopted" | "onDeferred" | "onAbandoned">>;
const historyOverlap = 20;
const recentLimit = 512;
export type Page<T> = { data: T[]; has_more: boolean };
export type Account = { accountId: string; apiBase: string; lineUid: string; emailLineUid?: string; threadTrust?: "ask" | "trusted" | "untrusted" };

export class HttpError extends Error {
  status: number;
  constructor(status: number) { super(`Plow HTTP ${status}`); this.status = status; }
}

export class DeliveryUnknownError extends Error {
  constructor() { super("Plow delivery is unknown; stopped to avoid resending"); }
}

export async function request<T>(account: Pick<Account, "apiBase">, path: string, body?: unknown, signal?: AbortSignal, method: "POST" | "PUT" = "POST"): Promise<T> {
  const token = process.env.PLOW_AGENT_TOKEN;
  if (!token) throw new Error("PLOW_AGENT_TOKEN is required");
  const response = await fetch(`${account.apiBase}/v1${path}`, {
    method: body === undefined ? "GET" : method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new HttpError(response.status);
  return await response.json() as T;
}

export function accepts(account: Account, chat: Chat): boolean {
  const line = account.accountId === "email" ? account.emailLineUid : account.lineUid;
  return chat.status === "active" && chat.participants.some(p => p.type === "agent" && p.relationship === "self" && p.line.uid === line);
}

const validChatId = (uid: unknown): uid is string => typeof uid === "string" && uid !== "" && uid !== "." && uid !== "..";

class AmbiguousOwnerChatError extends Error {}

const discoveredChats = new Map<string, Map<string, Chat>>();
type HistoryState = { contextualized: Set<string>; versions: Map<string, number> };
const historyStates = new Map<string, HistoryState>();
const historyKey = (account: Account) => `${account.apiBase}/${account.accountId}/${account.accountId === "email" ? account.emailLineUid : account.lineUid}`;

export function invalidateContextualizedHistory(account: Account, chatUid: string) {
  const state = historyStates.get(historyKey(account));
  state?.contextualized.delete(chatUid);
  if (state) state.versions.set(chatUid, (state.versions.get(chatUid) ?? 0) + 1);
}

export function findOwnerChat(account: Account, chats: Chat[]): Chat | undefined {
  const owners = chats.filter(chat => chat.status === "active" && chat.participants.length === 2 &&
    chat.participants.some(p => p.type === "agent" && p.relationship === "self" && p.line.uid === account.lineUid) &&
    chat.participants.some(p => p.type === "member" && p.role === "owner"));
  if (owners.length > 1) throw new AmbiguousOwnerChatError(`Expected one owner's chat; found ${owners.length}`);
  return owners[0];
}

export async function ownerChat(account: Account): Promise<Chat> {
  const cached = findOwnerChat(account, [...(discoveredChats.get(`${account.apiBase}/${account.lineUid}`)?.values() ?? [])]);
  if (cached) return cached;
  const listing = await request<Page<Chat>>(account, "/chats");
  if (listing.has_more) throw new Error("Cannot resolve owner from a truncated chat listing");
  const chat = findOwnerChat(account, listing.data);
  if (!chat) throw new Error("No owner's chat discovered");
  return chat;
}

// Pages run newest-first; starting_after means older than the page cursor.
// A first:<uid> checkpoint includes that message, but none of its older history.
export async function recover(account: Account, chat: string, checkpoint: string, overlap = 0): Promise<Message[]> {
  const missed: Message[] = [];
  let cursor = "";
  let reachedCheckpoint = false;
  let older = overlap;
  for (;;) {
    const page = await request<Page<Message>>(account, `/chats/${chat}/messages?limit=50${cursor ? `&starting_after=${cursor}` : ""}`);
    for (const message of page.data) {
      if (reachedCheckpoint && older-- === 0) return missed.reverse();
      if (message.uid === checkpoint || `first:${message.uid}` === checkpoint) {
        reachedCheckpoint = true;
        if (overlap === 0 && message.uid === checkpoint) return missed.reverse();
      }
      missed.push(message);
      if (reachedCheckpoint && overlap === 0) return missed.reverse();
    }
    if (!page.has_more || !page.data.length) return missed.reverse();
    cursor = page.data.at(-1)!.uid;
  }
}

async function earliestUnansweredOwnerMessage(account: Account, chat: string, newest: Message): Promise<string> {
  let earliest = newest.uid;
  let cursor = newest.uid;
  for (;;) {
    const page = await request<Page<Message>>(account, `/chats/${chat}/messages?limit=50&starting_after=${cursor}`);
    for (const message of page.data) {
      if (message.direction !== "inbound" || message.sender.type !== "member") return earliest;
      earliest = message.uid;
    }
    if (!page.has_more || !page.data.length) return earliest;
    cursor = page.data.at(-1)!.uid;
  }
}

export async function listen(account: Account, signal: AbortSignal, log: (text: string) => void, turn: (chat: Chat, message: Message, firstContact: boolean, history: Message[], adoption: TurnAdoption, messages: Message[]) => Promise<TurnOutcome>, cfg: OpenClawConfig = {}) {
  const root = process.env.OPENCLAW_STATE_DIR;
  if (!root) throw new Error("OPENCLAW_STATE_DIR is required");
  const dir = `${root}/plow-checkpoints`;
  await mkdir(dir, { recursive: true });
  const checkpoints = new Map<string, string>();
  const recent = new Map<string, Set<string>>();
  const initializedRecent = new Set<string>();
  const dispatches = new Set<Promise<void>>();
  type Queued = { chat: Chat; message: Message; cursor: string; key?: string };
  const pending = new Map<string, Queued>();
  const acknowledgements = new Map<string, Promise<void>>();
  let debouncer: ReturnType<typeof createChannelInboundDebouncer<Queued>>["debouncer"];
  const discovered = new Map<string, Chat>();
  if (account.accountId === "chat") discoveredChats.set(`${account.apiBase}/${account.lineUid}`, discovered);
  const seen = new Set<string>();
  const state: HistoryState = { contextualized: new Set(), versions: new Map() };
  const contextualized = state.contextualized;
  const accountHistoryKey = historyKey(account);
  historyStates.set(accountHistoryKey, state);
  let attempt = 0;
  const remember = (id: string) => {
    seen.add(id);
    if (seen.size > 512) seen.delete(seen.values().next().value!);
  };
  const ack = (chat: string, uid: string | string[], cursor = typeof uid === "string" ? uid : uid.at(-1)!) => {
    const commit = (acknowledgements.get(chat) ?? Promise.resolve()).then(async () => {
      const uids = typeof uid === "string" ? [uid] : uid;
      const handled = new Set(recent.get(chat));
      for (const id of uids) handled.add(id);
      // A command may finish before buffered text; retain the recoverable frontier.
      if ([...pending.values()].some(item => item.chat.uid === chat && !uids.includes(item.message.uid))) cursor = checkpoints.get(chat) ?? cursor;
      while (handled.size > recentLimit) handled.delete(handled.values().next().value!);
      await writeFile(`${dir}/${encodeURIComponent(chat)}.tmp`, JSON.stringify({ uid: cursor, recent: [...handled] }));
      await rename(`${dir}/${encodeURIComponent(chat)}.tmp`, `${dir}/${encodeURIComponent(chat)}`);
      checkpoints.set(chat, cursor);
      recent.set(chat, handled);
      for (const id of uids) pending.delete(id);
    }).finally(() => { if (acknowledgements.get(chat) === commit) acknowledgements.delete(chat); });
    acknowledgements.set(chat, commit);
    return commit;
  };
  const readCheckpoint = async (chat: string) => {
    const saved = await readFile(`${dir}/${encodeURIComponent(chat)}`, "utf8");
    if (!saved.startsWith("{")) return saved;
    const checkpoint = JSON.parse(saved) as { uid: string; recent: string[] };
    recent.set(chat, new Set(checkpoint.recent));
    initializedRecent.add(chat);
    return checkpoint.uid;
  };
  const initializeRecent = async (chat: string, checkpoint: string) => {
    const window = await recover(account, chat, checkpoint, historyOverlap);
    const boundary = window.findIndex(message => message.uid === checkpoint.replace(/^first:/, ""));
    recent.set(chat, new Set(window.slice(0, boundary + (checkpoint.startsWith("first:") ? 0 : 1)).map(message => message.uid)));
    await ack(chat, checkpoint);
    initializedRecent.add(chat);
  };
  const dispatchTurn = async (items: Queued[], lane: Pick<TurnAdoption, "onAdopted" | "onDeferred">) => {
    const { chat, cursor } = items.at(-1)!;
    const chatUid = chat.uid;
    const messages = items.map(item => item.message);
    const message = combineMessages(messages);
    const owner = findOwnerChat(account, [...discovered.values()]);
    const complete = async () => {
      if (account.accountId === "chat") await ack(chatUid, messages.map(message => message.uid), cursor);
      for (const message of messages) {
        pending.delete(message.uid);
        remember(message.uid);
        log(`acked chat=${chatUid} message=${message.uid}`);
      }
    };
    let release!: () => void;
    let reject!: (error: unknown) => void;
    const released = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
    let adopted = false;
    let deferred = false;
    let abandoned = false;
    const checkpoint = checkpoints.get(chat.uid);
    const firstContact = account.accountId === "chat" && chat.uid === owner?.uid && (checkpoint === "" || checkpoint === `first:${messages[0].uid}`);
    let history: Message[] = [];
    const historyVersion = state.versions.get(chat.uid) ?? 0;
    let historyLoaded = contextualized.has(chat.uid) && !(account.accountId === "chat" && chat.uid === owner?.uid);
    if (!historyLoaded) {
      try { history = (await request<Page<Message>>(account, `/chats/${chat.uid}/messages?limit=20&starting_after=${messages[0].uid}`)).data.reverse(); historyLoaded = true; }
      catch (error) { log(`history failed chat=${chat.uid}: ${(error as Error).name}; dispatching without history`); }
    }
    const markContextualized = () => {
      if (historyLoaded && (state.versions.get(chat.uid) ?? 0) === historyVersion) contextualized.add(chat.uid);
    };
    const adoption: TurnAdoption = {
      admission: "exclusive", abortSignal: signal,
      onAdopted: async () => {
        if (adopted) return;
        try {
          signal.throwIfAborted();
          await complete();
          adopted = true;
          markContextualized();
          await lane.onAdopted();
          release();
        } catch (error) { abandoned = true; reject(error); throw error; }
      },
      onDeferred: () => { deferred = true; return lane.onDeferred?.() !== false && !signal.aborted; },
      onAbandoned: () => {
        abandoned = true;
        if (!adopted) reject(new Error(`Unadopted turn abandoned chat=${chatUid} message=${message.uid}`));
      },
    };
    signal.addEventListener("abort", release, { once: true });
    const dispatch = (async () => {
      let outcome: TurnOutcome = "incomplete";
      try { outcome = await turn(chat, message, firstContact, history, adoption, messages); }
      catch (error) {
        if (error instanceof DeliveryUnknownError) {
          log(`turn failed chat=${chat.uid} message=${message.uid}: delivery unknown; reply suppressed, acknowledging without resending`);
          outcome = "completed";
        } else log(`turn failed chat=${chat.uid} message=${message.uid}: ${(error as Error).name}`);
      }
      if (adopted || deferred || abandoned) return;
      if (outcome !== "completed") {
        if (signal.aborted) {
          log(`turn aborted chat=${chat.uid} message=${message.uid}; left unacked`);
          release();
          return;
        }
        log(`turn incomplete chat=${chat.uid} message=${message.uid}; acknowledging`);
      }
      await complete();
      markContextualized();
      release();
    })().catch(error => { reject(error); }).finally(() => {
      dispatches.delete(dispatch);
    });
    dispatches.add(dispatch);
    try { await released; }
    finally { signal.removeEventListener("abort", release); }
  };
  const consume = async (chatUid: string, message: Message, cursor = message.uid) => {
    if (signal.aborted || seen.has(message.uid) || recent.get(chatUid)?.has(message.uid) || pending.has(message.uid)) return;
    const chat = await request<Chat>(account, `/chats/${chatUid}`);
    if (!accepts(account, chat)) return;
    discovered.set(chat.uid, chat);
    findOwnerChat(account, [...discovered.values()]);
    const sender = message.sender;
    if (message.direction !== "inbound" || !(sender.type === "member" || (account.accountId === "chat" && sender.relationship === "peer"))) {
      if (account.accountId === "chat") await ack(chatUid, message.uid, cursor);
      remember(message.uid);
      log(`acked chat=${chatUid} message=${message.uid}`);
      return;
    }
    const senderId = sender.type === "member" ? sender.uid : sender.line.uid;
    const key = `plow:${account.accountId}:${chat.uid}:${senderId}`;
    const item = { chat, message, cursor, key };
    pending.set(message.uid, item);
    await debouncer.enqueue(item);
  };
  while (!signal.aborted) {
    let socket: WebSocket | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const queues = new Map<string, Promise<void>>();
    const slots: (() => void)[] = [];
    let active = 0;
    let accepting = true;
    let queueFailed = false;
    let queueError: unknown;
    const fail = (error: unknown, items: Queued[]) => {
      for (const item of items) pending.delete(item.message.uid);
      queueFailed = true;
      queueError = error;
      socket?.terminate();
    };
    debouncer = createChannelInboundDebouncer<Queued>({
      cfg, channel: "plow", buildKey: item => item.key,
      shouldDebounce: item => shouldDebounceTextInbound({
        cfg, text: item.message.body, hasMedia: item.message.attachments.length > 0, allowDebounce: account.accountId === "chat",
      }),
      onFlush: (items, createFlush) => createFlush({
        lifecycle: { abortSignal: signal, onFailed: error => fail(error, items) },
        dispatch: lane => dispatchTurn(items, lane),
      }),
      onCancel: items => { for (const item of items) pending.delete(item.message.uid); },
      onError: fail,
    }).debouncer;
    const enqueue = (chat: string, work: () => Promise<void>) => {
      const previous = queues.get(chat) ?? Promise.resolve();
      const next = previous.then(async () => {
        if (!accepting || signal.aborted || queueFailed) return;
        if (active === 4) await new Promise<void>(resolve => slots.push(resolve));
        else active++;
        try {
          if (accepting && !signal.aborted && !queueFailed) await work();
        } catch (error) {
          queueFailed = true;
          queueError = error;
          socket?.terminate();
        } finally {
          const waiting = slots.shift();
          if (waiting) waiting();
          else active--;
        }
      }).finally(() => {
        if (queues.get(chat) === next) queues.delete(chat);
      });
      queues.set(chat, next);
    };
    const abort = () => {
      // Cancelling a pending upgrade emits an error after the abort listeners are removed.
      if (socket?.readyState === WebSocket.CONNECTING) socket.once("error", () => {});
      socket?.terminate();
    };
    try {
      const { ticket } = await request<{ ticket: string }>(account, "/ws/ticket", {});
      socket = new WebSocket(`${account.apiBase.replace(/^http/, "ws")}/v1/ws?ticket=${encodeURIComponent(ticket)}`, { handshakeTimeout: 15_000 });
      let unauthorized = false;
      socket.on("unexpected-response", (_request, response) => socket!.emit("error", new HttpError(response.statusCode!)));
      socket.on("close", code => { unauthorized = code === 4401; });
      const frames = on(socket, "message", { signal, close: ["close"] });
      const bufferedChats = new Map<string, Set<string>>();
      const trackBufferedChat = (raw: WebSocket.RawData) => {
        const event = JSON.parse(raw.toString());
        if (event.event_type !== "message_received" || !validChatId(event.chat_id)) return;
        let messages = bufferedChats.get(event.chat_id);
        if (!messages) bufferedChats.set(event.chat_id, messages = new Set());
        messages.add(event.data.message.uid);
      };
      socket.on("message", trackBufferedChat);
      signal.addEventListener("abort", abort, { once: true });
      await once(socket, "open", { signal });
      attempt = 0;
      log(`connected account=${account.accountId}`);
      let alive = true;
      socket.on("pong", () => { alive = true; });
      heartbeat = setInterval(() => {
        if (!alive) socket!.terminate();
        else { alive = false; socket!.ping(); }
      }, 30_000);
      const listing = await request<Page<Chat>>(account, "/chats");
      if (listing.has_more) log("warning: Plow chat listing is truncated; continuing with returned chats");
      const chats = listing.data.filter(chat => validChatId(chat.uid) && accepts(account, chat));
      discovered.clear();
      for (const chat of chats) discovered.set(chat.uid, chat);
      const owner = findOwnerChat(account, chats);
      if (account.accountId === "chat") {
        for (const chat of chats) {
          if (checkpoints.has(chat.uid)) continue;
          let checkpoint: string;
          try { checkpoint = await readCheckpoint(chat.uid); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            const page = await request<Page<Message>>(account, `/chats/${chat.uid}/messages?limit=1`);
            const newest = page.data[0];
            checkpoint = chat.uid === owner?.uid && newest?.direction === "inbound" && newest.sender.type === "member"
              ? `first:${await earliestUnansweredOwnerMessage(account, chat.uid, newest)}` : newest?.uid ?? "";
            const buffered = bufferedChats.get(chat.uid);
            const first = buffered?.values().next().value;
            // A buffered frame moves first contact back only when history proves it is older.
            if (first && (!checkpoint.startsWith("first:") || (first !== checkpoint.slice(6) &&
              (await recover(account, chat.uid, `first:${first}`)).some(message => message.uid === checkpoint.slice(6))))) checkpoint = `first:${first}`;
            await ack(chat.uid, checkpoint);
            // Late frames can include an exclusive baseline, but must not replace pending first contact.
            if (!checkpoint.startsWith("first:") && bufferedChats.has(chat.uid)) {
              checkpoint = `first:${bufferedChats.get(chat.uid)!.values().next().value}`;
              await ack(chat.uid, checkpoint);
            }
          }
          checkpoints.set(chat.uid, checkpoint);
          if (!initializedRecent.has(chat.uid)) await initializeRecent(chat.uid, checkpoint);
        }
      }
      socket.off("message", trackBufferedChat);
      const replay = async (chatUid: string) => {
        const checkpoint = checkpoints.get(chatUid)!;
        const window = await recover(account, chatUid, checkpoint, historyOverlap);
        const boundary = window.findIndex(message => message.uid === checkpoint);
        for (const [index, message] of window.entries()) {
          if (!accepting || signal.aborted || queueFailed) break;
          // An overlapped arrival must not move the frontier behind its previous checkpoint.
          await consume(chatUid, message, index <= boundary ? checkpoint : message.uid);
        }
      };
      if (account.accountId === "chat") {
        for (const chat of chats) enqueue(chat.uid, () => replay(chat.uid));
      }
      for await (const [raw] of frames) {
        const event = JSON.parse(raw.toString());
        if (event.event_type !== "message_received" || !validChatId(event.chat_id)) continue;
        // Persist discovery before queueing: a dropped connection discards unstarted work.
        if (account.accountId === "chat" && !checkpoints.has(event.chat_id)) {
          let checkpoint: string;
          try { checkpoint = await readCheckpoint(event.chat_id); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            checkpoint = `first:${event.data.message.uid}`;
            await ack(event.chat_id, checkpoint);
          }
          checkpoints.set(event.chat_id, checkpoint);
          if (!initializedRecent.has(event.chat_id)) await initializeRecent(event.chat_id, checkpoint);
        }
        enqueue(event.chat_id, async () => {
          if (account.accountId === "chat") await replay(event.chat_id);
          else await consume(event.chat_id, event.data.message);
        });
      }
      accepting = account.accountId === "email";
      await Promise.all(queues.values());
      if (queueFailed) throw queueError;
      if (unauthorized) throw new HttpError(401);
    } catch (error) {
      accepting = account.accountId === "email";
      if (signal.aborted) break;
      if (error instanceof AmbiguousOwnerChatError || (error instanceof HttpError && error.status === 401)) {
        log(error.message + "; stopped until restart");
        clearInterval(heartbeat);
        abort();
        await once(signal, "abort");
        break;
      }
      log(`transport stopped: ${error instanceof HttpError ? error.message : (error as Error).name}`);
    } finally {
      clearInterval(heartbeat);
      signal.removeEventListener("abort", abort);
      abort();
      await Promise.all(queues.values());
      for (const key of new Set([...pending.values()].map(item => item.key))) if (key) debouncer.cancelKey(key);
      await debouncer.drain();
      await Promise.all(dispatches);
    }
    if (!signal.aborted) await delay(Math.min(30_000 * 2 ** attempt++, 300_000), undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
  }
  if (historyStates.get(accountHistoryKey) === state) historyStates.delete(accountHistoryKey);
}
