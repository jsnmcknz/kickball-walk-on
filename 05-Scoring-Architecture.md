# Scoring Architecture — Kickball Walk-On Music

Designed 2026-07-07 in a full-session design conversation with Jason (Fable 5), the same day as the post-game-1 session. This is the design of record for the **scoring merge**: the walk-on player grows a live scoring layer, season stats, and an opportunistic sync backend. Status: **designed, build pending**. Nothing in this document is implemented yet.

Read alongside: `01-Architecture.md` (the walk-on design this extends), `03-Invariants.md` (behavioral ground truth — nothing here overrides an invariant), `06-Scoring-Specs.md` (build phases), `mockups/scoring-screens.html` (**visually normative** — see Design authority below).

---

## Design authority (read this first, build sessions)

Lesson from the walk-on v1 build: prose under-specifies optics, and a build model given adjectives invents generic UI. So authority is split explicitly:

- **`mockups/scoring-screens.html` is normative for appearance** — *for screens the build hasn't reached yet.* **Amended 2026-07-11:** the built `app.template.html` has evolved past this mockup across the S1.5 sessions (pill tabs, vertical score bug, NOW UP layout, fixed-height last-action box, defense rework, diamond-tap corrections). For any screen that exists in the build, **the built template is normative for appearance**; the mockup must never be used to "correct" the build. The mockup's dated addendum notes carry not-yet-built deltas. New surfaces (portal, lineup editor) are governed by `mockups/portal-screens.html`.
- **`03-Invariants.md` is normative for behavior.** The mockup is static HTML and knows nothing about render() discipline, text-node ticks, or synchronous audio paths.
- **This document is normative for data and logic.**
- When mockup and invariants appear to conflict: invariants win on behavior, mockup wins on appearance. Implement mockup visuals inside `app.template.html`'s existing conventions — do not port the mockup's markup structure wholesale.

---

## Decision summary

| Decision | Choice | Rejected alternatives |
|---|---|---|
| Shape | Merged into the walk-on app: scoring takes over the Next Up tab when a game is live | Standalone companion app (loses result-tap-advances-lineup synergy, doubles ops surface); third tab (Jason prefers takeover) |
| Firm principle 2 | **Amended with Jason's explicit sign-off (2026-07-07):** "No feature *requires* network mid-game." Walk-up playback stays 100% offline-embedded; scoring events queue in localStorage and sync opportunistically. | Keeping the absolute form (would force post-game-export-only, killing live scoreboard + multi-device) |
| Data model | Append-only event log; ALL state (score, outs, runners, stats) derived by replay | Stored mutable state (undo/corrections become error-prone reconciliation) |
| Backend | Supabase (free tier): anon key public-by-design, realtime for live scoreboard | Airtable (PAT exposure in public static page, no realtime); no backend (no live view, manual merges) |
| Integrity | Team PIN gate + one-scorer lock + explicit game gate. No accounts in v1. | Supabase auth accounts (login friction at a park; revisit only if PIN proves insufficient) |
| Capture depth | L2: one-tap PA results + assumption engine + exception-tap runner corrections. Opponent half = outs/runs counters only, never PAs. | Scoreboard-only (no stats); full mandatory play-by-play (unworkable at a fast live game) |
| Rollout guard | `scoring.enabled` manifest gate — `false` builds today's app with zero scoring code in the artifact | Always-on (risks walk-on reliability before scoring earns trust) |
| Auto-play | Result tap advances lineup AND fires next kicker's clip in the same gesture, after `autoPlayDelayMs` (default **2000**) | Immediate (Jason: likely too fast); arm-only (extra tap) |

**Two postures, one URL.** Team phone (airplane mode): scoring works fully offline, queue flushes post-game on Wi-Fi; the auto-play synergy lives here since music and scoring share the device. Scorer's own phone (cellular): live sync, powers the read-only bench scoreboard for anyone with the URL. Nothing forks architecturally; per-game choice.

**Degradation ladder (protects firm principles 1 and 5).** No game started → the app IS today's walk-on player, identical. Game started, scorer gives up mid-game → walk-up flow keeps working; stats just have holes, which the model tolerates by design (see honest denominators). All Songs never gains modes and never blocks.

