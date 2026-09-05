"""The Edinburgh International Accents of English Corpus -> our fixture format.

EdAcc is CC BY-SA 4.0 (https://datashare.ed.ac.uk/handle/10283/8983). Everything corpus-specific
lives in this file, the same arrangement as ami.py: nothing downstream knows EdAcc exists.

**Why this corpus.** The only English benchmark here was AMI — British and European meeting speech
recorded in the 2000s on headset mics — and the launch is global. EdAcc is 40 hours of dyadic
conversations chosen for accent breadth, with a self-reported linguistic background per speaker,
which is the one thing that turns "our WER is 29.7%" into "our WER is 29.7% for whom".

It is conversational rather than read, which is why it is worth 5.5 GB when Common Voice is a
smaller download: this product transcribes people talking to each other, and read-sentence WER
does not predict that.

**What it does not cover:** no Australian and no Singaporean speakers, both named markets. Those
stay unmeasured until somebody records them.
"""
import csv
import os

# The read-aloud control passage every participant performs at the start. EdAcc marks it in the
# STM and excludes it from its own scoring, and so do we: it is a different speaking style from
# the conversation that follows, and mixing the two would produce a number describing neither.
IGNORE = "IGNORE_TIME_SEGMENT_IN_SCORING"


def parse_stm(stm_path):
    """{conversation_id: {"segments": [...], "scored_from_ms": int}} from an EdAcc STM.

    STM columns are `<recording> <channel> <speaker> <start_s> <end_s> <label> <text>`, where the
    label is `<gender,l1|l2>`. Turn-level, speaker-attributed, with real overlap between turns —
    which is what makes it usable as our truth.json directly.

    The STM is used rather than the `text` + `segments` + `utt2spk` trio because those carry the
    COARSE alignment: `segments` holds spans like 20.70-46.90 where the STM has the four turns
    inside it. Scoring attribution against 26-second blocks would measure the annotation, not the
    diarizer.

    Read-speech spans are dropped from the reference AND excluded by `scored_from_ms` rather than
    only the first, because the audio is still there and the recogniser will still transcribe it.
    A reference that simply omitted those words would count every one of them as an insertion and
    read as a catastrophic regression — the failure `scored_from_ms` exists to prevent. It works as
    one range because the passage is always at the start: measured across the 31 test
    conversations that contain it, the last such span ends 11.4% into the conversation at worst,
    and under 8% in all but four.
    """
    convs = {}
    with open(stm_path, "r", encoding="utf-8") as f:
        for line in f:
            if line.startswith(";;") or not line.strip():
                continue
            parts = line.split(None, 6)
            if len(parts) < 7:
                continue
            conv, _channel, speaker, start_s, end_s, _label, text = parts
            text = text.strip()
            entry = convs.setdefault(conv, {"segments": [], "scored_from_ms": 0})
            start_ms = int(round(float(start_s) * 1000))
            end_ms = int(round(float(end_s) * 1000))
            if text == IGNORE:
                entry["scored_from_ms"] = max(entry["scored_from_ms"], end_ms)
                continue
            if not text:
                continue
            entry["segments"].append(
                {"start_ms": start_ms, "end_ms": end_ms, "speaker": speaker, "text": text})

    for entry in convs.values():
        entry["segments"].sort(key=lambda s: s["start_ms"])
        # A turn that starts inside the control passage would be half-scored against a hypothesis
        # clipped at the same boundary. Drop it: `_within` in run.py assigns by midpoint, so this
        # keeps both sides looking at the same set.
        cut = entry["scored_from_ms"]
        entry["segments"] = [s for s in entry["segments"]
                             if (s["start_ms"] + s["end_ms"]) / 2 >= cut]
    return convs


def conversations(split_dir):
    """The conversation ids listed for a split, in file order."""
    with open(os.path.join(split_dir, "conv.list"), "r", encoding="utf-8") as f:
        return [line.strip() for line in f if line.strip()]


def read_linguistic_background(csv_path):
    """{speaker_id: {field: value}} from linguistic_background.csv.

    Self-reported, which is the point — an accent label assigned by a third party is a guess about
    somebody's identity. EdAcc's own README warns that the derived l1/l2 labels are not entirely
    reliable, so treat these as the speaker's description of themselves and report them verbatim
    rather than bucketing them into tidier categories here.
    """
    out = {}
    with open(csv_path, "r", encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            key = next((row[k] for k in row
                        if k and k.strip().upper() in ("PARTICIPANT_ID", "SPEAKER", "SPEAKER_ID")
                        and row[k]), None)
            if key:
                out[key.strip()] = {k.strip(): (v or "").strip() for k, v in row.items() if k}
    return out


def accents_for(conversation, segments, background):
    """The accents heard in one conversation: {speaker_id: accent-ish description}.

    Falls back to the speaker id when the background file has no row for them, so a fixture is
    still buildable and the gap is visible in meta.json instead of crashing the build.
    """
    out = {}
    for speaker in sorted({s["speaker"] for s in segments}):
        row = background.get(speaker, {})
        out[speaker] = _accent_of(row) or "unknown (no linguistic_background row)"
    return out


# Matched on a prefix rather than the whole string: the real column is
# "How would you describe your accent in English? (e.g. Italian, Glaswegian)", and pinning the
# parenthetical means a corpus revision that reworded the example silently returns "unknown" for
# every speaker instead of failing.
_ACCENT_PREFIX = "how would you describe your accent"


def _accent_of(row):
    for key, value in row.items():
        if key and key.strip().lower().startswith(_ACCENT_PREFIX) and value:
            return value
    return ""
