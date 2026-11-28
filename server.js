
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing. Connect Railway PostgreSQL first.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});

// GAME SETTINGS
const WORLD_SIZE = 6000;
const FOOD_COUNT = 4500;
const START_MASS = 1000;
const FOOD_GAIN = 100;

const PLAYER_SPEED = 7;
const SPEED_UPGRADE_AMOUNT = 1;
const UPGRADE_BASE_COST = 10000;
const UPGRADE_COST_STEP = 5000;

const PELLET_DAMAGE = 350;
const PELLET_DAMAGE_UPGRADE = 50;
const PELLET_SPEED = 12;
const PELLET_MASS = 25;

const FIND_PLAYER_COST = 1000;
const FIND_BALL_SPEED = 13;

const MASS_PER_MASSIT = 1000;
const SKIN_UNLOCK_COST = 1000;
const MAX_SKIN_BYTES = 2 * 1024 * 1024;

const publicDir = path.join(__dirname, "public");

const players = new Map();
const pellets = [];
const findBalls = [];

let nextPlayerId = 1;
let nextPelletId = 1;
let nextFindBallId = 1;

let food = [];
let wantedAccountIds = new Set();

// DATABASE SETUP
async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(18) NOT NULL,
      username_lower VARCHAR(18) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      massits BIGINT NOT NULL DEFAULT 0 CHECK (massits >= 0),
      skin_unlocked BOOLEAN NOT NULL DEFAULT FALSE,
      skin_mime TEXT,
      skin_data BYTEA,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      account_id BIGINT NOT NULL REFERENCES accounts(id)
        ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS sessions_account_idx
      ON sessions(account_id);

    CREATE TABLE IF NOT EXISTS bounties (
      id BIGSERIAL PRIMARY KEY,
      host_id BIGINT NOT NULL REFERENCES accounts(id)
        ON DELETE CASCADE,
      target_id BIGINT NOT NULL REFERENCES accounts(id)
        ON DELETE CASCADE,
      amount_massits BIGINT NOT NULL CHECK (amount_massits > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      UNIQUE(target_id)
    );
  `);

  await pool.query("DELETE FROM sessions WHERE expires_at < NOW()");
  console.log("PostgreSQL tables ready.");
}

function randomPosition() {
  return {
    x: Math.random() * WORLD_SIZE,
    y: Math.random() * WORLD_SIZE
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function radius(player) {
  return Math.sqrt(Math.max(1, player.mass) * 0.45);
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(data) {
  const message = JSON.stringify(data);

  for (const player of players.values()) {
    if (player.ws && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(message);
    }
  }
}

function makeFood() {
  const position = randomPosition();

  return {
    id: "f" + crypto.randomBytes(5).toString("hex"),
    x: position.x,
    y: position.y
  };
}

function parseCookies(req) {
  const cookies = {};

  for (const part of (req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");

    if (index < 0) continue;

    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    cookies[name] = decodeURIComponent(value);
  }

  return cookies;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function setSessionCookie(res, token, maxAge = 30 * 24 * 60 * 60) {
  let cookie =
    "supio_session=" + encodeURIComponent(token) +
    "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAge;

  if (process.env.NODE_ENV === "production") {
    cookie += "; Secure";
  }

  res.setHeader("Set-Cookie", cookie);
}

async function getAccountFromRequest(req) {
  const token = parseCookies(req).supio_session;

  if (!token) return null;

  const result = await pool.query(
    `SELECT a.id, a.username, a.massits, a.skin_unlocked
     FROM sessions s
     JOIN accounts a ON a.id = s.account_id
     WHERE s.token_hash = $1
       AND s.expires_at > NOW()`,
    [hashToken(token)]
  );

  return result.rows[0] || null;
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let total = 0;

    req.on("data", chunk => {
      total += chunk.length;

      if (total > 100000) {
        reject(new Error("Request too large."));
        req.destroy();
        return;
      }

      body += chunk;
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON."));
      }
    });

    req.on("error", reject);
  });
}

// ACCOUNT API
async function handleApi(req, res, url) {
  // REGISTER OR LOGIN
  if (
    req.method === "POST" &&
    (url.pathname === "/api/register" ||
     url.pathname === "/api/login")
  ) {
    const data = await readJson(req);

    const username = String(data.username || "").trim();
    const usernameLower = username.toLowerCase();
    const password = String(data.password || "");

    if (!/^[a-zA-Z0-9_]{3,18}$/.test(username)) {
      return sendJson(res, 400, {
        error: "Username must be 3–18 letters, numbers, or underscores."
      });
    }

    if (password.length < 8 || password.length > 100) {
      return sendJson(res, 400, {
        error: "Password must be 8–100 characters."
      });
    }

    let account;

    if (url.pathname === "/api/register") {
      const passwordHash = await bcrypt.hash(password, 12);

      try {
        const result = await pool.query(
          `INSERT INTO accounts
           (username, username_lower, password_hash)
           VALUES ($1, $2, $3)
           RETURNING id, username, massits, skin_unlocked`,
          [username, usernameLower, passwordHash]
        );

        account = result.rows[0];
      } catch (error) {
        if (error.code === "23505") {
          return sendJson(res, 409, {
            error: "That username is already taken."
          });
        }

        throw error;
      }
    } else {
      const result = await pool.query(
        `SELECT id, username, massits, skin_unlocked, password_hash
         FROM accounts
         WHERE username_lower = $1`,
        [usernameLower]
      );

      account = result.rows[0];

      if (!account ||
          !(await bcrypt.compare(password, account.password_hash))) {
        return sendJson(res, 401, {
          error: "Incorrect username or password."
        });
      }

      delete account.password_hash;
    }

    const token = crypto.randomBytes(32).toString("hex");

    await pool.query(
      `INSERT INTO sessions (token_hash, account_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [hashToken(token), account.id]
    );

    setSessionCookie(res, token);

    return sendJson(res, 200, {
      account: {
        id: account.id,
        username: account.username,
        massits: Number(account.massits),
        skinUnlocked: account.skin_unlocked
      }
    });
  }

  // CURRENT ACCOUNT
  if (req.method === "GET" && url.pathname === "/api/me") {
    const account = await getAccountFromRequest(req);

    if (!account) {
      return sendJson(res, 401, { error: "Please log in." });
    }

    return sendJson(res, 200, {
      account: {
        id: account.id,
        username: account.username,
        massits: Number(account.massits),
        skinUnlocked: account.skin_unlocked
      }
    });
  }

  // LOGOUT
  if (req.method === "POST" && url.pathname === "/api/logout") {
    const token = parseCookies(req).supio_session;

    if (token) {
      await pool.query(
        "DELETE FROM sessions WHERE token_hash = $1",
        [hashToken(token)]
      );
    }

    setSessionCookie(res, "", 0);

    return sendJson(res, 200, { ok: true });
  }

  // UNLOCK CUSTOM SKINS FOR 1,000 MASSITS
  if (req.method === "POST" && url.pathname === "/api/skin/unlock") {
    const account = await getAccountFromRequest(req);

    if (!account) {
      return sendJson(res, 401, { error: "Log in first." });
    }

    const result = await pool.query(
      `UPDATE accounts
       SET massits = massits - $1,
           skin_unlocked = TRUE
       WHERE id = $2
         AND massits >= $1
         AND skin_unlocked = FALSE
       RETURNING massits`,
      [SKIN_UNLOCK_COST, account.id]
    );

    if (!result.rowCount) {
      const check = await pool.query(
        "SELECT massits, skin_unlocked FROM accounts WHERE id = $1",
        [account.id]
      );

      if (check.rows[0]?.skin_unlocked) {
        return sendJson(res, 200, {
          massits: Number(check.rows[0].massits),
          skinUnlocked: true
        });
      }

      return sendJson(res, 400, {
        error: "You need 1,000 Massits to unlock custom skins."
      });
    }

    return sendJson(res, 200, {
      massits: Number(result.rows[0].massits),
      skinUnlocked: true
    });
  }

  // UPLOAD CUSTOM SKIN
  if (req.method === "POST" && url.pathname === "/api/skin/upload") {
    const account = await getAccountFromRequest(req);

    if (!account) {
      return sendJson(res, 401, { error: "Log in first." });
    }

    if (!account.skin_unlocked) {
      return sendJson(res, 403, {
        error: "Unlock custom skins for 1,000 Massits first."
      });
    }

    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    const boundary = boundaryMatch && (boundaryMatch[1] || boundaryMatch[2]);

    if (!contentType.startsWith("multipart/form-data") || !boundary) {
      return sendJson(res, 400, { error: "Choose an image or GIF." });
    }

    const chunks = [];
    let total = 0;

    for await (const chunk of req) {
      total += chunk.length;

      if (total > MAX_SKIN_BYTES + 20000) {
        return sendJson(res, 413, {
          error: "Your image must be 2 MB or smaller."
        });
      }

      chunks.push(chunk);
    }

    const body = Buffer.concat(chunks);
    const marker = Buffer.from("--" + boundary);
    const parts = [];
    let position = 0;

    while ((position = body.indexOf(marker, position)) >= 0) {
      position += marker.length;

      if (body.slice(position, position + 2).toString() === "--") break;

      if (body.slice(position, position + 2).toString() === "\r\n") {
        position += 2;
      }

      const next = body.indexOf(marker, position);
      if (next < 0) break;

      let part = body.slice(position, next);

      if (part.slice(-2).toString() === "\r\n") {
        part = part.slice(0, -2);
      }

      const separator = part.indexOf("\r\n\r\n");

      if (separator >= 0) {
        parts.push({
          headers: part.slice(0, separator).toString(),
          data: part.slice(separator + 4)
        });
      }

      position = next;
    }

    const file = parts.find(part =>
      /name="skin"/i.test(part.headers) &&
      /filename="/i.test(part.headers)
    );

    if (!file) {
      return sendJson(res, 400, { error: "No file selected." });
    }

    const image = file.data;

    if (image.length > MAX_SKIN_BYTES) {
      return sendJson(res, 413, {
        error: "Your image must be 2 MB or smaller."
      });
    }

    let mime = null;

    // PNG signature
    if (
      image.length >= 8 &&
      image.slice(0, 8).equals(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      )
    ) {
      mime = "image/png";
    }

    // JPG signature
    else if (
      image.length >= 3 &&
      image[0] === 255 &&
      image[1] === 216 &&
      image[2] === 255
    ) {
      mime = "image/jpeg";
    }

    // GIF signature
    else if (
      image.slice(0, 6).toString() === "GIF87a" ||
      image.slice(0, 6).toString() === "GIF89a"
    ) {
      mime = "image/gif";
    }

    if (!mime) {
      return sendJson(res, 400, {
        error: "Please upload a PNG, JPG, or GIF image."
      });
    }

    await pool.query(
      `UPDATE accounts
       SET skin_mime = $1, skin_data = $2
       WHERE id = $3`,
      [mime, image, account.id]
    );

    return sendJson(res, 200, { ok: true });
  }

  // GET A PLAYER'S SKIN
  const skinMatch = url.pathname.match(/^\/api\/skin\/(\d+)$/);

  if (req.method === "GET" && skinMatch) {
    const result = await pool.query(
      `SELECT skin_mime, skin_data
       FROM accounts
       WHERE id = $1`,
      [skinMatch[1]]
    );

    if (!result.rowCount || !result.rows[0].skin_data) {
      res.writeHead(404);
      return res.end("No skin found.");
    }

    res.writeHead(200, {
      "Content-Type": result.rows[0].skin_mime,
      "Cache-Control": "public, max-age=60"
    });

    return res.end(result.rows[0].skin_data);
  }

  // LIST BOUNTIES
  if (req.method === "GET" && url.pathname === "/api/bounties") {
    const account = await getAccountFromRequest(req);

    if (!account) {
      return sendJson(res, 401, { error: "Please log in." });
    }

    const result = await pool.query(
      `SELECT b.id, b.amount_massits, b.expires_at,
              h.username AS host, t.username AS target
       FROM bounties b
       JOIN accounts h ON h.id = b.host_id
       JOIN accounts t ON t.id = b.target_id
       ORDER BY b.created_at DESC`
    );

    return sendJson(res, 200, { bounties: result.rows });
  }

  // POST BOUNTY
  if (req.method === "POST" && url.pathname === "/api/bounties") {
    const account = await getAccountFromRequest(req);

    if (!account) {
      return sendJson(res, 401, { error: "Please log in." });
    }

    const data = await readJson(req);
    const targetName = String(data.target || "").trim().toLowerCase();
    const amount = Math.floor(Number(data.amount));

    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000) {
      return sendJson(res, 400, {
        error: "Bounty must be between 1 and 1,000,000 Massits."
      });
    }

    const targetResult = await pool.query(
      `SELECT id, username
       FROM accounts
       WHERE username_lower = $1`,
      [targetName]
    );

    if (!targetResult.rowCount) {
      return sendJson(res, 404, { error: "Wanted player account not found." });
    }

    const target = targetResult.rows[0];

    if (String(target.id) === String(account.id)) {
      return sendJson(res, 400, { error: "You can't put a bounty on yourself." });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // If a bounty already exists on this target, refund its owner.
      const oldBounty = await client.query(
        `DELETE FROM bounties
         WHERE target_id = $1
         RETURNING host_id, amount_massits`,
        [target.id]
      );

      if (oldBounty.rowCount) {
        await client.query(
          `UPDATE accounts
           SET massits = massits + $1
           WHERE id = $2`,
          [oldBounty.rows[0].amount_massits, oldBounty.rows[0].host_id]
        );
      }

      // Reserve the new bounty amount.
      const debit = await client.query(
        `UPDATE accounts
         SET massits = massits - $1
         WHERE id = $2 AND massits >= $1
         RETURNING id`,
        [amount, account.id]
      );

      if (!debit.rowCount) {
        await client.query("ROLLBACK");
        return sendJson(res, 400, { error: "Not enough Massits." });
      }

      await client.query(
        `INSERT INTO bounties
         (host_id, target_id, amount_massits, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')`,
        [account.id, target.id, amount]
      );

      await client.query("COMMIT");

      return sendJson(res, 200, {
        ok: true,
        message: "Bounty posted on " + target.username + "."
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Bounty creation error:", error);
      return sendJson(res, 500, { error: "Could not create bounty." });
    } finally {
      client.release();
    }
  }

  return false;
}

