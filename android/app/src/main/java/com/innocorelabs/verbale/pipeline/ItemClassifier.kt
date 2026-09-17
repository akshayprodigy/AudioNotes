package com.innocorelabs.verbale.pipeline

import android.util.Log
import com.innocorelabs.verbale.data.AudioDb
import org.json.JSONObject
import java.time.ZoneId

/**
 * The typed record for each rule-extracted item, read by the model through a grammar.
 *
 * Bounded on purpose: it types what the rules found and never invents an item; it can only quote;
 * every answer is validated in C++ before it is believed; the date is a rule (DateNorm), not the
 * model; whether a person is asked is a rule (ReviewRule), not the model. Pro only, by
 * construction — it runs inside narration, behind the one paid gate.
 *
 * What it reads: the turn the item came from and the replies after it — up to
 * [REPLY_WINDOW_TURNS] more lines or [REPLY_WINDOW_MS], whichever ends first. That is where "only
 * a draft; the final needs another week" lives, and it is what the rules cannot see.
 */
object ItemClassifier {
  private const val TAG = "AudioPipeline"
  const val REPLY_WINDOW_TURNS = 4
  const val REPLY_WINDOW_MS = 90_000L
  const val RECORD_TOKENS = 96
  const val GEN_SUFFIX = "+qwen2.5-1.5b/classify@1"

  fun interface Generate { fun run(prompt: String, maxTokens: Int, grammar: String): String }

  /** The items of a meeting the classifier has not read yet and a person has not settled. */
  /**
   * The date phrase for an item: the rule's reading of the statement first (DateNorm.spanIn),
   * the model's validated phrase only where the rule finds nothing. Measured 17 Sep: the model
   * left "Friday" and "tomorrow" unread on the Mac and the Pixel alike; the rule never does.
   */
  fun dateSaidFor(statement: String, modelPhrase: String): String? =
    DateNorm.spanIn(statement) ?: modelPhrase.trim().ifBlank { null }

  fun pending(db: AudioDb, meetingId: String): List<AudioDb.StoredItem> =
    db.items(meetingId).filter {
      it.record == null && it.review !in AudioDb.Review.BY_A_PERSON && it.genVersion != AudioDb.Gen.USER
    }

  /**
   * The window for one item: the source line and the replies after it, as parallel arrays.
   * Null when the source line cannot be found in the transcript any more.
   */
  data class Window(val ordinals: IntArray, val speakers: Array<String>, val texts: Array<String>, val sourceSpeakerId: String?)

  fun windowFor(item: AudioDb.StoredItem, utts: List<Utt>, names: Map<String, String>): Window? {
    val src = item.sources.firstOrNull() ?: return null
    val at = utts.indexOfFirst { it.id == src.utteranceId }.takeIf { it >= 0 }
      ?: utts.indexOfFirst { it.startMs <= src.startMs && src.startMs <= it.endMs }.takeIf { it >= 0 }
      ?: return null
    val lines = ArrayList<Utt>()
    for (i in at until utts.size) {
      val u = utts[i]
      if (lines.size > REPLY_WINDOW_TURNS || u.startMs - utts[at].startMs > REPLY_WINDOW_MS) break
      lines.add(u)
    }
    return Window(
      IntArray(lines.size) { it },
      Array(lines.size) { names[lines[it].speakerId] ?: "Speaker" },
      Array(lines.size) { lines[it].text },
      utts[at].speakerId,
    )
  }

  /**
   * Classifies every pending item; returns how many records were written. [onEach] is called
   * after each item and returns true to stop (cancellation, from the narrator's progress).
   */
  fun run(db: AudioDb, meetingId: String, meetingAtMs: Long, gen: Generate, onEach: () -> Boolean): Int {
    val utts = db.utterances(meetingId)
    val speakers = db.speakers(meetingId)
    val names = speakers.associate { it.id to (it.displayName ?: "Speaker") }
    val grammar = NativeBridge.nativeClassifyGrammar()
    var written = 0
    for (item in pending(db, meetingId)) {
      val w = windowFor(item, utts, names) ?: continue
      val prompt = NativeBridge.nativeClassifyPrompt(item.text, w.ordinals, w.speakers, w.texts)
      val raw = gen.run(prompt, RECORD_TOKENS, grammar)
      val json = NativeBridge.nativeValidateRecord(raw, w.ordinals, w.speakers, w.texts)
      if (json.isEmpty()) {
        Log.w(TAG, "classifier answer did not parse for ${item.id}: ${raw.take(120)}")
        if (onEach()) break
        continue
      }
      val r = JSONObject(json)
      val confidence = r.getString("confidence")
      val ownerKind = r.getJSONObject("owner").getString("kind")
      val ownerName = r.getJSONObject("owner").getString("name")
      // "I will" is the speaker of the source line; a named person is matched to a speaker row
      // when one carries that name, else kept as a name. The model never guesses a name for a
      // voice — that is what the validator's verbatim rule is for.
      val owner = when (ownerKind) {
        "speaker" -> JSONObject().put("kind", "speaker").put("id", w.sourceSpeakerId ?: "").put("confidence", confidence)
        "person" -> {
          val match = names.entries.firstOrNull { it.value.equals(ownerName, ignoreCase = true) }
          if (match != null) JSONObject().put("kind", "speaker").put("id", match.key).put("confidence", confidence)
          else JSONObject().put("kind", "person").put("name", ownerName).put("confidence", confidence)
        }
        else -> JSONObject().put("kind", "unassigned")
      }
      val dateSaid = dateSaidFor(item.text, r.getString("date_said"))
      val dateNorm = dateSaid?.let { DateNorm.resolve(it, meetingAtMs, ZoneId.systemDefault()) }
      val decision = ReviewRule.decide(
        kind = item.kind, type = r.getString("type"), status = r.getString("status"),
        confidence = confidence, ownerKind = owner.getString("kind"),
        dateSaid = dateSaid, dateNorm = dateNorm, currentReview = item.review,
      )
      db.classifyItem(
        item.id,
        AudioDb.Classified(r.getString("type"), r.getString("status"), owner.toString(), dateSaid, dateNorm),
        decision.review, item.genVersion + GEN_SUFFIX,
      )
      Log.i(
        TAG,
        "classified ${item.id}: ${r.getString("type")}/${r.getString("status")} owner=${owner.getString("kind")} " +
          "date=${dateSaid ?: "-"}${if (dateNorm != null) "→$dateNorm" else ""} -> ${decision.review}${decision.reason?.let { " ($it)" } ?: ""}",
      )
      written++
      if (onEach()) break
    }
    return written
  }
}
