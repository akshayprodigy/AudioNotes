"""The pure parts of eval/measure_search_floor.py: the chunker must match SearchChunker.kt, the
quantised dot product must match VecCodec, and every hand label must name a real passage. The
embedding itself is measured by running the script, not here."""
import unittest

from eval import measure_search_floor as m


def seg(start, end, text):
    return {"start_ms": start, "end_ms": end, "text": text}


class TestChunker(unittest.TestCase):
    def test_merges_turns_up_to_100_words(self):
        words = "w " * 60
        out = m.chunks([seg(0, 1000, words), seg(1000, 2000, words), seg(2000, 3000, "tail")])
        self.assertEqual(len(out), 2)  # 60 + 60 > 100 starts a second window
        self.assertTrue(out[1].startswith("w") and out[1].endswith("tail"))

    def test_a_silence_over_30_seconds_splits(self):
        self.assertEqual(len(m.chunks([seg(0, 1000, "a"), seg(31_001, 32_000, "b")])), 2)
        self.assertEqual(len(m.chunks([seg(0, 1000, "a"), seg(31_000, 32_000, "b")])), 1)  # exactly 30 s is not a gap

    def test_turns_are_taken_in_time_order_and_blanks_skipped(self):
        self.assertEqual(m.chunks([seg(5000, 6000, "second"), seg(0, 1000, "first"), seg(2000, 3000, "  ")]), ["first second"])


class TestVectors(unittest.TestCase):
    def test_quantise_round_trip_is_close(self):
        v = [0.5, -0.25, 0.1, 0.0]
        q, scale = m.quantise(v)
        self.assertEqual(max(abs(x) for x in q), 127)
        self.assertAlmostEqual(m.dot(v, (q, scale)), sum(x * x for x in v), places=2)

    def test_percentiles(self):
        self.assertEqual(m.pct([1, 2, 3, 4, 5], 0.5), 3)
        self.assertEqual(m.pct([1, 2, 3, 4], 0.25), 1.75)


class TestKeywordApproximation(unittest.TestCase):
    PS = [("x#0", "turn", "we discussed the price today"), ("x#1", "turn", "pricing is next")]

    def test_every_token_must_match_and_the_last_is_a_prefix(self):
        self.assertEqual(m.keyword_hits("pric", self.PS), {"x#0", "x#1"})
        self.assertEqual(m.keyword_hits("pricing", self.PS), {"x#1"})  # no stemming: "pricing" does not find "price"
        self.assertEqual(m.keyword_hits("price today", self.PS), {"x#0"})
        self.assertEqual(m.keyword_hits("price tomorrow", self.PS), set())


class TestLabels(unittest.TestCase):
    def test_every_label_names_a_real_passage(self):
        ids = {p[0] for p in m.passages()}
        for name, _, rel in m.QUERIES:
            self.assertLessEqual(rel, ids, name)

    def test_the_no_answer_set_is_big_enough(self):
        self.assertGreaterEqual(sum(1 for q in m.QUERIES if not q[2]), 10)
        self.assertGreaterEqual(len(m.QUERIES), 30)


if __name__ == "__main__":
    unittest.main()
