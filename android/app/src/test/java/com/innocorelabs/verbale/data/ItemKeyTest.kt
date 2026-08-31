package com.innocorelabs.verbale.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * The same vectors as __tests__/actionKey.test.ts, plus the literal keys the JS implementation
 * produces for them.
 *
 * The shared cases prove the two implementations agree on the RULES. The literal expectations are
 * what actually pin them together: two hash functions can both be case-insensitive and still
 * disagree on every value, and it is the values that decide whether a user's correction survives
 * into the document they send to a client.
 */
class ItemKeyTest {
  @Test fun matchesTheJavaScriptImplementation() {
    // Produced by itemKey() in src/screens/meeting/shared.tsx.
    assertEquals("30:502262517", ItemKey.of("Ana to draft the mapping table"))
    assertEquals("23:-33342988", ItemKey.of("I'll do it. — Speaker 1"))
    assertEquals(
      "56:202981010",
      ItemKey.of("Ravi will check with finance about reissuing the orders."),
    )
  }

  @Test fun ignoresWhitespaceAndCase() {
    val base = ItemKey.of("Ana to draft the mapping table")
    assertEquals(base, ItemKey.of("  Ana to draft the mapping table  "))
    assertEquals(base, ItemKey.of("Ana  to   draft the mapping table"))
    assertEquals(base, ItemKey.of("ANA TO DRAFT THE MAPPING TABLE"))
  }

  /**
   * A non-breaking space is an ordinary thing to find in a transcript, and it is exactly where the
   * two languages disagree by default: JS's `\s` folds it, Kotlin's does not unless asked.
   */
  @Test fun foldsUnicodeWhitespaceTheWayJavaScriptDoes() {
    val base = ItemKey.of("Ana to draft the mapping table")
    assertEquals(base, ItemKey.of("Ana\u00A0to draft the\u00A0mapping table"))
    assertEquals(base, ItemKey.of("\u00A0Ana to draft the mapping table\u00A0"))
  }

  @Test fun differsWhenTheWordingDiffers() {
    assertNotEquals(
      ItemKey.of("Ana to draft the mapping table"),
      ItemKey.of("Ravi to draft the mapping table"),
    )
    // A tick must not carry over to a different item that happens to be a prefix.
    assertNotEquals(ItemKey.of("Ana to draft"), ItemKey.of("Ana to draft the mapping table"))
  }
}
