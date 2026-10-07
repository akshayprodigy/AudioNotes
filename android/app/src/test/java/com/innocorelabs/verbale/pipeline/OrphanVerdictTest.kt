package com.innocorelabs.verbale.pipeline

import com.innocorelabs.verbale.pipeline.OrphanVerdict.Kind
import org.junit.Assert.assertEquals
import org.junit.Test

/** N03: the per-row decision of `AudioDb.recoverOrphanedRecordings`. The SQL is device-only. */
class OrphanVerdictTest {
  @Test fun nothingOnDiskIsAFailedStart() {
    assertEquals(Kind.ERROR, OrphanVerdict.of(0L, "recording").kind)
  }

  @Test fun justUnderASecondIsStillAFailedStart() {
    assertEquals(Kind.ERROR, OrphanVerdict.of(31_999L, "recording").kind)
  }

  @Test fun exactlyASecondIsNotMoreThanASecond() {
    assertEquals(Kind.ERROR, OrphanVerdict.of(32_000L, "recording").kind)
  }

  @Test fun oneByteOverIsAMeetingWithItsDurationFromTheByteCount() {
    val v = OrphanVerdict.of(32_001L, "recording")
    assertEquals(Kind.CAPTURED, v.kind)
    assertEquals(1_000L, v.durationMs)
    assertEquals(60_000L, OrphanVerdict.of(1_920_000L, "recording").durationMs)
  }

  @Test fun aRowNotInRecordingIsNeverTouched() {
    for (s in listOf("captured", "error", "failed", "done", "asr", "vad", "")) {
      assertEquals(s, Kind.LEAVE, OrphanVerdict.of(5_000_000L, s).kind)
      assertEquals(s, Kind.LEAVE, OrphanVerdict.of(0L, s).kind)
    }
  }
}
