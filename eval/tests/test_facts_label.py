"""The labelling round-trip and the two-labeller comparison.

The sheet is what a person edits; if the parser skipped a line it could not read, a fact would
vanish from the reference and every score would then count the app's correct answer as spurious.
Hence refusal-with-line-numbers tests. Fixtures here are JSON built in a temp dir, never audio.
"""
import contextlib
import io
import json
import os
import tempfile
import unittest

from eval import facts
from eval.corpus import facts_label as fl


def labelled():
    return {
        "prices": [{"id": "price-1", "span_ms": [70000, 74000], "spoken": "four ninety nine a month",
                    "amount": 4.99, "currency": "USD", "period": "month"}],
        "dates": [{"id": "date-1", "span_ms": [80000, 81000], "spoken": "Thursday",
                   "resolved_date": "2026-10-08", "relative_to": "2026-10-05"},
                  {"id": "date-2", "span_ms": [82000, 83000], "spoken": "before Wednesday",
                   "resolved_date": None, "relative_to": None}],
        "commitments": [{"id": "commit-1", "span_ms": [90000, 93000],
                         "text": "Rahul will recruit two people: one senior, one junior",
                         "owner": "Rahul", "due_spoken": "before Wednesday", "due_date": None,
                         "state": "promised"}],
        "decisions": [{"id": "decision-1", "span_ms": [100000, 102000], "text": "ship on Thursday"}],
        "owners_note": "Second commitment: Priya or Sam, unclear.\nAsk the adjudicator.",
    }


def without_marker(sheet):
    return "\n".join(l for l in sheet.splitlines() if "UNLABELLED" not in l)


class SheetRoundTripTest(unittest.TestCase):
    def test_round_trip_is_lossless(self):
        sheet = without_marker(fl.render_sheet("demo", labelled(), audio_ms=120000))
        parsed = fl.parse_sheet(sheet)
        self.assertEqual(parsed, labelled())

    def test_empty_sheet_round_trips_to_the_skeleton(self):
        sheet = without_marker(fl.render_sheet("demo", facts.empty_facts()))
        self.assertEqual(fl.parse_sheet(sheet), facts.empty_facts())

    def test_init_sheet_explains_each_class_with_examples_in_comments(self):
        sheet = fl.render_sheet("demo", facts.empty_facts())
        for heading in ("== PRICES ==", "== DATES ==", "== COMMITMENTS ==", "== DECISIONS ==",
                        "== OWNERS NOTE =="):
            self.assertIn(heading, sheet)
        examples = [l for l in sheet.splitlines() if l.startswith("# [") and "spoken:" in l]
        self.assertGreaterEqual(len(examples), 2)

    def test_ids_are_assigned_when_the_labeller_omits_them(self):
        sheet = ("== PRICES ==\n"
                 "[00:00:01.000 -> 00:00:02.000] spoken: five bucks | amount: 5 | currency: USD "
                 "| period: once\n"
                 "[00:00:03.000 -> 00:00:04.000] spoken: ten bucks | amount: 10 | currency: USD "
                 "| period: once\n")
        got = fl.parse_sheet(sheet)["prices"]
        self.assertEqual([p["id"] for p in got], ["price-1", "price-2"])
        self.assertEqual(got[0]["amount"], 5)

    def test_a_colon_inside_a_value_survives(self):
        sheet = ("== DECISIONS ==\n[0:01.000 -> 0:02.000] text: agreed: ship Thursday\n")
        self.assertEqual(fl.parse_sheet(sheet)["decisions"][0]["text"], "agreed: ship Thursday")


