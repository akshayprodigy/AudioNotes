"""Label a meeting's facts from the audio, then compare two labellers.

The reference for factual accuracy (prices, dates, commitments, decisions) is hand-labelled by a
person who HEARS the audio — not corrected from the app's transcript, which would leave a
plausible mishearing in the answer key. The tool only moves labels between a plain-text sheet
and a validated facts.json; it never invents one.

    python3 -m eval.corpus.facts_label init <fixture-id>
    # ... fill in eval/fixtures/<id>/facts.sheet.txt while listening, delete its STATUS line ...
    python3 -m eval.corpus.facts_label import <fixture-id>
    python3 -m eval.corpus.facts_label validate <fixture-id>
    python3 -m eval.corpus.facts_label agreement <fixture-id> <labeller-a.json> <labeller-b.json>

`agreement` prints, per class, what two independent labellers matched and where they differ, so a
third person can adjudicate. It deliberately prints no single score and sets no threshold.
"""
import json
import os
import re
import sys

from eval import facts
from eval.corpus.truth_draft import format_timestamp, parse_timestamp

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIXTURES = os.path.join(ROOT, "eval", "fixtures")

SECTIONS = {"PRICES": facts.PRICES, "DATES": facts.DATES, "COMMITMENTS": facts.COMMITMENTS,
            "DECISIONS": facts.DECISIONS, "OWNERS NOTE": "owners_note"}
HEADINGS = {v: k for k, v in SECTIONS.items()}
ID_PREFIX = {facts.PRICES: "price", facts.DATES: "date", facts.COMMITMENTS: "commit",
             facts.DECISIONS: "decision"}
MARKER = "# STATUS: UNLABELLED"

_SECTION = re.compile(r"^==\s*(.+?)\s*==$")
_FACT = re.compile(r"^\[\s*([^\s\]]+)\s*(?:->|→)\s*([^\s\]]+)\s*\]\s*(.*)$")
_PIPE = re.compile(r"\s\|\s")
_NULLS = ("null", "none", "")

HEADER = """\
# Reference facts for `{fixture}` -- label from the AUDIO, then run:
#     python3 -m eval.corpus.facts_label import {fixture}
#
# Listen and write down what was SAID and what it MEANT. Do not open the app's output first: the
# whole point is that your labels are independent of it. A second person labels the same
# meeting separately; a third settles the differences.
#
# One fact per line:   [start -> end] key: value | key: value | ...
# The span is where in the audio the claim is made (HH:MM:SS.mmm, MM:SS.mmm or seconds).
# Write null (or leave a value empty) for "none" in the fields that allow it. `id:` is optional
# and is filled in for you; give one only to keep a stable name across re-imports.
# Lines starting with # are ignored. Sections may be repeated.
#
# audio_ms: {audio_ms}
{marker} -- delete this line when you are done. Import refuses while it is here, so a
# sheet nobody has looked at cannot become a reference that says "this meeting had no facts".
"""

EXAMPLES = {
    facts.PRICES: [
        "# [00:01:10.000 -> 00:01:14.000] spoken: four ninety nine a month | amount: 4.99 | "
        "currency: USD | period: month",
        "# [00:12:03.500 -> 00:12:06.000] spoken: two lakh fifty | amount: 250000 | "
        "currency: INR | period: once",
    ],
    facts.DATES: [
        "# [00:03:20.000 -> 00:03:22.000] spoken: Thursday | resolved_date: 2026-10-08 | "
        "relative_to: 2026-10-05",
        "# [00:03:30.000 -> 00:03:33.000] spoken: before Wednesday | resolved_date: null | "
        "relative_to: null     (a deadline, not a date)",
    ],
    facts.COMMITMENTS: [
        "# [00:05:00.000 -> 00:05:04.000] text: Rahul will recruit two people | owner: Rahul | "
        "due_spoken: before Wednesday | due_date: null | state: promised",
        "# [00:06:10.000 -> 00:06:13.000] text: the invoice is already sent | owner: Priya | "
        "due_spoken: null | due_date: null | state: completed",
        "# states: promised (future, still to do) | completed (reported done) | conditional | "
        "withdrawn",
    ],
    facts.DECISIONS: [
        "# [00:08:40.000 -> 00:08:44.000] text: we ship on Thursday",
    ],
}


