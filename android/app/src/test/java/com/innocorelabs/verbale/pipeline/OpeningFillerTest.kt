package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The auto-title's filler strip, which exists in two places and must agree in both.
 *
 * Android titles a meeting headlessly through ProcessingEngine, while the JS path titles the same
 * recording when the app drives it. The cases below are copied from
 * `__tests__/retitle.test.ts` deliberately: if one side's word list changes and the other's does
 * not, the same audio gets two different names depending on who processed it, and nothing else
 * would notice.
 */
class OpeningFillerTest {

  @Test
  fun `drops the throat-clearing a meeting opens with`() {
    assertEquals(
      "there are three different stages to the design",
      ProcessingEngine.stripOpeningFiller("So there are three different stages to the design"),
    )
    assertEquals(
      "let us start with the budget review",
      ProcessingEngine.stripOpeningFiller("Okay so um yeah let us start with the budget review"),
    )
    assertEquals(
      "the pricing question from last week",
      ProcessingEngine.stripOpeningFiller("Right, so the pricing question from last week"),
    )
  }

  @Test
  fun `leaves a title that opens with something meaningful alone`() {
    val real = "Pricing for the enterprise tier needs a decision today"
    assertEquals(real, ProcessingEngine.stripOpeningFiller(real))
  }

  @Test
  fun `never strips a meeting down to nothing`() {
    assertEquals("So, right", ProcessingEngine.stripOpeningFiller("So, right"))
    assertEquals("Okay then", ProcessingEngine.stripOpeningFiller("Okay then"))
    assertEquals("", ProcessingEngine.stripOpeningFiller(""))
  }

  @Test
  fun `only strips whole words`() {
    // "Nowhere" and "Sofa" begin with filler spellings and are not filler.
    val a = "Nowhere in the contract does it say that"
    val b = "Sofa delivery is blocked on the warehouse"
    assertEquals(a, ProcessingEngine.stripOpeningFiller(a))
    assertEquals(b, ProcessingEngine.stripOpeningFiller(b))
  }
}
