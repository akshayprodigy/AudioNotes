"""Turn one EdAcc conversation into a fixture.

    python3 -m eval.corpus.build_edacc EDACC-C08
    python3 -m eval.corpus.build_edacc --list        # what is available, and whose accents

The 5.5 GB release is downloaded once into eval/corpus/_cache/edacc (gitignored) and unpacked
there. Edinburgh DataShare serves it at roughly 0.3 MB/s, so budget hours, not minutes, the first
time — and note that the archive stores the split metadata BEFORE the audio, so `--list` works
against a partial download.

Fixture ids are prefixed `edacc-` so they sort apart from the AMI ones and so a report can tell at
a glance which corpus a number came from.
"""
import json
import os
import subprocess
import sys
import tarfile
import urllib.request

from eval.corpus import edacc

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CACHE = os.path.join(ROOT, "eval", "corpus", "_cache", "edacc")
FIXTURES = os.path.join(ROOT, "eval", "fixtures")
ARCHIVE_URL = "https://datashare.ed.ac.uk/bitstreams/819f726e-1a65-4b3c-88d2-efdf0a7021ce/download"
ARCHIVE = os.path.join(CACHE, "edacc_v1.0.tar.gz")
ROOT_DIR = os.path.join(CACHE, "edacc_v1.0")

CAVEAT = ("Edinburgh International Accents of English Corpus (CC BY-SA 4.0). Dyadic conversations "
          "over video call, chosen for accent breadth, with self-reported linguistic background "
          "per speaker. Two-person and remote, so it is NOT a room full of people around one "
          "phone — but unlike AMI it says whose accents the number describes. No Australian or "
          "Singaporean speakers.")


def ensure_archive():
    if not (os.path.exists(ARCHIVE) and os.path.getsize(ARCHIVE) > 0):
        os.makedirs(CACHE, exist_ok=True)
        print(f"fetch   {ARCHIVE_URL}  (5.5 GB, slow)")
        urllib.request.urlretrieve(ARCHIVE_URL, ARCHIVE)
    return ARCHIVE


def ensure_unpacked(skip_audio=False, want=None):
    """Unpack the archive; optionally only the parts needed.

    Extracting selectively is what makes `--list` usable while the download is still running: the
    metadata lives at the FRONT of the stream, so the split directories are readable long before
    the 5.4 GB of audio behind them has arrived. `skip_audio` also keeps `--list` from writing a
    second copy of however many gigabytes have landed so far.

    `want` is a set of conversation ids whose audio is needed; everything else under data/ is
    skipped, because a fixture build has no use for the other 39 recordings.
    """
    ensure_archive()
    os.makedirs(ROOT_DIR, exist_ok=True)
    audio_dir = "edacc_v1.0/data/"
    with tarfile.open(ARCHIVE, "r|gz") as tar:
        try:
            for member in tar:
                name = member.name
                if name.startswith(audio_dir):
                    if skip_audio:
                        continue
                    if want is not None:
                        leaf = os.path.basename(name)
                        if leaf and leaf[:-4] not in want:
                            continue
                target = os.path.join(CACHE, name)
                if os.path.exists(target) and member.isfile() and \
                        os.path.getsize(target) == member.size:
                    continue
                tar.extract(member, CACHE, filter="data")
        except (EOFError, tarfile.ReadError, OSError):
            # A partial download ends mid-stream. Everything already written is intact and usable;
            # this is the expected path for `--list` against an in-flight fetch.
            pass


def _splits():
    return [d for d in ("dev", "test") if os.path.isdir(os.path.join(ROOT_DIR, d))]


def _stm_index():
    """{conversation: (split, parsed_stm_entry)} across whichever splits are unpacked."""
    index = {}
    for split in _splits():
        parsed = edacc.parse_stm(os.path.join(ROOT_DIR, split, "stm"))
        for conv, entry in parsed.items():
            index[conv] = (split, entry)
    return index


def _background():
    path = os.path.join(ROOT_DIR, "linguistic_background.csv")
    return edacc.read_linguistic_background(path) if os.path.exists(path) else {}


def _write(path, obj):
    with open(path, "w") as f:
        json.dump(obj, f, indent=1, ensure_ascii=False)
        f.write("\n")


def list_conversations():
    ensure_unpacked(skip_audio=True)
    index = _stm_index()
    if not index:
        raise SystemExit("no split metadata unpacked yet — is the download still starting?")
    background = _background()
    if not background:
        print("(linguistic_background.csv not unpacked yet — accents will show as unknown)\n")
    rows = []
    for conv, (split, entry) in sorted(index.items()):
        segs = entry["segments"]
        if not segs:
            continue
        accents = edacc.accents_for(conv, segs, background)
        secs = max(s["end_ms"] for s in segs) / 1000
        words = sum(len(s["text"].split()) for s in segs)
        rows.append((conv, split, secs, len(segs), words, accents))
    print(f"{'conversation':<22} {'split':<5} {'audio':>7} {'turns':>6} {'words':>7}  accents")
    for conv, split, secs, nseg, words, accents in rows:
        print(f"{conv:<22} {split:<5} {secs:7.0f}s {nseg:6d} {words:7d}  "
              f"{'; '.join(sorted(set(accents.values())))}")
    print(f"\n{len(rows)} conversations")


def build(conversation):
    ensure_unpacked(want={conversation})
    index = _stm_index()
    if conversation not in index:
        raise SystemExit(f"unknown conversation {conversation!r} — try --list")
    split, entry = index[conversation]
    segments = entry["segments"]
    if not segments:
        raise SystemExit(f"no scorable segments for {conversation}")

    raw_audio = os.path.join(ROOT_DIR, "data", f"{conversation}.wav")
    if not os.path.exists(raw_audio):
        raise SystemExit(f"{raw_audio} not unpacked yet — the audio is at the end of the archive")

    fixture_id = f"edacc-{conversation.replace('EDACC-', '')}"
    out_dir = os.path.join(FIXTURES, fixture_id)
    os.makedirs(out_dir, exist_ok=True)

    audio_path = os.path.join(out_dir, "audio.wav")
    subprocess.run(
        ["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", raw_audio, audio_path],
        check=True)
    # A stale .pcm from a previous build would be read in preference to the wav we just wrote.
    stale = audio_path + ".pcm"
    if os.path.exists(stale):
        os.remove(stale)

    audio_ms = int(os.path.getsize(audio_path) / 32)  # 16 kHz * 2 bytes = 32 bytes per ms
    accents = edacc.accents_for(conversation, segments, _background())
    truth = {"audio_ms": audio_ms, "segments": segments}
    if entry["scored_from_ms"]:
        truth["scored_from_ms"] = entry["scored_from_ms"]
    _write(os.path.join(out_dir, "truth.json"), truth)
    _write(os.path.join(out_dir, "meta.json"),
           {"source": "edacc", "conversation": conversation, "split": split,
            "speakers": sorted(accents), "accents": accents,
            "licence": "CC BY-SA 4.0", "notes": CAVEAT})

    words = sum(len(s["text"].split()) for s in segments)
    skipped = entry["scored_from_ms"] / 1000
    print(f"\n{fixture_id}: {len(segments)} turns, {len(accents)} speakers, {words} words, "
          f"{audio_ms / 1000:.0f}s audio (first {skipped:.0f}s excluded: read passage)")
    for spk, accent in sorted(accents.items()):
        print(f"  {spk}: {accent}")
    print(f"-> {out_dir}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        raise SystemExit(__doc__)
    if args[0] == "--list":
        list_conversations()
    else:
        for conv in args:
            build(conv)
