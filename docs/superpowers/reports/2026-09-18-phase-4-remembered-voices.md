# Phase 4 — Remembered voices (Session B report)

*18 September 2026. Session B execution sheet:
`docs/superpowers/specs/2026-09-18-phase-4-session-b-execution.md`. The by-hand Pixel run
(§5.6) and the `device-verify.sh` pass were not run — see §1/§6.*

## 1. Status

Done except the on-phone verification: the gate is all clear and the six screen/test steps are
green, but the Pixel was not attached (`adb` absent; `adb devices | grep -c 36091FDH30034G` = 0), so
the `device-verify.sh` pass (§6) and the seven by-hand §5.6 items (§7, for the founder) are
**not run — phone unavailable**.

## 2. What was built

Created:
- `src/screens/voiceCopy.ts` — pure `soundsLike(names)` wording for the banner/suggestion line.
- `src/screens/settings/VoicesSection.tsx` — Settings › Voices (switch, consent copy, forget-all), pure & props-driven.
- `src/screens/__tests__/voiceCopy.test.ts` — five cases for `soundsLike`.
- `src/screens/__tests__/SpeakersScreen.test.tsx` — nine tests for the row + card.
- `src/screens/__tests__/VoicesSection.test.tsx` — four tests for the Settings component.

Modified:
- `src/pipeline/types.ts` — `Speaker` gains `suggestedPerson` / `suggestedName`.
- `src/db/queries.ts` — `speakers` SELECT LEFT JOINs `people` for the suggested name.
- `src/screens/SpeakersScreen.tsx` — per-speaker "Sounds like …?" line, Yes/No, remember-on-rename, the one-time consent card.
- `src/screens/meeting/SummaryTab.tsx` — `voiceSuggestions`/`onConfirmVoices` props + the "Sounds like …" banner.
- `src/screens/MeetingScreen.tsx` — derives `voiceSuggestions` from the speakers it already loads.
- `src/screens/SettingsScreen.tsx` — mounts `VoicesSection`, reads `voices_remember`/`entitlement`.
- `src/screens/meeting/__tests__/SummaryTab.test.tsx`, `src/screens/__tests__/MeetingScreen.test.tsx` — voice-banner coverage.
- Speaker-literal fixups `tsc` demanded: `__tests__/sweep.test.ts`, `src/pipeline/__tests__/evidence.test.ts`, `src/screens/__tests__/SpeakerPicker.test.tsx`, `__tests__/minutes.test.ts`, `__tests__/summarize.test.ts`, plus one literal inside `src/db/queries.ts`.

## 3. Decisions taken

- **Join, don't fetch.** `db.speakers` LEFT JOINs `people` so a match yields a name and a miss yields `null` — the screen never sees a `people` row it can't render as a real `Speaker`.
- **VoicesSection is pure.** It takes `paid`/`remember`/`onToggle`/`onForget`/`onUpgrade`; SettingsScreen owns `entitlement()` and the `voices_remember`/`voices_prompted` keys, so the section is trivially unit-testable on its own.
- **The one-time card fires once, by design.** Gated on paid + `voices_remember` unset (`!== null`) and `voices_prompted !== '1'`; "Not now" sets `voices_prompted`, "Turn on" both sets `voices_remember` and remembers this speaker straight away — so renaming one speaker after accepting never re-prompts.
- **rename remembers for real names only.** `Speaker N` and blank names are filtered (`DEFAULT_NAME`), matching the brief's "no automatic naming" rule; the native side still answers `not_pro` on free.
- **Summary banner is paid-gated and navigates home.** `onConfirmVoices` opens the `Speakers` stack so the row already shows the suggestion.
- **`soundsLike` is its own module + unit test.** Wording is pinned by 5 cases so the banner and the row can never drift apart.
- **Screen tests use `jest.useFakeTimers()`** (matching `SearchScreen`/`MeetingScreen`/`SpeakersScreen`). `Pop` and `Switch` start an `Animated.timing` with `useNativeDriver: true` on mount, which crashes the test renderer's `findNodeHandle` path unless timers are faked; this is test-hygiene only, not a change to the components.
- **Consent copy rewrapped.** The §2.9 paragraph is copied verbatim; its line breaks were shifted in the JSX so "Nothing is uploaded and nothing leaves the phone." sits on one physical line, satisfying §5's `grep -c == 1` without altering the rendered words.
- **Pre-existing `busy` shadow left alone.** `SettingsScreen.tsx:485` shadows the file-level `busy` (`@typescript-eslint/no-shadow`, a *warning*) in the unrelated `models.map` download row. It predates Session A (present at `9750864`), has no test, and is outside Phase 4; eslint still exits 0 (0 errors). All Phase 4 files are warning-free.
- **`SoftButton` carries no `accessibilityLabel`.** Per §8's note, each Yes/No button is wrapped in a `<View accessibilityLabel={…} style={st.noShrink}>` (named style, not inline, to keep §10d eslint clean), and `SoftButton` is left unedited.

