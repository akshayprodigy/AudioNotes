import unittest

from eval.metrics.normalize import normalize


class TestNormalize(unittest.TestCase):
    def test_lowercases_and_splits(self):
        self.assertEqual(normalize("Hello There"), ["hello", "there"])

    def test_strips_bracketed_non_speech(self):
        # AMI annotates events our transcript never emits; counting them would measure
        # annotation convention rather than transcription quality.
        self.assertEqual(normalize("hello [laugh] there <vocalsound>"), ["hello", "there"])

    def test_drops_punctuation_but_keeps_intra_word_apostrophes(self):
        self.assertEqual(normalize("don't, stop."), ["do", "not", "stop"])

    def test_expands_contractions(self):
        self.assertEqual(normalize("we'll it's I'm"), ["we", "will", "it", "is", "i", "am"])

    def test_removes_disfluencies_from_either_side(self):
        self.assertEqual(normalize("uh so um yeah"), ["so", "yeah"])

    def test_expands_digits_to_words(self):
        # Digits -> words, never the reverse: "twenty five" must match "25" token for token.
        self.assertEqual(normalize("25"), ["twenty", "five"])
        self.assertEqual(normalize("we ship 3 items"), ["we", "ship", "three", "items"])

    def test_leaves_large_numbers_alone(self):
        self.assertEqual(normalize("12345"), ["12345"])

    def test_empty_input(self):
        self.assertEqual(normalize(""), [])
        self.assertEqual(normalize("   "), [])


if __name__ == "__main__":
    unittest.main()
