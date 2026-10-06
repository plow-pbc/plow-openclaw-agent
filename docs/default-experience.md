# The prebuilt experience

The fresh base is an everyday assistant that answers useful requests and leaves
room for people to talk. A builder can specialize that role without recreating
the transport, permission gates, memory controls, or reporter.

These defaults apply when no owner choice or builder override already exists.
Restart preserves explicit owner settings where the configuration contract allows
them. [The manifest reference](agent-definition.md#precedence-and-ownership) explains
the precedence rules.

## A useful first conversation

The [default persona](../prompt/AGENTS.md) gives the assistant a practical role,
a warm and direct voice, and examples for clarification, correction, group silence,
and failed delivery. The [maintained base](../prompt/BASE.md) supplies the shared
conversation and permission guidance.

The agent answers the first useful request before requesting a profile.
Timezone, language, and preferred name are learned when those facts affect the
task and the person confirms them. This avoids a setup interview that delays
the reason someone contacted the agent.

For example, "Help me plan dinner" can start with the plan. A scheduled reminder
may require a timezone and an exact time. The agent asks for the missing detail
when it changes the action.

## Quiet groups and explicit authority

New rooms start in helper mode. A helper answers direct requests and relevant
replies to its active work. Unrelated human exchanges can end in deliberate
silence. The delivery path consumes that decision without a fallback text or a
literal `NO_REPLY`; group turns also avoid typing indicators before participation
has been decided.

Coordinator mode tracks a shared goal and the next missing answer. Facilitator
mode supports an invited discussion. These modes provide model guidance. They
do not create permission grants or guarantee a model will judge every turn well.

The default trust policy is `ask`: when the agent creates a group, it asks the
owner whether the group is normal or fully trusted. A normal group has no guest
tools unless the builder declares them. A trusted group gives every member access
to tools that can reach the owner's resources. Trust is a separate, consequential
choice from asking the agent to coordinate a plan.

## Private preferences and public style

Private owner preferences enter only the owner's main phone DM. Public personality
is the agent's style across conversations. Room purpose and notes stay in their
own scope.

The five sliders start at neutral 50 when the builder supplies no positions.
The default persona still supplies a useful voice. A neutral slider means no
additional directional instruction, rather than an absence of personality.
Preview shows proposed guidance without saving. Save survives restart.
Reset removes the override and returns to the builder persona.

Personality cannot grant account access, widen room trust, or turn unconfirmed
delivery into completion. This separation lets an owner ask for a warmer or more
direct agent without changing who may act.

## Durable work with a responsive conversation

The main agent owns conversation, authorization, messages, and mutations.
Long read-only research can run in the native `plow-worker` agent while main
remains available for a correction or cancellation. The worker has a separate
workspace, public research tools, and an execution guard.

The base allows at most two concurrent workers, two children per agent, and one
spawn depth. Workers cannot create further workers, read private memory, message
people, schedule jobs, or mutate accounts. Native cancellation uses a task ID.
The coordinator checks the result and returns one useful completion to the source
conversation.

A task record stores a commitment and its completion condition. The record does
not schedule a wakeup. A requested reminder also needs a native automation.
Completion evidence still requires the model to assess the actual receipt
truthfully; a valid record alone cannot prove the requested work happened.

## Notifications that can be stopped

Pause is persisted before the base changes scheduler jobs. Scheduled physical
delivery checks that gate, including when a reminder is already generating.
Direct answers remain available while scheduled notifications are paused.
Resume restores only unchanged jobs that this control suspended.

Optional heartbeats use a 30-minute minimum interval unless the owner changes it.
Quiet hours apply to optional heartbeats. An explicitly timed reminder retains
its requested timing unless it is paused or cancelled. The base does not require
an owner to receive unsolicited monitoring.

Cancel a task, cancel its scheduled job, and forget its notes as separate actions.
Each action changes a different durable record.

## Model, media, and service behavior

Text uses GLM 5.2 with Sonnet 5 as fallback. Still images use Sonnet image
understanding. Phone image intake accepts JPEG, PNG, GIF, and WebP, up to four
images and 8 MiB per image. Audio, video, and incoming email attachments require
relevant text or a supported still image.

The Mac connection is optional for texting. When it is unavailable, the agent
names the missing service and offers a usable next step. It does not invent
another account or pretend that an action succeeded.

Transport reconnects independently of model runs and recovers paginated history
to its checkpoint. Adoption means the runtime took responsibility for a source;
it does not prove successful delivery. An uncertain external send blocks later
Plow mutations and automatic finals in that run. Ordinary provider messages lack
an idempotency key, so the base does not promise exactly-once delivery.

## What builders keep and what they change

Keep the inherited boot, permission boundaries, state volume, pinned runtime,
and reporter. Change the persona, domain skill, narrow guest tools, and room
defaults through the supported manifest.

Follow [the builder SOPs](builder-sops.md) for quality checks. The
[base contract](base-experience.md) distinguishes code-enforced behavior from
model-dependent instruction contracts. A strong prebuilt default still needs
human review and live acceptance when a builder adds a new domain or provider.
