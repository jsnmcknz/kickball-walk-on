# Feature Specs — Build-Ready

Written 2026-07-07 (Fable 5 planning session) so a later session can implement mechanically. Design decisions are **made here**, not re-opened during implementation — if one proves wrong on-device, change it deliberately and note it, don't drift. Every spec must respect `03-Invariants.md`; each lists which invariants it touches. Suggested implementation order: **A+B together → C → D → E+F together → G/H as wanted.**

General rules for all specs: manifest is the only config surface (invariant 18); nothing adds taps to the walk-up flow; `node dom-stub-test.js` extended + passing before ship; every ship ends with "ready to push" + build id.

---

## A. Manifest trim points (workflow multiplier — do first)

**What:** full songs live in `clips/`; the manifest declares the cut window; build.py cuts. Only the processed clip is embedded in the published file.

**Manifest:** a `clips` array entry becomes either a bare string (back-compat, processed exactly as today) or:

```json
{ "file": "megan-full.mp3", "start": 43.5, "duration": 16 }
```

`start` seconds (float, ≥ 0, default 0); `duration` seconds (float, > 0, optional — omitted = to end of file). Validate in `load_manifest`: file key present, types sane; fail loudly (existing BuildError pattern).

**build.py:** in `process_clip`, when a window is given, add accurate seek to the stage-1 ffmpeg call: `-ss {start}` **after** `-i` (accurate mode; we re-encode anyway, and clip starts must be beat-precise), plus `-t {duration}` when given. **Skip `silenceremove` for windowed clips** — an explicit `start` is the human saying where the clip begins; the auto-trimmer second-guessing it is a bug, not a feature. Loudnorm/fade/encode unchanged.

**App changes: none. Test changes: none** (build-side only; the payload shape is unchanged). Verify by building with one windowed clip and listening to `dist/index.html`.

