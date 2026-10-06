# Agent builder SOPs

Use these standard operating procedures to take a variant from a concrete purpose
to a reviewable release. Keep the resulting brief, scenario results, and release
record with your agent repository. The [first-agent tutorial](first-agent.md)
provides the local commands.

## SOP 1: Define the agent's job

**Outcome:** a short brief that a builder and reviewer can use to judge scope.

1. Write one sentence describing the person served and the outcome achieved.
2. List three representative requests the agent must handle.
3. State the completion evidence for each request.
4. Identify which requests need an owner's account or an external mutation.
5. Choose the conversations where the agent can work: owner DM, normal group,
   trusted group, email, or a defined subset.
6. Describe the first useful interaction without a setup interview.
7. List unsupported requests and the useful next step offered for each.

Use this brief template:

```text
Role:
Person served:
Useful outcome:
First useful request:
Three supported requests:
Observable completion evidence:
Required connected services:
External actions and required authority:
Normal-group guest tools:
Private data and its scope:
Unsupported requests and next steps:
Release owner:
```

For a coordinator, "help people choose a dinner time" is a bounded purpose.
"Handle everything for the group" does not identify completion or authority.
Record a confirmed decision separately from a reminder or a message that still
needs delivery.

## SOP 2: Select the inherited behavior

**Outcome:** an explicit configuration with no unexplained broad permissions.

1. Read [the prebuilt experience](default-experience.md).
2. Start with the tutor or coordinator manifest, or omit a persona to use the
   inherited everyday assistant.
3. Choose a room mode from the user's task. Use helper for occasional requests,
   coordinator for a shared goal, or facilitator for an invited discussion.
4. Choose the trust policy separately. Use normal groups for narrow collaboration.
   Select full trust only when every participant may access owner resources.
5. List the exact guest tools needed. Leave the list empty if guests need only
   conversation.
6. Set persona role, purpose, voice, and concrete examples.
7. Keep runtime permissions, routing, and completion evidence out of style controls.

Include examples for a first request, an unrelated group exchange, a correction,
an unavailable service, a permission refusal, and an uncertain external action.
Explain a slider choice through the desired dialogue. A number alone does not
explain how the agent should behave.

**Exit check:** a reviewer can predict when the agent replies, stays quiet,
asks a question, or requires owner authorization.

## SOP 3: Package one workflow at a time

**Outcome:** an image that inherits the base and installs reviewed domain content.

Keep the variant in its own repository before release. The tutorial's `work/`
copy is ignored scratch space in this base repository. Move your customized
manifest, Dockerfile, skills, and ignore file into an agent repository and add its
license. Use MIT licensing for an Agent Index hackathon submission.

1. Pin a released base digest in the variant's `FROM` reference.
   In a copied starter, set `ARG PLOW_BASE=REGISTRY/BASE@sha256:DIGEST` or replace
   `FROM ${PLOW_BASE}` with the full digest reference. The tutorial's local tag
   is for development. A CLI image build has no `--build-arg` option, so the
   Dockerfile needs a usable default before publication.
2. Write the version 1 manifest using [the reference](agent-definition.md).
3. Put procedural domain guidance in a `SKILL.md`, following the existing
   [coordinator skill](../examples/coordinator/skills/group-planning/SKILL.md)
   or [tutor skill](../examples/tutor/skills/guided-practice/SKILL.md).
4. Add a native plugin only when a workflow needs executable state, a provider
   operation, or a tool receipt. Follow [the extension SOP](extension-sop.md).
5. Copy code, manifest, and skills as root under `/opt/`.
6. Return to `USER node`. Retain the inherited boot, persistent state, and reporter.
7. Build locally and inspect the first failed step if preflight or compilation fails.
8. Keep each workflow change in a focused PR with its behavior, authority, and
   observable verification.

Do not duplicate the maintained base prompt in every variant. Do not place secrets
in an image layer. Store runtime credentials outside the build context and use
the deployment's credential injection.

**Exit check:** the image builds, installation is immutable, declared tool names
match the plugin manifest, and the Dockerfile still runs the inherited boot.

## SOP 4: Verify the experience

**Outcome:** evidence for runtime correctness, conversation quality, and a real install.

1. Run the deterministic suite and offline probe in [development](development.md).
2. Run the gateway acceptance harness against the pinned runtime.
3. Run synthetic dialogues on the default and fallback models with a dedicated
   test credential.
