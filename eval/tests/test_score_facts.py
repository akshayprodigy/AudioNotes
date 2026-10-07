"""Scoring a meeting's factual accuracy from hand-adjudicated matches.

Every number here is an arithmetic consequence of a human's decisions, so the tests concentrate on
the rules that keep it honest: one outcome per reference fact, a silent S1 reported on its own,
no rate printed below the count-first minimum, and nothing scored without a human's matches.
Fixtures are JSON written into a temp dir; there is no audio anywhere.
"""
import contextlib
import csv
import io
import json
import os
import re
import tempfile
import unittest

from eval import score_facts as sf


def facts_doc():
    sp = lambda i: [i * 1000, i * 1000 + 500]
    return {
        "prices": [
            {"id": "pr1", "span_ms": sp(1), "spoken": "four ninety nine a month", "amount": 4.99,
             "currency": "USD", "period": "month"},
            {"id": "pr2", "span_ms": sp(2), "spoken": "ten dollars", "amount": 10,
             "currency": "USD", "period": "once"},
            {"id": "pr3", "span_ms": sp(3), "spoken": "twenty dollars", "amount": 20,
             "currency": "USD", "period": "once"}],
        "dates": [
            {"id": "d1", "span_ms": sp(4), "spoken": "Thursday", "resolved_date": "2026-10-08",
             "relative_to": "2026-10-05"},
            {"id": "d2", "span_ms": sp(5), "spoken": "before Wednesday", "resolved_date": None,
             "relative_to": None}],
        "commitments": [
            {"id": "c1", "span_ms": sp(6), "text": "Rahul will recruit two people", "owner": "Rahul",
             "due_spoken": None, "due_date": None, "state": "promised"},
            {"id": "c2", "span_ms": sp(7), "text": "the invoice is already sent", "owner": None,
             "due_spoken": None, "due_date": None, "state": "completed"},
            {"id": "c3", "span_ms": sp(8), "text": "Sam will book the venue", "owner": "Sam",
             "due_spoken": None, "due_date": None, "state": "promised"},
            {"id": "c4", "span_ms": sp(9), "text": "Priya will email the vendor", "owner": "Priya",
             "due_spoken": None, "due_date": None, "state": "promised"}],
        "decisions": [
            {"id": "dc1", "span_ms": sp(10), "text": "ship on Thursday"},
            {"id": "dc2", "span_ms": sp(11), "text": "hire two engineers"}],
        "owners_note": "",
    }


def produced_list():
    return [
        {"id": "p1", "kind": "price", "text": "$499 a month", "owner": None, "due": None,
         "anchor_ms": 1000, "flagged_for_review": False, "source": "rules"},
        {"id": "p2", "kind": "price", "text": "ten dollars", "owner": None, "due": None,
         "anchor_ms": 2000, "flagged_for_review": False, "source": "rules"},
        {"id": "p3", "kind": "date", "text": "Thursday", "owner": None, "due": None,
         "anchor_ms": 4000, "flagged_for_review": False, "source": "rules"},
        {"id": "p4", "kind": "action", "text": "Rahul will recruit two people", "owner": "Rahul",
         "due": None, "anchor_ms": 6000, "flagged_for_review": False, "source": "rules"},
        {"id": "p5", "kind": "action", "text": "send the invoice", "owner": None, "due": None,
         "anchor_ms": 7000, "flagged_for_review": True, "source": "writer"},
        {"id": "p6", "kind": "action", "text": "Let's start the weekly check-in", "owner": None,
         "due": None, "anchor_ms": None, "flagged_for_review": False, "source": "rules"},
        {"id": "p7", "kind": "decision", "text": "ship on Thursday", "owner": None, "due": None,
         "anchor_ms": 10000, "flagged_for_review": False, "source": "rules"},
        {"id": "p8", "kind": "question", "text": "who owns the venue?", "owner": None, "due": None,
         "anchor_ms": None, "flagged_for_review": False, "source": "rules"},
        {"id": "p9", "kind": "action", "text": "a duplicate of p4", "owner": "Rahul", "due": None,
         "anchor_ms": None, "flagged_for_review": False, "source": "rules"},
        {"id": "p10", "kind": "action", "text": "Sam will book the venue", "owner": "Pam",
         "due": None, "anchor_ms": 8000, "flagged_for_review": False, "source": "rules"},
    ]


