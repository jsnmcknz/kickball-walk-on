# Portal Architecture — the app as team surface

Decisions from the 2026-07-08 session's closing conversation (round 6, Jason-initiated), written up 2026-07-11. Those decisions were provisional until documented; **this file is the write-up that makes them of record.** Nothing here is built yet.

**Design authority:** this document is normative for *app identity, boot posture, the schedule, and the stats portal*. `05-Scoring-Architecture.md` remains normative for scoring data/logic, `03-Invariants.md` for platform behavior, `mockups/scoring-screens.html` for the screens it covers. No portal screen has a mockup yet — one is needed before the portal build session (same lesson as always: prose under-specifies optics).

---

## Identity expansion

The app stops being an operator-only tool. **Every team member installs it** (same URL, same artifact, Add to Home Screen). What a device is *for* determines what it boots into. *(Refined by Jason 2026-07-11, superseding the round-6 sketch where scorer devices booted to Next Up — in the refined model, everyone starts at the portal; game mode is entered by schedule/game-state, not by device role alone.)*

- **Most of the team** → the **season stats portal** (season + per-game stats, schedule). For most members, most of the time, the app is "how's our season going?" — not a soundboard. **Music for regular members — DECIDED 2026-07-11 (mockup round):** no soundboard *screen*; instead a **play button on each player row** in the portal's team list plays that kicker's walk-up clip through the normal one-sound-at-a-time engine (playing row = plum stop control, as everywhere). The clips ship in everyone's artifact regardless (single-artifact principle), so this is pure UX surface, not payload. Normative appearance: `mockups/portal-screens.html` screen 1.
- **Scorer devices** (Jason as primary; 2nd/3rd scorers who may take over) → also boot to the stats portal, with **scoring modes a tap or two away**; around game time a context-aware prompt offers scoring mode (rule below).
- **The team phone** is a scorer device that is also the music device; in game mode it runs the merged scoring + walk-up surface (the auto-play synergy lives there). The walk-up flow's one-tap guarantee is preserved *inside* game mode via the NOW UP card, and the Soundboard stays one tab away (principle 5). **Hardware detail (Jason, 2026-07-11):** the team phone is SIM-less but has Wi-Fi at home and can pair to Jason's active phone's hotspot at games — so mid-game live sync from the team phone is realistic, softening 05's airplane-mode framing and shrinking the split-posture problem. **It should almost always be in game mode**: boot = live game → game screen; game window → Start-game flow directly, skipping the prompt; otherwise → Next Up, never the portal. Enforcement mechanic (options, not yet picked): (a) role in the home-screen bookmark URL (`index.html#team` — lives in the installed icon, survives localStorage eviction, re-add icon to change role; recommended) or (b) a persisted "team phone" toggle near the debug readout (one tap, but evictable with localStorage).

Score mode remains **PIN-gated and team-phone-primary**. S2's scorer-lock takeover is the emergency path (dead team phone), not a routine posture.

### Posture-aware boot rule (refined 2026-07-11, second pass — prompt-based game-mode entry)

1. **Live game in progress on this device** (a `game_start` without `game_end` in the local log) → game screen, wherever the half is. Game state wins over everything, including the schedule window. This is also the team phone's mid-game reopen path — no prompt, no taps, straight back in.
2. **Any device opening inside a game window** — from 60 minutes before a scheduled fixture's start until 60 minutes after it *(tightened from end-of-day, Jason 2026-07-11: games run ~50 minutes)* — gets a **context-aware prompt** on top of the portal: "Game tonight vs {opponent} — score it?" Accepting leads through the PIN gate (skipped if this device is already PIN-unlocked) into the **Start game flow** (fixture pre-picked → set the game roster/lineup → `game_start`), then the main scoring interface. Declining (or ignoring) leaves the user in the portal. Roster-setting is the explicit first step at/before game start. *(Jason's second-pass rationale: most members won't open the app around game time at all, so a prompt on open costs nothing broadly, and auto-booting scorer phones into game mode was presumptuous — the scorer chooses, one tap.)*
3. **Everyone, otherwise** → stats portal. PIN-unlocked devices keep scoring entry a tap or two away at all times (not only in the window).

