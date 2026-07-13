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
import re
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


VALID_PLAYER_STATUS = ("member", "sub")


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
        status = p.get("status", "member")
        if status not in VALID_PLAYER_STATUS:
            raise BuildError(
                f"players[{i}] ('{p.get('id')}') has invalid status '{status}' "
                f"-- must be one of {VALID_PLAYER_STATUS}."
            )

    # --- Scoring-merge additions (05-Scoring-Architecture.md §Manifest) ---
    # teamSounds and defaultClips are optional arrays; when absent, treated
    # as empty (no TEAM section on All Songs, no default hype clips). Each
    # entry is validated like a player clip -- same "fail loudly before any
    # processing work" contract as the players loop above.
    team_sounds = data.get("teamSounds", [])
    if not isinstance(team_sounds, list):
        raise BuildError("Manifest 'teamSounds' must be an array if present.")
    for i, s in enumerate(team_sounds):
        for key in ("id", "name", "kind", "clips"):
            if key not in s:
                raise BuildError(f"teamSounds[{i}] missing required key: '{key}'")
        if not isinstance(s["clips"], list) or not s["clips"]:
            raise BuildError(f"teamSounds[{i}] ('{s.get('id')}') has no clips listed.")

    default_clips = data.get("defaultClips", [])
    if not isinstance(default_clips, list):
        raise BuildError("Manifest 'defaultClips' must be an array if present.")

    # scoring block: optional; missing == disabled with empty credentials,
    # so a manifest predating the scoring merge still builds unchanged.
    scoring = data.get("scoring", {})
    if not isinstance(scoring, dict):
        raise BuildError("Manifest 'scoring' must be an object if present.")
    scoring.setdefault("enabled", False)
    scoring.setdefault("supabaseUrl", "")
    scoring.setdefault("supabaseAnonKey", "")
    scoring.setdefault("teamPin", "0000")
    scoring.setdefault("inningsPerGame", 7)
    if not isinstance(scoring["enabled"], bool):
        raise BuildError("scoring.enabled must be true or false.")
    if not isinstance(scoring["inningsPerGame"], int) or scoring["inningsPerGame"] <= 0:
        raise BuildError("scoring.inningsPerGame must be a positive integer.")
    data["scoring"] = scoring
    data["teamSounds"] = team_sounds
    data["defaultClips"] = default_clips

    # --- Schedule + venue (07-Portal-Architecture.md / docs/season-schedule.md) ---
    # Optional; absent == no fixtures (a manifest predating S1.6 still builds
    # unchanged). Convention: absent keys mean TBD -- no "TBD" strings, so the
    # app-side rendering can treat a missing field as the TBD case uniformly.
    # `result` is present only for games whose final predates event data
    # (game 1); scored/live games derive their result from the event log via
    # scheduleGameId, never from the manifest -- enforced app-side, not here.
    schedule = data.get("schedule", [])
    if not isinstance(schedule, list):
        raise BuildError("Manifest 'schedule' must be an array if present.")
    seen_ids = set()
    for i, g in enumerate(schedule):
        if "id" not in g or "date" not in g:
            raise BuildError(f"schedule[{i}] missing required key: 'id' and 'date' are both required.")
        if g["id"] in seen_ids:
            raise BuildError(f"schedule[{i}]: duplicate schedule id '{g['id']}'.")
        seen_ids.add(g["id"])
        if "result" in g:
            r = g["result"]
            if not isinstance(r, dict) or "us" not in r or "them" not in r:
                raise BuildError(f"schedule[{i}] ('{g['id']}') has an invalid 'result' -- needs {{us, them}}.")
    data["schedule"] = schedule

    venue = data.get("venue", {})
    if not isinstance(venue, dict):
        raise BuildError("Manifest 'venue' must be an object if present.")
    data["venue"] = venue

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


def default_clip_display_name(clip_name: str) -> str:
    """Derives a display name for a defaultClips entry from its filename
    ("hype-track-1.mp3" -> "Hype Track 1") -- no separate manifest field for
    this since defaultClips is deliberately just a filename array (principle
    3: manifest-driven, minimal). Good enough for the "+new" song picker;
    a clip that needs a nicer name can just be renamed on disk."""
    stem = Path(clip_name).stem
    words = re.split(r"[-_\s]+", stem)
    return " ".join(w.capitalize() for w in words if w)


