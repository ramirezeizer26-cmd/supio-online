
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const WORLD_WIDTH = 6000;
const WORLD_HEIGHT = 6000;
const DOT_COUNT = 4500;
const START_MASS = 1000;

const DOT_MASS = 100;
const PLAYER_SPEED = 4;
const SHOOT_COOLDOWN = 80;
const PELLET_SPEED = 12;
const PELLET_MASS = 25;

const PUBLIC_DIR = path.join(__dirname, "public");

const players = new Map();
const dots = [];
const pellets = [];
const nukes = [];

let nextPlayerId = 1;
let nextDotId = 1;
let nextPelletId = 1;

function randomNumber(min, max) {
  return Math.random() * (max - min) + min;
}

function randomColor() {
  const colors = [
    "#ff4d4d",
    "#4d9dff",
    "#48d17a",
    "#ffd447",
    "#bd69ff",
    "#ff8c42",
    "#ff65b5"
  ];

  return colors[Math.floor(Math.random() * colors.length)];
}

function randomPosition() {
  return {
    x: randomNumber(100, WORLD_WIDTH - 100),
    y: randomNumber(100, WORLD_HEIGHT - 100)
  };
}

function createDot() {
  const pos = randomPosition();

  return {
    id: nextDotId++,
    x: pos.x,
    y: pos.y,
    mass: DOT_MASS,
    size: DOT_MASS,
    color: "#38d96b"
  };
}

function initializeDots() {
  dots.length = 0;

  for (let i = 0; i < DOT_COUNT; i++) {
    dots.push(createDot());
  }
}

