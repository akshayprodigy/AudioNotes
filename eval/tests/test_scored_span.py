"""Scoring restricted to the span a human actually corrected.

The failure this prevents is subtle and would look like a catastrophic regression: score a
three-minute reference against a nine-minute transcript and the six uncorrected minutes arrive
as pure insertions. WER would read several hundred percent and nobody would know why.
"""
import json
import os
import tempfile
import unittest

from eval.run import score

DOC = {
    "audio_ms": 600000,
    "timings": {"asr_ms": 1000},
    "transcript": [
        {"start_ms": 1000, "end_ms": 5000, "speaker": 0, "text": "inside the window"},
        {"start_ms": 400000, "end_ms": 404000, "speaker": 0, "text": "far outside the window"},
    ],
}
TRUTH = {
    "audio_ms": 600000,
    "scored_from_ms": 0,
    "scored_to_ms": 180000,
    "segments": [{"start_ms": 1000, "end_ms": 5000, "speaker": "A", "text": "inside the window"}],
}


class ScoredSpanTest(unittest.TestCase):
    def fixture(self, truth):
        d = tempfile.mkdtemp()
        with open(os.path.join(d, "truth.json"), "w") as f:
            json.dump(truth, f)
        with open(os.path.join(d, "meta.json"), "w") as f:
            json.dump({"source": "local", "notes": ""}, f)
        return d

    def test_hypothesis_outside_the_span_is_not_scored(self):
        r = score(self.fixture(TRUTH), DOC)
        # Only the in-window utterance is compared, and it matches: no errors at all.
        self.assertEqual(r["wer"]["wer"], 0.0)
        self.assertEqual(r["wer"]["insertions"], 0)

    def test_without_a_span_the_stray_utterance_counts(self):
        whole = {k: v for k, v in TRUTH.items() if not k.startswith("scored_")}
        r = score(self.fixture(whole), DOC)
        self.assertEqual(r["wer"]["insertions"], 4)  # "far outside the window" + "far"

    def test_the_span_is_reported_so_a_number_is_never_read_as_whole_meeting(self):
        r = score(self.fixture(TRUTH), DOC)
        self.assertEqual(r["scored_span_ms"], [0, 180000])
        self.assertIsNone(score(self.fixture(
            {k: v for k, v in TRUTH.items() if not k.startswith("scored_")}), DOC)["scored_span_ms"])


if __name__ == "__main__":
    unittest.main()
