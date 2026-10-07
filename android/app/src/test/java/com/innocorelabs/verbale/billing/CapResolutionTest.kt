package com.innocorelabs.verbale.billing

import com.innocorelabs.verbale.pipeline.CaptureController
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CapResolutionTest {
  @Test fun `a paid session is uncapped and a free one is capped at an hour`() {
    assertEquals(0L, AllowancePolicy.capFor(true))
    assertEquals(3_600_000L, AllowancePolicy.capFor(false))
  }

  // The tile, the shortcut and the record screen all end in CaptureController.start, which asks
  // this and nothing else — there is no caller-supplied cap any more to forget.
  @Test fun `the free cap is the free duration and nothing a caller can change`() {
    assertEquals(AllowancePolicy.FREE_DURATION_MS, AllowancePolicy.capFor(false))
  }

  // The hole this closes: the Quick Settings tile called start(context) with no cap and recorded
  // without a limit. If a caller can supply a cap, one can forget to; so start() takes none.
  @Test fun `capture start takes no cap from its caller`() {
    val starts = CaptureController::class.java.declaredMethods.filter { it.name == "start" }
    assertTrue("CaptureController.start not found", starts.isNotEmpty())
    for (m in starts) {
      assertFalse("start(${m.parameterTypes.joinToString()}) takes a Long", m.parameterTypes.any { it == java.lang.Long.TYPE })
    }
  }
}
