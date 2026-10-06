# Base experience and builder contract

The base supplies delivery, routing, privacy gates, durable controls and maintained
instructions. Builders supply a role and domain workflows. Owners can change
public personality, private preferences and room settings without rebuilding.

For a first build, use [the tutor tutorial](first-agent.md). For a repeatable
development process, use [the builder SOPs](builder-sops.md). The
[manifest reference](agent-definition.md) lists field limits and precedence;
[the operations SOPs](operations-sops.md) provide deployment, backup, and recovery
procedures. This document describes the runtime and SDK contracts those guides use.

## Build a variant

Use the [coordinator](../examples/coordinator) or [tutor](../examples/tutor) starter.
Pass a released base digest, never a floating tag:

```sh
docker build --build-arg PLOW_BASE=REGISTRY/BASE@sha256:DIGEST \
  -t REGISTRY/my-agent:v1 examples/coordinator
plow-agents image push REGISTRY/my-agent:v1
```

`/opt/plow/agent.json` is a root-owned version 1 object. It supports `persona`
with role, purpose, voice, optional instructions, examples and sliders; `skills`
with absolute `/opt/` directories; `plugins` with id, path, tool names and an
explicit conversation-access boolean; `guestTools`; and defaults for `groupMode`
and `threadTrust`. Unknown fields, versions, duplicate plugin IDs, invalid paths
and writable plugin installations fail preflight. Manifest and installation
parents must also be root-owned, immutable and free of symlinks,
so the agent cannot replace a read-only file or directory through its parent.
Extra plugins must declare
their tools in `openclaw.plugin.json`. Images should install immutable code as
root and return to `USER node`.

Legacy plugin arrays remain supported. A legacy custom
`/opt/plow/prompt/AGENTS.md` is composed after maintained `BASE.md`. A manifest
persona takes precedence over that legacy personality file. The boot-rendered
workspace prompt is an output, not durable memory. Base instructions are capped
at 13,000 characters, builder personality at 6,000 and connected Mac instructions
at the remaining 20,000-character composition budget, up to 8,000.

`PLOW_GUEST_TOOLS` overrides the manifest guest list, including an explicit empty
value. `PLOW_THREAD_TRUST` overrides its trust default. Restarts refresh Plow-owned
includes while preserving owner model choices, explicit group-silence settings,
plugin disablement and other owner settings. Missing silence and image-model
defaults are seeded on existing volumes. Room settings override the image room
mode. Public owner personality overrides builder voice; private preferences apply
only in the owner's main phone DM. None of these settings grant permissions.

The two-agent roster uses explicit ownership. Plow routes its phone and email
conversations to `main`, selects `main` for system work and removes its old
legacy default marker during migration. Worker routing, its read-only tool policy
and concurrency limits are maintained image settings. Owner bindings for other
channels and more specific peers are preserved ahead of the default Plow binding.

## Owner and room controls

The owner can ask for settings in their main phone DM, or open
`/plugins/plow/personality` on their authenticated agent dashboard. The five
integer sliders use 0–100 with neutral 50. Preview does not save. Save persists
raw values separately from generated instructions; reset restores builder defaults.
The dashboard rejects stale revisions and foreign-origin writes. Independent
execution and candid language still obey current authorization and privacy.

| Tool | Scope and behavior |
| --- | --- |
| `plow_personality` | Owner main phone DM; get, preview, partial set, reset public voice |
| `plow_preferences` | Owner main phone DM; confirmed name, language, IANA timezone, private voice, verbosity, initiative, quiet hours and heartbeat frequency |
| `plow_room` | Current conversation; get, set, reset purpose and helper/coordinator/facilitator mode |
| `plow_memory` | Owner-private or current conversation; get, remember, correct, forget, export, reset with provenance and optional expiry |
| `plow_tasks` | Current conversation; durable commitments with goal, completion condition, deadline, evidence and native task lifecycle |
| `plow_notifications` | Current phone conversation or owner main DM for all; persist pause/resume and disable/re-enable eligible jobs |

Helper mode answers direct requests and relevant replies to active work.
Coordinator mode also collects requested responses and settles the shared plan.
Facilitator mode helps an explicitly invited discussion. All modes stay silent
during unrelated conversation and avoid autonomous exchanges with other bots.

Normal guests get only declared guest tools. An empty guest list means replies
only. Full group trust gives every member tools that can reach the owner's Mac,
mail and files. Trust changes, new groups and cross-conversation follow-ups retain
their runtime gates. Tools re-fetch active membership and use SDK context version
2 invalidation checks before effects. Pasted approvals cannot confer authority.

## Memory, tasks and notifications