## 4. Tests

| Test file | Tests | Result | Mutants tried | Mutant result |
|---|---|---|---|---|
| `src/screens/__tests__/voiceCopy.test.ts` | 5: empty, 1, 2, 3 (`and 1 more`), 5 (`and 3 more`) | 5 pass | `names.length - 2` → `- 1` | 3- & 5-name cases fail ✓ |
| `src/screens/__tests__/SpeakersScreen.test.tsx` | 9: suggested row shows; Yes→true+reload; No→false; rename remembers (and not for `Speaker 9`/`'   '`); Turn-on writes both keys + 2× remember; Not-now writes only prompted; no card when prompted; no card when set; no card on free | 9 pass | swap Yes/No true/false; drop `rememberVoice` in rename; drop `if(!paid)`; `prompted==='1'`→`==='0'` | tests 2,3; tests 4,5,9; test 9; test 7 — all fail ✓ |
| `src/screens/meeting/__tests__/SummaryTab.test.tsx` | 4 (voice banner): paid+1 name; paid+3 (`and 1 more`); free hidden; empty hidden | 4 pass | drop `paid &&`; pass `voiceSuggestions.slice(1)` | test 3; tests 1,2 — fail ✓ |
| `src/screens/__tests__/MeetingScreen.test.tsx` | 1: nulls filtered → `['Priya','Ravi']`; `onConfirmVoices` navigates to Speakers | pass | drop the `filter` | `['Priya','Ravi',null]`, test fails ✓ |
| `src/screens/__tests__/VoicesSection.test.tsx` | 4: paid row + switch; free row + paywall; consent text verbatim; Forget confirm dialog | 4 pass | invert `paid ?` label; remove Forget `onPress` | tests 1,2; test 4 — fail ✓ |

Jest total (gate `js`): **546 passed, 546 total**, incl. the 23 new Phase 4 tests above.

Kotlin: unit JVM tests ran in the gate's `kotlin` stage (`OK`) — `SchemaTest` **19**, `PeopleMatchTest` **2** (the brief §5.1 counts). Instrumented device suites — `PeopleDbTest` (3/3) and the `NativePipelineTest` seam `speaker_voices_returns_one_row_per_speaker` — were run by Session A; this cycle they are **not run** (see §6).

