#!/usr/bin/env python3
"""
Build script for Kickball Walk-On Music.

Reads manifest.json, validates every referenced clip exists, runs each
clip through an ffmpeg prep pipeline (loudness-normalize -> trim leading
silence -> fade out -> encode), base64-embeds the results, and assembles
a single self-contained dist/index.html.

Fails loudly on any missing clip or manifest error -- never emits a
partial soundboard (see 01-Architecture.md, "Build script").

Usage:
    python3 build.py [--manifest manifest.json] [--out dist/index.html]
"""

import argparse
import base64
import hashlib
import json
import mimetypes
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

LOUDNORM_ARGS = "loudnorm=I=-16:TP=-1.5:LRA=11"
SILENCE_TRIM_ARGS = "silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:detection=peak"
AAC_BITRATE = "128k"


class BuildError(Exception):
    """Raised for any condition that should fail the build loudly."""


def require_ffmpeg():
    for tool in ("ffmpeg", "ffprobe"):
        if shutil.which(tool) is None:
            raise BuildError(f"'{tool}' not found on PATH -- install ffmpeg before building.")


def load_manifest(path: Path) -> dict:
    if not path.exists():
        raise BuildError(f"Manifest not found: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise BuildError(f"Manifest is not valid JSON: {e}")

    for key in ("team", "players", "settings"):
        if key not in data:
            raise BuildError(f"Manifest missing required top-level key: '{key}'")
    if not isinstance(data["players"], list) or not data["players"]:
        raise BuildError("Manifest 'players' must be a non-empty array.")
    for i, p in enumerate(data["players"]):
        for key in ("id", "name", "clips"):
            if key not in p:
                raise BuildError(f"players[{i}] missing required key: '{key}'")
        if not isinstance(p["clips"], list) or not p["clips"]:
            raise BuildError(f"players[{i}] ('{p.get('id')}') has no clips listed.")
    return data


def probe_duration(path: Path) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise BuildError(f"ffprobe failed on {path}: {result.stderr.strip()}")
    try:
        return float(result.stdout.strip())
    except ValueError:
        raise BuildError(f"Could not parse duration for {path}: {result.stdout!r}")


def run_ffmpeg(args: list, context: str):
    result = subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"] + args,
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise BuildError(f"ffmpeg failed ({context}): {result.stderr.strip()}")


def process_clip(src: Path, fade_out_ms: int, workdir: Path) -> Path:
    """Normalize, trim leading silence, fade out, encode. Returns path to final AAC file."""
    stage1 = workdir / f"{src.stem}.stage1.wav"
    run_ffmpeg(
        ["-i", str(src), "-af", f"{SILENCE_TRIM_ARGS},{LOUDNORM_ARGS}", "-ar", "44100", str(stage1)],
        context=f"normalize/trim {src.name}",
    )

    duration = probe_duration(stage1)
    fade_sec = fade_out_ms / 1000.0
    fade_start = max(0.0, duration - fade_sec)

    final = workdir / f"{src.stem}.final.m4a"
    run_ffmpeg(
        ["-i", str(stage1), "-af", f"afade=t=out:st={fade_start:.3f}:d={fade_sec:.3f}",
         "-c:a", "aac", "-b:a", AAC_BITRATE, str(final)],
        context=f"fade/encode {src.name}",
    )
    return final


def build(manifest_path: Path, out_path: Path):
    require_ffmpeg()
    manifest = load_manifest(manifest_path)
    repo_root = manifest_path.parent
    clips_dir = repo_root / manifest["settings"].get("clipsDir", "clips")
    fade_out_ms = manifest["settings"].get("fadeOutMs", 1500)
    theme = manifest["settings"].get("theme", "dark")

    if not clips_dir.exists():
        raise BuildError(f"clipsDir not found: {clips_dir}")

    # Validate every referenced clip exists before doing any processing work.
    missing = []
    for p in manifest["players"]:
        for clip_name in p["clips"]:
            if not (clips_dir / clip_name).exists():
                missing.append(f"{p['id']}: {clip_name}")
    if missing:
        raise BuildError("Missing clip file(s):\n  " + "\n  ".join(missing))

    players_out = []
    total_processed_bytes = 0

    with tempfile.TemporaryDirectory(prefix="kickball-build-") as tmp:
        workdir = Path(tmp)
        for p in manifest["players"]:
            clip_entries = []
            for clip_name in p["clips"]:
                src = clips_dir / clip_name
                print(f"  processing {p['id']}: {clip_name} ...", file=sys.stderr)
                final = process_clip(src, fade_out_ms, workdir)
                data = final.read_bytes()
                total_processed_bytes += len(data)
                mime = mimetypes.guess_type(final.name)[0] or "audio/mp4"
                clip_entries.append({
                    "mime": mime,
                    "data": base64.b64encode(data).decode("ascii"),
                })
            players_out.append({
                "id": p["id"],
                "name": p["name"],
                "clips": clip_entries,
            })

    payload = {
        "team": manifest["team"],
        "theme": theme,
        "fadeOutMs": fade_out_ms,
        "players": players_out,
    }

    html = render_html(payload)

    # Content-hash cache id: hashed from the *final rendered HTML*, not just
    # the manifest/audio payload -- a code fix to app.template.html changes
    # index.html's bytes just as much as a roster change does, and both
    # need to bust the service worker's cache the same way. Hashing only
    # the payload was a real bug caught during the first build session: it
    # meant a shipped code fix would never actually reach an already-cached
    # phone via the normal "reopen on Wi-Fi" update flow.
    cache_id = hashlib.sha256(html.encode()).hexdigest()[:10]
    sw_js = render_sw(cache_id)

    # Published to repo root by default: GitHub Pages' "deploy from a
    # branch" mode only serves from / (root) or /docs, and /docs is
    # already spoken for by the ops walkthroughs (01-Architecture.md).
    # Root it is -- pass --out dist/index.html for a local-only test copy.
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html, encoding="utf-8")
    (out_path.parent / "sw.js").write_text(sw_js, encoding="utf-8")

    mb = total_processed_bytes / (1024 * 1024)
    out_mb = out_path.stat().st_size / (1024 * 1024)
    print(f"\nBuild OK: {len(players_out)} players, "
          f"{mb:.2f} MB audio -> {out_path} ({out_mb:.2f} MB total), "
          f"cache id {cache_id}", file=sys.stderr)


