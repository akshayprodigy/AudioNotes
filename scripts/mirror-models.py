#!/usr/bin/env python3
"""
Mirror the model files the app downloads on first run.

    ./scripts/mirror-models.py check                  # are the upstream URLs still what we hashed?
    ./scripts/mirror-models.py fetch  [--dir DIR]     # download and verify into DIR/models/v1/
    ./scripts/mirror-models.py verify --base URL      # is the mirror serving the right bytes?

## Why this exists

The app fetches ~114 MB of required weights on first run, plus 1.1 GB for the writer model. None of
it is in the APK — an app shipping 1.4 GB of weights loses most of its installs at the store's size
warning — so until a mirror exists, every first run depends on GitHub and Hugging Face being up and
serving the same bytes they served when the catalog was hashed.

That second part is the real hazard, and it is not hypothetical. `silero-vad` is fetched from a
`raw/master` URL: a **branch pointer**, not a release. The day upstream commits a new model to
master, that URL serves different bytes, the sha256 check in ModelManagerModule fails, and first
run breaks — for NEW installs only. Everyone who already has the file is fine, so nothing in
crash reporting fires and nothing in the existing install base degrades. It surfaces as store
reviews. `check` is what turns that into something we find on a Tuesday instead.

## Where the truth lives

Everything here is read out of ModelCatalog.kt. There is deliberately no second copy of the URLs or
the hashes: a mirror script that disagreed with the app about what a file should be would upload
exactly the wrong thing and verify it happily.

## Uploading

`fetch` leaves a directory laid out the way `ModelCatalog.sourcesFor` expects, so the upload is
whatever your object store's sync command is:

    aws s3 sync ./mirror/models/ s3://<bucket>/models/ \\
        --endpoint-url https://<account>.r2.cloudflarestorage.com

Then set `modelBaseUrl=https://<your cdn>` in android/gradle.properties. Upstream stays as the
fallback, so a bad afternoon at the CDN degrades to slow rather than broken, and every file is
sha256-verified after download from either source — a mirror cannot substitute a different file
undetected.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def find_catalog() -> Path:
    """
    Locate ModelCatalog.kt by searching, not by a hardcoded package path.

    It used to be hardcoded, and the rename to com.innocorelabs.verbale broke every command here
    with a FileNotFoundError — silently, because nothing runs this on a schedule. `check` is
    supposed to be what catches a moved upstream file before the store reviews do, and it had been
    unable to run at all. Searching costs nothing and has no package name to go stale.
    """
    roots = [ROOT / "android/app/src/main/java", ROOT / "android/app/src/main/kotlin"]
    found = sorted(f for r in roots if r.is_dir() for f in r.rglob("ModelCatalog.kt"))
    if not found:
        raise SystemExit(f"could not find ModelCatalog.kt under {roots[0]}")
    if len(found) > 1:
        raise SystemExit("found more than one ModelCatalog.kt:\n  " + "\n  ".join(map(str, found)))
    return found[0]


CATALOG = find_catalog()

STRING = re.compile(r'"((?:[^"\\]|\\.)*)"')
SIZE = re.compile(r"\b(\d[\d_]*)L\b")
BOOL = re.compile(r"\b(true|false)\b")


@dataclass(frozen=True)
class Spec:
    id: str
    name: str
    kind: str
    required: bool
    filename: str
    upstream: str
    sha256: str
    size: int


def strip_comments(text: str) -> str:
    """Drop // comments, leaving string literals alone (several contain '//' inside URLs)."""
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            out.append(text[i : j + 1])
            i = j + 1
        elif text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
        else:
            out.append(c)
            i += 1
    return "".join(out)


def blocks(text: str) -> list[str]:
    """
    Every ModelSpec( ... ) argument list, by balanced parentheses.

    Skips `data class ModelSpec(...)` itself, which is the same nine characters followed by the
    field declarations rather than by values — and `fun ModelSpec(...)`, the single-file
    convenience constructor, for the same reason.
    """
    found, start = [], 0
    while True:
        start = text.find("ModelSpec(", start)
        if start < 0:
            return found
        preceding = text[:start].rstrip()
        if preceding.endswith("class") or preceding.endswith("fun"):
            start += len("ModelSpec(")
            continue
        i = start + len("ModelSpec(")
        depth = 1
        while i < len(text) and depth:
            if text[i] == "(":
                depth += 1
            elif text[i] == ")":
                depth -= 1
            i += 1
        found.append(text[start + len("ModelSpec(") : i - 1])
        start = i