def row(ref, prod, outcome, stage=None, severity=None, fields=None, note="", anchor="na"):
    return {"ref_id": ref, "produced_id": prod, "outcome": outcome, "stage": stage,
            "severity": severity, "fields": fields, "note": note, "anchor": anchor}


def matches_list():
    return [
        row("pr1", "p1", "wrong_value", "extractor-rules", "S1", ["amount"], anchor="resolves"),
        row("pr2", "p2", "correct", anchor="resolves"),
        row("pr3", None, "missing", "asr", "S1"),
        row("d1", "p3", "correct", anchor="wrong-moment"),
        row("d2", None, "missing", "extractor-rules", "S1"),
        row("c1", "p4", "correct", anchor="resolves"),
        row("c2", "p5", "wrong_value", "writer", "S1", ["state"], anchor="summary"),
        row("c3", "p10", "wrong_value", "diarization", "S1", ["owner"], anchor="resolves"),
        row("c4", None, "missing", "extractor-rules", "S1"),
        row("dc1", "p7", "correct", anchor="resolves"),
        row("dc2", None, "missing", "classifier", "S2"),
        row(None, "p6", "spurious", "classifier", "S2", note="a meeting opener"),
        row(None, "p9", "ignored", note="duplicate of p4, already counted"),
    ]


def build(matches=None, produced=None, min_instances=1, cohort=None):
    return sf.score(facts_doc(), produced or produced_list(),
                    matches if matches is not None else matches_list(),
                    meeting_id="real-demo", cohort=cohort or {}, min_instances=min_instances)


class WilsonTest(unittest.TestCase):
    # Hand-computed with z = 1.96, e.g. 5/10: centre (0.5+0.1921)/1.3842 = 0.5,
    # half-width 1.96*sqrt(0.025+0.009604)/1.3842 = 0.2634 -> 0.2366 .. 0.7634.
    def check(self, k, n, lo, hi):
        got = sf.wilson(k, n)
        self.assertAlmostEqual(got[0], lo, places=4)
        self.assertAlmostEqual(got[1], hi, places=4)

    def test_half_of_ten(self):
        self.check(5, 10, 0.2366, 0.7634)

    def test_27_of_30(self):
        self.check(27, 30, 0.7438, 0.9654)

    def test_81_of_100(self):
        self.check(81, 100, 0.7222, 0.8749)

    def test_none_of_thirty_closed_form(self):
        # k = 0: lower bound exactly 0, upper bound z^2 / (n + z^2) = 3.8416 / 33.8416
        lo, hi = sf.wilson(0, 30)
        self.assertEqual(lo, 0.0)
        self.assertAlmostEqual(hi, 3.8416 / 33.8416, places=6)

    def test_all_of_thirty_is_the_mirror(self):
        lo, hi = sf.wilson(30, 30)
        self.assertEqual(hi, 1.0)
        self.assertAlmostEqual(lo, 1 - 3.8416 / 33.8416, places=6)

    def test_zero_n_has_no_interval(self):
        self.assertIsNone(sf.wilson(0, 0))


