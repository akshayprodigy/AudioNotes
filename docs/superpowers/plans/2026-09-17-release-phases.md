# Release phases — what ships before the production build

*17 September 2026. The founder's 15 Sep decision stands: every partly-done or not-built item of
the improvement report is finished before the production build (except audio-file encryption,
which stays on Android FBE, and Hindi, which stays hidden). This is that work as phases, in
order, each one a spec → plan → code → Pixel run → docs cycle. The store-side items (Play
Console product, listing, website, staged rollout) are the founder's and run in parallel; they
are not phases here.*

| Phase | What | State |
|---|---|---|
| 1 | **Prove 4 and 5 on the Pixel.** Typed record + review queue; ask this meeting + meaning search. | **Done 17 Sep** — two phone-found fixes (`564431f`, `dd214e2`); three spot-checks listed in the ask spec |
| 2 | **Meeting templates** (sub-project 6a). Meeting types — stand-up, 1:1, client, interview, lecture, site walk — as prompt and section variants for the narrator, auto-suggested from the transcript, changeable on the Summary tab, remembered per tag. | **Done 17 Sep** — built by a Sonnet session from its brief; reviewed the same day (report §10): one phone-shape defect fixed (`foldSections`, Pixel 16/16), the suggester's threshold left for the founder to calibrate; the by-hand run (report §7) is the founder's |
| **3** | **Thread memory — decision history + preparation** (sub-project 6b). A thread is the meetings that share a tag; a Pro screen shows what is still open across them, the decisions in order with "changes: …" links found by a rule over the existing item vectors, and the meetings. No generated text. Founder's shape and Pro-only decision of 17 Sep; brief: `docs/superpowers/specs/2026-09-17-phase-3-thread-memory-brief.md`. | **Next** — brief written 17 Sep |
| 4 | **Remembered voices** (sub-project 7). A `people` table with a voice centroid per named person from the diarization embeddings already computed; "Sounds like Priya?" next meeting. Consent copy written before it ships (voice = biometric under GDPR Art. 9 / BIPA). | After 3 |
| 5 | **Custom vocabulary + dictation** (sub-project 8). A local glossary biasing the recogniser and the narrator; corrections feed it; a separate dictation mode (one voice, no diarization, punctuation commands). | After 4 |
| 6 | **The no-internet build decision, and the release gate** (sub-project 9). Measure what the INTERNET permission buys (model download, licence refresh, Crashlytics) against a build without it; decide; then the final full gate on both phones and the production build. | Last |

**Rules that hold across every phase:** one spec and one plan per phase; TDD; every new test
mutation-checked; the Pixel run before "shipped"; the founder pushes; a phase's spec lists any
decision taken in the founder's absence in a §0, to overrule.

**Open device gates carried into Phase 6's final run** (from the launch list): the consent
clip's level fix re-run on a phone; the 90-minute meeting's diarization memory; a third,
non-Pixel non-Samsung phone (MIUI) end to end.