---

## Event sourcing (the load-bearing idea)

Every user action appends an immutable event. **No derived quantity is ever stored** — score, outs, inning, diamond occupancy, RBI, and all season stats are computed by replaying the log. Consequences, all structural rather than coded-for:

- **Undo** = tombstone the last event, re-derive. Nothing to unwind.
- **Corrections** = amend event referencing its target; replay applies the latest amendment. Runner state, outs, runs, and RBI all re-derive automatically — there is no "revert stats" logic to get wrong.
- **Sync conflict tolerance** = events are idempotent inserts keyed `(game_id, device_id, seq)`; retries and even a freak double-scorer merge detectably instead of corrupting.
- **The scorecard** (S3) is just another replay renderer.

### Event schema

```json
{
  "id": "uuid",
  "game_id": "uuid",
  "device_id": "short-string",
  "seq": 42,
  "ts": "2026-07-14T19:42:13-04:00",
  "type": "…",
  "payload": { }
}
```

`seq` is per-device monotonic. Replay order: by `ts`, tiebreak `(device_id, seq)`.

| type | payload | notes |
|---|---|---|
| `game_start` | `{opponent, lineup: [playerId,…], innings, scheduleGameId?}` | Creates the game; publishes the lineup so other devices inherit it. `scheduleGameId` links to the manifest schedule fixture *(added 2026-07-11, see `07-Portal-Architecture.md`)*; absent for unscheduled games |
| `pa` | `{playerId, result, inning, half}` | result ∈ `1B 2B 3B HR FLY GND K MISSED SKIP` (league has no BBs, no errors-as-results; K exists). `MISSED` = PA happened, unseen. `SKIP` = no PA, pointer advance only — excluded from PA counts entirely |
| `runner` | `{playerId, action: "set"\|"out", to?, scored?}` | Manual exception taps. `set` moves the runner to an absolute base (`to`: `1`–`3`, or `4` for home/scored) — **amended 2026-07-07 (S1.5 build session)** from the original relative `action:"advance", bases: N`. The relative form replayed a delta against whatever base the runner happened to occupy *at replay time*, which drifted whenever an earlier event (e.g. the PA that force-advanced them) was later undone or amended — a stored "+1" could silently resolve to the wrong base. An absolute target has no such dependency: "set to 3rd" always means 3rd. This also unlocked tap-a-base as the correction UI (a target is just a base number) and backward corrections (walking an over-advanced runner back), neither of which fit the relative model. **Amended again 2026-07-08 (Fable session): un-scoring is now in scope.** A `set` is an absolute *observation* and wins over the assumption engine at replay: if the runner isn't on base because *this replay* scored them earlier **in the same half** (the canonical trigger: 1B logged → runner manually set to 3rd → the 1B amended to a 2B, whose push sent them home before the set replayed), the run is reversed — score, runsLog, the crediting PA's RBI and its recap movement line all re-derive — and the runner is placed on `to` (backward-move rules: target must be open). `out` with `scored: true` (appended only by the scored-runner correction sheet) likewise reverses a same-half run and adds the out — "actually out at home." The same-half guard means runs from finished halves are untouchable; a cross-half stale `set`/`out` no-ops |
| `runner_out_hit_stands` | `{playerId}` | The rundown case: kicker legitimately reached, then out on the bases — hit stays in stats, out increments |
| `opp_out` / `opp_run` | `{inning}` / `{inning, delta: 1\|-1}` | The entire defensive half. Never opponent PAs |
| `adjust` | `{field: "outs"\|"score_us"\|"score_them"\|"inning", value}` | Score-bug direct correction; the app never blocks on inconsistency |
| `amend` | `{target_event_id, result}` | Fix-last: replay uses the amended result |
| `undo` | `{target_event_id}` | Tombstone; replay skips target |
| `player_add` | `{playerId, name, status: "member"\|"sub", defaultClip}` | On-the-fly subs from the lineup editor |
| `game_end` | `{final_us, final_them}` | Closes the game |

### Assumption engine (replay rules)

