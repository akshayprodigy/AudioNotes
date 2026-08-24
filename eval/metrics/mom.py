"""Minutes quality: did we catch what was decided, and did we invent anything.

Lexical scoring is ruled out by the shapes involved. AMI's reference decisions are abstractive
one-liners ("the casing will be made of rubber"); our minutes are extractive transcript sentences
("so I think we should go with rubber for the case then"). Same decision, almost no shared
tokens — overlap scoring would report a correct MOM as a total failure. So a model judges
semantic capture, and everything here is the arithmetic around its verdicts.

The judge is the weakest link, which drives two rules:
  * every verdict is retained, so any score can be read back and argued with;
  * a category the reference never mentions scores None, not 0.0 — an absence in the reference
    is not a failure of the product, and 0% reads like one.
"""
import re
from dataclasses import dataclass, field

CATEGORIES = ("decisions", "actions", "questions")

# "<sentence> — <owner> (due <due>)" is what minutes_extractor composes. The separator is the
# LAST " — " because the sentence may well contain one of its own.
_DUE = re.compile(r"\s*\(due\s+(.+?)\)\s*$")


@dataclass
class Verdict:
    matched: bool
    evidence: str = ""
    note: str = ""


@dataclass
class _Tally:
    captured: int = 0
    total: int = 0
    verdicts: list = field(default_factory=list)


def parse_action(content):
    """`"Ship it. — Bo (due Monday)"` -> `("Ship it.", "Bo", "Monday")`."""
    text, owner, due = content, "", ""
    m = _DUE.search(text)
    if m:
        due = m.group(1).strip()
        text = text[: m.start()]
    sep = text.rfind(" — ")
    if sep != -1:
        owner = text[sep + 3:].strip()
        text = text[:sep]
    return text.strip(), owner, due


def from_document(doc):
    """The CLI's flat minutes list -> the reference minutes shape. `summary` is prose about the
    meeting rather than an item in it, so it is not scored."""
    out = {"decisions": [], "actions": [], "questions": []}
    for m in doc.get("minutes", []):
        kind, content = m.get("kind"), m.get("content", "")
        if kind == "action":
            text, owner, due = parse_action(content)
            out["actions"].append({"text": text, "owner": owner, "due": due})
        elif kind == "decision":
            out["decisions"].append(content)
        elif kind == "question":
            out["questions"].append(content)
    return out


def _text(item):
    return item["text"] if isinstance(item, dict) else item


def _norm(s):
    return " ".join((s or "").strip().lower().split())


def score_minutes(reference, doc, judge, transcript=""):
    """Recall of reference items, support for produced items, and owner/due on matched actions.

    `transcript` is the ground-truth text. Without it there is nothing to check produced items
    against, so precision is left None rather than assumed perfect — the failure mode this
    guards is a minutes writer that invents plausible items and scores well on recall alone.
    """
    produced = from_document(doc)
    recall, verdicts = {}, []
    owner = {"correct": 0, "checked": 0}
    due = {"correct": 0, "checked": 0}

    for category in CATEGORIES:
        items = reference.get(category) or []
        tally = _Tally(total=len(items))
        for item in items:
            v = judge.captures(_text(item), category, produced)
            tally.captured += 1 if v.matched else 0
            verdicts.append({"kind": "recall", "category": category, "item": _text(item),
                             "matched": v.matched, "evidence": v.evidence, "note": v.note})
            if v.matched and category == "actions" and isinstance(item, dict):
                _, got_owner, got_due = parse_action(v.evidence)
                if item.get("owner"):
                    owner["checked"] += 1
                    owner["correct"] += _norm(got_owner) == _norm(item["owner"])
                if item.get("due"):
                    due["checked"] += 1
                    due["correct"] += _norm(got_due) == _norm(item["due"])
        recall[category] = (tally.captured / tally.total) if tally.total else None

    captured_total = sum(1 for v in verdicts if v["kind"] == "recall" and v["matched"])
    ref_total = sum(len(reference.get(c) or []) for c in CATEGORIES)
    recall["overall"] = (captured_total / ref_total) if ref_total else None

    precision = {c: None for c in CATEGORIES}
    hallucinated = {}
    if transcript:
        for category in CATEGORIES:
            items = produced[category]
            if not items:
                continue
            bad = 0
            for item in items:
                v = judge.supported(_text(item), category, transcript)
                bad += 0 if v.matched else 1
                verdicts.append({"kind": "support", "category": category, "item": _text(item),
                                 "matched": v.matched, "evidence": v.evidence, "note": v.note})
            precision[category] = (len(items) - bad) / len(items)
            hallucinated[category] = bad

    return {
        "recall": recall,
        "precision": precision,
        "hallucinated": hallucinated,
        "owner": owner,
        "due": due,
        "produced_counts": {c: len(produced[c]) for c in CATEGORIES},
        "reference_counts": {c: len(reference.get(c) or []) for c in CATEGORIES},
        "verdicts": verdicts,
    }
