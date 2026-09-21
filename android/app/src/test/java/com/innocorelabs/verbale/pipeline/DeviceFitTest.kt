package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The sentence a cheap phone shows instead of a download button, and the arithmetic behind it.
 *
 * The number in that sentence is the one the person can check against their phone's box, so the
 * tests pin real readings: what the 2019 Galaxy Tab A reports, what a "3 GB" phone reports after
 * the kernel's share, and the gate's own edge.
 */
class DeviceFitTest {
  private val gib = 1L shl 30

  @Test
  fun `the marketed size is the next whole gigabyte above what the kernel reports`() {
    assertEquals(2, DeviceFit.marketedGb(1_818_908L * 1024)) // the Galaxy Tab A, sold as 2 GB
    assertEquals(3, DeviceFit.marketedGb((2.3 * gib).toLong())) // a "3 GB" phone, kernel share taken
    assertEquals(3, DeviceFit.marketedGb((2.8 * gib).toLong()))
    assertEquals(4, DeviceFit.marketedGb((3.6 * gib).toLong()))
    assertEquals(4, DeviceFit.marketedGb(4 * gib)) // exactly whole stays whole
    assertEquals(8, DeviceFit.marketedGb((7.5 * gib).toLong()))
  }

  @Test
  fun `a phone sold as 3 GB fails the gate and a 4 GB one clears it`() {
    // The gate is unchanged from Narrator's; what is new is saying it in the box's units. A "3 GB"
    // phone reports under 3 GiB and so has never run the writer — WRITER_MIN_GB has to say 4.
    assertFalse(DeviceFit.writerFits((2.8 * gib).toLong()))
    assertFalse(DeviceFit.writerFits(DeviceFit.WRITER_MIN_BYTES - 1))
    assertTrue(DeviceFit.writerFits(DeviceFit.WRITER_MIN_BYTES))
    assertTrue(DeviceFit.writerFits((3.6 * gib).toLong()))
    assertEquals(4, DeviceFit.WRITER_MIN_GB)
    assertEquals(3 * gib, DeviceFit.WRITER_MIN_BYTES)
  }

  @Test
  fun `the sentence names both numbers`() {
    assertEquals(
      "Writing the minutes in plain English needs a phone with 4 GB of memory; this one has 2 GB.",
      DeviceFit.writerReason(1_818_908L * 1024),
    )
    assertEquals(
      "Writing the minutes in plain English needs a phone with 4 GB of memory; this one has 3 GB.",
      DeviceFit.writerReason((2.8 * gib).toLong()),
    )
  }
}
