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
Before replacing a volume, stop the agent and preserve `/var/lib/plow/plow-checkpoints`
and `/var/lib/plow/plow-owner-asks` (including unresolved decision routes).
Restore both directories into the replacement volume before booting the agent.
Without checkpoints, boot silently skips group messages from the outage window;
trailing unanswered owner DMs replay in order.

## Owner decision context

`plow_ask_owner` renders a human question in an isolated, tool-free inference
using the first model in the Plow-owned provider catalog, then sends and mirrors that question with the fixed human provenance “A member asks:”. The
render receives human request data rather than the routing-aware session. It
has no fallback to the tool's proposed text if generation fails. The delivery mirror
is an assistant transcript entry, visible to session readers; it is not a private
context channel ([delivery mirror writer](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/infra/outbound/deliver-transcript.ts#L41)).
The plugin journals the source and original member request before delivery,
scoped to the API, phone line and literal notification body. Each source request
has its own record, so identical questions retain all sources. The notification
uses `format: none` to keep its phone body identical to the journal key; an
ambiguous send response cannot discard the route. A definitive adapter rejection
removes its source record before the SDK wraps the failed batch. An uncertain
delivery blocks further asks before journaling. The owner must clarify when one
question matches several sources. On an owner-DM turn, notifications
in the loaded literal phone history supply structured
context. No separate pending-request lifecycle is needed; the phone history
selects the relevant asks, including after an agent restart. An owner history
fetch failure leaves the decision unacknowledged for recovery after reconnect.

OpenClaw projects `supplemental.channelStructuredContext` into model context
([inbound projection](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/auto-reply/reply/inbound-context.ts#L115)),
serializes and neutralizes embedded Markdown fences
([JSON context formatter](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/auto-reply/reply/channel-prompt-context.ts#L57)),
and tells the model that structural fields are context while human-authored
values are untrusted
([message context instructions](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/auto-reply/reply/inbound-meta.ts#L595)).
Source fields come from the active turn; member names and request text stay data.
The visible DM and its mirror contain no injected routing instructions; their
member-derived content is explicitly untrusted and cannot approve an action.
