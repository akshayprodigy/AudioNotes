package com.innocorelabs.verbale.pipeline

import android.app.ActivityManager
import android.content.Context
import android.util.Log
import com.innocorelabs.verbale.billing.LicenceStore
import com.innocorelabs.verbale.billing.Trial
import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.data.ModelCatalog

/**
 * The on-device LLM pass over a finished transcript: the summary the details screen leads with, the
 * MOM narrative, and the one-line description on the library row.
 *
 * **Kotlin owns the LOOP; C++ owns the LOGIC.** Every prompt, the chunking rule, the fold plan and
 * the markdown stripping come from [NativeBridge], so this file cannot drift from
 * `cpp/minutes/llm_prompts.cpp` — the code the desktop CLI and the eval harness actually score.
 * What lives here is the part a single JNI call cannot express: per-chunk progress, cancellation
 * between generations, and a database checkpoint after every expensive one.
 *
 * It deliberately mirrors `narrate()` in that file rather than calling it. If you change the
 * sequence on either side, change it on both; `test_llm_minutes` pins the C++ call order so the
 * drift is visible from the other direction.
 *
 * Output is written as `minutes` rows with `source='llm'`. The rule-based rows are never touched:
 * the rules are extractive and every item quotes something that was said (measured invented=0
 * across four AMI fixtures), while this writes prose and carries no such guarantee. The Actions tab
 * reads the rules; the Summary and MOM tabs read this.
 *
 * Strictly best-effort. No model, a device under the RAM gate, or a generation that comes back
 * empty leaves the meeting with its rule-based minutes and no `llm` rows, which the UI renders as
 * an at-a-glance summary. That is a supported outcome, not a failure.
 */
object Narrator {
  private const val TAG = "Narrator"

  /** Context window, matching LlmModule. */
  private const val N_CTX = 8192

  /**
   * Characters of prose one prompt may carry. ~4 chars/token against N_CTX, holding back room for
   * the instruction text and the answer, so a condense pass is triggered before LlamaEngine's own
   * token guard fires and silently returns "". Mirrors kNotesBudgetChars in llm_minutes.h.
   */
  private const val NOTES_BUDGET_CHARS = (N_CTX - 1600) * 4

  /**
   * Argmax alone loops on repetitive input — measured emitting one transcript line forty times.
   * See NativeBridge.nativeLlmLoad on why this is not implied by `greedy`.
   */
  private const val REPEAT_PENALTY = 1.15f

  private const val DIGEST_TOKENS = 320
  private const val NARRATIVE_TOKENS = 640
  private const val SUMMARY_TOKENS = 192
  private const val HEADLINE_TOKENS = 48

  /** Rounds of condensing before we give up and let the prompt be oversized. */
  private const val MAX_CONDENSE_ROUNDS = 4

  /** Below this much transcript, narration invents a meeting rather than describing one. */
  private const val MIN_TRANSCRIPT_CHARS = 400

  /**
   * Everything that stands between a raw generation and the reader, in order.
   *
   * Each step exists because the prompt asked for the same thing and the model did it anyway —
   * markdown it was told not to emit, a form header it was told not to write, a caveat about what
   * the meeting failed to decide, and a final sentence severed by the token cap. Prompt wording
   * shifts the odds; these make the guarantee. The logic lives in C++ so the CLI and the phone
   * clean prose identically — see llm_prompts.cpp.
   *
   * Order matters: strip the markup, then the labels it was hiding under, then the closing
   * caveat, and only then cut to a whole sentence — so trimming is the last word.
   */
  private fun clean(raw: String): String =
    NativeBridge.nativeTrimToSentence(
      NativeBridge.nativeDropAbsenceTail(
        NativeBridge.nativeStripLabels(NativeBridge.nativeStripMarkdown(raw)),
      ),
    )

  interface Progress {
    fun onStage(stage: String, done: Int, total: Int)
    fun isCancelled(): Boolean
  }

