# Supabase Setup — Zero-Assumed-Knowledge Walkthrough

Sets up the free cloud database that stores game scoring events, so multiple phones can log and watch games live. You do this **once**, before build phase S2. Nothing here affects the walk-on music — if you never do this, the app still works exactly as it does today (scoring just stays offline-only).

**What Supabase is:** a hosted database with a free tier. The app talks to it directly over the internet — no server of our own to run. Think "Airtable, but built for apps to write to."

---

## 1. Create the account and project

1. Go to **supabase.com** → **Start your project** → sign up (easiest: "Continue with GitHub", using the account from the GitHub Pages setup).
2. You'll land on a dashboard. Click **New project**.
3. Fill in:
   - **Name:** `kickball-scoring` (anything works)
   - **Database password:** click Generate, then **save it in your password manager**. You won't need it day-to-day, but you can't recover it later.
   - **Region:** pick the closest — `East US (North Virginia)` is right for Toronto.
   - **Plan:** Free.
4. Click **Create new project** and wait ~2 minutes while it provisions.

## 2. Create the tables

1. In the left sidebar, click the **SQL Editor** icon (looks like a terminal).
2. Click **New query**, paste ALL of the block below, click **Run** (or Cmd-Enter). You should see "Success. No rows returned."

```sql
create table games (
  id uuid primary key default gen_random_uuid(),
  opponent text not null,
  date date not null default current_date,
  status text not null default 'live',
  lineup jsonb,
  scorer_device text,
  scorer_heartbeat_at timestamptz,
  final_us int,
  final_them int,
  created_at timestamptz not null default now()
);

create table events (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references games(id),
  device_id text not null,
  seq int not null,
  ts timestamptz not null,
  type text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (game_id, device_id, seq)
);

alter table games enable row level security;
alter table events enable row level security;

create policy "anon read games"   on games  for select using (true);
create policy "anon insert games" on games  for insert with check (true);
create policy "anon update games" on games  for update using (true);
create policy "anon read events"  on events for select using (true);
create policy "anon insert events" on events for insert with check (true);

-- Realtime: lets the live bench scoreboard update without refreshing.
-- Doing it in SQL here saves hunting for the dashboard toggle (which
-- lives under Database → Publications → supabase_realtime, if you ever
-- want to verify it took).
alter publication supabase_realtime add table public.events;
```

Note what's deliberately missing: no `delete` policy on `events`, and no `update` on `events` at all — even a bug (or a prankster with the URL) can't rewrite or erase logged plays. Corrections happen by adding new events, never editing old ones.

## 3. Get the two values the app needs

*(Updated 2026-07-12: Supabase replaced its old key system during 2025 — dashboards now show new-style keys, with the old ones under a "Legacy" tab. Either kind works for us.)*

1. Left sidebar → **Settings** (gear) → **API Keys** (the Project URL is on the same page, or under Settings → General).
2. Copy two things into `manifest.json` under the `scoring` block:
   - **Project URL** (like `https://abcdefgh.supabase.co`) → `supabaseUrl`
   - The client key → `supabaseAnonKey`. **Which key:** if the page shows a **Publishable key** (starts `sb_publishable_...`), use that — click "Create new API Keys" first if prompted. If you only see the **Legacy API Keys** tab, the **anon / public** key there works identically. Either string goes in the same manifest field.

**Is it safe that this key ends up in a public web page? Yes — that's its job.** Publishable/anon keys are designed to be shipped in client apps; the SQL policies above are the actual security boundary. Do NOT ever put the **secret key** (`sb_secret_...`) or legacy `service_role` key anywhere near the app — those bypass all policies.

3. Set `scoring.teamPin` in the manifest to a 4-digit code and share it only with the people who should be able to enter scores. Then rebuild and push as usual.

## 4. ⚠️ The free-tier pause (read this one)

Free Supabase projects **pause automatically after about 1 week without traffic**, and a paused project means no live scoring until it's manually restored from the dashboard (takes a couple of minutes, needs a laptop or phone browser + login). Weekly games sit exactly on that boundary, so cover it both ways:

- **Game-morning ritual:** open the app's live scoreboard once on Wi-Fi/data the morning of each game. That's traffic (keeps/proves the project awake) *and* confirms scoring works before you're at the park.
- **Belt-and-suspenders:** set up a pinger that requests `https://YOUR-PROJECT.supabase.co/rest/v1/games?select=id&limit=1` once a day with two custom headers, `apikey` and `Authorization: Bearer …`, both set to your client key from step 3 (publishable or legacy anon — same one as the manifest). Daily traffic = never pauses. **Easiest for Jason: a Make.com scheduled scenario** (one HTTP "Make a request" module, daily schedule — ~30 ops/month, negligible; same pattern as the Henderson pipelines). cron-job.org's free tier is the no-Make alternative. Daily beats weekly here: a mid-week-only ping leaves no slack if a run fails or a game-morning ritual gets skipped.

If it does pause anyway: supabase.com → dashboard → your project shows a **Restore** button. Click it, wait ~2 minutes, done. Nothing is lost — pausing stops the service, it doesn't delete data.

## 5. Sanity test (optional but satisfying)

Paste this into Safari's address bar (swap in your URL and key):

```
https://YOUR-PROJECT.supabase.co/rest/v1/games?select=*&apikey=YOUR-ANON-KEY
```

Seeing `[]` means everything works — the database is live, reachable, and empty.

*(If you used a new-style publishable key and this returns an API-key error, don't sweat it — the query-param form is a legacy convenience and the app sends the key as a header, which works with both kinds. The build session's first sync is the real test.)*

## 6. What this leaves for the S2 build session

All the code, none of the clicking: the local sync queue, opportunistic flush (batched idempotent upserts on `(game_id, device_id, seq)`), the "N plays waiting to sync" chip, sync fields in the debug readout, and the realtime bench-scoreboard subscription. One implementation note for that session: local event ids are short strings, not UUIDs — inserts must **omit** the `id` column and let the table default generate it; identity for dedup is the `(game_id, device_id, seq)` tuple, which is exactly why the unique constraint exists. Local events also don't carry `game_id`/`device_id` yet — the flush layer stamps them.

## Ongoing

- Nothing to maintain besides the pause mitigation. Free tier limits (500 MB database, 2 GB bandwidth/month) are ludicrously beyond a kickball season (~a few hundred KB of events).
- Post-season: `tools/` will get an export script (build phase S3) to pull the season into CSV/Airtable for your own analysis. The Supabase project can then idle or be deleted — export first.
