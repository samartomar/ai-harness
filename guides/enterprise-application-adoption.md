---
last_verified: 2026-08-10
owner: AI-Harness maintainers
purpose: Practical adoption guide for engineering teams applying
  AI-Harness during enterprise application delivery.
status: guide
truth_home: false
---

# Enterprise Application Adoption Guide

Use this guide when an engineering team wants to apply AI-Harness
(`aih`) while building or modernizing a real enterprise application. It
complements the [Enterprise Admin](enterprise-admin-guide.md) and
[Enterprise Developer](enterprise-developer-guide.md) guides by focusing
on the application-delivery journey rather than organization policy
authoring or developer-local setup alone.

The central idea is simple: AI coding tools can accelerate
implementation, but enterprise application delivery still needs durable
repository context, engineering guardrails, reviewed capabilities,
verification, and normal software-delivery controls.

> **Standardize the engineering controls around AI-assisted development
> without requiring every developer to use the same AI coding client.**

## 1. Start with workstation readiness

Before asking an AI coding client to diagnose application failures,
establish whether the developer environment itself is ready:

``` console
aih doctor
```

AI-Harness also provides workstation and runtime commands such as
`certs`, `heal`, `tools`, `ready`, and `bootstrap` for supported
readiness workflows. In TLS-intercepted or otherwise controlled
enterprise environments, separating workstation problems from
application problems can reduce misleading agent debugging and
developer-specific setup drift.

## 2. Bootstrap the application repository deliberately

`aih` is dry-run by default. Preview repository initialization before
applying changes:

``` console
aih init .
```

Review the plan and then apply it deliberately:

``` console
aih init . --apply
```

Repository bootstrap composes the supported AI-Harness setup surfaces
for the selected posture and configuration. Treat the resulting diff
like any other engineering change: review it, understand what will be
committed, and keep organization-specific enforcement in the appropriate
platform, CI, and policy systems.

## 3. Make repository context durable

AI-assisted development works better when the coding client understands
information it cannot safely infer from source code alone, such as:

-   architectural boundaries and repository responsibilities;
-   build, test, and review expectations;
-   technology and implementation conventions;
-   security expectations;
-   domain terminology;
-   integration boundaries and operational constraints.

AI-Harness uses repository-owned canon and generated client surfaces so
important engineering context does not exist only inside an individual
chat session.

Generate the selected AI client surfaces with the supported
`bootstrap-ai` workflow. For example:

``` console
aih bootstrap-ai --all-tools --apply
aih bootstrap-ai --verify
```

For governed enterprise rollout, follow the client set and posture
defined by the organization's approved configuration rather than
enabling tools independently.

## 4. Prevent multi-client context drift

Enterprise teams may use different AI coding clients. Those clients
consume instructions through different native files and configuration
surfaces, which creates a risk that engineering guidance gradually
diverges.

The useful separation is:

``` text
Repository-owned engineering context
              |
              v
          AI-Harness
              |
      +-------+-------+
      |       |       |
      v       v       v
   Client A Client B Client C
```

The clients do not need to behave identically. The goal is for supported
generated surfaces to begin from the same repository-owned engineering
truth and for teams to verify those surfaces rather than maintaining
unrelated copies manually.

## 5. Keep AI-generated code inside the engineering lifecycle

AI-generated code remains software owned by the engineering team. A
practical application-delivery flow remains recognizable:

``` text
Requirement
    |
Architecture / Design
    |
Implementation with AI assistance
    |
Automated tests
    |
Security and quality checks
    |
Code review
    |
Deployment
    |
Operational feedback
```

AI can accelerate analysis, implementation, test generation,
refactoring, and documentation. It does not remove the need for
architecture decisions, testing, security review, code review,
deployment controls, or operational ownership.

The objective is not maximum generated code. The objective is faster
delivery of maintainable software.

## 6. Add guardrails without overstating enforcement

AI-Harness can generate and verify supported repository guardrail and
secret-control surfaces. For example:

``` console
aih guardrails --apply
aih secrets --verify
```

Generated configuration is not automatically equivalent to
organization-wide enforcement. Teams remain responsible for installing
required tools, wiring hooks and CI, configuring branch protections, and
making checks mandatory where their engineering policy requires it.

This distinction matters in enterprise adoption: AI-Harness helps
materialize and verify configuration, while the organization's
engineering platform remains responsible for the enforcement model
around the repository.

## 7. Treat skills and external capabilities as governed inputs

AI coding clients increasingly gain capabilities from external skills,
repositories, packages, plugins, and other sources. These should not
become trusted merely because a coding client can discover them.

AI-Harness provides governed skill workflows around review and approved
state. In an enterprise application workflow, teams should be able to
answer questions such as:

-   Where did this capability come from?
-   Was the source reviewed?
-   What version or content was approved?
-   Has approved content changed?
-   Is the capability permitted under organization policy?