def build(manifest_path: Path, out_path: Path):
    require_ffmpeg()
    manifest = load_manifest(manifest_path)
    repo_root = manifest_path.parent
    clips_dir = repo_root / manifest["settings"].get("clipsDir", "clips")
    fade_out_ms = manifest["settings"].get("fadeOutMs", 1500)
    theme = manifest["settings"].get("theme", "dark")

    if not clips_dir.exists():
        raise BuildError(f"clipsDir not found: {clips_dir}")

    # Validate every referenced clip exists before doing any processing work
    # -- players, teamSounds, and defaultClips all draw from the same
    # clipsDir and fail together, loudly, before any ffmpeg runs.
    missing = []
    for p in manifest["players"]:
        for clip_name in p["clips"]:
            if not (clips_dir / clip_name).exists():
                missing.append(f"{p['id']}: {clip_name}")
    for s in manifest["teamSounds"]:
        for clip_name in s["clips"]:
            if not (clips_dir / clip_name).exists():
                missing.append(f"teamSounds/{s['id']}: {clip_name}")
    for clip_name in manifest["defaultClips"]:
        if not (clips_dir / clip_name).exists():
            missing.append(f"defaultClips: {clip_name}")
    if missing:
        raise BuildError("Missing clip file(s):\n  " + "\n  ".join(missing))

    players_out = []
    team_sounds_out = []
    default_clips_out = []
    total_processed_bytes = 0

    def process_and_encode(clip_name: str, workdir: Path) -> dict:
        nonlocal total_processed_bytes
        src = clips_dir / clip_name
        final = process_clip(src, fade_out_ms, workdir)
        data = final.read_bytes()
        total_processed_bytes += len(data)
        mime = mimetypes.guess_type(final.name)[0] or "audio/mp4"
        # Final-file duration (post fade/trim), used by defaultClips' song
        # picker (mockups/portal-screens.html screen 7: "Hype Track 1 · 0:12")
        # -- cheap to probe again here rather than threading it back out of
        # process_clip's internals.
        duration_sec = probe_duration(final)
        return {"mime": mime, "data": base64.b64encode(data).decode("ascii"), "durationSec": round(duration_sec, 1)}

    with tempfile.TemporaryDirectory(prefix="kickball-build-") as tmp:
        workdir = Path(tmp)
        for p in manifest["players"]:
            clip_entries = []
            for clip_name in p["clips"]:
                print(f"  processing {p['id']}: {clip_name} ...", file=sys.stderr)
                clip_entries.append(process_and_encode(clip_name, workdir))
            entry = {
                "id": p["id"],
                "name": p["name"],
                "status": p.get("status", "member"),
                "clips": clip_entries,
            }
            # Optional manual 2-letter runner code (2026-07-13, Jason):
            # overrides the app's derived code for the diamond labels.
            if p.get("code"):
                entry["code"] = str(p["code"]).upper()[:2]
            players_out.append(entry)
        for s in manifest["teamSounds"]:
            clip_entries = []
            for clip_name in s["clips"]:
                print(f"  processing teamSounds/{s['id']}: {clip_name} ...", file=sys.stderr)
                clip_entries.append(process_and_encode(clip_name, workdir))
            team_sounds_out.append({
                "id": s["id"],
                "name": s["name"],
                "kind": s["kind"],
                "clips": clip_entries,
            })
        for i, clip_name in enumerate(manifest["defaultClips"]):
            print(f"  processing defaultClips: {clip_name} ...", file=sys.stderr)
            entry = process_and_encode(clip_name, workdir)
            entry["id"] = "default-" + str(i)
            entry["name"] = default_clip_display_name(clip_name)
            default_clips_out.append(entry)

    payload = {
        "team": manifest["team"],
        # Team shorthand for scoring surfaces (score bug, scorecard) --
        # optional; app falls back to initials-of-team when empty.
        "teamShort": manifest.get("teamShort", ""),
        "theme": theme,
        "fadeOutMs": fade_out_ms,
        # 2026-07-13 (Jason): clips fade IN too, so they don't blast on at
        # full volume. 0 disables.
        "fadeInMs": manifest["settings"].get("fadeInMs", 500),
        "autoPlayDelayMs": manifest["settings"].get("autoPlayDelayMs", 2000),
        "players": players_out,
        "teamSounds": team_sounds_out,
        "defaultClips": default_clips_out,
        # Schedule + venue ship even when scoring is disabled (cheap, static
        # JSON -- unlike audio there's no processing cost to gate) so a
        # manifest edit that only flips scoring.enabled later doesn't also
        # need the schedule re-added.
        "schedule": manifest["schedule"],
        "venue": manifest["venue"],
        "scoring": {
            # supabaseUrl/supabaseAnonKey ship even when disabled -- see
            # 05-Scoring-Architecture.md: the anon key is public-by-design,
            # and keeping them in the payload means flipping `enabled` to
            # true later is a manifest edit, not a credentials hunt. The
            # `enabled` flag itself is the only thing app-side code reads
            # to decide whether to run the scoring layer at all.
            "enabled": manifest["scoring"]["enabled"],
            "supabaseUrl": manifest["scoring"]["supabaseUrl"],
            "supabaseAnonKey": manifest["scoring"]["supabaseAnonKey"],
            "teamPin": manifest["scoring"]["teamPin"],
            "inningsPerGame": manifest["scoring"]["inningsPerGame"],
        },
    }

    # Content-hash cache id, computed from the build INPUTS (template text +
    # rendered payload JSON) rather than the final HTML. Two reasons:
    # (1) same cache-busting guarantee -- a code fix to app.template.html or
    #     any roster/clip change alters the inputs exactly as much as the
    #     output, so the service worker cache still busts on every real
    #     change (hashing only the payload was a real bug caught during the
    #     first build session: shipped code fixes never reached cached
    #     phones);
    # (2) hashing the inputs lets the id be INJECTED INTO THE PAGE ITSELF
    #     (__BUILD_ID__, shown in the field-debug readout) -- hashing the
    #     final HTML can't do that, since embedding the hash would change
    #     the hash. Added 2026-07-07: game 1's fixes were invisible ("am I
    #     on the new version?" had no answer without visual changes).
    html, cache_id = render_html(payload)
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


