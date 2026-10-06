import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { createHash } from "node:crypto";
import { request, requestDelivery, findOwnerChat, DeliveryUnknownError, type Account, type Chat } from "./transport.ts";

export type Requester = Pick<OpenClawPluginToolContext, "sessionKey" | "messageChannel" | "agentAccountId" | "nativeChannelId" | "deliveryContext" | "requesterSenderId" | "senderIsOwner">;
export function conversationUid(context: Requester): string | undefined {
  return (context.nativeChannelId ?? context.deliveryContext?.to)?.replace(/^plow:/i, "");
}
export async function ownerDmTurn(account: Account, context: Requester): Promise<{ chat: Chat }> {
  const uid = conversationUid(context);
  if (context.sessionKey !== "agent:main:main" || context.messageChannel !== "plow" || !context.senderIsOwner
    || context.agentAccountId !== "chat" || !uid || !context.requesterSenderId) throw new Error("This action requires the owner's main Plow DM.");
  const chat = await request<Chat>(account, `/chats/${encodeURIComponent(uid)}`);
  if (findOwnerChat(account, [chat]) !== chat) throw new Error("This action requires the owner's main Plow DM.");
  return { chat };
}

export function threadHandle(value: string): string {
  const normalized = value.includes("@") ? value.trim().toLowerCase() : value.replace(/[\s().-]/g, "");
  if (!/^\+[1-9][0-9]{1,14}$/.test(normalized) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("Use an E.164 phone number or an iMessage email address.");
  return normalized;
}

function groupTrust(account: Account, choice: boolean | undefined): boolean {
  if (account.threadTrust !== "ask" && account.threadTrust !== "trusted" && account.threadTrust !== "untrusted") throw new Error("Plow group trust mode is unavailable.");
  if (account.threadTrust === "ask" && typeof choice !== "boolean") throw new Error("Starting a group requires an explicit trust choice.");
  return account.threadTrust === "trusted" || (account.threadTrust === "ask" && choice === true);
}

// Shared by the native tool and image-installed workflow plugins. Callers
// retain the active owner-DM gate, trust policy and stable API idempotency key.
export async function startThread(account: Account, context: Requester, callId: string, args: { members: string[]; body: string; trusted?: boolean }): Promise<{ chat_uid: string; message_sent: true }> {
  const turn = await ownerDmTurn(account, context);
  if (!callId || !args.body.trim() || !args.members.length) throw new Error("A thread needs a stable call ID, recipients and a first message.");
  const owner = turn.chat.participants.find(value => value.type === "member" && value.role === "owner");
  if (owner?.type !== "member" || !owner.provider_key) throw new Error("The owner's chat has no owner handle");
  const members = [...new Set([threadHandle(owner.provider_key), ...args.members.map(threadHandle)])].sort();
  const trusted = groupTrust(account, args.trusted);
  const idempotencyKey = createHash("sha256").update(JSON.stringify([account.lineUid, callId, members, args.body, trusted])).digest("hex");
  const chat = await requestDelivery<{ uid: string }>(account, "/chats", { line_uid: account.lineUid, members, body: args.body, trusted, idempotency_key: idempotencyKey });
  if (!chat.uid) throw new DeliveryUnknownError();
  return { chat_uid: chat.uid, message_sent: true };
}
