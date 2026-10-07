# Agent definition reference

`/opt/plow/agent.json` describes image-installed persona, skills, plugins,
guest tools, and defaults. The schema lives in
[`boot/extensions.ts`](../boot/extensions.ts). The current object format is
version 1. Unknown fields and unsupported versions are rejected.

## Top-level fields

| Field | Type and limit | Default | Meaning |
| --- | --- | --- | --- |
| `version` | Integer, exactly `1` | Required in an object | Schema version |
| `persona` | Object described below | Absent | Builder persona; absence uses the image's legacy `prompt/AGENTS.md` |
| `plugins` | Array, at most 32 entries | `[]` | Native plugins installed in this image |
| `skills` | Array, at most 20 absolute paths under `/opt/` | `[]` | Additional skill directories |
| `guestTools` | Array, at most 100 tool names | `[]` | Tools available to non-owners in normal conversations |
| `defaults` | Object described below | Helper mode, ask for group trust | Image defaults for rooms and newly created groups |

An absent manifest uses `{ "version": 1 }`. A legacy top-level plugin array is
parsed as `{ "version": 1, "plugins": ARRAY }`. There is no automatic conversion
of an unsupported object version.

## Persona fields

| Field | Type and limit | Requirement | Meaning |
| --- | --- | --- | --- |
| `role` | Trimmed string, 1–300 characters | Required when persona exists | The agent's working role |
| `purpose` | Trimmed string, 1–1,000 characters | Required | A concrete outcome the agent helps achieve |
| `voice` | Trimmed string, 1–1,000 characters | Required | Style and level of explanation |
| `instructions` | String, at most 2,000 characters | Optional | Domain guidance subject to base policy |
| `examples` | Up to six strings, at most 500 characters each | Defaults to `[]` | Concrete expected behavior |
| `sliders` | Strict object with the five axes below | Optional | Builder personality positions |

The role is separate from the canonical name supplied by Plow identity.
Listing metadata such as `AGENT_NAME` describes the Agent Index listing.
Neither a role nor a listing name grants access to an owner's resources.

Every supplied slider value is an integer from 0 to 100. Missing axes in a
manifest slider object default to 50. Conversational partial updates preserve
previously saved axes.

| Axis ID | 0 means | 100 means |
| --- | --- | --- |
| `companion-coworker` | Warm and conversational | Pragmatic and professional |
| `genz-boomer` | Relaxed, contemporary language | Familiar, classic plain language |
| `execute-collaborate` | Take already authorized steps independently | Explain material choices and invite useful input |
| `playful-serious` | Light humor where welcome | Calm, matter-of-fact tone |
| `polite-unfiltered` | Tactful language | Candid, civil disagreement |

50 supplies no directional instruction for that axis. Distance from 50 sets
slight, moderate, or strong guidance. Sliders do not alter authority, truthful
completion, participation rules, or notification policy. Generational labels do
not authorize stereotypes or forced slang.

## Plugin fields

Every plugin entry requires all four fields:

| Field | Type and limit | Meaning |
| --- | --- | --- |
| `id` | Lowercase letter followed by lowercase letters, digits, or hyphens | Unique plugin ID; `plow` is reserved |
| `path` | Absolute normalized path under `/opt/` | Installed plugin directory |
| `tools` | Up to 100 tool names | Tools added to the image's allowed tool set |
| `conversationAccess` | Boolean | Whether OpenClaw permits the plugin's conversation-access hooks |

Tool names start with a lowercase letter and contain lowercase letters, digits,
or underscores. The plugin's `openclaw.plugin.json` must have a matching `id`
and a `contracts.tools` array containing every tool offered here.
`conversationAccess: true` does not replace per-tool authorization.

Manifest-listed plugin and skill directories, all their contents, the manifest,
and the parents of installed paths must be root-owned and not writable by the
group or others. Symlinks are rejected in the manifest, installation contents,
and every parent component, including links that currently point inside `/opt/`.
These rules prevent replacement through a writable parent or an intermediate link.
The Dockerfile can copy these files as root and then return to `USER node`.

## Default fields

| Field | Accepted values | Default | Meaning |
| --- | --- | --- | --- |
| `groupMode` | `helper`, `coordinator`, `facilitator` | `helper` | Initial participation guidance |
| `threadTrust` | `ask`, `untrusted`, `trusted` | `ask` | Policy for groups this agent creates |

Room mode and trust are separate. A coordinator can operate in a normal group
with narrow guest tools. A trusted group gives every member access to tools that
can reach the owner's Mac, mail, and files.

## Precedence and ownership

These rules apply to a fresh or restarted install:

1. Runtime routing and authorization remain enforced regardless of persona.
2. A manifest persona takes precedence over a copied legacy personality file.
3. `PLOW_GUEST_TOOLS` overrides the manifest guest list. An explicit empty value
   removes all guest tools.
4. `PLOW_THREAD_TRUST` overrides the manifest trust default.
5. Saved room settings override the image's room mode for that room.
6. Saved public personality adds style guidance across the agent's conversations.
7. Saved private owner preferences enter only the owner's main phone DM.

On every boot, `skills.load.extraDirs` merges the base skill directory, the
manifest's directories, and the owner's existing array, removing duplicates.
An upgraded image therefore makes its newly declared skills available on an
existing volume without discarding owner-added directories. Keep this setting
as an array of paths; another shape fails with an actionable configuration error.

The base composes maintained `prompt/BASE.md`, builder guidance, current trust
guidance, and connected Mac instructions. Base text has a 13,000-character cap;
builder guidance has a 6,000-character cap. Mac instructions receive the remaining
20,000-character composition budget, capped at 8,000 characters.

Keep injected guidance compact. The individual caps are validation limits, not
recommended lengths. Repeating base policy in a persona consumes space that
Latch needs to explain connected services. Put detailed teaching examples and
procedures in the agent's documentation and skills. The default-composition test
checks that the maintained base and default persona leave room for a complete
8,000-character Latch contract, including trust guidance and a dashboard URL.
Check the rendered composition when a variant uses longer custom guidance.

Boot writes workspace `AGENTS.md` and removes boot-owned `BOOTSTRAP.md`,
`SOUL.md`, `IDENTITY.md`, and `USER.md`. These files are outputs.
Durable preferences, memory, tasks, and schedules belong in supported state stores.
The [base contract](base-experience.md#operations-and-release-evidence) lists the
state covered by a complete backup.

## Example and validation

The [tutor manifest](../examples/tutor/agent.json) and
[coordinator manifest](../examples/coordinator/agent.json) are complete examples.
The [extension SOP](extension-sop.md) covers tool installation and authorization.
Build the image and run [the deterministic checks](development.md) before
deployment. Boot preflight validates installation as part of readiness; a
container that stays running after a preflight error remains unhealthy.
