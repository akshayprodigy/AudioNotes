package com.innocorelabs.verbale

import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.pipeline.Minutes
import com.innocorelabs.verbale.pipeline.Reconciler
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The matrix for [Reconciler].
 *
 * Every case here is a thing a person loses if the matcher is wrong, and the reason this file is
 * long is that all of those losses are SILENT: nobody notices the item they ticked last week is
 * unticked, or that the owner they confirmed in March is back to "Unassigned". There is no crash
 * and no error toast, so the tests are the only alarm.
 *
 * A plain JVM test, no database and no device, because [Reconciler] is pure. If a change to it
 * ever needs a `System.currentTimeMillis()` or a DB read, the boundary has moved to the wrong
 * place — persistence belongs in `AudioDb.replaceItems`, policy belongs here.
 *
 * These tests are themselves checked by measurement, not by inspection: `npm run mutate:reconciler`
 * deletes one rule from Reconciler.kt at a time and fails if nothing here notices. Five assertions
 * in this sub-project have already read as coverage while being incapable of failing. Run it after
 * changing either file — and if it reports PATCH DID NOT APPLY, re-point the patch rather than
 * dropping it, because a mutation that no longer applies proves nothing while looking like it did.
 */
class ReconcilerTest {

  /** March 3rd 2026, a date a person confirmed something on. Anything but "now". */
  private val LONG_AGO = 1_772_000_000_000L

  private fun stored(
    id: String,
    text: String,
    start: Long,
    end: Long,
    review: String = "suggested",
    kind: String = "action",
    genVersion: String = "rules@1",
    createdAt: Long = LONG_AGO,
    // One flag, not three. WHICH table said a person engaged with this row — the review column, a
    // tick in item_done, the older tick in action_done, a hand correction in edits — is decided by
    // AudioDb.items() and pinned on a real database by ItemsDbTest. Reconciler is told the answer
    // and must never assemble it, because the next signal will arrive in a fifth table and will
    // not fail to compile here.
    //
    // The default follows the review because AudioDb.items() computes it that way: a row whose
    // review a PERSON set is touched by definition, and a fixture saying otherwise would describe
    // a state no database can hold — a test that passes against an impossible row proves nothing.
    // Pass it explicitly for the interesting cases: a `suggested` row that a person ticked or
    // rewrote (touched anyway), or a `needs_review` row nobody has been near (not touched, because
    // the machine set that flag itself).
    touched: Boolean = review in AudioDb.Review.BY_A_PERSON,
  ) = AudioDb.StoredItem(
    id, kind, text, review, genVersion, start, end,
    listOf(AudioDb.StoredSource(start, end, 0, text.length, "u-old")),
    createdAt, touched,
  )

  private fun incoming(text: String, start: Long, end: Long, kind: String = "action") =
    Minutes.Item(kind, text, listOf(Minutes.Source("u-new", start, end, 0, text.length)), start, end)

  // ---------------------------------------------------------------------------------------------
  // The seven-case matrix from the spec.
  // ---------------------------------------------------------------------------------------------

  /**
   * A re-ASR that changed nothing must keep every id.
   *
   * Lost: everything. If the trivial case does not hold, every tick, owner and confirmation in the
   * meeting is discarded by a reprocess that produced identical output.
   */
  @Test fun identicalTextAndTimingKeepsTheId() {
    val plan = Reconciler.reconcile(
      listOf(stored("id-1", "Send the report — Unassigned", 5000, 9000)),
      listOf(incoming("Send the report — Unassigned", 5000, 9000)),
    )
    assertEquals(1, plan.rows.size)
    assertEquals("id-1", plan.rows[0].id)
    assertEquals("suggested", plan.rows[0].review)
  }

  /**
   * The defect this whole sub-project exists to fix: one word re-recognised, tick survives.
   *
   * Lost: the tick, the owner and the confirmation on an item whose only change is that the
   * recogniser heard "reports" instead of "report". Under the old text-hash keying this is a
   * different item and the tick is gone with no notice at all.
   */
  @Test fun oneChangedWordAtTheSameMomentKeepsTheId() {
    val plan = Reconciler.reconcile(
      listOf(stored("id-1", "Send the report — Unassigned", 5000, 9000)),
      listOf(incoming("Send the reports — Unassigned", 5000, 9000)),
    )
    assertEquals(1, plan.rows.size)
    assertEquals("id-1", plan.rows[0].id)
    assertEquals("suggested", plan.rows[0].review)
    // The id is the old one; everything else is the NEW run's. Keeping the stored text here would
    // mean a reprocess never improves anything it recognises better the second time.
    assertEquals("Send the reports — Unassigned", plan.rows[0].item.text)
    assertEquals("u-new", plan.rows[0].item.sources[0].utteranceId)
  }

