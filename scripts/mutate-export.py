#!/usr/bin/env python3
"""Break the Pro-export rules on purpose, one at a time, and fail if the tests do not notice.

Every file that leaves the app is Pro (ExportGate), and an MP3 can only be made from audio that is
still there (Mp3Export). Both rules fail SILENTLY: a Free person is handed a file, or a person is
handed an empty one. So each rule gets a mutant and each mutant must be killed by a named test.

Each entry names the file it breaks and the test class that must then fail. A SURVIVED line is a
rule nothing pins. PATCH DID NOT APPLY means the source moved under the patch: re-point it, do not
delete it (see mutate-reconciler.py, which this follows).

    python3 scripts/mutate-export.py             # all of them
    python3 scripts/mutate-export.py "mp3"       # only entries whose name matches
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ANDROID = os.path.join(ROOT, "android")
PIPE = os.path.join(ANDROID, "app", "src", "main", "java", "com", "innocorelabs", "verbale", "pipeline")
RESULTS = os.path.join(ANDROID, "app", "build", "test-results", "testDebugUnitTest")

GATE = "ExportGate.kt"
MP3 = "Mp3Export.kt"
MODULE = "FileExportModule.kt"

# (name, file, test class, find, replace). `find` must appear EXACTLY once in the file.
MUTATIONS = [
    ("gate removed: Free is never refused", GATE, "ExportGateTest",
     "    if (paid) return null\n    if (op in FILE_OPS) return PRO_REQUIRED\n    return null",
     "    return null"),
    ("gate inverted: Pro is refused, Free is allowed", GATE, "ExportGateTest",
     "    if (paid) return null\n    if (op in FILE_OPS) return PRO_REQUIRED",
     "    if (!paid) return null\n    if (op in FILE_OPS) return PRO_REQUIRED"),
    ("format skipped: mp3 is free", GATE, "ExportGateTest",
     "    if (paid) return null\n",
     "    if (paid || format == \"mp3\") return null\n"),
    ("format skipped: srt is free", GATE, "ExportGateTest",
     "    if (paid) return null\n",
     "    if (paid || format == \"srt\") return null\n"),
    ("format skipped: pdf is free", GATE, "ExportGateTest",
     "    if (paid) return null\n",
     "    if (paid || format == \"pdf\") return null\n"),
    ("format skipped: md is free", GATE, "ExportGateTest",
     "    if (paid) return null\n",
     "    if (paid || format == \"md\") return null\n"),
    ("format skipped: txt is free", GATE, "ExportGateTest",
     "    if (paid) return null\n",
     "    if (paid || format == \"txt\") return null\n"),
    ("shareWith is not gated", GATE, "ExportGateTest",
     'private val FILE_OPS = setOf("share", "shareWith", "exportMp3")',
     'private val FILE_OPS = setOf("share", "exportMp3")'),
    ("exportMp3 is not gated", GATE, "ExportGateTest",
     'private val FILE_OPS = setOf("share", "shareWith", "exportMp3")',
     'private val FILE_OPS = setOf("share", "shareWith")'),
    ("render is gated (Copy would break for Free)", GATE, "ExportGateTest",
     'private val FILE_OPS = setOf("share", "shareWith", "exportMp3")',
     'private val FILE_OPS = setOf("share", "shareWith", "exportMp3", "render", "copy", "preview")'),
    ("the module never asks the gate", MODULE, "ExportGateTest",
     '    if (refuseFree("shareWith", format, promise)) return\n',
     ''),
    ("the module asks with paid hard-wired", MODULE, "ExportGateTest",
     "ExportGate.refusal(op, format, LicenceStore.current(ctx).isPaid)",
     "ExportGate.refusal(op, format, true)"),
    # ---- Mp3Export: the audio-deleted path and the loop ----
    ("deleted-audio check removed: retained flag ignored", MP3, "Mp3ExportTest",
     "    if (!retained) return AudioState.DELETED\n", ""),
    ("deleted-audio check removed: an empty file counts as audio", MP3, "Mp3ExportTest",
     "file == null || file.length() == 0L", "file == null"),
    ("deleted-audio check removed: a missing path counts as audio", MP3, "Mp3ExportTest",
     "    if (file == null || file.length() == 0L) return AudioState.DELETED\n", ""),
    ("the deleted message is changed", MP3, "Mp3ExportTest",
     "was deleted, so there is nothing to export.", "is unavailable."),
    ("the module skips the audio check", MODULE, "Mp3ExportTest",
     "Mp3Export.audioState(retained, src) == Mp3Export.AudioState.DELETED", "false"),
    ("the module rejects the deleted audio with a bare error", MODULE, "Mp3ExportTest",
     "promise.reject(Mp3Export.AUDIO_DELETED, Mp3Export.DELETED_MESSAGE)", 'promise.reject("export_failed", "failed")'),
    ("exportMp3 starts work before asking the gate", MODULE, "ExportGateTest",
     '    if (refuseFree("exportMp3", "mp3", promise)) return\n    if (!mp3Busy',
     '    if (!mp3Busy'),
    ("cancel is ignored", MP3, "Mp3ExportTest",
     "      if (cancelled()) return Outcome.CANCELLED\n", ""),
    ("whole file read at once (chunk grows to 64 MiB)", MP3, "Mp3ExportTest",
     "const val CHUNK_BYTES = 64 * 1024", "const val CHUNK_BYTES = 64 * 1024 * 1024"),
    ("an odd trailing byte is encoded as a sample", MP3, "Mp3ExportTest",
     "val n = got / 2 //", "val n = (got + 1) / 2 //"),
    ("samples read big-endian", MP3, "Mp3ExportTest",
     "((bytes[2 * i].toInt() and 0xFF) or (bytes[2 * i + 1].toInt() shl 8))",
     "((bytes[2 * i + 1].toInt() and 0xFF) or (bytes[2 * i].toInt() shl 8))"),
    ("the encoder is never flushed", MP3, "Mp3ExportTest",
     "    val w = enc.flush(mp3)\n", "    val w = 0\n"),
    ("progress never reaches 1", MP3, "Mp3ExportTest",
     "    onProgress(1.0)\n", ""),
    ("progress overshoots mid-run", MP3, "Mp3ExportTest",
     "minOf(0.99, done.toDouble() / totalBytes)", "done.toDouble() / totalBytes + 1.0"),
    ("sweep removes nothing", MP3, "Mp3ExportTest",
     "    dir.listFiles()?.forEach { it.delete() }\n", ""),
    ("an empty title gives an empty filename", MP3, "Mp3ExportTest",
     '.ifEmpty { "meeting" }', ""),
]


def failed_tests(cls):
    path = os.path.join(RESULTS, f"TEST-com.innocorelabs.verbale.pipeline.{cls}.xml")
    with open(path, encoding="utf-8") as f:
        xml = f.read()
    return sorted(re.findall(r'<testcase name="([^"]+)"[^>]*>\s*<failure', xml))


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    rows, holes = [], 0
    for name, fname, cls, find, replace in MUTATIONS:
        if only and only not in name:
            continue
        src = os.path.join(PIPE, fname)
        with open(src, encoding="utf-8") as f:
            original = f.read()
        n = original.count(find)
        if n != 1:
            rows.append((name, f"PATCH DID NOT APPLY ({n} matches) — re-point it"))
            holes += 1
            continue
        stale = os.path.join(RESULTS, f"TEST-com.innocorelabs.verbale.pipeline.{cls}.xml")
        if os.path.exists(stale):
            os.remove(stale)
        try:
            with open(src, "w", encoding="utf-8") as f:
                f.write(original.replace(find, replace, 1))
            run = subprocess.run(
                ["./gradlew", ":app:testDebugUnitTest", "--tests", f"*{cls}*"],
                cwd=ANDROID, capture_output=True, text=True,
            )
            # A mutant that does not COMPILE has not been killed by a test; it has been killed by
            # the compiler, which proves nothing about the rule.
            if not os.path.exists(stale):
                rows.append((name, "DID NOT RUN (compile error?) — fix the patch"))
                holes += 1
                continue
            caught = failed_tests(cls)
        finally:
            with open(src, "w", encoding="utf-8") as f:
                f.write(original)
        if caught:
            rows.append((name, f"caught by {len(caught)}: " + ", ".join(caught[:3])))
        else:
            rows.append((name, "SURVIVED — nothing pins this behaviour"))
            holes += 1

    width = max(len(n) for n, _ in rows)
    for name, result in rows:
        print(f"{name.ljust(width)}  {result}")
    if holes:
        print(f"\n{holes} of {len(rows)} mutations were not caught.", file=sys.stderr)
        return 1
    print(f"\nall {len(rows)} mutations caught")
    return 0


if __name__ == "__main__":
    sys.exit(main())
