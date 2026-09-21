# Device fit — progress

Against `259ab72`, spec `docs/superpowers/specs/2026-09-21-device-fit-execution.md`.

## Steps

- [x] Step 1 — the two gates read the one fact (65ec0cc)
- [x] Step 2 — the rows say it, the download refuses it, the engine will not load where it would crash (d911ff8)
- [x] Step 3 — the pure helper the screens share (b3453d9)
- [x] Step 4 — onboarding: the sentence instead of the switch (96a30c4)
- [x] Step 5 — the Pro screen: "Not on this phone" on the two rows it cannot keep (c35116b)
- [x] Step 6 — Settings: the sentence instead of Get (ffd0b78)
- [x] Step 7 — the Summary tab: the phone before the model (4483865)
- [ ] Step 8 — the Ask screen and the meeting say the same processor sentence
- [ ] Step 9 — the probe, the device, the gate, the report

**End of Run A.** Run B starts at Step 5.

## Decisions

- Step 4: the spec's own literal code for OnboardingScreen.tsx, applied verbatim, prints
  `grep -c "writerBlocked[^R]"` → `6` (spec says `8`) and `grep -c "spaceShort\|cpuReason"` → `6`
  (spec says `7`). Traced by hand: lines like `{writerBlocked` (the ternary's `?` on the next line,
  exactly as the spec's own snippet has it) end the line right after the identifier, so
  `[^R]` never matches them — true of the spec's given code too, not just this transcription.
  Treated as an arithmetic error in the spec's narrative, not a stop condition: the formal §4 check
  (`tsc --noEmit` → `0`) passes, `unsupportedReason` count in this file is `1` as §5 expects, and
  the code is byte-for-byte what §2 Step 4 specifies. Did not alter the code to chase the stated
  count.
- Step 5: same kind of mismatch. The spec's own literal code for PaywallScreen.tsx prints
  `grep -c "spaceShort"` → `3` (spec says `4`). The fourth occurrence the spec is counting is
  `setSpaceShort(...)` in part (e) — `setSpaceShort` contains `SpaceShort` (capital S), not the
  lowercase `spaceShort` the pattern requires, so a case-sensitive grep never counts it, verbatim
  spec code or not. `writerBlocked[^R]` → `4` as expected. `tsc --noEmit` → `0`. Not a stop
  condition, same reasoning as the Step 4 note above.

## Mutants

- Step 3, `deviceFit.ts` `runnable`: `!m.unsupportedReason` → `true` — 1 failed, restored.
- Step 3, `deviceFit.ts` `writerBlockedReason`: `?? null` → `?? ''` — 1 failed, restored.
- Step 3, `deviceFit.ts` `sizeMb`: `/ 1e6` → `/ 1e5` — 1 failed, restored.
- Step 3, `deviceFit.ts` `spaceFits`: `>=` → `>` — 1 failed, restored.
- Step 7, `SummaryTab.tsx` `setReason` order: `!capable ? 'weak-device' : !available ? 'no-model'`
  → `!available ? 'no-model' : !capable ? 'weak-device'` — 1 failed, restored.

## Notes