  /**
   * Same moment, not one word in common: two different sentences, not a weak match.
   *
   * Lost: the confirmed item outright. Pairing them would hand its id — and its tick — to an
   * unrelated commitment and overwrite its text, so the only record of what the person confirmed
   * is replaced by a sentence they never saw. A review flag does not undo that.
   */
  @Test fun noSharedWordsIsADifferentItemEvenAtTheSameMoment() {
    val plan = Reconciler.reconcile(
      listOf(stored("id-1", "Book the venue — Raj", 5000, 9000, "confirmed")),
      listOf(incoming("Send quarterly figures to Priya", 5200, 9100)),
    )
    assertEquals(2, plan.rows.size)
    val fresh = plan.rows.first { it.item.text == "Send quarterly figures to Priya" }
    assertNotEquals("id-1", fresh.id)
    assertEquals("suggested", fresh.review)
    val kept = plan.rows.first { it.id == "id-1" }
    assertEquals("Book the venue — Raj", kept.item.text)
    assertEquals("needs_review", kept.review)
  }

  /**
   * Same words, a different part of the meeting: a different item that happens to rhyme.
   *
   * Lost: correctness in the other direction. "Send the report" said in the stand-up and again an
   * hour later in the review are two commitments; carrying a tick from one to the other marks work
   * done that nobody did.
   */
  @Test fun sameTextAtADifferentMomentIsANewItem() {
    val plan = Reconciler.reconcile(
      listOf(stored("id-1", "Send the report — Unassigned", 5000, 9000)),
      listOf(incoming("Send the report — Unassigned", 3_600_000, 3_604_000)),
    )
    assertEquals(1, plan.rows.size)
    assertNotEquals("id-1", plan.rows[0].id)
    assertEquals("suggested", plan.rows[0].review)
  }

  /**
   * Overlapping in time but barely alike: carried forward, and flagged rather than guessed at.
   *
   * Lost: either the state (if we called it a new item) or the person's trust (if we silently
   * pretended "Cancel the quarterly report" is the same commitment as "Send the quarterly report
   * to finance"). The answer is neither: keep the row, and say out loud that a human should look.
   */
  @Test fun anAmbiguousMatchIsFlaggedForReview() {
    val plan = Reconciler.reconcile(
      listOf(stored("id-1", "Send the quarterly report to finance — Priya", 5000, 9000, "confirmed")),
      listOf(incoming("Cancel the quarterly report — Unassigned", 5200, 9100)),
    )
    assertEquals(1, plan.rows.size)
    assertEquals("id-1", plan.rows[0].id)
    assertEquals("needs_review", plan.rows[0].review)
  }

  /**
   * A decision that reversed between two runs is never a confident match.
   *
   * "We will ship on Friday" and "We will not ship on Friday" share seven tokens of eight and
   * score 0.875 — well clear of the threshold, and opposite in meaning.
   *
   * Lost: the confirmation, attached to its own reversal. The person confirmed that the team
   * ships on Friday; after the reprocess the row says they do not ship on Friday and still reads
   * as confirmed by them. Nothing on screen says a thing changed. The row is still carried — the
   * tick is not thrown away — it is carried and flagged.
   */
  @Test fun aNegationFlipIsNeverAConfidentMatch() {
    val plan = Reconciler.reconcile(
      listOf(stored("id-1", "We will ship on Friday — Unassigned", 5000, 9000, "confirmed")),
      listOf(incoming("We will not ship on Friday — Unassigned", 5000, 9000)),
    )
    assertEquals(1, plan.rows.size)
    assertEquals("id-1", plan.rows[0].id)
    assertEquals("needs_review", plan.rows[0].review)
  }

