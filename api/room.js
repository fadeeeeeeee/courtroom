// Shared room storage, backed by Upstash Redis (free tier).
// Requires these Vercel environment variables:
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN
// (Both come from your Upstash Redis database's "REST API" tab.)

module.exports = async (req, res) => {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    res.status(500).json({ error: 'Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN environment variables in Vercel.' });
    return;
  }

  async function redisCommand(cmd) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd)
    });
    return r.json();
  }

  try {
    if (req.method === 'GET') {
      const code = (req.query.code || '').toString();
      if (!code) { res.status(400).json({ error: 'missing code' }); return; }
      const data = await redisCommand(['GET', 'courtroom:' + code]);
      res.status(200).json({ value: data.result || null });
      return;
    }

    if (req.method === 'POST') {
      const { code, value } = req.body || {};
      if (!code || typeof value !== 'string') { res.status(400).json({ error: 'missing code/value' }); return; }
      await redisCommand(['SET', 'courtroom:' + code, value]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
};
