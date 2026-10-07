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

  /** Writes the lag through [write] when the plan has one, and only then. */
  fun applyLag(plan: Plan, write: (Long) -> Unit) {
    plan.lagMs?.let(write)
  }
}
