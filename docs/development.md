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
| MCP configuration | [MCP server schema](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/config/zod-schema.mcp-server.ts) |
| Native MCP catalog omits server instructions | [Catalog construction](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/agents/agent-bundle-mcp-runtime.ts) |
| Channel identity and personal USER.md | [Identity methods](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/gateway/server-methods/users-channel-identities.ts), [session ownership](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/src/gateway/server-methods/sessions-mutations.ts) |

## Defaults we inherit

Generated config leaves host agent concurrency and cross-provider messaging
policy unset, so both follow the pinned OpenClaw release's defaults. Review
those defaults when changing the runtime pin or adding channels. Host concurrency
is separate from Plow's per-chat scheduling; Plow's send adapter still validates
that destinations are active and belong to its served lines.

OpenClaw 2026.9.6 still executes `plow_start_thread` without the channel module's
`AsyncLocalStorage` context. Channel receipt and tool execution load separate
instances of the plugin module. Plow shares its active turn by session key across
those instances; the current-chat send refusal and message delivery latch still
use their live outbound context. The dashboard owner profile is linked to the
`plow-owner` channel identity after first sign-in, and the owner DM session is
assigned to that profile so its personal `USER.md` loads on later turns.
The messaging tool profile excludes OpenClaw's `automations` scheduler, so
Plow explicitly allows it for owner reminders and denies it for other senders
with `toolsBySender`. OpenClaw 2026.9.6 enables Tool Search by default, which
would hide plugin and MCP schemas behind `tool_search` and `tool_call`; boot
sets `tools.toolSearch` to false to retain the tested tool surface. The 9.6
messaging profile also includes the new `gateway` and `theme` tools.
The trusted proxy grants the signed dashboard connection read, write and admin
scopes. A Gateway role would treat the channel sender sentinel as a profile ID
when an owner-created automation runs, so the base image leaves roles unset.
Boot uses its local password for identity reads and the idempotent link;
`sessions.assignOwner` requires an identified human, so boot uses a signed
trusted-proxy connection for that assignment. It polls every five minutes until
both records exist, then stops. A profile or session shape that cannot be linked
stops the polling with an error. The signing key stays in the state volume.

A state database already opened by 2026.9.6 cannot be opened by 2026.9.4.
Restore a pre-upgrade backup, or use a fresh state volume (which resets local
profiles, sessions and memory); do not attempt an in-place database downgrade.
Before replacing a volume, stop the agent and preserve `/var/lib/plow/plow-checkpoints`.
Restore that directory into the replacement volume before booting the agent.
Without checkpoints, boot silently skips group messages from the outage window
and all but the newest pending owner DM.
