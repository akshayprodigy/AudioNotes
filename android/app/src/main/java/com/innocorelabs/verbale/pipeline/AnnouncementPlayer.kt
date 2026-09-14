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
     * Playback finished. NOT on its own proof that the room was told — see [verified].
     *
     * Six recordings on a Pixel 7 Pro produced this outcome identically while the room heard the
     * disclosure in only two of them. Whether the clip arrives loudly enough to be evidence turns
     * on physical things Android never reports, so this value must be passed through [verified]
     * with the recording's own answer before anything is stamped.
     */
    PLAYED,
    /** The user turned it off. Not a failure; simply no evidence. */
    DISABLED,
    /** The device is muted or in Do Not Disturb, so nobody heard it. */
    SILENCED,
    /**
     * It played, and the recording says the room did not get it: either absent from the capture
     * or so far under the room that no transcript will carry it. Not a crash, not a mistake by
     * anybody — and not evidence, which is the only thing that matters here.
     */
    NOT_HEARD,
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
      NOT_HEARD ->
        "The announcement played but the recording did not pick it up, so it is not proof of " +
          "anything. Tell the room yourself, and try moving the phone off the surface it is on."
    }
  }

  /**
   * The only way a meeting becomes announced: playback finished AND the recording carries it.
   *
   * One function because the rule was previously spread between the player and its caller, and
   * that is how an app ends up claiming the room was told on the strength of a MediaPlayer
   * callback. Anything that is not PLAYED passes through unchanged — a switched-off announcement
   * was not a failure, and a silenced one already has its own message.
   */
  @JvmStatic
  fun verified(playback: Outcome, heardInRecording: Boolean): Outcome =
    if (playback == Outcome.PLAYED && !heardInRecording) Outcome.NOT_HEARD else playback

  /**
   * The bundled clip as 16 kHz mono PCM16, for comparing against what the microphone recorded.
   *
   * Walks the RIFF chunks to find `data` rather than assuming a 44-byte header, because the header
   * is only 44 bytes when nothing else is in the file, and afconvert does not promise that.
   */
  /** The bundled clip's length in ms, for keeping its span out of ASR. Null if it cannot be read. */
  fun bundledClipMs(ctx: Context): Long? =
    bundledClipPcm(ctx)?.let { it.size * 1000L / RecordingService.SAMPLE_RATE }

  fun bundledClipPcm(ctx: Context): ShortArray? = try {
    ctx.resources.openRawResource(R.raw.consent_announcement).use { input ->
      val bytes = input.readBytes()
      var pos = 12 // past "RIFF" <size> "WAVE"
      var dataAt = -1
      var dataLen = 0
      while (pos + 8 <= bytes.size) {
        val id = String(bytes, pos, 4, Charsets.US_ASCII)
        val size = le32(bytes, pos + 4)
        if (id == "data") {
          dataAt = pos + 8
          dataLen = minOf(size, bytes.size - dataAt)
          break
        }
        pos += 8 + size + (size and 1)
      }
      if (dataAt < 0 || dataLen <= 0) return null
      ShortArray(dataLen / 2) { i ->
        val b = dataAt + i * 2
        ((bytes[b].toInt() and 0xFF) or (bytes[b + 1].toInt() shl 8)).toShort()
      }
    }
  } catch (e: Exception) {
    Log.w(TAG, "could not read the bundled clip", e)
    null
  }

  private fun le32(b: ByteArray, at: Int): Int =
    (b[at].toInt() and 0xFF) or ((b[at + 1].toInt() and 0xFF) shl 8) or
      ((b[at + 2].toInt() and 0xFF) shl 16) or ((b[at + 3].toInt() and 0xFF) shl 24)

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
