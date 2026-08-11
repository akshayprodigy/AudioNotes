package com.audionotes.pipeline

// Rule-based minutes — the deterministic Free-tier floor. No model, no network.
// Kotlin port of src/pipeline/minutes.ts — a line-for-line parity port so the MOM reads
// identically whether produced in JS (in-app) or here (headless/native). If any rule below
// looks odd, that's minutes.ts being odd too; match it exactly rather than "improving" it.
//
// Extracts action items (with best-effort owner + due date), decisions, and open questions
// from the transcript, plus a factual overview line.
//
// Patterns are English-first but structured so more languages can be added as extra cue lists.

/** Mirrors src/pipeline/minutes.ts DraftMinute. kind in: summary|decision|action|question. */
data class DraftMinute(val kind: String, val content: String, val source: String = "rule")

/** The minimal utterance/speaker fields the extractor needs (subset of the DB rows). */
data class Utt(val text: String, val speakerId: String?)
data class Spk(val id: String, val displayName: String?)

/**
 * Deterministic rule-based minutes extraction — a line-for-line port of src/pipeline/minutes.ts.
 * Pure/regex only; the same rules the JS floor uses, so the MOM reads identically whether produced
 * in JS (in-app) or here (headless/native).
 */
object MinutesExtractor {

  // JS: const ACTION_FIRST_PERSON = /\b(i['’]ll|i will|i am going to|i'm going to|let me|we['’]ll|we will|we need to|let['’]s)\b/i;
  private val ACTION_FIRST_PERSON = Regex(
    """\b(i['’]ll|i will|i am going to|i'm going to|let me|we['’]ll|we will|we need to|let['’]s)\b""",
    RegexOption.IGNORE_CASE,
  )

  // JS: const ACTION_ASSIGN = /\b(can you|could you|would you|please|you need to|you should|make sure (you|to)|assign(ed)? to)\b/i;
  private val ACTION_ASSIGN = Regex(
    """\b(can you|could you|would you|please|you need to|you should|make sure (you|to)|assign(ed)? to)\b""",
    RegexOption.IGNORE_CASE,
  )

  // JS: const ACTION_OBLIGATION = /\b(need to|needs to|have to|has to|must|should|going to|will send|will get|will do|follow[- ]?up|action item|to-?do)\b/i;
  private val ACTION_OBLIGATION = Regex(
    """\b(need to|needs to|have to|has to|must|should|going to|will send|will get|will do|follow[- ]?up|action item|to-?do)\b""",
    RegexOption.IGNORE_CASE,
  )

  // JS: const IMPERATIVE_VERBS = ['send', 'prepare', ...];
  private val IMPERATIVE_VERBS = listOf(
    "send", "prepare", "schedule", "email", "call", "review", "update", "create", "finish",
    "draft", "share", "set up", "book", "confirm", "check", "fix", "add", "remove", "ping",
  )

  // JS: const DECISION = /\b(we decided|the decision|we agreed|agreed to|let['’]s go with|we['’]ll go with|we chose|going with|we['’]re going with|finali[sz]ed|sign(ed)? off|approved|conclusion is)\b/i;
  private val DECISION = Regex(
    """\b(we decided|the decision|we agreed|agreed to|let['’]s go with|we['’]ll go with|we chose|going with|we['’]re going with|finali[sz]ed|sign(ed)? off|approved|conclusion is)\b""",
    RegexOption.IGNORE_CASE,
  )

  // JS: const DUE = /\b(today|tonight|tomorrow|this (morning|afternoon|evening|week|month)|next (week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|by (the )?(end of (the )?(day|week|month)|eod|cob|monday|tuesday|wednesday|thursday|friday|saturday|sunday|noon|\w+day)|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in \d+ (day|days|week|weeks)|\d{1,2}(st|nd|rd|th)?( of)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b/i;
  private val DUE = Regex(
    """\b(today|tonight|tomorrow|this (morning|afternoon|evening|week|month)|next (week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|by (the )?(end of (the )?(day|week|month)|eod|cob|monday|tuesday|wednesday|thursday|friday|saturday|sunday|noon|\w+day)|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in \d+ (day|days|week|weeks)|\d{1,2}(st|nd|rd|th)?( of)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b""",
    RegexOption.IGNORE_CASE,
  )

