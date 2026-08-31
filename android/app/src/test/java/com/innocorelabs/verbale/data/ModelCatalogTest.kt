package com.innocorelabs.verbale.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The catalog, and in particular which entries sit behind the subscription.
 *
 * Worth pinning because the answer is mostly derived from `kind` rather than listed by id: that is
 * the safe direction for it to be wrong in — a new LLM is gated by default — but it also means
 * adding a model can change the answer without anyone editing the line that decides it.
 */
class ModelCatalogTest {

  @Test
  fun `the writer model and the better ASR are behind the subscription`() {
    val gated = ModelCatalog.ALL.filter { ModelCatalog.needsSubscription(it) }.map { it.id }
    // In catalog order, which is the order they are offered during onboarding.
    assertEquals(listOf("whisper-small", "llm-qwen"), gated)
  }

  /**
   * whisper-base is the free tier's floor and that floor is a promise, so the ASR gate is by id
   * and not by kind. Gating `kind == "asr"` would take the guaranteed path away with it.
   */
  @Test
  fun `the baseline ASR model is never gated`() {
    val base = ModelCatalog.byId("whisper-base")
    assertTrue("whisper-base is missing from the catalog", base != null)
    assertFalse(ModelCatalog.needsSubscription(base!!))
  }

  @Test
  fun `nothing a meeting actually needs is behind the subscription`() {
    // Recording, transcription and rule-based minutes are free forever, and that promise is
    // printed on the web page. A required model that needed paying for would silently break it.
    for (spec in ModelCatalog.REQUIRED) {
      assertFalse(
        "${spec.id} is required but gated — the free tier could not work",
        ModelCatalog.needsSubscription(spec),
      )
    }
  }

  @Test
  fun `every gated model is optional, so declining it leaves a working app`() {
    for (spec in ModelCatalog.ALL.filter { ModelCatalog.needsSubscription(it) }) {
      assertFalse(spec.required)
    }
  }

  @Test
  fun `every model has a sha256 and a size to verify a download against`() {
    for (spec in ModelCatalog.ALL) {
      assertEquals("${spec.id} sha256 is not 64 hex chars", 64, spec.sha256.length)
      assertTrue("${spec.id} sha256 is not hex", spec.sha256.all { it in "0123456789abcdef" })
      assertTrue("${spec.id} has no size", spec.sizeBytes > 0)
    }
  }

  @Test
  fun `ids and filenames are unique`() {
    // Two specs sharing a filename would race into the same file on disk, and `installed` would
    // report whichever wrote last for both.
    assertEquals(ModelCatalog.ALL.size, ModelCatalog.ALL.map { it.id }.toSet().size)
    assertEquals(ModelCatalog.ALL.size, ModelCatalog.ALL.map { it.filename }.toSet().size)
  }

  @Test
  fun `every upstream is https`() {
    // These are weights that get loaded and executed. Plain http would let anyone on the path
    // choose them, and the sha256 check only helps if the catalog itself arrived intact.
    for (spec in ModelCatalog.ALL) {
      assertTrue("${spec.id} is not https", spec.upstream.startsWith("https://"))
    }
  }
}