def _cell(v):
    if v is None:
        return "null"
    return str(v)


def _render_item(cls, item):
    start, end = item["span_ms"]
    parts = [f"id: {item['id']}"] + [f"{k}: {_cell(item[k])}" for k in facts.FIELDS[cls]]
    return f"[{format_timestamp(start)} -> {format_timestamp(end)}] " + " | ".join(parts)


def render_sheet(fixture_id, doc, audio_ms=None):
    out = [HEADER.format(fixture=fixture_id, audio_ms=audio_ms if audio_ms is not None else "unknown",
                         marker=MARKER)]
    for cls in facts.CLASSES:
        out.append(f"== {HEADINGS[cls]} ==")
        out += EXAMPLES[cls]
        out += [_render_item(cls, it) for it in doc.get(cls, [])]
        out.append("")
    out.append("== OWNERS NOTE ==")
    out.append("# Free text: where an owner is ambiguous, say so here so the adjudicator decides.")
    if doc.get("owners_note"):
        out += doc["owners_note"].split("\n")
    return "\n".join(out) + "\n"


def parse_sheet(text, audio_ms=None):
    """-> facts dict. Raises ValueError listing every problem with its line number."""
    errors = []                                   # (line, message)
    doc = facts.empty_facts()
    note_lines = []
    lines_of = {}                                 # id -> [line numbers]
    pending = []                                  # (cls, item, line) in file order
    section = None

    if any(l.strip().startswith(MARKER) for l in text.splitlines()):
        raise ValueError(
            "this sheet still carries its STATUS: UNLABELLED line.\n"
            "  Label the meeting from the audio, then delete that line. Importing it as-is "
            "would record 'this meeting had no facts' as a reference.")

    for n, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = _SECTION.match(line)
        if m:
            name = m.group(1).upper()
            if name not in SECTIONS:
                errors.append((n, f"unknown section {m.group(1)!r} "
                                  f"(one of {', '.join(SECTIONS)})"))
                section = None
            else:
                section = SECTIONS[name]
            continue
        if section is None:
            errors.append((n, "text before any section heading (or inside an unknown section)"))
            continue
        if section == "owners_note":
            note_lines.append(raw.rstrip())
            continue
        item = _parse_fact_line(section, line, n, errors)
        if item is not None:
            pending.append((section, item, n))

    explicit = {it["id"] for _, it, _ in pending if "id" in it}
    counters = {}
    for cls, item, n in pending:
        if "id" not in item:
            while True:
                counters[cls] = counters.get(cls, 0) + 1
                cand = f"{ID_PREFIX[cls]}-{counters[cls]}"
                if cand not in explicit:
                    break
            item["id"] = cand
            explicit.add(cand)
        lines_of.setdefault(item["id"], []).append(n)
        doc[cls].append(_ordered(cls, item))
    doc["owners_note"] = "\n".join(note_lines).strip()

    for issue in facts.check(doc, audio_ms):
        ln = lines_of.get(issue.item_id, [0])
        n = ln[-1] if "duplicate id" in issue.message else ln[0]
        errors.append((n, str(issue)))
    if errors:
        errors.sort(key=lambda e: e[0])
        raise ValueError(f"{len(errors)} problem(s):\n" +
                         "\n".join(f"  line {n}: {msg}" if n else f"  {msg}" for n, msg in errors))
    return doc


def _ordered(cls, item):
    d = {"id": item["id"], "span_ms": item["span_ms"]}
    d.update({k: item[k] for k in facts.FIELDS[cls] if k in item})
    d.update({k: v for k, v in item.items() if k not in d})
    return d


