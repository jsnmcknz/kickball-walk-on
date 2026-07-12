#!/usr/bin/env python3
"""
Scoring preview builder -- dist/scoring-preview.html.

Promoted from Claude's /tmp scratch script (2026-07-08 session) after being
recreated from scratch across three sessions; see _ai/handoff.md history.
NOT part of the deploy pipeline -- the artifact this emits is only for
on-device review of the scoring screens.

What it does:
1. Copies manifest.json with `scoring.enabled` forced true, into the repo
   root (build.py resolves clipsDir relative to the manifest's folder, so
   the temp copy must live there too).
2. Runs the normal build against it, out to dist/scoring-preview.html
   (full ffmpeg clip pipeline -- identical audio payload to a real build).
3. Injects a preview-only <script> that seeds localStorage with the replay
   fixture (mockups/sample-game-events.json) so the app boots mid-game.
   Seeding happens when the key is absent, or on demand by opening the
   page with `#reset` in the URL. Fixture events get synthetic ids so
   undo/amend (which target event ids) work against seeded history.

Usage:
    python3 tools/gen-preview.py

Re-run after ANY app.template.html change intended for on-device review.
"""

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

import build as buildmod  # noqa: E402

TMP_MANIFEST = REPO / "manifest_preview.json.tmp"
OUT = REPO / "dist" / "scoring-preview.html"
FIXTURE = REPO / "mockups" / "sample-game-events.json"
STORAGE_KEY = "kickball_v1_scoringEvents_v1"


def main():
    manifest = json.loads((REPO / "manifest.json").read_text(encoding="utf-8"))
    manifest.setdefault("scoring", {})["enabled"] = True
    TMP_MANIFEST.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    try:
        buildmod.build(TMP_MANIFEST, OUT)
    finally:
        try:
            TMP_MANIFEST.unlink()
        except OSError as e:
            print(f"note: could not remove {TMP_MANIFEST.name} ({e}) -- "
                  "harmless leftover, delete by hand.", file=sys.stderr)

    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    events = fixture["events"]
    for i, evt in enumerate(events):
        evt.setdefault("id", f"seed_{evt.get('seq', i)}")

    # "</" escaped so no fixture string can close the <script> tag early --
    # same trick as build.py's payload injection.
    seed_json = json.dumps(events).replace("</", "<\\/")
    seed_js = (
        "<script>\n"
        "/* PREVIEW ONLY (tools/gen-preview.py): seed the scoring log from\n"
        "   mockups/sample-game-events.json so the game screen boots mid-game.\n"
        "   Seeds when the key is absent; open with #reset to force a reseed. */\n"
        "(function () {\n"
        "  try {\n"
        f"    var KEY = {json.dumps(STORAGE_KEY)};\n"
        f"    var SEED = {seed_json};\n"
        "    if (!localStorage.getItem(KEY) || location.hash === '#reset') {\n"
        "      localStorage.setItem(KEY, JSON.stringify(SEED));\n"
        "    }\n"
        "  } catch (e) {}\n"
        "})();\n"
        "</script>\n"
    )

    html = OUT.read_text(encoding="utf-8")
    marker = "<script>\n'use strict';"
    if marker not in html:
        raise SystemExit("gen-preview: couldn't find the app <script> to inject before.")
    OUT.write_text(html.replace(marker, seed_js + marker, 1), encoding="utf-8")
    print(f"Preview OK: {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
