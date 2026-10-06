# Review the base experience stack

This stack separates runtime behavior from builder teaching material. Each PR
uses the previous branch as its base, so its default GitHub diff shows one layer.
Review and merge from the bottom upward.

| Order | PR | Main review boundary |
| --- | --- | --- |
| 1 | [Support image-installed native workflow plugins](https://github.com/plow-pbc/plow-openclaw-agent/pull/66) | Review boot/extensions.ts, config plugin load paths, and the shared plugin APIs. |
| 2 | [Keep groups quiet and recover durable conversation history](https://github.com/plow-pbc/plow-openclaw-agent/pull/67) | Review plugin/transport.ts and plugin/delivery-guard.ts, including cyclic cursors, unread windows beyond the recent UID cache, stable thread intent and adoption versus delivery. |
| 3 | [Add strict builder definitions and installation preflight](https://github.com/plow-pbc/plow-openclaw-agent/pull/68) | Review boot/extensions.ts and boot/prompt.ts first, then config rendering and the Docker build. |
| 4 | [Add scoped owner controls and personality settings](https://github.com/plow-pbc/plow-openclaw-agent/pull/69) | Review plugin/experience-state.ts, then the four scoped tools in plugin/experience.ts and personality-page.ts. |
| 5 | [Add native workers and durable notification pause](https://github.com/plow-pbc/plow-openclaw-agent/pull/70) | Review worker routing and tools in boot/config.ts, then task/notification tools and guards. |
| 6 | [Bound phone images and route vision to Sonnet](https://github.com/plow-pbc/plow-openclaw-agent/pull/71) | Review plugin/media.ts, the inbound attachment path and image configuration. |
| 7 | [Verify native gateway behavior and two-model dialogues](https://github.com/plow-pbc/plow-openclaw-agent/pull/72) | Review tests/gateway-acceptance.ts and the evaluation rubric before the fixtures. |
| 8 | [Builder SOPs, starters, and prebuilt default](https://github.com/plow-pbc/plow-openclaw-agent/pull/64) | Teaching material, release procedures, starter personas, and shared/default prompt clarity |

## Review each layer

1. Open the PR's default diff and confirm its named base is the preceding layer.
2. Read its concrete behavior and review entrypoints before the fixtures.
3. Check CI against the latest head after any rebase.
4. Distinguish code-enforced authority and delivery from model-dependent decisions.
5. Inspect the attached image and video with their stated evidence boundary.
6. Leave feedback on the layer that owns the behavior.

Layers 1–6 run the pinned-image runtime suite and offline gateway probe.
Layer 7 adds real native gateway acceptance and an optional credentialed dialogue
evaluation. Layer 8 preserves those checks and adds the builder-facing defaults
and documentation. The visual attachments show the integrated experience using
fixture transport and synthetic live-model calls; they do not establish a live
phone or email provider connection.

## Inspect the main boundaries

- **Installation and ownership:** `boot/extensions.ts` validates image-owned
  code, parents, symlink targets, and declared tool contracts. `boot/config.ts`
  maintains Plow-owned includes and preserves explicit owner choices.
- **Conversation and effects:** `plugin/transport.ts` owns recovery and provider
  receipts. `plugin/threads.ts` refreshes the owner-DM gate. `plugin/index.ts`
  uses SDK context version 2 and separates source adoption from delivered effects.
- **Scoped state and controls:** `plugin/experience-state.ts` keeps private owner
  data out of room context. `plugin/experience.ts` validates the grant and current
  invocation at the effect boundary.
- **Long work and stop:** native managed flows record commitments; native workers
  perform bounded read-only analysis. Persisted pause gates scheduled delivery
  before scheduler changes. The pinned patches have narrow checksum-guarded targets.
- **Teaching material:** the [documentation guide](README.md) separates a guided
  tutorial, repeatable SOPs, factual references, and explanation of the defaults.

## Maintain the stack after feedback or merges

Before rewriting a dependency, record its old head SHA. Rebase only the child's
own commits onto the updated dependency, then propagate the change upward.
Use `git rebase --onto NEW_PARENT OLD_PARENT_SHA CHILD_BRANCH` after inspecting
the relevant references. Push a branch owned by this stack with a lease so a
concurrent change is not overwritten.

If a dependency is squash-merged, its commit IDs change. Rebase the next layer's
own commits onto updated main and retarget that PR to main. Check that the diff
still contains only that layer. Repeat for later descendants and rerun their CI.
Do not merge the top documentation PR against main while its dependencies remain
unmerged.

A parent update can change a child's effective runtime even if its own diff stays
small. Review the resulting image and current checks rather than carrying an old
green status across the rebase.

## Release the complete base

The final candidate includes every layer. Use [the builder release SOP](builder-sops.md#sop-5-release-a-candidate),
[the evaluation rubric](../eval/README.md#human-release-review), and [the readiness checklist](readiness.md).
Human tone review and acceptance on an isolated live installation remain release
gates. Test prefixes and fixture previews do not replace those steps.