def _parse_fact_line(cls, line, n, errors):
    m = _FACT.match(line)
    if not m:
        errors.append((n, f"cannot read {line!r}\n    expected: [start -> end] key: value | key: value"))
        return None
    try:
        start, end = parse_timestamp(m.group(1)), parse_timestamp(m.group(2))
    except ValueError:
        errors.append((n, f"cannot read the timestamps in {line[:60]!r}"))
        return None
    item = {"span_ms": [start, end]}
    ok = True
    for part in _PIPE.split(m.group(3).strip()):
        key, sep, value = part.partition(":")
        key, value = key.strip().lower(), value.strip()
        if not sep or not key:
            errors.append((n, f"cannot read {part!r}; expected 'key: value'"))
            ok = False
            continue
        if key in item:
            errors.append((n, f"field {key!r} given twice"))
            ok = False
            continue
        if key == "id":
            item["id"] = value
        elif key in facts.FIELDS[cls]:
            kind = facts.FIELDS[cls][key]
            if kind in ("str?", "date?") and value.lower() in _NULLS:
                item[key] = None
            elif kind == "num":
                try:
                    f = float(value)
                except ValueError:
                    errors.append((n, f"{key} must be a number, got {value!r}"))
                    ok = False
                    continue
                item[key] = int(f) if f == int(f) and re.fullmatch(r"-?\d+", value) else f
            else:
                item[key] = value
        else:
            item[key] = value            # check() reports it as an unknown field
    return item if ok else None


# ---- two labellers --------------------------------------------------------------------------

COMPARED = {facts.PRICES: ("amount", "currency", "period"),
            facts.DATES: ("resolved_date",),
            facts.COMMITMENTS: ("owner", "state", "due_date"),
            facts.DECISIONS: ()}


def _norm(v):
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, (int, float)):
        return float(v)
    return " ".join(str(v).split()).casefold()


def _overlap(a, b):
    return min(a[1], b[1]) - max(a[0], b[0])


def _iou(a, b):
    inter = _overlap(a, b)
    union = max(a[1], b[1]) - min(a[0], b[0])
    return inter / union if union > 0 else 1.0


def _same_place(a, b):
    """Spans overlap, or are the same instant (a zero-length span has no overlap to speak of)."""
    return _overlap(a, b) > 0 or a == b


def compare(a, b):
    """-> {class: {"matched": [{"a","b","diffs"}], "only_a": [...], "only_b": [...]}}.

    Matching is by span overlap, one-to-one, best overlap first. Matched pairs are then checked
    field by field for EXACT agreement (owner and state for commitments, amount/currency/period
    for prices, resolved date for dates); a pair that matches on place but not on value is a
    disagreement to adjudicate, not a failure to match.
    """
    out = {}
    for cls in facts.CLASSES:
        xs, ys = a.get(cls, []), b.get(cls, [])
        cands = sorted(((_iou(x["span_ms"], y["span_ms"]), x["id"], y["id"], i, j)
                        for i, x in enumerate(xs) for j, y in enumerate(ys)
                        if _same_place(x["span_ms"], y["span_ms"])),
                       key=lambda c: (-c[0], c[1], c[2]))
        used_x, used_y, pairs = set(), set(), []
        for _, _, _, i, j in cands:
            if i in used_x or j in used_y:
                continue
            used_x.add(i)
            used_y.add(j)
            pairs.append((i, j))
        matched = []
        for i, j in sorted(pairs):
            diffs = [(f, xs[i].get(f), ys[j].get(f)) for f in COMPARED[cls]
                     if _norm(xs[i].get(f)) != _norm(ys[j].get(f))]
            matched.append({"a": xs[i], "b": ys[j], "diffs": diffs})
        out[cls] = {"matched": matched,
                    "only_a": [x for i, x in enumerate(xs) if i not in used_x],
                    "only_b": [y for j, y in enumerate(ys) if j not in used_y]}
    return out


def _label(cls, item):
    text = item.get("text") or item.get("spoken") or ""
    start, end = item["span_ms"]
    return f"{item['id']} [{format_timestamp(start)} -> {format_timestamp(end)}] {text}"


