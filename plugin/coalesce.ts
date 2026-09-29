import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { Message } from "./transport.ts";

const maxTextChars = 4000;
const maxAttachments = 20;
const maxEntries = 10;

// The first message anchors reply identity; every source UID remains in the batch.
export function combineMessages(messages: Message[]): Message {
  const first = messages[0];
  if (!first) throw new Error("Cannot combine an empty message batch");
  if (messages.length === 1) return first;
  const seenTexts = new Set<string>();
  const textParts: string[] = [];
  const attachments: Message["attachments"] = [];
  let textLength = 0;
  let latestCreatedAt: string | undefined;
  let reply: Message | undefined;
  for (const [index, message] of messages.entries()) {
    const keepContent = index < maxEntries - 1 || index === messages.length - 1;
    if (message.created_at && (latestCreatedAt === undefined || message.created_at > latestCreatedAt)) latestCreatedAt = message.created_at;
    if (!reply && message.reply_to) reply = message;
    if (!keepContent) continue;
    const text = textLength <= maxTextChars ? message.body.trim() : "";
    if (text) {
      const normalized = seenTexts.size > 0 ? text.toLowerCase() : undefined;
      if (normalized === undefined || !seenTexts.has(normalized)) {
        const separatorLength = textParts.length > 0 ? 1 : 0;
        const part = text.slice(0, maxTextChars + 1 - textLength - separatorLength);
        textParts.push(part);
        textLength += separatorLength + part.length;
        if (textLength <= maxTextChars) seenTexts.add(normalized ?? text.toLowerCase());
      }
    }
    for (const attachment of message.attachments) {
      if (attachments.length === maxAttachments) break;
      attachments.push(attachment);
    }
  }
  let body = textParts.join(" ");
  if (textLength > maxTextChars) body = `${sliceUtf16Safe(body, 0, maxTextChars)}…[truncated]`;
  return { ...first, body, attachments, created_at: latestCreatedAt ?? first.created_at, reply_to: (reply ?? first).reply_to };
}
