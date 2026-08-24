"""The correction round-trip: what the pipeline heard -> what a human fixes -> the reference.

The reference transcript is the yardstick every other number is measured against, so a parser
that quietly drops a line is worse than one that crashes: the dropped words would score as
insertions forever after and nobody would know. Hence the loud-failure tests below.
"""
import unittest

from eval.corpus.truth_draft import parse_timestamp, format_timestamp, render_draft, parse_draft


class TimestampTest(unittest.TestCase):
    def test_forms(self):
        self.assertEqual(parse_timestamp("00:00:03.120"), 3120)
        self.assertEqual(parse_timestamp("01:02:03.004"), 3723004)
        self.assertEqual(parse_timestamp("1:02.5"), 62500)
        self.assertEqual(parse_timestamp("12.3"), 12300)
        self.assertEqual(parse_timestamp("0"), 0)

    def test_format_is_parseable(self):
        for ms in (0, 999, 3120, 3723004, 509364):
            self.assertEqual(parse_timestamp(format_timestamp(ms)), ms)


DOC = {
    "audio_ms": 60000,
    "transcript": [
        {"start_ms": 1000, "end_ms": 3000, "speaker": 7, "text": "hello everyone"},
        {"start_ms": 30000, "end_ms": 33500, "speaker": 12, "text": "shall we start"},
    ],
}


def as_corrected(doc, fixture_id="demo"):
    """A rendered draft with the UNCORRECTED marker removed — what a human hands back."""
    return "\n".join(l for l in render_draft(doc, fixture_id).splitlines()
                     if "UNCORRECTED" not in l)


class RoundTripTest(unittest.TestCase):
    def test_untouched_draft_round_trips(self):
        parsed = parse_draft(as_corrected(DOC))
        self.assertEqual(parsed["audio_ms"], 60000)
        self.assertEqual(parsed["segments"], [
            {"start_ms": 1000, "end_ms": 3000, "speaker": "S7", "text": "hello everyone"},
            {"start_ms": 30000, "end_ms": 33500, "speaker": "S12", "text": "shall we start"},
        ])

    def test_gap_marker_is_a_comment_and_survives_import(self):
        # A 27 s hole between the two utterances: the draft must point at it, because speech we
        # never transcribed is invisible otherwise — and deletions are our largest error bucket.
        self.assertIn("no detected speech", render_draft(DOC, "demo"))
        self.assertEqual(len(parse_draft(as_corrected(DOC))["segments"]), 2)

    def test_human_edits_are_carried_verbatim(self):
        draft = """# audio_ms: 60000
[00:00:01.000 -> 00:00:03.000] Akshay: hello everyone, thanks for joining

# a note the human left for themselves
[00:00:30.000 -> 00:00:33.500] Priya M.: shall we start?
"""
        segs = parse_draft(draft)["segments"]
        self.assertEqual([s["speaker"] for s in segs], ["Akshay", "Priya M."])
        self.assertEqual(segs[0]["text"], "hello everyone, thanks for joining")

    def test_colon_in_the_text_survives(self):
        segs = parse_draft("# audio_ms: 10\n[0 -> 1] S1: the decision: ship on Friday\n")["segments"]
        self.assertEqual(segs[0]["text"], "the decision: ship on Friday")

    def test_blank_text_is_dropped_but_counted(self):
        # Blanking a line is how you say "that was noise, not speech".
        out = parse_draft("# audio_ms: 10\n[0 -> 1] S1:\n[1 -> 2] S1: real words\n")
        self.assertEqual(len(out["segments"]), 1)
        self.assertEqual(out["dropped"], 1)

    def test_malformed_line_fails_loudly_with_its_number(self):
        bad = "# audio_ms: 10\n[0 -> 1] S1: fine\n[0 - 1 S1 broken line\n"
        with self.assertRaises(ValueError) as e:
            parse_draft(bad)
        self.assertIn("line 3", str(e.exception))

    def test_end_before_start_is_rejected(self):
        with self.assertRaises(ValueError):
            parse_draft("# audio_ms: 10\n[00:00:05.000 -> 00:00:02.000] S1: backwards\n")

    def test_added_line_out_of_order_is_accepted_and_sorted(self):
        # The human adds missed speech at the bottom of the file rather than hunting for the spot.
        draft = "# audio_ms: 10\n[5 -> 6] S1: second\n[1 -> 2] S1: first\n"
        segs = parse_draft(draft)["segments"]
        self.assertEqual([s["text"] for s in segs], ["first", "second"])

    def test_overlapping_speech_is_kept(self):
        # Two people talking at once is real; DER excludes overlap but the reference must hold it.
        draft = "# audio_ms: 10\n[1 -> 4] A: one\n[3 -> 6] B: two\n"
        self.assertEqual(len(parse_draft(draft)["segments"]), 2)

    def test_importing_an_uncorrected_draft_is_refused(self):
        """The worst outcome this workflow can produce is a reference that IS the hypothesis.

        It would score near-0% WER and read as a perfect product. So the draft carries a marker
        the corrector has to delete, and import refuses while it is there.
        """
        draft = render_draft(DOC, "demo")
        self.assertIn("UNCORRECTED", draft)
        with self.assertRaises(ValueError) as e:
            parse_draft(draft)
        self.assertIn("UNCORRECTED", str(e.exception))

    def test_removing_the_marker_allows_import(self):
        self.assertEqual(len(parse_draft(as_corrected(DOC))["segments"]), 2)

    def test_audio_ms_missing_falls_back_to_the_last_end(self):
        # A bare number is SECONDS, not milliseconds — 2.5 here, and 2500 would be 41 minutes.
        self.assertEqual(parse_draft("[1 -> 2.5] S1: x\n")["audio_ms"], 2500)


if __name__ == "__main__":
    unittest.main()
