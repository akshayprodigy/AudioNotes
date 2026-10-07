"""Merging per-meeting scores into one cohort report, under the same count-first refusal."""
import contextlib
import io
import json
import os
import tempfile
import unittest

from eval import aggregate_facts as agg
from eval import score_facts as sf
from eval.tests.test_score_facts import facts_doc, matches_list, produced_list


def meeting(mid, device, min_instances=1):
    return sf.score(facts_doc(), produced_list(), matches_list(), mid,
                    {"device": device, "capture_path": "in-app", "tier": "free",
                     "meeting_type": "planning", "field_density": "dense"},
                    min_instances)["doc"]


class MergeTest(unittest.TestCase):
    def test_counts_add_across_meetings(self):
        merged = agg.merge([meeting("m1", "A07"), meeting("m2", "Pixel")], 1)
        self.assertEqual(merged["summary"]["classes"]["price"]["counts"]["ref"], 6)
        self.assertEqual(merged["summary"]["classes"]["commitment"]["counts"]["wrong_value"], 4)
        self.assertEqual(merged["summary"]["s1"]["silent"], 4)
        self.assertEqual(merged["summary"]["meetings"], 2)

    def test_the_gate_is_applied_to_the_pooled_count_not_each_meeting(self):
        docs = [meeting("m1", "A07"), meeting("m2", "Pixel")]      # 3 prices each, 6 pooled
        self.assertIn("price accuracy: 33.3%", agg.render(docs, 6))
        self.assertIn("price accuracy: rate not printed", agg.render(docs, 7))
        self.assertIn("6 reference instances, fewer than the 7 required", agg.render(docs, 7))

    def test_min_instances_comes_from_the_aggregate_call_not_the_inputs(self):
        docs = [meeting("m1", "A07", min_instances=1), meeting("m2", "Pixel", min_instances=1)]
        self.assertIn("rate not printed", agg.render(docs, 30))

    def test_cohorts_split_by_device(self):
        text = agg.render([meeting("m1", "A07"), meeting("m2", "Pixel")], 1)
        self.assertIn("### device = A07 (1 meeting(s))", text)
        self.assertIn("### device = Pixel (1 meeting(s))", text)

    def test_duplicate_meeting_ids_are_refused(self):
        with self.assertRaises(ValueError) as ctx:
            agg.merge([meeting("m1", "A07"), meeting("m1", "Pixel")], 1)
        self.assertIn("'m1' appears twice", str(ctx.exception))

    def test_a_document_without_rows_is_refused(self):
        with self.assertRaises(ValueError) as ctx:
            agg.merge([{"meeting_id": "x"}], 1)
        self.assertIn("not a facts_score.json", str(ctx.exception))

    def test_silent_s1_line_is_pooled(self):
        self.assertIn("Silent S1: 4", agg.render([meeting("m1", "A07"), meeting("m2", "P")], 1))


class CommandTest(unittest.TestCase):
    def test_command_writes_json_and_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = []
            for mid in ("m1", "m2"):
                p = os.path.join(tmp, f"{mid}.json")
                with open(p, "w") as f:
                    json.dump(meeting(mid, "A07"), f)
                paths.append(p)
            out = os.path.join(tmp, "agg")
            with contextlib.redirect_stdout(io.StringIO()):
                agg.main(paths + ["--out", out, "--min-instances", "6"])
            with open(os.path.join(out, "facts_aggregate.json")) as f:
                self.assertEqual(json.load(f)["summary"]["meetings"], 2)
            with open(os.path.join(out, "facts_aggregate_report.md")) as f:
                self.assertIn("price accuracy: 33.3%", f.read())

    def test_unreadable_input_is_a_clear_exit(self):
        with self.assertRaises(SystemExit) as ctx:
            agg.main(["/nonexistent/facts_score.json"])
        self.assertIn("cannot read", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