  /**
   * The same, spelled as a contraction, which is how people actually talk.
   *
   * Exercises the `n't` rule rather than the explicit word list — the two halves of the guard fail
   * independently, so they are tested independently.
   *
   * Lost: exactly what the previous test protects, for every sentence that says "won't" instead
   * of "will not".
   */
  @Test fun aContractedNegationFlipIsCaughtToo() {
    val plan = Reconciler.reconcile(
      listOf(stored("id-1", "We will ship on Friday — Unassigned", 5000, 9000, "confirmed")),
      listOf(incoming("We won't ship on Friday — Unassigned", 5000, 9000)),
    )
    assertEquals("needs_review", plan.rows[0].review)
  }

  /**
   * Two texts that both negate are the same sentence re-recognised, and stay confident.
   *
   * Lost: the guard's whole value. A negation check that fires whenever a negation is PRESENT,
   * rather than when it CHANGED, would flag every negative item in every meeting on every
   * reprocess — and a review queue that flags everything says nothing.
   */
  @Test fun twoTextsThatBothNegateStillMatchConfidently() {
    val plan = Reconciler.reconcile(
      listOf(stored("id-1", "We will not ship on Friday — Unassigned", 5000, 9000, "confirmed")),
      listOf(incoming("We will not ship on Fridays — Unassigned", 5000, 9000)),
    )
    assertEquals(1, plan.rows.size)
    assertEquals("id-1", plan.rows[0].id)
    assertEquals("confirmed", plan.rows[0].review)
  }

  /**
   * "will not" and "won't" are one negation spelled two ways, not a change of sign.
   *
   * Lost: the guard's credibility. ASR flips between contracted and expanded forms between runs as
   * a matter of course, so comparing surface tokens would flag a large share of every meeting's
   * negative items on every reprocess — and a queue that flags everything says nothing, which is
   * the argument the guard is built on. A false positive here costs the same thing a missing guard
   * costs: nobody reads the flags.
   */
  @Test fun aContractionIsNotAChangeOfSign() {
    val plan = Reconciler.reconcile(
      listOf(stored("id-1", "We will not ship on Friday — Unassigned", 5000, 9000, "confirmed")),
      listOf(incoming("We won't ship on Friday — Unassigned", 5000, 9000)),
    )
    assertEquals(1, plan.rows.size)
    assertEquals("id-1", plan.rows[0].id)
    assertEquals("confirmed", plan.rows[0].review)
  }

  /** The same for `cannot` against `can't`, the other form the extractor sees both ways. */
  @Test fun cannotAndCantAreTheSameNegation() {
    val plan = Reconciler.reconcile(
      listOf(stored("id-1", "We cannot ship on Friday — Unassigned", 5000, 9000, "confirmed")),
      listOf(incoming("We can't ship on Friday — Unassigned", 5000, 9000)),
    )
    assertEquals("confirmed", plan.rows[0].review)
  }

  /**
   * The guard downgrades and does nothing else: a differing negation on an already-ambiguous pair
   * still produces one matched, flagged row — not a drop, not a duplicate, not a new id.
   *
   * Lost: the state. A guard that rejected the pair instead of downgrading it would turn a
   * carried-forward tick into a new item plus a retained orphan, which is the failure this class
   * exists to prevent, arriving through the code meant to prevent it.
   */
  @Test fun theNegationGuardOnlyDowngrades_itNeverUnmatches() {
    val plan = Reconciler.reconcile(
      listOf(stored("id-1", "Send the quarterly report to finance — Priya", 5000, 9000, "confirmed")),
      listOf(incoming("Do not cancel the quarterly report — Unassigned", 5200, 9100)),
    )
    assertEquals(1, plan.rows.size)
    assertEquals("id-1", plan.rows[0].id)
    assertEquals("needs_review", plan.rows[0].review)
  }

  /**
   * A person confirmed it; an exact re-match must not quietly demote it back to suggested.
   *
   * Lost: the review itself. Demoting on every reprocess would put an item a person already
   * settled back into the queue, which trains people to ignore the queue.
   */
  @Test fun aConfirmedItemStaysConfirmedOnAnExactMatch() {
    val plan = Reconciler.reconcile(
      listOf(stored("id-1", "Send the report — Unassigned", 5000, 9000, "confirmed")),
      listOf(incoming("Send the report — Unassigned", 5000, 9000)),
    )
    assertEquals("confirmed", plan.rows[0].review)
  }

