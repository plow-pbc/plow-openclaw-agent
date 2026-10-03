/*
 * Checkpoints are per chat; after baseline initialization, progress advances only
 * once OpenClaw adopts a turn. Sources interrupted before adoption
 * stay unacked; adopted sources and uncertain sends are not replayed.
 * first:<uid> requests inclusive replay from uid. Recovery and buffered frames
 * dispatch in history order within each chat. Catch-up reads only the newest
 * 50 messages; durable UID deduplication covers repeated frames.
 * Commands without an agent run acknowledge at terminal completion.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { on, once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

export type Member = { type: "member"; uid: string; display_name: string; role: string; provider_key: string };
export type RosterMember = Omit<Member, "provider_key"> & { provider_key?: string | null };
export type Agent = { type: "agent"; relationship: string; line: { uid: string; display_name?: string } };
export type Chat = { uid: string; status: string; trusted: boolean; display_name?: string; participants: (RosterMember | Agent)[] };
export type Message = {
  uid: string; direction: string; body: string; sender: Member | Agent; created_at: string;
  attachments: { url: string; content_type: string; filename: string }[];
  reply_to?: Message;
};
export type TurnIngress = { abortSignal: AbortSignal; onSubmitted: () => void; onAdopted: () => Promise<void> };
export type TurnOutcome = "completed" | "incomplete" | "deferred";
export type Page<T> = { data: T[]; has_more: boolean };
export type Account = { accountId: string; apiBase: string; lineUid: string; emailLineUid?: string; emailName?: string; threadTrust?: "ask" | "trusted" | "untrusted" };

export class HttpError extends Error {
  status: number;
  constructor(status: number) { super(`Plow HTTP ${status}`); this.status = status; }
}

export class DeliveryUnknownError extends Error {
  constructor() { super("Plow delivery is unknown; not replaying this send"); }
}

export async function request<T>(account: Pick<Account, "apiBase">, path: string, body?: unknown, signal?: AbortSignal, method: "POST" | "PUT" = "POST"): Promise<T> {
  const token = process.env.PLOW_AGENT_TOKEN;
  if (!token) throw new Error("PLOW_AGENT_TOKEN is required");
  const response = await fetch(`${account.apiBase}/v1${path}`, {
    method: body === undefined ? "GET" : method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
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
export async function recover(account: Account, chat: string, checkpoint: string, log?: (text: string) => void): Promise<Message[]> {
  const page = await request<Page<Message>>(account, `/chats/${chat}/messages?limit=50`);
  const boundary = page.data.findIndex(message => message.uid === checkpoint.replace(/^first:/, ""));
  if (boundary < 0 && page.has_more) {
    // The API exposes no total or checkpoint position beyond this page.
    log?.(`warning: catch-up truncated chat=${chat} fetched=${page.data.length} older_unread_skipped=unknown; checkpoint absent from newest page`);
  }
  return page.data.slice(0, boundary < 0 ? undefined : boundary + (checkpoint.startsWith("first:") ? 1 : 0)).reverse();
}

async function earliestUnansweredOwnerMessage(account: Account, chat: string, newest: Message, log: (text: string) => void): Promise<string> {
  const page = await request<Page<Message>>(account, `/chats/${chat}/messages?limit=50`);
  let earliest = newest.uid;
  for (const message of page.data) {
    if (message.direction !== "inbound" || message.sender.type !== "member") return earliest;
    earliest = message.uid;
  }
  if (page.has_more) log(`warning: catch-up truncated chat=${chat} fetched=${page.data.length} older_unread_skipped=unknown; owner backlog exceeds newest page`);
  return earliest;
}

export async function listen(account: Account, signal: AbortSignal, log: (text: string) => void, turn: (chat: Chat, message: Message, firstContact: boolean, history: Message[], ingress: TurnIngress) => Promise<TurnOutcome>) {
  const root = process.env.OPENCLAW_STATE_DIR;
  if (!root) throw new Error("OPENCLAW_STATE_DIR is required");
  const dir = `${root}/plow-checkpoints`;
  await mkdir(dir, { recursive: true });
  const checkpoints = new Map<string, string>();
  const recent = new Map<string, Set<string>>();
  const unadopted = new Map<string, Set<string>>();
  type Queued = { chat: Chat; message: Message };
  const pending = new Set<string>();
  const dispatching = new Set<Promise<void>>();
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
      while (handled.size > 512) handled.delete(handled.values().next().value!);
      recent.set(chat, handled);
      // Later handled rows must not move recovery past an unfinished source.
      const cursor = unadopted.get(chat)?.size ? checkpoints.get(chat)! : uid;
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
  const dispatchTurn = async ({ chat, message }: Queued, onSubmitted: () => void) => {
    let acknowledged: Promise<void> | undefined;
    const acknowledge = (stage: string) => acknowledged ??= (async () => {
      if (account.accountId === "chat") await ack(chat.uid, message.uid);
      pending.delete(message.uid);
      remember(message.uid);
      log(`acked chat=${chat.uid} message=${message.uid} stage=${stage}`);
    })();
    const ingress = { abortSignal: signal, onSubmitted, onAdopted: () => acknowledge("adoption") };
    const owner = findOwnerChat(account, [...discovered.values()]);
    let outcome: TurnOutcome = "incomplete";
    try {
      const checkpoint = checkpoints.get(chat.uid);
      const firstContact = account.accountId === "chat" && chat.uid === owner?.uid && (checkpoint === "" || checkpoint === `first:${message.uid}`);
      let history: Message[] = [];
      const historyVersion = state.versions.get(chat.uid) ?? 0;
      let historyLoaded = contextualized.has(chat.uid) && !(account.accountId === "chat" && chat.uid === owner?.uid);
      if (!historyLoaded) {
        try { history = (await request<Page<Message>>(account, `/chats/${chat.uid}/messages?limit=20&starting_after=${message.uid}`)).data.reverse(); historyLoaded = true; }
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
    else if (outcome === "incomplete") pending.delete(message.uid);
  };

  const consume = async (chatUid: string, message: Message) => {
    if (signal.aborted || seen.has(message.uid) || checkpoints.get(chatUid) === message.uid || recent.get(chatUid)?.has(message.uid) || pending.has(message.uid)) return;
    const chat = await request<Chat>(account, `/chats/${chatUid}`);
    if (!accepts(account, chat)) return;
    discovered.set(chat.uid, chat);
    findOwnerChat(account, [...discovered.values()]);
    const sender = message.sender;
    if (message.direction !== "inbound" || !(sender.type === "member" || (account.accountId === "chat" && sender.relationship === "peer"))) {
      if (account.accountId === "chat") await ack(chatUid, message.uid);
      remember(message.uid);
      log(`acked chat=${chatUid} message=${message.uid}`);
      return;
    }
    const item = { chat, message };
    if (account.accountId === "chat") {
      if (!unadopted.has(chatUid)) unadopted.set(chatUid, new Set());
      unadopted.get(chatUid)!.add(message.uid);
    }
    pending.add(message.uid);
    let onSubmitted!: () => void;
    const submitted = new Promise<void>(resolve => { onSubmitted = resolve; });
    const task = dispatchTurn(item, onSubmitted).finally(onSubmitted);
    dispatching.add(task);
    void task.catch(error => failDispatch(error)).finally(() => dispatching.delete(task));
    await submitted;
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
            checkpoint = chat.uid === owner?.uid && newest?.direction === "inbound" && newest.sender.type === "member"
              ? `first:${await earliestUnansweredOwnerMessage(account, chat.uid, newest, log)}` : newest?.uid ?? "";
            const buffered = bufferedChats.get(chat.uid);
            const first = buffered?.values().next().value;
            // A buffered frame moves first contact back only when history proves it is older.
            if (first && (!checkpoint.startsWith("first:") || (first !== checkpoint.slice(6) &&
              (await recover(account, chat.uid, `first:${first}`, log)).some(message => message.uid === checkpoint.slice(6))))) checkpoint = `first:${first}`;
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
        const window = await recover(account, chatUid, checkpoint, log);
        for (const message of window) {
          if (!accepting || signal.aborted) break;
          await consume(chatUid, message);
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
      await Promise.allSettled(dispatching);
      await Promise.all(queues.values());
    }
    if (!signal.aborted) await delay(Math.min(30_000 * 2 ** attempt++, 300_000), undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
  }
  if (historyStates.get(accountHistoryKey) === state) historyStates.delete(accountHistoryKey);
}