  // JS: const NAMED_OWNER = /\b([A-Z][a-z]{1,20})\s+(?:will|to|should|is going to|needs to|has to|can|could|please)\b/;
  // Note: no /i flag in the JS source — this one is intentionally case-sensitive (it's how a
  // capitalized proper name is distinguished from an ordinary word).
  private val NAMED_OWNER = Regex(
    """\b([A-Z][a-z]{1,20})\s+(?:will|to|should|is going to|needs to|has to|can|could|please)\b""",
  )

  // JS: const QUESTION_WORDS = /^(what|why|how|when|where|who|which|should we|do we|can we|are we|is it|could we|would it)\b/i;
  private val QUESTION_WORDS = Regex(
    """^(what|why|how|when|where|who|which|should we|do we|can we|are we|is it|could we|would it)\b""",
    RegexOption.IGNORE_CASE,
  )

  // JS: if (!/^(I|We|You|The|This|That|It|Let|Please)$/.test(n)) return n;
  // Case-sensitive on purpose (matches capitalized sentence-starter words only).
  private val EXCLUDED_OWNER_WORDS = Regex("""^(I|We|You|The|This|That|It|Let|Please)$""")

  private val WHITESPACE_RUN = Regex("""\s+""")
  private val SENTENCE_SPLIT = Regex("""(?<=[.!?])\s+""")
  private val NON_ALNUM_RUN = Regex("""[^a-z0-9]+""")

  // JS:
  // function splitSentences(text: string): string[] {
  //   return text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  // }
  private fun splitSentences(text: String): List<String> =
    text.replace(WHITESPACE_RUN, " ")
      .split(SENTENCE_SPLIT)
      .map { it.trim() }
      .filter { it.isNotEmpty() }

  // JS: function norm(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  private fun norm(s: String): String =
    s.lowercase().replace(NON_ALNUM_RUN, " ").trim()

  // JS:
  // function startsWithImperative(sentence: string): boolean {
  //   const first = sentence.trim().toLowerCase();
  //   return IMPERATIVE_VERBS.some(v => first.startsWith(v + ' '));
  // }
  private fun startsWithImperative(sentence: String): Boolean {
    val first = sentence.trim().lowercase()
    return IMPERATIVE_VERBS.any { first.startsWith("$it ") }
  }

  // JS:
  // function detectOwner(sentence: string, speakerName: string | null): string {
  //   const named = sentence.match(NAMED_OWNER);
  //   if (named) {
  //     const n = named[1];
  //     if (!/^(I|We|You|The|This|That|It|Let|Please)$/.test(n)) return n;
  //   }
  //   if (ACTION_FIRST_PERSON.test(sentence) && speakerName) return speakerName;
  //   if (ACTION_ASSIGN.test(sentence)) return 'Unassigned';
  //   return 'Unassigned';
  // }
  private fun detectOwner(sentence: String, speakerName: String?): String {
    val named = NAMED_OWNER.find(sentence)
    if (named != null) {
      val n = named.groupValues[1]
      if (!EXCLUDED_OWNER_WORDS.matches(n)) return n
    }
    if (ACTION_FIRST_PERSON.containsMatchIn(sentence) && !speakerName.isNullOrEmpty()) return speakerName
    if (ACTION_ASSIGN.containsMatchIn(sentence)) return "Unassigned"
    return "Unassigned"
  }

  // JS:
  // function isAction(sentence: string): boolean {
  //   return (
  //     ACTION_FIRST_PERSON.test(sentence) ||
  //     ACTION_ASSIGN.test(sentence) ||
  //     ACTION_OBLIGATION.test(sentence) ||
  //     startsWithImperative(sentence)
  //   );
  // }
  private fun isAction(sentence: String): Boolean =
    ACTION_FIRST_PERSON.containsMatchIn(sentence) ||
      ACTION_ASSIGN.containsMatchIn(sentence) ||
      ACTION_OBLIGATION.containsMatchIn(sentence) ||
      startsWithImperative(sentence)