class ProducedTest(unittest.TestCase):
    def test_from_run_document(self):
        doc = {"minutes": [
            {"kind": "summary", "content": "3 action items", "source": "rule"},
            {"kind": "action", "content": "Ship it. — Bo (due Monday)", "source": "rule"},
            {"kind": "decision", "content": "Go with rubber", "source": "llm",
             "anchor_ms": 4200, "flagged_for_review": True},
            {"kind": "question", "content": "Who pays?", "source": "rule"}]}
        got = sf.produced_from_run(doc)
        self.assertEqual([p["id"] for p in got], ["m0", "m1", "m2", "m3"])
        self.assertEqual((got[1]["text"], got[1]["owner"], got[1]["due"]), ("Ship it.", "Bo", "Monday"))
        self.assertEqual((got[1]["source"], got[2]["source"]), ("rules", "writer"))
        self.assertEqual((got[2]["anchor_ms"], got[2]["flagged_for_review"]), (4200, True))
        self.assertEqual(sf.validate_produced(got), [])

    def test_produced_problems(self):
        probs = sf.validate_produced([{"id": "a", "kind": "action", "text": "x"},
                                      {"id": "a", "kind": "banana", "text": "y"},
                                      {"kind": "action", "text": "z"}])
        joined = "\n".join(probs)
        self.assertIn("duplicate id 'a'", joined)
        self.assertIn("unknown kind 'banana'", joined)
        self.assertIn("needs a non-empty string id", joined)


class OutcomeTest(unittest.TestCase):
    def test_class_counts(self):
        s = build()["summary"]["classes"]
        self.assertEqual(s["price"]["counts"],
                         {"ref": 3, "correct": 1, "wrong_value": 1, "missing": 1, "spurious": 0,
                          "ignored": 0})
        self.assertEqual(s["date"]["counts"]["correct"], 1)
        self.assertEqual(s["date"]["counts"]["missing"], 1)
        self.assertEqual(s["commitment"]["counts"],
                         {"ref": 4, "correct": 1, "wrong_value": 2, "missing": 1, "spurious": 1,
                          "ignored": 1})
        self.assertEqual(s["decision"]["counts"]["missing"], 1)

    def test_every_outcome_path_produces_a_row(self):
        rows = build()["rows"]
        self.assertEqual({r["outcome"] for r in rows},
                         {"correct", "wrong_value", "missing", "spurious", "ignored"})
        self.assertEqual(len(rows), 13)

    def test_owner_and_state_are_scored_from_the_fields_a_human_named(self):
        m = build()["summary"]["classes"]["commitment"]["metrics"]
        self.assertEqual((m["owner"]["k"], m["owner"]["n"]), (2, 3))       # c3's owner is wrong
        self.assertEqual((m["state"]["k"], m["state"]["n"]), (2, 3))       # c2 shown as open
        self.assertEqual((m["recall"]["k"], m["recall"]["n"]), (3, 4))
        self.assertEqual((m["precision"]["k"], m["precision"]["n"]), (3, 4))

    def test_price_and_date_and_decision_metrics(self):
        s = build()["summary"]["classes"]
        self.assertEqual((s["price"]["metrics"]["accuracy"]["k"],
                          s["price"]["metrics"]["accuracy"]["n"]), (1, 3))
        self.assertEqual((s["date"]["metrics"]["accuracy"]["k"],
                          s["date"]["metrics"]["accuracy"]["n"]), (1, 2))
        self.assertEqual((s["decision"]["metrics"]["recall"]["k"],
                          s["decision"]["metrics"]["recall"]["n"]), (1, 2))

    def test_anchor_results_are_counted(self):
        a = build()["summary"]["anchors"]
        self.assertEqual(a["resolves"], 5)
        self.assertEqual(a["wrong-moment"], 1)
        self.assertEqual(a["summary"], 1)

    def test_stage_counts_cover_errors_only(self):
        st = build()["summary"]["stages"]
        self.assertEqual(st["extractor-rules"], 3)
        self.assertEqual(st["asr"], 1)
        self.assertEqual(sum(st.values()), 8)


