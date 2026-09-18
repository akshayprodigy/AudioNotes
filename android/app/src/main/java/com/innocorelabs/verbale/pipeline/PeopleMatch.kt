package com.innocorelabs.verbale.pipeline

import java.util.regex.Pattern

/**
 * Pure match rule for remembered voices (Phase 4).
 *
 * Given a speaker's voice vector and the list of remembered people, return the id of the person the
 * speaker sounds like — or null when the match is not confident enough, when someone already named
 * this speaker, or when there is no one to match against.
 *
 * All vectors are unit length; cosine is the dot product. The constants and thresholds are pinned
 * by measurement (see §4 of the Phase 4 brief) and by the golden in cpp/tests/golden/people_match.json.
 */
object PeopleMatch {
  const val MATCH_COSINE = 0.65f
  const val MATCH_MARGIN = 0.10f

  /** A speaker whose display_name is not this pattern has already been named by a person. */
  private val DEFAULT_SPEAKER_NAME = Pattern.compile("^Speaker \\d+$")

  data class Person(val id: String, val name: String, val voice: FloatArray)

  /**
   * @param voice the speaker's unit vector voiceprint.
   * @param people already-known people, in `ORDER BY created_at` order so ties resolve to the oldest.
   * @param displayName the speaker's current `display_name` — if it is not "Speaker N" the speaker
   *   has already been named and is skipped.
   * @return the matched person's id, or null.
   */
  fun suggest(
    voice: FloatArray,
    people: List<Person>,
    displayName: String,
  ): String? {
    if (!DEFAULT_SPEAKER_NAME.matcher(displayName).matches()) return null
    if (people.isEmpty()) return null

    var bestIdx = -1
    var bestCos = -1f
    var secondCos = -1f
    for (i in people.indices) {
      val cos = dot(voice, people[i].voice)
      if (cos > bestCos) {
        secondCos = bestCos
        bestCos = cos
        bestIdx = i
      } else if (cos < bestCos && cos > secondCos) {
        secondCos = cos
      }
    }

    if (bestCos < MATCH_COSINE) return null
    // secondCos is -1 when no person has a strictly lower cosine (one person, or all tied); the
    // margin is then unbounded, so a tie does not block the suggestion — insertion order picks it.
    if (bestCos - secondCos < MATCH_MARGIN) return null

    return people[bestIdx].id
  }

  private fun dot(a: FloatArray, b: FloatArray): Float {
    var s = 0f
    val n = minOf(a.size, b.size)
    for (i in 0 until n) s += a[i] * b[i]
    return s
  }
}
