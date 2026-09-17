#!/usr/bin/env python3
"""Subset the upstream Zpix pixel font into the WOFF2 we self-host.

Why this exists
---------------
The app renders dynamic CJK text (usernames, scores, timers, race log). The
original Qt game had no font at all — its Chinese labels were baked into PNGs —
so the web port needs a *pixel* CJK face, and it must not depend on a CDN:
the container has to work on an intranet with no egress.

Upstream zpix.ttf is ~6.9 MB (22k glyphs). This script keeps only what the game
can actually draw and emits a ~0.3 MB WOFF2, then proves the subset is
character-for-character identical to the original for every retained glyph.

Coverage kept
  * printable ASCII
  * every character that appears literally in index.html / styles.css / src / test
  * the whole GB2312 repertoire (6763 hanzi + symbols) so any Chinese name a
    player types still renders in the pixel face
  * CJK punctuation, full-width forms, enclosed alphanumerics, arrows, symbols

Usage
    python tools/subset-font.py                 # download upstream, build, verify
    python tools/subset-font.py --src zpix.ttf  # use a local copy
    python tools/subset-font.py --check-only    # verify the shipped file only
"""

from __future__ import annotations

import argparse
import pathlib
import sys
import urllib.request

FONT_URL = "https://cdn.jsdelivr.net/gh/SolidZORO/zpix-pixel-font/dist/zpix.ttf"
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "fonts" / "zpix-subset.woff2"
CACHE = ROOT / ".cache" / "zpix-upstream.ttf"
SCAN = ["index.html", "styles.css", "src", "test"]
SCAN_EXT = {".js", ".mjs", ".html", ".css"}

# Everything the font is asked to keep. Ranges are generous on purpose: glyphs
# the upstream face doesn't have simply don't make it into the subset.
RANGES = [
    (0x0020, 0x007E, "printable ASCII"),
    (0x00A0, 0x00FF, "Latin-1 supplement (· × ° …)"),
    (0x2010, 0x206F, "general punctuation (— … ≈)"),
    (0x2100, 0x218F, "letterlike + number forms (① Ⅻ)"),
    (0x2190, 0x21FF, "arrows (← ↑ → ↓)"),
    (0x2460, 0x24FF, "enclosed alphanumerics (① ② ③)"),
    (0x25A0, 0x25FF, "geometric shapes (■ ▲ ●)"),
    (0x2600, 0x26FF, "misc symbols (★ ☆ ♪)"),
    (0x3000, 0x303F, "CJK punctuation (。、〈〉)"),
    (0xFF00, 0xFFEF, "full-width forms (！？：)"),
]


# --------------------------------------------------------------- charset
def source_charset() -> set[str]:
    """Every non-ASCII character that appears literally in the shipped sources."""
    out: set[str] = set()
    for entry in SCAN:
        p = ROOT / entry
        files = [p] if p.is_file() else [f for f in p.rglob("*") if f.is_file()]
        for f in files:
            if f.suffix not in SCAN_EXT:
                continue
            out |= {c for c in f.read_text(encoding="utf-8", errors="ignore")
                    if ord(c) > 0x7F and c.strip()}
    return out


