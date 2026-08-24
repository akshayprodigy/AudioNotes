"""Download one AMI meeting and write it out as a fixture.

    python3 -m eval.corpus.build_fixture ES2002a

Downloads are cached under eval/corpus/_cache (gitignored) so re-running is cheap. Audio is
converted to the 16 kHz mono PCM16 the CLI requires; AMI Mix-Headset is 16 kHz already, but the
conversion is unconditional so a corpus that is not gets handled the same way.
"""
import json
import os
import subprocess
import sys
import urllib.request
import zipfile

from eval.corpus import ami

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CACHE = os.path.join(ROOT, "eval", "corpus", "_cache")
FIXTURES = os.path.join(ROOT, "eval", "fixtures")

CAVEAT = ("AMI Meeting Corpus (CC BY 4.0). 2000s meeting-room audio, headset/far-field mics, "
          "mostly British/European accents, scenario-driven, no code-switching. A proxy for "
          "detecting regressions, NOT evidence the product works for in-person phone capture.")


def _download(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        print(f"cached  {os.path.basename(dest)}")
        return dest
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    print(f"fetch   {url}")
    urllib.request.urlretrieve(url, dest)
    return dest


def ensure_annotations():
    """Fetch and unpack the (21.8 MB) annotation bundle covering all 142 meetings."""
    zip_path = _download(ami.ANNOTATION_URL, os.path.join(CACHE, "ami_annotations.zip"))
    out = os.path.join(CACHE, "annotations")
    if not os.path.isdir(os.path.join(out, "words")):
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(out)
    return out


def _flatten(annotations_dir, meeting):
    """Copy the meeting's XML into one flat directory, which is what the adapter expects."""
    flat = os.path.join(CACHE, "flat", meeting)
    os.makedirs(flat, exist_ok=True)
    for sub in ("words", "segments"):
        src_dir = os.path.join(annotations_dir, sub)
        for name in os.listdir(src_dir):
            if name.startswith(meeting + "."):
                dst = os.path.join(flat, name)
                if not os.path.exists(dst):
                    with open(os.path.join(src_dir, name), "rb") as s, open(dst, "wb") as d:
                        d.write(s.read())
    abs_src = os.path.join(annotations_dir, "abstractive", f"{meeting}.abssumm.xml")
    abs_dst = os.path.join(flat, f"{meeting}.abssumm.xml")
    if os.path.exists(abs_src) and not os.path.exists(abs_dst):
        with open(abs_src, "rb") as s, open(abs_dst, "wb") as d:
            d.write(s.read())
    return flat


def _write(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=1, ensure_ascii=False)
        f.write("\n")


def build(meeting):
    annotations = ensure_annotations()
    flat = _flatten(annotations, meeting)

    speakers = ami.speakers_for(flat, meeting)
    if not speakers:
        raise SystemExit(f"no speaker segment files for {meeting}")

    segments = []
    for spk in speakers:
        segments.extend(ami.parse_segments(flat, meeting, spk))
    segments.sort(key=lambda s: s["start_ms"])
    if not segments:
        raise SystemExit(f"no segments parsed for {meeting}")

    out_dir = os.path.join(FIXTURES, meeting)
    os.makedirs(out_dir, exist_ok=True)

    raw_audio = _download(ami.AUDIO_URL.format(meeting=meeting),
                          os.path.join(CACHE, "audio", f"{meeting}.Mix-Headset.wav"))
    audio_path = os.path.join(out_dir, "audio.wav")
    subprocess.run(
        ["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", raw_audio, audio_path],
        check=True)

    audio_ms = int(os.path.getsize(audio_path) / 32)  # 16 kHz * 2 bytes = 32 bytes per ms
    _write(os.path.join(out_dir, "truth.json"), {"audio_ms": audio_ms, "segments": segments})
    _write(os.path.join(out_dir, "minutes.json"), ami.parse_abstractive(flat, meeting))
    _write(os.path.join(out_dir, "meta.json"),
           {"source": "ami", "meeting": meeting, "speakers": speakers,
            "licence": "CC BY 4.0", "notes": CAVEAT})

    words = sum(len(s["text"].split()) for s in segments)
    print(f"\n{meeting}: {len(segments)} segments, {len(speakers)} speakers, {words} words, "
          f"{audio_ms / 1000:.0f}s audio -> {out_dir}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("usage: python3 -m eval.corpus.build_fixture <MEETING-ID>  e.g. ES2002a")
    build(sys.argv[1])
