package com.innocorelabs.verbale.pipeline

/**
 * F24: the writer's fact check, as [Narrator] uses it.
 *
 * **C++ owns the RULES; this file owns the plumbing.** What counts as a claim, and what supports
 * one, is `cpp/minutes/fact_check.cpp` — the same function the desktop CLI runs and the same tests
 * pin. This object does the three things a JNI call cannot: reads the one-string answer back,
 * adds the counts up across the three outputs of a narration, and fails CLOSED.
 *
 * Failing closed is the point of [guard]. A check that returns garbage must not become "no check":
 * text that could not be verified is not stored, exactly as text that was found unsupported is not.
 */
object FactGuard {
  /** A writer output after the check. [dropped] sentences were removed; [text] is what is left. */
  data class Checked(val text: String, val dropped: Int, val classes: List<String>)

  /**
   * Reads `nativeFactCheck`'s answer: `"<dropped>|<class,class>\n<text>"`. Null when it is not that
   * shape, which [guard] treats as "unverifiable".
   */
  fun parse(raw: String): Checked? {
    val nl = raw.indexOf('\n')
    if (nl < 0) return null
    val header = raw.substring(0, nl)
    val bar = header.indexOf('|')
    if (bar < 0) return null
    val dropped = header.substring(0, bar).toIntOrNull() ?: return null
    if (dropped < 0) return null
    val classes = header.substring(bar + 1).split(',').filter { it.isNotEmpty() }
    return Checked(raw.substring(nl + 1), dropped, classes)
  }

  /** What one narration removed, across the narrative, the summary and the headline. */
  class Tally {
    var dropped = 0
      private set
    private val seen = LinkedHashSet<String>()

    fun add(c: Checked) {
      dropped += c.dropped
      seen.addAll(c.classes)
    }

    /** Distinct classes in the order the checker named them first. */
    val classes: List<String> get() = seen.toList()

    /** The settings value the Summary card reads: `"<n>|<class,class>"`. `"0|"` clears a stale one. */
    fun encoded(): String = encode(dropped, classes)
  }

  fun encode(dropped: Int, classes: List<String>): String = "$dropped|${classes.joinToString(",")}"

  /**
   * The per-meeting record of what was removed. A settings key rather than a `minutes` row on
   * purpose: `minutes` rows are indexed for search, and a count has no business in a search hit.
   * Rewritten on every narration — `"0|"` when nothing was removed — so a re-run clears it.
   */
  fun settingKey(meetingId: String): String = "writer_check:$meetingId"

  /**
   * Hold one writer output against the transcript it was written from.
   *
   * Returns the text with every unsupported sentence removed — `""` when nothing is left, which
   * the caller already handles as "the model produced nothing" and so stores nothing. Counts are
   * added to [tally] whether or not anything survives, because the removal of a whole narrative is
   * the loudest thing this check does and must be countable.
   *
   * [check] is the native function in production; the parameter exists so the plumbing can be
   * tested off a device, where the library is not loaded.
   */
  fun guard(
    written: String,
    transcript: String,
    tally: Tally,
    check: (String, String) -> String = NativeBridge::nativeFactCheck,
  ): String {
    if (written.isBlank()) return written
    val checked = parse(check(written, transcript)) ?: return ""
    tally.add(checked)
    return checked.text
  }
}
