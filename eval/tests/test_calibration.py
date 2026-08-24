"""The gate on the judge itself.

A model grading a model is the weakest link in this harness. If nobody checks the judge against
a human, every MOM number downstream is decoration. So a sample gets hand-labelled and the
numbers are only reported as numbers when the judge agrees with the human often enough.
"""
import unittest

from eval.metrics.calibration import THRESHOLD, agreement, sample_for_labelling

VERDICTS = (
    [{"kind": "recall", "category": "decisions", "item": f"d{i}", "matched": i % 2 == 0,
      "evidence": ""} for i in range(10)]
    + [{"kind": "recall", "category": "actions", "item": f"a{i}", "matched": i < 2,
        "evidence": ""} for i in range(10)]
    + [{"kind": "support", "category": "questions", "item": f"q{i}", "matched": True,
        "evidence": ""} for i in range(10)]
)


class SampleTest(unittest.TestCase):
    def test_size(self):
        self.assertEqual(len(sample_for_labelling(VERDICTS, n=20)), 20)

    def test_fewer_verdicts_than_asked_for(self):
        self.assertEqual(len(sample_for_labelling(VERDICTS[:5], n=20)), 5)

    def test_deterministic(self):
        a = sample_for_labelling(VERDICTS, n=12, seed=7)
        b = sample_for_labelling(VERDICTS, n=12, seed=7)
        self.assertEqual([x["item"] for x in a], [x["item"] for x in b])

    def test_spans_categories_and_both_outcomes(self):
        """Sampling only the judge's YES verdicts would measure half the instrument. The
        failures are where a judge is most likely to be wrong and least likely to be checked.
        """
        s = sample_for_labelling(VERDICTS, n=12)
        self.assertGreaterEqual(len({x["category"] for x in s}), 3)
        self.assertIn(True, {x["matched"] for x in s})
        self.assertIn(False, {x["matched"] for x in s})


class AgreementTest(unittest.TestCase):
    def test_full_agreement(self):
        s = sample_for_labelling(VERDICTS, n=10)
        r = agreement(s, {x["item"]: x["matched"] for x in s})
        self.assertEqual(r["rate"], 1.0)
        self.assertTrue(r["trustworthy"])

    def test_below_the_threshold_is_not_trustworthy(self):
        s = sample_for_labelling(VERDICTS, n=10)
        labels = {x["item"]: x["matched"] for x in s}
        for item in list(labels)[:3]:            # 7/10 = 70%
            labels[item] = not labels[item]
        r = agreement(s, labels)
        self.assertEqual(r["rate"], 0.7)
        self.assertFalse(r["trustworthy"])
        self.assertLess(r["rate"], THRESHOLD)

    def test_disagreements_are_listed_so_they_can_be_read(self):
        s = sample_for_labelling(VERDICTS, n=10)
        labels = {x["item"]: x["matched"] for x in s}
        first = list(labels)[0]
        labels[first] = not labels[first]
        r = agreement(s, labels)
        self.assertEqual([d["item"] for d in r["disagreements"]], [first])

    def test_an_unlabelled_item_is_an_error_not_a_silent_pass(self):
        s = sample_for_labelling(VERDICTS, n=10)
        labels = {x["item"]: x["matched"] for x in s}
        labels.pop(list(labels)[0])
        with self.assertRaises(ValueError) as e:
            agreement(s, labels)
        self.assertIn("unlabelled", str(e.exception))


if __name__ == "__main__":
    unittest.main()
