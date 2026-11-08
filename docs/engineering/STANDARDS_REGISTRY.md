# Orbit Standards Registry — versioned and extensible

Status: **engineering policy adopted in draft PR; actual compliance must be verified separately**.
Scope: Android child app, React/Vite parent web panel, Supabase backend and CI. App Store submission is **not a project goal**.

## How to interpret status

- **Required policy**: review standard for new/revised code; enforce incrementally through objective checks and pull requests.
- **Target / phased**: desired practice; tooling or test coverage still being introduced; do not claim it already passes.
- **Reference / conditional**: relevant when changing a specific area or platform; not a universal gate.
- **Inactive**: for a future platform or distribution path; only enable by explicit decision.

| ID | Area | Reference | Status | Applied to | Reviewer / verification |
| --- | --- | --- | --- | --- | --- |
| ARCH-01 | Architecture & maintainability | SOLID principles, Clean Architecture *where useful*, KISS, DRY, cohesion/coupling, modular monolith | Required policy; progressive refactor | All code | Architect; module boundary review, ADR for breaking changes |
| AND-01 | Android architecture | [Android official architecture guide](https://developer.android.com/topic/architecture) and [recommendations](https://developer.android.com/topic/architecture/recommendations) | Required reference; phased verification | Kotlin, Compose, services | Android Architect / QA; UI/data/domain separation, single source of truth, UDF |
| KOT-01 | Kotlin style | [Official Kotlin conventions](https://kotlinlang.org/docs/coding-conventions.html), [ktlint](https://pinterest.github.io/ktlint/) | Required style; automation planned | Android Kotlin | Code Quality Reviewer; ktlint + review |
| KOT-02 | Kotlin static quality | [Detekt](https://detekt.dev/) and Android Lint | Target / phased | Android Kotlin | Code Quality / QA; static diagnostics |
| WEB-01 | TypeScript | [TypeScript strict](https://www.typescriptlang.org/tsconfig/strict.html) | Required policy; existing tsconfig strict=true | Web | Web build/typecheck, reviewer |
| WEB-02 | JS/TS lint and formatting | [ESLint](https://eslint.org/), [Prettier](https://prettier.io/) | Target / phased | Web | Code Quality Reviewer; planned CI gates |
| SEC-MOB-01 | Mobile security | [OWASP MASVS](https://mas.owasp.org/MASVS/) and MASTG where relevant | Required security reference; phased verification | Android and stored child data | Security & Privacy Reviewer; control-to-evidence checklist |
| SEC-WEB-01 | Web/API security | [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/) | Required security reference; phased verification | Web, Edge Functions, Supabase RLS | Security & Privacy Reviewer; authorization tests and threat modeling |
| ACCESS-01 | Accessibility | [WCAG 2.2](https://www.w3.org/TR/WCAG22/) (AA target) and Android/platform accessibility guidance | Target / phased | Web + Android UI | UI/UX Accessibility Reviewer; keyboard/screen-reader/contrast checks |
| APP-DES-01 | Apple interface guidance | [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/) | **Reference / conditional** only | iPhone Safari, future Apple client | UI/UX reviewer; adopt principles as relevant, not as a mandatory Android constraint |
| APP-STORE-01 | App Store review | [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) | **Inactive** | Future native Apple store distribution only | Release & Platform Reviewer if activated |
| REL-01 | Release & platform integrity | GitHub Actions least privilege, signed APK, reproducible builds, semantic-compatible versioning, rollback, staged rollout | Required policy; phased automation | Android APK, Web/Vercel, Supabase | Release & Platform Reviewer; CI logs, signing evidence, migration verification |
| LANG-01 | Technical language | English-only source identifiers, code comments, tests, PR/commit and engineering docs; user-visible strings localized | Required policy; phased legacy migration | All code and docs | Code Quality / every reviewer |
| AI-PORT-01 | Tool/model portability | AGENTS.md, repository docs, Git history, PRs; no proprietary-only memory | Required policy | AI workflows | Coordinator and independent reviewer |
| TEST-01 | Regression safeguards | Unit, integration, Android device and browser/visual tests proportionate to risk | Required policy; coverage phased | Every user-visible behavior | QA & Regression Reviewer |

## Avoid dogma
- SOLID and Clean Architecture are design heuristics, not requirements to create interfaces, use cases, layers or classes for every small function.
- Android's official guidance recommends UI and data layers, with a domain layer *when useful*; do not force identical patterns on every screen.
- The Apple review process is not a criterion for releasing this Android + web project. Apple HIG is only a design reference for platform-relevant experiences.
- Tool configurations, rulesets and standards versions should be checked against official sources before upgrade. Always test existing behavior and log exceptions.

## Extension mechanism: future standards and specialists

To add or revise a standard:
1. Propose a new unique ID in this registry. Record source URL, standard **version/date**, which modules it applies to, current/potential impact, severity and measurable acceptance criteria.
2. Choose status: required, target, conditional or inactive; name an owning reviewer. Record exceptions in a dated ADR or issue.
3. Test in a feature branch / isolated environment; collect baseline measurements and false positive rates.
4. Add incremental tooling and CI checks, initially report-only for existing technical debt; make them blocking only after fixes and review.
5. Get independent review and explicit approval before merging or touching releases.
6. Update docs/engineering/AGENT_REVIEW_ROLES.md and docs/engineering/TECH_RADAR.md; hand off next steps in PROJECT_HANDOFF.md.
7. Retire or replace a standard explicitly (do not silently delete), with migration notes.

To add a new specialist reviewer, define scope, trigger conditions, inputs/permissions, objective checks, output/evidence template, escalation and owner. It is a review policy until an implementation and validation are delivered. No agent can silently enable new production permissions.

## Review triggers
- **Every PR**: English naming, style/readability, typecheck/build/test, security-sensitive diff classification.
- **UI-related**: responsive and accessibility review; browser/mobile visual evidence.
- **Permissions, auth, child data, RLS**: MASVS/ASVS control mapping, explicit threat case and independent security review.
- **Android runtime/services**: lifecycle, time accounting, offline behavior, resource limits and device verification.
- **Release/CI/signing/schema**: independent Release & Platform review, rollback and human approval.
- **Future Apple-native target**: activate Apple-specific controls through an ADR only when actually relevant.

## Evidence
A CI success means that **those specific checks passed**, not that the project is fully compliant with MASVS, ASVS, WCAG, Kotlin/TypeScript style, HIG or App Store rules. Each control requires explicit evidence or an 'unverified' label.
