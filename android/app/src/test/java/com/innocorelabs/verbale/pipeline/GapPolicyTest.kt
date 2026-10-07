package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** F26: call interruptions. The rules are pure; whether a real call fires the callback is device-only. */
class GapPolicyTest {
  private fun iv(s: Long, e: Long) = longArrayOf(s, e)
  private fun List<LongArray>.pairs() = map { it.toList() }

  // ---- merge ----

  @Test fun overlappingIntervalsMerge() {
    val out = GapPolicy.normalise(listOf(iv(10_000, 20_000), iv(15_000, 30_000)), 60_000)
    assertEquals(listOf(listOf(10_000L, 30_000L)), out.pairs())
  }

  @Test fun touchingIntervalsMerge() {
    val out = GapPolicy.normalise(listOf(iv(10_000, 20_000), iv(20_000, 25_000)), 60_000)
    assertEquals(listOf(listOf(10_000L, 25_000L)), out.pairs())
  }

  @Test fun anIntervalInsideAnotherIsAbsorbedAndOrderDoesNotMatter() {
    val out = GapPolicy.normalise(listOf(iv(40_000, 50_000), iv(10_000, 30_000), iv(12_000, 14_000)), 60_000)
    assertEquals(listOf(listOf(10_000L, 30_000L), listOf(40_000L, 50_000L)), out.pairs())
  }

  @Test fun separateIntervalsStaySeparate() {
    val out = GapPolicy.normalise(listOf(iv(0, 5_000), iv(5_001, 9_000)), 60_000)
    assertEquals(2, out.size)
  }

  // ---- the 2-second floor ----

  @Test fun anIntervalUnderTwoSecondsIsIgnored() {
    assertTrue(GapPolicy.normalise(listOf(iv(10_000, 11_999)), 60_000).isEmpty())
  }

  @Test fun anIntervalOfExactlyTwoSecondsStays() {
    assertEquals(1, GapPolicy.normalise(listOf(iv(10_000, 12_000)), 60_000).size)
  }

  @Test fun twoShortOnesThatMergeIntoALongOneStay() {
    // 1.5 s + 1.5 s touching is a 3 s interruption: the floor applies after the merge.
    val out = GapPolicy.normalise(listOf(iv(10_000, 11_500), iv(11_500, 13_000)), 60_000)
    assertEquals(listOf(listOf(10_000L, 13_000L)), out.pairs())
  }

  // ---- clamp ----

  @Test fun anIntervalPastTheEndIsClampedToTheRecording() {
    val out = GapPolicy.normalise(listOf(iv(50_000, 90_000)), 60_000)
    assertEquals(listOf(listOf(50_000L, 60_000L)), out.pairs())
  }

  @Test fun anIntervalEntirelyPastTheEndIsDropped() {
    assertTrue(GapPolicy.normalise(listOf(iv(70_000, 90_000)), 60_000).isEmpty())
  }

  @Test fun aNegativeStartIsClampedToZero() {
    assertEquals(listOf(listOf(0L, 5_000L)), GapPolicy.normalise(listOf(iv(-3_000, 5_000)), 60_000).pairs())
  }

  @Test fun clampingHappensBeforeTheFloor() {
    // 1 s of real overlap with the recording is under the floor even though the raw interval was long.
    assertTrue(GapPolicy.normalise(listOf(iv(59_000, 90_000)), 60_000).isEmpty())
  }

  // ---- total ----

  @Test fun theTotalIsTheSumOfTheNormalisedIntervals() {
    val total = GapPolicy.totalMs(listOf(iv(10_000, 20_000), iv(15_000, 30_000), iv(40_000, 41_000), iv(50_000, 70_000)), 60_000)
    assertEquals(20_000L + 10_000L, total) // 10-30 s merged, 40-41 s dropped, 50-60 s clamped
  }

  // ---- the sentence ----

  @Test fun minutesSayMin() {
    assertEquals(
      "Your phone's microphone was silenced for 4 min (a call, or another app) — that part wasn't recorded.",
      GapPolicy.sentence(4 * 60_000L),
    )
  }

  @Test fun underAMinuteCountsSeconds() {
    assertEquals(
      "Your phone's microphone was silenced for 45 seconds (a call, or another app) \u2014 that part wasn't recorded.",
      GapPolicy.sentence(45_000L),
    )
    assertTrue(GapPolicy.sentence(59_999L)!!.contains("for 59 seconds "))
  }

