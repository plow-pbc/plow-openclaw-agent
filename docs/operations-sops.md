# Agent operations SOPs

Use these procedures for an install that inherits this base. Keep an operations
record with its line UID, image digest, state location, release commit, and
responsible owner. Use an isolated line for recovery rehearsals.

## SOP 1: Deploy a tested image

**Outcome:** the intended immutable image runs on the intended line.

1. Complete [the release acceptance checks](builder-sops.md#sop-4-verify-the-experience).
2. Confirm the target line is available with `plow-agents lines`.
3. Push the tested variant and record the digest printed by the CLI.
4. Deploy that digest:

   ```sh
   plow-agents deploy REGISTRY/my-agent@sha256:DIGEST --line LINE_UID
   ```

5. Check the install's startup log and health.
6. Send a useful owner request and verify its actual reply.
7. Confirm the expected persona and any declared connected services.
8. If `AGENT_ID` is configured, verify reporting after the five-minute interval.

An image digest identifies the bytes deployed. A moving tag does not provide the
same release traceability. Keep the image publicly pullable when hosting or
one-click deployment requires public access.

For local variants, use the inherited Compose proxy and the image override from
[the tutorial](first-agent.md#5-run-the-variant-through-the-existing-local-proxy).
`plow-agents deploy --local --line LINE_UID` is also available for the current
Compose project. Check which image that project's Compose configuration selects.

## SOP 2: Inspect a failed or unhealthy install

**Outcome:** a concrete failing boundary and evidence for its repair.

For the root Compose project:

```sh
docker compose ps
docker compose logs --tail 200 agent
```

If you use an override or project name, include it in each command.
The rotated boot log also lives at `/var/lib/plow/boot.log`.

1. Check health separately from container process status.
2. Find the first boot error. Identity lookup, manifest preflight, config rendering,
   and gateway startup are distinct stages.
3. If preflight fails, inspect the named path, ownership, modes, and all parent
   components. Symlinks are rejected, including links inside `/opt/`.
   Rebuild immutable installation content rather than making it writable.
4. If identity fails, verify the selected line, API root, and credential injection.
   `PLOW_API_BASE` is the API root without `/v1`.
5. If the gateway is healthy but a reply is missing, inspect source adoption,
   task outcome, and delivery receipt separately.
6. If a provider connection is missing, repair that connection and retry an
   authorized read. Do not repeat an uncertain mutation.
7. Record the failing source or task ID and a concise observed outcome.

| Observation | Meaning and next check |
| --- | --- |
| Container running, unhealthy | Boot can be parked or readiness can fail; read boot diagnostics |
| Source adopted, no confirmed message | Runtime ownership is established; delivery still needs evidence |
| `DeliveryUnknownError` | Confirmation is unavailable; inspect provider evidence before another effect |
| Scheduler job exists, no delivered reminder | Inspect execution, pause state, destination, and delivery |
| Paused, scheduler update failed | The durable gate remains active; retry control after inspecting the scheduler |
| Dashboard 403 | Inspect owner proxy attribution and trusted origin; keep gateway authentication enabled |
| State cannot be parsed | Preserve the file and restore a compatible backup; do not silently reset it |
| Checkpoint progress stalls | Inspect filesystem capacity and ownership; a failed write or atomic rename retains adoption IDs for reconnects in the running process |

Restrict diagnostics to install operators. Native gateway logs can contain sender
identifiers. PR evidence should use synthetic content and omit credentials and
private note bodies.

For checkpoint storage failures, inspect the running agent's user, state paths
and available space:

```sh
docker compose exec agent id
docker compose exec agent ls -ld /var/lib/plow /var/lib/plow/plow-checkpoints
docker compose exec agent df -h /var/lib/plow
```

Repair capacity or ownership while preserving complete state. The transport
keeps adopted IDs in memory until its atomic checkpoint commit succeeds, so
cache eviction during a failed write or rename cannot redispatch those sources
on reconnect. After storage recovers, confirm that checkpoint progress resumes.
Inspect provider receipts for uncertain effects before authorizing another
attempt. Retained memory protects the current process; preserve the state and
repair storage before an operator restart.

For the local Compose install, use `docker compose restart agent`. Its dashboard
shares the agent's network namespace, so Compose also restarts `dev-dashboard`
to attach it to the new namespace. Then verify agent health and reload the page.
Restarting only the agent through raw `docker stop`/`docker start` does not apply
that Compose dependency; reconnect the proxy with
`docker compose restart dev-dashboard`. For backups, stop and start the complete
project as shown below.

## SOP 3: Back up complete state

**Outcome:** a stopped-state archive and its matching image reference.

These commands use the root Compose project. Create a private backup directory:

```sh
mkdir -p backups
chmod 700 backups
docker compose stop
docker compose images
docker compose run --rm --no-deps --user root --entrypoint tar \
  -v "$PWD/backups:/backups" agent \
  -czf /backups/plow-state.tar.gz -C /var/lib/plow .
docker compose start
```

Record the full image digest separately. Use dated filenames instead of
overwriting the only known-good archive.

Back up all of `/var/lib/plow`. The archive covers scoped experience state,
native databases, sessions, tasks, cron jobs, delivery queues, phone checkpoints,
listening timestamps, email origins, and Agent Index key and ledger.
Copying only `openclaw.json` cannot restore this experience.

Exclude the private archive from Git and Docker build contexts. Immutable image
code and generated `/etc/plow/openclaw` includes are rebuilt from the matching
image; they are separate from durable state.

## SOP 4: Restore and rehearse recovery

**Outcome:** a complete archive starts with the matching runtime and preserves behavior.

1. For a rehearsal, select a backup from an isolated test install and its matching
   image digest. Keep the same API root, line UID and chat identities.
2. Stop the source and destination installs so only the restored copy can listen.
3. Create an empty destination state volume:

   ```sh
   docker volume create plow-restore-state
   ```

4. Restore the archive and runtime ownership:

   ```sh
   docker run --rm --user root \
     -v plow-restore-state:/var/lib/plow \
     -v "$PWD/backups:/backups:ro" \
     --entrypoint sh REGISTRY/my-agent@sha256:DIGEST -c \
     'tar -xzf /backups/plow-state.tar.gz -C /var/lib/plow && chown -R node:node /var/lib/plow'
   ```

5. Configure the restored test deployment to use that volume and credentials for
   the same isolated test line that produced the backup.
6. Start the matching image and verify health.
7. Inspect saved personality, private preferences, room notes, task records,
   paused notifications, and scheduler jobs.
8. Check checkpoint continuity with synthetic traffic. Confirm that adopted
   sources do not create duplicate effects.
9. Confirm the Agent Index key and ledger retain the install identity.

Scoped state is keyed by API root, line UID and conversation identity. A different
line or different chat IDs select fresh scopes; that cannot validate restoration
of the saved personality, private preferences, notes or pause journals. A separate
line can exercise a fresh install, but scoped-state continuity requires the original
identities. Never attach a production backup to another live line as a rehearsal.
Keep copied schedules paused during a rehearsal until destinations are reviewed.
Use `scope=all` pause on the source before backup if the rehearsal would otherwise
resume live work.

Do not open a newer runtime database with an older runtime. A compatible newer
image still requires an upgrade rehearsal.

## SOP 5: Upgrade or roll back

**Outcome:** a reviewed upgrade or restoration of the complete prior install.

1. Record the current image digest and create a complete stopped-state backup.
2. Review base and runtime changes, configuration migrations, and the two
   checksum-guarded runtime patches.
3. Build the variant against the new base digest.
4. Run deterministic checks, the gateway probe, the acceptance harness, and domain cases.
5. Rehearse restoration and migration on an isolated install.
6. Verify that explicit owner models, silence policy, and unrelated settings survive.
7. Deploy the new digest and check actual owner, group, email, and reminder behavior.
8. If rollback is needed, stop the new image and restore the complete pre-upgrade
   archive into an empty volume. Run its matching previous image.

Checksum guards fail when a patched upstream module changes. Review the new source
contract; do not update a hash without reviewing the change. The patches preserve
Plow cron delivery provenance and avoid a duplicate cancellation notice for the
reserved worker. [Runtime and gateway checks](development.md#experience-acceptance)
verify these boundaries.

## SOP 6: Stop work and retire an install

**Outcome:** work stops in its intended scope without claiming unrelated deletion.

1. Inspect notification status and pause the intended room or all owner phone work.
2. Inspect suspended-job IDs and any partial scheduler error. A lost disable
   response leaves a pending journal entry; retry pause or resume with a fresh
   authorized invocation. Resume preserves later job edits and pre-disabled jobs.
   If another room or global pause remains active, the job's journal moves there
   and it stays disabled until that scope resumes.
   Resume opens the requested delivery gate before enabling jobs. A lost enable
   response leaves the journal for reconciliation; inspect the scheduler and
   retry resume. Do not report that all jobs resumed from `paused: false` alone.
3. Cancel active tasks through their native task records.
4. Cancel associated automations separately.
5. Export or forget scoped memory when requested. Historical transcripts and
   external provider data have separate retention.
6. Take a final backup if the owner needs recovery.
7. Stop the container or deployed agent.
8. Revoke the install credential through the CLI's agent management commands when
   permanently retiring it. Keep the account login separate.

Use `plow-agents --help` and the
[CLI README](https://github.com/plow-pbc/plow-agents) for the installed version's
agent-management commands. Deleting a task, removing a schedule, forgetting a note,
stopping a container, and revoking a credential have different effects.
