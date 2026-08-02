// Applies an Elo rating update after a ranked match's verdict.
//
// Security note: this reads the authoritative match record straight from
// Upstash Redis rather than trusting whatever the client sends, so a player
// can't just invent arbitrary user-id pairs or declare their own winner --
// the room has to actually exist, actually be flagged ranked, and actually
// have both seats filled by signed-in users. The rating write itself goes
// through Supabase's service-role key (bypasses RLS), which never reaches
// the browser.
//
// Requires these Vercel environment variables:
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN   (same ones api/room.js uses)
//   SUPABASE_URL                                        (same one api/config.js uses)
//   SUPABASE_SERVICE_ROLE_KEY  (Project Settings -> API Keys -> service_role
//                               or the newer sb_secret_... key -- SECRET, server-only,
//                               never put this in api/config.js or anywhere client-visible)

const K_FACTOR = 32;

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!redisUrl || !redisToken) {
    res.status(500).json({ error: 'Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN environment variables in Vercel.' });
    return;
  }
  if (!supabaseUrl || !serviceKey) {
    res.status(500).json({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY environment variables in Vercel.' });
    return;
  }

  const { roomCode } = req.body || {};
  if (!roomCode) {
    res.status(400).json({ error: 'missing roomCode' });
    return;
  }

  async function redisCommand(cmd) {
    const r = await fetch(redisUrl, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + redisToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd)
    });
    return r.json();
  }

  try {
    // 1. Read the authoritative room record -- this is the source of truth,
    // not anything the client claims.
    const roomData = await redisCommand(['GET', 'courtroom:' + roomCode]);
    if (!roomData.result) { res.status(404).json({ error: 'room not found' }); return; }
    const room = JSON.parse(roomData.result);

    if (!room.ranked) { res.status(400).json({ error: 'room is not a ranked match' }); return; }
    if (room.rankApplied) {
      res.status(200).json({ ok: true, alreadyApplied: true, ratingChanges: room.ratingChanges || null });
      return;
    }
    // The winner is read from the room's own stored verdict -- never from
    // the request body -- so a player can't claim a different outcome than
    // what the AI judge actually decided.
    if (room.status !== 'verdict' || !room.verdict || !['plaintiff', 'defense', 'split'].includes(room.verdict.winner)) {
      res.status(400).json({ error: 'room has no valid verdict yet' });
      return;
    }
    const winner = room.verdict.winner;

    const players = Object.values(room.players || {});
    const plaintiff = players.find(p => p.role === 'plaintiff');
    const defense = players.find(p => p.role === 'defense');
    if (!plaintiff || !defense || !plaintiff.userId || !defense.userId) {
      res.status(400).json({ error: 'both players must be signed in for a ranked match' });
      return;
    }

    // 2. Fetch current ratings from Supabase (service role bypasses RLS).
    const ids = [plaintiff.userId, defense.userId];
    const selectRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=in.(${ids.join(',')})&select=id,rating,wins,losses`,
      { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
    );
    const rows = await selectRes.json();
    if (!Array.isArray(rows) || rows.length !== 2) {
      res.status(500).json({ error: 'could not load both player profiles' });
      return;
    }
    const pRow = rows.find(r => r.id === plaintiff.userId);
    const dRow = rows.find(r => r.id === defense.userId);

    // 3. Compute Elo deltas. A split decision leaves ratings untouched.
    let pNew = pRow.rating, dNew = dRow.rating;
    let pWinsAdd = 0, pLossAdd = 0, dWinsAdd = 0, dLossAdd = 0;

    if (winner !== 'split') {
      const pScore = winner === 'plaintiff' ? 1 : 0;
      const dScore = 1 - pScore;
      const pExpected = expectedScore(pRow.rating, dRow.rating);
      const dExpected = 1 - pExpected;
      pNew = Math.round(pRow.rating + K_FACTOR * (pScore - pExpected));
      dNew = Math.round(dRow.rating + K_FACTOR * (dScore - dExpected));
      if (winner === 'plaintiff') { pWinsAdd = 1; dLossAdd = 1; } else { dWinsAdd = 1; pLossAdd = 1; }
    }

    // 4. Write updates back to Supabase.
    async function updateProfile(id, newRating, winsAdd, lossAdd, prevWins, prevLosses) {
      await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${id}`, {
        method: 'PATCH',
        headers: {
          apikey: serviceKey, Authorization: 'Bearer ' + serviceKey,
          'Content-Type': 'application/json', Prefer: 'return=minimal'
        },
        body: JSON.stringify({ rating: newRating, wins: prevWins + winsAdd, losses: prevLosses + lossAdd })
      });
    }
    await Promise.all([
      updateProfile(plaintiff.userId, pNew, pWinsAdd, pLossAdd, pRow.wins, pRow.losses),
      updateProfile(defense.userId, dNew, dWinsAdd, dLossAdd, dRow.wins, dRow.losses)
    ]);

    const ratingChanges = {
      plaintiff: { before: pRow.rating, after: pNew, delta: pNew - pRow.rating },
      defense:   { before: dRow.rating, after: dNew, delta: dNew - dRow.rating }
    };

    // 5. Mark the room so this can't be applied twice, and stash the result
    // so both clients pick it up through their normal room polling.
    room.rankApplied = true;
    room.ratingChanges = ratingChanges;
    room.rev = (room.rev || 0) + 1;
    room.updatedAt = Date.now();
    await redisCommand(['SET', 'courtroom:' + roomCode, JSON.stringify(room)]);

    res.status(200).json({ ok: true, ratingChanges });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
};
