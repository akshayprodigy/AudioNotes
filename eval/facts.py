"""The reference file for factual accuracy: `facts.json`, hand-labelled from the AUDIO.

Section 3.3 of docs/superpowers/reports/2026-10-07-phase-0-baseline.md fixes the content. This
module only says what a well-formed file looks like and lists, in words a labeller can act on,
everything that is wrong with one that is not. It never edits a file and it never scores.

    {"prices":      [{id, span_ms:[start,end], spoken, amount, currency, period}],
     "dates":       [{id, span_ms, spoken, resolved_date|null, relative_to}],
     "commitments": [{id, span_ms, text, owner|null, due_spoken|null, due_date|null, state}],
     "decisions":   [{id, span_ms, text}],
     "owners_note": "free text where an owner is ambiguous"}

Ids are unique across the whole file, not just within a class, because a matches.json row names
a reference fact by id alone.
"""
import json
import os
import re
from dataclasses import dataclass

PRICES, DATES, COMMITMENTS, DECISIONS = "prices", "dates", "commitments", "decisions"
CLASSES = (PRICES, DATES, COMMITMENTS, DECISIONS)

PROMISED, COMPLETED, CONDITIONAL, WITHDRAWN = "promised", "completed", "conditional", "withdrawn"
STATES = (PROMISED, COMPLETED, CONDITIONAL, WITHDRAWN)

# field -> kind. "str" non-empty string; "text" any string (may be empty); "num" a number;
# "date?" an ISO date or null; "str?" a string or null.
FIELDS = {
    PRICES: {"spoken": "str", "amount": "num", "currency": "str", "period": "str"},
    DATES: {"spoken": "str", "resolved_date": "date?", "relative_to": "str?"},
    COMMITMENTS: {"text": "str", "owner": "str?", "due_spoken": "str?", "due_date": "date?",
                  "state": "state"},
    DECISIONS: {"text": "str"},
}
TOP_LEVEL = set(CLASSES) | {"owners_note"}
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@dataclass
class Issue:
    cls: str          # class name, or "" for a file-level problem
    item_id: str      # "" when the item has no usable id
    message: str

    def __str__(self):
        where = f"{self.cls}[{self.item_id}]" if self.item_id else (self.cls or "file")
        return f"{where}: {self.message}"


def empty_facts():
    d = {c: [] for c in CLASSES}
    d["owners_note"] = ""
    return d


def _is_int(x):
    return isinstance(x, int) and not isinstance(x, bool)


def _is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def check(doc, audio_ms=None):
    """-> list of Issue. `audio_ms` (from truth.json, when there is one) bounds every span."""
    issues = []
    if not isinstance(doc, dict):
        return [Issue("", "", "facts.json must be a JSON object")]
    for key in doc:
        if key not in TOP_LEVEL:
            issues.append(Issue("", "", f"unknown top-level key {key!r}"))
    if "owners_note" in doc and not isinstance(doc["owners_note"], str):
        issues.append(Issue("", "", "owners_note must be a string"))

    seen = {}
    for cls in CLASSES:
        items = doc.get(cls, [])
        if not isinstance(items, list):
            issues.append(Issue(cls, "", f"{cls!r} must be a list"))
            continue
        for item in items:
            if not isinstance(item, dict):
                issues.append(Issue(cls, "", "every entry must be an object"))
                continue
            iid = item.get("id")
            ok_id = isinstance(iid, str) and iid.strip() != ""
            if not ok_id:
                issues.append(Issue(cls, "", "needs a non-empty string id"))
                iid = ""
            elif iid in seen:
                issues.append(Issue(cls, iid, f"duplicate id {iid!r} (also in {seen[iid]})"))
            else:
                seen[iid] = cls
            _check_span(issues, cls, iid, item, audio_ms)
            _check_fields(issues, cls, iid, item)
    return issues


def _check_span(issues, cls, iid, item, audio_ms):
    span = item.get("span_ms")
    if not (isinstance(span, list) and len(span) == 2 and all(_is_int(v) for v in span)):
        issues.append(Issue(cls, iid, "span_ms must be [start, end] in whole milliseconds"))
        return
    start, end = span
    if start < 0:
        issues.append(Issue(cls, iid, f"span starts before the audio does ({start})"))
    if end < start:
        issues.append(Issue(cls, iid, f"span ends ({end}) before it starts ({start})"))
    elif audio_ms is not None and (end > audio_ms):
        issues.append(Issue(cls, iid, f"span {start}-{end} is outside the audio "
                                      f"(0-{audio_ms} ms)"))


def _check_fields(issues, cls, iid, item):
    for name, kind in FIELDS[cls].items():
        if name not in item:
            issues.append(Issue(cls, iid, f"missing field {name!r}"))
            continue
        v = item[name]
        if kind == "str" and not (isinstance(v, str) and v.strip()):
            issues.append(Issue(cls, iid, f"{name} must be a non-empty string"))
        elif kind == "str?" and v is not None and not isinstance(v, str):
            issues.append(Issue(cls, iid, f"{name} must be a string or null"))
        elif kind == "num" and not _is_num(v):
            issues.append(Issue(cls, iid, f"{name} must be a number"))
        elif kind == "date?" and v is not None and not (isinstance(v, str)
                                                         and _ISO_DATE.match(v)):
            issues.append(Issue(cls, iid, f"{name} must be YYYY-MM-DD or null"))
        elif kind == "state" and v not in STATES:
            issues.append(Issue(cls, iid, f"unknown state {v!r} (one of {', '.join(STATES)})"))
    for name in item:
        if name not in FIELDS[cls] and name not in ("id", "span_ms"):
            issues.append(Issue(cls, iid, f"unknown field {name!r}"))


def validate(doc, audio_ms=None):
    """-> list of human-readable problems; empty means well-formed."""
    return [str(i) for i in check(doc, audio_ms)]


def audio_ms_of(fixture_dir):
    """The fixture's audio length from truth.json, or None when there is no truth.json."""
    path = os.path.join(fixture_dir, "truth.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f).get("audio_ms")


def load(path, audio_ms=None):
    """Read and validate; raises ValueError listing every problem."""
    with open(path) as f:
        try:
            doc = json.load(f)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}: not valid JSON ({exc})") from None
    problems = validate(doc, audio_ms)
    if problems:
        raise ValueError(f"{path}: {len(problems)} problem(s)\n  " + "\n  ".join(problems))
    return doc


def all_items(doc):
    """-> [(cls, item)] in class order."""
    return [(c, it) for c in CLASSES for it in doc.get(c, [])]
