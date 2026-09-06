package com.innocorelabs.verbale.pipeline

import android.content.Context
import android.media.AudioAttributes
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
    /** Played to completion while the microphone was live. The only outcome that is evidence. */
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
      player = MediaPlayer.create(ctx, R.raw.consent_announcement)
        ?: return Outcome.NO_CLIP
      player.setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build(),
      )
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
