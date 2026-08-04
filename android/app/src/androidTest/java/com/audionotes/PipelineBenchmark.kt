package com.audionotes

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.audionotes.data.ModelCatalog
import com.audionotes.pipeline.NativeBridge
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Measures the pipeline against BUILD_PLAN section 10: "30-minute recording processed in under
 * 5 minutes". Not a pass/fail test — it prints a table and never asserts, so it can be run on any
 * device to produce comparable numbers.
 *
 *   adb shell am instrument -w -e class com.audionotes.PipelineBenchmark \
 *     com.audionotes.test/androidx.test.runner.AndroidJUnitRunner
 *
 * Uses a ~3-minute fixture rather than the 15-second one: whisper pays a fixed model-load cost per
 * transcribe() call, which on a short clip dominates the measurement and flatters the realtime
 * factor. Three minutes is long enough for the steady-state rate to show through.
 *
 * Reported as a REALTIME FACTOR (processing seconds per audio second), because that is the number
 * that extrapolates. Anything above 1.0x means the device cannot keep up with a meeting as it
 * happens; the target implies roughly 0.17x end to end.
 */
@RunWith(AndroidJUnit4::class)
class PipelineBenchmark {

  private val ctx: Context get() = InstrumentationRegistry.getInstrumentation().targetContext

  private fun fixture(): File {
    val out = File(ctx.cacheDir, "bench.pcm")
    if (!out.exists() || out.length() == 0L) {
      InstrumentationRegistry.getInstrumentation().context.assets.open("bench.pcm").use { input ->
        out.outputStream().use { input.copyTo(it) }
      }
    }
    return out
  }

  /**
   * Android's thermal pressure level (0 = none, higher = throttling). Printed alongside every
   * measurement so a reader can tell a real result from one taken on a cooking phone.
   */
  private fun thermalStatus(): Int = try {
    val pm = ctx.getSystemService(android.os.PowerManager::class.java)
    pm.currentThermalStatus
  } catch (e: Exception) {
    -1
  }

  private fun fmt(ms: Long, audioMs: Long) =
    "%6d ms  (%.2fx realtime)".format(ms, ms.toDouble() / audioMs)

