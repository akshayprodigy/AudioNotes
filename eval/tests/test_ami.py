import os
import unittest

from eval.corpus.ami import parse_segments, parse_abstractive

DATA = os.path.join(os.path.dirname(__file__), "data")


class TestAmiAdapter(unittest.TestCase):
    def test_segments_carry_speaker_text_and_ms_timings(self):
        segs = parse_segments(DATA, "ES9999a", "A")
        self.assertEqual(len(segs), 4)
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

    def test_segment_range_ending_on_punctuation_is_not_dropped(self):
        # Segment hrefs routinely reference punctuation word ids. Indexing only non-punctuation
        # words makes those lookups fail and the whole segment vanish -- on the real ES2002a this
        # silently discarded 256 of 277 segments, taking most of the reference transcript with
        # them and leaving a WER computed against 363 words instead of ~3100.
        segs = parse_segments(DATA, "ES9999a", "A")
        punc_seg = next(s for s in segs if s["start_ms"] == 12000)
        self.assertEqual(punc_seg["text"], "Hi")  # comma excluded from text, not from indexing

    def test_segment_range_ending_on_a_vocalsound_is_not_dropped(self):
        # <vocalsound>, <gap> and <disfmarker> share the same "words" id sequence as <w> and are
        # used as range endpoints. Indexing only <w> loses those segments too -- another 81 of
        # ES2002a's 277 on top of the punctuation case.
        segs = parse_segments(DATA, "ES9999a", "A")
        vs_seg = next(s for s in segs if s["start_ms"] == 14000)
        self.assertEqual(vs_seg["text"], "Right")  # the vocalsound contributes no words

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
