"""Checking the judge against a human before believing anything it says.

Every MOM number rests on a model's opinion. Unverified, that is not a measurement — it is one
model's taste reported to three significant figures. So a sample of its verdicts gets
hand-labelled, and below THRESHOLD agreement the report is required to say the numbers are noise
rather than print a confident percentage.
"""
import random

THRESHOLD = 0.85


def sample_for_labelling(verdicts, n=20, seed=1):
    """A spread across categories AND both outcomes, deterministic for a given seed.

    Stratifying on the outcome matters more than it looks: sampling only the judge's YES verdicts
    would measure half the instrument, and the NOs are where a judge is most likely to be wrong
    and least likely to be questioned.
    """
    buckets = {}
    for v in verdicts:
        buckets.setdefault((v.get("category"), bool(v.get("matched"))), []).append(v)
    rng = random.Random(seed)
    for items in buckets.values():
        rng.shuffle(items)

    out, keys = [], sorted(buckets, key=lambda k: (str(k[0]), k[1]))
    while len(out) < n and any(buckets[k] for k in keys):
        for k in keys:                       # round-robin keeps the spread even
            if buckets[k] and len(out) < n:
                out.append(buckets[k].pop())
    return out


def agreement(sampled, labels):
    """`labels`: {item -> bool the human assigned}. Returns rate, verdict and the disagreements.

    An item with no label raises rather than being skipped: silently scoring 19 of 20 would
    report a rate that nobody chose, and the missing one is as likely as not the hard case that
    was left for later.
    """
    missing = [v["item"] for v in sampled if v["item"] not in labels]
    if missing:
        raise ValueError(f"{len(missing)} unlabelled item(s): {missing[:3]}")
    disagreements = [{"item": v["item"], "category": v.get("category"),
                      "judge": bool(v["matched"]), "human": bool(labels[v["item"]]),
                      "evidence": v.get("evidence", "")}
                     for v in sampled if bool(v["matched"]) != bool(labels[v["item"]])]
    total = len(sampled)
    agree = total - len(disagreements)
    rate = (agree / total) if total else None
    return {"agree": agree, "total": total, "rate": rate,
            "trustworthy": bool(rate is not None and rate >= THRESHOLD),
            "threshold": THRESHOLD, "disagreements": disagreements}
