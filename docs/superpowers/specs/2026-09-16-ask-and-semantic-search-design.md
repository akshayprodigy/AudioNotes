# Ask this meeting, and search by meaning

*Sub-project 5 of the improvement-report work. 16 September 2026. Written while the founder was
away ("do all the developments that you can, we will do the testing tomorrow"), so the decisions
below were taken by the author and are listed first for the founder to overrule. The prior
decisions stand: English only; interpretation is Pro (a free user has no model weights on disk);
nothing leaves the phone.*

## 0. Decisions taken in the founder's absence

1. **A small embedding model is added to the Pro download**: `bge-small-en-v1.5` (BAAI, MIT
   licence, 33 M parameters, 384-dimensional, English), the `q8_0` GGUF from
   `CompendiumLabs/bge-small-en-v1.5-gguf` — 36.8 MB, sha256
   `ec38e8da142596baa913124ae50550de284b6916bf59577ef2f0cb9660c2f514`. It runs through the
   llama.cpp already in the app. It is catalogued as `kind = "llm"` so that every rule that
   gates, offers and downloads "the writer" carries it along without a second list: the Pro
   bundle becomes 1.1 GB + 37 MB.
2. **Search is hybrid, not a toggle**: one result list, keyword hits and meaning hits fused
   (reciprocal rank fusion). A hit found by meaning alone wears a small "≈" mark. Nobody has to
   decide which kind of search they want before typing.
3. **Ask is per meeting**, reached from the meeting's header. Not a global inbox — the founder's
   list says ask-*this*-meeting, and the global case is the same machinery over more rows,
   which can come later without redesign.
4. **Every answer must point at the transcript.** The model is handed at most eight numbered
   passages and may answer only from them, citing `[n]`; an answer with no valid citation is
   not shown as an answer. What is shown instead is "Nothing in this meeting settles that" over
   the closest passages, which is still useful and never invented.
5. **Questions and answers are kept**, in an `asks` table, deleted with the meeting. The privacy
   ledger already names "questions" as inside the boundary; the answer is a derived document
   like the summary, and people re-read what they asked.
6. **Ask and the writer do not run at once.** The 1.5 B model resident twice is an OOM on a 3 GB
   phone. While the processing service is narrating, Ask says so and offers to try again.
7. **The two known search defects are fixed on the way** (§7): every rule decision indexed
   twice, and a backlog reported as "1 to go" for any size.

## 1. What this builds

Two things a Pro user can do with a processed meeting that they cannot today:

- Type "what did Rahul push back on" into Search and find the turn where he did, although
  neither *push* nor *back* was said.
- Open a meeting, tap **Ask**, type "did we agree on a date for the proposal?", and read a
  two-sentence answer that cites the turns it came from, each one tappable and playable.

Both are offline, both are Pro, and both come from the same index.

## 2. The embedding engine (C++)

`cpp/llm/embed_engine.{h,cpp}` — `EmbedEngine::load(path, n_threads)`, `embed(texts) →
vector<vector<float>>`, L2-normalised, `dim()`. llama.cpp with `embeddings = true`, pooling as
the GGUF declares (CLS for bge), `n_ctx = 512`, `n_batch` = the longest text; texts longer than
the context are truncated at the tokenizer, never rejected. Built under `HAVE_LLAMA` like the
writer; `ok()` false when the model did not load. JNI: `nativeEmbedLoad(path, threads)`,
`nativeEmbedTexts(handle, texts[]) → float[]` (flat, `dim * n`), `nativeEmbedDim(handle)`,
`nativeEmbedFree(handle)`.

Tested on the Mac with the real GGUF (`cpp/tests/test_embed.cpp`, skipped when the file is
absent): "the proposal is due on Friday" is closer to "when do we deliver the pitch" than to
"the coffee machine is broken"; two calls agree to 1e-5; the vector is unit length.

## 3. The index

**Chunks** (`SearchChunker.kt`, pure, tested): consecutive utterances merged into windows of up
to 100 words; a window never crosses a gap of more than 30 s; a single utterance longer than the
limit is its own window. Each chunk keeps `start_ms`, `end_ms`, the first utterance id and the
speaker id of its first line. The embedded text is **the words only** — no speaker names, no
stamps — so a rename never invalidates a vector. Items (`review <> 'rejected'`) are one chunk
each; the narrated summary is one chunk.

