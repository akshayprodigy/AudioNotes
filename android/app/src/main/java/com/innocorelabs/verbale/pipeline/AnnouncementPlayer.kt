package com.innocorelabs.verbale.pipeline

import android.content.Context
import android.media.AudioManager
import android.media.MediaPlayer
import android.util.Log
import com.innocorelabs.verbale.R

/**
 * Speaks the recording disclosure into the room, while the microphone is already live.
 *
 * The point is not the sound. It is that capture has started, so the clip lands in the audio and
 * becomes the first line of the transcript — the recording carries its own proof that the room was
 * told, and that proof travels with the exported file. A consent flag in a local database proves
 * nothing to anybody off the phone.
 *
 * A bundled clip rather than TextToSpeech, which was the obvious first answer. Google's TTS
 * synthesises over the NETWORK for its better voices, and the next thing on the roadmap is a
 * screen reading "Network calls this month: 1 licence check". A consent feature cannot be the
 * thing that falsifies the privacy claim. A bundled file is also deterministic, verifiable, and
 * has no engine to be missing.
 */
object AnnouncementPlayer {

  private const val TAG = "AnnouncementPlayer"

  /** Whether the room actually heard it, and if not, what to tell the person holding the phone. */
  enum class Outcome {
    /**
     * Played to completion while the microphone was live. The only outcome that stamps a meeting.
     *
     * KNOWN GAP, measured on a Pixel 7 Pro 6 Sep 2026. This means playback finished, NOT that the
     * room heard it. Six recordings on one device with one build: two captured the clip clearly
     * (loudness in the announcement window 2.5x and 1.8x the rest of the meeting, and the
     * transcript's first line was the disclosure), four captured nothing measurable (1.0-1.1x) —
     * while AudioTrack reported all 72076 frames delivered every time, routing stayed
     * AUDIO_DEVICE_OUT_SPEAKER, onCompletion fired, and logcat was clean. The variable is
     * physical: how the phone is lying, what is over the speaker. Nothing in the audio stack
     * reports it.
     *
     * So on those four runs the app would have stamped the meeting as announced when the room was
     * told nothing — the exact failure the design says is worse than having no announcement at
     * all, because the person stops checking.
     *
     * The fix is to stop trusting the player and ask the recording: cross-correlate the captured
     * PCM's first seconds against res/raw/consent_announcement.wav (the same measurement that
     * found this) and stamp only on a match. We own both signals, so this is cheap. Until then
     * `announced_at` means "we played it", and no user-facing copy may claim more.
     */
    PLAYED,
    /** The user turned it off. Not a failure; simply no evidence. */
    DISABLED,
    /** The device is muted or in Do Not Disturb, so nobody heard it. */
    SILENCED,
    /** No clip is bundled in this build. */
    NO_CLIP,
    /** Playback started and did not finish: audio focus lost, decoder error, speaker fault. */
    FAILED;

    /** True only when the room was actually told. Nothing else may stamp a meeting. */
    fun wasHeard(): Boolean = this == PLAYED

    /** What to show the person holding the phone. Empty for the outcomes that need no message. */
    fun userMessage(): String = when (this) {
      PLAYED, DISABLED -> ""
      SILENCED -> "Your phone is on silent, so the announcement was not heard. Tell the room yourself."
      NO_CLIP -> "The announcement is unavailable in this build. Tell the room yourself."
      FAILED -> "The announcement did not finish playing. Tell the room yourself."
    }
  }

  /**
   * Play the clip and block until it finishes or fails.
   *
   * Synchronous on purpose: the caller is the capture thread's setup path, and the outcome decides
   * whether the meeting may be stamped. An async version would have to invent a rule for what to
   * claim before the answer arrived, and the only safe rule is to claim nothing.
   */
  fun announce(ctx: Context, enabled: Boolean): Outcome {
    if (!enabled) return Outcome.DISABLED

    val audio = ctx.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    if (audio != null && audio.getStreamVolume(AudioManager.STREAM_MUSIC) == 0) {
      return Outcome.SILENCED
    }

    var player: MediaPlayer? = null
    return try {
      // The two-argument create(), with its default STREAM_MUSIC attributes.
      //
      // The four-argument form (AudioAttributes + generateAudioSessionId) was tried and reverted.
      // setAudioAttributes() AFTER create() is worse still — create() returns an already PREPARED
      // player and the call is rejected in that state ("trying to set audio attributes called in
      // state 8" on a Pixel 7 Pro), so it silently does nothing. This form is the one measured to
      // put the clip into the capture, so it is the one that stays until something better is
      // MEASURED, not reasoned about.
      //
      // What playback completing does NOT prove: see announce()'s note on Outcome.PLAYED.
      player = MediaPlayer.create(ctx, R.raw.consent_announcement)
        ?: return Outcome.NO_CLIP
      val done = java.util.concurrent.CountDownLatch(1)
      var ok = false
      player.setOnCompletionListener { ok = true; done.countDown() }
      player.setOnErrorListener { _, what, extra ->
        Log.w(TAG, "announcement error what=$what extra=$extra")
        done.countDown()
        true
      }
      player.start()
      // Bounded so a wedged decoder cannot hold the capture thread open forever. The clip is a
      // single sentence; ten seconds is far past any honest playback.
      val finished = done.await(10, java.util.concurrent.TimeUnit.SECONDS)
      if (finished && ok) Outcome.PLAYED else Outcome.FAILED
    } catch (e: Exception) {
      Log.w(TAG, "announcement failed", e)
      Outcome.FAILED
    } finally {
      try {
        player?.release()
      } catch (e: Exception) {
        Log.w(TAG, "player release failed", e)
      }
    }
  }
}