function sendTo(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(data) {
  const message = JSON.stringify(data);

  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

function getPlayerBySocket(ws) {
  if (!ws.playerId) return null;
  return players.get(ws.playerId) || null;
}

function createPlayer(ws, name, color) {
  const id = String(nextPlayerId++);
  const pos = randomPosition();

  const player = {
    id,
    ownerId: id,
    name: String(name || "Player").slice(0, 16),
    color: color || randomColor(),

    x: pos.x,
    y: pos.y,

    targetX: pos.x,
    targetY: pos.y,

    mass: START_MASS,
    size: START_MASS,

    isClone: false,
    alive: true,

    lastShoot: 0,
    lastClone: 0
  };

  players.set(id, player);
  ws.playerId = id;

  return player;
}

function getPlayerList() {
  return Array.from(players.values()).map(player => ({
    id: player.id,
    ownerId: player.ownerId,
    name: player.name,
    color: player.color,
    x: player.x,
    y: player.y,
    mass: player.mass,
    size: player.mass,
    isClone: player.isClone
  }));
}

function getPelletList() {
  return pellets.map(p => ({
    id: p.id,
    ownerId: p.ownerId,
    x: p.x,
    y: p.y,
    mass: p.mass,
    size: p.mass,
    color: p.color
  }));
}

function getDotList() {
  return dots.map(dot => ({
    id: dot.id,
    x: dot.x,
    y: dot.y,
    mass: dot.mass,
    size: dot.mass,
    color: dot.color
  }));
}

function broadcastState() {
  broadcast({
    type: "state",
    players: getPlayerList(),
    pellets: getPelletList(),
    nukes
  });
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function playerRadius(player) {
  return Math.sqrt(Math.max(1, player.mass)) * 1.5;
}

function pelletRadius(pellet) {
  return Math.sqrt(Math.max(1, pellet.mass)) * 1.5;
}

function respawnPlayer(player) {
  const pos = randomPosition();

  player.x = pos.x;
  player.y = pos.y;
  player.targetX = pos.x;
  player.targetY = pos.y;

  player.mass = START_MASS;
  player.size = START_MASS;
  player.alive = true;
}

function removePlayerAndClones(ownerId) {
  for (const [id, player] of players) {
    if (player.ownerId === ownerId) {
      players.delete(id);
    }
  }
}

function handleMove(ws, data) {
  const player = getPlayerBySocket(ws);
  if (!player) return;

  const x = Number(data.x);
  const y = Number(data.y);

  if (!Number.isFinite(x) || !Number.isFinite(y)) return;

  player.targetX = Math.max(0, Math.min(WORLD_WIDTH, x));
  player.targetY = Math.max(0, Math.min(WORLD_HEIGHT, y));
}

function handleShoot(ws) {
  const player = getPlayerBySocket(ws);
  if (!player || !player.alive) return;

  const now = Date.now();

  if (now - player.lastShoot < SHOOT_COOLDOWN) return;
  player.lastShoot = now;

  const dx = player.targetX - player.x;
  const dy = player.targetY - player.y;
  const length = Math.sqrt(dx * dx + dy * dy) || 1;

  const pellet = {
    id: nextPelletId++,
    ownerId: player.ownerId,
    x: player.x + (dx / length) * (playerRadius(player) + 10),
    y: player.y + (dy / length) * (playerRadius(player) + 10),
    vx: (dx / length) * PELLET_SPEED,
    vy: (dy / length) * PELLET_SPEED,
    mass: PELLET_MASS,
    color: player.color,
    life: 90
  };

  pellets.push(pellet);

  player.mass = Math.max(100, player.mass - PELLET_MASS);
  player.size = player.mass;
}

function handleClone(ws) {
  const player = getPlayerBySocket(ws);
  if (!player || !player.alive) return;

  const now = Date.now();
  if (now - player.lastClone < 1000) return;
  player.lastClone = now;

  if (player.mass < 500) return;

  player.mass = Math.floor(player.mass / 2);
  player.size = player.mass;

  const pos = randomPosition();
  const cloneId = String(nextPlayerId++);

  const clone = {
    id: cloneId,
    ownerId: player.ownerId,
    name: player.name + " clone",
    color: player.color,

    x: player.x + 40,
    y: player.y + 40,

    targetX: player.targetX,
    targetY: player.targetY,

    mass: player.mass,
    size: player.mass,

    isClone: true,
    alive: true,

    lastShoot: 0,
    lastClone: 0
  };

  players.set(cloneId, clone);
}

function handleChat(ws, data) {
  const player = getPlayerBySocket(ws);
  if (!player) return;

  const text = String(data.text || "").trim().slice(0, 160);
  if (!text) return;

  // Secret command; intentionally not listed in the game instructions.
  if (text === "*summon_missel*") {
    const nuke = {
      id: Date.now(),
      x: player.x,
      y: player.y,
      ownerId: player.ownerId,
      start: Date.now()
    };

    nukes.push(nuke);

    broadcast({
      type: "nuke",
      nuke
    });

    return;
  }

  broadcast({
    type: "chat",
    name: player.name,
    color: player.color,
    text
  });
}

function handleMessage(ws, data) {
  if (!data || typeof data.type !== "string") return;

  switch (data.type) {
    case "join": {
      if (ws.playerId) return;

      const player = createPlayer(ws, data.name, data.color);

      sendTo(ws, {
        type: "welcome",
        id: player.id,
        playerId: player.id,
        dots: getDotList(),
        players: getPlayerList(),
        pellets: getPelletList()
      });

      broadcast({
        type: "playerJoined",
        player: {
          id: player.id,
          name: player.name,
          color: player.color,
          x: player.x,
          y: player.y,
          mass: player.mass,
          size: player.mass
        }
      });

      break;
    }

    case "move":
      handleMove(ws, data);
      break;

    case "shoot":
      handleShoot(ws);
      break;

    case "clone":
      handleClone(ws);
      break;

    case "chat":
      handleChat(ws, data);
      break;
  }
}

function updatePlayers() {
  for (const player of players.values()) {
    if (!player.alive) continue;

    // Clones follow their owner's target.
    if (player.isClone) {
      const owner = players.get(player.ownerId);

      if (owner) {
        player.targetX = owner.targetX;
        player.targetY = owner.targetY;
      }
    }

    const dx = player.targetX - player.x;
    const dy = player.targetY - player.y;
    const distanceToTarget = Math.sqrt(dx * dx + dy * dy);

    if (distanceToTarget > 2) {
      const speed = PLAYER_SPEED * Math.max(
        0.45,
        Math.min(1.2, 1000 / Math.max(1000, player.mass))
      );

      player.x += (dx / distanceToTarget) * speed;
      player.y += (dy / distanceToTarget) * speed;
    }

    player.x = Math.max(0, Math.min(WORLD_WIDTH, player.x));
    player.y = Math.max(0, Math.min(WORLD_HEIGHT, player.y));
  }
}

function updateDots() {
  for (const player of players.values()) {
    if (!player.alive) continue;

    for (let i = dots.length - 1; i >= 0; i--) {
      const dot = dots[i];

      if (distance(player, dot) < playerRadius(player) + 8) {
        dots.splice(i, 1);

        player.mass += DOT_MASS;
        player.size = player.mass;

        const newDot = createDot();
        dots.push(newDot);

        broadcast({
          type: "dotEaten",
          id: dot.id,
          playerId: player.id
        });

        broadcast({
          type: "dotRespawn",
          dot: newDot
        });
      }
    }
  }
}

function updatePellets() {
  for (let i = pellets.length - 1; i >= 0; i--) {
    const pellet = pellets[i];

    pellet.x += pellet.vx;
    pellet.y += pellet.vy;
    pellet.life--;

    if (
      pellet.life <= 0 ||
      pellet.x < 0 ||
      pellet.y < 0 ||
      pellet.x > WORLD_WIDTH ||
      pellet.y > WORLD_HEIGHT
    ) {
      pellets.splice(i, 1);
      continue;
    }

    for (const player of players.values()) {
      if (!player.alive) continue;
      if (player.ownerId === pellet.ownerId) continue;

      if (distance(player, pellet) < playerRadius(player) + pelletRadius(pellet)) {
        player.mass += pellet.mass;
        player.size = player.mass;
        pellets.splice(i, 1);
        break;
      }
    }
  }
}

function updatePlayerCollisions() {
  const list = Array.from(players.values());

  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.alive) continue;

    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (!b.alive) continue;

      // Players from the same account do not eat each other.
      if (a.ownerId === b.ownerId) continue;

      const dist = distance(a, b);
      const eatDistance = playerRadius(a) * 0.75;

      if (dist < eatDistance && a.mass > b.mass * 1.15) {
        a.mass += b.mass;
        a.size = a.mass;

        if (b.isClone) {
          players.delete(b.id);
        } else {
          removePlayerAndClones(b.ownerId);

          broadcast({
            type: "gameOver",
            playerId: b.ownerId
          });

          // Main player is respawned after being eaten.
          respawnPlayer(b);
          players.set(b.id, b);
        }
      } else if (dist < playerRadius(b) * 0.75 && b.mass > a.mass * 1.15) {
        b.mass += a.mass;
        b.size = b.mass;

        if (a.isClone) {
          players.delete(a.id);
        } else {
          removePlayerAndClones(a.ownerId);

          broadcast({
            type: "gameOver",
            playerId: a.ownerId
          });

          respawnPlayer(a);
          players.set(a.id, a);
        }
      }
    }
  }
}