- `1B`: kicker→1st, every runner +1 base. `2B`: kicker→2nd, runners +2. `3B`: kicker→3rd, runners +3 (i.e. all score). `HR`: everyone scores.
- `FLY`, `K`: out +1, runners hold. `GND`: out +1, runners hold — deliberately the same default even though forces/advances are common on grounders; GND is the case most likely to need an exception tap, which is what the diamond is for. `MISSED`: runners hold, no out (unknown); pointer advances.
- Manual `runner` **forward** sets (`to` > current base, including home) use **chain semantics** *(amended 2026-07-08 — Fable audit found the original "exactly like a hit" uniform push silently scoring an unblocked runner on 3rd when a trailing runner was corrected 1st→2nd, the most common board in the game)*: the tapped runner moves to the target; every runner they'd **pass** is carried along ahead of them (a trailing runner never passes a lead runner without carrying them); runners already **beyond the target hold their base** unless a carried runner actually lands on them, in which case they're bumped one base at a time — anyone past home scores. Same spirit as the force-chain-only 1B rule. Hits (2B/3B) deliberately keep the uniform push — that's the assumption engine's default, corrected after the fact. **Backward** sets (`to` < current base) move the tapped runner alone, and may neither land on **nor pass** a trailing runner *(pass rule added 2026-07-08 round 2 — Jason's on-device find: a scored runner walked back from home was being offered 1st behind a teammate on 2nd)*: the legal backward list stops at the first occupied base, and replay enforces the same rule (`backwardBlocked`), so a stale illegal event no-ops. The UI only offers legal targets (computed from these rules), so impossible states cannot be entered; tapping a base on the diamond directly *is* the interface (no intermediate button list).
- **Scored-runner corrections (2026-07-08; round 3 semantics):** when the assumption engine scores a runner reality didn't (runner on 2nd, kicker doubles, they actually held at 3rd), they're no longer on the diamond to tap — **home plate is their tap target**. Corrections run in the **reverse order runs scored, one at a time**: tapping home always opens the **most recent scorer of the half** (no picker — walking one back exposes the next), replay enforces the same rule (only the newest same-half run credit is reversible; anything else no-ops), and the backward pass-blocking rule then naturally confines each walk-back to bases ahead of anyone already re-placed. When the most recent scorer is the last at-bat's own kicker (the HR case), home routes to **fix-last** instead — re-scoring their at-bat is the correction, exactly like the previous-kicker redirect on the bases. Otherwise the sheet offers tap-a-base walk-back (a plain `set`) or "OUT at home" (`out` + `scored: true`).
- **Runs & RBI**: any runner reaching home increments the score and credits an RBI to the PA that moved them. Manual `runner: set` corrections credit the most recent PA and are **flagged inferred**. 3 outs flips the half, clears the diamond.
- **Previous-kicker redirect (Jason's rule, 2026-07-07):** tapping the runner whose base placement came from the most recent PA opens fix-last mode (their "advance" is really a re-score of their at-bat), with `runner_out_hit_stands` available inside it for the rundown exception. All other runners get the tap-a-base correction sheet (OUT, or tap the target base directly).
- **Fielder's choice, accepted simplification:** kicker reaches while a runner is forced out = logged 1B + runner-out. Purists call it FC; for this league it counts as a hit. Deferred possibility (zero UX cost): auto-reclassify a runner-out within a few seconds of a 1B.

### Honest denominators

Stats never pretend to knowledge the scorer didn't have. AVG/SLG compute over known-result PAs only; `MISSED` counts toward games/PA totals but joins no rate stat; inferred RBI are queryable separately from observed. A game nobody scored is a hole the season already tolerates. Sub/member status segments season leaderboards.

---

## Sync layer

**Local-first, always.** Every event lands in localStorage synchronously with the tap (same `saveJSON` pattern and failure-silence as the existing app). A sync queue flushes opportunistically: on `online`, on visibilitychange, on a gentle interval while a game is live. Flush = batched idempotent upsert (`on conflict (game_id, device_id, seq) do nothing`). Airplane mode costs nothing; the queue grows.

**Sync visibility: silence is the success state.** No indicator anywhere when synced. Queue > 0 → small bottom-center chip: "N plays waiting to sync". Full diagnostics (queue depth, last flush, last error) join the existing hidden debug readout (5 wordmark taps).

### Supabase design

Two tables. RLS on, permissive anon policies (insert+select on `events`; insert+select+update on `games`) — see `docs/03-supabase-setup.md` for the exact SQL.

- `games`: `id, opponent, date, status ('live'|'final'), lineup jsonb, scorer_device, scorer_heartbeat_at, final_us, final_them`
- `events`: schema above; unique `(game_id, device_id, seq)`

Realtime subscription on `events` filtered by `game_id` powers the live bench scoreboard (viewer mode replays the same engine). Credentials (`supabaseUrl`, `supabaseAnonKey`) ship in the manifest and are baked into the artifact — the anon key is public-by-design; RLS is the boundary.

**Integrity model (threat model: friends and fat fingers, not attackers):**
1. **Game gate** — no live game, no writes possible; the result pad doesn't render. Kills off-day fiddling.
2. **Scorer lock** — `games.scorer_device` + heartbeat (~30s). Everyone else gets the read-only live scoreboard: "Kirsten is scoring", with a deliberate take-over action for dead-phone recovery. Advisory, client-enforced; the offline team phone can score without holding the lock (its events merge by ID; socially, one scorer per game).
3. **Team PIN** — client-side gate on score-entry mode, shared with the trusted few. Honestly: friction, not cryptography. If ever insufficient → Supabase magic-link accounts for 2–3 scorers (rejected for v1: login friction at a park).

**Known risk — free-tier pause:** Supabase pauses free projects after ~1 week of inactivity, and weekly games sit exactly on that boundary. Mitigations, either/both: game-morning ritual (open the live scoreboard once on Wi-Fi — also confirms the project is awake) and/or a free external uptime ping (cron-job.org) hitting the REST endpoint daily. Documented in the walkthrough; do not skip.

---

## UX summary (mockups are the real spec)

Screens in `mockups/scoring-screens.html`: offense, defense, runner-correction (state 1), fix-last (state 2), soundboard. Key behaviors:

- **Offense**: header (wordmark left, **lineup** button right — the existing order button, renamed surface); score bug (tap any figure → `adjust` steppers); diamond + last-action chip ("last: Franny — 1B · tap to fix or undo" — shows the most recent event of *any* kind, PA or runner action, so accidental taps of every species share one correction surface); NOW UP card (shrunk, same states as today plus "tap to replay" after auto-play has fired); result pad 1B/2B/3B/HR · FLY/GND/K · dashed MISSED ("kicked, no result") / SKIP ("didn't kick" — inherits ⏭'s soul); on-deck strip.
- **Auto-play**: the pa-logging tap synchronously (in-gesture — iOS unlock rides the same tap; see invariant on the synchronous play path) arms and fires the next kicker's clip after `autoPlayDelayMs`. A tap is a gesture; a timer callback is not — so the *context unlock/rebuild* must happen in the tap, with the delayed start scheduled on the already-running context.
- **Defense**: giant +OUT (auto-flips half at 3), their-runs stepper, "walk-up music resumes next half", leadoff preview.
- **State 1 (runner tapped)**: selected runner white-ringed, rest of the diamond dims. Action panel: OUT (plum) first, then "tap a base to move «name»" — legal target bases (`legalSetTargets`) render directly on the diamond as dashed-pickle tappable targets, forward or backward, in place of a separate `+N` button list. Dashed ✕ cancel. Previous-kicker chip redirects to state 2. **Amended 2026-07-08 (Fable session, Jason's on-device feedback):** the diamond grew for tap-target size (wrap 104×88 → 118×102, bases 24 → 28px, shared reference height 132 → 150px via the `--scoring-ref-h` CSS var that now locks all five matched columns together); home plate is an actual pentagon (clip-path, `-webkit-` prefixed, two-layer outline since borders don't survive clipping) with state fills (moss = tappable scored-runner fix, pickle = legal target, white = selected); runner labels are **unique 2-letter codes** derived deterministically from the roster at boot (Marcel→MA, Mark→MR, Mike→MI, Ming→MN — three same-initial Ms on base were unreadable); and the **last-action chip shows the recalculated at-bat** *(round 2, same day, superseding round 1's edit-ledger merge)*: the chip renders the NET assessment of the most recent at-bat — the record's pre-PA board snapshot diffed against the current board, so corrections read as if scored that way live ("Megan – Doubled / Ming 2nd→3rd"), runs credited to the PA (inferred included) read "scored," a reached-then-erased kicker reads "out on the bases," holds stay silent, and the RBI line tracks the record's live count. **Chip tap opens fix-last for that PA** even when the newest event is a runner correction (a mistaken correction is fixed by another correction on the diamond); the one exception is the dashed **"↩ undo last fix"** line inside fix-last, present when the newest event is a correction — required because a mistaken OUT correction has no correction-on-correction route back (the runner is neither on base nor at home). `adjust`/opp events keep the undo-only sheet; a SKIP still shows standalone so it stays fixable. **Amended 2026-07-07 (S1.5 build session, superseding the original text-list design):** tapping the diamond reads as more intuitive than reading buttons, and unifies with the `runner`/`set` event's absolute-target model (see Event schema) — a forward tap still carries lead runners along and can score them (discovered via the result afterward, not previewed before the tap, matching the rest of the app's "act now, undo is the safety net" pattern); a backward tap is only offered onto a base nobody else occupies.
- **State 2 (fix-last)**: pad re-targets with banner ("FIXING: FRANNY · logged as 1B"), current result pickle-highlighted, dashed plum "↩ undo — {name} still at bat" (full pre-tap state restoration), dashed cancel. **Amended 2026-07-07 (S1.5 build session):** the FIXING banner lives in the diamond row's right column, the same slot the last-action chip occupies on the live screen — reads as "the chip flipped into edit mode" rather than a separate note-plus-banner pair. No other static copy explains the mechanism (a "runner state re-derives..." line and a closing "{name}'s turn resumes" line were both tried and dropped — the former read as too technical for a live operator, the latter was only true on the undo path and wrong on the far more common amend path, where the pointer doesn't move at all; the undo button's own label is the only place that claim belongs).
- **Soundboard (All Songs)**: TEAM section above the player grid — stinger/hype tiles, moss borders, ALL-CAPS names; player tiles **Title Case** (matches the real app's caps-reserved-for-wordmark/NOW-UP rule; the planning widgets had this wrong). One sound at a time; playing tile is the plum stop control, as everywhere.
- **Lineup button** opens the existing field-tested reorder editor, extended with: "+ add player" (name → `member`/`sub` → pick a `defaultClips` song), **Start game** (opponent → confirm lineup → claim scorer), **End game** (confirm final score). Low-traffic controls all live here; the game screen stays pure. **Amended 2026-07-11 (see `07-Portal-Architecture.md`):** the editor becomes a full-width drag-handle list; Start game becomes pick-from-schedule (`game_start` gains `scheduleGameId`; opponent comes from the manifest schedule, never typed on the kiosk).

## Manifest additions

```json
"settings": { "autoPlayDelayMs": 2000 },
"scoring": {
  "enabled": false,
  "supabaseUrl": "", "supabaseAnonKey": "",
  "teamPin": "0000", "inningsPerGame": 7
},
"players": [{ "id": "…", "name": "…", "clips": ["…"], "status": "member" }],
"teamSounds": [{ "id": "airhorn", "name": "AIRHORN", "kind": "stinger", "clips": ["airhorn.mp3"] }],
"defaultClips": ["default-hype-1.mp3", "default-hype-2.mp3"]
```

`scoring.enabled: false` must produce an artifact byte-equivalent in behavior to today's app (scoring code may be absent or dead — absent preferred; build.py can strip the block).

## Relationship to existing roadmap

Spec H (04-Feature-Specs "season stats — collect now, present later") is **superseded** by this design — don't build the ring buffer; the event log is its grown-up form. Specs E/F (stingers) land naturally as `teamSounds`. Rally-mode design questions stay parked per 04.