class SilentS1Test(unittest.TestCase):
    def test_silent_s1_is_an_s1_error_whose_item_was_not_flagged(self):
        s1 = build()["summary"]["s1"]
        self.assertEqual(s1["total"], 6)
        self.assertEqual(s1["with_item"], 3)          # pr1, c2, c3 had a produced item
        self.assertEqual(s1["missing_no_item"], 3)    # pr3, d2, c4: nothing was there to flag
        self.assertEqual(s1["silent"], 2)             # pr1 and c3; c2 was flagged for review
        self.assertEqual(s1["flagged"], 1)

    def test_flagging_the_item_makes_it_not_silent(self):
        produced = produced_list()
        for p in produced:
            p["flagged_for_review"] = True
        s1 = build(produced=produced)["summary"]["s1"]
        self.assertEqual((s1["silent"], s1["flagged"]), (0, 3))

    def test_s2_errors_are_never_silent_s1(self):
        s1 = build()["summary"]["s1"]
        self.assertEqual(s1["total"], 6)              # dc2 (S2 missing) and p6 (S2 spurious) excluded

    def test_report_prints_the_silent_s1_line(self):
        text = sf.render_report([build()["doc"]], min_instances=1)
        self.assertIn("Silent S1: 2", text)
        self.assertIn("1 of the 3 S1 errors that had a produced item were flagged", text)

    def test_missing_flag_data_is_stated(self):
        produced = [{k: v for k, v in p.items() if k != "flagged_for_review"}
                    for p in produced_list()]
        doc = build(produced=produced)["doc"]
        self.assertFalse(doc["flag_data_present"])
        self.assertIn("carried no flagged_for_review", sf.render_report([doc], 1))


class CountFirstRuleTest(unittest.TestCase):
    def test_below_minimum_no_rate_is_printed(self):
        text = sf.render_report([build(min_instances=30)["doc"]], min_instances=30)
        self.assertIsNone(re.search(r"\d\.\d%", text), "a rate leaked into the report")
        self.assertIn("rate not printed", text)
        self.assertIn("3 reference instances, fewer than the 30 required", text)

    def test_refused_classes_list_their_individual_errors(self):
        text = sf.render_report([build(min_instances=30)["doc"]], min_instances=30)
        self.assertIn("pr1", text)
        self.assertIn("$499 a month", text)
        self.assertIn("wrong_value", text)

    def test_at_the_minimum_the_rate_is_printed_with_an_interval(self):
        text = sf.render_report([build()["doc"]], min_instances=3)
        self.assertIn("33.3%", text)                  # price accuracy 1 of 3
        self.assertIn("[", text)                      # with its Wilson interval

    def test_one_below_the_minimum_is_refused(self):
        # prices have 3 reference instances: min 3 prints, min 4 refuses
        printed = sf.render_report([build()["doc"]], min_instances=3)
        refused = sf.render_report([build()["doc"]], min_instances=4)
        self.assertIn("price accuracy: 33.3%", printed)
        self.assertNotIn("price accuracy: 33.3%", refused)
        self.assertIn("price accuracy: rate not printed", refused)

    def test_gate_uses_the_smaller_of_the_class_and_the_metrics_own_denominator(self):
        # commitments: 4 reference, but owner is only checkable on the 3 that were matched
        text = sf.render_report([build()["doc"]], min_instances=4)
        self.assertIn("commitment recall: 75.0%", text)
        self.assertIn("commitment owner: rate not printed", text)

    def test_precision_cannot_be_printed_on_the_back_of_many_spurious_items(self):
        # One reference commitment but six produced actions: the produced side has n = 6, which
        # would clear a minimum of 3, yet the class has a single reference instance.
        facts_one = {"prices": [], "dates": [], "decisions": [], "owners_note": "",
                     "commitments": [facts_doc()["commitments"][0]]}
        produced = [{"id": f"x{i}", "kind": "action", "text": f"noise {i}"} for i in range(5)]
        produced.append({"id": "hit", "kind": "action", "text": "Rahul will recruit two people"})
        matches = [row("c1", "hit", "correct")] + \
                  [row(None, f"x{i}", "spurious", "classifier", "S2") for i in range(5)]
        r = sf.score(facts_one, produced, matches, "m", {}, 3)["summary"]
        prec = r["classes"]["commitment"]["metrics"]["precision"]
        self.assertEqual((prec["k"], prec["n"]), (1, 6))
        self.assertTrue(prec["refused"])

    def test_summary_marks_refusal_without_a_rate(self):
        m = build(min_instances=30)["summary"]["classes"]["price"]["metrics"]["accuracy"]
        self.assertTrue(m["refused"])
        self.assertIsNone(m["rate"])
        self.assertIsNone(m["ci"])

    def test_no_pass_fail_language_anywhere(self):
        text = sf.render_report([build()["doc"]], min_instances=1).lower()
        for word in ("pass", "fail", "meets", "acceptable"):
            self.assertNotIn(word, text)


