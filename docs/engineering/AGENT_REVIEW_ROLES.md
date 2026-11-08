# Independent Review Roles

These are **prompts / review responsibilities**, not six already-installed autonomous workers. Any compatible tool can implement them. All reports land in Git PRs or docs, not in a vendor's private chat memory.

## 1. Developer / Implementer
Scope: only agreed change. Reads AGENTS.md, tests and relevant specs. Writes minimal diff, tests, migration plan if needed. Does not self-approve.

## 2. Architect / Maintainability Reviewer
Checks boundaries across Android, Web and Supabase, cohesion, coupling, KISS/DRY, API compatibility, idempotency, and migration strategy. Rejects forced abstractions and untested "cleanup".

## 3. Security & Privacy Reviewer
Threat models auth/RLS/Edge Function permissions, children/media data, intent exposure, offline enforcement, supply chain, secrets and dangerous CI workflows. Outputs evidence and risk severity, never speculative compliance claims.

## 4. QA / Regression Reviewer
Checks requirement-to-test traceability, edge cases, failed assertions, Android off-network mode, duplicate requests, timezone/DST, cross-platform flows and device testing. Checks *actual* logs.

## 5. UI/UX & Accessibility Reviewer
Checks design system reuse, mobile/iPhone Safari and desktop layouts, clipping, form/date picker handling, keyboard access, contrast, labels, responsive screenshots, and regression baselines.

## 6. Performance / Release Reviewer
Checks work on UI thread, excessive rendering or polling, memory, network retries, build reproducibility, signing, APK update safety, Vercel publish and safe rollback.

## Shared language review requirement
Every reviewer must check that newly introduced code identifiers, test names, KDoc/JSDoc and technical comments are in English and follow docs/engineering/QUALITY_POLICY.md. Check naming consistency and explicit time units. Localized UI copy is a separate, permitted exception.

## Extensibility and platform applicability
The governing [Standards Registry](STANDARDS_REGISTRY.md) maps each area to a reviewer, control status, source and evidence; the [specialist template](REVIEWER_EXTENSION_TEMPLATE.md) supports future roles.

**Release & Platform Reviewer** validates Android APK signing, versioning, CI/CD permissions, deployment safety, migration compatibility, rollback and test evidence. Apple distribution and store-review checks are currently inactive because no Apple store release is planned. New platform rules may be activated by documented decision.

Use language-appropriate automated analyzers as supporting evidence (ktlint/Detekt, ESLint/Prettier, Android Lint, security and accessibility tests) but never treat a passing scanner as proof of full compliance.

## How to use roles
- Every PR: Developer + automated checks; independent review by Architect or QA.
- Authentication, permissions, RLS or child privacy: Security role **mandatory**.
- UI changes: UI/UX reviewer + actual rendered screen verification **mandatory**.
- Release/CI/device commands: Release reviewer and explicit human approval **mandatory**.
- High-risk changes: require at least two independently reviewing roles or models.
- Do not send the full codebase to every agent. Give relevant diff, tests and minimum docs.
- Do not make one model claim to have independently run a different model's review.
- Review output uses: Finding | Evidence (path + line) | Severity | Fix | Test | Status.
