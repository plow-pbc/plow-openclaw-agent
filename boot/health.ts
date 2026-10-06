export async function healthy(url = "http://127.0.0.1:3000/readyz"): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "error" });
    const value: unknown = await response.json();
    return response.ok && typeof value === "object" && value !== null && "ready" in value && value.ready === true;
  } catch { return false; }
}
if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await healthy() ? 0 : 1;
