import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { on, once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

export type Member = { type: "member"; uid: string; display_name: string; role: string; provider_key?: string };
export type Agent = { type: "agent"; relationship: string; line: { uid: string; display_name?: string } };
export type Chat = { uid: string; status: string; trusted: boolean; display_name?: string; participants: (Member | Agent)[] };
export type Message = {
  uid: string; direction: string; body: string; sender: Member | Agent; created_at: string;
  attachments: { url: string; content_type: string; filename: string }[];
  reply_to?: Message;
};
export type TurnOutcome = "completed" | "incomplete";
export type Page<T> = { data: T[]; has_more: boolean };
export type Account = { accountId: string; apiBase: string; lineUid: string; ownerChatUid: string; emailLineUid?: string };

export class HttpError extends Error {
  status: number;
  constructor(status: number) { super(`Plow HTTP ${status}`); this.status = status; }
}

export class DeliveryUnknownError extends Error {
  constructor() { super("Plow delivery is unknown; stopped to avoid resending"); }
}

export async function request<T>(account: Account, path: string, body?: unknown): Promise<T> {
  const token = process.env.PLOW_AGENT_TOKEN;
  if (!token) throw new Error("PLOW_AGENT_TOKEN is required");
  const response = await fetch(`${account.apiBase}/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new HttpError(response.status);
  return await response.json() as T;
}

export function accepts(account: Account, chat: Chat): boolean {
  const line = account.accountId === "email" ? account.emailLineUid : account.lineUid;
  return chat.status === "active" && chat.participants.some(p => p.type === "agent" && p.relationship === "self" && p.line.uid === line);
}

// Pages run newest-first; starting_after means older than the page cursor.
// A first:<uid> checkpoint includes that message, but none of its older history.
export async function recover(account: Account, chat: string, checkpoint: string): Promise<Message[]> {
  const missed: Message[] = [];
  let cursor = "";
  for (;;) {
    const page = await request<Page<Message>>(account, `/chats/${chat}/messages?limit=50${cursor ? `&starting_after=${cursor}` : ""}`);
    for (const message of page.data) {
      if (message.uid === checkpoint) return missed.reverse();
      missed.push(message);
      if (`first:${message.uid}` === checkpoint) return missed.reverse();
    }
    if (!page.has_more || !page.data.length) return missed.reverse();
    cursor = page.data.at(-1)!.uid;
  }
}

export async function listen(account: Account, signal: AbortSignal, log: (text: string) => void, turn: (chat: Chat, message: Message, firstContact: boolean) => Promise<TurnOutcome>) {
  const root = process.env.OPENCLAW_STATE_DIR;
  if (!root) throw new Error("OPENCLAW_STATE_DIR is required");
  const dir = `${root}/plow-checkpoints`;
  await mkdir(dir, { recursive: true });
  const checkpoints = new Map<string, string>();
  const seen = new Set<string>();
  let attempt = 0;
  const remember = (id: string) => {
    seen.add(id);
    if (seen.size > 512) seen.delete(seen.values().next().value!);
  };
  const ack = async (chat: string, uid: string) => {
    await writeFile(`${dir}/${chat}.tmp`, uid);
    await rename(`${dir}/${chat}.tmp`, `${dir}/${chat}`);
    checkpoints.set(chat, uid);
  };
  const consume = async (chatUid: string, message: Message) => {
    if (signal.aborted || seen.has(message.uid) || checkpoints.get(chatUid) === message.uid) return;
    const chat = await request<Chat>(account, `/chats/${chatUid}`);
    if (!accepts(account, chat)) return;
    const sender = message.sender;
    if (message.direction === "inbound" && (sender.type === "member" || (account.accountId === "chat" && sender.relationship === "peer"))) {
      let outcome: TurnOutcome = "incomplete";
      try {
        const checkpoint = checkpoints.get(chat.uid);
        const firstContact = account.accountId === "chat" && chat.uid === account.ownerChatUid && (checkpoint === "" || checkpoint === `first:${message.uid}`);
        outcome = await turn(chat, message, firstContact);
      }
      catch (error) {
        if (error instanceof DeliveryUnknownError) {
          // The provider may have accepted it; advance rather than replay a send.
          log(`delivery unknown chat=${chat.uid} message=${message.uid}; not resending`);
          outcome = "completed";
        } else log(`turn failed chat=${chat.uid} message=${message.uid}: ${(error as Error).name}`);
      }
      if (outcome !== "completed") {
        if (signal.aborted) {
          log(`turn aborted chat=${chat.uid} message=${message.uid}; left unacked`);
          return;
        }
        log(`turn incomplete chat=${chat.uid} message=${message.uid}; reply lost, acknowledging`);
      }
    }
    if (account.accountId === "chat") await ack(chatUid, message.uid);
    remember(message.uid);
    log(`acked chat=${chatUid} message=${message.uid}`);
  };
  while (!signal.aborted) {
    let socket: WebSocket | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const abort = () => socket?.terminate();
    try {
      const { ticket } = await request<{ ticket: string }>(account, "/ws/ticket", {});
      socket = new WebSocket(`${account.apiBase.replace(/^http/, "ws")}/v1/ws?ticket=${encodeURIComponent(ticket)}`);
      let unauthorized = false;
      socket.on("unexpected-response", (_request, response) => socket!.emit("error", new HttpError(response.statusCode!)));
      socket.on("close", code => { unauthorized = code === 4401; });
      const frames = on(socket, "message", { signal, close: ["close"] });
      const bufferedChats = new Map<string, string>();
      const trackBufferedChat = (raw: WebSocket.RawData) => {
        const event = JSON.parse(raw.toString());
        if (event.event_type === "message_received" && !bufferedChats.has(event.chat_id)) bufferedChats.set(event.chat_id, event.data.message.uid);
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
      if (listing.has_more) throw new Error("Plow chat listing is truncated");
      const chats = listing.data.filter(chat => accepts(account, chat));
      await request(account, "/agents/me");
      if (account.accountId === "chat") {
        for (const chat of chats) {
          if (checkpoints.has(chat.uid)) continue;
          let checkpoint: string;
          try { checkpoint = await readFile(`${dir}/${chat.uid}`, "utf8"); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            const page = await request<Page<Message>>(account, `/chats/${chat.uid}/messages?limit=1`);
            const newest = page.data[0];
            checkpoint = chat.uid === account.ownerChatUid && newest?.direction === "inbound" && newest.sender.type === "member"
              ? `first:${newest.uid}` : newest?.uid ?? "";
            await ack(chat.uid, checkpoint);
            // Include frames that arrived while the baseline was being persisted.
            if (bufferedChats.has(chat.uid)) {
              checkpoint = `first:${bufferedChats.get(chat.uid)}`;
              await ack(chat.uid, checkpoint);
            }
          }
          checkpoints.set(chat.uid, checkpoint);
        }
      }
      socket.off("message", trackBufferedChat);
      // Retain the finite recovery overlap until this connection closes.
      const replayed = new Set<string>();
      if (account.accountId === "chat") {
        for (const chat of chats) {
          for (const message of await recover(account, chat.uid, checkpoints.get(chat.uid)!)) {
            await consume(chat.uid, message);
            replayed.add(message.uid);
          }
        }
      }
      for await (const [raw] of frames) {
        const event = JSON.parse(raw.toString());
        if (event.event_type !== "message_received" || seen.has(event.event_id) || replayed.has(event.data.message.uid)) continue;
        await consume(event.chat_id, event.data.message);
        remember(event.event_id);
      }
      if (unauthorized) throw new HttpError(401);
    } catch (error) {
      if (signal.aborted) break;
      if (error instanceof HttpError && error.status === 401) {
        log(error.message + "; stopped until restart");
        await once(signal, "abort");
        break;
      }
      log(`transport stopped: ${error instanceof HttpError ? error.message : (error as Error).name}`);
    } finally {
      clearInterval(heartbeat);
      signal.removeEventListener("abort", abort);
      socket?.terminate();
    }
    if (!signal.aborted) await delay(Math.min(30_000 * 2 ** attempt++, 300_000), undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
  }
}
