package com.innocorelabs.verbale.billing

import com.innocorelabs.verbale.billing.OfferChoice.Offer
import com.innocorelabs.verbale.billing.OfferChoice.Phase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Play lists one entry per OFFER — the base plan itself and every developer offer this account is
 * eligible for — not one per plan. These pin which one the paywall shows and the purchase uses.
 */
class OfferChoiceTest {

  private val monthlyPrice = Phase("₹299", 299_000_000L, "P1M", 0)
  private val annualPrice = Phase("₹2,499", 2_499_000_000L, "P1Y", 0)
  private val freeWeek = Phase("Free", 0L, "P1W", 1)

  private val monthlyBase = Offer("monthly", null, "tok-m", listOf(monthlyPrice))
  private val monthlyTrial = Offer("monthly", "free-trial-7d", "tok-m-trial", listOf(freeWeek, monthlyPrice))
  private val annualBase = Offer("annual", null, "tok-a", listOf(annualPrice))

  @Test fun `a free trial is chosen over the base plan wherever Play lists it`() {
    assertEquals("tok-m-trial", OfferChoice.choose(listOf(monthlyBase, monthlyTrial), "monthly")?.offerToken)
    assertEquals("tok-m-trial", OfferChoice.choose(listOf(monthlyTrial, monthlyBase), "monthly")?.offerToken)
  }

  @Test fun `with no developer offer the base plan is sold`() {
    assertEquals("tok-a", OfferChoice.choose(listOf(monthlyTrial, annualBase), "annual")?.offerToken)
  }

  @Test fun `a paid introductory offer is chosen over the base plan`() {
    val intro = Offer("monthly", "intro", "tok-intro", listOf(Phase("₹99", 99_000_000L, "P1M", 3), monthlyPrice))
    assertEquals("tok-intro", OfferChoice.choose(listOf(monthlyBase, intro), "monthly")?.offerToken)
  }

  @Test fun `an unknown base plan has no offer`() {
    assertNull(OfferChoice.choose(listOf(monthlyBase, annualBase), "weekly"))
  }

  @Test fun `base plans are listed once each in Play's order`() {
    assertEquals(listOf("monthly", "annual"), OfferChoice.basePlanIds(listOf(monthlyBase, monthlyTrial, annualBase)))
  }

  @Test fun `a trial plan is priced at what is charged after the trial`() {
    val p = OfferChoice.describe(monthlyTrial)!!
    assertEquals("₹299", p.price)
    assertEquals(299_000_000L, p.priceMicros)
    assertEquals("P1M", p.period)
    assertNull(p.fullPrice)
    assertEquals("P1W", p.trialPeriod)
    assertEquals(1, p.trialCycles)
  }

  @Test fun `a plain base plan has no trial and no struck price`() {
    val p = OfferChoice.describe(annualBase)!!
    assertEquals("₹2,499", p.price)
    assertEquals("P1Y", p.period)
    assertNull(p.fullPrice)
    assertNull(p.trialPeriod)
    assertEquals(0, p.trialCycles)
  }

  @Test fun `a paid intro shows its price with the standing price struck`() {
    val intro = Offer("monthly", "intro", "tok-intro", listOf(Phase("₹99", 99_000_000L, "P1M", 3), monthlyPrice))
    val p = OfferChoice.describe(intro)!!
    assertEquals("₹99", p.price)
    assertEquals("₹299", p.fullPrice)
    assertNull(p.trialPeriod)
  }
}