function updateNukes() {
  const now = Date.now();

  for (let i = nukes.length - 1; i >= 0; i--) {
    const nuke = nukes[i];

    if (now - nuke.start > 2500) {
      nukes.splice(i, 1);
      continue;
    }

    for (const player of players.values()) {
      if (!player.alive || player.ownerId === nuke.ownerId) continue;

      if (distance(player, nuke) < 250) {
        player.mass = Math.max(100, Math.floor(player.mass * 0.5));
        player.size = player.mass;
      }
    }
  }
}

function gameTick() {
  updatePlayers();
  updateDots();
  updatePellets();
  updatePlayerCollisions();
  updateNukes();

  broadcastState();
}

initializeDots();

// Serve the HTML game.
const httpServer = http.createServer((req, res) => {
  let requestPath = decodeURIComponent(req.url.split("?")[0]);

  if (requestPath === "/") {
    requestPath = "/index.html";
  }

  const filePath = path.normalize(
    path.join(PUBLIC_DIR, requestPath)
  );

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("File not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();

    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".svg": "image/svg+xml"
    };

    res.writeHead(200, {
      "Content-Type": contentTypes[ext] || "application/octet-stream"
    });

    res.end(content);
  });
});

// WebSocket server shares the same HTTP server.
const wss = new WebSocket.Server({
  server: httpServer
});

wss.on("connection", ws => {
  ws.playerId = null;

  ws.on("message", message => {
    try {
      const data = JSON.parse(message.toString());
      handleMessage(ws, data);
    } catch (error) {
      console.error("Invalid client message:", error.message);
    }
  });

  ws.on("close", () => {
    const player = getPlayerBySocket(ws);

    if (player) {
      removePlayerAndClones(player.ownerId);

      broadcast({
        type: "playerLeft",
        playerId: player.ownerId
      });
    }
  });

  ws.on("error", error => {
    console.error("WebSocket error:", error.message);
  });
});

setInterval(gameTick, 1000 / 30);

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`sup.io server running on port ${PORT}`);
});
