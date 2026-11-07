# Orbit Technology Radar — controlled adoption

Aim: stay aware of emerging engineering methods without disrupting the running system. "New" is not equivalent to "better".

## Watch categories
- Agent orchestration and portable context (Claude, Codex, Hermes, OpenCode and alternatives).
- Local/free inference (Ollama, open weights, provider compatibility and data privacy).
- Android/Kotlin/Compose, React/TypeScript/Vite, Supabase/Postgres security and deprecations.
- Mobile/web testing, visual regression, static analysis, dependency/supply-chain checks.
- New OWASP security recommendations, Android policy/API changes and GitHub Actions hardening.

## Decision stages
1. **Observe**: source, version, release date, problem it solves.
2. **Assess**: verified benefit, compatibility, pricing/license, privacy and maintenance cost.
3. **Trial**: isolated branch/worktree; representative Orbit test scenario; no production access.
4. **Adopt**: written ADR, reproducible setup, automated test, independent review, human approval.
5. **Hold/Reject**: explain reason and revisit trigger.

## Never auto-adopt
- New AI tools must not obtain production service_role tokens, APK signing secrets, child media or remote device commands by default.
- Experimental frameworks and major dependency versions do not automatically merge.
- Rollback plans and test baselines are mandatory for changes to device policy, duration accounting, schema or CI releases.
- Every adopted tool must support documented export/migration to avoid vendor lock-in.

## Review cadence
- Dependabot proposes dependency and Actions updates (never auto-merge).
- Periodic human/AI technology watch reports only material, actionable changes with primary links and an Orbit-specific impact statement.
- Compare candidates to current solution; don't chase tool announcements without demonstrated gains.
- Record accepted/rejected proposals in project ADRs and this radar.
