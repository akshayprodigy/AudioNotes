import unittest

from eval.metrics.der import der


def ref(*triples):
    return [{"start_ms": a, "end_ms": b, "speaker": s} for a, b, s in triples]


def hyp(*triples):
    return [{"start_ms": a, "end_ms": b, "speaker": s} for a, b, s in triples]


class TestDer(unittest.TestCase):
    # A 250 ms collar is excluded around every reference boundary, so all timings here are kept
    # well clear of boundaries to keep the arithmetic readable.
    def test_perfect_match_scores_zero(self):
        r = der(ref((0, 10000, "A"), (20000, 30000, "B")),
                hyp((0, 10000, 0), (20000, 30000, 1)))
        self.assertEqual(r.confusion_ms, 0)
        self.assertEqual(r.missed_ms, 0)
        self.assertEqual(r.false_alarm_ms, 0)
        self.assertEqual(r.der, 0.0)

    def test_swapped_labels_still_score_zero(self):
        # Cluster ids are arbitrary. Without optimal mapping this reads as 100% confusion, which
        # is the single easiest way to ship a diarization metric that is silently inverted.
        r = der(ref((0, 10000, "A"), (20000, 30000, "B")),
                hyp((0, 10000, 1), (20000, 30000, 0)))
        self.assertEqual(r.confusion_ms, 0)
        self.assertEqual(r.der, 0.0)

    def test_missed_speech_counts_as_missed(self):
        r = der(ref((0, 10000, "A")), hyp())
        self.assertEqual(r.false_alarm_ms, 0)
        self.assertGreater(r.missed_ms, 0)
        self.assertAlmostEqual(r.der, 1.0)

    def test_false_alarm_counts_when_reference_is_silent(self):
        r = der(ref((0, 10000, "A")), hyp((0, 10000, 0), (20000, 30000, 0)))
        self.assertGreater(r.false_alarm_ms, 0)
        self.assertEqual(r.missed_ms, 0)

    def test_confusion_when_a_speaker_is_mislabelled(self):
        # Three reference speakers, two hypothesis clusters: one speaker must be confused.
        r = der(ref((0, 10000, "A"), (20000, 30000, "B"), (40000, 50000, "C")),
                hyp((0, 10000, 0), (20000, 30000, 1), (40000, 50000, 0)))
        self.assertGreater(r.confusion_ms, 0)

    def test_overlapping_reference_speech_is_excluded_and_reported(self):
        # Our pipeline assigns exactly one speaker per utterance and cannot score overlap;
        # hiding that would flatter the number, so it is excluded AND surfaced.
        r = der(ref((0, 10000, "A"), (5000, 10000, "B")), hyp((0, 10000, 0)))
        self.assertGreater(r.overlap_ms, 0)

    def test_empty_reference_reports_zero_rate_not_a_crash(self):
        r = der(ref(), hyp((0, 1000, 0)))
        self.assertEqual(r.der, 0.0)

    def test_mapping_is_reported_for_auditing(self):
        r = der(ref((0, 10000, "A"), (20000, 30000, "B")),
                hyp((0, 10000, 7), (20000, 30000, 3)))
        self.assertEqual(r.mapping, {7: "A", 3: "B"})


if __name__ == "__main__":
    unittest.main()