def render_agreement(result, name_a="A", name_b="B"):
    """Counts per class, then every disagreement. No single score: the point is the list."""
    lines = [f"Labeller agreement: {name_a} (A) vs {name_b} (B)", ""]
    for cls in facts.CLASSES:
        r = result[cls]
        agree = sum(1 for m in r["matched"] if not m["diffs"])
        lines.append(f"{cls}: matched {len(r['matched'])} (same on every compared field: {agree}, "
                     f"differing: {len(r['matched']) - agree}), only-A {len(r['only_a'])}, "
                     f"only-B {len(r['only_b'])}")
    lines += ["", "For adjudication", ""]
    anything = False
    for cls in facts.CLASSES:
        r = result[cls]
        for m in r["matched"]:
            if m["diffs"]:
                anything = True
                lines.append(f"[{cls}] same place, different value: {_label(cls, m['a'])}")
                for f, va, vb in m["diffs"]:
                    lines.append(f"    {f}: A={va!r}  B={vb!r}   (B's fact: {m['b']['id']})")
        for tag, key in (("only-A", "only_a"), ("only-B", "only_b")):
            for it in r[key]:
                anything = True
                lines.append(f"[{cls}] {tag}: {_label(cls, it)}")
    if not anything:
        lines.append("(none -- the two sets match on every compared field)")
    lines += ["", "Matching is by span overlap; fields compared: amount/currency/period (prices), "
              "resolved_date (dates), owner/state/due_date (commitments). Owner text is compared "
              "ignoring case and spacing, nothing else."]
    return "\n".join(lines) + "\n"


# ---- command line ---------------------------------------------------------------------------

def _fail(msg):
    raise SystemExit(msg)


def main(argv, fixtures=FIXTURES):
    if len(argv) < 3 or argv[1] not in ("init", "import", "validate", "agreement"):
        raise SystemExit(__doc__)
    cmd, fixture_id = argv[1], argv[2]
    fixture_dir = os.path.join(fixtures, fixture_id)
    if not os.path.isdir(fixture_dir):
        _fail(f"no such fixture directory: {fixture_dir}")
    facts_path = os.path.join(fixture_dir, "facts.json")
    sheet_path = os.path.join(fixture_dir, "facts.sheet.txt")
    audio_ms = facts.audio_ms_of(fixture_dir)

    if cmd == "init":
        for p in (facts_path, sheet_path):
            if os.path.exists(p):
                _fail(f"{p} already exists; refusing to overwrite someone's labels. "
                      f"Move it aside first.")
        with open(facts_path, "w") as f:
            json.dump(facts.empty_facts(), f, indent=1)
        with open(sheet_path, "w") as f:
            f.write(render_sheet(fixture_id, facts.empty_facts(), audio_ms))
        print(f"wrote {facts_path}\nwrote {sheet_path}\n  label from the audio, delete the STATUS "
              f"line, then: python3 -m eval.corpus.facts_label import {fixture_id}")
    elif cmd == "import":
        if not os.path.exists(sheet_path):
            _fail(f"{sheet_path} not found; run init first")
        with open(sheet_path) as f:
            try:
                doc = parse_sheet(f.read(), audio_ms)
            except ValueError as exc:
                raise SystemExit(f"{sheet_path}\n{exc}") from None
        with open(facts_path, "w") as f:
            json.dump(doc, f, indent=1)
        print(f"wrote {facts_path}\n  " + ", ".join(f"{len(doc[c])} {c}" for c in facts.CLASSES))
    elif cmd == "validate":
        try:
            doc = facts.load(facts_path, audio_ms)
        except (ValueError, OSError) as exc:
            raise SystemExit(str(exc)) from None
        bound = "" if audio_ms is None else f" (spans checked against {audio_ms} ms of audio)"
        print(f"ok: {sum(len(doc[c]) for c in facts.CLASSES)} facts{bound}")
    else:
        if len(argv) < 5:
            _fail("usage: agreement <fixture-id> <labeller-a.json> <labeller-b.json>")
        try:
            a, b = facts.load(argv[3], audio_ms), facts.load(argv[4], audio_ms)
        except (ValueError, OSError) as exc:
            raise SystemExit(str(exc)) from None
        print(render_agreement(compare(a, b), os.path.basename(argv[3]), os.path.basename(argv[4])))


if __name__ == "__main__":
    main(sys.argv)