Experience files live at `/var/lib/plow/experience/<sha256>.json`, keyed by API,
phone line and owner, agent or conversation scope. They are versioned, mode 0600,
written atomically and serialized within the gateway. Unreadable state produces
an error, never an automatic reset. Group context includes only its own notes and
public voice. Owner preferences and notes are injected only into the owner DM.
Native sessions and task flows remain in OpenClaw's durable SQLite stores.

Memory changes require `expectedRevision` from a current get/export receipt.
Every change advances the revision, so work based on notes from before a forget
or reset cannot write them back. Notes record sender provenance, timestamps,
confirmed/tentative status and optional expiry. Export covers this scoped store.
Forget/reset removes its facts from subsequent prompt injection; it does not
erase historical transcripts or separately created files/indexes, and it does not
cancel tasks. Remove those artifacts separately when requested. The base does
not build another memory index.

Tasks use native managed flows bound to the current session. They distinguish
queued, running, waiting, succeeded, failed and cancelled states; evidence records
confirmed, failed or unknown delivery. A completion condition is required at
creation. Finish requires evidence and rejects unknown/failed delivery. The model
must supply actual tool/provider receipts; a free-text evidence field is not an
independent verifier of a booking or other external action. Builders should
validate their domain receipts before finishing. Task records do not schedule a
wakeup: use native `automations` for explicitly requested future work.

Pause persists the delivery gate first, then disables jobs in the authorized
scope with native scheduler revisions and cancels matching active native runs. A second
gate at physical cron delivery suppresses output already generating when pause
was persisted. It uses the pinned runtime's versioned cron intent prefix, covered
by the real gateway acceptance test.
Partial failures keep the gate active and report the incomplete stop. A disable
intent is journaled before the scheduler mutation, so a lost response or revoked
invocation cannot strand an unrecorded disabled job. Recovery compares the
unchanged public job definition and uses the scheduler's current revision for
the final update. Confirmed journal entries require their exact recorded revision;
edited/deleted jobs remain as the owner left them. New automations are blocked
while paused. Overlapping source-room, destination-room and global pauses transfer
the journal to a remaining paused scope; only the last resume enables the job.
Resume opens its requested gate before scheduler effects and retains unconfirmed
journal entries. This lets an accepted one-shot enable deliver even if its response
is lost. An open gate does not prove every job was restored. Both the tool and
physical delivery guards check the source room, destination room and global pause;
phone groups receive that effective status without private owner state.
An already confirmed external send cannot be withdrawn.
Cancel tasks and their associated automations separately when ending a workflow.

Quiet hours use IANA timezones including DST. Optional heartbeat delivery also
uses a persisted minimum interval, 30 minutes by default. Explicitly timed
reminders follow their requested schedule. Optional monitoring should notify only
on a meaningful change, completion, failure or required input.

## Conversational coordinator and workers

The conversational agent owns user messages, personality, approvals, private state
and mutations. Long read-only analysis or public research can use the native
`plow-worker` background agent. Its separate workspace receives a bounded
assignment with relevant non-secret context, constraints and a completion condition.
It does not inherit the conversation automatically. The base worker's native tool
allowlist contains only `web_search` and `web_fetch`; an execution-time guard also
blocks messages, account mutations, files, memory, schedules and further workers.
Web research still requires a configured provider. Analysis of supplied facts
works without that optional connection.

Native task acceptance means started. The coordinator remains available for status
and corrections while the worker runs. Native controls list and cancel a listed
task ID only within its owned subtree. When requirements change, settle cancellation
before creating a replacement. Worker results return through the coordinator,
which checks status and evidence and sends one useful response. The worker prompt
requests a JSON result with completed/needs_input/failed status, summary and up to
four sources or facts. This is a result-format instruction, not an independent
proof of an external outcome. Native task state supplies the lifecycle receipt.
Domain workers requiring account mutations need a separately reviewed extension
with its own capability and receipt validation.

The real gateway acceptance harness holds a worker's model request open, checks a
new owner message is answered, releases the result through the coordinator, then
cancels a second worker and observes its request abort. This verifies responsiveness,
source routing and cancellation without contacting a person.

## Channel and delivery contract

Phone replies stay in the source DM/group. Email uses the agent's mailbox and
`plow_send_email`; email final summaries go to the authorized origin phone chat
or private owner DM. Mail has no history backfill. The owner's personal accounts
must use their connected tools, with clear attribution rather than the agent's
mailbox identity. Owner resources remain unavailable when the Mac is disconnected.

