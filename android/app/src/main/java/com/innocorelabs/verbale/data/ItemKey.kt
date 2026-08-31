package com.innocorelabs.verbale.data

/**
 * The content hash that anchors a tick, and now a hand correction, to a minute.
 *
 * A deliberate mirror of `itemKey` in src/screens/meeting/shared.tsx. Minutes rows are deleted and
 * re-inserted on every reprocess and every speaker merge, so their ids are worthless as an anchor;
 * the key depends on the text and nothing else. JS writes these keys (the tick comes from the
 * Actions tab, the edit from the meeting screen) and native has to READ them, because the export
 * renderer lives here and an exported document that silently drops the user's corrections is worse
 * than one that never offered editing at all.
 *
 * Two mirrors are two chances to drift, so ItemKeyTest pins the same vectors as
 * __tests__/actionKey.test.ts. The arithmetic below is JS's, exactly: `charCodeAt` yields UTF-16
 * code units, which is what Kotlin's Char.code gives, and `| 0` is a wrap to 32-bit signed, which
 * is what Kotlin's Int already does.
 */
object ItemKey {
  /**
   * JavaScript's `\s`, spelled out.
   *
   * Kotlin's `\s` is ASCII-only unless UNICODE_CHARACTER_CLASS is set, and a transcript is exactly
   * the place a non-breaking space turns up. A key that folded whitespace differently on the two
   * sides would read as a different item and lose the edit.
   */
  private val WS = Regex("[ \\t\\n\\u000B\\u000C\\r\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+")

  fun of(content: String): String {
    val norm = WS.replace(content, " ").trim().lowercase()
    var h = 0
    for (c in norm) h = h * 31 + c.code
    return "${norm.length}:$h"
  }
}
