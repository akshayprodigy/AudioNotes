import os
import unittest

from eval.corpus.ami import parse_segments, parse_abstractive

DATA = os.path.join(os.path.dirname(__file__), "data")


class TestAmiAdapter(unittest.TestCase):
    def test_segments_carry_speaker_text_and_ms_timings(self):
        segs = parse_segments(DATA, "ES9999a", "A")
        self.assertEqual(len(segs), 2)
        first = segs[0]
        # Seconds -> ms, and the punctuation token is dropped rather than becoming a word.
        self.assertEqual(first["start_ms"], 1000)
        self.assertEqual(first["end_ms"], 2200)
        self.assertEqual(first["speaker"], "A")
        self.assertEqual(first["text"], "Hi I'm David")

    def test_single_word_segment_href_without_a_range(self):
        # Some segments reference one word: "#id(x)" with no "..id(y)". Mishandling this silently
        # drops real speech from the reference, which would flatter WER.
        segs = parse_segments(DATA, "ES9999a", "A")
        self.assertEqual(segs[1]["text"], "Right")

    def test_abstractive_maps_onto_our_minutes_shape(self):
        mins = parse_abstractive(DATA, "ES9999a")
        self.assertEqual(mins["decisions"], ["The remote will sell for 25 Euro."])
        self.assertEqual(mins["questions"], ["Whether the budget covers a prototype."])
        self.assertEqual(mins["actions"], [
            {"text": "The industrial designer will work on the design.", "owner": "", "due": ""}
        ])

    def test_abstract_section_is_not_treated_as_a_decision(self):
        mins = parse_abstractive(DATA, "ES9999a")
        self.assertNotIn("The team met.", mins["decisions"])


if __name__ == "__main__":
    unittest.main()
