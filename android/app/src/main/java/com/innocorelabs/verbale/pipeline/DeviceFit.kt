package com.innocorelabs.verbale.pipeline

import android.app.ActivityManager
import android.content.Context
import android.util.Log
import com.innocorelabs.verbale.data.ModelSpec
import java.io.File

/**
 * Whether THIS phone can run what the app is about to offer it — said before the download, the
 * trial or the price, rather than discovered after. Three facts, one place, every screen reads it:
 *
 *  - MEMORY. The writer (a 1.5 B model, 1.1 GB of weights plus its context) needs memory the
 *    cheapest phones do not have. Until 21 Sep 2026 the app knew that — Narrator and LlmModule each
 *    carried a 3 GiB gate — but told nobody: onboarding offered the switch, the paywall sold
 *    "summaries written, not extracted", Settings showed Get, the trial fetched 1.1 GB, and the
 *    meeting then said nothing except, on the Summary tab, that the phone lacked memory.
 *  - PROCESSOR. The engines are compiled for ARMv8.2 with fp16 and dot-product instructions
 *    (cpp/CMakeLists.txt), which Cortex-A53 and A73 cores do not have — and those are 64-bit cores
 *    in phones sold in the tens of millions (Helio G25/G35/G70/G80/G85/P60/P70, Snapdragon
 *    425–450/636/660: Redmi 9/9A/9C/10A, Redmi Note 7/9, Realme Narzo…). Play filters by ABI, not
 *    by instruction set, so the app installs there and the first transcription dies with SIGILL.
 *    No test phone ever had one of these cores (the Pixel 7 Pro and the Helio G99 A07 are v8.2);
 *    the 2019 Galaxy Tab A does (A53+A73) and only escapes because it runs the 32-bit build.
 *  - DISK. A download is refused, with the numbers, when the phone cannot hold it — instead of
 *    failing part-way through 1.1 GB with an error nobody can act on.
 *
 * The founder's rule (21 Sep): say it first, say it on the Pro screen too, and say it in the
 * person's units. Every sentence here is composed once, like DiarBudget's skip reasons, and the
 * screens print it verbatim. Nothing here knows any particular device; the tablet appears only as
 * the measurement that fixed the numbers.
 *
 * Memory comes in two units on purpose. The gate compares BYTES against `totalMem` (unchanged:
 * 3 GiB). The sentence speaks in the GB a phone is SOLD as, because that is the number the person
 * knows — and the two differ: a phone marketed as "3 GB" reports about 2.8 GiB once the kernel has
 * taken its share, so it fails the gate. `ceil(totalMem / GiB)` recovers the marketed size
 * (measured: the Galaxy Tab A reports 1 818 908 kB = 1.73 GiB, sold as 2 GB), and the requirement
 * in those terms is [WRITER_MIN_GB]: the smallest marketed size that clears 3 GiB is 4.
 */
object DeviceFit {
  private const val GIB = 1L shl 30

  /** The gate, in bytes of `ActivityManager.MemoryInfo.totalMem`. Matches what Narrator ran on. */
  const val WRITER_MIN_BYTES = 3L * GIB

  /** The same gate as the phone's box would print it. */
  const val WRITER_MIN_GB = 4

  fun totalBytes(ctx: Context): Long {
    val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return 0
    return ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }.totalMem
  }

  /** The size this phone was sold as: the next whole GiB above what the kernel reports. */
  @JvmStatic
  fun marketedGb(totalBytes: Long): Int = ((totalBytes + GIB - 1) / GIB).toInt()

  @JvmStatic
  fun writerFits(totalBytes: Long): Boolean = totalBytes >= WRITER_MIN_BYTES

  fun writerFits(ctx: Context): Boolean = writerFits(totalBytes(ctx))

  /** Only the writer needs the room. The 37 MB meaning index runs anywhere and stays offered. */
  fun needsWriterRam(spec: ModelSpec): Boolean = spec.id == "llm-qwen"

  /**
   * Why this phone cannot run the model, as one sentence the screens print verbatim — or null
   * when it can. Composed here, like DiarBudget's skip reasons, so the number is right on every
   * screen and there is one sentence to change.
   */
  @JvmStatic
  fun writerReason(totalBytes: Long): String =
    "Writing the minutes in plain English needs a phone with $WRITER_MIN_GB GB of memory; " +
      "this one has ${marketedGb(totalBytes)} GB."

  fun unsupportedReason(ctx: Context, spec: ModelSpec): String? {
    if (!needsWriterRam(spec)) return null
    val total = totalBytes(ctx)
    return if (writerFits(total)) null else writerReason(total)
  }

  // ---- the processor ----

  /**
   * What `-march=armv8.2-a+fp16+dotprod` (cpp/CMakeLists.txt) lets the compiler emit anywhere in
   * the engines, as the kernel names them in /proc/cpuinfo: `asimdhp` is vector fp16 arithmetic,
   * `asimddp` the dot-product. A core without either faults on the first kernel that uses them.
   */
  val NEEDED_ARM64_FEATURES: List<String> = listOf("asimdhp", "asimddp")

  const val CPU_REASON =
    "This phone's processor is missing instructions the speech engine needs (ARMv8.2 " +
      "half-precision and dot-product), so Verbale cannot transcribe on it. Nothing has been downloaded."

  /**
   * True when every core the kernel lists has the instructions the 64-bit engines were built for.
   * A 32-bit process runs engines built without them (the bench build) and always fits.
   *
   * Reads /proc/cpuinfo, which every app may read; an unreadable or empty file is treated as
   * fitting — refusing a phone on a guess would turn a rare read failure into a dead app, whereas
   * the crash this guards against is on cores that always list their features.
   */
  fun cpuFits(): Boolean {
    if (!android.os.Process.is64Bit()) return true
    val info = try { File("/proc/cpuinfo").readText() } catch (e: Exception) {
      Log.w("DeviceFit", "cannot read /proc/cpuinfo: $e"); ""
    }
    return cpuFits(info)
  }

  /** The decision over the file's text, so a JVM test can hand it the cores it has never met. */
  @JvmStatic
  fun cpuFits(cpuinfo: String): Boolean {
    val cores = cpuinfo.lineSequence()
      .filter { it.startsWith("Features") }
      .map { line -> line.substringAfter(':').trim().split(Regex("\\s+")).toSet() }
      .toList()
    if (cores.isEmpty()) return true
    return cores.all { features -> NEEDED_ARM64_FEATURES.all { it in features } }
  }

  /** The processor's sentence, or null. One call for the screens. */
  fun cpuReason(): String? = if (cpuFits()) null else CPU_REASON

  // ---- the disk ----

  /** What must still be free AFTER a download: the .part rename, the database, the next recording. */
  const val DOWNLOAD_HEADROOM_BYTES = 100L shl 20

  fun freeBytes(ctx: Context): Long = ctx.filesDir.usableSpace

  @JvmStatic
  fun spaceFits(needBytes: Long, freeBytes: Long): Boolean = freeBytes >= needBytes + DOWNLOAD_HEADROOM_BYTES

  @JvmStatic
  fun spaceReason(what: String, needBytes: Long, freeBytes: Long): String =
    "Downloading $what needs ${mb(needBytes + DOWNLOAD_HEADROOM_BYTES)} MB free; this phone has " +
      "${mb(freeBytes)} MB free. Clear some space and try again."

  /** Megabytes as the screens quote them — decimal, rounded — so the two numbers compare by eye. */
  private fun mb(bytes: Long): Long = Math.round(bytes / 1e6)
}
