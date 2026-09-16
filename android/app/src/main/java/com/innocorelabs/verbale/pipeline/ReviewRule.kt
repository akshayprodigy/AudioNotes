package com.innocorelabs.verbale.pipeline

import com.innocorelabs.verbale.data.AudioDb

/**
 * What the model could not settle — the founder's answer to "what enters the queue".
 *
 * A confidently typed item with an owner and no date trouble is shown with its label and never
 * asked about. Everything else is one card. A person's confirmed or rejected is theirs: the rule
 * never overwrites it, and the reconciler's own needs_review is left as it is. Mirrored in
 * src/pipeline/reviewRule.ts against cpp/tests/golden/review_rule.json.
 */
object ReviewRule {
  /** Why the item is in the queue, in priority order — the card shows the first. */
  enum class Reason { TYPE, STATUS, OWNER, DATE }

  data class Decision(val review: String, val reason: String?)

  fun decide(
    kind: String, type: String, status: String, confidence: String, ownerKind: String,
    dateSaid: String?, dateNorm: Long?, currentReview: String,
  ): Decision {
    if (currentReview in AudioDb.Review.BY_A_PERSON) return Decision(currentReview, null)
    if (currentReview == AudioDb.Review.NEEDS_REVIEW) return Decision(currentReview, null)
    val reason = when {
      type == "uncertain" || confidence == "low" -> Reason.TYPE
      status != "open" -> Reason.STATUS
      kind == "action" && ownerKind == "unassigned" -> Reason.OWNER
      !dateSaid.isNullOrEmpty() && dateNorm == null -> Reason.DATE
      else -> null
    }
    return if (reason == null) Decision(AudioDb.Review.SUGGESTED, null)
    else Decision(AudioDb.Review.NEEDS_REVIEW, reason.name.lowercase())
  }
}