class MatchValidationTest(unittest.TestCase):
    def problems(self, matches, produced=None):
        return sf.validate_matches(matches, facts_doc(), produced or produced_list())

    def test_the_good_set_is_clean(self):
        self.assertEqual(self.problems(matches_list()), [])

    def assertProblem(self, matches, needle):
        found = self.problems(matches)
        self.assertTrue(any(needle in p for p in found), f"{needle!r} not in {found}")

    def test_reference_with_two_outcomes(self):
        m = matches_list() + [row("pr2", None, "missing", "asr", "S1")]
        self.assertProblem(m, "reference fact 'pr2' has 2 outcome rows")

    def test_reference_with_no_outcome(self):
        m = [r for r in matches_list() if r["ref_id"] != "pr3"]
        self.assertProblem(m, "reference fact 'pr3' has no outcome row")

    def test_unaccounted_produced_item(self):
        m = [r for r in matches_list() if r["produced_id"] != "p6"]
        self.assertProblem(m, "produced item 'p6' (action) is neither matched, spurious nor ignored")

    def test_questions_and_summaries_need_no_row(self):
        self.assertEqual(self.problems(matches_list()), [])     # p8 is a question, has no row

    def test_ignored_needs_a_reason(self):
        m = [r for r in matches_list() if r["produced_id"] != "p9"] + \
            [row(None, "p9", "ignored", note="  ")]
        self.assertProblem(m, "ignored row for 'p9' needs a note")

    def test_unknown_outcome(self):
        m = matches_list()
        m[0]["outcome"] = "kinda"
        self.assertProblem(m, "unknown outcome 'kinda'")

    def test_correct_needs_both_sides(self):
        m = matches_list()
        m[1]["produced_id"] = None
        self.assertProblem(m, "'correct' needs both ref_id and produced_id")

    def test_missing_must_not_name_a_produced_item(self):
        m = matches_list()
        m[2]["produced_id"] = "p1"
        self.assertProblem(m, "'missing' must have produced_id null")

    def test_spurious_must_not_name_a_reference(self):
        m = matches_list()
        m[11]["ref_id"] = "pr1"
        self.assertProblem(m, "'spurious' must have ref_id null")

    def test_unknown_ids(self):
        m = matches_list() + [row("zz", None, "missing", "asr", "S1")]
        self.assertProblem(m, "ref_id 'zz' is not in facts.json")
        m = matches_list()
        m[1]["produced_id"] = "nope"
        self.assertProblem(m, "produced_id 'nope' is not in the produced items")

    def test_error_needs_stage_and_severity(self):
        m = matches_list()
        m[2]["stage"] = None
        m[4]["severity"] = "S3"
        self.assertProblem(m, "needs a stage")
        self.assertProblem(m, "severity must be S1 or S2")

    def test_wrong_value_needs_fields_of_its_class(self):
        m = matches_list()
        m[0]["fields"] = None
        self.assertProblem(m, "'wrong_value' must name the wrong fields")
        m = matches_list()
        m[0]["fields"] = ["owner"]
        self.assertProblem(m, "field 'owner' is not a price field")

    def test_bad_anchor(self):
        m = matches_list()
        m[1]["anchor"] = "sort-of"
        self.assertProblem(m, "unknown anchor 'sort-of'")

    def test_correct_rows_carry_no_severity(self):
        m = matches_list()
        m[1]["severity"] = "S1"
        self.assertProblem(m, "a 'correct' row carries no stage or severity")

    def test_produced_item_both_matched_and_spurious(self):
        m = matches_list() + [row(None, "p4", "spurious", "classifier", "S2")]
        self.assertProblem(m, "produced item 'p4' is both matched and spurious/ignored")

    def test_spurious_for_a_kind_with_no_reference_class(self):
        m = matches_list() + [row(None, "p8", "spurious", "classifier", "S2")]
        self.assertProblem(m, "produced item 'p8' is a question, which is not scored")

    def test_not_a_list(self):
        self.assertIn("must be a JSON list", self.problems({"a": 1})[0])

    def test_row_not_an_object(self):
        self.assertIn("row 1 is not an object", self.problems(["x"])[0])

    def test_a_candidates_file_is_not_adjudicated_matches(self):
        todo = {"status": "CANDIDATES ONLY", "candidates": [], "template": []}
        self.assertIn("candidate", self.problems(todo)[0])

    def test_template_rows_with_no_outcome_are_rejected(self):
        self.assertProblem([row("pr1", "p1", None)], "unknown outcome None")

    def test_scoring_malformed_matches_raises_with_every_problem(self):
        with self.assertRaises(ValueError) as ctx:
            sf.score(facts_doc(), produced_list(), [row("pr1", None, "kinda")],
                     meeting_id="m", cohort={}, min_instances=1)
        self.assertIn("unknown outcome 'kinda'", str(ctx.exception))
        self.assertIn("has no outcome row", str(ctx.exception))


