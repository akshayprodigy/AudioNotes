"""Per-utterance speaker attribution — the user-visible half of diarization quality.

DER is the research metric; this is the one a user feels. It answers "of the lines we put in the
transcript, how many carry the right name?", and it can move independently of DER: a diarization
that gets the long turns right but flips every short interjection scores well on time-weighted DER
and badly here.

The roadmap also asks for "% of action items with the correct speaker". That needs a fixture whose
reference minutes carry owners, and AMI does not annotate them (our adapter leaves owner empty), so
it is not scoreable on AMI and waits for the user's own recordings. Utterance-level attribution is
scoreable today and measures the same underlying failure.
"""


from eval.metrics.der import is_unassigned


def _dominant_reference_speaker(reference, start_ms, end_ms):
    """The reference speaker holding the most of [start, end), or None if it is all silence."""
    best, best_overlap = None, 0
    for seg in reference:
        overlap = min(end_ms, seg["end_ms"]) - max(start_ms, seg["start_ms"])
        if overlap > best_overlap:
            best, best_overlap = seg["speaker"], overlap
    return best


def utterance_attribution(reference, utterances, mapping):
    """`mapping` is cluster -> reference speaker, from der(). Returns correct/scored/accuracy.

    Excluded from scoring: utterances with no speaker assigned (cluster < 0 — diarization was
    skipped or produced nothing, which is a coverage problem rather than a wrong label) and
    utterances sitting over reference silence (nothing to be right or wrong about).
    """
    correct = scored = unassigned = 0
    for utt in utterances:
        cluster = utt.get("speaker", -1)
        if is_unassigned(cluster):
            unassigned += 1
            continue
        truth = _dominant_reference_speaker(reference, utt["start_ms"], utt["end_ms"])
        if truth is None:
            continue
        scored += 1
        if mapping.get(cluster) == truth:
            correct += 1

    return {
        "correct": correct,
        "scored": scored,
        "unassigned": unassigned,
        "accuracy": (correct / scored) if scored else None,
    }
