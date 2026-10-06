export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export async function inboundImage(url: URL, contentType: string): Promise<Buffer> {
  if (!IMAGE_TYPES.has(contentType)) throw new Error("unsupported image type");
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "error" });
  if (!response.ok || !response.body) throw new Error("image download failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) throw new Error("image exceeds 8 MiB");
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_IMAGE_BYTES) throw new Error("image exceeds 8 MiB");
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel(); }
}
