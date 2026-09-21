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

  // Real /proc/cpuinfo shapes. The kernel prints one block per core; only the Features line matters.
  private fun cores(n: Int, features: String) =
    (0 until n).joinToString("") { "processor\t: $it\nFeatures\t: $features\nCPU part\t: 0xd03\n\n" }

  private val v80 = "fp asimd evtstrm aes pmull sha1 sha2 crc32 cpuid" // Cortex-A53, A73
  private val v82 = "fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp cpuid asimdrdm lrcpc dcpop asimddp" // A55, A76

  @Test
  fun `a phone of A53 or A73 cores does not fit and a v8_2 phone does`() {
    assertFalse(DeviceFit.cpuFits(cores(8, v80))) // Helio G25/G35: eight A53
    assertFalse(DeviceFit.cpuFits(cores(6, v80) + cores(2, v80))) // Helio G80/G85, Exynos 7904: A53 + A73, both v8.0
    assertTrue(DeviceFit.cpuFits(cores(6, v82) + cores(2, v82))) // Helio G99: A55 + A76
    // A mixed SoC is judged by its weakest core: the scheduler can run the engine on any of them.
    assertFalse(DeviceFit.cpuFits(cores(4, v82) + cores(4, v80)))
    // Both instructions, not either: fp16 without the dot-product still faults in the quantised kernels.
    assertFalse(DeviceFit.cpuFits(cores(8, v82.replace(" asimddp", ""))))
  }

  @Test
  fun `the 32-bit view of the same tablet has neither name and is refused by the parser alone`() {
    // What the Galaxy Tab A prints to a 32-bit reader (measured 21 Sep 2026). The parser says no;
    // it is cpuFits()'s 32-bit short-circuit that lets the bench build run — the v7a engines are
    // built without these instructions.
    val aarch32 = "half thumb fastmult vfp edsp neon vfpv3 tls vfpv4 idiva idivt lpae evtstrm aes pmull sha1 sha2 crc32"
    assertFalse(DeviceFit.cpuFits(cores(8, aarch32)))
  }

  @Test
  fun `an unreadable cpuinfo is not a refusal`() {
    assertTrue(DeviceFit.cpuFits(""))
    assertTrue(DeviceFit.cpuFits("processor\t: 0\nCPU part\t: 0xd03\n"))
  }

  @Test
  fun `the disk sentence carries the headroom and both numbers`() {
    val need = 1_117_320_736L
    assertTrue(DeviceFit.spaceFits(need, need + DeviceFit.DOWNLOAD_HEADROOM_BYTES))
    assertFalse(DeviceFit.spaceFits(need, need + DeviceFit.DOWNLOAD_HEADROOM_BYTES - 1))
    assertEquals(
      "Downloading the writer needs 1222 MB free; this phone has 800 MB free. Clear some space and try again.",
      DeviceFit.spaceReason("the writer", need, 800_000_000L),
    )
  }
}
