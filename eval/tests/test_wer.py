import unittest

from eval.metrics.wer import wer


class TestWer(unittest.TestCase):
    def test_perfect_match(self):
        r = wer("the cat sat", "the cat sat")
        self.assertEqual(r.errors, 0)
        self.assertEqual(r.wer, 0.0)
        self.assertEqual(r.ref_words, 3)

    def test_single_substitution(self):
        r = wer("the cat sat", "the dog sat")
        self.assertEqual((r.substitutions, r.deletions, r.insertions), (1, 0, 0))
        self.assertAlmostEqual(r.wer, 1 / 3)

    def test_single_deletion(self):
        r = wer("the cat sat", "the sat")
        self.assertEqual((r.substitutions, r.deletions, r.insertions), (0, 1, 0))

    def test_single_insertion(self):
        r = wer("the cat sat", "the cat sat down")
        self.assertEqual((r.substitutions, r.deletions, r.insertions), (0, 0, 1))

    def test_empty_hypothesis_is_all_deletions(self):
        r = wer("the cat sat", "")
        self.assertEqual(r.deletions, 3)
        self.assertEqual(r.wer, 1.0)

    def test_empty_reference_reports_zero_rate_not_a_crash(self):
        # A silent reference cannot have a rate; guard the divide rather than blowing up mid-run.
        r = wer("", "hello")
        self.assertEqual(r.ref_words, 0)
        self.assertEqual(r.insertions, 1)
        self.assertEqual(r.wer, 0.0)

    def test_normalisation_is_applied(self):
        # Differs only by punctuation, casing, a disfluency and digit form.
        r = wer("We ship 25 units.", "uh we ship twenty five units")
        self.assertEqual(r.errors, 0)

    def test_wer_can_exceed_one(self):
        r = wer("hello", "hello hello hello")
        self.assertGreater(r.wer, 1.0)


if __name__ == "__main__":
    unittest.main()
