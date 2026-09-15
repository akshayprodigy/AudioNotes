package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The three things the record screen may warn about, and the arithmetic behind each.
 *
 * Every threshold here is a first guess written down where a phone can argue with it — the
 * capture loop logs each transition with its numbers. What these tests pin is the SHAPE of each
 * rule, not the number: a clipped buffer is loud and a merely full one is not; faint needs both
 * enough speech to judge AND a low level (the A07 transcribed −48 dBFS speech perfectly, so that
 * must never read as faint); storage outranks loud outranks faint because losing the recording
 * is the failure the others are trying to prevent.
 */
class CaptureWarningsTest {
  @Test fun `more than one clipped sample in a hundred is loud`() {
    val clipped = ShortArray(1000) { 1000 }
    for (i in 0 until 11) clipped[i] = Short.MAX_VALUE
    assertTrue(CaptureWarnings.clippedFraction(clipped, clipped.size) > CaptureWarnings.CLIP_FRACTION)
    // Full-scale in ONE sample of a thousand is a transient, not clipping.
    val transient = ShortArray(1000) { 1000 }.also { it[3] = Short.MIN_VALUE }
    assertFalse(CaptureWarnings.clippedFraction(transient, transient.size) > CaptureWarnings.CLIP_FRACTION)
    // Loud but not clipped: 90 % of full scale.
    assertEquals(0.0, CaptureWarnings.clippedFraction(ShortArray(1000) { 29_000 }, 1000), 0.0)
  }

  @Test fun `faint needs ten seconds of speech AND a low mean level`() {
    assertTrue(CaptureWarnings.isFaint(speechMs = 12_000, meanRmsDuringSpeech = 0.001))   // −60 dBFS
    assertFalse(CaptureWarnings.isFaint(speechMs = 12_000, meanRmsDuringSpeech = 0.004))  // −48: the A07's meeting
    assertFalse(CaptureWarnings.isFaint(speechMs = 5_000, meanRmsDuringSpeech = 0.001))   // not enough speech to judge
    assertFalse(CaptureWarnings.isFaint(speechMs = 0, meanRmsDuringSpeech = 0.0))          // silence is not faint speech
  }

  @Test fun `minutes left is free bytes at 32 bytes per ms`() {
    assertEquals(10L, CaptureWarnings.minutesLeft(freeBytes = 32L * 60_000 * 10))
    assertEquals(0L, CaptureWarnings.minutesLeft(freeBytes = 0L))
  }

  @Test fun `storage outranks loud outranks faint, and nothing is nothing`() {
    val w = CaptureWarnings.pick(storageMinutesLeft = 4L, loud = true, faint = true, storageWarnAtMinutes = 5L)
    assertEquals(CaptureWarnings.Kind.STORAGE, w?.kind)
    assertEquals(4L, w?.minutesLeft)
    assertEquals(CaptureWarnings.Kind.LOUD, CaptureWarnings.pick(30L, true, true, 5L)?.kind)
    assertEquals(CaptureWarnings.Kind.FAINT, CaptureWarnings.pick(30L, false, true, 5L)?.kind)
    assertNull(CaptureWarnings.pick(30L, false, false, 5L))
  }

  @Test fun `the ring keeps a minute and averages the level inside speech spans`() {
    val ring = RmsRing(windowMs = 60_000)
    ring.add(atMs = 0, rms = 0.010)
    ring.add(atMs = 1_000, rms = 0.002)
    ring.add(atMs = 2_000, rms = 0.002)
    assertEquals(0.002, ring.meanIn(listOf(1_000L to 3_000L)), 1e-9)
    assertEquals(0.0, ring.meanIn(listOf(50_000L to 55_000L)), 1e-9) // no samples there
    ring.add(atMs = 70_000, rms = 0.5)
    assertEquals(0.0, ring.meanIn(listOf(0L to 500L)), 1e-9) // the first sample fell out of the window
    assertEquals(0.5, ring.meanIn(listOf(69_000L to 71_000L)), 1e-9)
  }

  @Test fun `loud is judged over the last two seconds of buffers, not one buffer`() {
    val clip = ClipWindow(windowMs = 2_000)
    clip.add(atMs = 0, fraction = 0.05)       // one hot buffer
    clip.add(atMs = 100, fraction = 0.0)
    clip.add(atMs = 200, fraction = 0.0)
    // Mean over the window: 0.05 / 3 ≈ 0.017 > 1 % — still loud while the hot buffer is inside it.
    assertTrue(clip.mean() > CaptureWarnings.CLIP_FRACTION)
    clip.add(atMs = 2_500, fraction = 0.0)    // the hot buffer is older than two seconds now
    assertFalse(clip.mean() > CaptureWarnings.CLIP_FRACTION)
  }
}
