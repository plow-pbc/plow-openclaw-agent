# Review the base experience stack

This stack separates runtime behavior from builder teaching material. Each PR
uses the previous branch as its base, so its default GitHub diff shows one layer.
Review and merge from the bottom upward.

| Order | PR | Main review boundary |
| --- | --- | --- |
| 1 | [Support image-installed native workflow plugins](https://github.com/plow-pbc/plow-openclaw-agent/pull/66) | Review boot/extensions.ts, config plugin load paths, and the shared plugin APIs. |
| 2 | [Keep groups quiet and recover durable conversation history](https://github.com/plow-pbc/plow-openclaw-agent/pull/67) | Review plugin/transport.ts and plugin/delivery-guard.ts, including cyclic cursors, unread windows beyond the recent UID cache, stable thread intent and adoption versus delivery. |
| 3 | [Add strict builder definitions and installation preflight](https://github.com/plow-pbc/plow-openclaw-agent/pull/68) | Review boot/extensions.ts and boot/prompt.ts first, then config rendering and the Docker build. |
| 4 | [Fence native invocations and retain delivery state](https://github.com/plow-pbc/plow-openclaw-agent/pull/73) | Review SDK context version 2, current-invocation checks, and delivery finalization. |
| 5 | [Add scoped preferences, memory and room controls](https://github.com/plow-pbc/plow-openclaw-agent/pull/69) | Review plugin/experience-state.ts, then the three scoped tools in plugin/experience.ts and current membership/provenance. |
| 6 | [Add authenticated personality preview, save and reset](https://github.com/plow-pbc/plow-openclaw-agent/pull/74) | Review the axis registry, sparse updates, personality-page.ts, origin/revision guards and UI. |
| 7 | [Add isolated workers and durable task commitments](https://github.com/plow-pbc/plow-openclaw-agent/pull/70) | Review worker routing and tool limits in boot/config.ts, then managed-flow commitments and cancellation notice suppression. |
| 8 | [Add recoverable notification pause and resume](https://github.com/plow-pbc/plow-openclaw-agent/pull/75) | Review persist-before-effect journals, scheduler revisions, overlapping scopes, stable pagination and physical delivery guards. |
| 9 | [Bound phone images and route vision to Sonnet](https://github.com/plow-pbc/plow-openclaw-agent/pull/71) | Review plugin/media.ts, the inbound attachment path and image configuration. |
| 10 | [Verify native gateway effects and recovery](https://github.com/plow-pbc/plow-openclaw-agent/pull/72) | Review tests/gateway-acceptance.ts and the existing Caddy-based preview before running the fixtures. |
| 11 | [Add opt-in model dialogue evaluation](https://github.com/plow-pbc/plow-openclaw-agent/pull/76) | Review the human rubric, synthetic cases, literal assertion limits and explicitly paid workflow. |
| 12 | [Builder SOPs, starters, and prebuilt default](https://github.com/plow-pbc/plow-openclaw-agent/pull/64) | Teaching material, release procedures, starter personas, and shared/default prompt clarity |
| 13 | [Add strict repeatable model evaluation controls](https://github.com/plow-pbc/plow-openclaw-agent/pull/81) | Evaluator options, strict validation, reporting, retries and opt-in CI. |
| 14 | [Retain connected-service context in compact default guidance](https://github.com/plow-pbc/plow-openclaw-agent/pull/82) | Default prompt compaction, full Latch headroom fixture and budget documentation. |
| 15 | [Add English experience scenarios and qualitative validation SOP](https://github.com/plow-pbc/plow-openclaw-agent/pull/83) | Consolidated scenario decisions, duplicate-risk assertion regression and isolated acceptance SOP. |
| 16 | [Run isolated dashboard ports through the trusted development proxy](https://github.com/plow-pbc/plow-openclaw-agent/pull/79) | Compose port isolation, Caddy origin ordering and spoofed-header fixtures. |
| 17 | [Report notification gates without leaking recovery internals](https://github.com/plow-pbc/plow-openclaw-agent/pull/80) | Effective delivery gates, scheduler uncertainty and explicitly requested recovery diagnostics. |
| 18 | [Separate mailbox transport from available chat drafting](https://github.com/plow-pbc/plow-openclaw-agent/pull/84) | Verified capability context on every turn, missing-mailbox receipts and sender identity. |
| 19 | [Reconnect local dashboards after Compose agent restarts](https://github.com/plow-pbc/plow-openclaw-agent/pull/85) | Agent/proxy dependency restart, retained state and the actual Compose regression fixture. |
| 20 | [Constrain unavailable send offers in drafts and uncertain status replies](https://github.com/plow-pbc/plow-openclaw-agent/pull/86) | Default prompt candidate; targeted real-model evidence retains six material findings and requires further qualitative acceptance. |
| 21 | [Stop model evaluation on exhausted provider credits](https://github.com/plow-pbc/plow-openclaw-agent/pull/87) | HTTP 402 checkpoint and unrun accounting; preserved retries and continuation for other errors. |

The three focused quality layers replace the broader [closed PR #78](https://github.com/plow-pbc/plow-openclaw-agent/pull/78). Its review and historical evidence remain available. The follow-up layers are drafts while qualitative and isolated live acceptance remain open. Their attached recordings state the captured source and whether they show an evidence page, a fixture or a real installation.

## Review each layer

1. Open the PR's default diff and confirm its named base is the preceding layer.
2. Read its concrete behavior and review entrypoints before the fixtures.
3. Check CI against the latest head after any rebase.
4. Distinguish code-enforced authority and delivery from model-dependent decisions.
5. Inspect the attached image and video with their stated evidence boundary.
6. Leave feedback on the layer that owns the behavior.

Layers 1–9 run the pinned-image runtime suite and offline gateway probe.
Layer 10 adds real native gateway acceptance; layer 11 adds optional credentialed
dialogue evaluation. Layer 12 preserves those checks and adds the builder-facing defaults
and documentation. The visual attachments show the integrated experience using
fixture transport and synthetic live-model calls; they do not establish a live
phone or email provider connection.

## Inspect the main boundaries

- **Installation and ownership:** `boot/extensions.ts` validates image-owned
  code, parents, absence of symlinks, and declared tool contracts. `boot/config.ts`
  maintains Plow-owned includes, merges image skill directories on restart, and
  preserves explicit owner choices.
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