4. Review outputs using [the human rubric](../eval/README.md#human-release-review).
5. Deploy a candidate on an isolated test line with consenting participants.
6. Execute the live scenarios below and record actual observations.
7. Attach images and a demo video to the PR with GH `--attach`.
8. Fix failures before recording a scenario as passed. Retain failed observations
   when they explain a regression or a known release limitation.

Use synthetic facts in evaluation and visual evidence. Automated word checks
help detect regressions; they do not establish useful tone or correct reasoning.

| Live scenario | Procedure | Observable acceptance |
| --- | --- | --- |
| First owner DM | Send one useful request on a fresh install | A useful reply with no mandatory setup interview |
| Owner preferences | Confirm a language, timezone, and verbosity preference, then restart | The preference survives and can be inspected or reset |
| Normal-group silence | Exchange unrelated human messages | No agent text, silence marker, fallback notice, or typing indicator |
| Normal-group task | Address the agent, then answer its active question | It follows the current task and uses only authorized guest tools |
| Private-data boundary | Ask from a group for a synthetic private owner note | The note is withheld; the agent explains the applicable permission |
| Trusted-group revocation | Give test trust, queue work, then revoke trust | Subsequent execution refreshes access and rejects the removed grant |
| Email | Ask the owner to send a synthetic message to a controlled mailbox, then reply there | Outgoing mail has a receipt; final private status reaches the owner route |
| Reminder | Request a short reminder with a known timezone | The scheduled job exists, executes, and delivers to the agreed scope |
| Pause and resume | Pause during scheduled work, restart, then resume | Optional scheduled delivery stops; direct replies work; changed jobs stay changed |
| Task cancellation | Start bounded worker analysis, ask another question, then cancel | Main remains responsive; cancellation has one acknowledgement and a native receipt |
| Disconnected Mac | Disconnect the test Mac and request a Mac action | The reply names the unavailable connection and gives a usable next step |
| Reconnected Mac | Reconnect and repeat an authorized read | The current service state is used; no invented earlier success |
| Unknown delivery | Use a controlled timeout fixture | No blind repeat or completed claim; uncertainty is recorded |
| Mobile settings | Preview, save, reload, make a stale edit, and reset | Saved values persist, stale writes fail visibly, and reset restores builder defaults |

For base releases, require zero unauthorized effects, duplicate fixture sends,
private-data leaks, visible silence markers, and missed recovered sources.
Record latency and cost with their measurement boundaries. Use the release
targets in [the base contract](base-experience.md#operations-and-release-evidence).

**Exit check:** deterministic checks pass, model outputs have no material false
claim, and the live candidate meets the agreed behavior. If human or live review
is pending, label the candidate accordingly.

## SOP 5: Release a candidate

**Outcome:** a traceable public image and a release record.

1. Commit the exact tested source and record the commit hash.
2. Record the base digest, variant digest, runtime version, test results, and
   unresolved acceptance work.
3. Push the tested variant to a registry you control:

   ```sh
   cd work/my-tutor
   plow-agents image push REGISTRY/my-agent:v1
   ```

   Run the CLI from your variant's Dockerfile directory. The example path assumes
   you copied the tutorial starter; use your agent repository root for a standalone
   project. Check that its base argument contains the released digest.

4. Deploy the immutable reference printed by push to the intended line:

   ```sh
   plow-agents deploy REGISTRY/my-agent@sha256:DIGEST --line LINE_UID
   ```

5. Confirm the first reply and startup health on that install.
6. Keep a complete pre-upgrade state backup and its matching image digest.
7. Follow [the operations SOPs](operations-sops.md) for future updates.

Use this release record:

```text
Agent repository and commit:
Base image digest:
Variant image digest:
Runtime version:
Purpose and supported conversations:
Deterministic checks:
Gateway fixture checks:
Live model run and human review:
Isolated live-installation results:
Attached images and video:
Known limitations:
Backup and rollback image:
Release owner and date:
```

## SOP 6: Publish on the Agent Index

**Outcome:** a listing that reports real usage and accurately describes the agent.

1. Choose the agent's slug, name, and one-line blurb.
2. Set `AGENT_ID` to that slug in the variant image or deployment environment.
   Set `AGENT_NAME` and `AGENT_BLURB` for listing metadata.
3. Retain the inherited reporter and the persistent `.agent-index` key and ledger.
4. Restart the install, use the agent, and confirm reported usage after a reporting
   interval. The base runs the client every five minutes.
5. Register a demo video, at least one image, and install instructions, following
   [the current publication guide](https://aiworthusing.com/agent-index/publish).
6. For one-click deploy, supply the account UID, slug, and public immutable image
   reference to the Plow admin process described there.
7. For hackathon verification, supply the repository, commit hash, and Index ID
   in the designated verification thread. An admin removes WIP after review.

MIT licensing, reporting usage, and removal of WIP are separate requirements.
Verified status is separate from removal of WIP. Keep a one-click image publicly
pullable. An enabled listing can receive a later tested image with:

```sh
plow-agents image push REGISTRY/my-agent:v2 --promote AGENT_SLUG
```

Promotion changes what future installs use. Treat it as a release action after
testing, rather than as evidence that the new image works.
