# Plow base image for OpenClaw

This image runs OpenClaw on Plow's cloud host or locally with Docker. You talk to
it on a Plow phone line. It can reply in group threads and its own email threads,
start groups and send follow-ups for the owner, and use the owner's Mac through
Latch, Plow’s Mac app that the owner installs. It uses `moonshotai/kimi-k2.5` through Plow.

## Run it

Install [plow-agents](https://github.com/plow-pbc/plow-agents), sign in, and choose
an available line. The listing includes the number you will text.

```sh
plow-agents login
plow-agents lines
```

No official image is published yet. For Plow's cloud host, first clone this repo,
then build and push from its root to a registry you control. Authenticate Docker
with that registry and make the image publicly pullable by Plow:

```sh
plow-agents image build REGISTRY/REPOSITORY:TAG
plow-agents image push REGISTRY/REPOSITORY:TAG
plow-agents deploy REGISTRY/REPOSITORY@sha256:DIGEST --line LINE_UID
```

Use the full digest reference printed by push and the selected line ID.

To build and run locally, clone this repository and run these commands from its
root. By default, mint writes `plow-credentials` in the current directory;
Compose reads `./plow-credentials` from this repository root:

```sh
plow-agents mint LINE_UID
docker compose up --build -d
docker compose logs -f agent
```

`plow-agents deploy --local --line LINE_UID` does the mint and the `compose up`
in one step. Either way, `plow-agents lines` is what names the line: it prints
the dashboard name and the number to text.

For a local Plow API, use the CLI's `--api-base` option and mint with
`--agent-api-base` set to an address the container can reach, such as
`http://host.docker.internal:PORT`.

Then text the selected number as the owner. Your first message starts the
conversation; no setup greeting is sent before it. Check that a reply arrives.
`docker compose down` keeps the named state volume. `docker compose down -v`
deletes it, so the next boot starts with fresh agent state.

## How it works

Boot reads `PLOW_API_BASE` from the environment: the API root without `/v1`.
Local runs also supply `PLOW_AGENT_TOKEN`. On a cloud host that injects the
credential, an absent or empty token becomes the placeholder `proxied`.
The boot process does not read a credential file itself.

Boot fetches the agent's identity, including its line, chats and optional MCP
relay URL. If the owner's direct chat does not exist yet, it waits for the first
text. A pending first message sent before boot is also processed. Existing
answered history is baselined, and restarts do not send a greeting.

Boot renders OpenClaw configuration and the workspace prompt under
`/var/lib/plow`, which Compose persists. The config uses environment references
for credentials and selects the Plow provider. The gateway runs as `node` and
binds loopback; Compose publishes no ports. Boot supervises it and forwards
shutdown signals. Plow's provider configuration allows a private API address,
so set `PLOW_API_BASE` only to an endpoint you control.

The `plow` channel plugin receives live messages over WebSocket and recovers
missed chat messages through the API. It uses separate chat and email accounts.
The owner's phone DM uses the main session; other DMs and groups have separate
sessions. Chat checkpoints survive restarts; email has no history backfill.
Shutdown-interrupted turns can be recovered. Live incomplete turns are logged
and acknowledged, losing that reply rather than replaying later answered turns.
An ambiguous delivery is not retried; a crash after a successful send but before
its checkpoint can still duplicate a reply.

Replies stay in the source chat. Two owner-only tools provide explicit sends:
`plow_start_thread` opens a group with the owner and supplied phone numbers;
`plow_send_message` sends to an existing chat the account serves. New groups are
untrusted. Tools generally require the owner or a trusted chat, but `read`,
`exec` and both send tools always require the owner. The plugin derives authority
from the current sender and chat roster. `ask_user` is disabled: clarifying
questions are ordinary replies that end the turn.

Detached sends, including restart delivery, are allowed to active chats the account
serves; absence of an active turn does not establish who initiated the send.
The host observes direct replies through `message_sent`; custom send tools return
API receipts and log sends, without emitting canonical `message_sent` observations.

For Latch, OpenClaw launches a small Node stdio MCP bridge. The bridge forwards
JSON-RPC to the identity-provided relay with the environment bearer and translates
JSON or SSE responses back to stdio. This lets the relay use a private host
address without OpenClaw's HTTP SSRF guard blocking it. TLS verification remains
on and redirects are refused; local rigs can use a plain HTTP relay origin.
Boot also fetches the Mac's MCP instructions for the prompt because the pinned
native client does not include them. An unavailable Mac does not prevent texting.

## Layout

| Path | Purpose |
| --- | --- |
| `boot/` | Identity lookup, config and prompt rendering, supervisor, probe and MCP bridge. |
| `plugin/` | Plow channel, transport, delivery, tools and authorization. |
| `seed/` | Assistant prompt and skills for the owner's Mac and Google Workspace. |
| `tests/` | Node tests with local API, WebSocket and MCP fixtures. |
| `Dockerfile`, `build.ts`, `compose.yml` | Pinned base image, TypeScript build and local runtime. |

## Tests

With Node 24 or later, the config suite below runs in a bare clone without any
install. It imports `boot/config.ts` directly and needs no `plugin/node_modules`:

```sh
node --test tests/config.test.ts
```

Run the full suite in the image, which contains the plugin dependencies and
pinned OpenClaw SDK. The temporary link makes the SDK available to source imports:

```sh
docker build -t plow-openclaw:test .
docker run --rm --user root --network none \
  -v "$PWD/tests:/opt/plow/tests:ro" plow-openclaw:test sh -c \
  'ln -s /app /opt/plow/plugin/node_modules/openclaw && node --test /opt/plow/tests/*.test.ts'
docker image rm plow-openclaw:test
```

The suite needs no Plow credentials. To check real delivery, run the agent with a
minted credential, text its number, and inspect the resulting conversation.

## Pinned OpenClaw contracts

The Dockerfile pins OpenClaw `2026.9.4` by image digest. These source links target
its release commit `3a9d69db306cd7f081e06254cb89c4bcc14a7107`.

| Contract | Source |
| --- | --- |
| Non-root runtime and foreground launcher | [Dockerfile](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/Dockerfile#L427-L448) |
| Config environment references | [Environment substitution](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/config/env-substitution.ts#L99-L145) |
| Private provider endpoint opt-in | [Provider transport](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/agents/provider-transport-fetch.ts#L666-L693) |
| Channel registration and inbound dispatch | [Plugin entry](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/plugin-sdk/core.ts#L553-L595), [turn contract](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/channels/turn/types.ts#L317-L349) |
| Session isolation and owner binding | [Routing schema](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/config/zod-schema.agents.ts#L90-L125) |
| Tool registration, requester and deny policy | [Tool API](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/plugins/plugin-api.types.ts#L209-L212), [hook context](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/plugins/hook-types.ts#L691-L726), [policy schema](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/config/zod-schema.agent-runtime.ts#L312-L318) |
| Stdio MCP configuration | [MCP server type](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/config/types.mcp.ts#L23-L37) |
| Native MCP catalog omits server instructions | [Catalog construction](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/agents/agent-bundle-mcp-runtime.ts#L825-L938) |
