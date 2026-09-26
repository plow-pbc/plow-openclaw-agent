# Plow base image for OpenClaw

This image runs OpenClaw on Plow's cloud host or locally with Docker. You talk to
it on a Plow phone line. It can reply in group threads and its own email threads,
start groups and send follow-ups for the owner, and use the owner's Mac through
Latch, Plow’s Mac app that the owner installs. It uses `z-ai/glm-5.2` through Plow, with `anthropic/claude-sonnet-5` as fallback.

## Run it

Install [plow-agents](https://github.com/plow-pbc/plow-agents), sign in, and choose
an available line. The listing includes the number you will text.

```sh
plow-agents login
plow-agents lines
```

This image is published as
`public.ecr.aws/e1h7x4a2/plow-cloud-agents:base-<sha>@sha256:<digest>`, one
immutable tag per commit of this repository — pinned by digest, because a tag
is a name someone can move, and the code it names boots holding this agent's
Plow credential. An agent built on it is a `FROM` line plus its own content — see [Building a variant image](#building-a-variant-image). Build
and push your variant to a registry you control, make it publicly pullable by
Plow, and deploy it:

```sh
plow-agents image build REGISTRY/REPOSITORY:TAG
plow-agents image push REGISTRY/REPOSITORY:TAG
plow-agents deploy REGISTRY/REPOSITORY@sha256:DIGEST --line LINE_UID
```

Use the full digest reference printed by push and the selected line ID — for
your image and for the base you build on alike.

To build and run locally, clone this repository and run these commands from its
root. By default, mint writes `plow-credentials` in the current directory;
Compose reads `./plow-credentials` from this repository root:

```sh
plow-agents mint LINE_UID
docker compose up --build
```

Open <http://localhost:3001>.

The gateway always serves the Control UI on loopback port 3000. No dashboard
origin environment variable is needed. Compose publishes the local dashboard
through a loopback-only proxy on port 3001; it does not publish port 3000.

Plow reaches it through the private `https://<vm>.exe.xyz:3000` ingress, which
delivers to `127.0.0.1` inside the VM. The proxy requires the exact browser
origin on WebSockets and preserves that `Origin` upstream, while replacing the
browser's `Host` with the upstream host. OpenClaw accepts any browser origin;
the proxy enforces the origin and owner checks. The image uses relative links
so the browser stays on its agent's web origin.

The proxy removes browser-supplied `X-Plow-*`, `X-Exedev-*`, `X-Forwarded-*`,
`Forwarded`, and `X-Real-IP` headers, plus Plow's session cookie. It sets
`X-Plow-User` to the authenticated owner's bare Plow user UID and
`X-Forwarded-For` to the request's client address when present. The UID is an
account identifier, not a phone number or a dashboard display name.
Each boot generates a gateway password in `OPENCLAW_GATEWAY_PASSWORD` for local
OpenClaw CLI calls. It is never written to `openclaw.json`. OpenClaw accepts
this password only on direct loopback requests without forwarded headers.
The runtime user's login and interactive shells load it from a private state
file, so `openclaw` commands work over SSH without entering a password. Anyone
with a shell on the VM already has full control of the agent.

This proxy is for local development only: anyone who can reach localhost:3001
can act as an admin of this agent. It rejects browser requests with a foreign
`Origin`; local clients can supply an allowed `Origin`.

For a local Plow API, use the CLI's `--api-base` option and mint with
`--agent-api-base` set to an address the container can reach, such as
`http://host.docker.internal:PORT`.

Then text the selected number as the owner. Your first message starts the
conversation; no setup greeting is sent before it. Check that a reply arrives.
`docker compose down` keeps the named state volume. `docker compose down -v`
deletes it, so the next boot starts with fresh agent state.

## Behaviour and failures

Set `PLOW_API_BASE` to the API root without `/v1`. Local runs also need
`PLOW_AGENT_TOKEN`; cloud hosts can inject it. Use an API endpoint you control.
Agent state lives in the persistent `/var/lib/plow` volume.
Boot diagnostics also appear in `/var/lib/plow/boot.log`, rotated at 256 KiB.

Set `AGENT_ID` to the Agent Index id to put this agent on
[the index](https://aiworthusing.com/agent-index): boot then registers the listing,
with `AGENT_NAME`, `AGENT_BLURB` and `AGENT_RUNTIME` (default `OpenClaw`) sent along when they are set, and reports its
token usage every five minutes. The counts come from agentsview, which this
image installs and which reads OpenClaw's own sessions; boot links them where
it looks, since this image moves OpenClaw's state off `~/.openclaw`, and each
pass refreshes the collector before reporting. The client is
[agent-index-client](https://github.com/plow-pbc/agent-index-client), pinned by
commit and checksum in the `Dockerfile` and fetched at build; its key and ledger live in the state
volume, so a rebuilt container keeps one install rather than registering a second.
Without `AGENT_ID` there is nothing to report for and nothing runs.
`openclaw.json` belongs to the owner. Changes made through the Control UI or
`openclaw config set` to other channels, model providers, plugins, agent defaults,
skills, and other owner settings survive restarts. Plow seeds defaults on a fresh
volume, then refreshes its own settings through `$include` files under
`/etc/plow/openclaw` at every boot. The Plow gateway, provider, MCP server (when
connected), channel, plugin entry and load path, tools, commands, main agent
identity, owner DM binding, session routing, visible-reply policy, and
cross-conversation memory policy are Plow-owned. OpenClaw refuses edits to
those included settings; edits made by hand beside an include are removed at
the next boot. Additional bindings survive.
An existing volume with a fully rendered config is converted on its next boot.
OpenClaw skips automatic legacy-key migration when a config uses `$include`, so
runtime upgrades must review and update both Plow's rendered settings and any
owner settings that use changed keys before starting the new version.
Workspace `BOOTSTRAP.md`, `SOUL.md`, `IDENTITY.md`, and `USER.md` are also boot-owned
and removed at every startup; `AGENTS.md` is boot-rendered.
Do not store durable agent state in these workspace files.

The gateway starts after one bounded identity lookup, even before the owner has a
chat. Identity lookup tolerates 401/403 for 120 seconds and retries network/429/5xx
failures ten times. Invalid identity or exhausted boot retries leave the
container running with a diagnostic error. The plugin subscribes before listing
chats, discovers the active owner DM from its roster, and buffers messages during
baseline recovery. Multiple owner DMs among the received listing and live chats
stop the chat account until the container restarts. A cached owner may be used
from a truncated listing; uniqueness is checked only among discovered chats.
Without a cached owner, the fallback lookup refuses truncated listings.
The API currently returns complete listings.
Socket drops reconnect with backoff; the plugin never re-reads identity.

Without a checkpoint, the earliest unanswered owner-DM message is first contact,
including texts sent before the plugin connects. Later unanswered texts run in order.
Chat checkpoints survive restarts. Chats omitted from a truncated listing
recover on their first live frame. Optional history failures still dispatch the
current message. Email threads have separate sessions, shared by their senders,
but no history backfill. The owner's phone DM uses the main session; other DMs
and groups have separate sessions.

Shutdown-interrupted chat turns can recover. Incomplete live turns are logged
and acknowledged. OpenClaw handles no-reply fallback delivery. An ambiguous
delivery is not retried; a crash after sending but before checkpointing can
duplicate a reply.

Replies stay in their source conversation. The agent can start trusted groups
with the owner and send follow-ups to active conversations on its own lines.
Clarifications are ordinary replies. When connected through Latch, the owner's
Mac provides its tools and instructions. Mac unavailability does not prevent
texting. Long-running MCP responses stream without a fixed bridge timeout;
client disconnects cancel the upstream request. A bridge crash restarts the
bridge while the gateway continues.

## Building a variant image

For a persona, prompt and skills, build a separate image on this base:

```dockerfile
FROM public.ecr.aws/e1h7x4a2/plow-cloud-agents:base-<sha>@sha256:<digest>

# Which agent this reports as on the Agent Index. A cloud install runs the
# image with no compose file, so this is the only place the id can come from,
# and without it nothing is reported and no page is claimed.
ENV AGENT_ID=your-agent-id

COPY prompt/AGENTS.md /opt/plow/prompt/AGENTS.md
COPY skills/ /opt/plow/skills/
```

Keep the inherited boot and reporter to use Plow's maintained reporting: it
registers the listing, reads OpenClaw's transcripts and reports every five
minutes. Rebuild on an updated base digest to pick up fixes.

If you need different startup behavior, fork this repository and maintain those
changes, including reporting. Free hosting requires working usage reporting
from the deployed image, whether it inherits this base or is a fork.

## Publishing

Published by CI in `plow-pbc/plow`
(`.github/workflows/build-agent-image.yml`), one immutable tag per commit:
`public.ecr.aws/e1h7x4a2/plow-cloud-agents:base-<full commit sha>`. There is no
`latest`, and the tag names the commit of this repository that built the
image. A variant lives in the registry its builder controls, pushed by
`plow-agents image push`. The tags that exist here are readable from the
registry itself:
<https://gallery.ecr.aws/e1h7x4a2/plow-cloud-agents>.

## Trust

Dashboard access relies on Plow's proxy admitting only the owner. Every
identity that reaches this gateway through that proxy receives admin access;
`GET /v1/agents/cloud/me` does not provide the owner's account UID for a narrower
gateway grant. The per-boot password lets the agent's own CLI use the gateway
over loopback; it does not authenticate requests carrying forwarded headers.
Any process on the same host, including the agent's shell, can forge
`X-Plow-User` over loopback. Keep direct gateway access limited to the host's
loopback interface.

This agent does not isolate hostile users. Every turn retains its tools; the
model judges authority from the fetched roster, trust flag, conversation and
owner instructions. Only trust people who may use the owner's resources,
including their Mac. Explicit sends can target other served conversations.

Groups use their own history and omit root MEMORY.md. Cross-conversation recall
is disabled, and native session tools cannot read unrelated conversations from
group or peer sessions. Shared files and tools are not privacy boundaries.

## Development

See [development checks and pinned source contracts](docs/development.md).
