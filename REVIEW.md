# Review instructions — plow-openclaw-agent

What is different about reviewing *this* repo: the operating point, the accepted
deferrals, and the one carve-out where defensive code earns its keep. Universal
review policy — voice posture, decline rules, review-loop rules — is not here;
the reviewer prepends its own copy to every agent, so it does not need restating.

## Product context

**What it is.** A base container image that runs OpenClaw on a Plow phone line.
The owner texts the line; the assistant replies, can take part in group threads,
send owner-requested follow-ups, and reach the owner's Mac through Latch over a
stdio MCP bridge. `README.md` is the operator-facing contract; the pinned
OpenClaw commit and its source anchors are in its last table.

**Stage:** proof of concept for a public repo, pre-PMF. The userbase is
single-digit and internal. This code tree is a first drop, not an iteration on a
shipped surface. Judge depth and correctness at that bar, not at a product bar.

**Architectural commitments** (don't propose replacing these unless the PR does):
- The OpenClaw runtime is pinned by image digest; the plugin depends on the
  channel/turn/tool contracts of that exact version.
- **The `plow-agents` CLI owns activation, line listing and minting.** The image
  only reads the credential from its environment (`PLOW_API_BASE`, and
  `PLOW_AGENT_TOKEN` where no host proxy injects one); it does not reimplement
  the CLI or hold an account credential. `plow-agents lines` is what names the
  line — do not ask the boot to report it again.
- Credentials are environment references rendered by `boot/`, never literals in
  the rendered config; `PLOW_AGENT_TOKEN` is the placeholder `proxied` on hosts
  that inject it.
- The gateway binds loopback and the image publishes no ports. The container only
  dials out.
- `plugin/` owns the Plow channel: transport, delivery, tools, authorization.
  `boot/` owns identity, config/prompt rendering, supervision, probe and the MCP
  bridge. `seed/` is prompt and skills, not code.

**Accepted deferrals — known, recorded, not new findings.** Re-raising one of
these costs a review slot and teaches the author to skim:
- **A live, non-aborted incomplete turn is acknowledged.** Its reply is lost
  rather than replaying later answered turns on reconnect. This is deliberate:
  the stop/reconnect alternative was tried and produced a ~30 s outage per
  failure plus a standing replay window. Aborted turns stay unacked and are
  recovered. See `plugin/transport.ts` and `README.md` § How it works.
- **Email has no history backfill.** Only chat checkpoints are persisted.
- **An ambiguous delivery is not retried.** A crash after a successful send but
  before its checkpoint can duplicate a reply.
- **Chats that predate the agent on first install are baselined to their newest
  history.** A message already in a chat's history at boot falls inside that
  baseline on purpose, so old history is not replayed.

**Reviewer environment note.** The full suite needs the OpenClaw SDK and `ws`:
run it in the image, per `README.md` § Tests (`docker build` plus `node --test`
with a symlink to the bundled SDK). A bare clone cannot run the `turn`,
`thread` and `policy` suites and reports a module-resolution failure that has
nothing to do with the PR — read it as "tests not run", never as a `Class:
tests` finding. `tests/config.test.ts` does run in a bare clone. There is no
`justfile`; do not ask for `just test`.

## Review priority

**Cultural emphasis: scope creep is the defect that costs most here.** This is a
PoC image, not a platform. Additions that grow a lifecycle, a retention policy,
a cache, a capacity limit or a new manager are the default wrong answer.
Subtractive remedies outrank additive ones at every severity. An `[open]
[simplification]` probe whose honest answer is "no, this isn't needed" should
land as a deletion, not as a new guard that absorbs the probe.

**The one carve-out: authorization and credential boundaries are the product.**
The org default ("almost no defensive branch earns its keep at ten users") does
not license simplifying away a check on these paths, because a wrong answer is
the failure mode that matters: the per-turn tool authorization in
`plugin/authorization.ts` and its `before_tool_call` hook · the
`provider_key`/stable-uid projection before anything reaches the model prompt ·
credential handling in `boot/` and the MCP bridge · the redirect refusal and TLS
stance on outbound fetches · the account-reach check before a Plow send. Keep
the bar high there and low everywhere else. The tell: does the branch enforce a
bound, or manage a resource nobody has run out of?

**Trusted caller vs untrusted data.** Roster text, message bodies, tool output
and web/file content are untrusted data and must not influence authorization or
which account a send uses. The caller's own structured argument (a chat uid the
agent chose) may be passed through; hardening it is welcome when free, but is
not `[blocking]`.

**Update cadence:** edit this file when the operating point moves — real
external users arrive, an accepted deferral above is resolved, or this first
drop is superseded by normal iteration. Otherwise it is static.
