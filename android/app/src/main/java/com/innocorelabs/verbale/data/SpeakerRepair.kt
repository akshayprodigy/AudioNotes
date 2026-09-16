package com.innocorelabs.verbale.data

/**
 * What re-diarization must leave alone.
 *
 * `assignSpeakers` used to delete every speaker row and reassign every line, which was right when
 * nothing but the machine had ever touched them. Once a person has renamed a voice, created one,
 * or said who really spoke a line, the machine's next pass has to work around that — the
 * alternative is a Redo that undoes their afternoon. Pure so the rule is testable off a device;
 * AudioDb does the SQL.
 */
object SpeakerRepair {
  /** A person's own voice, never the clusterer's: `speakers.cluster_label` for db.addSpeaker. */
  const val HUMAN_CLUSTER = "human"

  data class SpeakerRow(val id: String, val clusterLabel: String, val displayName: String)

  private val machineName = Regex("^Speaker [1-9][0-9]*$")

  /** "Speaker 3" and nothing else: the exact shape assignSpeakers writes. Anything else was typed. */
  fun isMachineName(name: String): Boolean = machineName.matches(name)

  /**
   * Speakers that survive a re-clustering: human-created, renamed, or the target of any speaker
   * edit. [edits] is line id → speaker id, the meeting's `target_kind = 'speaker'` rows.
   */
  fun protectedIds(speakers: List<SpeakerRow>, edits: Map<String, String>): Set<String> {
    val referenced = edits.values.toSet()
    return speakers
      .filter { it.clusterLabel == HUMAN_CLUSTER || !isMachineName(it.displayName) || it.id in referenced }
      .map { it.id }
      .toSet()
  }

  /** The lines a person has spoken for; the clusterer may not touch them. */
  fun pinnedLines(edits: Map<String, String>): Set<String> = edits.keys

  /** The edits to write back after re-clustering — those whose speaker row still exists. */
  fun reapplicable(edits: Map<String, String>, survivingSpeakerIds: Set<String>): Map<String, String> =
    edits.filterValues { it in survivingSpeakerIds }
}
