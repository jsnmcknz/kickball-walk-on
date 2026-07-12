# Season Schedule — Summer 2026

Reference data for the schedule feature (see `_ai/handoff.md` round 6: schedule ships in the manifest per firm principle 3; `game_start` gains a `scheduleGameId`; "Start game" becomes a pick-from-schedule, killing the kiosk text-input problem). Captured 2026-07-08 from league-site screenshots supplied by Jason. Update this file when the league fills in TBDs.

**Venue (all games):** University of Toronto — Back Campus Field, 5 Hoskin Avenue. All fixtures on the West Pitch; the North/South sub-field varies per game.

All games are Monday nights.

| # | Date | Time | Opponent | Sub-field | Status |
|---|------|------|----------|-----------|--------|
| 1 | Mon Jul 6 | 9:30 PM | COLD SHOTZ | South Field | **Final: L 13–27** |
| 2 | Mon Jul 13 | 8:30 PM | Otter Nonsense | North Field | upcoming |
| 3 | Mon Jul 20 | 8:30 PM | The Brew Jays | North Field | upcoming |
| 4 | Mon Jul 27 | 9:30 PM | Down with the Kickness | North Field | upcoming |
| 5 | Mon Aug 10 | 8:30 PM | Base Invaders | North Field | upcoming |
| 6 | Mon Aug 17 | TBD | TBD | TBD | TBD |
| 7 | Mon Aug 24 | TBD | TBD | TBD | TBD |

## Notes / gaps (don't invent — confirm with Jason or the league site)

- **No game listed Mon Aug 3** — bye week, or simply not shown in the screenshots. Confirm.
- Aug 17 / Aug 24 are full TBDs — likely playoff or seeding-dependent slots. Schema must tolerate TBD opponent/time/field.
- Home/away isn't indicated in the league listing (PPP renders first in every card — unknown whether that encodes anything). Left out of the schema until it matters.
- Opponent records shown on the site (e.g. `0-1-0-0`) are league-derived; not our data, not captured.
- **Game 1 (Jul 6) predates the scoring layer** — its 13–27 final exists nowhere in event data. That was walk-on v1's field debut ("game 1" throughout the invariants doc). Decide at schedule-schema time whether pre-app finals ship in the manifest entry (`result` below) so the season portal shows a complete line, honestly marked as score-only (no PA data — a known hole the stats model already tolerates).

## Draft manifest shape (design input for the S1.6/schedule session — not yet wired)

```json
"schedule": [
  { "id": "2026-g1", "date": "2026-07-06", "time": "21:30", "opponent": "COLD SHOTZ",
    "field": "West Pitch — South Field", "result": { "us": 13, "them": 27 } },
  { "id": "2026-g2", "date": "2026-07-13", "time": "20:30", "opponent": "Otter Nonsense",
    "field": "West Pitch — North Field" },
  { "id": "2026-g3", "date": "2026-07-20", "time": "20:30", "opponent": "The Brew Jays",
    "field": "West Pitch — North Field" },
  { "id": "2026-g4", "date": "2026-07-27", "time": "21:30", "opponent": "Down with the Kickness",
    "field": "West Pitch — North Field" },
  { "id": "2026-g5", "date": "2026-08-10", "time": "20:30", "opponent": "Base Invaders",
    "field": "West Pitch — North Field" },
  { "id": "2026-g6", "date": "2026-08-17" },
  { "id": "2026-g7", "date": "2026-08-24" }
],
"venue": { "name": "University of Toronto — Back Campus Field", "address": "5 Hoskin Avenue" }
```

Schema conventions proposed: absent keys mean TBD (no `"TBD"` strings to special-case); `result` present only for games whose final predates event data; live/scored games derive their result from the event log via `scheduleGameId`, never from the manifest.