def part_blocks(text: str) -> list[str]:
    """Every ModelPart( ... ) argument list inside one ModelSpec, by balanced parentheses."""
    found, start = [], 0
    while True:
        start = text.find("ModelPart(", start)
        if start < 0:
            return found
        if text[:start].rstrip().endswith("class"):
            start += len("ModelPart(")
            continue
        i = start + len("ModelPart(")
        depth = 1
        while i < len(text) and depth:
            if text[i] == "(":
                depth += 1
            elif text[i] == ")":
                depth -= 1
            i += 1
        found.append(text[start + len("ModelPart(") : i - 1])
        start = i


def parse_catalog() -> list[Spec]:
    """
    Read the specs out of the Kotlin, ONE ENTRY PER FILE.

    A model may be several files — Qwen3-ASR is six — and every one of them has to be fetched and
    hashed, so the flat list of files is what the rest of this script wants. The model id repeats
    across its parts, which is what the progress output should say anyway.

    Strict on purpose: a parser that silently found six of seven models would mirror six of seven,
    and the missing one would fail on first run for exactly the users who have no mirror to fall
    back to... which is nobody, until upstream moves. That strictness is why this refused to run
    when parts were introduced rather than quietly mirroring the models it still understood.
    """
    text = strip_comments(CATALOG.read_text())
    specs: list[Spec] = []
    for block in blocks(text):
        # The single-file convenience constructor forwards to ModelSpec(...) by parameter NAME,
        # so that call has no string literals in it at all. Neither does any other declaration.
        # A real catalogue entry always names itself, so "no literals" means "not data".
        if not STRING.search(block):
            continue
        flag = BOOL.search(block)
        parts = part_blocks(block)
        if parts:
            # Multi-file: id/name/purpose/detail/kind come first, then a ModelPart each.
            head = block[: block.index("ModelPart(")]
            head_strings = [m.group(1) for m in STRING.finditer(head)]
            if len(head_strings) != 5 or not flag:
                raise SystemExit(
                    f"could not parse a multi-part ModelSpec header:\n{head.strip()[:300]}"
                )
            for pb in parts:
                pstrings = [m.group(1) for m in STRING.finditer(pb)]
                psize = SIZE.search(pb)
                if len(pstrings) != 3 or not psize:
                    raise SystemExit(
                        f"could not parse a ModelPart — expected filename, sha256, size, "
                        f"upstream:\n{pb.strip()[:300]}"
                    )
                specs.append(
                    Spec(
                        id=head_strings[0], name=head_strings[1], kind=head_strings[4],
                        required=flag.group(1) == "true",
                        filename=pstrings[0], sha256=pstrings[1], upstream=pstrings[2],
                        size=int(psize.group(1).replace("_", "")),
                    )
                )
            continue

        strings = [m.group(1) for m in STRING.finditer(block)]
        size = SIZE.search(block)
        if len(strings) != 8 or not size or not flag:
            raise SystemExit(
                f"could not parse a ModelSpec — the catalog's shape changed:\n{block.strip()[:300]}"
            )
        specs.append(
            Spec(
                id=strings[0], name=strings[1], kind=strings[4], required=flag.group(1) == "true",
                filename=strings[5], upstream=strings[6], sha256=strings[7],
                size=int(size.group(1).replace("_", "")),
            )
        )
    if not specs:
        raise SystemExit(f"no ModelSpec entries found in {CATALOG}")
    for s in specs:
        if len(s.sha256) != 64:
            raise SystemExit(f"{s.id}: sha256 is not 64 hex characters — parsed the wrong field?")
        if not s.upstream.startswith("https://"):
            raise SystemExit(f"{s.id}: upstream is not https — parsed the wrong field?")
    return specs


def human(n: int) -> str:
    return f"{n / 1e6:,.0f} MB" if n >= 1e6 else f"{n / 1e3:,.0f} kB"


def download(url: str, dest: Path, expected_size: int) -> None:
    """Stream to a .part file and rename only once it is whole."""
    part = dest.with_suffix(dest.suffix + ".part")
    part.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "audionotes-mirror/1"})
    with urllib.request.urlopen(request, timeout=120) as response, open(part, "wb") as out:
        done = 0
        while chunk := response.read(1 << 20):
            out.write(chunk)
            done += len(chunk)
            if expected_size:
                pct = min(100, int(done * 100 / expected_size))
                print(f"\r    {pct:3d}%  {human(done)}", end="", flush=True)
    print()
    part.rename(dest)


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def cmd_check(specs: list[Spec]) -> int:
    """
    Confirm the upstream URLs still serve exactly what the catalog says.

    Downloads every byte, because a Content-Length matching proves nothing about content — and the
    failure being guarded against here is upstream replacing a file at a branch URL, which need not
    change its length at all.
    """
    print(f"checking {len(specs)} upstream files against the catalog\n")
    bad = 0
    tmp = ROOT / ".model-check"
    tmp.mkdir(exist_ok=True)
    for spec in specs:
        print(f"  {spec.id} ({human(spec.size)})")
        dest = tmp / spec.filename
        try:
            download(spec.upstream, dest, spec.size)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
            print(f"    UNREACHABLE: {e}\n")
            bad += 1
            continue
        actual, actual_size = digest(dest), dest.stat().st_size
        dest.unlink()
        if actual == spec.sha256 and actual_size == spec.size:
            print("    ok\n")
        else:
            bad += 1
            print("    CHANGED — upstream no longer serves what the app expects.")
            print(f"      catalog: {spec.sha256}  {spec.size} bytes")
            print(f"      actual:  {actual}  {actual_size} bytes")
            print("    First run is broken for NEW installs until this is fixed. Either the file")
            print("    moved and the catalog needs re-hashing, or a branch pointer advanced.\n")
    print("all upstream files match the catalog" if not bad else f"{bad} file(s) do not match")
    return 1 if bad else 0


