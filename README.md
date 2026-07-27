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

## 3. Add environment variables in Vercel
In your Vercel project → **Settings → Environment Variables**, add:
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `GROQ_API_KEY`

Redeploy after adding them (Vercel doesn't apply new env vars to an
already-running deployment).

## 4. Files
- `index.html` — the game itself
- `api/room.js` — shared room state (get/set), backed by Upstash Redis
- `api/judge.js` — calls Groq's free API server-side to rule on objections and
  deliver the verdict

Push all of this to the root of your GitHub repo (so `api/` sits next to
`index.html`) and Vercel will auto-detect the two files in `api/` as
serverless functions.

## How multiplayer works
Anyone who has your Vercel URL and the 5-character room code can join — a
real shared backend, working across different devices, browsers, and people.
