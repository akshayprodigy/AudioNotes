package com.innocorelabs.verbale.pipeline

import android.app.ActivityManager
import android.content.Context
import com.innocorelabs.verbale.data.ModelSpec

/**
 * Whether THIS phone can run a model, said before the download rather than discovered after it.
 *
 * The writer (a 1.5 B model, 1.1 GB of weights plus its context) needs memory the cheapest phones
 * do not have. Until 21 Sep 2026 the app knew that — Narrator and LlmModule each carried a 3 GiB
 * gate — but told nobody: onboarding offered the switch, the paywall sold "summaries written, not
 * extracted", Settings showed Get, the trial fetched 1.1 GB, and the meeting then said nothing
 * except, on the Summary tab, that the phone lacked memory. The founder's rule: say it first, and
 * say it on the Pro screen too. This is the one place the fact lives; every screen reads it.
 *
 * Two units on purpose. The gate compares BYTES against `totalMem` (unchanged: 3 GiB). The sentence
 * speaks in the GB a phone is SOLD as, because that is the number the person knows — and the two
 * differ: a phone marketed as "3 GB" reports about 2.8 GiB once the kernel has taken its share,
 * so it fails the gate. `ceil(totalMem / GiB)` recovers the marketed size (measured: the 2019
 * Galaxy Tab A reports 1 818 908 kB = 1.73 GiB, sold as 2 GB), and the requirement in those terms
 * is [WRITER_MIN_GB]: the smallest marketed size that clears 3 GiB is 4.
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
}
