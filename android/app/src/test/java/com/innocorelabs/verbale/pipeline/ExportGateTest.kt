package com.innocorelabs.verbale.pipeline

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Who may send a file out of the app. Every file export is Pro (founder decision, 13 Oct 2026);
 * copying to the clipboard and looking at the preview are not exports and stay free.
 */
class ExportGateTest {
  private val formats = listOf("pdf", "md", "txt", "srt", "mp3")

  @Test fun freeIsRefusedEveryFileFormat() {
    for (op in listOf("share", "shareWith", "exportMp3")) {
      for (f in formats) {
        assertEquals("$op/$f", ExportGate.PRO_REQUIRED, ExportGate.refusal(op, f, paid = false))
      }
    }
  }

  @Test fun proIsAllowedEveryFileFormat() {
    for (op in listOf("share", "shareWith", "exportMp3")) {
      for (f in formats) assertNull("$op/$f", ExportGate.refusal(op, f, paid = true))
    }
  }

  @Test fun renderCopyAndPreviewStayFreeForEveryFormat() {
    for (op in listOf("render", "copy", "preview")) {
      for (f in formats + "transcript") assertNull("$op/$f", ExportGate.refusal(op, f, paid = false))
    }
  }

  /** A format nobody has heard of must not be a way round the gate. */
  @Test fun anUnknownFormatIsRefusedForFree() {
    assertNotNull(ExportGate.refusal("shareWith", "docx", paid = false))
  }

  /**
   * The gate has to live in the native module and be asked BEFORE any work: a screen bug must not
   * be able to hand a file to a Free user. Source-level on purpose — the module needs a React
   * context to construct, which a JVM test cannot build.
   */
  @Test fun shareWithAsksTheGateBeforeAnyWork() = entryPointAsksFirst("fun shareWith(", "shareWith")

  @Test fun shareCannotGrowAPathAroundTheGate() {
    // `share` delegates to shareWith, and must not grow a path of its own around it.
    assertTrue(moduleSource().contains("shareWith(meetingId, format, savedAttribution(), promise)"))
  }

  private fun moduleSource() =
    File("src/main/java/com/innocorelabs/verbale/pipeline/FileExportModule.kt").readText()

  private fun entryPointAsksFirst(fn: String, op: String) {
    val body = moduleSource().let { it.substring(it.indexOf(fn)) }
    val gate = body.indexOf("refuseFree(\"$op\"")
    assertTrue("$fn does not ask the gate", gate in 0..600)
    // ...and the helper it asks really is the gate, fed by the real licence.
    val helper = moduleSource().substringAfter("private fun refuseFree(")
    assertTrue(helper.contains("ExportGate.refusal(op, format, LicenceStore.current(ctx).isPaid)"))
    val work = body.indexOf("document(").let { if (it < 0) Int.MAX_VALUE else it }
    assertTrue("$fn must ask before it reads or writes", gate < work)
  }
}