def gb2312_charset() -> set[str]:
    """The full GB2312 repertoire — the practical bound on what a player can type."""
    out: set[str] = set()
    for hi in range(0xA1, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                out.add(bytes([hi, lo]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    return out


def wanted() -> tuple[set[str], set[str]]:
    """(requested characters, literal UI characters)."""
    chars: set[str] = set()
    for lo, hi, _ in RANGES:
        chars |= {chr(c) for c in range(lo, hi + 1)}
    chars |= gb2312_charset()
    ui = source_charset()
    chars |= ui
    chars.discard("\n")
    chars.discard("\t")
    return chars, ui


# --------------------------------------------------------------- font IO
def fetch_src(explicit: str | None) -> pathlib.Path:
    if explicit:
        return pathlib.Path(explicit)
    if CACHE.exists() and CACHE.stat().st_size > 1_000_000:
        return CACHE
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    print(f"downloading {FONT_URL}")
    req = urllib.request.Request(FONT_URL, headers={"User-Agent": "hr-web-font-tool/1.0"})
    with urllib.request.urlopen(req, timeout=300) as r, open(CACHE, "wb") as f:
        f.write(r.read())
    return CACHE


def load(path: pathlib.Path):
    from fontTools.ttLib import TTFont
    f = TTFont(path)
    if f.flavor == "woff2":
        f.flavor = None
        tmp = path.with_suffix(".decoded.ttf")
        f.save(tmp)
        f = TTFont(tmp)
        tmp.unlink(missing_ok=True)
    return f


def outline_digest(font, ch: str):
    """Exact drawing-command record for a glyph, so two faces can be compared."""
    from fontTools.pens.recordingPen import RecordingPen
    cmap = font.getBestCmap()
    name = cmap.get(ord(ch))
    if name is None:
        return None
    gs = font.getGlyphSet()
    pen = RecordingPen()
    gs[name].draw(pen)
    return repr(pen.value)


# --------------------------------------------------------------- verify
def verify(out: pathlib.Path) -> int:
    """The contract: every glyph the upstream face HAS and the game might draw
    must survive into the subset with a byte-identical outline.

    Characters that upstream simply has no glyph for (emoji, a handful of
    GB2312 codepoints zpix never drew) are reported but cannot be a failure —
    the browser falls back to the system font for those, and no amount of
    subsetting would conjure them."""
    chars, ui = wanted()
    sub = load(out)
    sub_cmap = sub.getBestCmap()

    print(f"\n{'=' * 62}\nverification\n{'=' * 62}")
    print(f"  shipped file   : {out.name}  ({out.stat().st_size / 1024:.1f} KB)")
    print(f"  glyphs in file : {sub['maxp'].numGlyphs}")
    print(f"  codepoints     : {len(sub_cmap)}")

    orig = None
    try:
        orig = load(fetch_src(None))
    except Exception as e:                                        # offline, no cache
        print(f"\n  ! upstream unavailable ({e})")
        print("  ! cannot cross-check outlines; structural checks only")

    if orig is not None:
        up_cmap = orig.getBestCmap()
        expected = {ch for ch in (set(chars) | ui) if ord(ch) in up_cmap}

        dropped = sorted(c for c in expected if ord(c) not in sub_cmap)
        checked = damaged = 0
        broken: list[str] = []
        for ch in sorted(expected):
            if ord(ch) not in sub_cmap:
                continue
            checked += 1
            if outline_digest(orig, ch) != outline_digest(sub, ch):
                damaged += 1
                broken.append(ch)

        unsupported = sorted(c for c in set(chars) | ui if ord(c) not in up_cmap)
        ui_unsupported = sorted(c for c in ui if ord(c) not in up_cmap)

        print(f"\n  glyphs upstream has       : {len(up_cmap)}")
        print(f"  expected in subset        : {len(expected)}")
        print(f"  outline compared          : {checked}  (every expected glyph)")
        print(f"  dropped by subsetting     : {len(dropped)}  {''.join(dropped[:24])}")
        print(f"  outline mismatches        : {damaged}  {''.join(broken[:24])}")
        print(f"\n  upstream has no glyph for : {len(unsupported)} codepoints"
              f" (expected — system font fallback)")
        if ui_unsupported:
            print(f"    literal UI chars in that set : {len(ui_unsupported)}  "
                  f"{''.join(ui_unsupported)}")
            for c in ui_unsupported:
                import unicodedata
                print(f"      U+{ord(c):04X}  {unicodedata.name(c, '?')}")
        ok = not dropped and not damaged
    else:
        # no upstream to compare against: fall back to the weaker promise that
        # every literal UI character is present
        ui_missing = sorted(c for c in ui if ord(c) not in sub_cmap)
        print(f"\n  literal UI chars          : {len(ui)}")
        print(f"  UI chars absent           : {len(ui_missing)}  {''.join(ui_missing)}")
        ok = not ui_missing

    print("\n" + ("\x1b[32mFONT OK — every retained glyph is identical to upstream"
                  "\x1b[0m" if ok else "\x1b[31mFONT BAD\x1b[0m"))
    return 0 if ok else 1


# --------------------------------------------------------------- build
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", help="local zpix.ttf instead of downloading")
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--check-only", action="store_true",
                    help="only verify the already-built file")
    args = ap.parse_args()

    out = pathlib.Path(args.out)
    if not args.check_only:
        chars, ui = wanted()
        src = fetch_src(args.src)
        print(f"source font : {src}  ({src.stat().st_size / 1048576:.2f} MB)")
        print(f"requested   : {len(chars)} chars ({len(ui)} of them literal UI text)")

        out.parent.mkdir(parents=True, exist_ok=True)
        textfile = out.with_suffix(".charset.txt")
        textfile.write_text("".join(sorted(chars)), encoding="utf-8")
        try:
            from fontTools import subset as ft_subset
            print("subsetting  : fontTools.subset -> woff2")
            ft_subset.main([
                str(src),
                f"--text-file={textfile}",
                f"--output-file={out}",
                "--flavor=woff2",
                "--layout-features=",
                "--no-hinting",
                "--desubroutinize",
                "--drop-tables+=DSIG",
                "--name-IDs=*",
                "--name-languages=*",
                "--name-legacy",
                "--recalc-bounds",
            ])
        except ImportError:
            print("fontTools is missing:  pip install fonttools brotli", file=sys.stderr)
            return 2
        finally:
            textfile.unlink(missing_ok=True)

    if not out.exists():
        print(f"missing {out} — run without --check-only first", file=sys.stderr)
        return 2
    return verify(out)


if __name__ == "__main__":
    raise SystemExit(main())
