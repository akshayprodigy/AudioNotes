package com.innocorelabs.verbale.data

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The duplicate-card defect: a rule decision indexed from `minutes` and again from `items`.
 * Once the rules have produced items, the minutes index keeps only what items do not hold.
 */
class MinuteIndexRuleTest {
  @Test fun aMigratedMeetingIndexesOnlyWhatItemsDoNotHold() =
    assertEquals("kind NOT IN ('summary','decision','action','question')", AudioDb.minuteKindsToIndex(hasRuleItems = true))

  @Test fun anUnmigratedMeetingKeepsEveryKindButTheSummary() =
    assertEquals("kind <> 'summary'", AudioDb.minuteKindsToIndex(hasRuleItems = false))
}
