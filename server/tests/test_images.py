"""
Every image a page points at must exist as a committed file, so a reader never meets a broken
picture. `missing_images` is the check; the real-content test applies it to the shipped posts and
the other tests prove it can actually fail and that the generator produces what the pages expect.
"""
import re
import struct
import subprocess
import sys
from pathlib import Path

import pytest

from app import blog

SERVER = Path(__file__).resolve().parent.parent
STATIC = SERVER / "app" / "static"
CONTENT = SERVER / "app" / "content" / "blog"
FIXTURES = Path(__file__).parent / "fixtures" / "blog"
TOOL = SERVER / "tools" / "make_images.py"
SHOT_NAMES = ["recording", "summary", "mom", "decisions", "actions", "ask", "review", "privacy"]
SHOT_REF = re.compile(r"/static/shots/([\w-]+)\.webp")


def _front(raw: str) -> dict:
    return blog._split_front_matter(raw, "x")[0]


def missing_images(content_dir: Path, static_dir: Path) -> list[str]:
    """Paths (relative to static) that posts in content_dir reference but static_dir lacks."""
    missing = []
    for md in sorted(Path(content_dir).glob("*.md")):
        raw = md.read_text(encoding="utf-8")
        meta = _front(raw)
        wanted = [f"shots/{n}.webp" for n in SHOT_REF.findall(raw)]
        if meta.get("cover"):
            wanted += [f"blog/{meta['cover']}.webp", f"blog/{meta['cover']}-og.png"]
        missing += [f"{md.name}: {w}" for w in wanted if not (Path(static_dir) / w).exists()]
    return missing


def png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()[:24]
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    return struct.unpack(">II", data[16:24])


def webp_size(path: Path) -> tuple[int, int]:
    d = path.read_bytes()[:40]
    assert d[:4] == b"RIFF" and d[8:12] == b"WEBP"
    if d[12:16] == b"VP8X":
        return (int.from_bytes(d[24:27], "little") + 1, int.from_bytes(d[27:30], "little") + 1)
    if d[12:16] == b"VP8L":
        b = int.from_bytes(d[21:25], "little")
        return (b & 0x3FFF) + 1, ((b >> 14) & 0x3FFF) + 1
    return struct.unpack("<HH", d[26:30])[0] & 0x3FFF, struct.unpack("<HH", d[26:30])[1] & 0x3FFF


def test_real_posts_have_all_their_images():
    assert missing_images(CONTENT, STATIC) == []


def test_missing_cover_and_shot_are_reported(tmp_path):
    (tmp_path / "p.md").write_text(
        "---\ntitle: T\ndescription: D\ndate: 2026-01-01\ncover: nope\n---\n"
        "![x](/static/shots/ghost.webp)\n", encoding="utf-8")
    assert missing_images(tmp_path, STATIC) == [
        "p.md: shots/ghost.webp", "p.md: blog/nope.webp", "p.md: blog/nope-og.png"]


@pytest.mark.parametrize("name", SHOT_NAMES)
def test_store_shots_exist_and_are_small(name):
    p = STATIC / "shots" / f"{name}.webp"
    assert p.exists()
    assert p.stat().st_size <= 120 * 1024
    assert webp_size(p)[0] == 540


def test_default_og_is_1200_by_630():
    assert png_size(STATIC / "og.png") == (1200, 630)


def test_generator_makes_covers_at_the_sizes_pages_expect(tmp_path):
    pytest.importorskip("PIL")
    out = tmp_path / "static"
    # The on-device fixture names a shot that does not exist: everything is still written, but the
    # run must fail loudly and name the file.
    run = subprocess.run([sys.executable, str(TOOL), "--content", str(FIXTURES), "--out", str(out)],
                         capture_output=True, text=True)
    assert run.returncode == 1
    assert "on-device-transcription.md" in run.stderr and "record-screen" in run.stderr
    # The fixture post embeds a screenshot that is not one of the eight; covers themselves must exist.
    assert all("shots/" in m for m in missing_images(FIXTURES, out))
    for cover in ("on-device", "action-items"):
        w = out / "blog" / f"{cover}.webp"
        o = out / "blog" / f"{cover}-og.png"
        assert webp_size(w) == (blog.COVER_W, blog.COVER_H)
        assert w.stat().st_size <= 250 * 1024
        assert png_size(o) == (1200, 630)
        assert o.stat().st_size <= 300 * 1024
    assert png_size(out / "og.png") == (1200, 630)
    assert len(list((out / "shots").glob("*.webp"))) == 8


def test_committed_shots_match_what_the_tool_makes(tmp_path):
    """
    Stale committed shots (tool changed, files not regenerated) fail here instead of in review.
    Compared by pixels, not bytes: lossy WebP bytes differ between Pillow/libwebp versions even
    for identical input, so a byte check would fail on any machine with another Pillow.
    """
    pytest.importorskip("PIL")
    from PIL import Image, ImageChops, ImageStat
    mod = _tool()
    mod.make_shots(tmp_path)

    def flat(path):  # noqa: E306
        im = Image.open(path).convert("RGBA")
        bg = Image.new("RGBA", im.size, (*mod.INDIGO, 255))
        bg.alpha_composite(im)
        return bg.convert("RGB")

    for name in SHOT_NAMES:
        a, b = flat(tmp_path / "shots" / f"{name}.webp"), flat(STATIC / "shots" / f"{name}.webp")
        assert a.size == b.size, f"{name}.webp is stale: rerun tools/make_images.py"
        diff = sum(ImageStat.Stat(ImageChops.difference(a, b)).mean) / 3
        assert diff < 1.0, f"{name}.webp is stale: rerun tools/make_images.py"


def _tool():
    import importlib.util
    spec = importlib.util.spec_from_file_location("make_images", TOOL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_tool_and_blog_parse_front_matter_the_same():
    pytest.importorskip("PIL")
    mod = _tool()
    files = sorted(FIXTURES.glob("*.md")) + sorted(CONTENT.glob("*.md"))
    assert files
    for md in files:
        raw = md.read_text(encoding="utf-8")
        ours, theirs = mod.parse_front_matter(raw), _front(raw)
        for key in ("title", "cover", "shot"):
            assert ours.get(key) == theirs.get(key), f"{md.name}: {key}"


def test_unknown_shot_makes_main_exit_nonzero(tmp_path):
    pytest.importorskip("PIL")
    mod = _tool()
    (tmp_path / "c").mkdir()
    (tmp_path / "c" / "p.md").write_text(
        "---\ntitle: T\ndescription: D\ndate: 2026-01-01\ncover: c1\nshot: typo\n---\nx\n", encoding="utf-8")
    assert mod.main(["--content", str(tmp_path / "c"), "--out", str(tmp_path / "o")]) == 1
    assert (tmp_path / "o" / "blog" / "c1.webp").exists()