  /** Rough device gate: enough RAM to run a ~1.5B Q4 model without thrashing. Matches LlmModule. */
  fun capable(ctx: Context): Boolean {
    val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val mem = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
    return mem.totalMem >= 3L * 1024 * 1024 * 1024
  }

  fun modelFile(ctx: Context) = ModelCatalog.fileFor(ctx, "llm-qwen")?.takeIf { it.exists() }

  /**
   * Each chunk's prose digest, in order, with the chunks whose generation FAILED dropped entirely.
   *
   * Dropping is the load-bearing part and what it protects is not visible from here. A chunk is
   * recorded speech; what it feeds next is [NativeBridge.nativeLlmCondensePrompt], which is NOT
   * fenced — the core reasons that a condense prompt's input is always a generation and never
   * speech (see `cpp/minutes/fence.h` and the note above `mapPrompt` in `llm_prompts.cpp`).
   *
   * So the obvious kindness — `digest.ifEmpty { chunks[i] }`, so a chunk the model failed on is
   * not "lost" — would put a meeting's own words into the instruction position of a live model.
   * Every assertion about condensePrompt would still pass: the builder would be exactly as
   * unfenced as it was meant to be. What changed is what is handed to it.
   *
   * Extracted from [run] so that invariant can be tested off a device. `narrate()` in
   * llm_prompts.cpp is the same loop in C++ and `test_llm_minutes` pins it there; this is the copy
   * the phone actually runs, and until NarratorDigestsTest it had nothing watching it.
   *
   * @param already digests an earlier interrupted run already committed, by chunk index
   * @param digestOf chunk -> prose, `""` when the model produced nothing
   * @param commit checkpoint one digest as it lands
   * @param beforeEach called with each index before any work; return true to cancel the run
   * @return the digests in chunk order, or null when [beforeEach] asked to cancel
   */
  internal fun digestChunks(
    chunks: List<String>,
    already: Map<Int, String>,
    digestOf: (String) -> String,
    commit: (Int, String) -> Unit,
    beforeEach: (Int) -> Boolean = { false },
  ): List<String>? {
    val done = already.toMutableMap()
    for (i in chunks.indices) {
      if (beforeEach(i)) return null
      if (done.containsKey(i)) continue
      val digest = digestOf(chunks[i])
      // NEVER `?: chunks[i]` here. Read the note above before making a failed chunk carry itself.
      if (digest.isEmpty()) continue
      commit(i, digest)
      done[i] = digest
    }
    return chunks.indices.mapNotNull { done[it] }
  }

