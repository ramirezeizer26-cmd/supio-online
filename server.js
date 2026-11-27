const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const WORLD_SIZE = 6000;
const FOOD_COUNT = 4500;
const START_MASS = 1000;
const PLAYER_SPEED = 7;
const PELLET_SPEED = 12;
const PELLET_DAMAGE = 1000;
const PELLET_MASS = 25;
const FIND_PLAYER_COST = 1000;
const FIND_BALL_SPEED = 13;

const publicDir = path.join(__dirname, "public");
const server = http.createServer((req, res) => {
  let pathname = "/";
  try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); } catch {}
  if (pathname === "/") pathname = "/index.html";
  const safePath = path.normalize(path.join(publicDir, pathname));
  if (!safePath.startsWith(publicDir)) {
    res.writeHead(403); return res.end("Forbidden");
  }
  fs.readFile(safePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const ext = path.extname(safePath);
    const type = ext === ".html" ? "text/html; charset=utf-8" :
      ext === ".js" ? "text/javascript; charset=utf-8" :
      ext === ".css" ? "text/css; charset=utf-8" : "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
const players = new Map();
const pellets = [];
const findBalls = [];
let nextId = 1;
let nextPelletId = 1;
let nextFindBallId = 1;

function randomPos() {
  return { x: Math.random() * WORLD_SIZE, y: Math.random() * WORLD_SIZE };
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function radius(p) { return Math.sqrt(Math.max(1, p.mass) * 0.45); }
function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  }
}
function getPlayer(ws) {
  for (const p of players.values()) if (p.ws === ws && !p.isClone) return p;
  return null;
}
function makeFood() {
  const p = randomPos();
  return { id: "f" + Math.random().toString(36).slice(2), x: p.x, y: p.y };
}
const food = Array.from({ length: FOOD_COUNT }, makeFood);

function publicPlayer(p) {
  return {
    id: p.id, ownerId: p.ownerId, name: p.name, color: p.color,
    x: p.x, y: p.y, mass: Math.round(p.mass), size: p.mass,
    isClone: !!p.isClone
  };
}
function allPlayers() { return [...players.values()].map(publicPlayer); }

function createPlayer(ws, name, color) {
  const p = randomPos();
  const id = String(nextId++);
  const player = {
    id, ownerId: id, ws,
    name: String(name || "Player").slice(0, 18),
    color: /^#[0-9a-f]{6}$/i.test(color) ? color : "#55cc88",
    x: p.x, y: p.y, targetX: p.x, targetY: p.y,
    mass: START_MASS, alive: true, isClone: false,
    lastShoot: 0, lastFind: 0
  };
  players.set(id, player);
  return player;
}

function handleMove(ws, data) {
  const p = getPlayer(ws);
  if (!p) return;
  p.targetX = clamp(Number(data.x) || p.x, 0, WORLD_SIZE);
  p.targetY = clamp(Number(data.y) || p.y, 0, WORLD_SIZE);
}
function handleShoot(ws) {
  const p = getPlayer(ws);
  if (!p || p.mass < 100) return;
  const now = Date.now();
  if (now - p.lastShoot < 80) return;
  p.lastShoot = now;

  const dx = p.targetX - p.x;
  const dy = p.targetY - p.y;
  const len = Math.hypot(dx, dy) || 1;
  pellets.push({
    id: String(nextPelletId++), ownerId: p.ownerId,
    x: p.x, y: p.y, vx: dx / len * PELLET_SPEED,
    vy: dy / len * PELLET_SPEED, mass: PELLET_MASS, life: 100
  });
  p.mass = Math.max(100, p.mass - PELLET_MASS);
}
function handleFindPlayer(ws) {
  const p = getPlayer(ws);
  if (!p || p.mass < FIND_PLAYER_COST + 100) return;
  const now = Date.now();
  if (now - p.lastFind < 1200) return;

  let target = null;
  let best = Infinity;
  for (const other of players.values()) {
    if (!other.alive || other.isClone || other.id === p.id) continue;
    const d = distance(p, other);
    if (d < best) { best = d; target = other; }
  }
  if (!target) {
    send(ws, { type: "notice", text: "No opponent is online yet." });
    return;
  }

  p.lastFind = now;
  p.mass -= FIND_PLAYER_COST;

  // Spawn exactly at the player's current position.
  const dx = target.x - p.x;
  const dy = target.y - p.y;
  const len = Math.hypot(dx, dy) || 1;
  findBalls.push({
    id: String(nextFindBallId++), ownerId: p.ownerId,
    x: p.x, y: p.y, targetId: target.id,
    vx: dx / len * FIND_BALL_SPEED,
    vy: dy / len * FIND_BALL_SPEED,
    life: 450
  });
  send(ws, { type: "notice", text: "Find Player launched! -1000 score." });
}
function handleChat(ws, text) {
  const p = getPlayer(ws);
  if (!p) return;
  text = String(text || "").trim().slice(0, 120);
  if (!text) return;
  broadcast({ type: "chat", name: p.name, color: p.color, text });
}

