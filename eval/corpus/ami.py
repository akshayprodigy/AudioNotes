"""AMI Meeting Corpus -> our fixture format.

AMI is CC BY 4.0 (https://groups.inf.ed.ac.uk/ami/corpus/license.shtml). Everything corpus-specific
lives in this file: nothing downstream knows AMI exists, which is what lets the user's own
recordings become a benchmark by writing the fixture files directly.

Caveat recorded into every fixture's meta.json and repeated in reports: AMI is 2000s meeting-room
audio, headset/far-field mics, mostly British/European accents, scenario-driven, no code-switching.
Good for detecting whether a change helped. Not evidence the product works for a phone on a table.
"""
import os
import re
import xml.etree.ElementTree as ET

NITE = "{http://nite.sourceforge.net/}"
_HREF_IDS = re.compile(r"id\(([^)]+)\)")

ANNOTATION_URL = "https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip"
AUDIO_URL = ("https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/"
             "{meeting}/audio/{meeting}.Mix-Headset.wav")


def _read(path):
    # The corpus ships ISO-8859-1; parsing it as UTF-8 raises on the first accented name.
    with open(path, "r", encoding="iso-8859-1") as f:
        return ET.fromstring(f.read())


def parse_words(data_dir, meeting, speaker):
    """Ordered [(word_id, text)] for one speaker, punctuation tokens excluded."""
    root = _read(os.path.join(data_dir, f"{meeting}.{speaker}.words.xml"))
    words = []
    for w in root.iter():
        if not (w.tag.endswith("}w") or w.tag == "w"):
            continue
        if w.get("punc") == "true":
            continue
        text = (w.text or "").strip()
        if text:
            words.append((w.get(f"{NITE}id"), text))
    return words


def parse_segments(data_dir, meeting, speaker):
    """Speaker-labelled segments with ms timings, in file order."""
    words = parse_words(data_dir, meeting, speaker)
    index = {wid: i for i, (wid, _) in enumerate(words)}

    root = _read(os.path.join(data_dir, f"{meeting}.{speaker}.segments.xml"))
    segments = []
    for seg in root.iter():
        if not (seg.tag.endswith("}segment") or seg.tag == "segment"):
            continue
        start = seg.get("transcriber_start")
        end = seg.get("transcriber_end")
        if start is None or end is None:
            continue

        ids = []
        for child in seg:
            ids.extend(_HREF_IDS.findall(child.get("href", "")))
        if not ids:
            continue
        # "#id(a)..id(b)" spans a range; "#id(a)" is a single word. Treating the second form as a
        # range of one is what keeps single-word segments from vanishing.
        first, last = ids[0], ids[-1]
        if first not in index or last not in index:
            continue
        text = " ".join(t for _, t in words[index[first]:index[last] + 1])
        if not text:
            continue
        segments.append({
            "start_ms": int(round(float(start) * 1000)),
            "end_ms": int(round(float(end) * 1000)),
            "speaker": speaker,
            "text": text,
        })
    return segments


def _sentences(root, tag):
    for node in root.iter():
        if node.tag.endswith("}" + tag) or node.tag == tag:
            out = []
            for s in node.iter():
                if s.tag.endswith("}sentence") or s.tag == "sentence":
                    text = " ".join((s.text or "").split())
                    if text:
                        out.append(text)
            return out
    return []


def parse_abstractive(data_dir, meeting):
    """AMI's abstractive summary -> our minutes shape.

    DECISIONS -> decisions, ACTIONS -> actions, PROBLEMS/ISSUES -> questions. The ABSTRACT section
    is prose about the meeting, not a decision, so it is deliberately not mapped: folding it in
    would inflate reference decision counts and depress recall for no reason.

    AMI does not annotate owner or due date, so both are empty and scoring treats an empty
    reference field as "not required" rather than as a miss.
    """
    root = _read(os.path.join(data_dir, f"{meeting}.abssumm.xml"))
    return {
        "decisions": _sentences(root, "decisions"),
        "actions": [{"text": t, "owner": "", "due": ""} for t in _sentences(root, "actions")],
        "questions": _sentences(root, "problems"),
    }


def speakers_for(data_dir, meeting):
    """Speaker letters that actually have segment files for this meeting."""
    found = []
    for name in sorted(os.listdir(data_dir)):
        m = re.fullmatch(rf"{re.escape(meeting)}\.([A-Z])\.segments\.xml", name)
        if m:
            found.append(m.group(1))
    return found