  /**
   * An item that genuinely went away, which a person had confirmed, is kept and flagged.
   *
   * Lost: an entire confirmed commitment, deleted because a re-run of the rules stopped finding
   * the sentence. The old text and its evidence have to survive intact — this row is the only
   * remaining record of it.
   */
  @Test fun aVanishedConfirmedItemIsRetained() {
    val plan = Reconciler.reconcile(
      // touched spelled out rather than left to the default: this test's name says CONFIRMED, and
      // what rule 4 actually reads is touched. Both are true of a confirmed row; only one is what
      // is being pinned here.
      listOf(stored("id-1", "Send the report — Unassigned", 5000, 9000, "confirmed", touched = true)),
      listOf(incoming("Book the venue — Unassigned", 3_600_000, 3_604_000)),
    )
    assertEquals(2, plan.rows.size)
    val kept = plan.rows.first { it.id == "id-1" }
    assertEquals("needs_review", kept.review)
    assertEquals("Send the report — Unassigned", kept.item.text)
    assertEquals(5000L, kept.item.anchorStartMs)
    assertEquals(1, kept.item.sources.size)
    assertEquals(LONG_AGO, kept.createdAt)
  }

  /**
   * An item that went away and nobody had touched is simply gone.
   *
   * Lost: nothing, and that is the point — retaining every stale suggestion forever would fill the
   * list with items the rules no longer believe and no person ever cared about, which is how a
   * review queue becomes noise nobody reads.
   */
  @Test fun aVanishedUntouchedItemIsDropped() {
    val plan = Reconciler.reconcile(
      listOf(stored("id-1", "Send the report — Unassigned", 5000, 9000, "suggested")),
      listOf(incoming("Book the venue — Unassigned", 3_600_000, 3_604_000)),
    )
    assertEquals(1, plan.rows.size)
    assertNotEquals("id-1", plan.rows[0].id)
  }

  /**
   * ...and a flag the RECONCILER set does not make it undroppable.
   *
   * `needs_review` is this class's own output: rule 3 writes it whenever a match is ambiguous, so
   * an item can be flagged by five consecutive reprocesses without a person ever having seen it.
   * Counting that as engagement is a loop — the machine flags a row, the flag makes the row
   * permanent, and the queue a person is supposed to work through fills with items nobody ever
   * touched, which is precisely how a review queue stops being read.
   *
   * `suggested` and `needs_review` are what the machine says; `confirmed` and `rejected` are what a
   * person says. Only the second pair is engagement, and [AudioDb.StoredItem.touched] is where that
   * distinction is drawn.
   */
  @Test fun aVanishedItemTheMachineFlaggedButNobodyTouchedIsAlsoDropped() {
    val plan = Reconciler.reconcile(
      // "NobodyTouched" is half the name, so it is written down rather than inferred from the
      // default: flagged by the machine, and not touched by anyone.
      listOf(
        stored("id-1", "Send the report — Unassigned", 5000, 9000, "needs_review", touched = false),
      ),
      listOf(incoming("Book the venue — Unassigned", 3_600_000, 3_604_000)),
    )
    assertEquals(1, plan.rows.size)
    assertNotEquals("id-1", plan.rows[0].id)
  }

  // ---------------------------------------------------------------------------------------------
  // Beyond the plan's matrix.
  // ---------------------------------------------------------------------------------------------

  /**
   * A tick is not a review: ticking writes item_done (or, before Task 8's migration, action_done)
   * and never touches `review`, so an item can be done and still `suggested`. Dropping it because
   * `review` says "suggested" throws the tick away.
   *
   * Lost: the tick on work a person actually finished. This is the same silent loss as the
   * text-hash defect, arriving by a different road — `review == "suggested"` is not a synonym for
   * "nobody cared about this row".
   *
   * The fixture is `touched = true` because that is all this class is told; which of the four
   * tables the tick came from is AudioDb.items()' problem, and ItemsDbTest is where each of them is
   * pinned against a real database.
   */
  @Test fun aVanishedButTickedItemIsRetainedEvenThoughItWasNeverReviewed() {
    val plan = Reconciler.reconcile(
      listOf(
        stored("id-1", "Send the report — Unassigned", 5000, 9000, "suggested", touched = true),
      ),
      listOf(incoming("Book the venue — Unassigned", 3_600_000, 3_604_000)),
    )
    assertEquals(2, plan.rows.size)
    val kept = plan.rows.first { it.id == "id-1" }
    assertEquals("needs_review", kept.review)
    assertEquals("Send the report — Unassigned", kept.item.text)
  }

