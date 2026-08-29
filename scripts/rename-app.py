#!/usr/bin/env python3
"""
Rename the app.

    ./scripts/rename-app.py --name "Minutely" --id com.innocorelabs.minutely
    ./scripts/rename-app.py --name "Minutely" --id com.innocorelabs.minutely --apply

Dry run by default. Nothing is written until --apply.

## The one part that is irreversible

`applicationId` is the app's permanent identity on Google Play. It CANNOT be changed after the
first upload — not by editing it, not by appealing; a different applicationId is a different app,
with a different listing, different reviews and no upgrade path for anyone who installed the old
one. So it has to be right before you publish, and this script exists mostly to make sure it is.

Everything else is reversible at any time:

  * The display name (`app_name`, `app.json`) is what users see, and can change with any release.
  * The Kotlin package `com.audionotes.*` is invisible to users. Android is happy for it to differ
    from applicationId, and leaving it alone is the safe default this script takes.

## Why touching the package is opt-in

`--package` also moves the Kotlin package, which means rewriting 20 JNI symbols in cpp/jni/. Those
are matched **by string at runtime**: `Java_com_audionotes_pipeline_NativeBridge_nativeVad` has to
spell out the package of the class that declares it. Get one wrong and nothing fails to compile —
the app builds, installs, launches, and dies with UnsatisfiedLinkError the moment it records.

That is a real risk taken for a cosmetic gain, so it is not the default. If you do take it, the
script checks afterwards that every JNI symbol and every `external fun` still line up, and you
should record a meeting on a device before believing any of it.

## After running with --apply

    cd android && ./gradlew clean :app:assembleDebug :app:testDebugUnitTest

and, if --package was used, record something on a real device.
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OLD_ID = "com.audionotes"
OLD_NAME = "Verbale"

SKIP_DIRS = {"node_modules", "build", ".git", ".venv", "third_party", "graphify-out",
             "_to_delete", "Pods", ".gradle", "mirror", ".model-check"}


@dataclass
class Change:
    path: Path
    note: str
    hits: int


@dataclass
class Plan:
    """
    Edits accumulate per file rather than being collected as independent before/after pairs.

    The first version kept one Change per (file, rule), each computed from the file as it was on
    disk, and applied them by writing `after`. Two rules touching one file therefore raced, and the
    second silently undid the first — which is exactly what happened to cpp/jni/audionotes_jni.cpp,
    where the JNI symbol rewrite was clobbered by the rewrite of a comment three lines above it.
    The build would have succeeded and the app would have died on the first recording.
    """

    #: path -> the text as it will be written, with every rule so far applied.
    texts: dict[Path, str] = field(default_factory=dict)
    changes: list[Change] = field(default_factory=list)
    moves: list[tuple[Path, Path]] = field(default_factory=list)

    def edit_lines(self, path: Path, old: str, new: str, note: str) -> None:
        """
        Replace `old` with `new`, but never on a line containing a URL.

        ModelCatalog.kt fetches the ONNX Runtime shared library from
        github.com/akshayprodigy/Verbale/releases/... — a real address that does not change
        because the product did. Rewriting it would 404 every first run, and the sha256 check
        would not save anyone because the download never completes.
        """
        if not path.exists():
            return
        text = self.texts.get(path)
        if text is None:
            text = path.read_text(encoding="utf-8")
        # "an AudioNotes backup" becomes "an Verbale backup" if you only swap the noun. English
        # picks the article from the sound that follows it, so the article has to move too.
        vowel = new[:1].lower() in "aeiou"
        out, hits = [], 0
        for line in text.splitlines(keepends=True):
            if old in line and "://" not in line:
                hits += line.count(old)
                line = line.replace(old, new)
                if not vowel:
                    line = re.sub(rf"\ban {re.escape(new)}\b", f"a {new}", line)
                    line = re.sub(rf"\bAn {re.escape(new)}\b", f"A {new}", line)
                else:
                    line = re.sub(rf"\ba {re.escape(new)}\b", f"an {new}", line)
                    line = re.sub(rf"\bA {re.escape(new)}\b", f"An {new}", line)
            out.append(line)
        if hits:
            self.texts[path] = "".join(out)
            self.changes.append(Change(path, note, hits))

    def edit(self, path: Path, pattern: str, replacement: str, note: str, regex: bool = False) -> None:
        if not path.exists():
            return
        text = self.texts.get(path)
        if text is None:
            text = path.read_text(encoding="utf-8")
        if regex:
            new, hits = re.subn(pattern, replacement, text)
        else:
            hits = text.count(pattern)
            new = text.replace(pattern, replacement)
        if hits:
            self.texts[path] = new
            self.changes.append(Change(path, note, hits))


def walk(*, suffixes: tuple[str, ...]) -> list[Path]:
    out = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.suffix not in suffixes:
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        out.append(path)
    return sorted(out)


def build_plan(name: str | None, app_id: str | None, package: str | None,
               domain: str | None) -> Plan:
    plan = Plan()

    # --- the irreversible one ---
    if app_id:
        gradle = ROOT / "android/app/build.gradle"
        plan.edit(gradle, f'applicationId "{OLD_ID}"', f'applicationId "{app_id}"',
                  "applicationId — PERMANENT after the first Play upload")
        if not package:
            # namespace stays put when the Kotlin package does. Android allows them to differ, and
            # BuildConfig/R keep the package the Kotlin imports already name.
            pass

    # --- the display name ---
    if name:
        plan.edit(ROOT / "android/app/src/main/res/values/strings.xml",
                  f"<string name=\"app_name\">{OLD_NAME}</string>",
                  f"<string name=\"app_name\">{name}</string>", "launcher label")
        plan.edit(ROOT / "app.json", f'"{OLD_NAME}"', f'"{name}"', "React Native app name")
        plan.edit(ROOT / "android/settings.gradle", f"rootProject.name = '{OLD_NAME}'",
                  f"rootProject.name = '{name}'", "gradle project name")
        plan.edit(ROOT / "server/app/branding.py",
                  f'PRODUCT_NAME = os.environ.get("PRODUCT_NAME", "{OLD_NAME}")',
                  f'PRODUCT_NAME = os.environ.get("PRODUCT_NAME", "{name}")',
                  "the name in the web pages, the legal documents and reset emails")
        # User-visible prose, in the app and on the server. The server is swept too because
        # branding.py only helps where it is actually referenced: the first real rename found the
        # password-reset email subject still naming a product that no longer existed.
        for path in walk(suffixes=(".tsx", ".ts", ".py", ".md")):
            plan.edit_lines(path, OLD_NAME, name, "user-visible text")

        # Kotlin carries the name too, and two of those are not comments:
        #
        #   MainActivity.getMainComponentName() MUST equal app.json's `name`, because that is what
        #   index.js registers with AppRegistry. Change one without the other and the app launches
        #   and dies with "Application <old> has not been registered" — at runtime, on a device,
        #   with a green build behind it. The first real rename hit exactly this.
        #
        #   ProcessingService puts the name in a notification the user reads.
        for path in walk(suffixes=(".kt", ".java")):
            plan.edit_lines(path, OLD_NAME, name, "name in Kotlin (component name, notifications)")

        plan.edit(ROOT / "package.json", f'"name": "{OLD_NAME}"', f'"name": "{name}"',
                  "npm package name")

    # --- the licence server's address ---
    if domain:
        # Matches whatever is there now, so this keeps working after the first rename.
        plan.edit(ROOT / "android/gradle.properties",
                  r"licenceBaseUrl=\S*",
                  f"licenceBaseUrl=https://{domain}", "where the app signs in", regex=True)

    # --- the optional, risky part ---
    if package:
        old_path, new_path = OLD_ID.replace(".", "/"), package.replace(".", "/")
        old_jni, new_jni = OLD_ID.replace(".", "_"), package.replace(".", "_")

        for source_set in ("main", "test", "androidTest"):
            src = ROOT / f"android/app/src/{source_set}/java/{old_path}"
            if src.exists():
                plan.moves.append((src, ROOT / f"android/app/src/{source_set}/java/{new_path}"))

        for path in walk(suffixes=(".kt",)):
            plan.edit(path, OLD_ID, package, "Kotlin package")
        for path in walk(suffixes=(".cpp", ".h")):
            # The runtime-linked half. A mismatch here is an UnsatisfiedLinkError on a phone.
            plan.edit(path, f"Java_{old_jni}_", f"Java_{new_jni}_", "JNI symbol (runtime-linked)")
            plan.edit(path, OLD_ID, package, "comment referring to the Kotlin class")

        gradle = ROOT / "android/app/build.gradle"
        plan.edit(gradle, f'namespace "{OLD_ID}"', f'namespace "{package}"',
                  "namespace — where BuildConfig and R are generated")

    return plan


def verify_component_name() -> list[str]:
    """
    app.json's `name` and MainActivity.getMainComponentName() must be the same string.

    index.js does `AppRegistry.registerComponent(appName, ...)` with the value from app.json, and
    the Activity asks for its component by name. A mismatch is invisible to the compiler and fatal
    on launch.
    """
    import json

    app_json = ROOT / "app.json"
    if not app_json.exists():
        return ["app.json is missing"]
    registered = json.loads(app_json.read_text()).get("name")

    activities = list((ROOT / "android/app/src/main/java").rglob("MainActivity.kt"))
    if not activities:
        return ["MainActivity.kt not found"]
    text = activities[0].read_text()
    match = re.search(r'getMainComponentName\(\):\s*String\s*=\s*"([^"]+)"', text)
    if not match:
        return ["could not read getMainComponentName() from MainActivity.kt"]
    if match.group(1) != registered:
        return [
            f'app.json registers "{registered}" but MainActivity asks for "{match.group(1)}". '
            "The app will launch and die with \"Application ... has not been registered\"."
        ]
    return []


def verify_jni(package: str) -> list[str]:
    """After a package move, check the two halves of the JNI contract still name each other."""
    problems = []
    prefix = f"Java_{package.replace('.', '_')}_pipeline_NativeBridge_"
    jni = ROOT / "cpp/jni/audionotes_jni.cpp"
    bridge = ROOT / "android/app/src/main/java" / package.replace(".", "/") / "pipeline/NativeBridge.kt"

    if not jni.exists():
        return ["cpp/jni/audionotes_jni.cpp is missing"]
    jni_text = jni.read_text()
    symbols = set(re.findall(r"Java_[A-Za-z0-9_]+_pipeline_NativeBridge_(\w+)\(", jni_text))
    stale = re.findall(r"Java_com_audionotes_[A-Za-z0-9_]*", jni_text)
    if stale:
        problems.append(f"{len(stale)} JNI symbol(s) still name the old package: {stale[0]}")
    if f"Java_{package.replace('.', '_')}_" not in jni_text:
        problems.append(f"no JNI symbol uses the new prefix {prefix}")

    if not bridge.exists():
        problems.append(f"NativeBridge.kt not found at the new package path ({bridge})")
        return problems
    declared = set(re.findall(r"external fun (\w+)\(", bridge.read_text()))
    missing = declared - symbols
    if missing:
        problems.append(
            "declared in Kotlin but with no matching JNI symbol — these throw "
            f"UnsatisfiedLinkError at runtime: {', '.join(sorted(missing))}"
        )
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--name", help='display name, e.g. "Minutely"')
    parser.add_argument("--id", dest="app_id",
                        help="applicationId, e.g. com.innocorelabs.minutely. PERMANENT once published")
    parser.add_argument("--package", help="also move the Kotlin package and 20 JNI symbols (optional, riskier)")
    parser.add_argument("--domain", help="licence server hostname, e.g. minutely.innocorelabs.com")
    parser.add_argument("--apply", action="store_true", help="actually write the changes")
    args = parser.parse_args()

    if not any((args.name, args.app_id, args.package, args.domain)):
        parser.error("nothing to do — pass at least one of --name, --id, --package, --domain")
    for value, flag in ((args.app_id, "--id"), (args.package, "--package")):
        if value and not re.fullmatch(r"[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+", value):
            parser.error(f"{flag} must be lowercase reverse-DNS, e.g. com.innocorelabs.minutely (got {value!r})")

    plan = build_plan(args.name, args.app_id, args.package, args.domain)

    if not plan.texts and not plan.moves:
        print("nothing matched — has this already been renamed?")
        return 1

    print(f"{'APPLYING' if args.apply else 'DRY RUN — nothing will be written'}\n")
    for src, dst in plan.moves:
        print(f"  move  {src.relative_to(ROOT)}\n     -> {dst.relative_to(ROOT)}")
    if plan.moves:
        print()

    by_note: dict[str, list[Change]] = {}
    for change in plan.changes:
        by_note.setdefault(change.note, []).append(change)
    for note, changes in by_note.items():
        total = sum(c.hits for c in changes)
        print(f"  {note}: {total} replacement(s) in {len(changes)} file(s)")
        for c in changes[:6]:
            print(f"      {c.path.relative_to(ROOT)} ({c.hits})")
        if len(changes) > 6:
            print(f"      … and {len(changes) - 6} more")
    print()

    if args.app_id:
        print(f"  !! applicationId becomes {args.app_id}")
        print("     This is PERMANENT once the app is uploaded to Play. Be sure.\n")
    if args.package and not args.apply:
        print("  !! --package rewrites JNI symbols that are linked by string at RUNTIME.")
        print("     A mistake here compiles, installs, launches, and fails on the first")
        print("     recording. Record a meeting on a device before believing the build.\n")

    if not args.apply:
        print("re-run with --apply to write these changes")
        return 0

    # Edits BEFORE moves. The plan recorded every file at the path it had when it was scanned, so
    # moving the package directory first leaves 42 recorded paths pointing at nothing. (It did,
    # the first time this was run for real.)
    for path, text in plan.texts.items():
        path.write_text(text, encoding="utf-8")
    for src, dst in plan.moves:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
        # Leave no empty com/audionotes shell behind to confuse the next reader.
        parent = src.parent
        while parent != ROOT and parent.exists() and not any(parent.iterdir()):
            parent.rmdir()
            parent = parent.parent

    # React Native caches the package in autolinking.json and generates a Java entry point from
    # it. Left alone, the next build fails with "package com.audionotes does not exist" pointing
    # at a generated file nobody edited. Deleting it is free; both are build output.
    removed = []
    for cache in (ROOT / "android/build/generated/autolinking",
                  ROOT / "android/app/build/generated/autolinking"):
        if cache.exists():
            shutil.rmtree(cache)
            removed.append(str(cache.relative_to(ROOT)))
    if removed:
        print("cleared React Native's autolinking cache: " + ", ".join(removed))

    print("written.\n")

    problems = verify_component_name()
    if problems:
        print("COMPONENT NAME CHECK FAILED:")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print("component name check: app.json and MainActivity agree.")

    if args.package:
        problems = verify_jni(args.package)
        if problems:
            print("JNI CHECK FAILED:")
            for p in problems:
                print(f"  - {p}")
            return 1
        print("JNI check: every Kotlin `external fun` has a matching symbol under the new package.")
    print("\nnow run:\n  cd android && ./gradlew clean :app:assembleDebug :app:testDebugUnitTest")
    if args.package:
        print("  …then record a meeting on a real device. The JNI link is only proven at runtime.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
