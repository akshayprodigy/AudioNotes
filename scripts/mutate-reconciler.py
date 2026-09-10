#!/usr/bin/env python3
"""Break Reconciler on purpose, one rule at a time, and fail if ReconcilerTest does not notice.

Reconciler decides whether a person's work survives a reprocess: which tick, hand edit, confirmed
owner and review status carries across when items are regenerated from scratch. Every failure it
can have is SILENT — nobody notices the item they ticked last week is unticked — so its tests are
the only alarm, and a test that reads as coverage while being incapable of failing is worse than
no test at all. Five such assertions have already been found in this sub-project by inspection.
This finds them by measurement instead.

Each entry below deletes one rule from Reconciler.kt, runs ReconcilerTest, and expects at least
one named test to fail. A SURVIVED line is a hole in the matrix: behaviour nothing pins.

It also fails on PATCH DID NOT APPLY, which matters more than it looks. These patches match source
text, so an edit to the line a mutation targets turns that mutation into a silent no-op that
reports nothing and proves nothing. That happened once already, to the ambiguous-match mutation,
and was caught only because this script says so out loud rather than skipping quietly. If you
change Reconciler.kt and a patch stops applying, re-point the patch — do not delete it.

Costs about a minute (one Gradle test run per mutation). Not part of any build; run it when you
change Reconciler.kt or its tests.

    python3 scripts/mutate-reconciler.py            # all of them
    python3 scripts/mutate-reconciler.py negation   # only entries whose name matches a substring
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ANDROID = os.path.join(ROOT, "android")
SRC = os.path.join(
    ANDROID, "app", "src", "main", "java", "com", "innocorelabs", "verbale",
    "pipeline", "Reconciler.kt",
)
RESULTS = os.path.join(
    ANDROID, "app", "build", "test-results", "testDebugUnitTest",
    "TEST-com.innocorelabs.verbale.ReconcilerTest.xml",
)

# (name, find, replace). `find` must appear EXACTLY once in Reconciler.kt.
MUTATIONS = [
    ("confident match returns a fresh uuid",
     "      rows.add(Row(old.id, incoming[i], review, old.createdAt, null))",
     "      rows.add(Row(UUID.randomUUID().toString(), incoming[i], review, old.createdAt, null))"),
    ("matched row keeps the stored text instead of the new one",
     "      rows.add(Row(old.id, incoming[i], review, old.createdAt, null))",
     "      rows.add(Row(old.id, Minutes.Item(old.kind, old.text, incoming[i].sources,"
     " old.anchorStartMs, old.anchorEndMs), review, old.createdAt, null))"),
    ("created_at is not carried through a match",
     "      rows.add(Row(old.id, incoming[i], review, old.createdAt, null))",
     "      rows.add(Row(old.id, incoming[i], review, null, null))"),
    ("ambiguous match leaves review untouched",
     "      val review = if (confident) old.review else Review.NEEDS_REVIEW",
     "      val review = old.review"),
    ("preserved rows are relabelled with the run's gen_version",
     "      rows.add(Row(old.id, preserved, review, old.createdAt, old.genVersion))",
     "      rows.add(Row(old.id, preserved, review, old.createdAt, null))"),
    ("vanished-but-confirmed is dropped",
     "        else -> Review.NEEDS_REVIEW\n      }",
     "        else -> continue\n      }"),
    ("vanished-and-untouched is retained",
     "        !old.touched -> continue",
     "        !old.touched -> Review.NEEDS_REVIEW"),
    # The three engagement signals used to be ORed together on this line, and there was one
    # mutation per signal. They now arrive as the single `touched` field that AudioDb.items()
    # computes, so from here the only thing that can go wrong is asking the wrong question — this
    # mutation asks the one the code asked before, and the ticked and hand-edited cases must both
    # notice. Whether items() FINDS each signal is a database question and lives in ItemsDbTest.
    ("the touched predicate is reduced to the review column",
     "        !old.touched -> continue",
     "        old.review == Review.SUGGESTED -> continue"),
    # ...and the mirror image: `needs_review` is this file's own output, so treating it as
    # engagement lets our own guess keep a row nobody ever touched alive forever.
    ("the machine's own needs_review flag counts as engagement",
     "        !old.touched -> continue",
     "        old.review == Review.SUGGESTED && !old.touched -> continue"),
    ("a rejected vanished item is re-flagged for review",
     "        old.review == Review.REJECTED -> Review.REJECTED",
     "        old.review == Review.REJECTED -> Review.NEEDS_REVIEW"),
    ("a preserved source writes \"\" instead of a null utterance id",
     "          Minutes.Source(it.utteranceId, it.startMs, it.endMs, it.charStart, it.charEnd)",
     "          Minutes.Source(it.utteranceId ?: \"\", it.startMs, it.endMs, it.charStart,"
     " it.charEnd)"),
    ("user items may be matched",
     "    val candidates = existing.filter { it.genVersion != USER_GEN }",
     "    val candidates = existing"),
    ("kind is ignored",
     "        if (old.kind != item.kind) continue",
     "        if (false) continue"),
    ("anchor overlap is ignored",
     "        if (overlap < MIN_OVERLAP_MS) continue",
     "        if (overlap < Long.MIN_VALUE) continue"),
    ("touching anchors count as overlapping",
     "  private const val MIN_OVERLAP_MS = 1L",
     "  private const val MIN_OVERLAP_MS = 0L"),
    ("one millisecond of overlap is not enough",
     "  private const val MIN_OVERLAP_MS = 1L",
     "  private const val MIN_OVERLAP_MS = 2L"),
    ("similarity always 1.0",
     "  private fun similarity(a: String, b: String): Double {\n    if (a == b) return 1.0",
     "  private fun similarity(a: String, b: String): Double {\n    if (true) return 1.0\n"
     "    if (a == b) return 1.0"),
    ("similarity always 0.0",
     "  private fun similarity(a: String, b: String): Double {\n    if (a == b) return 1.0",
     "  private fun similarity(a: String, b: String): Double {\n    if (true) return 0.0\n"
     "    if (a == b) return 1.0"),
    ("zero shared words still counts as a candidate",
     "        if (score <= 0.0) continue",
     "        if (score < 0.0) continue"),
    ("the confidence threshold drops to 0.5",
     "  private const val CONFIDENT_SIMILARITY = 0.6",
     "  private const val CONFIDENT_SIMILARITY = 0.5"),
    ("the confidence threshold rises to 0.7",
     "  private const val CONFIDENT_SIMILARITY = 0.6",
     "  private const val CONFIDENT_SIMILARITY = 0.7"),
    ("arrival-order greed instead of best-first",
     "      compareByDescending<Pairing> { it.score }.thenBy { it.incomingIndex }"
     ".thenBy { it.storedIndex },",
     "      compareBy<Pairing> { it.incomingIndex }.thenByDescending { it.score }"
     ".thenBy { it.storedIndex },"),
    ("one incoming item may consume two stored rows",
     "      if (matched[p.incomingIndex] != null || storedTaken[p.storedIndex]) continue",
     "      if (storedTaken[p.storedIndex]) continue"),
    ("an exact tie is never flagged",
     "      tied[p.incomingIndex] = pairings.any { q ->",
     "      tied[p.incomingIndex] = false && pairings.any { q ->"),
    ("every match is treated as a tie",
     "      tied[p.incomingIndex] = pairings.any { q ->",
     "      tied[p.incomingIndex] = true || pairings.any { q ->"),
    ("the negation guard never fires",
     "        !negationChanged(old.text, incoming[i].text) &&",
     "        true &&"),
    ("the negation guard always fires",
     "  private fun negationChanged(a: String, b: String): Boolean =\n"
     "    negations(normalise(a)) != negations(normalise(b))",
     "  private fun negationChanged(a: String, b: String): Boolean =\n"
     "    true || negations(normalise(a)) != negations(normalise(b))"),
    ("the negation guard fires on presence rather than change",
     "  private fun negationChanged(a: String, b: String): Boolean =\n"
     "    negations(normalise(a)) != negations(normalise(b))",
     "  private fun negationChanged(a: String, b: String): Boolean =\n"
     "    negations(normalise(a)).isNotEmpty() || negations(normalise(b)).isNotEmpty()"),
    ("the explicit negation word list is emptied",
     "  private val NEGATIONS = setOf(NOT, \"never\", \"no\")",
     "  private val NEGATIONS = setOf<String>()"),
    ("the n't contraction rule is dropped",
     "    token == \"cannot\" || token.endsWith(\"n't\") -> NOT",
     "    token == \"cannot\" -> NOT"),
    ("contractions are compared as spellings rather than canonicalised",
     "    token == \"cannot\" || token.endsWith(\"n't\") -> NOT",
     "    token == \"cannot\" || token.endsWith(\"n't\") -> token"),
]


def failed_tests():
    """Names of the ReconcilerTest cases that failed in the last run."""
    with open(RESULTS, encoding="utf-8") as f:
        xml = f.read()
    return sorted(re.findall(r'<testcase name="([^"]+)"[^>]*>\s*<failure', xml))


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    with open(SRC, encoding="utf-8") as f:
        original = f.read()

    rows, holes = [], 0
    for name, find, replace in MUTATIONS:
        if only and only not in name:
            continue
        n = original.count(find)
        if n != 1:
            rows.append((name, f"PATCH DID NOT APPLY ({n} matches) — re-point it"))
            holes += 1
            continue
        try:
            with open(SRC, "w", encoding="utf-8") as f:
                f.write(original.replace(find, replace, 1))
            subprocess.run(
                ["./gradlew", ":app:testDebugUnitTest", "--tests", "*ReconcilerTest*"],
                cwd=ANDROID, capture_output=True, text=True,
            )
            caught = failed_tests()
        finally:
            with open(SRC, "w", encoding="utf-8") as f:
                f.write(original)
        if caught:
            rows.append((name, f"caught by {len(caught)}: " + ", ".join(caught)))
        else:
            rows.append((name, "SURVIVED — nothing pins this behaviour"))
            holes += 1

    width = max(len(n) for n, _ in rows)
    for name, result in rows:
        print(f"{name.ljust(width)}  {result}")
    if holes:
        print(
            f"\n{holes} of {len(rows)} mutations were not caught. Every rule in Reconciler decides\n"
            "whether somebody's tick, edit or confirmation survives a reprocess, and every way it\n"
            "can be wrong is invisible to the person it happens to. A rule nothing pins is a rule\n"
            "the next edit can delete in silence.",
            file=sys.stderr,
        )
        return 1
    print(f"\nall {len(rows)} mutations caught")
    return 0


if __name__ == "__main__":
    sys.exit(main())