  /**
   * Narrate one meeting. Returns true when `llm` rows were written.
   * Requires [NativeBridge.ensureLoaded] to have run.
   */
  fun run(ctx: Context, meetingId: String, progress: Progress): Boolean {
    // The paid gate, and the only one in the app: every caller of narration comes through here —
    // the processing service, the headless stop-from-notification path, and the Summary tab's
    // "Write it again". Checked before the model is even looked for, because a lapsed subscriber
    // still has the weights on disk.
    //
    // Failing here is not an error and not a dead end. The meeting still gets its transcript, its
    // speakers and its rule-based minutes — the free floor is a whole product, not a teaser — so
    // the only thing withheld is the prose. Nothing the user already has is ever taken away.
    if (!LicenceStore.entitled(ctx)) {
      Log.i(TAG, "skipped for $meetingId (no active subscription or trial)")
      return false
    }

    val model = modelFile(ctx)
    if (model == null) {
      Log.i(TAG, "skipped for $meetingId (Qwen model not installed)")
      return false
    }
    if (!capable(ctx)) {
      Log.i(TAG, "skipped for $meetingId (device under the 3 GB RAM gate)")
      return false
    }

    val db = AudioDb.get(ctx)
    val utts = db.utterances(meetingId)
    if (utts.isEmpty()) return false

    // Too little was said to summarise, so do not ask a model to try.
    //
    // Measured 2026-08-26: given the 11-second jfk fixture — one sentence, one voice — the model
    // returned "They resolved to participate in community service projects" and "Each participant
    // committed to specific actions like volunteering at schools or assisting elderly neighbors
    // with managing technology". No participants, no resolutions, no commitments exist in that
    // audio. Asked to write minutes of a meeting that did not happen, it invents one.
    //
    // 400 characters is roughly 35 seconds of speech. Below that the rule-based floor is not just
    // safer, it is more informative: it quotes what was actually said instead of describing a
    // meeting around it.
    val transcriptChars = utts.sumOf { it.text.length }
    if (transcriptChars < MIN_TRANSCRIPT_CHARS) {
      Log.i(TAG, "skipped for $meetingId (only $transcriptChars chars of transcript — too short " +
        "to summarise without inventing)")
      return false
    }

    val spks = db.speakers(meetingId)

    val chunks = NativeBridge.nativeLlmChunks(
      Array(utts.size) { utts[it].text },
      Array(utts.size) { utts[it].speakerId ?: "" },
      Array(spks.size) { spks[it].id },
      Array(spks.size) { spks[it].displayName ?: "" },
    )
    if (chunks.isEmpty()) return false

    val threads = maxOf(1, Runtime.getRuntime().availableProcessors() / 2)
    val startedAt = System.currentTimeMillis()
    val handle = NativeBridge.nativeLlmLoad(
      model.absolutePath, N_CTX, threads, /*greedy=*/true, REPEAT_PENALTY,
    )
    if (handle == 0L) {
      Log.w(TAG, "llama failed to load for $meetingId")
      return false
    }
    Log.i(TAG, "model loaded in ${System.currentTimeMillis() - startedAt}ms for $meetingId")

    try {
      fun gen(prompt: String, maxTokens: Int): String =
        NativeBridge.nativeLlmGenerate(handle, prompt, maxTokens).trim()

      // 3 for the condensation chain; digests only exist when the meeting needs more than one
      // chunk; one per item the classifier has still to read.
      val toClassify = ItemClassifier.pending(db, meetingId).size
      val total = (if (chunks.size == 1) 0 else chunks.size) + 3 + toClassify
      var step = 0
      fun tick(): Boolean {
        if (progress.isCancelled()) return true
        progress.onStage("narrate", step, total)
        return false
      }

      // The typed record first (evidence Phase B): a bounded, grammar-constrained reading of
      // each item over the turns that replied to it. Before the prose, so the narrator's
      // validator can hold what it writes against typed items. A failure here costs labels,
      // never the notes — it is caught and logged, and narration goes on.
      if (toClassify > 0) {
        val meetingAt = db.meetingCreatedAt(meetingId) ?: System.currentTimeMillis()
        val classified = try {
          ItemClassifier.run(db, meetingId, meetingAt, { p, n, g ->
            NativeBridge.nativeLlmGenerateConstrained(handle, p, n, g)
          }) { step++; tick() }
        } catch (e: Exception) {
          Log.w(TAG, "classifier failed for $meetingId", e)
          0
        }
        Log.i(TAG, "classified $classified of $toClassify item(s) for $meetingId")
        if (progress.isCancelled()) return false
      }

      // What the prose is written FROM decides how it reads. Fed the DECISIONS/ACTIONS/QUESTIONS
      // notes, a 1.5B model answers with "#### Actions:" and a bullet list however firmly the
      // prompt forbids headings — it mirrors the shape of its input. Fed dialogue it writes prose.
      // So a meeting that fits one prompt goes straight in, and only a longer one is digested.
      val source: String
      if (chunks.size == 1) {
        if (tick()) return false
        source = chunks[0]
      } else {
        var digests = digestChunks(
          chunks.toList(),
          db.notes(meetingId),
          digestOf = { chunk ->
            NativeBridge.nativeStripMarkdown(
              gen(NativeBridge.nativeLlmDigestPrompt(chunk), DIGEST_TOKENS),
            )
          },
          // Committed as it lands: this is the whole reason llm_notes exists. A process killed at
          // chunk 5 of 9 resumes at 5 instead of regenerating eight minutes of work it already did.
          commit = { i, digest -> db.putNote(meetingId, i, digest) },
          beforeEach = { if (tick()) true else { step++; false } },
        ) ?: return false

        if (digests.isEmpty()) {
          Log.w(TAG, "no digests produced for $meetingId")
          return false
        }

        // Condense in groups until the account fits one prompt. Bounded: foldPlan refuses to group
        // a single oversize entry, so one enormous digest would otherwise spin here forever.
        var round = 0
        while (round++ < MAX_CONDENSE_ROUNDS) {
          if (progress.isCancelled()) return false
          val flat = NativeBridge.nativeLlmFoldPlan(digests.toTypedArray(), NOTES_BUDGET_CHARS)
          if (flat.isEmpty()) break
          val groups = LinkedHashMap<Int, MutableList<Int>>()
          var k = 0
          while (k + 1 < flat.size) {
            groups.getOrPut(flat[k]) { mutableListOf() }.add(flat[k + 1])
            k += 2
          }
          val grouped = groups.values.flatten().toSet()
          val next = ArrayList<String>(groups.size)
          for (group in groups.values) {
            val joined = group.joinToString("\n\n") { digests[it] }
            val merged = gen(NativeBridge.nativeLlmCondensePrompt(joined), DIGEST_TOKENS)
            next.add(if (merged.isEmpty()) joined else NativeBridge.nativeStripMarkdown(merged))
          }
          // Entries outside any group already fit; carry them through unchanged.
          digests.indices.filter { it !in grouped }.forEach { next.add(digests[it]) }
          Log.i(TAG, "condensed ${digests.size} digests into ${next.size} for $meetingId")
          digests = next
        }
        source = digests.joinToString("\n\n")
      }

      // Progressive condensation. Only the narrative pays a full prefill; the other two read a few
      // hundred characters, and neither can contradict the one above it.
      if (tick()) return false
      step++
      val narrative = clean(gen(NativeBridge.nativeLlmNarrativePrompt(source), NARRATIVE_TOKENS))
      if (narrative.isEmpty()) {
        Log.w(TAG, "no narrative produced for $meetingId")
        return false
      }

      if (tick()) return false
      step++
      val summary = clean(gen(NativeBridge.nativeLlmSummaryPrompt(narrative), SUMMARY_TOKENS))
      if (summary.isEmpty()) {
        Log.w(TAG, "no summary produced for $meetingId")
        return false
      }

      if (tick()) return false
      step++
      val headline = gen(NativeBridge.nativeLlmHeadlinePrompt(summary), HEADLINE_TOKENS)

      // Source-scoped: this cannot touch the rule rows. See AudioDb.replaceMinutes.
      db.replaceMinutes(meetingId, "llm", listOf(
        DraftMinute("summary", summary, "llm"),
        DraftMinute("narrative", narrative, "llm"),
      ))
      // The model likes to wrap a one-liner in quotes despite being told not to.
      val line = headline.trim().trim('"', '“', '”').trim()
      if (line.isNotEmpty()) db.setSummaryLine(meetingId, line)

      // The checkpoint has served its purpose; leaving it would make a later re-narration resume
      // from stale digests of a transcript that may since have been re-diarized.
      db.clearNotes(meetingId)

      // Counted HERE, after the rows are committed, and nowhere else. Every path into narration
      // comes through run() — the processing service, the headless stop-from-notification, the
      // Summary tab's "Write it again" — so this is the one place a trial summary can be counted
      // exactly once. Counting at the gate instead would charge a person for a model that then
      // ran out of memory, and counting in the caller would miss the headless path entirely.
      // It no-ops for a subscriber and for anyone not on a trial.
      Trial.noteSummary(ctx)

      progress.onStage("narrate", total, total)
      Log.i(TAG, "narrated $meetingId in ${System.currentTimeMillis() - startedAt}ms " +
        "(${chunks.size} chunk(s), summary ${summary.length} chars)")
      return true
    } finally {
      NativeBridge.nativeLlmFree(handle)
    }
  }
}
