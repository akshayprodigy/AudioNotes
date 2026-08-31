package com.innocorelabs.verbale.pipeline

/**
 * The native pipeline stages, in order.
 *
 * NARRATE is the on-device LLM pass that writes the summary, the MOM narrative and the library
 * one-liner. It is last because it reads the finished transcript, and it is a STAGE rather than a
 * tail call because it is the only expensive step that can be interrupted halfway — see Narrator,
 * which commits each chunk's digest to the database as it lands.
 *
 * Rule-based minutes are deliberately not a stage. They cost 8 ms, they are the guaranteed floor,
 * and re-running them is cheaper than deciding whether to.
 */
enum class Stage { VAD, ASR, DIARIZE, NARRATE }

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
    val hasNarrative: Boolean,
  )

  /**
   * [forceNarrate] re-plans narration for a meeting that already has prose — the Summary tab's
   * "Write it again". It only ever ADDS the stage; it cannot resurrect a meeting with no
   * transcript, because the no-speech branch below returns before it is consulted and a stage that
   * could never complete would leave the meeting being swept forever.
   */
  fun remaining(s: State, forceNarrate: Boolean = false): List<Stage> {
    // Terminal no-speech: VAD already ran (status past 'captured') and committed zero segments.
    // NARRATE is deliberately NOT appended on this path. There is no transcript to narrate, so the
    // stage could never complete, and handing the caller a stage it cannot finish would leave the
    // meeting being swept forever instead of being marked terminal.
    if (!s.hasSegments && s.status != "captured") return emptyList()

    val stages = mutableListOf<Stage>()
    if (!s.hasSegments) stages += Stage.VAD
    if (!s.hasUtterances) stages += Stage.ASR
    if (!s.hasSpeakers) stages += Stage.DIARIZE
    if (!s.hasNarrative || forceNarrate) stages += Stage.NARRATE
    return stages
  }
}
