import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const url = process.env.PLOW_MCP_URL;
const token = process.env.PLOW_AGENT_TOKEN;
const bridgeToken = process.env.PLOW_MCP_BRIDGE_TOKEN;
if (!url || !token || !bridgeToken) throw new Error("PLOW_MCP_URL, PLOW_AGENT_TOKEN and PLOW_MCP_BRIDGE_TOKEN are required");
// Where a tool's images and files are saved, in the workspace, so the agent can text them (#116).
const files = process.env.PLOW_MCP_FILES_DIR ?? "/var/lib/plow/workspace/latch";
const KEEP_FILES = 100;
let saves = 0;
const EXTENSIONS: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };

type Block = { type?: string; data?: unknown; mimeType?: string; resource?: { uri?: string; blob?: unknown } };
const bytesOf = (block: Block) => block?.type === "image" ? block.data : block?.type === "resource" ? block.resource?.blob : undefined;

// Latch returns a screenshot as an image block and any other file as an embedded resource. OpenClaw
// shows a text-only model no image and keeps only a resource's path on the Mac, so the agent could
// neither see nor send either. Each is saved here, and the result says where.
async function saveToolFiles(body: string) {
  const rpc = JSON.parse(body);
  const content: Block[] | undefined = rpc?.result?.content;
  if (!Array.isArray(content) || !content.some(block => typeof bytesOf(block) === "string")) return body;
  const blocks: unknown[] = [];
  for (const block of content) {
    const bytes = bytesOf(block);
    if (typeof bytes !== "string") { blocks.push(block); continue; }
    const name = block.type === "image"
      ? `screenshot${EXTENSIONS[block.mimeType ?? ""] ?? ""}`
      : basename(decodeURIComponent(URL.parse(block.resource!.uri ?? "")?.pathname ?? "")).replace(/[^\w.-]+/g, "_").slice(-80) || "file";
    // A folder each, so the file is texted under its own name.
    const folder = join(files, `${Date.now()}-${++saves}`);
    await mkdir(folder, { recursive: true });
    const path = join(folder, name);
    await writeFile(path, Buffer.from(bytes, "base64"), { mode: 0o600 });
    // The image stays for a model that can see it; the file's bytes reach the agent as the file.
    if (block.type === "image") blocks.push(block);
    // The path ends the text, so no punctuation is mistaken for part of it.
    blocks.push({ type: "text", text: `${block.type === "image" ? "This image" : block.resource!.uri} is saved on your machine. To text it, attach this path: ${path}` });
  }
  // Folders are named for the time they were saved: keep the newest.
  const saved = (await readdir(files)).sort();
  await Promise.all(saved.slice(0, -KEEP_FILES).map(name => rm(join(files, name), { recursive: true, force: true })));
  return JSON.stringify({ ...rpc, result: { ...rpc.result, content: blocks } });
}

// Preserve each client's MCP session and HTTP result; never replay a request.
createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${bridgeToken}`) {
    response.writeHead(401).end("Unauthorized");
    return;
  }
  const controller = new AbortController();
  response.once("close", () => controller.abort());
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    for (const key of ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "mcp-method", "last-event-id"]) {
      const value = request.headers[key];
      if (typeof value === "string") headers.set(key, value);
    }
    const upstream = await fetch(url, {
      method: request.method, redirect: "error", signal: controller.signal, headers,
      body: ["GET", "HEAD"].includes(request.method!) ? undefined : Buffer.concat(chunks),
    });
    for (const key of ["content-type", "mcp-session-id", "mcp-protocol-version", "retry-after"]) {
      const value = upstream.headers.get(key);
      if (value) response.setHeader(key, value);
    }
    response.writeHead(upstream.status);
    response.flushHeaders();
    if (upstream.headers.get("content-type")?.startsWith("application/json")) {
      const body = await upstream.text();
      response.end(await saveToolFiles(body).catch(() => body));
    } else if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
    else response.end();
  } catch {
    if (!response.headersSent && !response.destroyed) response.writeHead(502).end("Relay request failed");
    else response.destroy();
  }
}).listen(18790, "127.0.0.1", () => process.send?.("ready"));
