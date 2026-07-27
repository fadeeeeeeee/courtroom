// Calls Groq's free API server-side so the key never reaches the browser.
// Groq (https://console.groq.com) gives out API keys for free, no credit card
// required, with a generous free-tier rate limit -- good fit for this game.
//
// Requires this Vercel environment variable:
//   GROQ_API_KEY   (create one at https://console.groq.com/keys)

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const key = process.env.GROQ_API_KEY;
  if (!key) {
    res.status(500).json({ error: 'Missing GROQ_API_KEY environment variable in Vercel.' });
    return;
  }

  const { system, user, maxTokens } = req.body || {};
  if (!system || !user) {
    res.status(400).json({ error: 'missing system/user' });
    return;
  }

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: maxTokens || 1000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    });
    const data = await r.json();

    if (data.error) {
      res.status(500).json({ error: data.error.message || JSON.stringify(data.error) });
      return;
    }

    const text = (data.choices && data.choices[0] && data.choices[0].message)
      ? data.choices[0].message.content
      : '';

    // Normalize to the same shape the frontend already expects.
    res.status(200).json({ content: [{ type: 'text', text }] });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
};