// HTTP SERVER
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  try {
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, url);

      if (handled !== false) return;

      return sendJson(res, 404, { error: "API route not found." });
    }

    let pathname = decodeURIComponent(url.pathname);

    if (pathname === "/") pathname = "/index.html";

    const filePath = path.resolve(publicDir, "." + pathname);

    if (
      !filePath.startsWith(publicDir + path.sep) &&
      filePath !== path.join(publicDir, "index.html")
    ) {
      res.writeHead(403);
      return res.end("Forbidden");
    }

    fs.readFile(filePath, (error, data) => {
      if (error) {
        res.writeHead(404);
        return res.end("Not found.");
      }

      const ext = path.extname(filePath);

      const types = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8"
      };

      res.writeHead(200, {
        "Content-Type": types[ext] || "application/octet-stream"
      });

      res.end(data);
    });
  } catch (error) {
    console.error("HTTP error:", error);

    if (!res.headersSent) {
      sendJson(res, 500, { error: "Server error. Check Railway logs." });
    }
  }
});

// PLAYER HELPERS
function getPlayerBySocket(ws) {
  for (const player of players.values()) {
    if (player.ws === ws && !player.isClone) return player;
  }

  return null;
}

function publicPlayer(player) {
  return {
    id: player.id,
    accountId: player.accountId,
    name: player.name,
    color: player.color,
    x: player.x,
    y: player.y,
    mass: Math.round(player.mass),
    size: player.mass,
    speedUpgrades: player.speedUpgrades,
    damageUpgrades: player.damageUpgrades,
    pelletDamage: player.pelletDamage,
    playerSpeed: player.playerSpeed,
    isClone: false,
    isWanted: wantedAccountIds.has(String(player.accountId)),
    skin: player.skin
  };
}