This turns external agent capabilities into explicit engineering inputs
rather than invisible workstation dependencies.

## 8. Treat MCP as an integration boundary

MCP can connect AI coding clients to additional systems and tools. That
makes MCP configuration an enterprise integration boundary rather than
merely a developer convenience.

Use the reviewed MCP workflow and organization policy appropriate to the
repository. For example, the Enterprise Admin guide documents approved
enterprise patterns and the Enterprise Developer guide covers consuming
admin-reviewed MCP choices.

Normal enterprise security principles still apply to systems exposed
through MCP, including least privilege, authentication, credential
management, environment separation, reviewed endpoints, and auditing
where required. AI-Harness manages supported configuration surfaces; it
does not replace the authorization model of the connected system.

## 9. Use sandboxing according to the threat model

Where the development workflow requires stronger execution boundaries,
use AI-Harness's supported sandbox configuration and review the
generated plan before applying it.

Sandboxing should be selected according to the organization's threat
model and the capabilities being granted to the coding client. Do not
describe a generated sandbox as absolute isolation; native client
extensions, local configuration, credentials, and connected tools still
require their own review.

## 10. Model multi-repository applications explicitly

Many enterprise applications are split across repositories: for example,
a frontend, backend APIs, shared libraries, infrastructure, and data
services.

AI-Harness workspace support can represent cross-repository
relationships without pretending the repositories are a monorepo. A
workspace can provide cross-repository architecture and declared
relationships while each child repository continues to own its own
truth.

This is useful when an application change crosses repository boundaries.
Instead of asking an AI client to infer the product architecture from
whichever repository happens to be open, teams can make important
relationships explicit and reviewable.

## 11. Verify before scaling adoption

Before expanding the workflow to more developers or repositories, run
the supported verification surfaces for the selected posture. Common
starting points include:

``` console
aih doctor
aih status
aih bootstrap-ai --verify
aih secrets --verify
```

For enterprise posture, follow the policy-backed checks documented in
the Enterprise Admin and Enterprise Developer guides. Verification
should be part of adoption, not something introduced only after
configuration problems appear.

## 12. Preserve reviewable evidence where required

As AI-assisted development moves beyond experimentation, organizations
may need to answer more than whether the tooling works. They may need to
understand which policy, approved capabilities, repository context, and
harness configuration were in effect.

AI-Harness provides evidence and bundle capabilities for supported
governed workflows. Use those mechanisms according to the organization's
policy and evidence requirements; do not treat the existence of an
artifact as a compliance certification by itself.

The useful transition is from an implicit assumption that a developer
environment is configured correctly toward configuration and evidence
that can be inspected and verified.

## 13. Adopt through one real application first

A practical rollout can begin with one representative application rather
than an organization-wide mandate:

``` text
Developer workstation
        |
    Readiness
        |
Repository bootstrap
        |
 Review dry-run plan
        |
      Apply
        |
Canon + reviewed controls
        |
Approved AI coding clients
        |
Application development
        |
Build / test / review
        |
    Verification
```

Once the team has learned from a real delivery workflow, platform and
security owners can decide which defaults, policy, approved
capabilities, evidence requirements, and rollout controls should become
reusable across additional teams.

## 14. Measure engineering outcomes, not AI usage alone

An enterprise pilot should evaluate whether AI-assisted development
improves engineering outcomes. Useful measures can include:

-   developer onboarding and environment setup time;
-   time to first successful change;
-   pull-request cycle time and lead time for change;
-   build and automated-test success;
-   security and quality findings;
-   rework caused by incorrect generated changes;
-   configuration drift and policy verification results;
-   developer feedback on context quality and workflow friction.

The goal is not to maximize prompts, generated lines, or client usage.
The goal is to improve software delivery while maintaining the
engineering standards the organization requires.

## Adoption principles

**Keep the repository as the durable engineering artifact.** Important
architecture and development expectations should survive an individual
AI session.

**Keep humans accountable for engineering decisions.** AI-generated
changes remain changes the engineering team owns.

**Separate AI intelligence from enterprise controls.** Coding clients
and models will evolve quickly; engineering governance should not need
to be reinvented with every tool change.

**Verify rather than assume.** Configuration and approved state should
be inspectable and testable where the harness provides verification.

**Start with a real application.** Enterprise AI adoption is easier to
evaluate against actual software delivery than isolated demonstrations.

## Closing perspective

The important transition is not simply from developers writing code to
AI writing code. It is from individual AI experimentation to AI-assisted
engineering as a repeatable organizational capability.

AI-Harness provides infrastructure for that transition while keeping
application delivery grounded in repository-owned context, normal
engineering controls, governed capabilities, and verification.

Coding clients will continue to change. The surrounding requirements for
architecture, security, engineering quality, governance, and
reproducibility will remain.