  @Test fun oneSecondIsSingular() {
    assertEquals(
      "Your phone's microphone was silenced for 1 second (a call, or another app) \u2014 that part wasn't recorded.",
      GapPolicy.sentence(1_000L),
    )
    assertTrue(GapPolicy.sentence(2_000L)!!.contains("for 2 seconds "))
  }

  @Test fun underASecondHasNoSentence() {
    assertNull(GapPolicy.sentence(999L))
    assertNull(GapPolicy.sentence(0L))
  }

  @Test fun aMinuteRoundsToWholeMinutes() {
    assertTrue(GapPolicy.sentence(60_000L)!!.contains("for 1 min "))
    assertTrue(GapPolicy.sentence(89_999L)!!.contains("for 1 min "))
    assertTrue(GapPolicy.sentence(90_000L)!!.contains("for 2 min "))
  }

  // ---- JSON ----

  @Test fun theStoredShapeIsAJsonArrayOfPairs() {
    assertEquals("[[10000,20000],[40000,50000]]", GapPolicy.toJson(listOf(iv(10_000, 20_000), iv(40_000, 50_000))))
    assertEquals("[]", GapPolicy.toJson(emptyList()))
  }

  @Test fun readingBackIsLenientAndNeverThrows() {
    assertEquals(listOf(listOf(1L, 2L)), GapPolicy.fromJson("[[1,2]]").pairs())
    assertTrue(GapPolicy.fromJson(null).isEmpty())
    assertTrue(GapPolicy.fromJson("").isEmpty())
    assertTrue(GapPolicy.fromJson("not json").isEmpty())
    assertEquals(listOf(listOf(3L, 4L)), GapPolicy.fromJson("[[1],\"x\",[3,4]]").pairs())
  }

  // ---- the tracker ----

  @Test fun theTrackerClosesAnIntervalWhenSilencingTurnsOff() {
    val t = GapTracker()
    t.onSilenced(true, 10_000)
    t.onSilenced(false, 70_000)
    assertEquals(listOf(listOf(10_000L, 70_000L)), t.finish(100_000).pairs())
  }

  @Test fun anIntervalStillOpenWhenTheRecordingEndsIsClosedAtTheEnd() {
    val t = GapTracker()
    t.onSilenced(true, 10_000)
    assertEquals(listOf(listOf(10_000L, 100_000L)), t.finish(100_000).pairs())
  }

  @Test fun repeatedSilencedEventsDoNotRestartTheInterval() {
    val t = GapTracker()
    t.onSilenced(true, 10_000)
    t.onSilenced(true, 30_000)
    t.onSilenced(false, 40_000)
    t.onSilenced(false, 50_000) // an "off" with nothing open is ignored
    assertEquals(listOf(listOf(10_000L, 40_000L)), t.finish(100_000).pairs())
  }

  @Test fun twoCallsAreTwoIntervals() {
    val t = GapTracker()
    t.onSilenced(true, 10_000); t.onSilenced(false, 20_000)
    t.onSilenced(true, 50_000); t.onSilenced(false, 60_000)
    assertEquals(2, GapPolicy.normalise(t.finish(100_000), 100_000).size)
  }

  @Test fun finishDoesNotCloseTheTrackerForGood() {
    val t = GapTracker()
    t.onSilenced(true, 10_000)
    t.finish(20_000)
    t.onSilenced(false, 30_000)
    assertEquals(listOf(listOf(10_000L, 30_000L)), t.finish(40_000).pairs())
  }

  @Test fun theKeyIsPerMeeting() {
    assertEquals("capture_gaps:abc", GapPolicy.key("abc"))
  }

  @Test fun whatIsStoredJoinsTheEarlierRunAndNormalises() {
    val stored = GapPolicy.toStore("[[10000,20000]]", listOf(iv(15_000, 30_000), iv(90_000, 99_000)), 95_000)
    assertEquals("[[10000,30000],[90000,95000]]", stored)
  }

  @Test fun nothingWorthStoringStoresNothing() {
    assertNull(GapPolicy.toStore(null, listOf(iv(10_000, 11_000)), 60_000))
    assertNull(GapPolicy.toStore(null, emptyList(), 60_000))
    assertNull(GapPolicy.toStore("garbage", emptyList(), 60_000))
  }
}