function allPlayers() {
  return [...players.values()].map(publicPlayer);
}

function createPlayer(ws, account, color) {
  const position = randomPosition();
  const id = String(nextPlayerId++);

  const player = {
    id,
    accountId: String(account.id),
    ws,
    name: account.username,
    color: /^#[0-9a-f]{6}$/i.test(color) ? color : "#55cc88",

    x: position.x,
    y: position.y,
    targetX: position.x,
    targetY: position.y,

    mass: START_MASS,

    speedUpgrades: 0,
    damageUpgrades: 0,
    pelletDamage: PELLET_DAMAGE,
    playerSpeed: PLAYER_SPEED,

    lastShoot: 0,
    lastFind: 0,
    cashingOut: false,

    skin: account.skin_unlocked
      ? "/api/skin/" + account.id
      : null
  };

  players.set(id, player);

  return player;
}

function removePlayer(player) {
  if (!player || !players.has(player.id)) return;

  players.delete(player.id);

  broadcast({
    type: "playerLeft",
    id: player.id
  });
}

// BOUNTY PAYOUT
async function awardBounty(target, killer) {
  if (!target || !killer || target.accountId === killer.accountId) return;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `DELETE FROM bounties
       WHERE target_id = $1
       RETURNING id, amount_massits`,
      [target.accountId]
    );

    if (!result.rowCount) {
      await client.query("COMMIT");
      return;
    }

    const bounty = result.rows[0];
    const bountyMass = Number(bounty.amount_massits) * MASS_PER_MASSIT;

    // Bounty is awarded as match mass, not permanent Massits.
    killer.mass += bountyMass;

    await client.query("COMMIT");

    broadcast({
      type: "bountyWon",
      winner: killer.name,
      target: target.name,
      mass: bountyMass
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Bounty payout error:", error);
  } finally {
    client.release();
  }
}

