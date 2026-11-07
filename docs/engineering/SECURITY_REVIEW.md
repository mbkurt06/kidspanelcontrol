# Orbit Security Review Playbook

**Scope:** Android Device Owner application, parent web panel, Supabase/Postgres/Edge Functions, CI/release automation.
Security review is evidence-based. A role-playing "security agent" is not a security certification or penetration test.

## Critical trust boundaries
- Parent identity and child pairing: prevent cross-family read/write and replay of pairing tokens.
- Supabase schema: verify row-level security and roles in **live database**, not only in migration source.
- Edge Functions: verify authenticated caller, authorization to target child, service-role access scope.
- Android: device-owner restrictions, dangerous permissions, intents, exported components, on-device secret storage.
- Web: authentication persistence, route/data authorization, XSS, CSP, file upload/media permissions.
- Offline and sync: stale rules, duplicate commands and rewards, clock manipulation, conflict resolution, fail-safe behavior.
- Supply chain: Gradle/npm packages, Actions permissions, signing material, updating APK on child devices.
- Child privacy: retain only necessary photos/audio/screen captures, access controls, retention and deletion.

## Required reviewer artifacts
- Finding ID, severity (P0/P1/P2/P3), affected file/endpoint, reproducible evidence, business impact.
- Proposed smallest safe fix, test reproducing the risk, rollback and migration effect.
- Explicitly label 'not checked' or 'requires manual device/cloud testing' when applicable.
- Never write or paste real passwords, tokens, private child media, or raw production records into AI prompts.

## Baseline observations (2026-11-08 — source only; not comprehensive)
- Repository is private. GitHub CodeQL code scanning and some hosted secret-scanning features can require paid GitHub security entitlements for private repositories. Do not assume they run.
- web/.env.production and web/.env.development are **tracked**; the checked values appear to be publishable Supabase client config, not service-role secrets. Verify all tracked config before broader sharing; moving future secrets to GitHub/Vercel/Supabase secret stores remains mandatory.
- android/app/build.gradle.kts contains a Supabase **publishable** key, expected to be public; this is not a secret by itself. Server authorization and RLS must not rely on hiding it.
- GitHub's Android workflow has permissions: contents:write, publishes releases after a main push and can request child app updates. Review action-token scope and dispatch behavior before any CI/refactor changes.
- The release build config conditionally uses a debug signing config when a release keystore is missing. Existing CI only publishes when the signing step marks success, but avoid accidental debug-signed releases or local distribution; assess explicitly.
- Test presence does not prove test success: CI outputs have not been verified in this audit.

## Scan program
- Automated: PR secret scan, TypeScript build, npm dependency audit signal; Android unit tests via existing Android PR workflow when android paths change.
- Next phase: add staged Kotlin lint (ktlint/Detekt), JS lint+format, selected SAST, Supabase RLS/SQL integration tests, browser/Android UI regressions and local device checks.
- Private GitHub repo: avoid designing a mandatory CI gate around a paid feature without confirming entitlement.
- External AI scans should use minimized/redacted samples, not the full private repository by default.

References:
- https://mas.owasp.org/MASVS/
- https://asvs.owasp.org/
- https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/configure-code-scanning/configure-code-scanning
