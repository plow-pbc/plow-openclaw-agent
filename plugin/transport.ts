/*
 * Checkpoints are per chat; after baseline initialization, progress advances only
 * once OpenClaw adopts a turn. Sources interrupted before adoption
 * stay unacked; adopted sources and uncertain sends are not replayed.
 * first:<uid> requests inclusive replay from uid. Recovery and buffered frames
 * dispatch in history order within each chat. Catch-up reads pages to the
 * checkpoint; durable UID deduplication covers repeated frames.
 * Commands without an agent run acknowledge at terminal completion.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { on, once } from "node:events";
import WebSocket from "ws";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { createChannelInboundDebouncer, shouldDebounceTextInbound } from "openclaw/plugin-sdk/channel-inbound";

export type Member = { type: "member"; uid: string; display_name: string; role: string; provider_key: string };
export type RosterMember = Omit<Member, "provider_key"> & { provider_key?: string | null };
export type Agent = { type: "agent"; relationship: string; line: { uid: string; display_name?: string } };
export type Chat = { uid: string; status: string; trusted: boolean; display_name?: string; participants: (RosterMember | Agent)[] };
export type Message = {
  uid: string; direction: string; body: string; sender: Member | Agent; created_at: string;
  attachments: { url: string; content_type: string; filename: string }[];
  // Plow wraps the replied-to message with the part being answered.
  reply_to?: { part_index: number | null; message: Message };
};
export type TurnIngress = { abortSignal: AbortSignal; onSubmitted: () => void; onAdopted: () => Promise<void> };
export type TurnOutcome = "completed" | "incomplete" | "deferred";
export type Page<T> = { data: T[]; has_more: boolean };
export type Account = { accountId: string; apiBase: string; lineUid: string; emailLineUid?: string; emailName?: string; threadTrust?: "ask" | "trusted" | "untrusted"; guestTools?: string[] };

// Image plugins can take durable ownership in before_dispatch without producing
// a normal reply. Separate SDK registries still run in the same gateway process.
const handoffKey = Symbol.for("plow.pluginHandoffs");
const shared = globalThis as typeof globalThis & { [handoffKey]?: Map<string, { confirmed: boolean }> };
const handoffs = shared[handoffKey] ??= new Map<string, { confirmed: boolean }>();
const inboundKey = (line: string, chat: string, message: string) => JSON.stringify([line, chat, message]);
export function acknowledgePluginHandoff(line: string, chat: string, message: string): boolean {
  const active = handoffs.get(inboundKey(line, chat, message));
  if (!active) return false;
  active.confirmed = true;
  return true;
}
export function pluginHandoff(line: string, chat: string, message: string) {
  const key = inboundKey(line, chat, message), state = { confirmed: false };
  handoffs.set(key, state);
  return { get confirmed() { return state.confirmed; }, close() { if (handoffs.get(key) === state) handoffs.delete(key); } };
}

export class HttpError extends Error {
  status: number;
  constructor(status: number) { super(`Plow HTTP ${status}`); this.status = status; }
}

export class DeliveryUnknownError extends Error {
  constructor() { super("Plow delivery is unknown; not replaying this send"); }
}

export async function request<T>(account: Pick<Account, "apiBase">, path: string, body?: unknown, signal?: AbortSignal, method: "POST" | "PUT" = "POST", headers: Record<string, string> = {}): Promise<T> {
  const token = process.env.PLOW_AGENT_TOKEN;
  if (!token) throw new Error("PLOW_AGENT_TOKEN is required");
  const response = await fetch(`${account.apiBase}/v1${path}`, {
    method: body === undefined ? "GET" : method,
    headers: { ...headers, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ?? AbortSignal.timeout(40_000),
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
async function* messagePages(account: Account, chat: string) {
  let cursor = "";
  const seen = new Set<string>();
  while (true) {
    const page = await request<Page<Message>>(account, `/chats/${chat}/messages?limit=50${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`);
    yield page;
    if (!page.has_more) return;
    const next = page.data.at(-1)?.uid;
    if (!next || seen.has(next)) throw new Error("Plow history pagination did not advance");
    seen.add(next);
    cursor = next;
  }
}

export async function recover(account: Account, chat: string, checkpoint: string): Promise<Message[]> {
  const messages: Message[] = [];
  for await (const page of messagePages(account, chat)) {
    const boundary = page.data.findIndex(message => message.uid === checkpoint.replace(/^first:/, ""));
    messages.push(...page.data.slice(0, boundary < 0 ? undefined : boundary + (checkpoint.startsWith("first:") ? 1 : 0)));
    if (boundary >= 0) break;
  }
  return messages.reverse();
}

async function earliestUnanswered(account: Account, chat: string, newest: Message, unanswered: (message: Message) => boolean, _log: (text: string) => void): Promise<string> {
  let earliest = newest.uid;
  for await (const page of messagePages(account, chat)) for (const message of page.data) {
    if (!unanswered(message)) return earliest;
    earliest = message.uid;
  }
  return earliest;
}

// A wait that ends early on abort. It uses the global timer so node:test mock
// timers can drive it; timers/promises' signal option is not mockable.
function backoff(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function listen(account: Account, signal: AbortSignal, log: (text: string) => void, turn: (chat: Chat, message: Message, firstContact: boolean, history: Message[], ingress: TurnIngress) => Promise<TurnOutcome>, cfg: OpenClawConfig = {}) {
  const root = process.env.OPENCLAW_STATE_DIR;
  if (!root) throw new Error("OPENCLAW_STATE_DIR is required");
  const dir = `${root}/plow-checkpoints`;
  await mkdir(dir, { recursive: true });
  // When this agent first listened. A chat with no checkpoint whose unanswered
  // messages are newer than this was missed while disconnected (e.g. a thread the
  // agent started during an outage); older ones predate the install. Only the
  // phone listener baselines chats, so only it owns this file.
  const sincePath = `${root}/plow-listening-since`;
  let since = Number.NaN;
  if (account.accountId === "chat") {
    try { since = Date.parse(await readFile(sincePath, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      since = Date.now();
      await writeFile(`${sincePath}.tmp`, new Date(since).toISOString());
      await rename(`${sincePath}.tmp`, sincePath);
    }
    if (!Number.isFinite(since)) throw new Error(`${sincePath} is not a timestamp`);
  }
  const checkpoints = new Map<string, string>();
  const recent = new Map<string, Set<string>>();
  const unadopted = new Map<string, Set<string>>();
  const recoveryEnds = new Map<string, string>();
  type Queued = { chatUid: string; message: Message; resolve: () => void; reject: (error: unknown) => void };
  const pending = new Map<string, Queued>();
  const dispatching = new Set<Promise<void>>();
  // Each pending message's turn, so a reconnect's replay can wait for its outcome.
  const inFlight = new Map<string, Promise<void>>();
  let failDispatch: (error: unknown) => void;
  const checkpointWrites = new Map<string, Promise<void>>();
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
  const ack = (chat: string, uid: string, adopted = true) => {
    const write = (checkpointWrites.get(chat) ?? Promise.resolve()).then(async () => {
      const handled = new Set(recent.get(chat));
      if (adopted) {
        handled.add(uid);
        unadopted.get(chat)?.delete(uid);
      }
      if (!unadopted.get(chat)?.size) while (handled.size > 512) handled.delete(handled.values().next().value!);
      recent.set(chat, handled);
      // Later handled rows must not move recovery past an unfinished source.
      const cursor = unadopted.get(chat)?.size ? checkpoints.get(chat)! : recoveryEnds.get(chat) ?? uid;
      await writeFile(`${dir}/${encodeURIComponent(chat)}.tmp`, JSON.stringify({ uid: cursor, recent: [...handled] }));
      await rename(`${dir}/${encodeURIComponent(chat)}.tmp`, `${dir}/${encodeURIComponent(chat)}`);
      checkpoints.set(chat, cursor);
    });
    checkpointWrites.set(chat, write.catch(() => {}));
    return write;
  };
  const readCheckpoint = async (chat: string) => {
    const saved = await readFile(`${dir}/${encodeURIComponent(chat)}`, "utf8");
    if (!saved.startsWith("{")) {
      if (saved) {
        const uid = saved.replace(/^first:/, "");
        const page = await request<Page<Message>>(account, `/chats/${chat}/messages?limit=50&starting_after=${uid}`);
        recent.set(chat, new Set([...page.data.map(message => message.uid).reverse(), ...(saved.startsWith("first:") ? [] : [uid])]));
      }
      return saved;
    }
    const checkpoint = JSON.parse(saved) as { uid: string; recent: string[] };
    recent.set(chat, new Set(checkpoint.recent));
    return checkpoint.uid;
  };
  const dispatchTurn = async (items: Queued[], onSubmitted: () => void) => {
    if (signal.aborted) return;
    const first = items[0], last = items.at(-1)!;
    const chat = await request<Chat>(account, `/chats/${first.chatUid}`);
    if (!accepts(account, chat)) {
      for (const item of items) {
        unadopted.get(first.chatUid)?.delete(item.message.uid);
        pending.delete(item.message.uid);
      }
      return;
    }
    discovered.set(chat.uid, chat);
    const owner = findOwnerChat(account, [...discovered.values()]);
    const message = { ...last.message, body: items.map(item => item.message.body).join("\n") };
    let acknowledged: Promise<void> | undefined;
    const acknowledge = (stage: string) => acknowledged ??= (async () => {
      for (const item of items) {
        if (account.accountId === "chat") await ack(chat.uid, item.message.uid);
        pending.delete(item.message.uid);
        remember(item.message.uid);
        log(`acked chat=${chat.uid} message=${item.message.uid} stage=${stage}`);
      }
    })();
    const ingress = { abortSignal: signal, onSubmitted, onAdopted: () => acknowledge("adoption") };
    let outcome: TurnOutcome = "incomplete";
    try {
      const checkpoint = checkpoints.get(chat.uid);
      const firstContact = account.accountId === "chat" && chat.uid === owner?.uid && (checkpoint === "" || checkpoint === `first:${first.message.uid}`);
      let history: Message[] = [];
      const historyVersion = state.versions.get(chat.uid) ?? 0;
      let historyLoaded = contextualized.has(chat.uid) && !(account.accountId === "chat" && chat.uid === owner?.uid);
      if (!historyLoaded) {
        try { history = (await request<Page<Message>>(account, `/chats/${chat.uid}/messages?limit=20&starting_after=${first.message.uid}`)).data.reverse(); historyLoaded = true; }
        catch (error) { log(`history failed chat=${chat.uid}: ${(error as Error).name}; dispatching without history`); }
      }
      outcome = await turn(chat, message, firstContact, history, ingress);
      if (historyLoaded && (state.versions.get(chat.uid) ?? 0) === historyVersion) contextualized.add(chat.uid);
    }
    catch (error) {
      if (error instanceof DeliveryUnknownError) {
        // The provider may have accepted it; advance rather than replay a send.
        log(`turn failed chat=${chat.uid} message=${message.uid}: delivery unknown; acknowledging without replaying the send`);
        outcome = "completed";
      } else log(`turn failed chat=${chat.uid} message=${message.uid}: ${(error as Error).name}`);
    }
    await acknowledged;
    if (outcome === "incomplete") {
      if (signal.aborted) {
        log(`turn aborted chat=${chat.uid} message=${message.uid}; left unacked`);
        return;
      }
      log(`turn incomplete chat=${chat.uid} message=${message.uid}; left unacked`);
    }
    if (outcome === "completed") await acknowledge("terminal");
    else if (outcome === "incomplete") for (const item of items) pending.delete(item.message.uid);
  };

  const lastSpeaker = new Map<string, string>();
  const key = (item: Queued) => `${account.accountId}/${item.chatUid}/${item.message.sender.type === "member" ? item.message.sender.uid : item.message.sender.line.uid}`;
  const { debouncer } = createChannelInboundDebouncer<Queued>({
    cfg, channel: "plow", buildKey: key,
    shouldDebounce: item => account.accountId === "chat" && shouldDebounceTextInbound({
      cfg, text: item.message.body, hasMedia: item.message.attachments.length > 0,
    }),
    onFlush: items => {
      let submitted!: () => void;
      const admission = new Promise<void>(resolve => { submitted = resolve; });
      const completion = dispatchTurn(items, submitted).then(() => {
        for (const item of items) item.resolve();
      }).finally(submitted);
      return { admission, completion };
    },
    onError: (error, items) => { for (const item of items) { pending.delete(item.message.uid); item.reject(error); } },
    onCancel: items => { for (const item of items) item.resolve(); },
  });
  const cancel = () => { for (const item of pending.values()) debouncer.cancelKey(key(item)); };
  signal.addEventListener("abort", cancel, { once: true });
  const consume = async (chatUid: string, message: Message, recovering = false) => {
    if (signal.aborted || seen.has(message.uid) || checkpoints.get(chatUid) === message.uid || recent.get(chatUid)?.has(message.uid) || pending.has(message.uid)) return;
    const chat = discovered.get(chatUid);
    if (chat && !accepts(account, chat)) return;
    const sender = message.sender;
    if (message.direction !== "inbound" || !(sender.type === "member" || (account.accountId === "chat" && sender.relationship === "peer"))) {
      if (!accepts(account, await request<Chat>(account, `/chats/${chatUid}`))) return;
      if (!recovering) recoveryEnds.set(chatUid, message.uid);
      if (account.accountId === "chat") await ack(chatUid, message.uid);
      remember(message.uid);
      log(`acked chat=${chatUid} message=${message.uid}`);
      return;
    }
    let resolve!: () => void, reject!: (error: unknown) => void;
    const outcome = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    const item = { chatUid, message, resolve, reject };
    if (account.accountId === "chat") {
      if (!unadopted.has(chatUid)) unadopted.set(chatUid, new Set());
      unadopted.get(chatUid)!.add(message.uid);
    }
    if (!recovering) recoveryEnds.set(chatUid, message.uid);
    const previous = lastSpeaker.get(chatUid);
    if (previous && previous !== key(item)) await debouncer.flushKey(previous);
    if (signal.aborted) return;
    lastSpeaker.set(chatUid, key(item));
    pending.set(message.uid, item);
    inFlight.set(message.uid, outcome);
    void outcome.catch(() => {}).finally(() => { if (inFlight.get(message.uid) === outcome) inFlight.delete(message.uid); });
    dispatching.add(outcome);
    void outcome.catch(error => failDispatch(error)).finally(() => dispatching.delete(outcome));
    if (debouncer.shouldBuffer(item)) log(`buffered chat=${chatUid} sender=${key(item)} message=${message.uid} timestamp=${Date.now()}`);
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
    failDispatch = error => { queueFailed = true; queueError = error; socket?.terminate(); };
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
            const fromMember = (message: Message) => message.direction === "inbound" && message.sender.type === "member";
            const missed = (message: Message) => message.direction === "inbound" && Date.parse(message.created_at) >= since &&
              (message.sender.type === "member" || message.sender.relationship === "peer");
            const unanswered = chat.uid === owner?.uid ? fromMember : missed;
            checkpoint = newest && unanswered(newest)
              ? `first:${await earliestUnanswered(account, chat.uid, newest, unanswered, log)}` : newest?.uid ?? "";
            const buffered = bufferedChats.get(chat.uid);
            const first = buffered?.values().next().value;
            // A buffered frame moves first contact back only when history proves it is older.
            if (first && (!checkpoint.startsWith("first:") || (first !== checkpoint.slice(6) &&
              (await recover(account, chat.uid, `first:${first}`)).some(message => message.uid === checkpoint.slice(6))))) checkpoint = `first:${first}`;
            await ack(chat.uid, checkpoint, false);
            // Late frames can include an exclusive baseline, but must not replace pending first contact.
            if (!checkpoint.startsWith("first:") && bufferedChats.has(chat.uid)) {
              checkpoint = `first:${bufferedChats.get(chat.uid)!.values().next().value}`;
              await ack(chat.uid, checkpoint, false);
            }
          }
          checkpoints.set(chat.uid, checkpoint);
        }
      }
      socket.off("message", trackBufferedChat);
      // Remember recovery rows until buffered frames have drained.
      const replayed = new Set<string>();
      const recoveredChats = new Set<string>();
      const replay = async (chatUid: string) => {
        const checkpoint = checkpoints.get(chatUid)!;
        const window = await recover(account, chatUid, checkpoint);
        const unread = window.filter(message => !recent.get(chatUid)?.has(message.uid));
        for (const message of window) replayed.add(message.uid);
        if (window.length) recoveryEnds.set(chatUid, window.at(-1)!.uid);
        const unfinished = unadopted.get(chatUid) ?? new Set<string>();
        for (const message of window) if (!recent.get(chatUid)?.has(message.uid) && message.direction === "inbound" &&
          (message.sender.type === "member" || message.sender.relationship === "peer")) unfinished.add(message.uid);
        unadopted.set(chatUid, unfinished);
        for (const message of unread) {
          if (!accepting || signal.aborted) break;
          // A turn still running from before the drop decides the message: an
          // incomplete one leaves it unacked, and consume then dispatches it again.
          await inFlight.get(message.uid)?.catch(() => {});
          await consume(chatUid, message, true);
          replayed.add(message.uid);
        }
        recoveredChats.add(chatUid);
      };
      if (account.accountId === "chat") {
        for (const chat of chats) enqueue(chat.uid, () => replay(chat.uid));
      }
      for await (const [raw] of frames) {
        const event = JSON.parse(raw.toString());
        if (event.event_type !== "message_received" || !validChatId(event.chat_id) || seen.has(event.data.message.uid) || replayed.has(event.data.message.uid)) continue;
        // Persist discovery before queueing: a dropped connection discards unstarted work.
        if (account.accountId === "chat" && !checkpoints.has(event.chat_id)) {
          let checkpoint: string;
          try { checkpoint = await readCheckpoint(event.chat_id); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            checkpoint = `first:${event.data.message.uid}`;
            await ack(event.chat_id, checkpoint, false);
          }
          checkpoints.set(event.chat_id, checkpoint);
        }
        enqueue(event.chat_id, async () => {
          if (account.accountId === "chat" && !recoveredChats.has(event.chat_id)) {
            await replay(event.chat_id);
          }
          if (!accepting || signal.aborted) return;
          if (!replayed.has(event.data.message.uid)) await consume(event.chat_id, event.data.message);
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
      // Running turns deliver over HTTP and replay skips them as pending, so a
      // dropped socket reconnects without waiting for them.
      await Promise.all(queues.values());
    }
    if (!signal.aborted) await backoff(Math.min(30_000 * 2 ** attempt++, 300_000), signal);
  }
  signal.removeEventListener("abort", cancel);
  await debouncer.drain();
  await Promise.allSettled(dispatching);
  if (historyStates.get(accountHistoryKey) === state) historyStates.delete(accountHistoryKey);
}


export async function requestDelivery<T>(account: Pick<Account, "apiBase">, path: string, body: unknown, method: "POST" | "PUT" = "POST", headers?: Record<string, string>): Promise<T> {
  try { return await request<T>(account, path, body, undefined, method, headers); }
  catch (error) {
    if (!(error instanceof HttpError) || [408, 424].includes(error.status) || error.status >= 500) {
      throw new DeliveryUnknownError();
    }
    throw error;
  }
}

// OpenClaw drops a reply only when it is exactly NO_REPLY. A model that writes a status line and
// then the token got both delivered: 129 internal heartbeat notes reached people's phones in a week
// (2026-10-02), one of them after the person asked twice to stop. The token ending the text is the
// model choosing silence, so nothing is posted. Heartbeat sends say so, which lets the server tell
// them apart from any other message instead of guessing from the text.
// The silence-marker grammar is DELIBERATELY COPIED from Hermes (hermes-plugin-plow,
// plow-chat-platform/_transport.py `_ends_silent`), the component that sends these messages; Plow's
// server-side guard copies it too. All three must stay identical, and each repo carries the same case
// list (tests/transport.test.ts here), so a copy that drifts fails a test instead of a review.
export const isSilent = (text: string) =>
  text.split("\n").filter(line => line.trim()).at(-1)?.trim().replace(/^[.*_ `]+|[.*_ `]+$/g, "") === "NO_REPLY";

export async function postMessage(account: Pick<Account, "apiBase">, chatUid: string, text: string, attachmentUids: string[] = [], kind?: "heartbeat") {
  if (!attachmentUids.length && isSilent(text)) return { channel: "plow" as const, messageId: "", outcome: "not_sent" as const };
  const sent = await requestDelivery<{ uid: string }>(account, `/chats/${chatUid}/messages`, { body: text, attachment_uids: attachmentUids },
    "POST", kind ? { "Plow-Message-Kind": kind } : undefined);
  return { channel: "plow" as const, messageId: sent.uid };
}