  /**
   * A hand-edited item is touched, even though nothing in its own row says so.
   *
   * The fixture is deliberately the invisible state: `review = "suggested"` and the only reason
   * `touched` is true is a row in `edits`. A person rewrote the text by hand; that writes `edits`
   * and touches neither `review` nor `item_done`, so the row's own columns look exactly like one
   * nobody ever cared about.
   *
   * Lost: the person's own words. The third form of the tick bug, in the code written to end that
   * bug class — and the one with no compile error behind it, because `edits` has no foreign key to
   * `items` and no orphan cleanup: the edit row survives on disk keyed to an id that will never be
   * re-minted, so the text is neither shown nor recoverable.
   */
  @Test fun aVanishedButHandEditedItemIsRetainedEvenThoughItWasNeverReviewedOrTicked() {
    val plan = Reconciler.reconcile(
      listOf(
        stored("id-1", "Book the venue — Unassigned", 5000, 9000, "suggested", touched = true),
      ),
      listOf(incoming("Send the report — Unassigned", 3_600_000, 3_604_000)),
    )
    assertEquals(2, plan.rows.size)
    val kept = plan.rows.first { it.id == "id-1" }
    assertEquals("needs_review", kept.review)
    assertEquals("Book the venue — Unassigned", kept.item.text)
  }

  /**
   * A person rejected it and then it stopped being extracted. Both agree it does not belong.
   *
   * Lost: the rejection. Flipping it to needs_review asks the person the question they already
   * answered, every single reprocess; dropping the row means the next recogniser improvement
   * re-suggests it as brand new. Keeping it, rejected, is what makes "no" stick.
   */
  @Test fun aVanishedRejectedItemKeepsItsRejection() {
    val plan = Reconciler.reconcile(
      listOf(stored("id-1", "Send the report — Unassigned", 5000, 9000, "rejected")),
      listOf(incoming("Book the venue — Unassigned", 3_600_000, 3_604_000)),
    )
    assertEquals(2, plan.rows.size)
    assertEquals("rejected", plan.rows.first { it.id == "id-1" }.review)
  }

  /**
   * An item a person typed is never matched, replaced or flagged.
   *
   * Deliberately arranged so it WOULD match if the gen_version guard were missing: same kind, same
   * text, same anchor as the incoming item. A weaker fixture — a user item anchored at 0 against
   * an incoming item at 5000 — passes whether the guard exists or not, and is therefore not a
   * test of anything.
   *
   * Lost: the item itself. Without the guard the hand-written row is consumed by the match, gets
   * the rules' text and the rules' evidence stapled to it, stops being a user item on the next
   * write, and the extracted item it swallowed never gets a row of its own.
   */
  @Test fun aUserWrittenItemIsNeverMatchedReplacedOrFlagged() {
    val user = AudioDb.StoredItem(
      "u-1", "action", "Send the report — Unassigned", "confirmed", "user", 5000, 9000,
      emptyList(), LONG_AGO, true,
    )
    val plan = Reconciler.reconcile(
      listOf(user),
      listOf(incoming("Send the report — Unassigned", 5000, 9000)),
    )
    assertEquals(2, plan.rows.size)
    val kept = plan.rows.first { it.id == "u-1" }
    assertEquals("confirmed", kept.review)
    assertEquals("Send the report — Unassigned", kept.item.text)
    assertTrue("a user item cites nothing and must not be given evidence", kept.item.sources.isEmpty())
    assertEquals("user", kept.genVersion)
    assertEquals(LONG_AGO, kept.createdAt)
    assertNotEquals("u-1", plan.rows.first { it.id != "u-1" }.id)
  }

  /**
   * A match carries the row's original created_at; a genuinely new row carries none.
   *
   * Lost: the date. Stamping `now` on a reconciled row makes an item a person confirmed in March
   * show today's date after any reprocess, and the real value is not recoverable from anywhere.
   * `null` means "there is no history here, stamp it" — the only honest thing a pure function with
   * no clock can say.
   */
  @Test fun aMatchCarriesTheOriginalCreatedAtAndANewItemCarriesNone() {
    val plan = Reconciler.reconcile(
      listOf(stored("id-1", "Send the report — Unassigned", 5000, 9000, "confirmed")),
      listOf(
        incoming("Send the report — Unassigned", 5000, 9000),
        incoming("Book the venue — Unassigned", 3_600_000, 3_604_000),
      ),
    )
    assertEquals(LONG_AGO, plan.rows.first { it.id == "id-1" }.createdAt)
    assertNull(plan.rows.first { it.id != "id-1" }.createdAt)
    // A matched row's content came from this run, so it is stamped with this run's version, not
    // the stored one. Null says "the caller's gen_version"; only preserved content pins its own.
    assertNull(plan.rows.first { it.id == "id-1" }.genVersion)
  }