function killPlayer(player, reason, killerId = null, damage = null) {
  if (!player || !players.has(player.id)) return;

  const killer = killerId ? players.get(String(killerId)) : null;

  removePlayer(player);

  send(player.ws, {
    type: "died",
    reason,
    killerId,
    damage
  });

  if (killer && killer.accountId !== player.accountId) {
    awardBounty(player, killer).catch(console.error);
  }
}

// WEBSOCKET SERVER
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws, req) => {
  ws.account = null;

  // Authenticate using the persistent HttpOnly login cookie.
  getAccountFromRequest(req)
    .then(account => {
      ws.account = account;

      if (!account) {
        send(ws, { type: "authRequired" });
      }
    })
    .catch(error => {
      console.error("WebSocket authentication error:", error);
      ws.close();
    });

  ws.on("message", raw => {
    let data;

    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!data || typeof data.type !== "string") return;

    // Must be logged in before joining.
    if (!ws.account) {
      send(ws, {
        type: "notice",
        text: "Please log in before playing."
      });
      return;
    }

    if (data.type === "join") {
      if (getPlayerBySocket(ws)) return;

      const player = createPlayer(ws, ws.account, data.color);

      send(ws, {
        type: "welcome",
        id: player.id,
        playerId: player.id,
        worldSize: WORLD_SIZE,
        food,
        players: allPlayers(),
        massits: Number(ws.account.massits)
      });

      broadcast({
        type: "playerJoined",
        player: publicPlayer(player)
      });

      return;
    }

    const player = getPlayerBySocket(ws);

    if (!player) return;

    // MOVEMENT
    if (data.type === "move") {
      player.targetX = clamp(
        Number(data.x) || player.x,
        0,
        WORLD_SIZE
      );

      player.targetY = clamp(
        Number(data.y) || player.y,
        0,
        WORLD_SIZE
      );
    }

    // SHOOT
    else if (data.type === "shoot") {
      const now = Date.now();

      if (player.mass < 100) return;
      if (now - player.lastShoot < 80) return;

      player.lastShoot = now;

      const dx = player.targetX - player.x;
      const dy = player.targetY - player.y;
      const length = Math.hypot(dx, dy) || 1;

      pellets.push({
        id: String(nextPelletId++),
        ownerId: player.id,
        x: player.x,
        y: player.y,
        vx: dx / length * PELLET_SPEED,
        vy: dy / length * PELLET_SPEED,
        damage: player.pelletDamage,
        life: 100
      });

      player.mass = Math.max(100, player.mass - PELLET_MASS);
    }

    // FIND PLAYER
    else if (data.type === "findPlayer" || data.type === "clone") {
      const now = Date.now();

      if (player.mass < FIND_PLAYER_COST + 100) return;
      if (now - player.lastFind < 1200) return;

      let target = null;
      let bestDistance = Infinity;

      for (const other of players.values()) {
        if (other.id === player.id) continue;

        const d = distance(player, other);

        if (d < bestDistance) {
          bestDistance = d;
          target = other;
        }
      }

      if (!target) {
        send(ws, {
          type: "notice",
          text: "No opponent is online yet."
        });
        return;
      }

      player.lastFind = now;
      player.mass -= FIND_PLAYER_COST;

      const dx = target.x - player.x;
      const dy = target.y - player.y;
      const length = Math.hypot(dx, dy) || 1;

      findBalls.push({
        id: String(nextFindBallId++),
        ownerId: player.id,
        targetId: target.id,
        x: player.x,
        y: player.y,
        vx: dx / length * FIND_BALL_SPEED,
        vy: dy / length * FIND_BALL_SPEED,
        life: 450
      });

      send(ws, {
        type: "notice",
        text: "Find Player launched! -1,000 score."
      });
    }

    // UPGRADES
    else if (data.type === "upgrade") {
      if (data.upgrade !== "speed" && data.upgrade !== "damage") return;

      const key = data.upgrade === "speed"
        ? "speedUpgrades"
        : "damageUpgrades";

      const cost = UPGRADE_BASE_COST + player[key] * UPGRADE_COST_STEP;

      if (player.mass < cost) {
        send(ws, {
          type: "notice",
          text: "You need " + cost.toLocaleString() + " mass."
        });
        return;
      }

      player.mass -= cost;
      player[key]++;

      if (data.upgrade === "speed") {
        player.playerSpeed += SPEED_UPGRADE_AMOUNT;
      } else {
        player.pelletDamage += PELLET_DAMAGE_UPGRADE;
      }
    }

    // CHAT
    else if (data.type === "chat") {
      const text = String(data.text || "").trim().slice(0, 120);

      if (text) {
        broadcast({
          type: "chat",
          name: player.name,
          color: player.color,
          text
        });
      }
    }

    // CASH OUT ONLY WHEN THE PLAYER PRESSES QUIT & CASH OUT
    else if (data.type === "cashout") {
      if (player.cashingOut) return;

      player.cashingOut = true;

      const matchMass = Math.floor(player.mass);
      const earnedMassits = Math.floor(matchMass / MASS_PER_MASSIT);

      try {
        const result = await pool.query(
          `UPDATE accounts
           SET massits = massits + $1
           WHERE id = $2
           RETURNING massits`,
          [earnedMassits, player.accountId]
        );

        if (!result.rowCount) {
          player.cashingOut = false;

          send(ws, {
            type: "notice",
            text: "Cash-out failed. Please try again."
          });

          return;
        }

        send(ws, {
          type: "cashoutDone",
          massits: Number(result.rows[0].massits),
          earned: earnedMassits,
          mass: matchMass
        });

        removePlayer(player);
      } catch (error) {
        console.error("Cash-out error:", error);
        player.cashingOut = false;

        send(ws, {
          type: "notice",
          text: "Cash-out failed. Check your connection and try again."
        });
      }
    }
  });

  // Closing the tab removes the player from the match.
  // It does NOT automatically cash out.
  ws.on("close", () => {
    const player = getPlayerBySocket(ws);

    if (player) {
      removePlayer(player);
    }
  });
});

