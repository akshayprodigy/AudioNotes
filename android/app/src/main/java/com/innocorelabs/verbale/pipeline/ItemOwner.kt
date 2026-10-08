package com.innocorelabs.verbale.pipeline

import org.json.JSONObject

/**
 * Who owns an action, resolved from the speaker row instead of from the words stored with it.
 *
 * The rule pass bakes the owner into the item's text — "Send the report — Speaker 1 (due by
 * Thursday)" — and the stored text must not change (ticks, hand corrections and the Reconciler's
 * matching all read it). Renaming Speaker 1 therefore left every surface showing the old name.
 * The fix is to record WHICH SPEAKER the owner is, in `items.owner_json` as `{kind:'speaker',id}`
 * (the shape the Pro classifier already writes), and to put the speaker's CURRENT display name
 * into the text at read time — render, export, search index, threads.
 *
 * Pure: no database, no Android. The TypeScript twin is `src/pipeline/itemOwner.ts`, and
 * both are held to the same vectors (ItemOwnerTest / itemOwner.test.ts).
 *
 * What it never does: rewrite a name that is not a speaker. "<Name> will …" puts a person's name in
 * the text and the rules record no speaker for it; a hand-typed owner is a person's own words; both
 * stay exactly as stored because no owner_json points at a speaker.
 */
object ItemOwner {
  /** `<body> — <owner>[ (due …)]` taken apart. [owner] is the raw token, "Unassigned" included. */
  data class Parts(val body: String, val owner: String?, val dueSuffix: String?)

  private val DUE_TAIL = Regex("\\s*(\\(due[^)]*\\))$", RegexOption.IGNORE_CASE)
  private const val SEP = " — "

  /** Mirror of `splitAction` in src/screens/meeting/shared.tsx, keeping the raw owner and due tail. */
  fun split(content: String): Parts {
    val at = content.lastIndexOf(SEP)
    if (at < 0) return Parts(content.trim(), null, null)
    val body = content.substring(0, at).trim()
    var tail = content.substring(at + SEP.length).trim()
    var due: String? = null
    val m = DUE_TAIL.find(tail)
    if (m != null) {
      due = m.groupValues[1]
      tail = tail.substring(0, m.range.first).trim()
    }
    return Parts(body, tail.ifEmpty { null }, due)
  }

  /** The speaker an owner_json points at, or null for anything else (person, unassigned, absent, junk). */
  fun speakerId(ownerJson: String?): String? {
    if (ownerJson.isNullOrBlank()) return null
    return try {
      val o = JSONObject(ownerJson)
      if (o.optString("kind") == "speaker") o.optString("id").takeIf { it.isNotBlank() } else null
    } catch (_: Exception) {
      null
    }
  }

  /**
   * The text with its owner replaced by the speaker's current name, when owner_json names a
   * speaker we still have a name for. Anything else comes back untouched.
   */
  fun resolve(text: String, ownerJson: String?, names: Map<String, String?>): String {
    val id = speakerId(ownerJson) ?: return text
    val name = names[id]?.trim().orEmpty()
    if (name.isEmpty()) return text
    val p = split(text)
    if (p.owner == name) return text
    val head = if (text.lastIndexOf(SEP) < 0) text.trim() else p.body
    return head + SEP + name + (p.dueSuffix?.let { " $it" } ?: "")
  }

  /**
   * A rule-composed overview with each renamed item's stored wording swapped for its current one.
   *
   * The overview ("Decided: …. Next: Send the report — Speaker 1 (due by Friday).") is composed once,
   * at processing time, out of the items' stored text, so the owner token inside it is whatever the
   * speaker was called then. [resolve] fixes the items; nothing fixed this paragraph, and every
   * export carried the old name at the top of a document whose list below said the new one (found
   * on the Nothing A069, 8 Oct). [renames] is `(stored text, resolved text)` per item whose owner
   * changed; the stored text is what the overview embeds, verbatim.
   *
   * Never applied to a summary a person typed or a model wrote: those say what they say.
   */
  fun renameWithin(text: String, renames: List<Pair<String, String>>): String {
    var out = text
    for ((from, to) in renames) {
      if (from.isNotEmpty() && from != to) out = out.replace(from, to)
    }
    return out
  }

  /**
   * The owner_json a freshly extracted rule item should carry, or null when its owner is not the
   * speaker of the line it came from.
   *
   * The rules' first-person branch writes the SPEAKER'S display name as the owner token, so at the
   * moment of extraction "the token equals the source line's speaker's name" is exactly "the owner
   * is that speaker". A named person ("Maya will …") puts a different token there and is left as
   * text. Evaluated only while the names still agree with the text — at extraction, and just before
   * a rename ([AudioDb.adoptRuleOwners]) — never after.
   */
  fun ruleSpeakerJson(text: String, speakerId: String?, speakerName: String?): String? {
    if (speakerId.isNullOrBlank()) return null
    val name = speakerName?.trim().orEmpty()
    if (name.isEmpty()) return null
    val owner = split(text).owner ?: return null
    if (owner != name) return null
    return JSONObject().put("kind", "speaker").put("id", speakerId).toString()
  }
}
