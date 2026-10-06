import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const patches = [
  // The coordinator acknowledges worker cancellation. Native result handoff
  // is separate; suppress only the redundant automatic terminal notice.
  {
    path: "/app/dist/task-notification-policy-7pB-BxLh.mjs",
    checksum: "28d0996e08711568666ccd06d32030afcb93d2304e344a24cfcaa6f0abf46e32",
    before: "function shouldAutoDeliverTaskTerminalUpdate(task) {",
    after: "function shouldAutoDeliverTaskTerminalUpdate(task) {\n\tif (task.runtime === \"subagent\" && task.childSessionKey?.startsWith(\"agent:plow-worker:subagent:\")) return false;",
  },
];
for (const { path, checksum, before, after } of patches) {
  const source = await readFile(path, "utf8");
  if (createHash("sha256").update(source).digest("hex") !== checksum) {
    throw new Error(`Pinned runtime changed at ${path}; review its Plow compatibility patch before building`);
  }
  if (source.split(before).length !== 2) throw new Error(`Pinned runtime patch target is not unique: ${path}`);
  await writeFile(path, source.replace(before, after));
}
