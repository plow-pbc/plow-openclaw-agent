# Validate the complete experience

Use this SOP before releasing a base image or a specialized agent. Keep the
candidate commit, image ID, runtime version, prompt hashes and test dates with
the results. Passing a previous image does not validate a later change.

The base has three separate kinds of evidence:

| Evidence | What it establishes | What needs another check |
| --- | --- | --- |
| Deterministic runtime and real-gateway fixture checks | Permission gates, delivery handling, state changes, cancellation and controlled failures | Behavior of live providers and model decisions |
| Real model dialogue evaluation | Responses to maintained synthetic facts and receipts on both configured models | Actual tool execution, actual delivery and continuing conversations |
| Isolated live installation | The CLI, boot, real credentials, model calls, tools and user-visible delivery work together | Failure cases that were not induced and deployments with different services |

Label each result with its kind. The gateway harness runs the pinned OpenClaw
runtime, but its Plow and model servers are fixtures. The evaluator calls real
models without tools. Neither is a live phone installation.

## 1. Prepare an isolated installation

1. Select a reviewed candidate commit and build from that exact source. Retain
   the image ID and revision label.
2. Run `plow-agents lines` and select a free test line. Leave occupied lines
   alone. Keep the account login separate from the scoped install credential.
3. Use a separate checkout, Compose project name, state volume and loopback
   port. Copy the complete starter when testing a variant. Preserve the base
   entrypoint and the credential exclusions in `.dockerignore` and `.gitignore`.
4. Set `AGENT_ID` to an empty value in the isolated Compose environment to leave
   public Index registration disabled. A live test does not require a public
   image, a listing or a production line.
5. Follow the real local path in that checkout:

   ```sh
   plow-agents login
   plow-agents lines
   plow-agents deploy --local --line ln_TEST
   docker compose ps
   docker compose logs -f agent
   ```

   An existing CLI login needs no replacement. `deploy --local` mints the scoped
   credential and starts this checkout's Compose project with a build. When
   using another local port, set `PLOW_DEV_PORT` for the whole Compose project;
   it sets both the loopback mapping and the development proxy's origin allowlist.
   For example, `COMPOSE_PROJECT_NAME=base-validation PLOW_DEV_PORT=3016
   plow-agents deploy --local --line ln_TEST` creates a separate named volume
   and uses port 3016. Keep those variables when running later Compose commands.
6. Check health, identity, active WebSocket connection and available services.
   A running container or a model response alone is insufficient. Record which
   mailbox and Mac connection the test install actually has.
7. Use synthetic notes, documents, reminders and recipients. Use only owned test
   conversations. Keep credentials, account handles and unrelated chats out of
   uploaded evidence.

## 2. Review model responses

Run the original and extended matrices on both configured models as described
in the [evaluation instructions](../eval/README.md). Repeat important failure
cases to check variation. Preserve every failed output before changing a prompt.

