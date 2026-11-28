'use strict';

// sup.io account + online game server
// Requires: pg, bcryptjs, ws (see package.json)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 8080);
const WORLD_SIZE = 6000;
const FOOD_COUNT = 4500;
const START_MASS = 1000;
const FOOD_MASS = 100;
const PLAYER_SPEED = 7;
const PELLET_SPEED = 12;
const PELLET_DAMAGE = 350;
const PELLET_MASS = 25;
const FIND_PLAYER_COST = 1000;
const FIND_BALL_SPEED = 13;
const UPGRADE_BASE_COST = 10000;
const UPGRADE_COST_STEP = 5000;
const SKIN_UNLOCK_COST = 1000;
const SKIN_MAX_BYTES = 2 * 1024 * 1024;
const SESSION_DAYS = 30;
const publicDir = path.join(__dirname, 'public');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing. Add your Railway PostgreSQL DATABASE_URL variable to the game service');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 10,
});

const server = http.createServer(async (req, res) => {
  try { await route(req, res); }
  catch (err) {
    console.error('Request error:', err);
    if (!res.headersSent) json(res, 500, { ok: false, error: 'Server error. Check Railway logs.' });
    else res.end();
  }
});
const wss = new WebSocket.Server({ server, maxPayload: 64 * 1024 });

