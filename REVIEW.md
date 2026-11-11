# Review instructions — plow-openclaw-agent

Repo-specific reviewer policy. The universal review policy is prepended by the
reviewer and is not restated here.

## What this repo is

**The Plow base image for OpenClaw.** A Docker image that runs an OpenClaw
agent on Plow's cloud host (or locally via Compose), talks to its owner over a
Plow phone line, and reaches the owner's machines through latch. Published to
public ECR one immutable tag per commit; variant agents build `FROM` it.

**Stage:** user-facing. Published image that real Plow cloud agents run.

## Review bar

Report **Critical** and **Important** findings only. Nits and style go
unmentioned.

- **No security against coworkers.** Everyone with push access, and our own
  agents, are trusted. Don't propose guards, validation or sandboxing
  against them.
- **Simplest code wins.** Prefer deleting a branch to adding one; don't guard
  cases that can't happen at the current operating point.

## Where the real risks are

- **Untrusted inbound text.** Messages arriving on the Plow line come from
  outside senders. Flag a change that lets that text become instructions,
  shell, or file writes outside the agent's sandbox.
- **The image is a base others pin by digest.** Flag a change that breaks the
  variant-image contract (`FROM` + content) or the in-place upgrade path
  without saying so.
- **Credentials.** The image boots holding the line's Plow credential; flag
  anything that logs it or widens who can read it.
