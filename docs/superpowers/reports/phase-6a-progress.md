# Phase 6a — progress

Execution sheet: `docs/superpowers/specs/2026-09-21-phase-6a-internet-decision-execution.md`.

- [x] Step 1 — the frame
  - Notes: progress file + brief skeleton created.
- [x] Step 2 — the inventory (measured)
  - Notes: egress check exit=0 (203 files); 3 enforced call sites + Crashlytics (uncounted) + Play's own connection (uncounted); token lifetime not in read list, flagged to verify; §1.1 monthly bytes are estimates per the sheet's own "≤200 bytes/field" rule.
- [x] Step 3 — what the permission buys, and what its absence looks like today (measured)
  - Notes: quoted the three offline-failure screens verbatim; token lifetime gap flagged again (2.2); 3 files import telemetry/crash, matches the sheet's expected count.
- [x] Step 4 — the permission-less build: what replaces each (supplied + judgement)
  - Notes: found recordError is never called today (crash.ts doesn't re-export it) — the JS-crash "loss" under Vitals is currently null, not the loss the sheet assumed; email sign-in's user base not found in the design doc's read range (grep came back empty) — flagged to verify with the founder.
- [x] Step 5 — the options and their cost (judgement, sized)
  - Notes: §4-§6 written; §0 summary written now (ahead of Step 6's verify pass, still "written last" relative to §1-§6).
- [ ] Step 6 — verify the brief against its own rules
  - Notes:
- [ ] Step 7 — report and hand-over
  - Notes:
