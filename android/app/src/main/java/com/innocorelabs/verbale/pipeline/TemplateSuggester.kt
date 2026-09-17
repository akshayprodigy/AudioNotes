package com.innocorelabs.verbale.pipeline

/**
 * Which of the seven meeting types (Phase 2, sub-project 6a) a transcript looks like — a rule,
 * not the model, so it is fast, free, and pinnable in a golden table
 * (cpp/tests/golden/template_suggest.json).
 *
 * Pure on purpose: it never touches the database. A meeting's remembered tag type is resolved by
 * the caller (AudioDb.tagsFor + AudioDb.rememberedTemplate) and handed in as [remembered], which
 * wins outright — "a tag's remembered type beats the rule" is a fact about ProcessingEngine's
 * call order, not a branch this function needs DB access to take.
 */
object TemplateSuggester {
  /** A type must clear this score (per hundred words) to win over "general". */
  const val THRESHOLD = 1.5

  /** speakers == 2 nudges toward one_on_one — most 1:1s are exactly two voices. */
  const val TWO_SPEAKER_BONUS = 1.0

  /** speakers >= 4 nudges away from one_on_one — a 1:1 is never a group. */
  const val FOUR_PLUS_SPEAKER_PENALTY = 1.0

  // Table order (docs/superpowers/specs/2026-09-17-phase-2-meeting-templates-brief.md §1, minus
  // "general" — general is never a scored winner, only the fallback). A LinkedHashMap so a tied
  // score keeps whichever type this iterates to first, which IS that table order.
  private val CUES: LinkedHashMap<String, List<String>> = linkedMapOf(
    "standup" to listOf(
      "yesterday", "today i", "blocker", "blockers", "blocked", "stand-up", "standup",
      "what did you do", "working on",
    ),
    "one_on_one" to listOf(
      "how are you", "career", "feedback", "one on one", "1:1", "growth", "how do you feel",
    ),
    "client" to listOf(
      "client", "contract", "proposal", "pricing", "quote", "invoice", "scope", "deliverable",
      "your team",
    ),
    "interview" to listOf(
      "candidate", "interview", "tell me about", "experience", "role", "hiring", "résumé",
      "resume", "why do you want",
    ),
    "lecture" to listOf(
      "lecture", "chapter", "definition", "theorem", "homework", "assignment", "for example",
      "syllabus",
    ),
    "site_walk" to listOf(
      "site", "inspection", "observed", "floor", "on site", "hazard", "defect", "snag",
      "contractor",
    ),
  )

  /**
   * Occurrences of [cue] in [text], counted only where it stands as a whole word or phrase — the
   * character on each side, if any, is not a letter or digit. A plain indexOf/isLetterOrDigit
   * scan rather than a `\b`-anchored regex: Java's `\b` treats non-ASCII letters like the "é" in
   * one of the interview cues as a non-word character, which would silently stop matching at the
   * accent.
   */
  private fun countCue(text: String, cue: String): Int {
    var count = 0
    var from = 0
    while (true) {
      val idx = text.indexOf(cue, from)
      if (idx < 0) break
      val before = idx == 0 || !text[idx - 1].isLetterOrDigit()
      val afterIdx = idx + cue.length
      val after = afterIdx >= text.length || !text[afterIdx].isLetterOrDigit()
      if (before && after) count++
      from = idx + 1
    }
    return count
  }

  fun suggest(transcript: String, speakerCount: Int, remembered: String? = null): String {
    if (!remembered.isNullOrEmpty()) return remembered

    val text = transcript.lowercase()
    val words = text.split(Regex("\\s+")).count { it.isNotEmpty() }
    if (words == 0) return "general"

    var winner: String? = null
    var winnerScore = 0.0
    for ((type, cues) in CUES) {
      var hits = 0
      for (cue in cues) hits += countCue(text, cue)
      var score = hits * 100.0 / words
      if (type == "one_on_one") {
        if (speakerCount == 2) score += TWO_SPEAKER_BONUS
        if (speakerCount >= 4) score -= FOUR_PLUS_SPEAKER_PENALTY
      }
      if (winner == null || score > winnerScore) {
        winner = type
        winnerScore = score
      }
    }
    return if (winner != null && winnerScore >= THRESHOLD) winner else "general"
  }
}
