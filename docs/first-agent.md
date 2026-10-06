# Build your first tutor

We will build a tutor that answers on a Plow test line, uses a guided-practice
skill, and inherits the base's group behavior and owner controls. By the end,
you have a local variant you can text and a saved personality setting.

You need Docker, Git, and [plow-agents](https://github.com/plow-pbc/plow-agents).
Use an available test line. Do not select a line that already runs another agent.
These steps create a local install; publication comes after acceptance.

## 1. Build the local base

Clone this repository and open its root:

```sh
git clone https://github.com/plow-pbc/plow-openclaw-agent.git
cd plow-openclaw-agent
docker build -t plow-openclaw:workshop .
```

The build finishes with a local image named `plow-openclaw:workshop`. It installs
the pinned OpenClaw runtime, Plow plugin, maintained prompt, and reporter.
If the build fails, read the first failed build step before trying to run it.

This local tag is for the exercise. Use a released digest in a published variant,
as described in [the release SOP](builder-sops.md#sop-5-release-a-candidate).

## 2. Copy the tutor starter

Keep your work separate from the maintained example:

```sh
mkdir -p work
cp -R examples/tutor work/my-tutor
```

The copy contains `Dockerfile`, `agent.json`, `.dockerignore`, and a
`skills/guided-practice/SKILL.md` file. Open `work/my-tutor/agent.json`.
The persona describes how the tutor helps; the skill describes how it teaches.

Change `persona.purpose` to one concrete subject, such as
"Help adults practice conversational Spanish with short, useful exercises."
Change the examples to match that subject. Keep `version`, skill paths, and
permission settings unchanged for this exercise.

The manifest does not set the phone agent's name. Plow supplies that verified
identity at boot. The [manifest reference](agent-definition.md) explains each field.

## 3. Build your variant

```sh
docker build --build-arg PLOW_BASE=plow-openclaw:workshop \
  -t my-tutor:v1 work/my-tutor
```

The starter installs the manifest at `/opt/plow/agent.json` and the skill under
`/opt/tutor/skills`. It returns to `USER node` before running the inherited boot.
Preflight checks root ownership, write permissions, and paths.

## 4. Select the test line

Sign in if needed, then list your lines:

```sh
plow-agents login
plow-agents lines
```

Choose an unused line and note its UID and phone number. Replace `LINE_UID`
in the next command with that UID:

```sh
plow-agents mint LINE_UID
```

The CLI writes `plow-credentials` in the repository root. Compose reads that file.
It contains a credential. Keep it out of Git, screenshots, evaluation outputs,
and Docker build contexts.

## 5. Run the variant through the existing local proxy

Create `work/my-tutor/compose.override.yml` with:

```yaml
services:
  agent:
    image: my-tutor:v1
```

Run the repository's Compose configuration with this override:

```sh
docker compose -f compose.yml -f work/my-tutor/compose.override.yml up -d --no-build
docker compose -f compose.yml -f work/my-tutor/compose.override.yml ps
```

`--no-build` uses the variant you just built. Without this flag, a Compose build
can rebuild the inherited root build context instead. The existing proxy stays on
loopback port 3001, and the existing named volume retains state.

If this checkout already has an install, use a fresh Compose project name with
`-p tutor-workshop` on every Compose command. A project name selects a separate
named volume. Use a test credential for that project.

Wait for the agent's health status to become healthy. Inspect startup failures
with `docker compose -f compose.yml -f work/my-tutor/compose.override.yml logs agent`.
A running container can still be unhealthy if boot is parked.

## 6. Ask the first useful question

Text the selected phone number from the owner's phone:

> Help me practice a short greeting in Spanish.

Expect a useful first response. The tutor can give an example and one exercise;
it should not require a profile interview before helping. Check the real reply,
not just the Docker logs.

Then send:

> I still don't understand. Use a smaller example.

Expect a different explanation at the requested level. Record any repeated or
unhelpful answer for the [dialogue review](builder-sops.md#sop-4-verify-the-experience).

## 7. Inspect and save personality

Open <http://localhost:3001/plugins/plow/personality>. Move one slider and inspect
the preview. Preview must not save the change. Select **Save**, reload the page,
and confirm the position persists. Select **Reset** to return to the tutor's
builder defaults.

The tutor starts with its own slider values. Reset does not necessarily set all
five sliders to 50. Personality changes voice; permissions and group trust retain
their separate controls.

In the owner's phone DM, try:

> Use brief explanations, and remember that my timezone is America/Sao_Paulo.

Then ask which preferences were saved. These private preferences must not appear
in a group. Do not put actual sensitive data in a test group.

## 8. Verify quiet participation and stop the install

With consenting test participants, add the agent to a normal group. Have two
people exchange an unrelated message, then ask the tutor a direct question.
Expect silence during the unrelated exchange and a reply to the direct request.
See [the live acceptance SOP](builder-sops.md#sop-4-verify-the-experience) for the
remaining release checks.

Stop the local exercise:

```sh
docker compose -f compose.yml -f work/my-tutor/compose.override.yml down
```

The named state volume remains. Reuse the same project name and volume to check
restart persistence. The `-v` option deletes named volumes; use the backup SOP
before choosing a fresh state.

Your variant is ready for deeper testing. Follow the [builder SOPs](builder-sops.md)
to narrow its scope, verify permissions, and publish a tested image.