def strip_scoring_blocks(template: str) -> str:
    """Remove everything between `/* __SCORING_START__ */` and
    `/* __SCORING_END__ */` marker pairs (and their HTML-comment equivalents
    `<!-- __SCORING_START__ -->` / `<!-- __SCORING_END__ -->`) from
    app.template.html when `scoring.enabled` is false.

    This is the mechanism referenced in 05-Scoring-Architecture.md's
    manifest section ("scoring.enabled: false ... build.py can strip the
    block ... absent preferred"). No markers exist in the template yet as
    of S1 item 1 -- scoring UI/logic lands in S1 items 2-7 and MUST wrap
    itself in these markers as it's added, so this function has something
    to strip. Until then this is a documented no-op (zero matches, template
    passes through unchanged), which is why parity holds today.

    Both marker flavors are supported because scoring code will land in
    both <style> (CSS comments) and <script> (works as either) contexts.
    Non-greedy, DOTALL match; unmatched/unbalanced markers fail loudly
    rather than silently mis-stripping half the template.
    """
    pattern = re.compile(
        r'(?:/\*\s*__SCORING_START__\s*\*/|<!--\s*__SCORING_START__\s*-->)'
        r'.*?'
        r'(?:/\*\s*__SCORING_END__\s*\*/|<!--\s*__SCORING_END__\s*-->)',
        re.DOTALL,
    )
    starts = template.count('__SCORING_START__')
    ends = template.count('__SCORING_END__')
    if starts != ends:
        raise BuildError(
            f"Unbalanced scoring markers in template: {starts} start(s), {ends} end(s)."
        )
    return pattern.sub('', template)


def render_html(payload: dict) -> tuple:
    """Returns (html, build_id). build_id doubles as the SW cache id."""
    if not TEMPLATE_PATH.exists():
        raise BuildError(f"Template not found: {TEMPLATE_PATH}")
    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    if not payload["scoring"]["enabled"]:
        template = strip_scoring_blocks(template)
    # Escape "</" so no player/team string can terminate the <script> tag
    # early (json.dumps doesn't escape forward slashes). "<\/" is identical
    # to "</" once JSON-parsed, so the payload is unchanged.
    payload_json = json.dumps(payload).replace("</", "<\\/")
    build_id = hashlib.sha256((template + payload_json).encode()).hexdigest()[:10]
    html = template.replace("__PAYLOAD_JSON__", payload_json)
    html = html.replace("__TEAM_NAME__", payload["team"])
    html = html.replace("__BUILD_ID__", build_id)
    return html, build_id


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
