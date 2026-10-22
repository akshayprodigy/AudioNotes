# Calm Library and Settings: build report, 22 Oct 2026

## A. Session A (Steps 1-5)

Commits:
- 498fadc feat(library): the strip's third cell on Pro is the open actions
- 0729150 feat(library): the header holds only Search and Settings; actions live in the strip
- 9d3f127 feat(record): "Or import a recording" moves here from the Library header
- c19cbc5 feat(setup): activeDownloads - every model download in flight, by what it is for
- bf3c6f7 feat(library): every download in flight shows on the front page, by what it is for

Gate (`GATE_STAGES="types js scans" scripts/gate.sh`): `gate: all clear in 18s`.

Mutants (each restored afterwards):
- Step 1, `'action'` to `'actions'` for one: killed ("says one action, not one actions").
- Step 2, `openActions={null}`: killed (on Pro the strip counts the open actions; buying Pro is noticed; Pro sees no allowance line).
- Step 3, delete the import Pressable: killed (Record offers an import).
- Step 4a, `>=` to `>` on finish: killed ("forgets it the moment it finishes").
- Step 4b, drop `!d.required &&`: killed ("shows only what the setup card does not").
- Step 5, delete `<DownloadsStrip />`: killed ("a download started anywhere shows on the library").

Deviations:
1. Step 2(e): the sheet says seven import tests share the replace pattern; six matched. The seventh,
   "a stale zero does not shut the picker", sets the allowance store between render and press, so a
   mount-time `importNow` would run before the stale zero. It now renders without params, sets the
   stale state, then `tree.update(...)` with `importNow: 1`.
2. Step 2: two existing tests asserted the old header and failed once it changed. "paid keeps the
   outstanding-actions card and the plain Actions label": the header `Actions` expectation went from
   1 to 0. "Pro sees no allowance line": the strip text is now
   `'1 meeting saved. 10 min captured. 0 open actions. Open the action tracker.'`.
3. Step 5: `ModelManager.list` is reached via the file's existing `ModelManager` import, not
   `__TEST_NATIVE_MODULES__`; the `texts` helper was copied into the describe.
4. Step 2(c): `row.findAll(..., { deep: false })` returned exactly the two labels; no Set needed.
