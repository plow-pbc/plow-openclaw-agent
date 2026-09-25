# Config include verification — 2026-09-25

Validated with the OpenClaw 2026.9.6 image built from this branch after merging
main's first-contact replay and boot-log changes.

- Container typecheck and Node suite: 180 passed, 0 failed, 0 skipped.
- Offline gateway probe: `PLOW_PROBE_OK`; the real Plow channel registered and
  the gateway became ready with include-backed config.
- On the local DTU stack, `config.patch` through the gateway API accepted a
  disabled Discord channel, a second model provider, and an enabled GitHub
  plugin entry. These are the same config methods used by the Control UI.
- The `config.patch` gateway-port edit was refused with `Config mutation cannot
  update external $include target /etc/plow/openclaw/gateway.json5`.
- Patches to the main agent's identity and binding entry were also refused at
  their external includes; the binding replacement returned
  `CONFIG_INCLUDE_OWNERSHIP`.
- `openclaw plugins install --link` refused an additional local plugin because
  `plugins.load` uses an include.
- A replacement container started on the same state volume. `config.get`
  returned `valid: true`, with Discord, the extra provider, and the GitHub
  plugin entry intact. Its resolved config contained the Plow channel, main
  identity, and owner DM binding. The raw config still held external includes
  at those paths.
- After that restart, the owner sent `19 × 23` through the LINQ twin to the
  disposable agent's line. The twin recorded the agent's outbound reply `437`.

The gateway API was exercised with `openclaw gateway call`, rather than by
clicking through the browser Control UI. The test used an isolated local agent,
line, and state volume; no production line was involved.
