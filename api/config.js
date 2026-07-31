// Serves the public Supabase project URL and anon key to the browser.
// Both values are meant to be public (Supabase's anon key is safe to expose;
// row-level security policies on the actual tables are what enforce access
// control), so returning them from an API route is just as safe as hardcoding
// them in the HTML -- this only exists so setup matches the same
// "add env vars in Vercel" pattern as Upstash/Groq.
//
// Requires these Vercel environment variables:
//   SUPABASE_URL       (Project Settings -> API -> Project URL)
//   SUPABASE_ANON_KEY   (Project Settings -> API -> anon / public key)

module.exports = async (req, res) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    res.status(500).json({ error: 'Missing SUPABASE_URL / SUPABASE_ANON_KEY environment variables in Vercel.' });
    return;
  }

  res.status(200).json({ supabaseUrl, supabaseAnonKey });
};