class SheetRefusalTest(unittest.TestCase):
    def refuses(self, sheet, *needles, audio_ms=None):
        with self.assertRaises(ValueError) as ctx:
            fl.parse_sheet(sheet, audio_ms=audio_ms)
        for n in needles:
            self.assertIn(n, str(ctx.exception))

    def test_untouched_sheet_is_refused(self):
        self.refuses(fl.render_sheet("demo", facts.empty_facts()), "UNLABELLED")

    def test_unreadable_line_names_its_line_number(self):
        self.refuses("== DECISIONS ==\n\nthis is not a fact\n", "line 3")

    def test_fact_outside_any_section(self):
        self.refuses("[0:01.000 -> 0:02.000] text: x\n", "line 1", "before any section")

    def test_unknown_section(self):
        self.refuses("== PRICE ==\n", "line 1", "unknown section")

    def test_bad_timestamp(self):
        self.refuses("== DECISIONS ==\n[abc -> 0:02.000] text: x\n", "line 2")

    def test_end_before_start_reports_the_line(self):
        self.refuses("== DECISIONS ==\n[0:05.000 -> 0:02.000] text: x\n", "line 2", "before it starts")

    def test_missing_field(self):
        self.refuses("== PRICES ==\n[0:01.000 -> 0:02.000] spoken: x | amount: 5 | currency: USD\n",
                     "line 2", "missing field 'period'")

    def test_unknown_field(self):
        self.refuses("== DECISIONS ==\n[0:01.000 -> 0:02.000] text: x | colour: red\n",
                     "line 2", "unknown field 'colour'")

    def test_bad_amount(self):
        self.refuses("== PRICES ==\n[0:01.000 -> 0:02.000] spoken: x | amount: lots | "
                     "currency: USD | period: once\n", "line 2", "amount")

    def test_unknown_state(self):
        self.refuses("== COMMITMENTS ==\n[0:01.000 -> 0:02.000] text: x | owner: null | "
                     "due_spoken: null | due_date: null | state: done\n", "line 2", "unknown state 'done'")

    def test_duplicate_id_reports_the_second_line(self):
        self.refuses("== DECISIONS ==\n[0:01.000 -> 0:02.000] id: a | text: x\n"
                     "[0:03.000 -> 0:04.000] id: a | text: y\n", "line 3", "duplicate id 'a'")

    def test_span_outside_audio_reports_the_line(self):
        self.refuses("== DECISIONS ==\n[0:01.000 -> 0:09.000] text: x\n", "line 2", "outside the audio",
                     audio_ms=5000)

    def test_all_problems_are_listed_not_just_the_first(self):
        with self.assertRaises(ValueError) as ctx:
            fl.parse_sheet("== DECISIONS ==\nbad one\nbad two\n")
        self.assertIn("line 2", str(ctx.exception))
        self.assertIn("line 3", str(ctx.exception))


def facts_with(**kw):
    d = facts.empty_facts()
    d.update(kw)
    return d


class AgreementTest(unittest.TestCase):
    def price(self, pid, span, amount=4.99, currency="USD", period="month"):
        return {"id": pid, "span_ms": span, "spoken": "x", "amount": amount, "currency": currency,
                "period": period}

    def commit(self, cid, span, owner="Rahul", state="promised"):
        return {"id": cid, "span_ms": span, "text": "t", "owner": owner, "due_spoken": None,
                "due_date": None, "state": state}

    def test_counts_per_class(self):
        a = facts_with(prices=[self.price("a1", [1000, 3000]), self.price("a2", [9000, 10000])],
                       commitments=[self.commit("c1", [5000, 6000])])
        b = facts_with(prices=[self.price("b1", [1500, 3500]), self.price("b3", [20000, 21000])],
                       commitments=[self.commit("c9", [5200, 5800])])
        r = fl.compare(a, b)
        self.assertEqual((len(r["prices"]["matched"]), len(r["prices"]["only_a"]),
                          len(r["prices"]["only_b"])), (1, 1, 1))
        self.assertEqual(len(r["commitments"]["matched"]), 1)
        self.assertEqual(len(r["dates"]["matched"]), 0)

    def test_matched_pair_that_differs_on_amount_is_listed(self):
        a = facts_with(prices=[self.price("a1", [1000, 3000], amount=4.99)])
        b = facts_with(prices=[self.price("b1", [1000, 3000], amount=499)])
        pair = fl.compare(a, b)["prices"]["matched"][0]
        self.assertEqual([d[0] for d in pair["diffs"]], ["amount"])

    def test_owner_and_state_differences(self):
        a = facts_with(commitments=[self.commit("c1", [0, 1000], owner="Rahul", state="promised")])
        b = facts_with(commitments=[self.commit("c2", [0, 1000], owner="Priya", state="completed")])
        diffs = fl.compare(a, b)["commitments"]["matched"][0]["diffs"]
        self.assertEqual(sorted(d[0] for d in diffs), ["owner", "state"])

    def test_owner_case_and_spacing_do_not_count_as_disagreement(self):
        a = facts_with(commitments=[self.commit("c1", [0, 1000], owner="Rahul  Rao")])
        b = facts_with(commitments=[self.commit("c2", [0, 1000], owner="rahul rao")])
        self.assertEqual(fl.compare(a, b)["commitments"]["matched"][0]["diffs"], [])

    def test_disjoint_spans_do_not_match(self):
        a = facts_with(prices=[self.price("a1", [0, 1000])])
        b = facts_with(prices=[self.price("b1", [1000, 2000])])
        r = fl.compare(a, b)["prices"]
        self.assertEqual((len(r["matched"]), len(r["only_a"]), len(r["only_b"])), (0, 1, 1))

    def test_matching_is_one_to_one(self):
        a = facts_with(prices=[self.price("a1", [0, 10000])])
        b = facts_with(prices=[self.price("b1", [0, 4000]), self.price("b2", [1000, 9000])])
        r = fl.compare(a, b)["prices"]
        self.assertEqual((len(r["matched"]), len(r["only_b"])), (1, 1))
        self.assertEqual(r["matched"][0]["b"]["id"], "b2")      # the better overlap wins

    def test_render_prints_the_disagreements_and_no_score(self):
        a = facts_with(prices=[self.price("a1", [1000, 3000], amount=4.99)])
        b = facts_with(prices=[self.price("b1", [1000, 3000], amount=499)])
        text = fl.render_agreement(fl.compare(a, b), "alice", "bob")
        self.assertIn("amount", text)
        self.assertIn("4.99", text)
        self.assertIn("499", text)
        self.assertNotIn("%", text)
        self.assertNotIn("kappa", text.lower())


class CommandTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = os.path.join(self.tmp.name, "real-demo")
        os.makedirs(self.dir)

    def run_cmd(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            fl.main(["facts_label"] + list(argv), fixtures=self.tmp.name)
        return out.getvalue()

    def test_init_writes_a_valid_skeleton_and_a_sheet(self):
        self.run_cmd("init", "real-demo")
        with open(os.path.join(self.dir, "facts.json")) as f:
            self.assertEqual(facts.validate(json.load(f)), [])
        self.assertTrue(os.path.exists(os.path.join(self.dir, "facts.sheet.txt")))

    def test_init_refuses_to_overwrite_labels(self):
        self.run_cmd("init", "real-demo")
        with self.assertRaises(SystemExit) as ctx:
            self.run_cmd("init", "real-demo")
        self.assertIn("already exists", str(ctx.exception))

    def test_init_on_a_missing_fixture_does_not_create_it(self):
        with self.assertRaises(SystemExit):
            self.run_cmd("init", "real-typo")
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "real-typo")))

    def test_import_uses_audio_length_from_truth_json(self):
        with open(os.path.join(self.dir, "truth.json"), "w") as f:
            json.dump({"audio_ms": 5000, "segments": []}, f)
        self.run_cmd("init", "real-demo")
        sheet = os.path.join(self.dir, "facts.sheet.txt")
        with open(sheet) as f:
            text = without_marker(f.read())
        with open(sheet, "w") as f:
            f.write(text + "\n== DECISIONS ==\n[0:01.000 -> 0:09.000] text: ship\n")
        with self.assertRaises(SystemExit) as ctx:
            self.run_cmd("import", "real-demo")
        self.assertIn("outside the audio", str(ctx.exception))

    def test_import_then_validate(self):
        self.run_cmd("init", "real-demo")
        sheet = os.path.join(self.dir, "facts.sheet.txt")
        with open(sheet) as f:
            text = without_marker(f.read())
        with open(sheet, "w") as f:
            f.write(text + "\n== DECISIONS ==\n[0:01.000 -> 0:09.000] text: ship\n")
        self.run_cmd("import", "real-demo")
        self.assertIn("ok", self.run_cmd("validate", "real-demo"))

    def test_validate_exits_nonzero_listing_problems(self):
        with open(os.path.join(self.dir, "facts.json"), "w") as f:
            json.dump({"decisions": [{"id": "a", "span_ms": [5, 1], "text": "x"}]}, f)
        with self.assertRaises(SystemExit) as ctx:
            self.run_cmd("validate", "real-demo")
        self.assertIn("before it starts", str(ctx.exception))

    def test_agreement_command_prints_disagreements(self):
        a = facts_with(decisions=[{"id": "a1", "span_ms": [0, 1000], "text": "ship Thursday"}])
        b = facts_with(decisions=[{"id": "b1", "span_ms": [50000, 51000], "text": "hire two"}])
        pa, pb = os.path.join(self.tmp.name, "a.json"), os.path.join(self.tmp.name, "b.json")
        for p, d in ((pa, a), (pb, b)):
            with open(p, "w") as f:
                json.dump(d, f)
        out = self.run_cmd("agreement", "real-demo", pa, pb)
        self.assertIn("only-A", out)
        self.assertIn("ship Thursday", out)
        self.assertIn("hire two", out)


if __name__ == "__main__":
    unittest.main()