**Repo-size tradeoff:** full songs add a few MB each to git. Acceptable; if it ever grates, a gitignored `clips/full/` subfolder works while Jason is the only builder (documented tradeoff, Jason's call later).

## B. Per-clip gain (do with A — same functions)

**What:** manual loudness override for when park acoustics disagree with EBU R128.

**Manifest:** optional `"gain": 2.5` (dB, float, clamp to ±10 with a build warning beyond ±6) on any clip object.

**build.py:** append `volume={gain}dB` as the **last** filter in the stage-2 (fade/encode) chain — after loudnorm, so it's a trim on the normalized level, not fighting it.

**App/test changes: none.**

## C. Service-worker update indicator (~20 lines + one update-dance to verify)

**What:** kill the count-to-ten ritual — the app says when a new version is ready.

**Mechanics:** in the page (near SW registration): if `navigator.serviceWorker.controller` is non-null at load (i.e. NOT the first install), listen for `controllerchange` on `navigator.serviceWorker`; when it fires, a new SW has taken over (our sw.js does `skipWaiting()` + `clients.claim()`) → show the notice. The controller-at-load guard is the critical part: without it the notice fires on first install. Belt-and-suspenders: also listen `registration.updatefound` → `newWorker.statechange === 'activated'`.

**UI:** a chip styled like `.debug-panel` (same position slot, above the tab bar; if the debug panel is open, stack above it), `pointer-events: none`, text: **"Update downloaded — close the app fully and reopen"**. Persistent once shown (no auto-dismiss; the instruction *is* the dismissal). Not a button — the reopen is a physical action the app can't do for itself.

**Invariants touched:** 16 (readout positioning), 17 (this doesn't remove the CDN delay — it makes the SW half visible). **Tests:** stub `navigator.serviceWorker` minimally to assert the guard logic (no notice when controller was null at load; notice on controllerchange otherwise). On-device: full push → wait → open → chip appears → reopen → new build id in readout.

## D. Announcer intros (the marquee; zero app-code change)

**What:** "Nooow kicking… MEGAN!" before each walk-up. **Entirely build-time: the intro is concatenated into the player's processed clip.** The app never knows intros exist — no changes to the play path (invariant 1), countdown just includes the intro (fine), tap-to-fade fades the whole thing (fine).

**Manifest:** optional per-player `"intro": "intros/megan.m4a"` (recorded file, relative to `clips/`) — recorded-by-teammates is the v1 path; it's funnier than TTS and has no dependencies. A `{ "tts": "Now kicking, MEGAN!" }` variant is a **later** extension; if added, generate via macOS `say -v <voice>` on Jason's machine, cache output in `clips/intros/generated/<sha of text+voice>.aiff`, never re-generate on unchanged text.

**build.py:** process intro (silenceremove + loudnorm, NO fade) and walk-up (as today) separately, then concat with 0.25s of silence between: ffmpeg `concat` filter, single re-encode to AAC. Intro loudness: same loudnorm target as clips — announcer punch comes from the recording, not from mixing hotter.

**Ops doc:** one paragraph in `docs/` on recording intros (phone voice memo is fine; any format ffmpeg reads; yell into the mic).

**Tests: none needed** (payload shape unchanged). Verify by ear on `dist/`.

## E. Record-scratch stop (small, loud laugh; touches a sacred path — care)

**What:** tap-to-stop does a vinyl-brake instead of a fade.

**Manifest:** `settings.stopEffect: "fade" | "scratch"` (default `"fade"` — this ships reversible). Build embeds a ~0.5s scratch sample (one extra base64 asset in the payload, `settings`-level, processed like a clip but no fade) only when `"scratch"` is set.

**App:** in `stopCurrent`, when effect is scratch AND this is a *user-tap* stop: start the scratch sample as a fire-and-forget source (see F's stateless pattern) and hard-stop the music simultaneously (existing non-fade path). **Backgrounding/pre-empt stops never scratch** (invariant 4 — silent stop stays silent; `playClip`'s internal pre-emptive stop also stays silent, the new song *is* its own transition). Captions change with the mode (invariant 14): scratch mode reads "tap to stop".

**Tests:** scratch fires only on tap-stop paths; caption matches mode; fade mode byte-identical behavior to today.

## F. Stinger pad (airhorn, charge, sad trombone…)

**Placement decision:** a single compact horizontal strip at the top of the **Soundboard** (formerly "All Songs"), between the header hint and the grid — NOT a third tab (the tab bar is a two-slot slider; a third slot is a nav redesign for five buttons), NEVER on Next Up (firm principle 1). Renders only if the manifest declares stingers. Small square buttons, emoji + tiny label.

**The load-bearing design rule: stingers are stateless.** Fire-and-forget: each tap creates a source on a dedicated gain node and lets it end. They MIX with a playing walk-up (never stop/duck it), have no stop control (they're 1–3s), no countdown, never touch `currentSource`/`playingId`/pointer machinery. This is what keeps the sacred play path untouched — if a stinger ever needs state, it's been designed wrong.

**Manifest:** `settings.stingers: [{ "id": "airhorn", "label": "📣", "file": "stingers/airhorn.mp3" }, …]` (cap ~6; build warns beyond). Processed like clips (loudnorm, no fade, trim-window support from spec A applies).

**Interaction with audio-context rebuild:** stinger taps go through the same `ensureRunning` logic path as `playClip` (state check → rebuild in-gesture) — factor that guard into a tiny shared helper rather than duplicating; keep it synchronous (invariant 1).

**Tests:** stinger tap while a walk-up plays leaves `playingId`/pointer untouched; stinger tap on a wedged context rebuilds (reuse test-22 pattern).

## G. Alternating clips per player (modest; watch file size)

**What:** `clips` arrays with 2+ entries cycle per at-bat. Today only `clips[0]` is used.

**App:** `buffers` becomes `playerId → [AudioBuffer,…]`; `playClip` picks `clipIndex[playerId] % n` and increments **only for lineup plays** (grid overrides replay the *current* clip — an override retap mid-inning shouldn't burn the next song). Persist `clipIndex` map in localStorage. Decode-all cost grows linearly — build.py should print per-player and total sizes, and the roadmap's ≤25s-per-clip guidance applies doubly.

**Tests:** rotation on lineup advance; override doesn't rotate; single-clip players unaffected.

## H. Season stats — collect now, present later

**What:** the cheapest possible version, shipped early because the data compounds: every play-tap appends `{playerId, ts, source: "lineup"|"grid"}` to a localStorage ring buffer (cap 2000, drop-oldest). ~10 lines inside `playClip`. **No UI this season** — at season's end, a recap session reads the log (extend the debug readout with a tap-count line, or pull via Safari devtools) and makes something fun for the team. Presentation is deliberately unspecced until the data exists.

**Tests:** ring cap respected; entries shaped right; storage failure silent (existing saveJSON pattern).

---

## Not specced on purpose

**Rally mode / team-state family** — real UX questions first, in a session with Jason: where does a rally trigger live without adding taps or crowding Next Up (long-press? a stinger-strip slot? shake?); loop mechanics and exit conditions (auto-duck on walk-up? manual off?); does "between-innings music" belong to the same control or a different one; is this even wanted before the playoffs. Design the family together when the first member lands (per roadmap).

**Birthday mode / guest kicker riff** — one-line manifest features; spec-on-demand when wanted (birthday: build-time is wrong — the *app* knows the date; guest: a default clip entry under a reserved `guest` id, playClip already handles unknown-id no-ops).

**Player photos** — pure polish, real file-size cost; revisit only if the team asks.
