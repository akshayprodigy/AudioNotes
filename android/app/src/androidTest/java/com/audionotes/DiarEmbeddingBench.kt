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
 * Compares candidate speaker-embedding models for the diarization stage.
 *
 * Diarization is the pipeline's dominant cost (it runs over the WHOLE recording, not just the
 * VAD spans), so the embedding model is chosen on measured cost as much as on language coverage.
 * Push candidates to the app's own external files dir and run:
 *
 *   adb push <models> /sdcard/Android/data/com.audionotes/files/diarbench/
 *   adb shell am instrument -w -e class com.audionotes.DiarEmbeddingBench \
 *     com.audionotes.test/androidx.test.runner.AndroidJUnitRunner
 *
 * NOT /data/local/tmp: that is shell_data_file, and SELinux denies untrusted_app any access to
 * it, so every candidate there is simply unreadable from this process.
 *
 * Reports wall time and the speaker count each model lands on. The speaker count is a sanity
 * check, not an accuracy score: this fixture is not labelled, so a model that returns a plausible
 * number is only "not obviously broken". Real DER would need a diarization test set.
 */
@RunWith(AndroidJUnit4::class)
class DiarEmbeddingBench {

  private val ctx: Context get() = InstrumentationRegistry.getInstrumentation().targetContext
  private val stage: File get() = File(ctx.getExternalFilesDir(null), "diarbench")

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
   * Scores each candidate against a fixture whose speaker turns are known.
   *
   * `two.pcm` in the stage dir is 6 alternating turns from two synthesised voices (a male en_GB
   * and a female en_US), so the correct answer is 2 speakers with boundaries at the turn edges.
   * That is an EASY case — two synthetic voices differ far more than two colleagues in one room —
   * so treat a good score as "not broken" rather than as evidence of real-world accuracy. It does
   * discriminate in the direction that matters, though: a model that cannot split these two would
   * certainly fail on a real meeting.
   */
  @Test
  fun score_against_known_two_speaker_fixture() {
    val seg = ModelCatalog.fileFor(ctx, "diar-seg")?.takeIf { it.exists() }
    assumeTrue("segmentation model not installed", seg != null)
    val pcm = File(stage, "two.pcm")
    assumeTrue("no two.pcm in $stage", pcm.exists() && pcm.length() > 0)

    // Turn boundaries in ms, from the lengths of the synthesised clips (A,B,A,B,A,B).
    val bounds = longArrayOf(0, 5410, 11655, 17111, 22568, 26678, 32694)
    fun truthAt(ms: Long): Int {
      for (i in 0 until 6) if (ms >= bounds[i] && ms < bounds[i + 1]) return i % 2
      return 1
    }

    val candidates = (stage.listFiles()?.filter { it.name.endsWith(".onnx") } ?: emptyList())
      .sortedBy { it.name }
    val only = InstrumentationRegistry.getArguments().getString("model")
    val selected = if (only == null) candidates else candidates.filter { it.name.contains(only) }
    assumeTrue("no candidate matching '$only'", selected.isNotEmpty())

    for (m in selected) {
      val local = File(ctx.cacheDir, "cand_${m.name}")
      if (local.length() != m.length()) m.copyTo(local, overwrite = true)

      val segs = NativeBridge.nativeDiarize(
        pcm.absolutePath, seg!!.absolutePath, local.absolutePath, 16000, 0,
      )
      val n = segs.size / 3
      val speakers = (0 until n).map { segs[it * 3 + 2] }.distinct()

      // Frame-level agreement, scored at the midpoint of each returned segment and credited under
      // whichever label-to-truth mapping is better — cluster ids are arbitrary, so "speaker 0" in
      // the output need not be speaker A in the fixture.
      var agreeDirect = 0L
      var agreeSwapped = 0L
      var total = 0L
      for (i in 0 until n) {
        val start = segs[i * 3]
        val end = segs[i * 3 + 1]
        val label = segs[i * 3 + 2].toInt()
        val truth = truthAt((start + end) / 2)
        val dur = end - start
        total += dur
        if (label % 2 == truth) agreeDirect += dur else agreeSwapped += dur
      }
      val agree = maxOf(agreeDirect, agreeSwapped)
      val pct = if (total > 0) agree * 100.0 / total else 0.0
      println(
        "%-56s %d speakers (want 2), %d segments, %.1f%% of speech labelled consistently"
          .format(m.name.take(56), speakers.size, n, pct),
      )
    }
  }

  @Test
  fun compare_embedding_models() {
    val seg = ModelCatalog.fileFor(ctx, "diar-seg")?.takeIf { it.exists() }
    val listed = stage.listFiles()
    println("stage dir      : $stage")
    println("  exists=${stage.exists()} isDir=${stage.isDirectory} canRead=${stage.canRead()}")
    println("  listFiles    : ${listed?.joinToString { it.name } ?: "<null>"}")
    println("segmentation   : ${seg?.absolutePath ?: "<missing>"}")

    assumeTrue("segmentation model not installed", seg != null)
    val candidates = (listed?.filter { it.name.endsWith(".onnx") } ?: emptyList())
      .sortedBy { it.name }
    assumeTrue("no candidates in $stage", candidates.isNotEmpty())

    val pcm = fixture()
    val audioMs = pcm.length() / 32

    // A model sherpa cannot load takes the whole process down with SIGSEGV rather than returning
    // an error, so one bad candidate would destroy the results for every other one in the same
    // run. Allow selecting a single candidate per invocation:
    //   adb shell am instrument -w -e class ... -e model wespeaker com.audionotes.test/...
    val only = InstrumentationRegistry.getArguments().getString("model")
    val selected = if (only == null) candidates else candidates.filter { it.name.contains(only) }
    assumeTrue("no candidate matching '$only'", selected.isNotEmpty())

    println("=".repeat(78))
    println("Diarization embedding-model comparison — ${audioMs / 1000}s fixture")
    println("=".repeat(78))

    for (m in selected) {
      // Load from INTERNAL storage. onnxruntime memory-maps the weights, and mmap on the
      // FUSE-backed /sdcard fails — sherpa then dereferences the null session and takes the
      // process down. Verified: the model shipping in production crashes identically when read
      // from /sdcard and loads fine from here, so this is the path, not the model.
      val local = File(ctx.cacheDir, "cand_${m.name}")
      if (local.length() != m.length()) m.copyTo(local, overwrite = true)

      val t = System.currentTimeMillis()
      val segs = NativeBridge.nativeDiarize(
        pcm.absolutePath, seg!!.absolutePath, local.absolutePath, 16000, 0,
      )
      val ms = System.currentTimeMillis() - t
      val n = segs.size / 3
      val speakers = (0 until n).map { segs[it * 3 + 2] }.distinct().size
      println(
        "%-56s %6d ms  (%.2fx realtime)  %d segments, %d speakers"
          .format(m.name.take(56), ms, ms.toDouble() / audioMs, n, speakers),
      )
    }
    println("=".repeat(78))
  }
}
