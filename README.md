# The Docket — setup

This site needs two things Vercel doesn't give you by default: a shared place to
store room state, and a way to call an AI judge without exposing an API key in
the browser. Both are handled by the two files in `api/`. Both services used
here (Upstash and Groq) are free with no credit card required.

## 1. Create a free Upstash Redis database
1. Go to https://upstash.com and sign up (free tier is plenty for this).
2. Create a new **Redis** database (any region close to you).
3. Open its **REST API** tab — copy `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN`.

## 2. Get a free Groq API key (this powers the AI judge)
1. Go to https://console.groq.com and sign up — no credit card required.
2. Go to **API Keys** and create a new key.
3. Copy it — you'll add it as `GROQ_API_KEY` below.

Groq's free tier has generous rate limits, more than enough for a courtroom
game between two people.

## 3. Set up accounts (Supabase — free, powers ranked/rating in Phase 1+)
1. Go to https://supabase.com and sign up — no credit card required.
2. Create a new project (pick any region, set a database password — you won't need that password day-to-day).
3. Leave **Confirm email** turned **on** (Authentication → Providers → Email) — this is the default. Signing up sends a real confirmation link, and the account isn't active until it's clicked.
4. Go to **SQL Editor → New query**, paste in the contents of `supabase-schema.sql` (included in this project), and run it. This creates the `profiles` table (username, rating, wins, losses) and a trigger that auto-creates a profile the moment someone signs up.
5. Go to **Project Settings → API Keys** and copy:
   - **Project URL** → this is `SUPABASE_URL`
   - **anon / public key**, or the newer `sb_publishable_...` key if that's what your project shows → this is `SUPABASE_ANON_KEY`. Either works the same way — never use the `service_role` / `sb_secret_...` key here, that one must stay server-side only.

Note: signing up now asks for a username, a real email, and a password. After
signing up, check your email for a confirmation link — you can't log in until
you click it. Log in uses your email + password (the username is just your
public display name).

## 4. Add environment variables in Vercel
In your Vercel project → **Settings → Environment Variables**, add:
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `GROQ_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` — from **Project Settings → API Keys**, the
  `service_role` key (or the newer `sb_secret_...` key). **This one is secret
  — it bypasses all database security rules.** Only ever add it as a Vercel
  environment variable, never in `index.html` or anywhere else client-visible.

Redeploy after adding them (Vercel doesn't apply new env vars to an
already-running deployment).

## 5. Files
- `index.html` — the game itself
- `api/room.js` — shared room state (get/set), backed by Upstash Redis
- `api/judge.js` — calls Groq's free API server-side to rule on objections and
  deliver the verdict
- `api/config.js` — hands the Supabase URL/anon key to the browser (both are
  meant to be public; Supabase's row-level security is what actually protects data)
- `api/rank-update.js` — applies the Elo rating change after a ranked match's
  verdict, using the secret service-role key server-side
- `api/queue.js` — ranked matchmaking queue: join/poll/leave and auto-creating
  the match room once Postgres pairs two players (see Phase 3 Part 1 below)
- `supabase-schema.sql` — run once in Supabase's SQL Editor: accounts/profiles (Phase 1)
- `supabase-schema-phase3.sql` — run once, **in addition to** the file above:
  the ranked queue tables (Phase 3 Part 1)

Push all of this to the root of your GitHub repo (so `api/` sits next to
`index.html`) and Vercel will auto-detect the files in `api/` as
serverless functions.

## How multiplayer works
Anyone who has your Vercel URL and the 5-character room code can join — a
real shared backend, working across different devices, browsers, and people.

## Accounts (Phase 1)
Signing in is optional — guests can still play local matches by just typing a
name, exactly as before. Signing up gets you a persistent username and a
rating (everyone starts at 1000, tier "Silver"). Local (friend-code) matches
never affect rating on their own — only matches explicitly flagged "Ranked"
do (see Phase 2 below).

## Ranked rating (Phase 2)
If the host is signed in, a **"Ranked Match"** checkbox appears in the lobby.
Turning it on requires both seats to be filled by signed-in accounts before
Begin Trial unlocks. When a ranked match reaches a verdict, both players'
ratings update via a standard Elo formula (K-factor 32) — a split decision
leaves ratings unchanged. The update happens server-side in
`api/rank-update.js`, which re-reads the actual match record from Redis
rather than trusting the browser, so a rating change can't be forged by
calling the endpoint directly with made-up data.

## Ranked matchmaking (Phase 3)
Built in two parts — both are now live.

**Part 1 — backend.** Run `supabase-schema-phase3.sql` in Supabase's SQL
Editor (in addition to `supabase-schema.sql` from Phase 1, not instead of
it). This creates:
- `ranked_queue` — who's currently searching
- `ranked_matches` — a one-row "you've been matched" mailbox per player,
  consumed the moment their client sees it
- `attempt_ranked_match(p_user_id)` — a Postgres function that atomically
  pairs you with a similar-rated waiting player using `FOR UPDATE SKIP LOCKED`,
  so two searches happening at the same instant can never both grab the same
  opponent (something a naive read-then-write queue can't safely guarantee)

No new environment variables — `api/queue.js` reuses
`SUPABASE_SERVICE_ROLE_KEY` (Phase 2) and the Upstash Redis vars (from the
very first setup), since matched rooms are created in the same Redis every
other room lives in.

**Part 2 — the game itself.** Signed-in players now see a **"Find Ranked
Match"** button on the landing page. Clicking it enters the queue and shows a
live search screen; once Postgres pairs you with someone, the match starts
automatically:
- Roles (Plaintiff/Defense) are assigned randomly
- Whoever is assigned Plaintiff generates a random AI case (there's no host
  to write one in an auto-matched room) and the trial starts immediately for
  both players — no lobby, no manual setup
- If pairing stalls for more than 30 seconds (network hiccup, AI call
  failure), the waiting player gets a friendly failure message instead of
  hanging forever
- Ratings update the same way Phase 2 already handles — nothing new there
- Since auto-matched rooms have no "host," the verdict screen swaps "Start a
  New Trial" for "Back to Home" — queue again for a fresh opponent instead of
  replaying the same person

Manually flagging a local room "Ranked Match" (Phase 2) still works
independently and is unaffected by any of this.

## Reading period (ranked only)
Every ranked match — whether auto-matched or manually flagged on a local
room — now opens with a **1-minute reading phase** once the case is ready,
before opening statements begin. Both players see the full case and a
countdown; statement/objection controls stay disabled until it runs out.
Either player's browser can trigger the automatic transition to opening
statements once time's up (same pattern as the existing turn-timer timeout),
so it doesn't depend on one specific person's tab staying open. Casual local
matches are unaffected — they still jump straight into opening statements
the moment Begin Trial is clicked.
