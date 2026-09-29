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
module instances. Plow shares the active turn by session key so `plow_start_thread`
can use its owner context. Tool Search is disabled to retain the tested plugin and
MCP tool surface.

A state database already opened by 2026.9.6 cannot be opened by 2026.9.4.
Restore a pre-upgrade backup, or use a fresh state volume (which resets local
profiles, sessions and memory); do not attempt an in-place database downgrade.
Before replacing a volume, stop the agent and preserve `/var/lib/plow/plow-checkpoints`.
Restore that directory into the replacement volume before booting the agent.
Without checkpoints, boot silently skips group messages from the outage window;
trailing unanswered owner DMs replay in order.

## Owner decision context

`plow_ask_owner` renders a human question in an isolated, tool-free inference
using the configured Plow model, then sends and mirrors that question. The
render receives human request data rather than the routing-aware session. It
has no fallback to the tool's proposed text if generation fails. The delivery mirror
is an assistant transcript entry, visible to session readers; it is not a private
context channel ([delivery mirror writer](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/infra/outbound/deliver-transcript.ts#L41)).
The plugin saves each notification's source and original member request in the
state volume, scoped to the API and phone line. On an owner-DM turn, notifications
in the loaded phone history (or the quoted reply target) supply structured
context. No separate pending-request lifecycle is needed; the phone history
selects the relevant asks, including after an agent restart.

OpenClaw projects `supplemental.channelStructuredContext` into model context
([inbound projection](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/auto-reply/reply/inbound-context.ts#L115)),
serializes and neutralizes embedded Markdown fences
([JSON context formatter](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/auto-reply/reply/channel-prompt-context.ts#L57)),
and tells the model that structural fields are context while human-authored
values are untrusted
([message context instructions](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/auto-reply/reply/inbound-meta.ts#L595)).
Source fields come from the active turn; member names and request text stay data.
The visible DM and its mirror contain no injected routing instructions.