**Storage** — `search_vec(meeting_id, kind, ref_id, start_ms, end_ms, speaker_id, text, hash,
vec BLOB, model)`, `kind ∈ {turn, item, summary}`; `hash` is the FNV-1a of `text`, and a row is
re-embedded only when its hash is new. Vectors are stored **int8 with one float scale per row**
(`VecCodec.kt`: 384 bytes + 4, a unit vector quantised symmetrically; cosine recovered as
`Σ q_i·d_i·scale`) — 20 000 chunks are 8 MB, scanned in Kotlin in tens of milliseconds. The
table has no foreign key, like `search_fts`; `deleteMeeting` and `reindexMeeting` delete its
rows explicitly. `meetings.embedded_at` (nullable, both schema mirrors) says the meeting's
current chunk set is fully embedded; every writer of transcript, items or summary sets it NULL
(`replaceUtterancesJson`, `replaceItems`, `replaceMinutes`, `reindexMeeting`, the classifier).

**When it runs** — `Embedder.fill(ctx, meetingId)`: computes the chunk set, deletes vec rows
whose hash is gone, embeds the missing ones, stamps `embedded_at`. Called (a) as the new
`EMBED` stage in `ProcessingEngine`, after narrate, Pro only, progress through `onStage("embed",
done, total)` with the thermal pause between batches of 16; (b) from the JS sweep's new
`db.backfillEmbeddings(limit)`, which fills up to `limit` meetings with `embedded_at IS NULL`
and returns the true remaining count — the older library catches up across app opens, newest
first, like the FTS backfill. Not entitled or no model on disk → `fill` returns without
touching anything and the sweep stops asking. `ResumePlan` does not know EMBED: a meeting
without vectors is complete, not resumable — the sweep is the retry.

## 4. Retrieval

`Retriever.kt` (pure over inputs, tested): `fuse(keyword: List<Hit>, meaning: List<Hit>, k =
60)` — reciprocal rank fusion on `(meeting_id, kind, ref_id)`; a hit present only in `meaning`
is marked `byMeaning = true`. `AudioDb.searchJson(term)` becomes: FTS as today (top 120) plus,
when the embedding model is loaded, the query embedded and the top 40 cosine matches over
`search_vec` — fused, top 60 returned. A meaning hit carries the chunk text as its snippet
(no term to highlight). `meetingId` narrows both to one meeting for Ask.

The embedding model is held by a process-wide `EmbedRuntime` (Kotlin object: load on first
use, keep resident — it is 37 MB — free on `onTrimMemory`). Without a subscription or the file
it is never loaded and search stays keyword-only, exactly as it is now.

## 5. Ask

`Asker.kt`: `ask(ctx, meetingId, question) → Answer(text, cites: List<Cite>, passages)`.

1. Gate: entitled (else `NOT_PRO`), writer + embed models on disk (else `NO_MODEL`), 3 GB RAM
   (`Narrator.capable`), processing service idle (else `BUSY`).
2. Retrieve the meeting's top 8 chunks for the question (§4, fused). None → `NOTHING`.
3. Build the prompt in C++ (`cpp/minutes/ask.{h,cpp}`, `askPrompt(question, passages)`): the
   passages numbered `[1]`…`[8]`, each "`[n] Speaker (m:ss): words`", both the passages and the
   question through the fence helper (`check-prompt-fencing.py` keeps them there); the
   instruction: answer in at most three sentences from the passages only, cite each claim as
   `[n]`, say "Nothing in this meeting settles that" when they do not answer it.
4. Generate with the resident writer handle (loaded on first ask in the session, `N_CTX 4096`,
   greedy, repeat penalty 1.15, ≤ 200 tokens), through `LlmModule`'s thread.
5. Validate in C++ (`validateAnswer(text, n) → {text, cites[]}`): citations outside `1..n` are
   removed from the text; an answer that then has no citation, or that contains the model's
   own refusal phrase, is `NOTHING`. Cites are de-duplicated in order of first mention.
6. Store `asks(id, meeting_id, question, answer, cites_json, asked_at)`; return.

`AskScreen` (stack route `Ask: {meetingId}`, header "Ask" button on the meeting — icon `chat`,
new in `Icon.tsx` — and a row in the More sheet): the thread of past asks for the meeting,
newest at the bottom; each answer with its citation chips "`[1] Priya · 12:05`" which navigate to
the meeting's transcript at that moment (`Meeting {tab:'transcript', atMs}`); a `NOTHING` answer
shows the phrase over the three closest passages as the same chips. A text box and a send
button at the bottom; "Thinking…" while it runs; `NOT_PRO` opens the paywall, `NO_MODEL` says
which model Settings is missing, `BUSY` says the writer is busy with a meeting. Free users see
the Ask button; it opens the paywall, the same way the summary's "Write it" does.

The writer handle is released when the Ask screen unmounts (`Llm.unload`), so a person who
asked one question and went back does not hold 1.1 GB.

## 6. Search screen