**Scorer-device detection — DECIDED (Jason, 2026-07-11): the persisted PIN unlock is the flag.** A device that has entered score mode (PIN against `scoring.teamPin`, once per device) skips the PIN gate thereafter. Zero new config, works offline, the team phone qualifies automatically, and handing scorer capability to a 2nd/3rd scorer = telling them the PIN. Rejected: manifest device list (rebuild to re-role a phone fights principle 3's spirit). Under the prompt-based rule the flag no longer changes *where* a device boots — it only smooths the path into scoring (no PIN re-entry).

**Schedule-window mechanics:** needs only the device clock + the manifest schedule — fully offline. The window closes 60 minutes after scheduled start, but rule 1 means an unclosed game stays in game mode regardless — the window only governs *entering* game mode, never *exiting* it. A scorer who only remembers later can still enter scoring from the portal at any time (rule 3).

**Open wrinkle — the split posture (flagged, not solved):** 05's "two postures, one URL" allows the scorer to score on their own phone while the team phone plays music. In that split, the team phone isn't the scoring device, but it still needs its walk-up surface operable — and without S2 sync it has no view of the remote scorer's pointer. Likely answer: the team phone simply runs classic Next Up, manually operated, exactly as today (degradation ladder already covers this). Confirm when S2 lands; until then the split posture is score-on-team-phone or manual-music.

---

## Season stats portal (default posture)

**v1 scope: H / R / RBI first.** Season leaderboards and per-player lines over the honest-denominator model already specced (S3 item 1 in `06-Scoring-Specs.md` — the portal is that view promoted to the app's front door, plus the schedule). Spray charts, trends, and AI analysis come later — and the heavier analysis lives **outside the app** via the S3 season export (CSV/Airtable), not as in-app features. The artifact stays lean; the file-size budget belongs to audio.

Portal shows: season record + schedule (next game up top), leaderboards, per-game results (from event data where it exists, from the manifest `result` field for pre-app games like game 1 — honestly marked score-only). A scored game taps through to its **game detail**: line score, the snake scorecard, and per-player game lines (AB·H·RBI·R, default sort H descending, tap-to-sort column headers with an active indicator, second tap flips direction). Read-only; no PIN. Normative appearance: `mockups/portal-screens.html`.

**Data path note:** stats derive from the event log, which lives per-device. Until S2 sync exists, a non-scorer phone has no events and the portal shows schedule + manifest results only. The portal reaches full value at S2 (pull from Supabase). That's acceptable — ship the posture and schedule first, the data arrives when sync does.

---

## Schedule in the manifest

Per firm principle 3: the season schedule is manifest data, compiled in at build time. Real data + draft schema live in **`docs/season-schedule.md`** (7 Monday fixtures, U of T Back Campus Field; conventions: absent keys = TBD, `result` only for pre-event-data games, live/scored games derive results from the log, never the manifest).

- `game_start` gains **`scheduleGameId`**, linking a live game to its fixture.
- **"Start game" becomes pick-from-schedule** — solving the kiosk text-input problem (opponent names never typed on the phone; the fixture supplies them). A manual "unscheduled game" fallback should exist but can be ugly (it's the exception).
- Schedule TBDs (Aug 17/24, the missing Aug 3) tolerated by schema; update the manifest as the league fills them in — a two-minute rebuild.

---

## Location capture, generalized

S1 item 7's fly-location picker extends to **all batted balls** — 1B/2B/3B/HR/FLY/GND, not K — under the identical contract: optional, non-blocking, dismisses on zone tap / skip / ~6s timeout / any other tap winning; logs as an `amend` (`payload.location`); recoverable later via fix-last. One picker, one contract, more data for eventual spray charts. Nothing about the dismissal semantics changes.

---

## Fleet updates (invariant 17, multiplied)

Invariant 17's two update delays (Pages CDN ~10 min; per-SW open→close→reopen cycle) now apply **per device across the whole team**. Consequences to design for, not around:

- **Never assume fleet build uniformity.** Any given week, teammates run a mix of builds.
- **Event-log tolerance is the compatibility boundary** (S2): newer devices may emit event types/fields an older build doesn't know. Replay must skip unknown event types silently rather than throw — a one-line guard in `deriveState`, cheap now, painful retrofitted.
- The existing SW update chip (spec C) becomes more valuable, not less — it's the only nudge a teammate's phone gets.

---

## Firm-principle amendment (pending Jason's sign-off)

Principle 1 currently reads boot-agnostic but was written when the app had one device and one job. Proposed amended text for `00-Project-Prompt.md` (v3, incorporating both of Jason's 2026-07-11 refinements — prompt-based game-mode entry):

> **1. Low friction above all.** The core walk-up flow is sacred: current kicker's song in one tap, by any operator, no instructions. Any feature that adds taps to that flow gets rejected, however fun. *(Amended 2026-07-11 with Jason's sign-off: the app now installs on the whole team's phones and boots into the season stats portal by default. Around game time a context-aware prompt offers scoring mode, PIN-gated; a device with a live game open boots straight back into game mode, no prompt. On the team phone, game mode IS the walk-up surface — the one-tap guarantee lives on unchanged inside it. "Low friction" now means every device boots directly into the surface it exists to serve, and game-mode entry is the scorer's one-tap choice, never an ambush. Boot rule of record: `07-Portal-Architecture.md`.)*

**Status: SIGNED OFF by Jason 2026-07-11; `00-Project-Prompt.md` updated the same day.** Jason still needs to re-paste 00 into Cowork project settings (the settings copy doesn't auto-update).

---

## Decisions of record (summary)

| Decision | Choice | Notes |
|---|---|---|
| App identity | Whole-team install; default posture = stats portal | Operator surfaces unchanged |
| Boot | Live game → game screen; in a game window, a prompt over the portal offers scoring mode (PIN-gated); otherwise portal for everyone; **team phone: always straight to Start Game, PIN-gated, window irrelevant** | Principle-1 amendment **signed off 2026-07-11**, in 00; team-phone correction **2026-07-12** below |
| Team-phone boot (corrected) | Team phone never sees the portal or the classic screens pre-game — `decidePortalBoot()` always calls Start Game directly, regardless of `scheduleGameInWindowNow()`. The PIN sheet on this path has no cancel button, and `#tabbar` stays hidden until a game is actually live (both were live escape hatches back to the classic tile-grid/Next-Up screen). | **Corrected 2026-07-12** — Jason, on-device: the original window-gated version fell through to "the old card-style lineup page" outside a game window, and made the PIN entry point unreachable without first building a classic lineup. Once a game *is* live, the tab bar returns as the firm-principle-5 manual-override fallback, same as any device. |
| Scorer detection | Persisted PIN unlock is the flag (skips PIN re-entry; doesn't change boot destination) | **Decided 2026-07-11** |
| Portal v1 | H/R/RBI leaderboards + schedule + results; read-only | Spray charts / AI analysis later, mostly outside the app via S3 export |
| Soundboard | Operator surface only (team phone / scorers). Regular members: play button per portal player row instead (mockup screen 1) | **Decided 2026-07-11** (both passes). Payload ships to everyone regardless |
| Game window | 60 min before scheduled start → 60 min after | **Decided 2026-07-11** (games run ~50 min) |
| Lineup building | Tap-to-draft: roster tile grid appends to the order; ✕ returns; drag reorders (mockup screens 4–5) | **Decided 2026-07-11** (mockup round) |
| Score mode | PIN-gated, team-phone-primary; S2 takeover = emergency only | |
| Schedule | Manifest-borne; `game_start.scheduleGameId`; Start game = pick-from-schedule | Schema in `docs/season-schedule.md` |
| Location capture | All batted balls (not K), same optional/non-blocking contract | Generalizes S1 item 7 |
| Fleet updates | Design for mixed builds; replay skips unknown event types | Invariant 17 per-device |
| Team-phone role marker | URL fragment in the home-screen bookmark (`index.html#team`), not a persisted toggle | **Decided 2026-07-12** (survives localStorage eviction; re-bookmarking is how you'd reassign a device) |
| Portal placement | No tab bar of its own — the portal shell replaces the classic tab UI entirely (`#tabbar` hidden while `isPortalActive()`); mockup screens 1/2/6 have no tab bar either | **Decided 2026-07-12**, built |
| Portal v1 build | Season stats (screen 1), schedule (screen 2), game detail + scorecard takeover (screen 6), game-window prompt (screen 3) — all built and tested (`node dom-stub-test.js`, groups 61–64) | **Built 2026-07-12** |
| Rollout timing | Shipped live as the default boot screen immediately once built/tested, not gated behind a flag | **Decided 2026-07-12** — Jason: game is 2026-07-13, not the night this was built, so there's time to test/refine; a standard media-player backup is the fallback if the app fails at game time |

## Open questions (not yet decided by Jason)

- **The split posture** (remote scorer + team phone as music-only) — likely classic Next Up manual operation; confirm at S2.
- **New-player landing** — after "+ new" creates a player, does their tile appear in the grid or do they land straight in the order? Feel decision, on-device.
- **Game-window prompt re-offer behavior** — exact copy is built; whether declining should re-offer on every open within the window, or stay dismissed longer than one session, is still open. Current build: in-memory-only dismiss (`gameWindowPromptDismissed`), returns on a fresh reload within the window — a deliberately simple default, not a final answer.
- **Per-player season drill-down** — mockup's "tap a kicker for their season" / "...all 12" truncation was scoped OUT of this build; the full team table always shows everyone, tapping a row does nothing beyond its play button. Revisit if the roster or the season stats screen gets crowded.
- How a sub enters the kicking order (append vs chosen slot) — S1.6.
- Sub clip playback (`defaultClip` mapping; playClip currently no-ops for overlay ids) — S1.6.
- PIN UX (once per device vs per game-start) — carried from 06.
- Whether pre-app finals in the manifest (`result`) are per-game only or also feed the season W/L record line. (Presumably yes; confirm.)
