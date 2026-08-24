import unittest

from eval.metrics.attribution import utterance_attribution


def ref(*t):
    return [{"start_ms": a, "end_ms": b, "speaker": s} for a, b, s in t]


def utts(*t):
    return [{"start_ms": a, "end_ms": b, "speaker": s, "text": "x"} for a, b, s in t]


class TestAttribution(unittest.TestCase):
    def test_all_correct_after_mapping(self):
        r = utterance_attribution(ref((0, 10000, "A"), (20000, 30000, "B")),
                                  utts((0, 10000, 5), (20000, 30000, 9)),
                                  mapping={5: "A", 9: "B"})
        self.assertEqual(r["correct"], 2)
        self.assertEqual(r["scored"], 2)
        self.assertEqual(r["accuracy"], 1.0)

    def test_wrong_speaker_is_counted(self):
        r = utterance_attribution(ref((0, 10000, "A"), (20000, 30000, "B")),
                                  utts((0, 10000, 5), (20000, 30000, 5)),
                                  mapping={5: "A"})
        self.assertEqual(r["correct"], 1)
        self.assertEqual(r["scored"], 2)

    def test_dominant_reference_speaker_wins_a_straddling_utterance(self):
        # An utterance spanning a turn change belongs to whoever holds most of it.
        r = utterance_attribution(ref((0, 9000, "A"), (9000, 10000, "B")),
                                  utts((0, 10000, 5)), mapping={5: "A"})
        self.assertEqual(r["correct"], 1)

    def test_unassigned_utterances_are_excluded_not_counted_wrong(self):
        # speaker -1 means diarization was skipped or produced nothing; that is a coverage
        # question, not an attribution error, so it must not silently depress accuracy.
        r = utterance_attribution(ref((0, 10000, "A")), utts((0, 10000, -1)), mapping={})
        self.assertEqual(r["scored"], 0)
        self.assertIsNone(r["accuracy"])

    def test_utterance_over_reference_silence_is_excluded(self):
        r = utterance_attribution(ref((0, 1000, "A")), utts((50000, 60000, 5)), mapping={5: "A"})
        self.assertEqual(r["scored"], 0)


if __name__ == "__main__":
    unittest.main()