function json(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(data));
}
function readBody(req, limit = 2 * 1024 * 1024 + 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const raw = await readBody(req, 256 * 1024);
  try { return JSON.parse(raw.toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Please send valid JSON.'), { status: 400 }); }
}
function cookieValue(req, name) {
  const line = req.headers.cookie || '';
  for (const item of line.split(';')) {
    const part = item.trim(); const i = part.indexOf('=');
    if (i >= 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return '';
}
function sessionCookie(token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `supio_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}
function clearSessionCookie() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `supio_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
async function getAccountFromReq(req) {
  const token = cookieValue(req, 'supio_session');
  if (!token) return null;
  const result = await pool.query(
    `SELECT a.id, a.username, a.massits, a.skin_unlocked
     FROM sessions s JOIN accounts a ON a.id=s.account_id
     WHERE s.token_hash=$1 AND s.expires_at > NOW()`, [sha(token)]);
  return result.rows[0] || null;
}
function publicAccount(a) {
  return { id: a.id, username: a.username, massits: Number(a.massits || 0), skinUnlocked: !!a.skin_unlocked, skinUrl: `/api/skin/${a.id}` };
}
async function createSession(accountId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,NOW()+($3 || \' days\')::interval)', [sha(token), accountId, String(SESSION_DAYS)]);
  return token;
}
async function initializeDatabase() {
  await pool.query(`CREATE TABLE IF NOT EXISTS accounts (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(20) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    massits BIGINT NOT NULL DEFAULT 0,
    skin_unlocked BOOLEAN NOT NULL DEFAULT FALSE,
    skin_mime TEXT,
    skin_data BYTEA,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS bounties (
    id BIGSERIAL PRIMARY KEY,
    creator_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    target_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    amount BIGINT NOT NULL CHECK(amount > 0),
    status TEXT NOT NULL DEFAULT 'active',
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS bounties_active_idx ON bounties(status,expires_at)');
  await pool.query('DELETE FROM sessions WHERE expires_at <= NOW()');
  console.log('PostgreSQL tables are ready.');
}

function validUsername(value) {
  const name = String(value || '').trim();
  return /^[A-Za-z0-9_]{3,20}$/.test(name) ? name : null;
}
async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  if (req.method === 'GET' && p === '/health') return json(res, 200, { ok: true, service: 'sup.io' });

  if (req.method === 'POST' && p === '/api/register') {
    const body = await readJson(req); const username = validUsername(body.username); const password = String(body.password || '');
    if (!username) return json(res, 400, { ok: false, error: 'Username must be 3–20 letters, numbers, or underscores.' });
    if (password.length < 8 || password.length > 100) return json(res, 400, { ok: false, error: 'Password must be at least 8 characters.' });
    const hash = await bcrypt.hash(password, 12);
    let result;
    try { result = await pool.query('INSERT INTO accounts(username,password_hash) VALUES($1,$2) RETURNING id,username,massits,skin_unlocked', [username, hash]); }
    catch (e) { if (e.code === '23505') return json(res, 409, { ok: false, error: 'That username is already taken.' }); throw e; }
    const account = result.rows[0]; const token = await createSession(account.id);
    return json(res, 201, { ok: true, user: publicAccount(account) }, { 'Set-Cookie': sessionCookie(token) });
  }

  if (req.method === 'POST' && p === '/api/login') {
    const body = await readJson(req); const username = String(body.username || '').trim(); const password = String(body.password || '');
    const result = await pool.query('SELECT id,username,password_hash,massits,skin_unlocked FROM accounts WHERE LOWER(username)=LOWER($1)', [username]);
    const account = result.rows[0];
    if (!account || !(await bcrypt.compare(password, account.password_hash))) return json(res, 401, { ok: false, error: 'Incorrect username or password.' });
    const token = await createSession(account.id);
    return json(res, 200, { ok: true, user: publicAccount(account) }, { 'Set-Cookie': sessionCookie(token) });
  }

  if (req.method === 'GET' && p === '/api/me') {
    const account = await getAccountFromReq(req);
    return json(res, account ? 200 : 401, account ? { ok: true, user: publicAccount(account) } : { ok: false, error: 'Please log in.' });
  }

  if (req.method === 'POST' && p === '/api/logout') {
    const token = cookieValue(req, 'supio_session');
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [sha(token)]);
    return json(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
  }

  if (req.method === 'POST' && p === '/api/skin/unlock') {
    const account = await getAccountFromReq(req); if (!account) return json(res, 401, { ok: false, error: 'Please log in first.' });
    const result = await pool.query('UPDATE accounts SET massits=massits-$1,skin_unlocked=TRUE WHERE id=$2 AND skin_unlocked=FALSE AND massits >= $1 RETURNING massits', [SKIN_UNLOCK_COST, account.id]);
    if (!result.rowCount) {
      const check = await pool.query('SELECT massits,skin_unlocked FROM accounts WHERE id=$1', [account.id]);
      if (check.rows[0]?.skin_unlocked) return json(res, 200, { ok: true, alreadyUnlocked: true, massits: Number(check.rows[0].massits) });
      return json(res, 400, { ok: false, error: 'You need 1,000 Massits to unlock custom skins.' });
    }
    return json(res, 200, { ok: true, massits: Number(result.rows[0].massits), skinUnlocked: true });
  }

  if (req.method === 'POST' && p === '/api/skin/upload') {
    const account = await getAccountFromReq(req);
    if (!account) return json(res, 401, { ok: false, error: 'Please log in first.' });

    const check = await pool.query('SELECT skin_unlocked FROM accounts WHERE id=$1', [account.id]);
    if (!check.rows[0]?.skin_unlocked) {
      return json(res, 403, { ok: false, error: 'Unlock custom skins for 1,000 Massits first.' });
    }

    const contentType = String(req.headers['content-type'] || '');
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);

    if (!contentType.toLowerCase().startsWith('multipart/form-data') || !boundaryMatch) {
      return json(res, 400, { ok: false, error: 'Upload must use a file form.' });
    }

    const boundary = boundaryMatch[1] || boundaryMatch[2];
    const raw = await readBody(req, SKIN_MAX_BYTES + 64 * 1024);
    const parsed = parseMultipartFile(raw, boundary, 'skin');

    if (!parsed) {
      return json(res, 400, { ok: false, error: 'Choose a file in the skin upload field.' });
    }

    const mime = sniffImage(parsed.data);

    if (!mime) {
      return json(res, 400, { ok: false, error: 'Only PNG, JPG, or GIF files are allowed.' });
    }

    if (parsed.data.length > SKIN_MAX_BYTES) {
      return json(res, 413, { ok: false, error: 'Image must be 2 MB or smaller.' });
    }

    await pool.query(
      'UPDATE accounts SET skin_mime=$1,skin_data=$2 WHERE id=$3',
      [mime, parsed.data, account.id]
    );

    return json(res, 200, { ok: true, skinUrl: `/api/skin/${account.id}` });
  }

  const skinMatch = p.match(/^\/api\/skin\/(\d+)$/);

  if (req.method === 'GET' && skinMatch) {
    const result = await pool.query(
      'SELECT skin_mime,skin_data FROM accounts WHERE id=$1',
      [skinMatch[1]]
    );

    const row = result.rows[0];

    if (!row || !row.skin_data) {
      res.writeHead(404);
      return res.end('No custom skin');
    }

    res.writeHead(200, {
      'Content-Type': row.skin_mime || 'image/png',
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff'
    });

    return res.end(row.skin_data);
  }

  if (req.method === 'GET' && p === '/api/bounties') {
    const result = await pool.query(`
      SELECT b.id,b.amount,b.expires_at,t.username AS target
      FROM bounties b JOIN accounts t ON t.id=b.target_id
      WHERE b.status='active' AND b.expires_at>NOW()
      ORDER BY b.created_at DESC LIMIT 100
    `);

    return json(res, 200, {
      ok: true,
      bounties: result.rows.map(b => ({
        id: b.id,
        amount: Number(b.amount),
        target: b.target,
        expiresAt: b.expires_at
      }))
    });
  }

  if (req.method === 'POST' && p === '/api/bounties') {
    const account = await getAccountFromReq(req);
    if (!account) return json(res, 401, { ok: false, error: 'Please log in first.' });

    const body = await readJson(req);
    const amount = Math.floor(Number(body.amount));
    const targetName = String(body.target || '').trim();

    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000) {
      return json(res, 400, { ok: false, error: 'Enter a bounty between 1 and 1,000,000 Massits.' });
    }

    if (!targetName) {
      return json(res, 400, { ok: false, error: 'Enter the wanted player username.' });
    }

    const targetResult = await pool.query(
      'SELECT id,username FROM accounts WHERE LOWER(username)=LOWER($1)',
      [targetName]
    );

    const target = targetResult.rows[0];

    if (!target) {
      return json(res, 404, { ok: false, error: 'That account was not found.' });
    }

    if (String(target.id) === String(account.id)) {
      return json(res, 400, { ok: false, error: 'You cannot place a bounty on yourself.' });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const debit = await client.query(
        'UPDATE accounts SET massits=massits-$1 WHERE id=$2 AND massits >= $1 RETURNING massits',
        [amount, account.id]
      );

      if (!debit.rowCount) {
        await client.query('ROLLBACK');
        return json(res, 400, { ok: false, error: 'You do not have enough Massits.' });
      }

      const inserted = await client.query(`
        INSERT INTO bounties(creator_id,target_id,amount,expires_at)
        VALUES($1,$2,$3,NOW()+INTERVAL '24 hours')
        RETURNING id,amount,expires_at
      `, [account.id, target.id, amount]);

      await client.query('COMMIT');

      return json(res, 201, {
        ok: true,
        bounty: {
          id: inserted.rows[0].id,
          amount,
          target: target.username,
          expiresAt: inserted.rows[0].expires_at
        },
        massits: Number(debit.rows[0].massits)
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // Serve the game and static files.
  if (req.method === 'GET' || req.method === 'HEAD') {
    let pathname = p === '/' ? '/index.html' : p;
    const decoded = decodeURIComponent(pathname);
    const fullPath = path.resolve(publicDir, '.' + decoded);

    if (!fullPath.startsWith(path.resolve(publicDir) + path.sep) &&
        fullPath !== path.resolve(publicDir, 'index.html')) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    fs.readFile(fullPath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }

      const ext = path.extname(fullPath).toLowerCase();

      const types = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.ico': 'image/x-icon'
      };

      res.writeHead(200, {
        'Content-Type': types[ext] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff'
      });

      res.end(req.method === 'HEAD' ? undefined : data);
    });

    return;
  }

  return json(res, 404, { ok: false, error: 'Not found.' });
}

function parseMultipartFile(buffer, boundary, fieldName) {
  const delimiter = Buffer.from('--' + boundary);
  let start = buffer.indexOf(delimiter);

  while (start !== -1) {
    start += delimiter.length;

    if (buffer[start] === 45 && buffer[start + 1] === 45) break;
    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;

    const next = buffer.indexOf(delimiter, start);
    if (next === -1) break;

    let part = buffer.subarray(start, next);

    if (part.length >= 2 &&
        part[part.length - 2] === 13 &&
        part[part.length - 1] === 10) {
      part = part.subarray(0, part.length - 2);
    }

    const split = part.indexOf(Buffer.from('\r\n\r\n'));

    if (split !== -1) {
      const headers = part.subarray(0, split).toString('latin1');

      if (headers.includes(`name="${fieldName}"`) &&
          /filename="[^"]*"/i.test(headers)) {
        return { data: part.subarray(split + 4) };
      }
    }

    start = next;
  }

  return null;
}

function sniffImage(data) {
  if (data.length >= 8 &&
      data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    return 'image/png';
  }

  if (data.length >= 3 &&
      data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }

  if (data.length >= 6 &&
      (data.subarray(0,6).toString('ascii') === 'GIF87a' ||
       data.subarray(0,6).toString('ascii') === 'GIF89a')) {
    return 'image/gif';
  }

  return null;
}

 // Online game state (server-authoritative)
const players = new Map();
const food = [];
const pellets = [];
const findBalls = [];
let nextPlayerId = 1, nextBulletId = 1, nextFoodId = 1, nextFindId = 1;

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const radius = p => Math.sqrt(Math.max(1, Number(p.mass || 1)) * 0.45);
const randomPos = () => ({ x: Math.random() * WORLD_SIZE, y: Math.random() * WORLD_SIZE });

function makeFood() {
  const q = randomPos();
  return { id: 'f' + nextFoodId++, x: q.x, y: q.y, color: '#00f000' };
}

for (let i = 0; i < FOOD_COUNT; i++) food.push(makeFood());

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.ws?.readyState === WebSocket.OPEN) p.ws.send(s);
  }
}

function cleanPlayer(p) {
  return {
    id: p.id,
    accountId: p.accountId,
    name: p.name,
    color: p.color,
    x: p.x,
    y: p.y,
    mass: Math.floor(p.mass),
    size: Math.floor(p.mass),
    speedLevel: p.speedLevel,
    damageLevel: p.damageLevel,
    skinUrl: p.skinUrl || null
  };
}

function allPlayers() {
  return [...players.values()].map(cleanPlayer);
}

function sendState() {
  const bulletList = pellets.map(b => ({
    id: b.id,
    x: b.x,
    y: b.y,
    ownerId: b.ownerId,
    damage: b.damage
  }));

  const state = {
    type: 'state',
    players: allPlayers(),
    pellets: bulletList,
    bullets: bulletList,
    findBalls: findBalls.map(b => ({ id: b.id, x: b.x, y: b.y }))
  };

  broadcast(state);
}

function getPlayer(ws) {
  for (const p of players.values()) {
    if (p.ws === ws) return p;
  }
  return null;
}

function killPlayer(p, reason, killerId = null) {
  if (!p || !players.has(p.id)) return;

  players.delete(p.id);
  send(p.ws, { type: 'died', reason, killerId });
  broadcast({ type: 'playerLeft', id: p.id });

  if (killerId) {
    settleBountyForKill(p.accountId, killerId)
      .catch(e => console.error('Bounty payout failed:', e));
  }
}

async function settleBountyForKill(targetAccountId, killerPlayerId) {
  const killer = players.get(String(killerPlayerId));

  if (!killer || !targetAccountId ||
      String(killer.accountId) === String(targetAccountId)) return;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(`
      UPDATE bounties SET status='paid'
      WHERE id=(
        SELECT id FROM bounties
        WHERE target_id=$1 AND status='active' AND expires_at>NOW()
        ORDER BY created_at ASC LIMIT 1 FOR UPDATE
      )
      RETURNING amount
    `, [targetAccountId]);

    if (result.rowCount) {
      const rewardMass = Number(result.rows[0].amount) * 1000;
      killer.mass += rewardMass;

      broadcast({
        type: 'notice',
        text: `${killer.name} claimed a bounty! +${rewardMass.toLocaleString()} mass.`
      });
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function expireBounties() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const expired = await client.query(`
      UPDATE bounties SET status='expired'
      WHERE status='active' AND expires_at<=NOW()
      RETURNING creator_id,amount
    `);

    for (const b of expired.rows) {
      await client.query(
        'UPDATE accounts SET massits=massits+$1 WHERE id=$2',
        [b.amount, b.creator_id]
      );
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Bounty expiry error:', e);
  } finally {
    client.release();
  }
}

function nearestOpponent(p) {
  let best = null, bestD = Infinity;

  for (const other of players.values()) {
    if (other.id === p.id) continue;

    const d = distance(p, other);
    if (d < bestD) {
      best = other;
      bestD = d;
    }
  }

  return best;
}

function safeColor(c) {
  return /^#[0-9a-f]{6}$/i.test(String(c || ''))
    ? String(c)
    : '#55cc88';
}

function safeName(n) {
  return String(n || 'Player')
    .replace(/[^\w -]/g, '')
    .trim()
    .slice(0, 16) || 'Player';
}

function joinPlayer(ws, message) {
  const old = getPlayer(ws);
  if (old) players.delete(old.id);

  const input = message.player || message;
  const account = ws.account;

  if (!account) {
    send(ws, { type: 'authRequired', text: 'Please log in to play online.' });
    return;
  }

  // One active online character per account.
  for (const [id, p] of players) {
    if (String(p.accountId) === String(account.id)) {
      send(p.ws, { type: 'notice', text: 'Your account was opened in another tab.' });
      p.ws.close();
      players.delete(id);
    }
  }

  const id = String(account.id);
  const pos = randomPos();

  const p = {
    id,
    accountId: account.id,
    ws,
    name: safeName(input.name || input.username || account.username),
    color: safeColor(input.color),
    x: pos.x,
    y: pos.y,
    targetX: pos.x,
    targetY: pos.y,
    mass: START_MASS,
    speedLevel: 0,
    damageLevel: 0,
    playerSpeed: PLAYER_SPEED,
    lastShoot: 0,
    lastMove: 0,
    skinUrl: account.skin_unlocked ? `/api/skin/${account.id}` : null
  };

  players.set(id, p);

  send(ws, {
    type: 'welcome',
    id,
    playerId: id,
    worldSize: WORLD_SIZE,
    food,
    dots: food,
    players: allPlayers(),
    mass: p.mass,
    user: publicAccount(account)
  });

  broadcast({ type: 'playerJoined', player: cleanPlayer(p) });
}

async function handleMessage(ws, raw) {
  let message;

  try {
    message = JSON.parse(raw.toString());
  } catch {
    return;
  }

  const type = String(message.type || '');

  if (type === 'join') return joinPlayer(ws, message);

  const p = getPlayer(ws);
  if (!p) return;

  if (type === 'move' || type === 'update') {
    const source = message.player || message;

    if (Number.isFinite(Number(source.x)) &&
        Number.isFinite(Number(source.y))) {
      p.targetX = clamp(Number(source.x), 0, WORLD_SIZE);
      p.targetY = clamp(Number(source.y), 0, WORLD_SIZE);
      p.lastMove = Date.now();
    }

    if (source.name) p.name = safeName(source.name);
    if (source.color) p.color = safeColor(source.color);
    return;
  }

  if (type === 'shoot') {
    const now = Date.now();
    if (now - p.lastShoot < 80) return;
    p.lastShoot = now;

    if (p.mass <= PELLET_MASS + 100) return;

    p.mass -= PELLET_MASS;

    const dx = p.targetX - p.x;
    const dy = p.targetY - p.y;
    const d = Math.hypot(dx, dy) || 1;

    pellets.push({
      id: nextBulletId++,
      ownerId: p.id,
      x: p.x + dx / d * (radius(p) + 8),
      y: p.y + dy / d * (radius(p) + 8),
      vx: dx / d * PELLET_SPEED,
      vy: dy / d * PELLET_SPEED,
      damage: PELLET_DAMAGE + p.damageLevel * 50,
      life: 90
    });

    return;
  }

  if (type === 'findPlayer' || type === 'clone') {
    if (p.mass < FIND_PLAYER_COST) {
      return send(ws, {
        type: 'notice',
        text: 'Find Player costs 1,000 mass.'
      });
    }

    const target = nearestOpponent(p);

    if (!target) {
      return send(ws, {
        type: 'notice',
        text: 'No opponent is online right now.'
      });
    }

    p.mass -= FIND_PLAYER_COST;

    findBalls.push({
      id: nextFindId++,
      ownerId: p.id,
      targetId: target.id,
      x: p.x,
      y: p.y,
      life: 900
    });

    return;
  }

  if (type === 'upgrade') {
    const kind = String(message.upgrade || message.kind || '');
    const level = kind === 'speed'
      ? p.speedLevel
      : kind === 'damage'
        ? p.damageLevel
        : -1;

    if (level < 0) return;

    const cost = UPGRADE_BASE_COST + level * UPGRADE_COST_STEP;

    if (p.mass < cost) {
      return send(ws, {
        type: 'notice',
        text: `Upgrade costs ${cost.toLocaleString()} mass.`
      });
    }

    p.mass -= cost;

    if (kind === 'speed') {
      p.speedLevel++;
      p.playerSpeed += 1;
    } else {
      p.damageLevel++;
    }

    send(ws, { type: 'notice', text: `${kind} upgrade purchased.` });
    return;
  }

  if (type === 'chat') {
    const text = String(message.text || message.message || '')
      .trim()
      .slice(0, 120);

    if (!text) return;

    broadcast({ type: 'chat', name: p.name, color: p.color, text });
    return;
  }

  if (type === 'cashout') {
    const earned = Math.floor(Math.max(0, p.mass) / 1000);

    if (earned > 0) {
      await pool.query(
        'UPDATE accounts SET massits=massits+$1 WHERE id=$2',
        [earned, p.accountId]
      );
    }

    players.delete(p.id);

    send(ws, {
      type: 'cashoutDone',
      massitsEarned: earned,
      massits: (Number(ws.account.massits || 0) + earned)
    });

    send(ws, { type: 'playerLeft', id: p.id });
    return;
  }
}

wss.on('connection', (ws, req) => {
  const cookie = req.headers.cookie || '';

  ws.authReady = (async () => {
    try {
      const token = cookieValue({ headers: { cookie } }, 'supio_session');

      if (!token) {
        ws.account = null;
        return;
      }

      const result = await pool.query(`
        SELECT a.id,a.username,a.massits,a.skin_unlocked
        FROM sessions s JOIN accounts a ON a.id=s.account_id
        WHERE s.token_hash=$1 AND s.expires_at>NOW()
      `, [sha(token)]);

      ws.account = result.rows[0] || null;
    } catch (e) {
      console.error('WebSocket auth error:', e);
      ws.account = null;
    }
  })();

  ws.on('message', async raw => {
    await ws.authReady;

    try {
      await handleMessage(ws, raw);
    } catch (e) {
      console.error('WebSocket message error:', e);
      send(ws, {
        type: 'notice',
        text: 'A server error occurred. Please try again.'
      });
    }
  });

  ws.on('close', () => {
    const p = getPlayer(ws);

    if (p) {
      players.delete(p.id);
      broadcast({ type: 'playerLeft', id: p.id });
    }
  });
});

function tick() {
  for (const p of players.values()) {
    const dx = p.targetX - p.x;
    const dy = p.targetY - p.y;
    const d = Math.hypot(dx, dy);

    // Cursor inside circle means stop.
    if (d > radius(p)) {
      const speed = (p.playerSpeed || PLAYER_SPEED) *
        Math.max(0.55, Math.min(1.25, 1000 / Math.max(1000, p.mass)));

      p.x = clamp(p.x + dx / d * Math.min(speed, d), 0, WORLD_SIZE);
      p.y = clamp(p.y + dy / d * Math.min(speed, d), 0, WORLD_SIZE);
    }
  }

  for (let i = pellets.length - 1; i >= 0; i--) {
    const b = pellets[i];
    b.x += b.vx;
    b.y += b.vy;
    b.life--;

    let hit = false;

    for (const target of players.values()) {
      if (target.id === b.ownerId) continue;

      if (distance(b, target) < radius(target) + 5) {
        target.mass = Math.max(0, target.mass - (b.damage || PELLET_DAMAGE));
        hit = true;

        if (target.mass <= 0) {
          killPlayer(target, 'pellet', b.ownerId);
        }

        break;
      }
    }

    if (hit || b.life <= 0 || b.x < 0 || b.y < 0 ||
        b.x > WORLD_SIZE || b.y > WORLD_SIZE) {
      pellets.splice(i, 1);
    }
  }

  for (let i = findBalls.length - 1; i >= 0; i--) {
    const b = findBalls[i];
    const target = players.get(String(b.targetId));

    if (!target) {
      findBalls.splice(i, 1);
      continue;
    }

    const dx = target.x - b.x;
    const dy = target.y - b.y;
    const d = Math.hypot(dx, dy) || 1;

    b.x += dx / d * FIND_BALL_SPEED;
    b.y += dy / d * FIND_BALL_SPEED;
    b.life--;

    if (d < radius(target) + 12 || b.life <= 0) {
      findBalls.splice(i, 1);
    }
  }

  for (const p of players.values()) {
    for (let i = food.length - 1; i >= 0; i--) {
      const f = food[i];

      // Dot is eaten when the player circle fully covers it.
      const dotRadius = 5;

      if (distance(p, f) < Math.max(0, radius(p) - dotRadius)) {
        food.splice(i, 1);
        p.mass += FOOD_MASS;

        const replacement = makeFood();
        food.push(replacement);

        broadcast({
          type: 'dotEaten',
          playerId: p.id,
          dotId: f.id,
          mass: p.mass
        });

        broadcast({ type: 'dotRespawn', dot: replacement });
      }
    }
  }

  const list = [...players.values()];

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];

      if (!players.has(a.id) || !players.has(b.id)) continue;

      if (distance(a, b) < radius(a) * 0.72 &&
          a.mass > b.mass * 1.15) {
        a.mass += Math.floor(b.mass * 0.8);
        killPlayer(b, 'absorbed', a.id);
      } else if (distance(a, b) < radius(b) * 0.72 &&
                 b.mass > a.mass * 1.15) {
        b.mass += Math.floor(a.mass * 0.8);
        killPlayer(a, 'absorbed', b.id);
      }
    }
  }

  sendState();
}

(async () => {
  await initializeDatabase();

  setInterval(tick, 1000 / 30);
  setInterval(() => expireBounties().catch(console.error), 60 * 1000);

  server.listen(PORT, '0.0.0.0', () =>
    console.log(`sup.io server listening on ${PORT}`)
  );
})().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
