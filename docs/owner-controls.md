# Owner and room control reference

The Plow experience tools let an authorized conversation inspect and change durable
state. Natural-language requests select these tools; the example phrases below
are requests, not a separate command parser.

All tools use live context version 2, validate arguments, refresh relevant
conversation authority, and check the current invocation before committing.
Their schemas and gates live in [`plugin/experience.ts`](../plugin/experience.ts).

## Scope and storage

| State | Scope | Who can change it | Persistence |
| --- | --- | --- | --- |
| Private preferences | Owner | Owner's main phone DM | Atomic experience file |
| Public personality | Agent across conversations | Owner's main phone DM or authenticated dashboard | Experience file; builder positions remain the reset baseline |
| Room mode and purpose | Current conversation | Owner, trusted member, or a granted guest tool | Experience file |
| Durable notes | Owner or current conversation | Owner scope requires owner main DM; room changes require current grant | Experience file with provenance and note revision |
| Task commitments | Current conversation | Current authorized tool context | Native managed flows |
| Reminder schedule | Authorized native automation scope | Current authorized scheduling context | Native cron state |
| Notification pause | Current phone room, or all owner phone work | Room grant; all-scope requires owner main DM | Experience gate plus suspended scheduler revisions |

Experience filenames hash API root, line UID, and scope. Files use mode 0600 in a
0700 directory. Corrupt state raises an error; the base does not silently replace
the file with fresh state. Back up all durable state using
[the operations SOP](operations-sops.md#sop-3-back-up-complete-state).

## Private preferences: `plow_preferences`

Actions are `get`, `set`, and `reset`. Set requires a `preferences` object.
Partial sets preserve omitted preferences; reset returns the preference object
to empty.

| Preference | Accepted value |
| --- | --- |
| `name` | Confirmed name, 1–100 characters |
| `language` | Confirmed language, 1–100 characters |
| `timezone` | Valid IANA timezone name, at most 100 characters |
| `voice` | Private voice guidance, at most 1,000 characters |
| `verbosity` | `brief`, `balanced`, or `detailed` |
| `initiative` | `requested`, `suggest`, or `proactive` |
| `notificationMinIntervalMinutes` | Integer from 0 to 1,440; missing uses 30 |
| `quietHours` | Strict object with `start`, `end` in 24-hour HH:MM, and IANA `timezone` |

Examples: "Use brief replies and my confirmed timezone America/Sao_Paulo" and
"Show the preferences you have saved." Preferences do not grant permission for a
new external action. Quiet hours and minimum intervals govern optional heartbeats,
not an explicitly timed reminder.

## Public voice: `plow_personality`

Actions are `get`, `preview`, `set`, and `reset`. Set requires `sliders`.
Values and axis IDs are in [the manifest reference](agent-definition.md#persona-fields).
Omitted axes keep saved values. Preview produces proposed guidance without saving.
Reset removes the saved override and restores builder defaults.

Examples: "Preview a more serious style" and "Reset your public personality."
Public settings apply across this agent's conversations. A private owner
preference remains private.

The dashboard path is `/plugins/plow/personality`. Its authenticated API uses
`/plugins/plow/personality/api`, revision checks, trusted-origin checks, and a
bounded strict JSON body. A stale edit returns 409 so the owner can reload current
values. The page announces errors and supports keyboard slider input.

## Participation: `plow_room`

Actions are `get`, `set`, and `reset`. Set requires `settings`, containing
`mode` and/or `purpose`. Modes are `helper`, `coordinator`, and `facilitator`.
Purpose has a 1,000-character cap.

Examples: "Coordinate our dinner plan in this room" and "Show this room's purpose."
Reset removes room overrides and restores the image mode. This tool changes
participation guidance. Use the separate owner trust control to change authority.

## Facts: `plow_memory`

Actions are `get`, `remember`, `correct`, `forget`, `export`, and `reset`.
Scope is `owner` or `conversation`. If omitted, the owner's main session selects
owner scope; other conversations select their own scope.

1. Get the current notes and `revision`.
2. For every change, supply that number as `expectedRevision`.
3. For correction or deletion, supply an existing note `id`.
4. For remember or correct, supply `text`. Use `confirmed: false` for tentative
   facts and an ISO timestamp in `expiresAt` for a temporary note.
5. If the revision changed, get the current list before retrying.

Notes contain source, dates, confirmation, and optional expiry. Each scope holds
at most 100 notes with a 1,000-character text cap. Current context receives the
last eight applicable notes. Groups do not receive private owner preferences
or owner notes.

Examples: "Remember in this room that we chose Friday" and "Forget that dinner
note." Forgetting a durable note does not remove historical transcripts or
external provider copies.

## Commitments: `plow_tasks`

Actions are `list`, `create`, `wait`, `resume`, `finish`, `fail`, and `cancel`.
Create requires `goal` and an observable `completion` condition. It can include a
`deadline` ISO timestamp. A task stores the authorizing sender, source intent,
conversation, and destination.

Use a listed task `id` for later actions. Wait and resume can include `step`.
Finish and fail require factual `evidence`. Finish rejects
`delivery: "failed"` or `delivery: "unknown"`. Evidence interpretation remains
a model-dependent responsibility; the string itself does not prove success.

Examples: "Track our plan until everyone confirms the time" and
"Show this room's open tasks." A record does not schedule execution. Add a native
automation for a requested wakeup. Cancel active task work and its associated
automation separately.

## Scheduled delivery: `plow_notifications`

Actions are `get`, `pause`, and `resume`. Scope defaults to `conversation`;
`all` requires the owner's main phone DM.

Pause first writes the durable gate, then disables matching jobs with expected
configuration revisions and cancels owned active runs. A scheduler failure can
leave partial job changes while the delivery gate remains paused. Report that
partial outcome accurately.

Before disabling each job, the control stores its intended disabled definition.
If the response is lost, or the invocation is cancelled before recording the
response, a fresh pause/resume can reconcile that unchanged definition against
the native scheduler. This preserves recoverability without ignoring cancellation.

Resume restores only unchanged jobs disabled by this control. Confirmed entries
must match their recorded revision; pending entries must match the recorded public
definition before updating with the current revision. It does not undo a user's
later schedule edits or re-enable jobs that were already disabled.

Resume opens the requested scope's delivery gate before asking the scheduler to
re-enable jobs. If the scheduler accepts an enable but its response is lost, a
one-shot reminder can still deliver. The journal entry remains for reconciliation;
retrying resume inspects the actual job without sending another confirmed enable.
If the scheduler fails before enabling, some jobs remain disabled. An open gate
therefore does not prove that every reminder has resumed. Report both facts.
`suspendedJobs` lists recovery journal entries, not observed scheduler status.
After a lost enable response, a listed job may already be enabled. Read its
native scheduler state before saying it is disabled or running.

Room and global pauses can overlap. The job stays disabled while its source room,
destination room, or all-scope gate remains paused. Resume transfers its journal
to the remaining scope before removing the original entry; the last resume
re-enables it. Direct replies remain available while paused. New automations in
the paused scope are blocked. Paginated job listing uses stable names so disabling
an earlier page cannot move unread jobs past the next page.
The physical delivery guard checks source-room, destination-room and global
gates again immediately before sending. Phone groups receive the effective
`notifications_paused` boolean, including a global pause, without receiving
private owner preferences or memory.

Examples: "Pause scheduled notifications in this room" and "Resume all scheduled
phone notifications." For one reminder, remove that automation directly.