// GAME LOOP
function tick() {
  // MOVE PLAYERS
  for (const player of players.values()) {
    const dx = player.targetX - player.x;
    const dy = player.targetY - player.y;
    const d = Math.hypot(dx, dy);

    if (d > 2) {
      const speed = player.playerSpeed *
        Math.max(0.55, Math.min(1.25, 1000 / Math.max(1000, player.mass)));

      player.x = clamp(
        player.x + dx / d * Math.min(speed, d),
        0,
        WORLD_SIZE
      );

      player.y = clamp(
        player.y + dy / d * Math.min(speed, d),
        0,
        WORLD_SIZE
      );
    }
  }

  // MOVE AND HIT PELLETS
  for (let i = pellets.length - 1; i >= 0; i--) {
    const bullet = pellets[i];

    bullet.x += bullet.vx;
    bullet.y += bullet.vy;
    bullet.life--;

    let hit = false;

    for (const player of players.values()) {
      if (player.id === bullet.ownerId) continue;

      if (distance(bullet, player) < radius(player) + 5) {
        player.mass = Math.max(0, player.mass - bullet.damage);
        hit = true;

        if (player.mass <= 0) {
          killPlayer(player, "pellet", bullet.ownerId, bullet.damage);
        }

        break;
      }
    }

    if (
      hit ||
      bullet.life <= 0 ||
      bullet.x < 0 ||
      bullet.y < 0 ||
      bullet.x > WORLD_SIZE ||
      bullet.y > WORLD_SIZE
    ) {
      pellets.splice(i, 1);
    }
  }

  // FIND PLAYER BALLS
  for (let i = findBalls.length - 1; i >= 0; i--) {
    const ball = findBalls[i];
    const target = players.get(ball.targetId);

    if (!target) {
      findBalls.splice(i, 1);
      continue;
    }

    const dx = target.x - ball.x;
    const dy = target.y - ball.y;
    const d = Math.hypot(dx, dy) || 1;

    ball.vx = dx / d * FIND_BALL_SPEED;
    ball.vy = dy / d * FIND_BALL_SPEED;

    ball.x += ball.vx;
    ball.y += ball.vy;
    ball.life--;

    if (d < radius(target) + 12 || ball.life <= 0) {
      findBalls.splice(i, 1);
    }
  }

  // EAT FOOD AND RESPAWN FOOD
  for (const player of players.values()) {
    for (let i = food.length - 1; i >= 0; i--) {
      if (distance(player, food[i]) < radius(player)) {
        const eatenFood = food[i];

        food.splice(i, 1);
        player.mass += FOOD_GAIN;

        const replacement = makeFood();
        food.push(replacement);

        broadcast({
          type: "dotEaten",
          playerId: player.id,
          dotId: eatenFood.id,
          mass: player.mass
        });

        broadcast({
          type: "dotRespawn",
          dot: replacement
        });
      }
    }
  }

  // ABSORB SMALLER PLAYERS
  const list = [...players.values()];

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];

      if (!players.has(a.id) || !players.has(b.id)) continue;

      if (
        distance(a, b) < radius(a) * 0.72 &&
        a.mass > b.mass * 1.15
      ) {
        a.mass += b.mass * 0.8;

        killPlayer(b, "absorbed", a.id);

        broadcast({
          type: "playerEaten",
          eaterId: a.id,
          eatenId: b.id
        });
      } else if (
        distance(a, b) < radius(b) * 0.72 &&
        b.mass > a.mass * 1.15
      ) {
        b.mass += a.mass * 0.8;

        killPlayer(a, "absorbed", b.id);

        broadcast({
          type: "playerEaten",
          eaterId: b.id,
          eatenId: a.id
        });
      }
    }
  }

  // SEND WORLD STATE
  broadcast({
    type: "state",
    players: allPlayers(),
    pellets: pellets.map(b => ({
      id: b.id,
      x: b.x,
      y: b.y
    })),
    findBalls: findBalls.map(b => ({
      id: b.id,
      x: b.x,
      y: b.y
    }))
  });
}