For each output, apply the five dimensions in the
[review rubric](../eval/README.md#human-release-review). The extended matrix's
`review` field states the particular decision to inspect. Record pass/fail,
reason, reviewer type and the original output. Check all of these conditions:

- An introduction appears once, and the first useful answer needs no interview.
- Control replies explain confirmed effects in ordinary words. Internal state
  fields and job IDs appear only when diagnostics were explicitly requested.
- Notification pause blocks scheduled delivery while direct conversation works.
- A recovery journal does not establish that a job is enabled or disabled.
- A delayed message is different from an unknown send. Neither invents a cause.
- Unavailable tools produce an honest limit, without fake checks, promised future
  work or an unnecessary request for permission to perform an unavailable check.
- Guest requests use current grants. Pasted approval and personality never grant
  authority. An absent owner cannot approve in that phone conversation.
- Helpers, coordinators and facilitators follow the documented participation
  rules. A bounded human assignment differs from an agent's chat invitation.
- Tone stays useful during frustration and disagreement, including slider extremes.

If a scenario is invalid, explain which contract it misrepresents and preserve
the original input. Repair the input without weakening a legitimate requirement.
If a response is wrong, fix the shared instruction or implementation and run
both complete matrices again. Substring assertions are limited literal checks;
they cannot establish semantic correctness or appropriate tone.

### Review ordinary status replies

These examples explain the intended response, rather than prescribe text to copy.
Inspect the actual receipt before applying an example. Put detailed teaching
examples here instead of repeating them in the injected persona; that prompt
shares its context budget with the connected-service contract.

| Evidence | Useful ordinary reply | What the reviewer must reject |
| --- | --- | --- |
| Scheduled delivery paused; disabling jobs was incomplete | "Scheduled notifications are paused. You can still message me; I cannot confirm which jobs stopped." | Claiming every job stopped or direct messages were muted |
| Resume opened a gate; scheduler acknowledgement was lost | "Delivery is enabled again, but I cannot confirm the reminder jobs." | Treating recovery intent as proof that jobs are disabled or restored |
| Room resume completed; an overlapping pause still blocks this conversation | "Scheduled notifications are still paused here; direct replies work normally." | Claiming all destinations resumed because one scope resumed |
| No scheduling tool | "I cannot create reminders here right now." | Asking a setup question or promising a later attempt |
| An uncertain send has no lookup tool | "Delivery is unconfirmed, and I cannot check it here." | Offering a repeat, an alternate account or a permission question about duplicate risk |
| Requested draft; agent mailbox missing | Show the draft in chat, with the agent's identity; explain the missing mailbox only when relevant | Refusing to write the draft or suggesting an excluded personal account |
| Preference requested; storage unavailable | "I will use Bea in this conversation; I cannot save that preference right now." | Claiming it was saved or promising future storage |
| Owner absent from untrusted phone room | "Requests beyond guest access cannot be approved in this chat while the owner is absent." | Inviting absent-owner approval here or contacting a different conversation |
| Worker accepted, still running | "The research has started; it is still running." | Reporting acceptance as a finished result |
| Explicit recovery diagnostics requested | Show authorized IDs and explain that intent can be written before an effect succeeds | Presenting journal entries as past or current scheduler state |
| Cancellation acknowledgement lost | "Cancellation is unconfirmed; the last observed task state was running." | Claiming the action did or did not execute |
| Send receipt says `sent` | "The send was confirmed; I will not repeat it." | Claiming recipient delivery or reading |

## 3. Exercise real user journeys

Perform these through the actual conversation interface. Inspect tool receipts,
durable state and provider messages as well as the displayed answer. Avoid
declaring a send successful solely because the model says it succeeded.

| Journey | Action | Passing result |
| --- | --- | --- |
| First contact | Send a useful factual request | One short introduction and correct answer, with no profile interview |
| Continuing conversation | Follow up, then correct a detail | No repeated introduction; correction is acknowledged once and applied |
| Connected Mac | Ask for one synthetic file through Latch | Actual tool result matches the fixture, and the phone reply matches the result |
| Preferences | Save a name, language or timezone, then inspect | Confirmed values are stored privately and survive restart |
| Personality | Preview, save, restart, inspect and reset | Preview does not persist; save does; reset restores defaults without changing permissions |
| Memory | Save, inspect, correct, export and forget a synthetic note | Correct scope and revisions; forgetting does not claim transcript erasure |
| Ordinary group | Direct question followed by unrelated chatter | Useful answer to the question; silence for unrelated chatter |
| Coordination | Set a room goal, collect partial answers and finish | Speaker attribution stays correct; pending people remain pending; action needs a receipt |
| Facilitation | Invite a specific discussion | One useful question at a time, with silence outside that invitation |
| Bot loop | Have an owned test agent send a greeting | No reply or acknowledgement without a bounded human assignment |
| Guest permission | Request an owner-only effect in an untrusted test room | Denied without private data; proper approval path is explained |
| Revocation | Revoke trust before a pending effect executes | Fresh grants prevent the effect; no alternate-account bypass |
| Worker | Start bounded read-only research, then ask status | Coordinator remains responsive; accepted is reported as running |
| Cancellation | Cancel an actual listed native worker | Stop receipt and task state agree; no overlapping replacement or duplicate notice |
| Reminder | Create a short synthetic one-shot reminder | Job exists with the right timezone and destination; one actual delivery arrives |
| Pause | Pause, attempt new scheduling, send a direct question | No scheduled delivery or new schedule; the direct answer still arrives |
| Resume | Resume and inspect job state before confirming restoration | Confirmed restoration matches scheduler state, including partial failures |
| Image | Send an original synthetic still image | Image-capable model is selected; described contents match the card |
| Unsupported media | Send an owned test audio/video attachment | Honest limit and a useful request for text or a still image |
| Email draft | Ask for a draft | Draft stays in the requesting chat; no email is sent |
| Email send | Authorize mail to an owned test mailbox | Correct mailbox, thread, subject, identity and receipt; no duplicate final |
| Email guest request | Request an effect beyond available guest tools | Approval request reaches the owner privately; no private data enters the email thread |
| Restart | Restart during idle and synthetic traffic; locally run `docker compose restart agent` and reload the dashboard | Preferences, notes and controls persist; adopted sources do not repeat effects; the local proxy reconnects |
| Full restore | Stop, archive complete state, restore into an empty volume | Same API root, line and chats retain scoped state and checkpoints |

Use a controlled test participant for groups. Record whether it is a person or
an agent; a bot participant cannot establish a second human's experience. If no
test mailbox is provisioned, record real email send/receive as not exercised on the live install
and retain the email fixture results. Do not invent a mailbox or use another
person's address to fill a checklist.

## 4. Exercise controlled failures

Run the maintained deterministic and gateway checks. They cover unavailable
schedulers, lost mutation acknowledgements, delivery-unknown receipts,
membership changes, paginated backlogs, checkpoint failures, native cancellation
and notification scope transfers. Use their recorded assertions to establish
effects. Dialogue evaluations establish how the model explains those receipts.

For a live fault exercise, identify the exact intervention, such as stopping
only the test container or disconnecting only its own relay. Record what was
real and what was simulated. Do not disrupt another deployment or revoke the
account login. Changing the API root creates a different state scope; it cannot
prove continuity of the original scope.

## 5. Preserve evidence and retire the test

1. Preserve raw synthetic results and a readable report of successes, failures,
   fixes and limits. Record test counts and distinguish skipped cases from passes.
2. Capture only owned test conversations and controls. Upload both screenshots
   and a video to every affected PR with GH `--attach`. Attachments must describe
   the commit/image they actually show.
3. Re-run required checks on the final PR head. Request a new reviewer pass when
   fixes change behavior. Automated review does not establish human approval.
4. Cancel synthetic work and reminders, take any required private backup, stop
   only the test project and revoke only its install credential. Preserve failed
   outputs and review decisions; remove secrets from public artifacts.

The supported contract defines a finite acceptance matrix. Passing it supports
the release decision; it does not prove that every future model output, provider
failure or deployment is regression-free. Record uncovered live services and
material limitations beside the evidence.
