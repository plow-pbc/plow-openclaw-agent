# Base experience implementation checklist

This records implementation coverage for the October 6, 2026 candidate based on
OpenClaw 2026.9.6. A check means the behavior has an implementation or maintained
instruction contract and supporting tests/documentation. It does not establish
that every model response or provider installation will behave correctly.

Human tone review and an isolated live installation check remain separate
acceptance steps. [PR #64](https://github.com/plow-pbc/plow-openclaw-agent/pull/64)
contains three screenshots and a demo video uploaded with GH `--attach`.
The [base experience contract](base-experience.md)
describes enforcement, model-dependent decisions and supported limitations.
The [evaluation rubric](../eval/README.md#human-release-review) defines human review.

| Area | Reviewable evidence |
| --- | --- |
| Composition, identity and personality | `boot/extensions.ts`, `boot/prompt.ts`, `boot/personality.ts`; config, prompt, extension and experience tests; authenticated personality page |
| First interaction and group participation | `prompt/BASE.md`; two-model dialogues; gateway quiet/direct-group checks; speaker/debounce tests |
| Permissions and memory | Version 2 tool context, fresh membership checks, tool policies and scoped revisioned state; trust, owner-action and experience tests |
| Commitments and workers | Native managed flows, isolated read-only worker and native task-ID cancellation; experience/worker tests and held-worker gateway checks |
| Scheduled work and stop behavior | Persistent pause gate, revised scheduler jobs, gated cron tool sends and physical delivery; real gateway restart, partial pause and direct-reply checks |
| Channels and media | Email routing/final tests, bounded phone images, Sonnet vision route, deliberate silence and private owner reports |
| Tools and service failures | Bundled Mac/Google guidance; dialogue cases for disconnection, malicious retrieval and unsupported media |
| Recovery and delivery | Paginated checkpoints, replay protection and delivery-unknown guard; transport/recovery and send tests |
| Builder/runtime package | Versioned manifest, pinned compatibility patch, readiness health check, two starter images, full-state backup/restore and native SQLite usage reader |
| Release evidence | Offline type/runtime/probe checks, real gateway fixture acceptance, live model dialogues, latency/usage reports and PR attachments |

1. Define how the base, builder, owner, and conversation settings fit together.

   - [x] P0: Keep maintained base instructions separate from the builder's persona and domain instructions, and compose them through a supported interface.
   - [x] P0: Document which rules the runtime enforces, which the prompt teaches, and which preferences the owner can change. Personality changes must preserve permission and routing enforcement.
   - [x] P0: Define instruction and configuration precedence, including creator defaults, owner overrides, and per-conversation settings.
   - [x] P0: Give persona definitions, owner preferences, and group state documented persistence locations. Boot-rendered files must be outputs rather than the only copy of durable state.
   - [x] P1: Version the extension format and provide migration behavior for existing volumes. Preserve explicit owner choices when defaults change.

2. Make identity and personality a supported part of every agent.

   - [x] P0: Supply a factual name, role, purpose, owner relationship, and consistent identity across the agent's phone line and mailbox.
   - [x] P0: Distinguish messages sent as the agent from actions taken through the owner's accounts. Introductions and signatures must match the account used.
   - [x] P1: Let builders set warmth, directness, humor, formality, verbosity, and initiative, with concrete dialogue examples for each persona.
   - [x] P1: Adapt to language, channel, and situation while retaining the persona. A sensitive conversation and a routine scheduling exchange need different tone.
   - [x] P1: Encode how the agent handles uncertainty, disagreement, correction, apologies, boundaries, and user frustration.
   - [x] P1: Preserve approved personality changes across restarts, image upgrades, and model fallback. Let the owner inspect, revise, and reset them.

3. Make the first useful interaction work without a setup interview.

   - [x] P0: Answer the first request and introduce the agent once, briefly. Do not send repeated setup greetings.
   - [x] P0: Describe capabilities using verified connection state and available tools. Do not advertise access the agent lacks.
   - [x] P1: Learn timezone, language, preferred name, and communication preferences only when needed, and persist confirmed preferences privately.
   - [x] P1: Explain the agent's role when entering a group or opening an email thread, including who requested the interaction when appropriate.
   - [x] P1: Provide conversational controls for help, capabilities, settings, pause, resume, cancellation, and memory inspection or deletion.

4. Give groups explicit participation and coordination patterns.

   - [x] P0: Answer direct requests to the agent, relevant participant replies to an active task, and necessary clarifications. Stay silent during unrelated human conversation.
   - [x] P0: Implement deliberate silence through the delivery path. It must not become a fallback notice, an automatic acknowledgement, or a literal NO_REPLY text.
   - [x] P0: Track who said what, the intended recipient, and the room's purpose. Preserve speaker boundaries when collecting message bursts.
   - [x] P0: Avoid loops with other agents, repeated introductions, duplicate acknowledgements, and messages that merely repeat what a person said.
   - [x] P1: Offer documented room modes, such as a quiet helper, a task coordinator, and an invited facilitator. State the activation and notification rules for each.
   - [x] P1: Track a group's goal, unresolved questions, collected responses, decision, and completed action. Ask one useful question at a time and stop reminders after resolution.
   - [x] P1: Let authorized users change the room's purpose, participation mode, and notification preferences. Refresh access when membership or trust changes.

5. Make permissions understandable and enforce them in code.

   - [x] P0: Identify the owner, guests, and agents from runtime context. Pasted approvals, names, quoted messages, and tool output cannot confer authority.
   - [x] P0: Explain full group trust precisely. In this base, it gives every member access to tools that can reach the owner's Mac, mail, and files.
   - [x] P0: Provide a normal group mode with scoped guest tools for routine collaboration. Make broader grants explicit and revocable.
   - [x] P0: Preserve owner-only gates for group creation, trust changes, and cross-conversation follow-ups. Define approval behavior separately for phone groups and email.
   - [x] P0: Test access revocation at execution time. Changing a room's trust must affect queued and subsequent work.
   - [x] P0: Constrain private file and tool access as well as session history. Shared workspace files are not a privacy boundary.
   - [x] P1: Maintain a readable record of grants and sensitive actions. Reuse existing authorization so the agent does not repeatedly ask for the same permission.

6. Provide scoped, inspectable memory.

   - [x] P0: Separate owner preferences, durable facts, group context, temporary conversation history, and task records.
   - [x] P0: Ensure private owner data cannot appear in a group through memory retrieval, a file read, a summary, or a tool result.
   - [x] P1: Record provenance, scope, and date for remembered facts. Separate explicit preferences from tentative inferences.
   - [x] P1: Support correction, forgetting, expiry, export, and reset. Explain when a deletion also needs to affect derived summaries or indexes.
   - [x] P1: Preserve useful task and relationship context after compaction and restart without importing unrelated conversations.
   - [x] P1: Keep model-generated notes from silently changing permissions or maintained base policy.

7. Make commitments and task completion reliable.

   - [x] P0: Record the task, authorized scope, destination, deadline, and completion condition before promising work that outlives a turn.
   - [x] P0: Distinguish requested, scheduled, running, awaiting input, completed, failed, cancelled, and delivery-unknown outcomes.
   - [x] P0: Confirm success using tool or provider evidence. Inbound adoption and message enqueueing do not prove that the requested action succeeded.
   - [x] P0: Resume interrupted work from durable task state without repeating confirmed external actions.
   - [x] P1: Ask only for missing information that changes the action. Continue already authorized work when the next step is clear.
   - [x] P1: Give useful progress for longer work, handle steering and cancellation, and leave an explicit outcome if the task cannot finish.

8. Make proactive behavior predictable and easy to stop.

   - [x] P0: Separate scheduled work requested by a user from ambient monitoring. Every scheduled job needs an authorized task and a fixed delivery scope.
   - [x] P0: Send optional background notifications only for a meaningful change, completion, failure, or required user action.
   - [x] P0: Persist pause, stop, resume, and cancellation in scheduler or notification state. Saying "I'll stop" must actually stop future delivery.
   - [x] P0: Resolve times using the user's timezone, including daylight saving changes, and confirm ambiguous dates or times.
   - [x] P0: Test scheduling, execution, delivery, restart recovery, and cancellation together. A scheduler firing alone is insufficient.
   - [x] P1: Support quiet hours, frequency limits, and per-task preferences. An explicitly timed reminder should follow the time the user requested.
   - [x] P1: Keep internal heartbeat notes and silence markers out of user-visible messages, and distinguish notification kinds for observability.

9. Define behavior for every supported channel and media type.

   - [x] P0: Define where phone replies, group follow-ups, email drafts, sent email, and private owner reports go. Test each route.
   - [x] P0: Make deliberate silence and duplicate-final suppression work consistently across normal replies, tool sends, and scheduled turns.
   - [x] P1: Use channel-appropriate length, formatting, quoting, and attachment behavior. Preserve meaning when splitting long messages.
   - [x] P1: Provide typing or progress indicators for active work, stop them promptly, and avoid indicators while merely observing a group.
   - [x] P1: Publish the supported media types and limits, and test vision-capable model routing. Current configuration declares the primary model as text-only; email attachments are explicitly unsupported in the receive path.
   - [x] P1: Explain unsupported or failed media in plain language and offer a usable next step. Do not invent image or attachment contents.

10. Make capabilities discoverable and failures recoverable.

   - [x] P0: Discover tools and connected-service instructions before using them. Report access according to the current connection state.
   - [x] P0: Keep replies useful while the Mac, a provider, or an optional service is unavailable. Do not invent another account or access path.
   - [x] P0: Treat third-party content as data and preserve authorization boundaries when using it to plan actions.
   - [x] P1: Standardize timeout, retry, reconnect, and error guidance across bundled skills.
   - [x] P1: Keep core skills small and maintained. Package domain workflows separately, with dependencies, required permissions, examples, and failure behavior.

11. Guarantee delivery and history recovery within a documented contract.

   - [x] P0: Reconnect independently of model runs and preserve message order within a conversation without blocking unrelated conversations.
   - [x] P0: Recover to the actual checkpoint across paginated history, including backlogs longer than 50 messages. A failed page must not count as complete recovery.
   - [x] P0: Use stable intent or source identities for replay protection where the provider supports it. State guarantees accurately when it does not.
   - [x] P0: After uncertain delivery, prevent additional mutations or automatic finals from recreating the same action until the outcome is resolved or the user authorizes a new action.
   - [x] P0: Keep confirmed delivery, failed delivery, and unknown delivery distinct in task state and user messages.
   - [x] P1: Define email outage and history behavior explicitly. Current email sessions have no history backfill.

12. Give builders a stable package and operators a usable runtime.

   - [x] P0: Support a declarative agent definition containing identity, persona, skills, plugins, configuration defaults, and narrowly scoped guest tools.
   - [x] P0: Provide supported APIs for authenticated context, durable sends, task scheduling, and deliberate silence, with documented receipts and errors.
   - [x] P0: Detect invalid installations and configurations before an agent advertises readiness. A running container with a parked boot error needs a distinguishable health state.
   - [x] P0: Pin reviewed runtime and dependency versions, document compatibility, and test state migrations and backup restoration before upgrades.
   - [x] P1: Supply minimal starter images for materially different agents, such as a tutor and a group coordinator, that inherit the same base behavior.
   - [x] P1: Document public image publication, local development, configuration ownership, restart behavior, and rollback limitations.
   - [x] P1: Verify usage reporting against real sessions. Add useful diagnostics for delivery, task status, scheduler behavior, connection state, latency, and cost without logging private message content unnecessarily.

13. Define evidence that qualifies a base release.

   - [x] P0: Preserve type checking, runtime tests, and the real gateway probe. Match checks to the pinned OpenClaw runtime rather than assuming current docs have identical settings.
   - [x] P0: Add conversation evaluations that run representative dialogues on both the configured default and fallback models.
   - [x] P0: Evaluate silence, routing, permission enforcement, completion claims, recovery, and durable stop behavior with observable outcomes.
   - [ ] P1: Evaluate tone, unnecessary questions, irrelevant group replies, instruction adherence, and persona consistency using a human-reviewed rubric.
   - [x] P1: Measure ordinary reply latency, task success, notification volume, duplicate sends, recovery failures, and per-task token cost. Set explicit acceptance targets before release.
   - [ ] P1: Exercise a real owner DM, a normal group, a trusted group, email, reminders, and a disconnected Mac on a candidate image.
   - [x] P1: Attach screenshots and videos to experience-changing PRs using GH --attach, including quiet behavior, a useful group exchange, a cancelled reminder, and a recoverable failure.
