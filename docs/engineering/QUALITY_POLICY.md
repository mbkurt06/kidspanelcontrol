# Orbit Engineering Quality Policy — v1

Status: proposed baseline, **not** proof of project-wide compliance. These are engineering objectives, not an App Store submission checklist.

## Reference practices
- Simplicity, single responsibility, modular boundaries, dependency inversion when useful; no forced enterprise patterns.
- Kotlin official coding conventions + Android architecture guidance (UI / domain / data as needed).
- TypeScript strict checking, React component boundaries, accessible responsive UI.
- OWASP MASVS for Android/mobile controls and ASVS for web/API controls.
- WCAG 2.2 AA as an interface accessibility target (where applicable).
- Git pull requests, controlled migrations, observable failures, tests, and rollback plans.

## Non-negotiable release gates
- No known unreviewed critical vulnerability, permission bypass, family data leak, or loss of time/accounting integrity.
- Existing tested behavior passes; new acceptance criteria have appropriate tests.
- No direct push to main; independent reviewer for high-risk changes.
- Web, Android, and backend versions remain compatible during rolling updates.
- Data migrations have an approved forward plan, verification, and backup/restore plan.
- Changes do not silently disable an existing parental control, offline rule, or parental consent flow.
- Tests must run and be cited; an AI review is additional evidence, not a substitute.

## Change sizes
- Small cosmetic fix: shared design component + responsive/interaction check + screenshot or human visual review.
- Behavior change: written scenario, edge cases, tests, relevant cross-layer check.
- Architecture/security change: brief ADR, explicit approval, threat analysis, independent review.
- High-risk/irreversible change: backup, staging/pilot, rollback strategy, human approval.

## Review checklist
1. Behavior and acceptance: unchanged unless specified; relevant edge cases covered.
2. Architecture: dependencies point inward; no duplicated rule engine in web and Android.
3. Readability: clear names, cohesive modules, predictable errors, comments for business rationale.
4. Security: minimal access, RLS/authorization, no secrets in code, data minimization, abuse cases.
5. Performance: justified hot-path changes with before/after measurements and device constraints.
6. UX: consistent shared components, keyboard/touch support, small-screen overflow, loading/errors/empty states.
7. Tests: unit/integration/end-to-end and visual baselines according to risk.
8. Operations: reproducible build, signed artifacts, migrations, monitoring, rollback.

## Evidence standard
Each PR identifies changed modules; expected/actual test output; risk and rollback; independent review findings; screenshots for meaningful UI updates; and any follow-up issues.

## Current gaps to close in phases
- Existing web uses Vite despite README saying Next.js; correct outdated docs.
- Web package scripts currently lack automated lint, formatting, component and browser tests.
- Android has RuleEngine and SectionEngine unit tests, but device/E2E coverage needs assessment.
- No visual regression baseline or static security tool gate was present when this policy was drafted.
- GitHub branch protection/settings are not verified via the connector; enable required status checks manually if available.
- A proposed CI gate must be observed as passing before making it required.
