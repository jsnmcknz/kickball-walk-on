# Invariants — Things That Look Weird On Purpose

**Audience: future AI sessions (and future Jason).** Every entry here is a hard-won platform lesson, mostly paid for at game 1 (2026-07-06) or in the on-device debugging session after it (2026-07-07). Each one *looks* like something a tidy refactor would simplify. Do not simplify it. If a change touches one of these, re-verify the invariant on-device before shipping.

The test suite (`node dom-stub-test.js`, must pass before any ship) covers some of these; the rest only show up on a real iPhone. Test numbers referenced below.

---

## Audio engine

**1. The play path must stay synchronous from state-check to `source.start()`.**
In `playClip`, there is no `await` between checking `ctx.state` and starting the source. An `await` leaves the user-gesture call stack, and iOS will refuse to unlock a rebuilt AudioContext outside a gesture. This is why `playClip` looks like it should await `resume()` and doesn't. *(Tests 22–23.)*

**2. Rebuild, never trust `resume()`.**
After a screen lock, iOS parks the context in the nonstandard **`interrupted`** state (not `suspended`), and `resume()` from it can no-op forever (WebAudio/web-audio-api#2585). Any not-running context at tap time is closed and replaced synchronously in-gesture, reusing the decoded AudioBuffers. This was game 1's "app dead after sleep" bug, and the fix was field-confirmed 2026-07-07 (readout: `rebuild: suspended at tap → audio: running`). Buffer reuse across contexts is confirmed working on the team phone. *(Tests 22–23.)*

**3. The watchdog retries exactly once.**
`armAudioWatchdog` rebuilds + replays a clip whose context isn't running ~600ms after start — once per tap (`_watchdogRetry`), never looping. A second failure waits for the next real tap, which heals in-gesture. *(Test 23.)*

**4. Backgrounding is an explicit stop.**
iOS forcibly interrupts a standalone web app's audio when it leaves the foreground — unfixable, even with `<audio>`/Media Session. `visibilitychange → hidden` therefore stops cleanly and advances the lineup. Don't try to "fix" background playback. *(Test 17.)*

**5. The silent switch mutes the app entirely.**
WebKit routes Web Audio through the "ambient" session; the ring/silent switch silences it (confirmed on the team phone) even though music apps keep playing. Not fixable in code — handled operationally (pre-game checklist).

## Rendering

**6. The countdown tick updates ONE text node, never `render()`.**
A 5×/sec full re-render meant any tap straddling a tick landed on a detached DOM node and silently died — game 1's intermittent dead taps, worst on tap-to-stop (which only happens while ticking). Each `render()` installs a fresh `liveCountdownUpdate` closure for whichever countdown is on screen. The tick must never grow back into a re-render.

**7. `render()` sweeps drag debris; drags commit via document-level listeners.**
Safari can stop delivering a captured pointer stream after the captured element is DOM-moved repeatedly (long drags, game 1: frozen ghosts). Once a drag starts, move/up/cancel live on `document` keyed by `pointerId`, and every `render()` deletes stray `.drag-ghost`/`.drag-placeholder` nodes. Both layers are required.

**8. Fixed 78px tile height, both states.**
The playing tile's extra lines (stop icon + countdown) must never grow its row — the grid used to reshuffle mid-game. Guest tile is deliberately exempt. The stop icon's asymmetric margins (3px top / 5px bottom) are optically tuned on-device — "equal" margins read unequal because of the glyph's own headroom. Same story on the NOW UP card: the stop square occupies the same 42px vertical footprint as the play triangle (4+22+16 = 0+30+12) because `box-sizing: border-box` makes the square 8px shorter than the border-drawn triangle, and the centered card stack re-centers on the swap. The name's 4px-top/8px-bottom margins are also optical (all-caps line-box headroom). **Do not equalize any of these margins.**

**9. Global `touch-action: manipulation`; `.order-tile` keeps `touch-action: none`.**
iOS has ignored `user-scalable=no` since iOS 10 — without `manipulation`, rapid taps read as double-tap-zoom attempts and the gesture recognizer swallows subsequent taps (tab buttons went dead until a fidget). The `*` rule also carries `user-select: none` (drags read as text selection otherwise: loupe, blue ranges). `.order-tile`'s `touch-action: none` wins on specificity — required for drag.

**10. `h()` only sets `disabled` when truthy.**
`setAttribute('disabled', null)` still disables an element, permanently. The conditional in `h()` is the fix for a real shipped bug. *(Test 5b guards it.)*

## Interaction semantics

**11. The grid is modeless (firm principle 5, structural form).**
The Soundboard tab (formerly "All Songs") always renders the play soundboard — full, partial, or empty order, mid-edit or not. No order button, no modes, no route into editing from it. The editor lives on the Lineup tab (`state.editing`), survives a peek at the Soundboard, and only Done exits it. The 2026-07-06 version had editing as a grid mode and grew an unreachable-grid bug; the relocation removed that bug *class*. *(Test 19.)*

**12. Deferred lineup advance; manual moves win.**
A lineup clip's pointer advance happens when the clip ends or is stopped — not on tap — so the card never disagrees with what's playing. A manual skip/back/on-deck jump during playback resolves the turn; the stale clip ending must not double-advance (`pendingLineupSource`/`pendingLineupStartPointer`). *(Tests 7, 10b, 10c.)*

**13. Double-tap guard: 400ms, play-taps only.**
Taps-to-stop within `STOP_TAP_GRACE_MS` of play start are ignored (excited double-tap = play + instant skip otherwise). Applies to the card and grid tiles; backgrounding and every other stop path are exempt. *(Tests 7a2, 12.)*

**14. Tap-to-stop fades.**
`stopCurrent(true)` ramps over `fadeOutMs`; the captions say "tap to fade out" because that's what happens. If a stop path ever becomes a hard cut (e.g. record-scratch mode), the caption must change with it.

## Build & delivery

**15. Build id hashes the INPUTS (template + payload JSON), not the output HTML.**
Hashing the final HTML can't work — the id is injected into the page (`__BUILD_ID__`), and embedding a hash changes the hash. Input-hashing gives identical cache-busting (any real change alters the inputs) *and* a visible id. The id must stay identical in three places: `BUILD_ID` in the page, `CACHE_NAME` in sw.js, and build.py's console output. History note: hashing only the manifest/clips payload was an earlier real bug — code fixes never busted caches.

**16. The debug readout is load-bearing.**
5 wordmark taps toggle it; it's the only way to answer "which build is this phone running?" (no visual diff between most builds) and it diagnosed the game-1 audio wedge from a screenshot. It must stay `pointer-events: none`, positioned *inside* the #app card (`position: fixed` at viewport bottom landed in the gutter under the home indicator — invisible). Keep `build:` as its first field.

**17. Update propagation has two independent delays.**
GitHub Pages' CDN caches ~10 minutes after a push; then the service worker needs one full open (fetch new sw.js in background) → close → reopen cycle. Safari-tab and home-screen-app are separate SW instances — each needs its own cycle. "It didn't update" is almost always one of these, not a bug.

**18. Single artifact, offline, manifest-driven (firm principles 1–3).**
No runtime network calls, ever. Features are manifest/config changes compiled by build.py, not app-side settings UI — configuration creeping into the app creates two sources of truth. And nothing may add taps to the core walk-up flow.

## Process

**19. `node dom-stub-test.js` before any ship.** 24 groups as of 2026-07-07. The stub harness evals the template's `<script>` with fake DOM/AudioContext — it catches state-machine and wiring regressions, not visual or gesture ones. On-device checks remain mandatory for anything touching CSS, drag, or audio.

**20. Jason pushes; AI sessions never run git against this repo.** A sandboxed `git status` once left a stale `index.lock` the sandbox couldn't remove. Builds and file edits are done by the session; add/commit/push is Jason's, with an explicit "ready to push" + build id handoff at the end of each round.
