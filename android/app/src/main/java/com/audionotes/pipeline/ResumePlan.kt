package com.audionotes.pipeline

/** The native pipeline stages, in order. Minutes runs in JS and is not part of this plan. */
enum class Stage { VAD, ASR, DIARIZE }

/**
 * Decides, from a meeting's persisted state, which native stages still need to run.
 *
 * Persisted ROWS are the source of truth, not `status`: status advances when a stage STARTS, so a
 * process killed mid-stage can leave status ahead of the rows actually committed. We only skip a
 * stage when its output rows exist. "VAD ran but produced no segments" is a genuine no-speech
 * recording, not resumable — remaining() returns empty and the caller marks it terminal.
 */
object ResumePlan {
  data class State(
    val status: String,
    val hasSegments: Boolean,
    val hasUtterances: Boolean,
    val hasSpeakers: Boolean,
  )

  fun remaining(s: State): List<Stage> {
    // Terminal no-speech: VAD already ran (status past 'captured') and committed zero segments.
    if (!s.hasSegments && s.status != "captured") return emptyList()

    val stages = mutableListOf<Stage>()
    if (!s.hasSegments) stages += Stage.VAD
    if (!s.hasUtterances) stages += Stage.ASR
    if (!s.hasSpeakers) stages += Stage.DIARIZE
    return stages
  }
}
