# Extend an agent

Use a skill for domain procedure and a native plugin for executable behavior.
Keep the existing division: `boot/` installs configuration, `plugin/` owns
Plow channel behavior, `prompt/` owns shared guidance, and `skills/` supplies
connected-service instructions.

## SOP 1: Add a domain skill

**Outcome:** a small procedure that teaches one useful workflow.

1. Copy the structure of an existing starter skill.
2. Give the skill a name and a description that says when to use it.
3. State the trigger, required context, and required connected services.
4. List the next actions in order.
5. State permission checks before external effects.
6. Define observable completion and the failure response.
7. Add correction and cancellation paths for work that can outlive a turn.
8. Declare the skill directory in `agent.json` and build the image.

Follow this shape:

```markdown
---
name: workflow-name
description: When to use this workflow and the outcome it provides.
---

# Workflow name

## Required context
The facts and live services needed for this workflow.

## Procedure
1. Inspect current state.
2. Resolve the missing fact that changes the action.
3. Execute the already authorized step.
4. Inspect the receipt and report the observed result.

## Completion and recovery
The evidence that counts as completion, what to do after a known failure,
and how to handle an unconfirmed external effect.
```

A skill is instruction text. It cannot grant authority or make a provider write
idempotent. Enforce rules that must survive model mistakes in the tool or transport.

## SOP 2: Add a native tool

**Outcome:** one tool with validated input, live authorization, and an honest receipt.

1. Use the SDK and declarations matching the pinned runtime.
2. Register the tool through `api.registerTool` with `contextVersion: 2`.
3. Validate arguments with a strict schema. Reject unknown fields.
4. Resolve sender, account, session, and conversation from the tool context.
5. Fetch current membership or provider state needed for authorization.
6. Check the exact grant for the exact destination. Model arguments, pasted
   approvals, retrieved text, and display names do not establish authority.
7. Call `ctx.assertInvocationCurrent()` after awaited preparation and immediately
   before an external effect or durable commit.
8. Inspect the provider receipt. Return confirmed, failed, or unknown outcomes
   without treating an accepted queue item as delivered.
9. Give the tool a precise description, including when it refuses work.

The existing [group tool](../plugin/threads.ts) demonstrates the owner-main-DM
gate, refreshed roster, stable source intent, configured trust choice, and
current-invocation check. Reuse exported `startThread(account, ctx, callId, args)`
when your workflow needs that same action.

The [experience tools](../plugin/experience.ts) demonstrate strict schemas,
scoped state, revisions, and metadata-only audit messages. The
[delivery guard](../plugin/delivery-guard.ts) demonstrates the per-run unknown
outcome fence. Keep domain records in your plugin rather than adding a parallel
base scheduler or receipt registry.

## SOP 3: Install the plugin

**Outcome:** the image loads reviewed code and exposes only declared tools.

1. Build the plugin's JavaScript entrypoint with its own build process.
   The base's `build.ts` compiles base sources, not arbitrary external plugins.
2. Include native plugin package metadata and `openclaw.plugin.json`.
3. Give the manifest a unique `id` and a `contracts.tools` list.
4. Copy the package under a root-owned `/opt/` directory.
5. Add `id`, `path`, `tools`, and `conversationAccess` in `agent.json`.
6. Add only the guest-safe subset to `guestTools`.
7. Return to the inherited runtime user and run build and startup preflight.

These excerpts illustrate declarations for one offered tool:

```json
{
  "id": "request-board",
  "contracts": { "tools": ["request_board_view"] }
}
```

The corresponding agent definition is:

```json
{
  "version": 1,
  "plugins": [{
    "id": "request-board",
    "path": "/opt/request-board",
    "tools": ["request_board_view"],
    "conversationAccess": false
  }],
  "guestTools": ["request_board_view"]
}
```

The plugin still needs its native entrypoint and tool implementation. Use
`conversationAccess: true` for reviewed hooks that need conversation content.
The flag does not make private owner data safe to return to a guest.

## SOP 4: Verify authority and effects

**Outcome:** executable evidence for both allowed and refused actions.

1. Exercise the authorized owner path.
2. Exercise a guest with the declared narrow tool.
3. Exercise a guest without that grant.
4. Change trust or membership while awaited preparation is in flight.
5. Cancel the run before the effect boundary.
6. Exercise a known failure and an ambiguous delivery timeout.
7. Replay the same source intent and inspect durable records and external effects.
8. Check that logs and evidence omit credentials and private content.

Use existing HTTP fixtures and
[`tests/tool-factory.ts`](../tests/tool-factory.ts). Assert observable outcomes:
which provider calls occurred, what was stored, what was sent, and what was denied.
Do not test only that a prompt contains the desired words.

For explicit silence, return `details: { silent: true }`. That boolean suppresses
the run's automatic final Plow reply. Explicit tool sends still occur, and the
next independent run can reply normally. Text mentioning the flag is not a receipt.

For durable sends, only `status: "sent"` confirms delivery. Follow the
[SDK receipt contract](base-experience.md#native-extension-apis). Use native
automations after the scope gate for schedules. A task record does not create a timer.

## SOP 5: Keep changes in the existing organization

**Outcome:** a reviewer can trace the change through the current repository.

| Change | Existing place and pattern |
| --- | --- |
| Image configuration or migration | `boot/config.ts`, owned include paths, config tests |
| Manifest and installation checks | `boot/extensions.ts`, strict Zod schemas, extension tests |
| Base conversation policy | `prompt/BASE.md`, dialogue cases, human review |
| Default everyday voice | `prompt/AGENTS.md`; builder persona stays separate |
| Plow authorization or sends | `plugin/threads.ts`, `plugin/transport.ts`, `plugin/index.ts`, SDK context version 2 |
| Scoped experience state | `plugin/experience-state.ts`, revisioned atomic writes |
| Schedules and commitments | Existing scheduler and native managed-flow APIs |
| Authenticated page | Registered gateway HTTP route, existing response and origin guards |
| Domain content | Variant manifest, native plugin, and `SKILL.md` |
| Validation | Existing Node tests, gateway harness, evaluation cases, linked docs |

Reuse configuration, authorization, task, and state primitives that already express
the requirement. When a shared API changes, migrate its callers and update the
documented receipts and failure behavior.