TEMPLATE_PATH = Path(__file__).parent / "app.template.html"
SW_TEMPLATE_PATH = Path(__file__).parent / "sw.template.js"


def render_html(payload: dict) -> str:
    if not TEMPLATE_PATH.exists():
        raise BuildError(f"Template not found: {TEMPLATE_PATH}")
    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    # Escape "</" so no player/team string can terminate the <script> tag
    # early (json.dumps doesn't escape forward slashes). "<\/" is identical
    # to "</" once JSON-parsed, so the payload is unchanged.
    payload_json = json.dumps(payload).replace("</", "<\\/")
    html = template.replace("__PAYLOAD_JSON__", payload_json)
    html = html.replace("__TEAM_NAME__", payload["team"])
    return html


def render_sw(cache_id: str) -> str:
    if not SW_TEMPLATE_PATH.exists():
        raise BuildError(f"Service worker template not found: {SW_TEMPLATE_PATH}")
    return SW_TEMPLATE_PATH.read_text(encoding="utf-8").replace("__CACHE_ID__", cache_id)


def main():
    parser = argparse.ArgumentParser(description="Build the Kickball Walk-On Music soundboard.")
    parser.add_argument("--manifest", default="manifest.json", type=Path)
    parser.add_argument("--out", default="index.html", type=Path,
                         help="Published location (default: repo root, for GitHub Pages).")
    args = parser.parse_args()

    try:
        build(args.manifest, args.out)
    except BuildError as e:
        print(f"\nBUILD FAILED: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
