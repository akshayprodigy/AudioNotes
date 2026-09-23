package com.innocorelabs.verbale.billing

/**
 * Which Play offer a base plan is sold with, decided without the Billing Library in sight.
 *
 * Play returns one entry per OFFER, not per plan: the base plan itself (offerId null) and every
 * developer offer this Google account is eligible for — at launch, the seven-day free trial.
 * Reading that list as one entry per plan drew two Monthly rows, one of them priced "Free", and
 * sold whichever Play happened to list first.
 *
 * Plain data in and out so the rule runs on the JVM; ProductDetails cannot be built there.
 */
object OfferChoice {
  data class Phase(val formattedPrice: String, val priceMicros: Long, val billingPeriod: String, val cycles: Int)

  data class Offer(val basePlanId: String, val offerId: String?, val offerToken: String, val phases: List<Phase>)

  /** One base plan as the paywall is told it. Field names are the JS PlayPlan's. */
  data class Plan(
    val basePlanId: String,
    val price: String,
    val priceMicros: Long,
    val period: String,
    val fullPrice: String?,
    val trialPeriod: String?,
    val trialCycles: Int,
  )

  /** A free trial: a first phase that costs nothing, followed by one that does. */
  fun isFreeTrial(o: Offer): Boolean = o.phases.size > 1 && o.phases.first().priceMicros == 0L

  /** Base plan ids in the order Play listed them, once each. */
  fun basePlanIds(offers: List<Offer>): List<String> = offers.map { it.basePlanId }.distinct()

  /**
   * The offer to sell [basePlanId] with. Play lists a developer offer only to an account eligible
   * for it, so taking one is always allowed: a free trial first, then any other offer (a paid
   * introductory price), then the plain base plan.
   */
  fun choose(offers: List<Offer>, basePlanId: String): Offer? {
    val mine = offers.filter { it.basePlanId == basePlanId }
    return mine.firstOrNull(::isFreeTrial)
      ?: mine.firstOrNull { it.offerId != null }
      ?: mine.firstOrNull()
  }

  /**
   * What the paywall shows for one offer. `price` is the first amount actually charged — after a
   * free trial, the standing price. `fullPrice` is set only when that first charge is a discount
   * on the standing price: it is the one honest source for a struck-through price.
   */
  fun describe(o: Offer): Plan? {
    val standing = o.phases.lastOrNull() ?: return null
    val charged = o.phases.firstOrNull { it.priceMicros > 0L } ?: return null
    val trial = if (isFreeTrial(o)) o.phases.first() else null
    return Plan(
      basePlanId = o.basePlanId,
      price = charged.formattedPrice,
      priceMicros = charged.priceMicros,
      period = standing.billingPeriod,
      fullPrice = if (charged.priceMicros < standing.priceMicros) standing.formattedPrice else null,
      trialPeriod = trial?.billingPeriod,
      trialCycles = trial?.cycles ?: 0,
    )
  }
}
