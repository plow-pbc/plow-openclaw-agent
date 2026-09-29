# Development

The image pins the runtime and SDK. CI type-checks boot, plugin and build sources,
runs all Node tests against that image, and boots the real offline gateway probe.
Tests use local fixtures and need no Plow credentials. Type checking uses the
published OpenClaw 2026.9.6 declarations because the runtime image omits them;
runtime tests use the SDK shipped in the pinned image. The plugin is an npm
workspace: CI and the image use the root lock, with development, peer and optional
dependencies omitted from the image install.

```sh
npm ci
docker build -t plow-openclaw:test .
docker run --rm --user root --network none \
  -v "$PWD/node_modules:/opt/plow/node_modules:ro" \
  -v "$PWD/tests:/opt/plow/tests:ro" plow-openclaw:test sh -c \
  '/opt/plow/node_modules/.bin/tsc --noEmit -p /opt/plow/tsconfig.json && mkdir -p /opt/plow/plugin/node_modules && ln -s /app /opt/plow/plugin/node_modules/openclaw && node --test /opt/plow/tests/*.test.ts'
docker run --rm --network none plow-openclaw:test /opt/plow/probe
```

## Pinned OpenClaw contracts

The Dockerfile pins OpenClaw `2026.9.6` by image digest. These source links target
its release commit `eb377ac59e6c9fd6c7705028034812becf00271b`.

| Contract | Source |
| --- | --- |
| Non-root runtime and foreground launcher | [Dockerfile](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/Dockerfile) |
| Config environment references | [Environment substitution](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/config/env-substitution.ts) |
| Private provider endpoint opt-in | [Provider transport](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/agents/provider-transport-fetch.ts) |
| Channel registration and inbound dispatch | [Plugin entry](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/plugin-sdk/core.ts), [turn contract](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/channels/turn/types.ts) |
| Session isolation and owner binding | [Routing schema](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/config/zod-schema.agents.ts) |
| Tool registration, requester and deny policy | [Tool API](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/plugins/plugin-api.types.ts), [hook context](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/plugins/hook-types.ts), [policy schema](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/config/zod-schema.agent-runtime.ts) |
| MCP configuration | [MCP server type](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/config/types.mcp.ts) |
| Native MCP catalog omits server instructions | [Catalog construction](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/agents/agent-bundle-mcp-runtime.ts) |

## Defaults we inherit

Generated config leaves host agent concurrency and cross-provider messaging
policy unset, so both follow the pinned OpenClaw release's defaults. Review
those defaults when changing the runtime pin or adding channels. Host concurrency
is separate from Plow's per-chat scheduling; Plow's send adapter still validates
that destinations are active and belong to its served lines.

On 2026.9.6, OpenClaw loads channel receipt and tool execution in separate plugin
module instances. Plow's existing shared session registry now attaches at agent
run start and clears at its terminal outcome, so commands and deferred admissions
cannot replace the running tool context. Tool Search is disabled to retain the
tested plugin and MCP tool surface.

A state database already opened by 2026.9.6 cannot be opened by 2026.9.4.
Restore a pre-upgrade backup, or use a fresh state volume (which resets local
profiles, sessions and memory); do not attempt an in-place database downgrade.
Before replacing a volume, stop the agent and preserve `/var/lib/plow/plow-checkpoints`.
Restore that directory into the replacement volume before booting the agent.
Without checkpoints, boot silently skips group messages from the outage window;
trailing unanswered owner DMs replay in order.

Plow follows the pinned iMessage channel's receive pattern:

| Plow wiring | Pinned OpenClaw source |
| --- | --- |
| Same-account/chat/sender key, SDK text/media/command policy, `createFlush` admission | [monitor-provider.ts:507–591](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/extensions/imessage/src/monitor/monitor-provider.ts#L507) |
| First-message identity, bounded text/attachment merge, latest timestamp, source identities | [coalesce.ts:40–151](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/extensions/imessage/src/monitor/coalesce.ts#L40) |
| SDK reply pipeline, typing callbacks, ingress lifecycle binding | [monitor-provider.ts:1103–1306](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/extensions/imessage/src/monitor/monitor-provider.ts#L1103) |
| Host-injected context builder and dispatcher | [Channel inbound API](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/docs/plugins/sdk-channel-inbound.md) |

The debounce is configured through `messages.inbound.byChannel.plow` (2000 ms).
The [pinned queue schema](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/config/zod-schema.messages.ts#L48)
rejects `messages.queue.byChannel.plow` (only native channel keys are accepted); Plow therefore uses the channel debouncer without a
queue override. Email keeps its existing immediate receive path.
Rejected steering remains in the SDK followup queue
([agent-runner-steer-adoption.ts:126](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/auto-reply/reply/agent-runner-steer-adoption.ts#L126)).
The channel debouncer batches before exclusive turn admission, so batching does
not depend on the active run accepting steering.

The durable ingress monitor
[refuses non-bundled channel registrations](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/plugins/registry-runtime.ts#L202). Plow
therefore retains its history/checkpoint transport for that piece: a 20-row
checkpoint overlap, persistent source-UID deduplication, atomic batch adoption,
and drain/cancellation at shutdown. iMessage instead fans in its durable ingress
claims and uses SQLite row IDs. Plow cannot order by `created_at` alone because
inbound and outbound timestamps come from different clocks.

Owner notifications quote the request and identify its source account/chat.
They do not assert a member name or role from the running turn: SDK steering
compatibility checks tool authority, so compatible senders can share a run.

The published SDK omits the declaration for `text-utility-runtime`; the local
declaration copies only `sliceUtf16Safe`'s pinned signature. Runtime execution
still uses the SDK helper.
