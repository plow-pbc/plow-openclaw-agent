# Build and operate a Plow agent

Start with the inherited base behavior, then add one useful domain workflow.
The base already supplies conversation routing, group participation guidance,
owner controls, scoped state, transport recovery, and usage reporting.

Choose the document that matches your task:

| You want to… | Read |
| --- | --- |
| Build your first working agent | [Build your first tutor](first-agent.md) |
| Understand what a fresh install does and why | [The prebuilt experience](default-experience.md) |
| Design and release an agent with a repeatable process | [Agent builder SOPs](builder-sops.md) |
| Look up every manifest field and precedence rule | [Agent definition reference](agent-definition.md) |
| Inspect owner and room control actions, scopes, and limits | [Owner control reference](owner-controls.md) |
| Add a skill or a native plugin tool | [Extend an agent](extension-sop.md) |
| Deploy, inspect, back up, upgrade, or recover an install | [Agent operations SOPs](operations-sops.md) |
| Understand controls, enforced boundaries, and SDK receipts | [Base experience contract](base-experience.md) |
| Run deterministic and gateway checks | [Development](development.md) |
| Review a base release's coverage and remaining acceptance work | [Readiness checklist](readiness.md) |
| Review or maintain the dependent PRs | [Review stack](review-stack.md) |
| Judge dialogue outputs and model-dependent behavior | [Evaluation rubric](../eval/README.md#human-release-review) |
| Validate responses and a real isolated installation | [Experience validation SOP](experience-validation.md) |

The tutorial uses local images and an isolated test line. The release procedures
use immutable public image digests. A successful build establishes neither
permission correctness nor useful conversation behavior; the SOPs require
observable checks for both.

The [coordinator](../examples/coordinator) and [tutor](../examples/tutor) are
complete starting points. Their Dockerfiles retain the base entrypoint and install
only a manifest and domain skills. They demonstrate two different roles with the
same routing, permission, memory, and reporting contracts.