Inbound phone images support JPEG, PNG, GIF and WebP, at most four attachments and
8 MiB each. Download is bounded to 15 seconds and refuses redirects. Native image
understanding uses the configured image model, initially Sonnet, while GLM remains
the text default. Image processing has a 45-second limit. Audio/video interpretation
and inbound email attachments are unsupported; ask for relevant text or a still
image and never invent attachment contents. Outbound attachments follow native
media handling. Phone DMs use typing indicators that stop on completion;
groups use explicit progress replies for long work and do not emit typing while
the model decides whether to participate.

History recovery pages to the actual checkpoint, including backlogs beyond the
512-UID retained window. Adoption acknowledges processing ownership, not action
success. Phone finals use native durable delivery. Intentional `NO_REPLY` and
successful tool receipts with `details.silent=true` suppress automatic finals;
explicit authorized sends can still happen. Delivery timeout is an unknown outcome,
not a failed send to retry. Later Plow mutations/finals in that run are fenced.
Ordinary provider sends have no idempotency key, so the contract does not promise
exactly-once external delivery. Thread creation uses a stable source/payload key.

## Native extension APIs

Use the pinned SDK with `api.registerTool({ contextVersion: 2, create(ctx) { ... } })`.
Call `ctx.assertInvocationCurrent()` after awaited preparation and immediately
before effects. Resolve authorization from this live context and refreshed Plow
roster, not model arguments. Builders own authorization for their workflow.

`/opt/plow/plugin/dist/threads.js` exports `startThread(account, ctx, callId, args)`.
It returns `{chat_uid, message_sent:true}` after the owner-DM and configured trust
gates. `/opt/plow/plugin/dist/index.js` exports
`sendText(cfg, destination, text, channelRuntime)`, returning `{messageId}` only
after durable confirmation. It checks the served destination; the caller must
authorize that destination. Ambiguity throws `DeliveryUnknownError`.

For scheduling, use native `automations` or the authenticated loopback scheduler
after your Plow scope gate. Native task APIs persist flows, revisions and lifecycle.
An external plugin cannot call the upstream bundled-plugin-only gateway runtime.
A `before_dispatch` handler that durably takes over a source must call
`acknowledgePluginHandoff(line, chat, message)` after its journal write. That
acknowledges responsibility, not external completion.

## Operations and release evidence

Docker health checks `/readyz` without taking a config lock. A parked boot is
unhealthy. `boot.log` is rotated and contains connection/task/delivery diagnostics;
experience logs contain tool and scope metadata rather than private note bodies.
Gateway logs can contain sender identifiers, so restrict access to the state volume.

Stop the container before backing up **all** of `/var/lib/plow`, including
experience, native databases, sessions, cron, delivery queues, checkpoints, email
origins and `.agent-index`. Restore with the runtime user's ownership into an
empty volume and boot the same or a compatible newer image. Test restoration on
an isolated line. Do not open a newer database with an older runtime. A rollback
requires the complete pre-upgrade backup and its matching image digest.

Run the checks in [development.md](development.md), including real gateway
acceptance, before release. Live model dialogues test both configured models with
synthetic facts and no human sends. Review their outputs for tone and truthful
claims. Production acceptance additionally needs owner/normal-group/trusted-group,
email, a requested reminder and disconnected/reconnected Mac checks on an isolated
line. Fixture tests cannot prove a particular provider installation is connected.

Release targets are zero unauthorized effects, duplicate fixture sends, leaked
silence markers or missed recovered sources; all deterministic checks pass; all
dialogue assertions pass and human review finds no material false claim. Record
model latency p50/p95 and estimated token cost; use p95 under 30 seconds as the
initial dialogue target, investigate regressions over 20%, and keep meaningful
optional notifications under the owner's configured frequency. A fixture/model
report labels its evidence and never claims a live phone acceptance it did not run.

With `AGENT_ID`, the existing pinned Agent Index client registers and reports every
five minutes. Its native SQLite reader supports current OpenClaw sessions and
deduplicates usage against collector results. Keep the key and ledger in the state
volume. Public image promotion and removal of an Index WIP tag are separate
publication/admin steps, described by [Plow](https://aiworthusing.com/agent-index/publish).

The slider IDs and range follow [Vellum's constants](https://github.com/vellum-ai/vellum-assistant/blob/56dfa96fd56d5e0e153a380be2b3bd7a353f0523/assistant/src/api/constants/personality-sliders.ts).
This base uses deterministic prompt guidance for GLM and Sonnet. Scoped task
records and revisions follow the inspectable-work pattern in
[OpenInstinct](https://github.com/Merit-Systems/OpenInstinct/blob/0c2a7c6e842fa7105cee004b2d6ac1d5f1c7c1e8/shared/workstreams/schema.ts).
