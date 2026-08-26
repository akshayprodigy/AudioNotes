package com.audionotes.pipeline

import android.app.ActivityManager
import android.content.Context
import android.util.Log
import com.audionotes.data.AudioDb
import com.audionotes.data.ModelCatalog

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
   * Narrate one meeting. Returns true when `llm` rows were written.
   * Requires [NativeBridge.ensureLoaded] to have run.
   */
  fun run(ctx: Context, meetingId: String, progress: Progress): Boolean {
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

      // 3 for the condensation chain; digests only exist when the meeting needs more than one chunk.
      val total = (if (chunks.size == 1) 0 else chunks.size) + 3
      var step = 0
      fun tick(): Boolean {
        if (progress.isCancelled()) return true
        progress.onStage("narrate", step, total)
        return false
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
        val done = db.notes(meetingId).toMutableMap()
        for (i in chunks.indices) {
          if (tick()) return false
          step++
          if (done.containsKey(i)) continue
          val digest = NativeBridge.nativeStripMarkdown(
            gen(NativeBridge.nativeLlmDigestPrompt(chunks[i]), DIGEST_TOKENS),
          )
          if (digest.isEmpty()) continue
          // Committed as it lands: this is the whole reason llm_notes exists. A process killed at
          // chunk 5 of 9 resumes at 5 instead of regenerating eight minutes of work it already did.
          db.putNote(meetingId, i, digest)
          done[i] = digest
        }

        var digests = chunks.indices.mapNotNull { done[it] }
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
      val narrative = NativeBridge.nativeStripMarkdown(
        gen(NativeBridge.nativeLlmNarrativePrompt(source), NARRATIVE_TOKENS),
      )
      if (narrative.isEmpty()) {
        Log.w(TAG, "no narrative produced for $meetingId")
        return false
      }

      if (tick()) return false
      step++
      val summary = NativeBridge.nativeStripMarkdown(
        gen(NativeBridge.nativeLlmSummaryPrompt(narrative), SUMMARY_TOKENS),
      )
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

      progress.onStage("narrate", total, total)
      Log.i(TAG, "narrated $meetingId in ${System.currentTimeMillis() - startedAt}ms " +
        "(${chunks.size} chunk(s), summary ${summary.length} chars)")
      return true
    } finally {
      NativeBridge.nativeLlmFree(handle)
    }
  }
}