  /**
   * A decision and an action are never the same item, however alike they read.
   *
   * Lost: the tick jumps type. "We ship on Friday" recorded as a decision and re-extracted as an
   * action would inherit the decision's confirmation, and the decision — confirmed by a person —
   * would vanish into it.
   */
  @Test fun aDifferentKindIsNeverTheSameItem() {
    val plan = Reconciler.reconcile(
      listOf(stored("id-1", "Send the report — Unassigned", 5000, 9000, "confirmed", kind = "decision")),
      listOf(incoming("Send the report — Unassigned", 5000, 9000, kind = "action")),
    )
    assertEquals(2, plan.rows.size)
    assertNotEquals("id-1", plan.rows.first { it.item.kind == "action" }.id)
    assertEquals("needs_review", plan.rows.first { it.id == "id-1" }.review)
  }

  /**
   * The best pair in the meeting wins, whatever order the extractor emitted them in.
   *
   * Matching each incoming item against the best remaining candidate, in arrival order, lets a
   * poor early match steal the row a later, perfect match needed. Here "Send the report" arrives
   * first and overlaps the stored item at 0.44; the identical re-extraction arrives second. Under
   * arrival-order greed the confirmed row is handed to the wrong item and flagged, and the item
   * that is word-for-word the same sentence gets a fresh id — the confirmation lands on one item
   * and the text it belonged to on another.
   *
   * Lost: the confirmation, and worse, it is not merely lost but reattached to a different
   * commitment.
   */
  @Test fun theBestPairWinsWhateverOrderTheItemsArrivedIn() {
    val plan = Reconciler.reconcile(
      listOf(stored("id-1", "Send the quarterly report to finance — Priya", 5000, 9000, "confirmed")),
      listOf(
        incoming("Send the report — Unassigned", 5100, 8000),
        incoming("Send the quarterly report to finance — Priya", 5000, 9000),
      ),
    )
    assertEquals(2, plan.rows.size)
    val exact = plan.rows.first { it.item.text == "Send the quarterly report to finance — Priya" }
    assertEquals("id-1", exact.id)
    assertEquals("confirmed", exact.review)
    assertNotEquals("id-1", plan.rows.first { it.item.text == "Send the report — Unassigned" }.id)
  }

  /**
   * An exact tie is decided by emission order, so it is flagged rather than settled quietly.
   *
   * Two candidate re-extractions of one confirmed action, scoring identically because each
   * replaces the owner with a different name. Something has to win and position picks it, which is
   * reproducible but not order-independent: a different extraction order hands the confirmation to
   * the other item.
   *
   * Lost: the meaning of "confirmed". A tie is the definition of the ambiguity this class says it
   * never resolves by guessing, so the winner keeps the state and says a person should look.
   */
  @Test fun anExactTieIsFlaggedRatherThanSettledByEmissionOrder() {
    val plan = Reconciler.reconcile(
      listOf(stored("id-1", "Send the report to finance — Priya", 5000, 9000, "confirmed")),
      listOf(
        incoming("Send the report to finance — Raj", 5000, 9000),
        incoming("Send the report to finance — Anil", 5000, 9000),
      ),
    )
    assertEquals(2, plan.rows.size)
    assertEquals("needs_review", plan.rows.first { it.id == "id-1" }.review)
  }