C++: ctest **29/29 passed** (gate `cpp`, 27 s), including `test_voices_live` (#12, 3.55 s). That test prints the four match cosines; this cycle ctest ran `-q` so no per-test stdout was captured — the values are the brief's 17 Sep measurement (plan line 15): **same-person across meetings 0.79–0.88**, **strangers ≤ 0.50** (max different-person).

## 5. Gate

`GATE_STAGES="types js scans mutations kotlin cpp" bash scripts/gate.sh` (full run, `/tmp/gate.log`):

```
==> types   ok  types (3s)
==> js      ok  js (7s)        # 546 passed
==> scans   ok  scans (4s)
==> mutations ok  mutations (63s)
==> kotlin  ok  kotlin (3s)
==> cpp     ok  cpp (27s)
gate: all clear in 107s            # exit 0
```

## 6. Device

Not run — phone unavailable. `adb` is not on PATH and
`adb devices | grep -c 36091FDH30034G` returns `0`; Metro was not started and no
`am instrument` runs were fired. The expected probe values (from the execution sheet §5.6 / brief §5.5)
are listed against each item but were **not observed**:

1. Settings › Voices › turn *Remember voices* on — *probe: nothing yet* — not run.
2. Record meeting 1 (40 s `say -v Samantha`); rename "Speaker 1" → **Sam** — *probe: people count 1, that speaker `has_voice=1`; card must NOT appear* — not run.
3. Record meeting 2 (40 s Samantha) — *probe: `suggested_person` set; Summary banner "Sounds like Sam — confirm?"; tap Yes → row "Sam", probe `samples=2`* — not run.
4. Record meeting 3 (40 s `say -v Daniel`) — *probe: `suggested_person` null; no banner* — not run.
5. Turn *Remember voices* off, run `VerificationVoicesTest#resetTheVoicePrompt`, rename meeting 3 "Speaker 1" → **Dan** — *probe: card "Remember this voice?" appears; on Turn on, `voices_remember=1`/`voices_prompted=1`; a second rename shows no card* — not run.
6. Settings › *Forget all voices* › *Forget* — *probe: people count 0, every `has_voice=0`; record meeting 4 Samantha → no suggestion* — not run.
7. End trial (`VerificationVoicesTest#endTheTrial`) — *probe: row reads "Remember voices (Pro)", no switch, tap opens paywall; Forget all voices still present* — not run.

## 7. For the founder to test by hand

Run these on a Pixel with Verbale in trial (these are the §5.6 steps the session could not execute):

1. **Start a trial** (Settings › your account) so *Remember voices* is reachable. **Look for:** Settings › Voices shows "Remember voices" with the switch off.
2. **Turn *Remember voices* on.** **Look for:** the consent card's exact body (brief §2.9) and the *Not now* / *Turn on* buttons; nothing is uploaded.
3. **Record a 40 s meeting with `say -v Samantha`**, wait for `status=done`, then on the Speakers screen rename "Speaker 1" to **Sam**. **Look for:** the one-time *Remember this voice?* card — note its title, body, and the two buttons — then tap **Turn on**. **Probe:** `people count 1`, that speaker `has_voice=1`. Because the setting is now on, the card **must not** reappear on this speaker.
4. **Record a second 40 s Samantha meeting**, wait for processing. **Look for:** the Summary tab banner *Sounds like Sam — confirm?* and the Speakers row *Sounds like Sam?* → tap **Yes**. **Look for:** the row now reads "Sam"; probe `samples=2`.
5. **Record a 40 s `say -v Daniel`** meeting. **Look for:** no suggestion — probe `suggested_person` null, no banner, no "Sounds like" line on the Speakers screen.
6. **Forget.** Settings › *Forget all voices* › **Forget**. **Look for:** probe `people count 0` and every `has_voice=0`. Record a short Samantha meeting → **no** suggestion appears.
7. **End the trial** (`VerificationVoicesTest#endTheTrial`). **Look for:** the row now reads **Remember voices (Pro)**, the switch is gone, tapping the row opens the paywall, and *Forget all voices* is still present; then start the trial again to restore the switch.

## 8. Known gaps and cosmetic leftovers

- The by-hand Pixel run and both `device-verify.sh` suites were not executed this cycle (§1/§6); they passed in Session A. Re-run before the production build.
- No per-person management UI (rename one person, delete one person) — out of scope (brief §8); only forget-all exists.
- The `VoicesSection` row's `rowPad` matches SettingsScreen's `{ padding: s(16) }`; with two children (the row and the Forget button) the Forget button carries no extra vertical margin in the mock — verify on the Pixel and add `mt` if it butts the row.
- The `noShrink` wrapper on Yes/No replaces the spec note's inline `{{ flexShrink: 0 }}` purely for lint; SoftButton itself has no `flexShrink` guard, so keep the wrapper if labels ever clip.
- Pre-existing `@typescript-eslint/no-shadow` warning on `busy` at `SettingsScreen.tsx:485` (models download row), untouched — see §3.
- `test_voices_live` cosines not reprinted this cycle (ctest `-q`); values are Session A's.

## 9. Commits

Session A (native and data), oldest first:

- `9714c18` — feat(voices): AudioDb voice functions + ProcessingEngine diarize hook
- `4db7970` — feat(voices): StorageModule methods + NativeStorage + queries wrappers + jest stubs
- `a5704e5` — test(voices): PeopleDbTest + NativePipelineTest seam + VerificationProbeTest extension
- `9750864` — review(voices): Session A checked — a tie refuses, indentation, and the builder's worktree kept out of the gate

Session B (screens, by hand, report):

- `7363106` — docs(voices): Session B as an execution sheet, and two verification levers for the by-hand run
- `80f2bf5` — feat(voices): the speakers query joins the suggested person; soundsLike copy
- `38f6fa1` — docs(voices): tick Step 7 in progress file
- `6957ef9` — feat(voices): SpeakersScreen — "Sounds like Priya?", Yes/No, remember on rename, the one-time card
- `a9f4cba` — docs(voices): tick Step 8 in progress file
- `63e9052` — feat(voices): the Summary tab's "Sounds like …" banner, from the speakers MeetingScreen already loads
- `a2f30b5` — docs(voices): tick Step 9 in progress file
- `047bf9b` — feat(voices): Settings › Voices — the switch, the consent text, forget all
- `67af6b8` — chore(voices): gate all clear; device tests skipped (phone unavailable)
- *(this report)* — docs: Phase 4 report — remembered voices done