wss.on("connection", ws => {
  ws.on("message", raw => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (!data || typeof data.type !== "string") return;

    if (data.type === "join") {
      if (getPlayer(ws)) return;
      const p = createPlayer(ws, data.name, data.color);
      send(ws, {
        type: "welcome", id: p.id, playerId: p.id,
        worldSize: WORLD_SIZE, food, players: allPlayers()
      });
      broadcast({ type: "playerJoined", player: publicPlayer(p) });
    } else if (data.type === "move") handleMove(ws, data);
    else if (data.type === "shoot") handleShoot(ws);
    else if (data.type === "findPlayer" || data.type === "clone") handleFindPlayer(ws);
    else if (data.type === "chat") handleChat(ws, data.text);
  });

  ws.on("close", () => {
    const p = getPlayer(ws);
    if (!p) return;
    for (const [id, other] of players) {
      if (other.ownerId === p.id) players.delete(id);
    }
    broadcast({ type: "playerLeft", id: p.id });
  });
});

function tick() {
  // Move players toward their pointer.
  for (const p of players.values()) {
    if (p.isClone) continue;
    const dx = p.targetX - p.x, dy = p.targetY - p.y;
    const d = Math.hypot(dx, dy);
    if (d > 2) {
      const speed = PLAYER_SPEED * Math.max(0.55, Math.min(1.25, 1000 / Math.max(1000, p.mass)));
      p.x = clamp(p.x + dx / d * Math.min(speed, d), 0, WORLD_SIZE);
      p.y = clamp(p.y + dy / d * Math.min(speed, d), 0, WORLD_SIZE);
    }
  }

  // Move ordinary shooting pellets. A hit removes 1000 score from opponent.
  for (let i = pellets.length - 1; i >= 0; i--) {
    const b = pellets[i];
    b.x += b.vx; b.y += b.vy; b.life--;
    let hit = false;
    for (const p of players.values()) {
      if (p.isClone || p.ownerId === b.ownerId) continue;
      if (distance(b, p) < radius(p) + 5) {
        p.mass = Math.max(100, p.mass - PELLET_DAMAGE);
        hit = true; break;
      }
    }
    if (hit || b.life <= 0 || b.x < 0 || b.y < 0 || b.x > WORLD_SIZE || b.y > WORLD_SIZE) pellets.splice(i, 1);
  }

  // Find Player balls chase the nearest opponent and never change opponent score.
  for (let i = findBalls.length - 1; i >= 0; i--) {
    const b = findBalls[i];
    const target = players.get(b.targetId);
    if (!target || target.isClone) {
      findBalls.splice(i, 1); continue;
    }
    const dx = target.x - b.x, dy = target.y - b.y;
    const d = Math.hypot(dx, dy) || 1;
    b.vx = dx / d * FIND_BALL_SPEED;
    b.vy = dy / d * FIND_BALL_SPEED;
    b.x += b.vx; b.y += b.vy; b.life--;
    if (d < radius(target) + 12 || b.life <= 0) findBalls.splice(i, 1);
  }

  // Food pickup and respawn.
  for (const p of players.values()) {
    if (p.isClone) continue;
    for (let i = food.length - 1; i >= 0; i--) {
      if (distance(p, food[i]) < radius(p)) {
        const eaten = food[i];
        food.splice(i, 1);
        p.mass += 100;
        const replacement = makeFood();
        food.push(replacement);
        broadcast({ type: "dotEaten", playerId: p.id, dotId: eaten.id, mass: p.mass });
        broadcast({ type: "dotRespawn", dot: replacement });
      }
    }
  }

  // Players can absorb smaller opponents.
  const list = [...players.values()].filter(p => !p.isClone);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (!players.has(a.id) || !players.has(b.id)) continue;
      if (distance(a, b) < radius(a) * 0.72 && a.mass > b.mass * 1.15) {
        a.mass += b.mass * 0.8;
        players.delete(b.id);
        broadcast({ type: "playerEaten", eaterId: a.id, eatenId: b.id });
      } else if (distance(a, b) < radius(b) * 0.72 && b.mass > a.mass * 1.15) {
        b.mass += a.mass * 0.8;
        players.delete(a.id);
        broadcast({ type: "playerEaten", eaterId: b.id, eatenId: a.id });
      }
    }
  }

  broadcast({
    type: "state",
    players: allPlayers(),
    pellets: pellets.map(b => ({ id: b.id, x: b.x, y: b.y })),
    findBalls: findBalls.map(b => ({ id: b.id, x: b.x, y: b.y }))
  });
}
setInterval(tick, 1000 / 30);

server.listen(PORT, "0.0.0.0", () => {
  console.log("sup.io server running on port " + PORT);
});
