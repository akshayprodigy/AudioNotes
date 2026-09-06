package com.innocorelabs.verbale.pipeline

import java.util.Random
import kotlin.math.PI
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Whether the room was told, decided from the recording rather than from the media player.
 *
 * Split deliberately. Stage one — is the clip in the recording — is tested on synthetic signals,
 * because testing it on the real ones would mean committing a recording of somebody's room. Stage
 * two — was it loud enough to be evidence — is tested on the REAL captures, because loudness
 * envelopes are not invertible to speech and can be committed safely. That is also the stage that
 * actually decides, so the real-world ground truth sits where it counts.
 *
 * See src/test/resources/announcement/README.md.
 */
class AnnouncementVerifierTest {

  // ---------------------------------------------------------------- stage one: is it there

  /** A stand-in clip with speech-like structure: sweeping tone, two "sentences", a gap between. */
  private fun syntheticClip(seconds: Float = 4.5f): ShortArray {
    val n = (16000 * seconds).toInt()
    return ShortArray(n) { i ->
      val t = i / 16000.0
      val silent = t > 2.0 && t < 2.4
      if (silent) 0 else (6000 * sin(2 * PI * (180 + 90 * sin(t * 1.7)) * t)).toInt().toShort()
    }
  }

  private fun room(n: Int, level: Int, seed: Long = 3): ShortArray {
    val rng = Random(seed)
    return ShortArray(n) { (rng.nextGaussian() * level).toInt().toShort() }
  }

  private fun mix(bed: ShortArray, clip: ShortArray, at: Int, gain: Float): ShortArray {
    val out = bed.copyOf()
    for (i in clip.indices) {
      val j = at + i
      if (j < out.size) out[j] = (out[j] + clip[i] * gain).toInt().coerceIn(-32768, 32767).toShort()
    }
    return out
  }

  @Test
  fun the_clip_is_found_where_it_was_put() {
    val clip = syntheticClip()
    val capture = mix(room(16000 * 12, 200), clip, at = 6400, gain = 1f)
    val m = AnnouncementVerifier.findClip(capture, clip)!!
    // 6400 samples at 16 kHz is 0.4s, which is 40 envelope frames.
    assertEquals("lag in 10ms frames", 40.0, m.lagFrames.toDouble(), 3.0)
    assertTrue("a real match towers over the background", m.peakOverBackground > 2f)
  }

  @Test
  fun a_recording_that_never_contained_the_clip_has_no_peak() {
    val clip = syntheticClip()
    val v = AnnouncementVerifier.describe(room(16000 * 12, 800), clip)
    assertFalse("nothing to find", v.found)
    assertFalse(v.heard)
  }

  @Test
  fun a_loud_unrelated_voice_at_the_start_is_not_an_announcement() {
    // The false positive that loudness alone would produce: somebody says "right, let's begin"
    // over the first seconds and the room then goes quiet. Loud, and not this clip.
    val clip = syntheticClip()
    val other = syntheticClip(4.5f).let { c ->
      val rng = Random(11)
      ShortArray(c.size) { (rng.nextGaussian() * 5000).toInt().toShort() }
    }
    val capture = mix(room(16000 * 12, 120), other, at = 6400, gain = 1f)
    val v = AnnouncementVerifier.describe(capture, clip)
    assertFalse("loud, but not this signal: $v", v.heard)
  }

  @Test
  fun the_clip_buried_under_the_room_is_found_but_is_not_evidence() {
    // The real-world case. Present in the file, useless to anybody reading the transcript.
    val clip = syntheticClip()
    val capture = mix(room(16000 * 12, 2500), clip, at = 6400, gain = 0.04f)
    val v = AnnouncementVerifier.describe(capture, clip)
    assertFalse("too quiet to prove anything: $v", v.heard)
  }

  @Test
  fun the_clip_over_a_quiet_room_is_evidence() {
    val clip = syntheticClip()
    val capture = mix(room(16000 * 12, 150), clip, at = 6400, gain = 1f)
    val v = AnnouncementVerifier.describe(capture, clip)
    assertTrue("clear playback into a quiet room: $v", v.heard)
  }

  @Test
  fun a_capture_shorter_than_the_clip_decides_nothing() {
    val clip = syntheticClip()
    assertFalse(AnnouncementVerifier.heardIn(room(16000, 100), clip))
  }

  // ---------------------------------------------------------------- stage two: was it evidence
  //
  // Real envelopes from six recordings on a Pixel 7 Pro. Ground truth is the transcript: two of
  // them opened with the disclosure, three had the clip present but under the room ("no speech
  // found" came back for two), and one had the announcement switched off entirely.

  private fun fixture(name: String): FloatArray =
    javaClass.classLoader!!.getResourceAsStream("announcement/$name")!!
      .bufferedReader().readText()
      .split(",", "\n", "\r")
      .filter { it.isNotBlank() }
      .map { it.trim().toFloat() }
      .toFloatArray()

  private val clipFrames = 450 // the bundled clip is 4.5s

  private fun ratio(name: String, lagFrames: Int) =
    AnnouncementVerifier.loudnessRatio(fixture(name), clipFrames, lagFrames)

  @Test
  fun the_two_whose_transcripts_opened_with_the_disclosure_clear_the_bar() {
    assertTrue("heard-1", ratio("heard-1.txt", 37) >= AnnouncementVerifier.MIN_LOUDNESS_RATIO)
    assertTrue("heard-2", ratio("heard-2.txt", 24) >= AnnouncementVerifier.MIN_LOUDNESS_RATIO)
  }

  @Test
  fun the_three_that_played_under_the_room_do_not() {
    // Playback completed on all three. This is the entire reason the class exists.
    assertTrue("unheard-2", ratio("unheard-2.txt", 28) < AnnouncementVerifier.MIN_LOUDNESS_RATIO)
    assertTrue("unheard-3", ratio("unheard-3.txt", 25) < AnnouncementVerifier.MIN_LOUDNESS_RATIO)
    assertTrue("unheard-4", ratio("unheard-4.txt", 24) < AnnouncementVerifier.MIN_LOUDNESS_RATIO)
  }

  @Test
  fun the_one_with_the_announcement_switched_off_does_not() {
    assertTrue(
      "unheard-1",
      ratio("unheard-1-switched-off.txt", 162) < AnnouncementVerifier.MIN_LOUDNESS_RATIO,
    )
  }

  @Test
  fun the_envelope_is_the_rms_of_each_ten_millisecond_frame() {
    // Pinned because the fixtures were generated with this hop; changing it invalidates them all.
    val pcm = ShortArray(320) { if (it < 160) 100 else 0 }
    val e = AnnouncementVerifier.envelope(pcm)
    assertEquals(2, e.size)
    assertEquals(100f, e[0], 0.5f)
    assertEquals(0f, e[1], 0.5f)
  }
}
