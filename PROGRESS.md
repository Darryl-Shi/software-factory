# Progress (bundles build, run run-mv4ghzj2-allm)

Spec: docs/spec.md (bundles). Notes for myself.

## Decisions
- Legacy runs: on startup, non-terminal runs without `flowVersion` that had begun delivering (DELIVERING, AWAITING_CI,
  AWAITING_APPROVAL(merge), ESCALATED from AWAITING_CI, or a delivery artifact) get `legacy: true`; all get flowVersion 2.
  Legacy runs keep the old DELIVERING/AWAITING_CI/merge-gate path.
- FAILED bundles keep their members (they can't be shipped elsewhere) until retried or cancelled; cancelBundle is
  allowed on FAILED to release them.
- There is no intake in the code (superseded); "writeBack" = the run's final notice. Noted in DEVIATIONS.
- Integrator: Coding + TestRunner + WebSearch (no subagent), write sandbox like the builder; report_done.
- Ticket key (PROJECT-N) is computed by the core for BundleMember the same way the UI does.
- Pre-existing failures: test/sandbox*.test.ts (bubblewrap can't run in this host). Not caused by this change.

## Status
- [x] types.ts
