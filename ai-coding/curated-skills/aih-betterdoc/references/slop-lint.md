# Bounded Anti-Slop Lint

Use this after the claim, evidence, artifact-preservation, and completeness passes.

The goal is not to remove every phrase that can sound AI-written. The goal is to remove prose that is empty, formulaic, vague, or performative without damaging technical meaning.

## Cut Throat-Clearing

Usually cut:

- Here's the thing,
- Here's why,
- Let me be clear,
- The truth is,
- It turns out,
- It is worth noting,
- At its core,
- When it comes to,
- In today's landscape,
- The reality is.

Replace with the actual claim.

## Remove Empty Emphasis

Usually cut:

- Full stop,
- Period,
- Make no mistake,
- Let that sink in,
- This matters because,
- The stakes are high,
- The implications are significant.

Replace with the mechanism, consequence, or evidence.

## Avoid Formulaic Contrast Unless It Protects Meaning

Usually rewrite:

```md
This is not X. This is Y.
```

as:

```md
This is Y.
```

Keep contrast when it prevents a real misunderstanding:

```md
The system does not make model reasoning deterministic. It makes action boundaries explicit and enforceable.
```

## Avoid Negative Listing

Weak:

```md
Not a dashboard. Not a proxy. Not another tool. A platform.
```

Better:

```md
The platform coordinates the workflow across users, services, and audit records.
```

## Replace Vague Declaratives

Weak:

```md
The implications are significant.
```

Better:

```md
The change requires operators to rotate existing tokens before enabling the new policy.
```

## Replace Business Jargon

Prefer concrete verbs over:

- leverage,
- navigate,
- unlock,
- seamless,
- robust,
- game-changing,
- best-in-class,
- cutting-edge,
- future-proof,
- mission-critical,
- world-class,
- next-generation.

Keep domain terms that are precise in context.

## Active Voice, With Exceptions

Prefer active voice when passive voice hides responsibility.

Weak:

```md
Errors were handled.
```

Better:

```md
The handler returns a 400 response for invalid input.
```

Passive voice is acceptable when the controlled object, invariant, or protocol requirement matters more than the actor:

```md
Requests are rejected when the token audience is missing.
```

Passive voice is also acceptable in specs, RFC-style prose, security/assurance docs, and generated reference docs when it keeps the invariant clear.

## False Agency

Avoid vague abstractions acting like people.

Weak:

```md
The process decides what users need.
```

Better:

```md
The reviewer approves or rejects each candidate.
```

System components can act when they actually do something:

```md
The authorizer rejects expired tokens.
```

## Absolutes

Do not ban `every`, `always`, or `never` mechanically.

Keep absolutes when they describe a real invariant:

```md
The server listens only on localhost.
```

Cut vague absolutes:

```md
Every team needs this.
```

## Adverbs and Qualifiers

Cut empty intensifiers:

- very,
- really,
- truly,
- clearly,
- simply,
- fundamentally,
- importantly,
- crucially.

Keep adverbs and qualifiers that carry technical precision:

- cryptographically,
- automatically,
- periodically,
- explicitly,
- locally,
- globally,
- intentionally,
- transitively,
- deterministically,
- idempotently,
- approximately,
- best-effort,
- under sustained load,
- in the absence of retries,
- source-backed,
- runtime-verified.

## Hedging for Evidence Limits

Do not remove hedging that accurately reflects weak or partial evidence.

Keep calibrated phrases when true:

- appears to,
- source indicates,
- source does not show,
- not runtime-verified,
- not yet tested,
- based on the provided source,
- assuming the stated environment.

Cut hedges that avoid making a supported claim:

```md
The CLI seems to maybe validate the config.
```

when source supports:

```md
The CLI validates the config before writing generated files.
```

## Lists, Tables, and Prose

Lists are not slop. Use the format that helps the reader.

Prefer a list when:

- steps must be followed,
- requirements are parallel,
- readers need to scan.

Prefer a table when:

- repeated attributes must be compared,
- each row has the same evidence/status/risk fields.

Prefer prose when:

- a paragraph explains cause, mechanism, or tradeoff better than fragments.

Avoid repeated three-item cadence when it adds rhythm but no information.

## Callouts

Use callouts only when the information changes user behavior.

- `Warning`: risk of data loss, security exposure, cost, breaking change, or operational impact.
- `Important`: required prerequisite, constraint, or invariant.
- `Note`: useful context.
- `Tip`: optional convenience.

Do not hide unsupported claims in callouts.

## Rhetorical Setups

Usually cut:

- What if...,
- Think about it,
- Here's what I mean,
- As we will see,
- In this section, we will.

Exception: FAQs can use real user questions as headings.

## Rhythm

Avoid metronomic prose, stacked fragments, and repeated three-item cadence.

But do not make technical docs literary. Tables, command lists, reference pages, and runbooks should optimize for scanability.

## Em Dashes

Do not ban em dashes mechanically. Use them sparingly and consistently with project style.

## Quotable Lines

Keep a quotable line when it is true, precise, canonical, and useful as a thesis.

Cut quotables that are generic hype.
