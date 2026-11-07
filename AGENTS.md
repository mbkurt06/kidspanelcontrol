# Orbit — Agent Contract (tool-independent)

Read this file before changing any code, regardless of provider (Claude, Codex, Hermes, OpenCode, local models, or future agents).

## Source of truth and boundaries
- Source code, committed specs, tests, and Git history are authoritative. A model's chat history, memory, or self-reported success is not.
- Read docs/engineering/PROJECT_HANDOFF.md and relevant requirements before working.
- Never invent test results, deployments, live device state, permissions, or requirements.
- Work in a dedicated feature/repair branch or worktree; do not push directly to main.
- Inspect git status and diffs before changes. Preserve unrelated edits and existing functionality.
- Do not change production credentials, Vercel settings, Supabase production migrations, APK signing, device permissions, or device update flows without explicit approval.
- Do not change active release workflows or trigger a device release as a side effect of a refactor.

## Change protocol
1. State the user-visible behavior and acceptance criteria.
2. Identify Android, Web, Supabase, and CI impacts, including offline synchronization and data migrations.
3. Run relevant existing tests **before** a refactor; add regression cases for critical behavior.
4. Change one cohesive module/feature at a time; avoid speculative abstractions and unrelated cleanup.
5. Run relevant build, tests, lint, and security checks. Record exact commands and outcomes.
6. Seek independent review for security, policy, cross-layer, or high-risk changes.
7. Update the handoff with facts from Git and test logs; identify remaining risks and next step.
8. Submit a pull request. No autonomous merge or deployment.

## Quality rules
- Prefer explicit, readable, typed functions and small cohesive modules. No class for its own sake.
- Comments explain **why**, invariant, platform limitation, or non-obvious security decision—not every line of obvious code.
- Shared UI behavior belongs in reusable components; verify desktop and mobile states.
- Keep authorization at the server/database boundary. A client-side check is not authorization.
- For time accounting: profile selection must not rewrite previously consumed seconds; check against documented rules and tests.
- For tasks/rewards: prevent duplicate grants on retry; make idempotency clear.
- For Android enforcement: verify behavior without network and on clock/timezone changes.
- Never expose real children, private media, passwords, or tokens to third-party LLMs.

## Mandatory English-only engineering language
- **All source-code identifiers and technical comments MUST be in English:** variable names, function and method names, class/interface/type/enum names, constants, database identifiers, test case names, code documentation (KDoc/JSDoc), commit messages, PR descriptions, engineering documentation, and log messages.
- Use clear domain-specific names, never transliterated Turkish such as `sure`, `gorev`, `kullanici`, or abbreviated names without a conventional meaning. Prefer `remainingTimeSeconds`, `taskReward`, `parentAccount`.
- Follow official language conventions: Kotlin/TypeScript `lowerCamelCase` for values/functions, `UpperCamelCase` for classes/types/React components, `UPPER_SNAKE_CASE` for true compile-time constants when idiomatic; PostgreSQL identifiers `snake_case`. Conventional acronyms only.
- Make every variable's unit and state explicit where ambiguity is costly: `elapsedSeconds`, `dailyLimitMinutes`, `isDeviceLocked`, `pendingCommands`. Avoid `data`, `temp`, `flag` or single-letter identifiers outside a tiny well-understood local context.
- Avoid literal line-by-line explanation; explanatory comments describe WHY, invariants, constraints, tradeoffs, or non-obvious behavior **in English**.
- User-facing text may be Turkish or another localized language, but keep it in translation resources / UI localization structures; never put Turkish words into technical identifiers or code comments. Do not translate user-visible Turkish text into English as an incidental refactor.
- Do not mass-rename existing identifiers or comments merely to satisfy this policy; plan incremental, test-backed modernization. Schema/API/serialized key changes require compatibility and migration review.

## Agent portability
- CLAUDE.md points to this document; other tools must also read AGENTS.md.
- Model/provider/agent configuration is replaceable; no single proprietary memory store is the source of truth.
- Use docs/engineering/PROJECT_HANDOFF.md for unfinished work and Git status.
- Follow docs/engineering/QUALITY_POLICY.md and SECURITY_REVIEW.md for review gates.
- A human approves releases and major architectural changes.
