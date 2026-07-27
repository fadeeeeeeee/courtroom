// Calls the Anthropic API server-side so your API key never reaches the browser.
// Requires this Vercel environment variable:
//   ANTHROPIC_API_KEY   (create one at https://console.anthropic.com)

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY environment variable in Vercel.' });
    return;
  }

  const { system, user, maxTokens } = req.body || {};
  if (!system || !user) {
    res.status(400).json({ error: 'missing system/user' });
    return;
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: maxTokens || 1000,
        system: system,
        messages: [{ role: 'user', content: user }]
      })
    });
    const data = await r.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
};