  @Test
  fun benchmark_pipeline_stages_and_thread_counts() {
    val vad = File(ModelCatalog.modelsDir(ctx), "silero_vad.onnx").takeIf { it.exists() }
    val asr = ModelCatalog.fileFor(ctx, "whisper-base")?.takeIf { it.exists() }
    assumeTrue("models not installed", vad != null && asr != null)

    val pcm = fixture()
    val audioMs = pcm.length() / 32
    val cores = Runtime.getRuntime().availableProcessors()

    println("=".repeat(72))
    println("AudioNotes pipeline benchmark")
    println("  device      : ${android.os.Build.MODEL} (${android.os.Build.SOC_MODEL}), $cores cores")
    println("  fixture     : ${audioMs / 1000}s of audio")
    println("  thermal     : ${thermalStatus()} (0 = unthrottled)")
    println("=".repeat(72))

    // ---- VAD ----
    var t = System.currentTimeMillis()
    val spans = NativeBridge.nativeVad(pcm.absolutePath, vad!!.absolutePath, 16000)
    val vadMs = System.currentTimeMillis() - t
    val n = spans.size / 2
    val speechMs = (0 until n).sumOf { spans[it * 2 + 1] - spans[it * 2] }
    println("VAD           ${fmt(vadMs, audioMs)}   -> $n spans, ${speechMs / 1000}s speech " +
      "(${100 - speechMs * 100 / audioMs}% stripped)")

    val starts = LongArray(n) { spans[it * 2] }
    val ends = LongArray(n) { spans[it * 2 + 1] }

    // ---- ASR thread sweep ----
    //
    // METHODOLOGY. A single pass per thread count is worthless on a phone. Sustained inference
    // heats the SoC into thermal throttling within a couple of minutes, so a sequential sweep
    // measures "how hot was the device by then" at least as much as it measures thread scaling —
    // an early first run looks fast and the last one looks catastrophic no matter what value it
    // was testing. (An earlier sequential 2/4/6/8 sweep here produced exactly that artefact:
    // 8 threads appeared 5.5x slower than 4, purely because it ran last at 92 C.)
    //
    // So: several REPS, thread counts round-robined within each rep, and the MEDIAN reported.
    // Interleaving spreads any thermal drift evenly across all the candidates instead of
    // loading it onto whichever ran last. Thermal status is printed per rep, because a run
    // conducted entirely under throttling tells you about a hot phone, not about thread scaling.
    val candidates = listOf(2, 4, 6, 8).filter { it <= cores }
    val samples = candidates.associateWith { mutableListOf<Long>() }
    val reps = 3

    println("\nASR (whisper base q5_1) — $reps reps, interleaved; cost per SPEECH second:")
    for (rep in 1..reps) {
      for (threads in candidates) {
        val before = thermalStatus()
        t = System.currentTimeMillis()
        NativeBridge.nativeTranscribe(pcm.absolutePath, asr!!.absolutePath, 16000, starts, ends, threads)
        val ms = System.currentTimeMillis() - t
        samples.getValue(threads).add(ms)
        println("  rep $rep  %d threads  %6d ms  (%.2fx)  thermal=%d->%d"
          .format(threads, ms, ms.toDouble() / speechMs, before, thermalStatus()))
      }
    }

    println("\n  median of $reps reps:")
    var best = Long.MAX_VALUE
    var bestThreads = 0
    for (threads in candidates) {
      val med = samples.getValue(threads).sorted()[reps / 2]
      val spread = samples.getValue(threads).max() - samples.getValue(threads).min()
      println("    %d threads  %6d ms  (%.2fx per speech-second)  spread %d ms"
        .format(threads, med, med.toDouble() / speechMs, spread))
      if (med < best) { best = med; bestThreads = threads }
    }
    println("  best: $bestThreads threads (median ${best}ms)")

    // ---- Diarization ----
    val seg = ModelCatalog.fileFor(ctx, "diar-seg")?.takeIf { it.exists() }
    val emb = ModelCatalog.fileFor(ctx, "diar-emb")?.takeIf { it.exists() }
    var diarMs = 0L
    if (seg != null && emb != null) {
      t = System.currentTimeMillis()
      NativeBridge.nativeDiarize(pcm.absolutePath, seg.absolutePath, emb.absolutePath, 16000, 0)
      diarMs = System.currentTimeMillis() - t
      println("\nDiarization   ${fmt(diarMs, audioMs)}   (runs on the FULL file, not the VAD spans)")
    }

    // ---- Extrapolation to the acceptance criterion ----
    // Meetings are 30-40% silence (BUILD_PLAN 4.2); use 35% so ASR is charged only for speech.
    val meetingS = 30 * 60.0
    val meetingSpeechS = meetingS * 0.65
    val vadS = vadMs / 1000.0 / (audioMs / 1000.0) * meetingS
    val asrS = best / 1000.0 / (speechMs / 1000.0) * meetingSpeechS
    val diarS = diarMs / 1000.0 / (audioMs / 1000.0) * meetingS

    println("\n" + "=".repeat(72))
    println("Extrapolated to a 30-minute meeting (65%% speech):")
    println("  VAD          %6.1f min".format(vadS / 60))
    println("  ASR          %6.1f min   (at $bestThreads threads)".format(asrS / 60))
    println("  Diarization  %6.1f min".format(diarS / 60))
    println("  TOTAL        %6.1f min   vs the 5.0 min target -> %.1fx over"
      .format((vadS + asrS + diarS) / 60, (vadS + asrS + diarS) / 300))
    println("  without diarization: %.1f min".format((vadS + asrS) / 60))
    println("=".repeat(72))
  }
}
