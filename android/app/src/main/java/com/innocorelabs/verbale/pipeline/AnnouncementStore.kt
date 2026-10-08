package com.innocorelabs.verbale.pipeline

/**
 * What the announcement check writes for one verdict, decided apart from the service (D04).
 *
 * Two different facts, two different rules, and mixing them is how a clip that was found but too
 * quiet leaked into a meeting's transcript and title:
 *  - the LAG (where the clip sits in the capture) is stored whenever the clip was FOUND, heard or
 *    not, so ASR can keep off it ([AnnouncementSpan.lagToExclude]);
 *  - the STAMP (`announced_at`, the proof the room was told) is written only when it was HEARD.
 *
 * [RecordingService] applies the plan; the SQL it ends in (`setAnnouncedLag`, `markAnnounced`) is
 * device-only.
 */
object AnnouncementStore {
  data class Plan(val lagMs: Long?, val stampHeard: Boolean)

  fun plan(verdict: AnnouncementVerifier.Verdict): Plan =
    Plan(lagMs = AnnouncementSpan.lagToExclude(verdict), stampHeard = verdict.heard)

  /**
   * Whether this capture speaks the "this meeting is being recorded" clip at all.
   *
   * Not when it resumes an earlier capture (it would talk over the middle of a meeting), and not for
   * a dictation: a dictation is one person's own voice, there is no room to tell, and the clip plays
   * into the recording and takes the first ~5.7 seconds of what they say with it (ASR keeps the clip
   * out of its windows, and a word that overlaps the clip goes too). Found on the Nothing A069: an
   * 8-second dictation, "Call Priya at five o'clock tomorrow and send her the budget.", was
   * transcribed as "And punch it.".
   */
  fun announces(resumed: Boolean, mode: String?): Boolean = !resumed && mode != "dictation"

  /** Writes the lag through [write] when the plan has one, and only then. */
  fun applyLag(plan: Plan, write: (Long) -> Unit) {
    plan.lagMs?.let(write)
  }
}
