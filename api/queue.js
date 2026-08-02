// Ranked matchmaking queue.
//
// Pairing itself happens atomically inside Postgres (see
// supabase-schema-phase3.sql -- the attempt_ranked_match() function uses
// `FOR UPDATE SKIP LOCKED` so two simultaneous searches can never both grab
// the same opponent). This function is a thin layer on top of that: it
// upserts you into the queue, asks Postgres to try pairing you, and if a
// pair is found, creates the actual match room in the same Upstash Redis
// used everywhere else in the app.
//
// Actions (POST, JSON body):
//   { action:'join', userId, username, rating }
//     -> Upserts into the queue and attempts a match. Returns
//        { status:'matched', roomCode, role, opponent } or { status:'waiting' }.
//   { action:'poll', userId }
//     -> Checks whether someone else's 'join' matched you while you waited.
//   { action:'leave', userId }
//     -> Removes you from the queue (cancel search).
//
// Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (same as api/rank-update.js),
// UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN (same as api/room.js).
//
// Run supabase-schema-phase3.sql once in Supabase's SQL Editor before using this.

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 5; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!supabaseUrl || !serviceKey) {
    res.status(500).json({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.' });
    return;
  }
  if (!redisUrl || !redisToken) {
    res.status(500).json({ error: 'Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.' });
    return;
  }

  async function sb(path, options) {
    const r = await fetch(supabaseUrl + '/rest/v1' + path, {
      ...options,
      headers: {
        apikey: serviceKey,
        Authorization: 'Bearer ' + serviceKey,
        'Content-Type': 'application/json',
        ...(options && options.headers ? options.headers : {})
      }
    });
    return r;
  }
  async function redisCommand(cmd) {
    const r = await fetch(redisUrl, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + redisToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd)
    });
    return r.json();
  }
  // Opponent info for a poll response -- pulled from the room's own
  // assignedRoles rather than a separate lookup table.
  async function opponentInfo(roomCode, myUserId) {
    try {
      const data = await redisCommand(['GET', 'courtroom:' + roomCode]);
      if (!data.result) return null;
      const room = JSON.parse(data.result);
      const roles = room.assignedRoles || {};
      const entry = Object.values(roles).find(p => p.userId !== myUserId);
      return entry ? { username: entry.username, rating: null } : null;
    } catch (e) { return null; }
  }

  const { action, userId, username, rating } = req.body || {};
  if (!action || !userId) {
    res.status(400).json({ error: 'missing action/userId' });
    return;
  }

  try {
    if (action === 'leave') {
      await sb(`/ranked_queue?user_id=eq.${userId}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'poll') {
      const r = await sb(`/ranked_matches?user_id=eq.${userId}&select=room_code,assigned_role`, { method: 'GET' });
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length) {
        const match = rows[0];
        await sb(`/ranked_matches?user_id=eq.${userId}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
        const opponent = await opponentInfo(match.room_code, userId);
        res.status(200).json({ status: 'matched', roomCode: match.room_code, role: match.assigned_role, opponent });
        return;
      }
      res.status(200).json({ status: 'waiting' });
      return;
    }

    if (action === 'join') {
      if (typeof rating !== 'number' || !username) {
        res.status(400).json({ error: 'missing rating/username' });
        return;
      }

      // Defensive: consume any already-pending match first (e.g. this client
      // reconnected right as it got matched by someone else).
      const pending = await sb(`/ranked_matches?user_id=eq.${userId}&select=room_code,assigned_role`, { method: 'GET' });
      const pendingRows = await pending.json();
      if (Array.isArray(pendingRows) && pendingRows.length) {
        const match = pendingRows[0];
        await sb(`/ranked_matches?user_id=eq.${userId}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
        const opponent = await opponentInfo(match.room_code, userId);
        res.status(200).json({ status: 'matched', roomCode: match.room_code, role: match.assigned_role, opponent });
        return;
      }

      // Upsert into the queue, then ask Postgres to atomically try pairing us.
      await sb('/ranked_queue', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ user_id: userId, username, rating, joined_at: new Date().toISOString() })
      });

      const rpcRes = await sb('/rpc/attempt_ranked_match', {
        method: 'POST',
        body: JSON.stringify({ p_user_id: userId })
      });
      const rpcRows = await rpcRes.json();
      const result = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;

      if (!result || !result.matched) {
        res.status(200).json({ status: 'waiting' });
        return;
      }

      // Matched -- create the actual room in Redis and notify the opponent.
      const code = genCode();
      const room = {
        code, createdAt: Date.now(), rev: 0,
        hostId: null,
        players: {},
        spectators: {}, spectatorChat: [],
        status: 'lobby',
        case: { title: '', plaintiffName: '', defendantName: '', scenario: '' }, caseReady: false,
        phase: null, turnRole: null,
        transcript: [], objection: null, verdict: null,
        ranked: true, rankApplied: false, ratingChanges: null,
        matchmade: true,
        assignedRoles: {
          [result.my_role]: { userId, username },
          [result.opponent_role]: { userId: result.opponent_id, username: result.opponent_username }
        }
      };
      await redisCommand(['SET', 'courtroom:' + code, JSON.stringify(room)]);

      await sb('/ranked_matches', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ user_id: result.opponent_id, room_code: code, assigned_role: result.opponent_role })
      });

      res.status(200).json({
        status: 'matched', roomCode: code, role: result.my_role,
        opponent: { username: result.opponent_username, rating: result.opponent_rating }
      });
      return;
    }

    res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
};