Unchanged in shape. Each row can carry `byMeaning`; those rows show a small "≈" before the
snippet with accessibility label "found by meaning". The meaning hits' snippet is the chunk's
first 120 characters. The empty-state copy gains one line for Pro users whose library is still
embedding: "Meaning search covers N of M meetings so far" (from the backfill count), and for
free users nothing changes.

## 7. The two defects fixed on the way

- **Duplicate cards**: `indexMinutes` indexes every `minutes` row except the summary — and the
  rule decisions, actions and questions live in `items` too, so each was a card twice. Fix:
  `indexMinutes` indexes only kinds not in `ITEM_KINDS` when the meeting has rule items
  (`hasRuleItems`), and all kinds when it does not (an unmigrated meeting).
- **"1 to go"**: `StorageModule.backfillSearch` resolves `unindexedMeetings(1).size`. Fix: an
  `unindexedCount()` beside it, the same predicate once, like `unmigratedCount`.

## 8. Tests

Every new test mutation-checked.

- C++ `test_embed` (Mac, real GGUF, skipped if absent), `test_ask` (`askPrompt` numbered and
  fenced; `validateAnswer` strips `[9]` of 8, keeps `[2]`, de-duplicates, flags no-citation
  and the refusal phrase as `NOTHING`); `check-prompt-fencing.py` sees `askPrompt`.
- Kotlin `SearchChunkerTest` (100-word windows, the 30 s gap, a long single line, words only),
  `VecCodecTest` (round trip within 0.02 cosine; unit vector), `RetrieverTest` (RRF order,
  `byMeaning`, one id in both lists counted once), `AskerTest` (gate order; `NOTHING` on empty
  retrieval; stored row shape), `AudioDbTest` additions on the phone (`embedded_at` reset by
  each writer; `deleteMeeting` removes vec rows), `indexMinutes` no-duplicate test,
  `unindexedCount`.
- TS `schema.test.ts` (new tables/column in both mirrors), `AskScreen.test.tsx` (thread renders
  stored asks; send calls `Ask.ask(meetingId, q)`; a cite chip navigates with `atMs`; `NOT_PRO`
  navigates to Paywall; unmount unloads), `SearchScreen` (a `byMeaning` row shows "≈").
- Device (Pixel, Pro): the two models install from Settings; a processed meeting shows
  `embedded …` in logcat; Search "push back" finds "Only a draft; the final version needs
  another week"; Ask "did we agree on a date for the proposal?" answers with `[1]`/`[2]`
  chips that open the transcript at the turn; Ask while the writer runs → the BUSY note; free
  tier: Ask → paywall, search unchanged.

## Out of scope

A global ask across meetings; streaming tokens; conversation memory across questions
(each ask stands alone); re-ranking by a cross-encoder; Hindi or any second language for the
embedding model; quantised search on a GPU.

## Device verification

*Pixel 7 Pro, 17 September 2026.*

- `NativePipelineTest` 14/14 including `embedding_is_a_unit_vector_and_near_beats_far` (the
  model loads in ~120 ms on the phone) and `ask_prompt_is_fenced_and_the_validator_strips_bad_cites`;
  `SearchIndexDbTest` 5/5 (one card per decision after the pipeline's order and after a
  reindex; the backlog count; every writer of words resets `embedded_at`; `deleteMeeting`
  sweeps `search_vec`; the diff by words and moment); `BackupManagerTest` 2/2 (marks and asks
  travel).
- The model was put on the phone at the catalog's filename (the download path is the same
  ModelManager every other model uses; Settings reports it installed by size).
- Processing the lead-example meeting showed the new stage **"Indexed for meaning"**; logcat
  `Embed: embedded 8/15/3 chunk(s)` for older meetings as the sweep caught the library up, and
  `embedded 0 chunk(s) (0 dropped)` on a rewrite that changed no words — the hash diff working.
- **Search "objected to the cost"** — no word in common with any turn — returned
  **"≈ Reholt pushed back on the pricing…"** first, under "Meaning search is still indexing 6
  meetings".
- **Ask "did we agree on a date for the proposal"** answered in 17 s with five citation chips,
  and the answer showed why the build needed fixing: the writer had been handed the screen
  snippets (fragments, FTS markers), copied the passages back out, and cited nothing.
  Fixed in `dd214e2`: whole passages, a worked example, echoed lines stripped, and the answer
  grammar-constrained to "refusal, or prose then ≥ 1 citation". On the Mac against the same
  GGUF (`test_ask_live`, in the gate) the lead question now answers *"Yes, we agreed to ship
  on Monday. [4]"* and the off-topic one refuses.
- **Not yet seen on the phone with the fixed build:** the re-asked answer (the phone was taken
  by another session mid-question), the BUSY note during narration, a free user's Ask → paywall.
