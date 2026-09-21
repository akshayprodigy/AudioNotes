package com.innocorelabs.verbale.pipeline

/**
 * Correction rules for the transcript (Phase 5, custom vocabulary): "in over" -> "Innova".
 * Applied after recognition, never as a recogniser prompt — measured 18 Sep, a prompt made
 * whisper drop words on every meeting (design §2). Pure: no database, so a golden pins it.
 */
object Vocabulary {
  data class Rule(val heard: String, val meant: String)

  /**
   * Every rule applied to [text]: whole words only, case-insensitive, longest `heard` first so
   * "in over there" beats "in over"; `meant` is written exactly as typed. Text no rule touches
   * comes back byte for byte (the same String instance).
   */
  fun apply(text: String, rules: List<Rule>): String {
    if (rules.isEmpty() || text.isEmpty()) return text
    var out = text
    for (r in rules.sortedByDescending { it.heard.length }) {
      val heard = r.heard.trim()
      if (heard.isEmpty()) continue
      val re = Regex("(?<![\\p{L}\\p{N}])" + Regex.escape(heard) + "(?![\\p{L}\\p{N}])", RegexOption.IGNORE_CASE)
      // The lambda form of replace appends its result literally — no $-group syntax, so no escaping.
      out = re.replace(out) { r.meant }
    }
    return if (out == text) text else out
  }
}