  // JS:
  // function isQuestion(sentence: string): boolean {
  //   const t = sentence.trim();
  //   return t.endsWith('?') || (QUESTION_WORDS.test(t) && t.length < 160);
  // }
  private fun isQuestion(sentence: String): Boolean {
    val t = sentence.trim()
    return t.endsWith("?") || (QUESTION_WORDS.containsMatchIn(t) && t.length < 160)
  }

  /**
   * JS: export function extractMinutes(utterances, speakers = []): DraftMinute[] { ... }
   *
   * Classification priority per sentence: question > decision > action (a question is never
   * also treated as an action or decision; matching `continue`s in the JS loop are mirrored
   * below). Ordering of the final list: summary, then decisions, then actions, then questions.
   * Per-kind caps: 30 actions / 20 decisions / 20 questions (applied after ordering-within-kind,
   * before the summary counts are computed off the *trimmed* lists — matching minutes.ts).
   */
  fun extract(utterances: List<Utt>, speakers: List<Spk> = emptyList()): List<DraftMinute> {
    val nameById = HashMap<String, String?>()
    for (s in speakers) nameById[s.id] = s.displayName

    val actions = ArrayList<DraftMinute>()
    val decisions = ArrayList<DraftMinute>()
    val questions = ArrayList<DraftMinute>()
    val seen = HashSet<String>()

    // JS: const add = (arr, kind, content) => { key = kind + '|' + norm(content); if (!content || seen.has(key)) return; seen.add(key); arr.push({kind, content, source: 'rule'}); };
    fun add(arr: MutableList<DraftMinute>, kind: String, content: String) {
      val key = kind + "|" + norm(content)
      if (content.isEmpty() || seen.contains(key)) return
      seen.add(key)
      arr.add(DraftMinute(kind, content))
    }

    for (u in utterances) {
      // JS: const speakerName = u.speakerId ? nameById.get(u.speakerId) ?? null : null;
      val speakerName: String? = if (!u.speakerId.isNullOrEmpty()) nameById[u.speakerId] else null

      for (sentence in splitSentences(u.text)) {
        if (sentence.length < 4) continue

        if (isQuestion(sentence)) {
          add(questions, "question", sentence)
          continue // a question is not also an action
        }
        if (DECISION.containsMatchIn(sentence)) {
          add(decisions, "decision", sentence)
          continue
        }
        if (isAction(sentence)) {
          val owner = detectOwner(sentence, speakerName)
          val due = DUE.find(sentence)
          var content = sentence
          content += " — $owner"
          if (due != null) content += " (due ${due.value})"
          add(actions, "action", content)
        }
      }
    }

    val trimmedActions = actions.take(30)
    val trimmedDecisions = decisions.take(20)
    val trimmedQuestions = questions.take(20)

    // JS:
    // const summary: DraftMinute = {
    //   kind: 'summary',
    //   content:
    //     `${trimmed.actions.length} action item${trimmed.actions.length === 1 ? '' : 's'}, ` +
    //     `${trimmed.decisions.length} decision${trimmed.decisions.length === 1 ? '' : 's'}, ` +
    //     `${trimmed.questions.length} open question${trimmed.questions.length === 1 ? '' : 's'}.`,
    //   source: 'rule',
    // };
    val summary = DraftMinute(
      kind = "summary",
      content = "${trimmedActions.size} action item${if (trimmedActions.size == 1) "" else "s"}, " +
        "${trimmedDecisions.size} decision${if (trimmedDecisions.size == 1) "" else "s"}, " +
        "${trimmedQuestions.size} open question${if (trimmedQuestions.size == 1) "" else "s"}.",
    )

    // JS: return [summary, ...trimmed.decisions, ...trimmed.actions, ...trimmed.questions];
    return listOf(summary) + trimmedDecisions + trimmedActions + trimmedQuestions
  }
}
