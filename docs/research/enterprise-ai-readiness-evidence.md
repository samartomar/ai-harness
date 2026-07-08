# Enterprise AI Readiness Evidence Register

Status: public research register

Purpose: give README, articles, and leadership decks a source/date/population/
caveat trail before any statistic becomes public copy.

## Evidence Rules

1. Prefer primary sources: research owner, official report, official press release, or standards body.
2. Every statistic needs a date, population, and caveat.
3. Do not copy a statistic from a secondary article when the primary source is available.
4. Do not use a statistic in a product assurance claim unless the AIH control matrix proves the product behavior.
5. Research can justify the problem. The control matrix must justify the product claim.

## Source Register

| Source | Date | Population / basis | Claim to use | Why it matters to AIH | Caveat |
| --- | ---: | --- | --- | --- | --- |
| McKinsey, *The State of AI: Global Survey 2025* | Nov. 2025 | Global executive survey | 88% report regular AI use in at least one business function; roughly one-third report that their companies have begun scaling AI programs. | Access is broad, but enterprise scaling and operating-model maturity lag. | Self-reported; "at least one function" is not full enterprise readiness. |
| Stack Overflow, *2025 Developer Survey - AI* | 2025 | Developer survey respondents | 46% distrust AI-tool accuracy vs. 33% trust it. | AI work needs verification and reviewable evidence because adoption and trust diverge. | Developer-community sample; trust is perception, not direct output-quality measurement. |
| GitLab, *AI Accountability Report* press release | Jun. 2026 | 1,528 developers and technology buyers across six countries, conducted by The Harris Poll | 91% have two or more AI coding tools; 78% report faster code output; 85% say the bottleneck shifted to review/validation; 80% adopted faster than policies. | AI code generation has outpaced traceability, review, and governance. | Vendor research; use as signal, not as a universal benchmark. |
| Netskope, *Cloud and Threat Report: 2026* | 2026 | Security telemetry in Netskope-managed environments | GenAI data policy violations doubled; average organization sees 223 incidents/month; source code is 42% of GenAI DLP violation categories. | AI-assisted development is a data-governance and source-code protection surface. | Telemetry depends on Netskope customer base and configured DLP policies. |
| Deloitte, *State of AI in the Enterprise: The Untapped Edge* | Jan. 2026 | 3,235 director-to-C-suite business/IT leaders, 24 countries, 6 industries | Close to three-quarters plan agentic AI within two years; only 21% report a mature agent governance model. | Tool-using agents need permission boundaries, policy, and evidence before broad rollout. | Survey of leaders involved in AI initiatives; not all companies have the same agent maturity. |
| Gartner, *Critical GenAI Blind Spots* press release | Nov. 2025 | 302 cybersecurity leaders surveyed from March to May 2025 | 69% of organizations suspect or have evidence that employees are using prohibited public GenAI. | Shadow AI pressure means the governed path must be useful, not only blocked. | Suspicion/evidence is not the same as confirmed misuse in every case. |
| Google Cloud DORA, *2025 State of AI-assisted Software Development* | Sep. 2025 | Software delivery survey | 90% use AI at work; more than 80% report productivity gains; 30% report little or no trust in AI-generated code. | AI can improve individual productivity while still requiring platform, workflow, and trust controls. | Survey-based; DORA's key argument is systemic capability, not tool-only ROI. |

## Approved Public Copy

### Problem Framing

AI access is no longer the hard part. Governed readiness is. Research from
McKinsey, Stack Overflow, GitLab, Netskope, Deloitte, Gartner, and Google DORA
points to the same pattern: adoption is high, but context, policy,
verification, traceability, and evidence lag behind.

### AIH Positioning

`aih` is a governed readiness layer for AI-assisted software development:
environment, context, policy, local execution boundaries, and evidence.

### Safe Claims

`aih` helps teams standardize AI-assisted development workflows, make repo
context easier to load, apply policy checks at the point of use, create
reviewable evidence, and make unmanaged risk easier to surface and review.

### Claims To Avoid

Do not say `aih` eliminates hallucinations, guarantees secure code, prevents all
data leakage, proves compliance by itself, replaces AppSec/DLP/GRC/human review,
or makes teams a specific percentage faster without pilot data.

## Recommended README Evidence Cards

| Card | Text |
| --- | --- |
| Adoption | 88% report AI use in at least one business function. |
| Trust gap | 46% of developers distrust AI-tool accuracy. |
| Review bottleneck | 85% say AI shifts the bottleneck to review and validation. |
| Data risk | Source code is 42% of GenAI DLP violation categories. |
| Agent gap | 21% report mature agent governance. |

Use each card with a nearby source link and caveat. The cards are problem
evidence, not AIH performance claims.

## Source Links

- McKinsey, *The State of AI: Global Survey 2025*: <https://www.mckinsey.com/capabilities/quantumblack/our-insights/the-state-of-ai>
- Stack Overflow, *2025 Developer Survey - AI*: <https://survey.stackoverflow.co/2025/ai>
- GitLab, *AI Accountability Report* press release: <https://ir.gitlab.com/news/news-details/2026/GitLab-Research-Reveals-Organizations-Are-Generating-AI-Code-Faster-Than-They-Can-Control-It/default.aspx>
- Netskope, *Cloud and Threat Report: 2026*: <https://www.netskope.com/resources/cloud-and-threat-reports/cloud-and-threat-report-2026>
- Deloitte, *State of AI in the Enterprise: The Untapped Edge*: <https://www.deloitte.com/us/en/about/press-room/state-of-ai-report-2026.html>
- Gartner, *Critical GenAI Blind Spots* press release: <https://www.gartner.com/en/newsroom/press-releases/2025-11-19-gartner-identifies-critical-genai-blind-spots-that-cios-must-urgently-address0>
- Google Cloud DORA, *Announcing the 2025 DORA Report*: <https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report>
