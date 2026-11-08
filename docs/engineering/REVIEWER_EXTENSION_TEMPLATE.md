# Specialist Reviewer Definition Template

Add new reviewer roles without relying on a specific AI provider, model, or agent runtime.

## Identity
- Role ID:
- English role name:
- Scope / relevant code paths:
- Standards registry IDs:
- When this reviewer is required:
- Inputs (minimal diff, task/spec, docs, test results):
- Allowed operations (read-only by default):
- Disallowed operations (e.g. production secrets, device controls, auto-merge):
- Automated checks that support this role:
- Manual checks that cannot be delegated:
- Required outputs: Finding ID, evidence (file + line/test), severity, proposed fix, verification and residual risk.
- Escalation threshold / human approval needed:
- Model-agnostic implementation notes:
- Initial validation task and result:
- Date / decision / owner:

## Upgrade process
1. Propose and review the reviewer spec.
2. Run against a known safe code sample and a controlled defective sample.
3. Compare false positives, missed defects and costs.
4. Integrate into PR review only after sufficient evidence.
5. Log all decisions in Git and update the handoff.