class CandidatesTest(unittest.TestCase):
    def test_token_overlap_proposes_pairs_but_scores_nothing(self):
        todo = sf.candidates(facts_doc(), produced_list())
        self.assertIn("CANDIDATES ONLY", todo["status"])
        pairs = {(c["ref_id"], c["produced_id"]) for c in todo["candidates"]}
        self.assertIn(("pr1", "p1"), pairs)           # "a month" in common
        self.assertIn(("c1", "p4"), pairs)
        self.assertNotIn(("c1", "p7"), pairs)         # decision vs commitment: wrong kind
        self.assertNotIn("summary", todo)
        self.assertNotIn("rows", todo)
        self.assertTrue(all(r["outcome"] is None for r in todo["template"]))

    def test_every_reference_fact_is_in_the_template(self):
        todo = sf.candidates(facts_doc(), produced_list())
        refs = {r["ref_id"] for r in todo["template"] if r["ref_id"]}
        self.assertEqual(refs, {"pr1", "pr2", "pr3", "d1", "d2", "c1", "c2", "c3", "c4",
                                "dc1", "dc2"})


class CommandTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fx = os.path.join(self.tmp.name, "real-demo")
        os.makedirs(self.fx)
        self.out = os.path.join(self.tmp.name, "out")
        self.write("facts.json", facts_doc(), self.fx)
        self.write("truth.json", {"audio_ms": 60000, "segments": []}, self.fx)
        self.write("meta.json", {"device": "A07", "capture_path": "in-app", "tier": "free",
                                 "meeting_type": "planning", "field_density": "dense"}, self.fx)
        self.write("produced.json", produced_list(), self.tmp.name)

    def write(self, name, obj, where):
        with open(os.path.join(where, name), "w") as f:
            json.dump(obj, f)
        return os.path.join(where, name)

    def run_cmd(self, *extra):
        argv = ["--fixture", self.fx, "--produced", os.path.join(self.tmp.name, "produced.json"),
                "--out", self.out] + list(extra)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            sf.main(argv)
        return buf.getvalue()

    def test_without_matches_it_writes_candidates_and_stops(self):
        with self.assertRaises(SystemExit) as ctx:
            self.run_cmd()
        self.assertNotEqual(ctx.exception.code, 0)
        self.assertIn("matches.todo.json", str(ctx.exception))
        self.assertTrue(os.path.exists(os.path.join(self.out, "matches.todo.json")))
        self.assertFalse(os.path.exists(os.path.join(self.out, "facts_score.json")))
        self.assertFalse(os.path.exists(os.path.join(self.out, "facts_report.md")))

    def test_with_matches_it_writes_the_three_outputs(self):
        m = self.write("matches.json", matches_list(), self.tmp.name)
        self.run_cmd("--matches", m, "--min-instances", "1")
        for name in ("facts_score.json", "facts_errors.csv", "facts_report.md"):
            self.assertTrue(os.path.exists(os.path.join(self.out, name)), name)
        with open(os.path.join(self.out, "facts_score.json")) as f:
            doc = json.load(f)
        self.assertEqual(doc["meeting_id"], "real-demo")
        self.assertEqual(doc["cohort"]["device"], "A07")
        self.assertEqual(doc["min_instances"], 1)

    def test_errors_csv_has_one_row_per_error_with_the_agreed_columns(self):
        m = self.write("matches.json", matches_list(), self.tmp.name)
        self.run_cmd("--matches", m)
        with open(os.path.join(self.out, "facts_errors.csv")) as f:
            rows = list(csv.DictReader(f))
        self.assertEqual(len(rows), 8)
        for col in ("meeting_id", "class", "outcome", "stage", "severity", "reference_span",
                    "produced_text", "anchor"):
            self.assertIn(col, rows[0])
        first = [r for r in rows if r["outcome"] == "wrong_value" and r["class"] == "price"][0]
        self.assertEqual(first["produced_text"], "$499 a month")
        self.assertEqual(first["reference_span"], "1000-1500")

    def test_default_min_instances_is_30(self):
        m = self.write("matches.json", matches_list(), self.tmp.name)
        self.run_cmd("--matches", m)
        with open(os.path.join(self.out, "facts_score.json")) as f:
            self.assertEqual(json.load(f)["min_instances"], 30)
        with open(os.path.join(self.out, "facts_report.md")) as f:
            self.assertIn("rate not printed", f.read())

    def test_malformed_matches_exit_with_the_problem_list_and_write_no_score(self):
        bad = matches_list()[:-1]
        m = self.write("matches.json", bad, self.tmp.name)
        with self.assertRaises(SystemExit) as ctx:
            self.run_cmd("--matches", m)
        self.assertIn("neither matched, spurious nor ignored", str(ctx.exception))
        self.assertFalse(os.path.exists(os.path.join(self.out, "facts_score.json")))

    def test_invalid_facts_json_is_refused(self):
        bad = facts_doc()
        bad["commitments"][0]["state"] = "done"
        self.write("facts.json", bad, self.fx)
        m = self.write("matches.json", matches_list(), self.tmp.name)
        with self.assertRaises(SystemExit) as ctx:
            self.run_cmd("--matches", m)
        self.assertIn("unknown state", str(ctx.exception))

    def test_run_document_input(self):
        run = {"minutes": [{"kind": "action", "content": "Rahul will recruit — Rahul",
                            "source": "rule"}]}
        p = self.write("run.json", run, self.tmp.name)
        argv = ["--fixture", self.fx, "--run", p, "--out", self.out]
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), self.assertRaises(SystemExit):
            sf.main(argv)
        with open(os.path.join(self.out, "matches.todo.json")) as f:
            todo = json.load(f)
        self.assertEqual(todo["produced_ids"], ["m0"])

    def test_one_of_run_or_produced_is_required(self):
        with self.assertRaises(SystemExit):
            sf.main(["--fixture", self.fx, "--out", self.out])

    def test_meta_is_optional(self):
        os.remove(os.path.join(self.fx, "meta.json"))
        m = self.write("matches.json", matches_list(), self.tmp.name)
        self.run_cmd("--matches", m)
        with open(os.path.join(self.out, "facts_score.json")) as f:
            self.assertEqual(json.load(f)["cohort"]["device"], "unknown")


if __name__ == "__main__":
    unittest.main()