// REFRESH WANTED PLAYER LIST
async function refreshWantedPlayers() {
  try {
    const result = await pool.query(
      "SELECT target_id FROM bounties WHERE expires_at > NOW()"
    );

    wantedAccountIds = new Set(
      result.rows.map(row => String(row.target_id))
    );
  } catch (error) {
    console.error("Could not refresh bounty list:", error);
  }
}

// EXPIRED BOUNTIES: REFUND THE HOST
async function refundExpiredBounties() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `DELETE FROM bounties
       WHERE expires_at < NOW()
       RETURNING host_id, amount_massits`
    );

    for (const bounty of result.rows) {
      await client.query(
        `UPDATE accounts
         SET massits = massits + $1
         WHERE id = $2`,
        [bounty.amount_massits, bounty.host_id]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Bounty refund error:", error);
  } finally {
    client.release();
  }
}

// START
food = Array.from({ length: FOOD_COUNT }, makeFood);

setInterval(tick, 1000 / 30);
setInterval(refreshWantedPlayers, 10000);
setInterval(refundExpiredBounties, 60000);

initDatabase()
  .then(async () => {
    await refreshWantedPlayers();

    server.listen(PORT, "0.0.0.0", () => {
      console.log("sup.io server running on port " + PORT);
    });
  })
  .catch(error => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
