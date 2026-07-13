# Invariants — Things That Look Weird On Purpose

**Audience: future AI sessions (and future Jason).** Every entry here is a hard-won platform lesson, mostly paid for at game 1 (2026-07-06) or in the on-device debugging session after it (2026-07-07). Each one *looks* like something a tidy refactor would simplify. Do not simplify it. If a change touches one of these, re-verify the invariant on-device before shipping.

The test suite (`node dom-stub-test.js`, must pass before any ship) covers some of these; the rest only show up on a real iPhone. Test numbers referenced below.

---

## Audio engine

**1. The play path must stay synchronous from state-check to `source.start()`.**
In `playClip`, there is no `await` between checking `ctx.state` and starting the source. An `await` leaves the user-gesture call stack, and iOS will refuse to unlock a rebuilt AudioContext outside a gesture. This is why `playClip` looks like it should await `resume()` and doesn't. *(Tests 22–23.)*

**2. Rebuild, never trust `resume()`.**
After a screen lock, iOS parks the context in the nonstandard **`interrupted`** state (not `suspended`), and `resume()` from it can no-op forever (WebAudio/web-audio-api#2585). Any not-running context at tap time is closed and replaced synchronously in-gesture, reusing the decoded AudioBuffers. This was game 1's "app dead after sleep" bug, and the fix was field-confirmed 2026-07-07 (readout: `rebuild: suspended at tap → audio: running`). Buffer reuse across contexts is confirmed working on the team phone. *(Tests 22–23.)*

**3. The watchdog retries exactly once, then fails visibly.**
`armAudioWatchdog` rebuilds + replays a clip whose context isn't running ~600ms after start — once per tap (`_watchdogRetry`), never looping. A second failure waits for the next real tap, which heals in-gesture — but (2026-07-12 amendment) it no longer sits there silently claiming to be "playing" while it waits: it resets to idle (`stopCurrent(false, {advanceIfPending:false})`, no lineup-advance since nothing actually played) so the operator sees "not playing" immediately instead of a countdown that will never resolve. *(Test 23.)*

**4. Backgrounding is an explicit stop.**
iOS forcibly interrupts a standalone web app's audio when it leaves the foreground — unfixable, even with `<audio>`/Media Session. `visibilitychange → hidden` therefore stops cleanly and advances the lineup. Don't try to "fix" background playback. *(Test 17.)*

**5. The silent switch mutes the app entirely.**
WebKit routes Web Audio through the "ambient" session; the ring/silent switch silences it (confirmed on the team phone) even though music apps keep playing. Not fixable in code — handled operationally (pre-game checklist).

**6. Scoring's timer-fired auto-play can't self-heal from a real sleep — this is a policy wall, not a bug.**
`scheduleScoringAutoPlay`'s `setTimeout` callback (and its one watchdog retry) both run *outside any user gesture*, unlike every tap-triggered play in this file. Invariant 1's whole fix depends on staying inside a gesture's call stack; a timer callback was never in one to begin with, so if the device has genuinely slept in between (screen actually locked — not just idle), no amount of rebuild/retry from here can unlock the new AudioContext, full stop. This is what Jason saw live (2026-07-12): auto-play frozen at the initial stage, no progress, no countdown, no error. It is **not** fixable by restructuring this code further — iOS requires a real tap to unlock audio, and a timer firing after a sleep cycle categorically isn't one. The fix is operational: verify Settings → Display & Brightness → Auto-Lock is actually "Never" on the scoring device (the documented primary defense, invariant note above wake lock in `app.template.html`), and/or run Guided Access during games (prevents the screen from sleeping/locking at the OS level, independent of this app's own best-effort Wake Lock API call, which many older iOS/Safari versions don't even implement). Watchdog give-up now at least fails *visibly* (see invariant 3) so a missed auto-play is obvious and one manual tap away from recovering, rather than a silent, confusing hang.

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

**10b. `body` is locked (`position: fixed; overflow: hidden`) — only `#screen` may ever scroll.**
`#app` is `position: fixed` with explicit top/left/right/bottom insets, and `#screen` inside it is the one `overflow-y: auto` region — that's supposed to be the only thing that scrolls, ever. `overscroll-behavior-y: contain` on `html, body` looked sufficient (it stops scroll-chaining to native gestures like pull-to-refresh) but does NOT stop `body` itself from being draggable. On a screen taller than one viewport — first caught on the mid-game lineup editor (full roster + full add-grid + done/cancel row easily exceeds one screen) — standalone home-screen Safari let the whole page drag: `#app` and its sibling `.tabbar` visibly moved together as one unit, revealing content that should have been clipped below the physical screen edge (Jason, 2026-07-12, on-device: "tap and drag [the tab bar] down to the bottom of the screen"). Locking `body` itself to `position: fixed; top:0; left:0; width:100%; overflow:hidden` forces literally all scroll through `#screen`. If a future screen still looks like it's dragging as a whole rather than scrolling its own content, this is the first thing to re-check, not `#screen`'s own CSS.

**10c. [RESOLVED 2026-07-13] Bottom gap between the tab bar and the home indicator.**
Root cause, established by putting every viewport source in the debug readout (`vp[SA]: sh812 vv772 ih772 ce772`): **the viewport numbers were never wrong.** The standalone install draws a native status bar, so the web view starts below it (hence `screen.height` = 812 vs everything else = 772 — never use screen.height for sizing, it clips the card off the bottom; it stays in the readout for diagnosis). The "gap" was the *designed-in* bottom reserve: `#app`'s `clamp(12px, env(safe-area-inset-bottom), 40px)` ≈ 34px plus the tab bar's margin. Resolution: `--real-vh` = max(visualViewport, innerHeight) (attempt #4's machinery, kept — body sized off it, `#app` absolute); `#app`'s bottom inset is a flat **8px** so the card frame runs to the screen edge; the home-indicator clearance lives on `.tabbar`'s bottom margin (`max(10px, env(safe-area-inset-bottom) − 12px)`). Do not "restore" the env clamp on `#app`'s bottom or swap the measurement to any CSS-only viewport unit — that's four failed attempts' worth of lesson. The attempt history below is preserved for archaeology:
1. `#app`'s top/bottom insets capped with `clamp(12px, env(safe-area-inset-*), 40px)` (was unbounded `max()`) — belt-and-suspenders regardless of root cause, kept.
2. Dropped `maximum-scale`/`user-scalable=no` from the viewport meta tag (now just `width=device-width, initial-scale=1.0, viewport-fit=cover`) — a documented iOS bug pairs those with `viewport-fit=cover` to throw off `env(safe-area-inset-*)`. Costs nothing either way: invariant 9 already established iOS ignores `user-scalable=no` as a meta directive since iOS 10; `touch-action: manipulation` (CSS, untouched) is what actually blocks double-tap-zoom. **Jason confirmed this did NOT close the gap.**
3. `html, body`'s `height` changed from static `100%` to `100dvh` (dynamic viewport height, iOS 15.4+, with `100%` kept as a fallback line before it) — per further research Jason found, a static percentage height can resolve against a stale/cached viewport in iOS standalone PWA mode, notably after repeated launches/navigation; `dvh` is the unit built to track the live viewport instead. Unconfirmed as of this writing.

4. **[attempt #4, 2026-07-13 — FAILED on-device]** `syncRealViewportHeight()` measures the live viewport in JS (`visualViewport.height`, `innerHeight` fallback) into `--real-vh`; `body { height: var(--real-vh, 100%) }` (fallback deliberately `100%`, NOT `dvh` — an invalid-at-computed-value var fallback would nuke the earlier height declarations instead of yielding to them); `#app` switched `position: fixed` → `absolute` to anchor to body's corrected box. Gap survived → conclusion: the JS sources themselves report the short viewport.
5. **[attempt #5, 2026-07-13 — overshot, but its instrumentation solved the case]** `screen.height` joined the candidate set on the theory that standalone + `viewport-fit=cover` spans the full screen. Wrong — the readout it added proved the web view sits below a native status bar (812 vs 772), the card clipped off-screen, and the same numbers showed vv/ih had been correct all along. Removed from the candidates the same day; the readout line stays permanently.

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
No feature may *require* the network mid-game *(amended 2026-07-13 with the S2 sync build, tracking firm principle 2's own 2026-07-07 amendment — the original text here said "no runtime network calls, ever")*. Walk-up playback stays 100% offline-embedded. The scoring sync layer is the one sanctioned network user, and it is fire-and-forget by construction: the localStorage event log IS the queue, no live path ever awaits a response, and a flush failure is silent (debug readout + sync chip, never a modal). Features are manifest/config changes compiled by build.py, not app-side settings UI — configuration creeping into the app creates two sources of truth. And nothing may add taps to the core walk-up flow.

**18b. Sync is additive bookkeeping, never authority.** `scoringSync_v1` only remembers how far each game has been pushed (`syncedThroughSeq` cursors keyed by the game_start event id, plus the Supabase row id). Deleting it entirely is safe — the next flush re-upserts everything and the `(game_id, device_id, seq)` unique constraint deduplicates server-side (`Prefer: resolution=ignore-duplicates`). Local event ids are short strings, NOT uuids: inserts must keep omitting the `id` column. *(Tests: group 74.)*

## Process

**19. `node dom-stub-test.js` before any ship.** 24 groups as of 2026-07-07. The stub harness evals the template's `<script>` with fake DOM/AudioContext — it catches state-machine and wiring regressions, not visual or gesture ones. On-device checks remain mandatory for anything touching CSS, drag, or audio.

**20. Jason pushes; AI sessions never run git against this repo.** A sandboxed `git status` once left a stale `index.lock` the sandbox couldn't remove. Builds and file edits are done by the session; add/commit/push is Jason's, with an explicit "ready to push" + build id handoff at the end of each round.