def cmd_fetch(specs: list[Spec], out_dir: Path) -> int:
    """Build the directory the mirror serves, verifying every file before it counts as fetched."""
    target = out_dir / "models" / "v1"
    target.mkdir(parents=True, exist_ok=True)
    print(f"fetching {len(specs)} files into {target}\n")
    bad = 0
    for spec in specs:
        dest = target / spec.filename
        if dest.exists() and dest.stat().st_size == spec.size and digest(dest) == spec.sha256:
            print(f"  {spec.id}: already here and verified")
            continue
        print(f"  {spec.id} ({human(spec.size)})")
        try:
            download(spec.upstream, dest, spec.size)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
            print(f"    FAILED: {e}\n")
            bad += 1
            continue
        actual = digest(dest)
        if actual != spec.sha256:
            # Never keep it. A file that reaches the mirror unverified is one the app will
            # download, fail to verify, and refuse — from our CDN, having paid for the bytes.
            dest.unlink()
            bad += 1
            print(f"    SHA MISMATCH — discarded.\n      expected {spec.sha256}\n      got      {actual}\n")
        else:
            print("    verified\n")

    if bad:
        print(f"{bad} file(s) failed — do NOT upload this directory")
        return 1
    total = sum(s.size for s in specs)
    print(f"all {len(specs)} files verified — {human(total)} in {target}\n")
    print("upload with something like:\n")
    print(f"  aws s3 sync {out_dir}/models/ s3://<bucket>/models/ \\")
    print("      --endpoint-url https://<account>.r2.cloudflarestorage.com\n")
    print("then set modelBaseUrl=https://<your cdn> in android/gradle.properties")
    return 0


def cmd_verify(specs: list[Spec], base: str) -> int:
    """Check a live mirror serves the same bytes the app will refuse if it does not."""
    base = base.rstrip("/")
    print(f"verifying mirror at {base}\n")
    bad = 0
    tmp = ROOT / ".model-check"
    tmp.mkdir(exist_ok=True)
    for spec in specs:
        url = f"{base}/models/v1/{spec.filename}"
        print(f"  {spec.id} ({human(spec.size)})")
        dest = tmp / spec.filename
        try:
            download(url, dest, spec.size)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
            print(f"    NOT SERVED: {e}\n")
            bad += 1
            continue
        actual = digest(dest)
        dest.unlink()
        if actual == spec.sha256:
            print("    ok\n")
        else:
            bad += 1
            print(f"    WRONG BYTES — the app would reject this.\n      expected {spec.sha256}\n      got      {actual}\n")
    print("the mirror is serving exactly what the app expects" if not bad else f"{bad} file(s) wrong")
    return 1 if bad else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check", help="verify upstream still serves what the catalog hashed")
    f = sub.add_parser("fetch", help="download and verify into a directory to upload")
    f.add_argument("--dir", default=str(ROOT / "mirror"))
    v = sub.add_parser("verify", help="verify a live mirror")
    v.add_argument("--base", required=True, help="e.g. https://cdn.example.com")
    sub.add_parser("list", help="show what the catalog contains")
    args = parser.parse_args()

    specs = parse_catalog()

    if args.command == "list":
        total = sum(s.size for s in specs)
        required = sum(s.size for s in specs if s.required)
        for s in specs:
            tag = "required" if s.required else ("PRO" if s.kind == "llm" else "optional")
            print(f"  {s.id:18s} {tag:9s} {human(s.size):>10s}  {s.filename}")
        print(f"\n  {len(specs)} files, {human(total)} total, {human(required)} required on first run")
        return 0
    if args.command == "check":
        return cmd_check(specs)
    if args.command == "fetch":
        return cmd_fetch(specs, Path(args.dir))
    return cmd_verify(specs, args.base)


if __name__ == "__main__":
    sys.exit(main())