  /**
   * Anchors that merely touch do not overlap, and one millisecond of overlap is enough.
   *
   * Both edges of MIN_OVERLAP_MS, which is otherwise the constant with the longest comment and the
   * least evidence in the file — before this, a value of -100000 passed the whole suite.
   *
   * Lost: the boundary the whole "different moment, different item" rule stands on. Loosened, an
   * item's tick migrates to the adjacent item that starts where it ended; tightened, an item whose
   * anchor moved by a millisecond becomes a new row and splits from its own history.
   */
  @Test fun anchorsThatOnlyTouchAreNotTheSameMoment() {
    val plan = Reconciler.reconcile(
      listOf(stored("id-1", "Send the report — Unassigned", 5000, 9000, "confirmed")),
      listOf(incoming("Send the report — Unassigned", 9000, 12000)),
    )
    assertEquals(2, plan.rows.size)
    assertNotEquals("id-1", plan.rows.first { it.item.anchorStartMs == 9000L }.id)
  }

  @Test fun oneMillisecondOfOverlapIsEnough() {
    val plan = Reconciler.reconcile(
      listOf(stored("id-1", "Send the report — Unassigned", 5000, 9000, "confirmed")),
      listOf(incoming("Send the report — Unassigned", 8999, 12000)),
    )
    assertEquals(1, plan.rows.size)
    assertEquals("id-1", plan.rows[0].id)
    assertEquals("confirmed", plan.rows[0].review)
  }

  /**
   * The closest miss in the measured table — 0.556 — must not be confident.
   *
   * Two different commitments to the same person in the same minute. This pair is the stated
   * reason CONFIDENT_SIMILARITY is not lower, and without it the constant is pinned only from
   * above: dropping it to 0.5 keeps every other test green while making this a silent match.
   *
   * Lost: a confirmation transplanted between two of one person's commitments, which is worse than
   * losing it — the tick on "send the deck to legal" now sits on "send the invoice to accounts".
   */
  @Test fun theClosestMissInTheMeasuredTableIsNotConfident() {
    val plan = Reconciler.reconcile(
      listOf(stored("id-1", "Send the deck to legal — Priya", 5000, 9000, "confirmed")),
      listOf(incoming("Send the invoice to accounts — Priya", 5000, 9000)),
    )
    assertEquals(1, plan.rows.size)
    assertEquals("id-1", plan.rows[0].id)
    assertEquals("needs_review", plan.rows[0].review)
  }

  /**
   * One incoming item never consumes two stored rows.
   *
   * Two confirmed rows share a window; the incoming item is word-for-word one of them. It must
   * take that one and leave the other alone.
   *
   * Lost: both rows at once. Without the guard the incoming item is assigned twice and the later,
   * far worse pairing wins — the exact-match text lands on the OTHER item's id with its
   * confirmation demoted, and the row it really continued is left orphaned and flagged. One
   * reprocess, two items wrong, and the text now sits under an id a person associates with
   * something else entirely.
   */
  @Test fun oneIncomingItemNeverConsumesTwoStoredRows() {
    val plan = Reconciler.reconcile(
      listOf(
        stored("id-a", "Send the quarterly report to finance — Priya", 5000, 9000, "confirmed"),
        stored("id-b", "Book the venue — Raj", 5000, 9000, "confirmed"),
      ),
      listOf(incoming("Send the quarterly report to finance — Priya", 5000, 9000)),
    )
    assertEquals(2, plan.rows.size)
    val matched = plan.rows.first { it.id == "id-a" }
    assertEquals("Send the quarterly report to finance — Priya", matched.item.text)
    assertEquals("confirmed", matched.review)
    val untouched = plan.rows.first { it.id == "id-b" }
    assertEquals("Book the venue — Raj", untouched.item.text)
    assertEquals("needs_review", untouched.review)
  }

  /**
   * A preserved source keeps a null utterance id as null.
   *
   * Lost: the difference between "this row never had an utterance id" and "its id is the empty
   * string". `item_sources.utterance_id` is nullable on purpose — ids are re-minted every
   * recognition pass — and writing "" back puts a value that reads like an id into a column whose
   * NULL is the honest answer.
   */
  @Test fun aPreservedSourceKeepsANullUtteranceIdNull() {
    val stored = AudioDb.StoredItem(
      "id-1", "action", "Send the report — Unassigned", "confirmed", "rules@1", 5000, 9000,
      listOf(AudioDb.StoredSource(5000, 9000, 0, 27, null)), LONG_AGO, true,
    )
    val plan = Reconciler.reconcile(
      listOf(stored),
      listOf(incoming("Book the venue — Unassigned", 3_600_000, 3_604_000)),
    )
    assertNull(plan.rows.first { it.id == "id-1" }.item.sources[0].utteranceId)
  }
}
