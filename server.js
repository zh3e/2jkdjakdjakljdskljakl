/**
 * =============================================
 * BLAZE CASINO — BACKEND SERVER
 * Node.js + WebSocket + Minecraft log reader
 * =============================================
 */

const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

// ─── CONFIG ───────────────────────────────────
const CONFIG = {
  // Port du serveur WebSocket
  WS_PORT: 3001,
  // Port du serveur HTTP (pour servir le frontend)
  HTTP_PORT: 3000,
  // Chemin vers le dossier public (frontend)
  PUBLIC_DIR: path.join(__dirname, 'public'),

  // ── MINECRAFT LOG ──
  // Option A : Chemin vers le fichier latest.log de votre serveur Minecraft
  // Laissez vide '' si vous utilisez le plugin Bukkit/Spigot (Option B)
  MINECRAFT_LOG_PATH: '/path/to/your/minecraft/server/logs/latest.log',

  // ── SÉCURITÉ ──
  // Token admin pour les actions sensibles (changez-le!)
  ADMIN_TOKEN: 'blaze-secret-2024',

  // Durée d'un round en secondes
  ROUND_DURATION: 60,

  // House edge (pourcentage gardé par la maison, ex: 0.10 = 10%)
  HOUSE_EDGE: 0.05,

  // Format du message de paiement Minecraft (regex)
  // Exemple: "ZxrkyOnTop paid you $103489."
  PAYMENT_REGEX: /^(\w+) paid you \$(\d+(?:\.\d+)?)\./,
};

// ─── AUTH (SQLite) ─────────────────────────────
const Database = require('better-sqlite3');
const DB_PATH = path.join(__dirname, 'casino.db');
const db = new Database(DB_PATH);

// Create tables if they don't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT    NOT NULL,
    hash         TEXT    NOT NULL,
    salt         TEXT    NOT NULL,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS balances (
    username   TEXT PRIMARY KEY COLLATE NOCASE,
    amount     INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT    NOT NULL COLLATE NOCASE,
    type       TEXT    NOT NULL,
    amount     INTEGER NOT NULL,
    note       TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS pending_withdrawals (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT    NOT NULL COLLATE NOCASE,
    mc_player  TEXT    NOT NULL,
    amount     INTEGER NOT NULL,
    status     TEXT    NOT NULL DEFAULT 'pending',
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// Prepared statements
const stmtFindUser        = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE');
const stmtInsertUser      = db.prepare('INSERT INTO users (username, display_name, hash, salt) VALUES (?, ?, ?, ?)');
const stmtInsertToken     = db.prepare('INSERT INTO sessions (token, username) VALUES (?, ?)');
const stmtFindToken       = db.prepare('SELECT username FROM sessions WHERE token = ?');
const stmtDeleteToken     = db.prepare('DELETE FROM sessions WHERE token = ?');
const stmtGetBalance      = db.prepare('SELECT amount FROM balances WHERE username = ? COLLATE NOCASE');
const stmtSetBalance      = db.prepare('INSERT INTO balances (username, amount) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET amount = excluded.amount');
const stmtAddTransaction  = db.prepare('INSERT INTO transactions (username, type, amount, note) VALUES (?, ?, ?, ?)');
const stmtGetTransactions = db.prepare('SELECT * FROM transactions WHERE username = ? COLLATE NOCASE ORDER BY id DESC LIMIT 20');
const stmtInsertWithdraw  = db.prepare('INSERT INTO pending_withdrawals (username, mc_player, amount) VALUES (?, ?, ?)');
const stmtUpdateWithdraw  = db.prepare('UPDATE pending_withdrawals SET status = ? WHERE id = ?');
const stmtGetPendingWithdraws = db.prepare("SELECT * FROM pending_withdrawals WHERE status = 'pending' ORDER BY id ASC");

// ─── BALANCE HELPERS ──────────────────────────
function getBalance(username) {
  const row = stmtGetBalance.get(username);
  return row ? row.amount : 0;
}

function adjustBalance(username, delta, type, note) {
  const current = getBalance(username);
  const newAmount = current + delta;
  stmtSetBalance.run(username.toLowerCase(), newAmount);
  stmtAddTransaction.run(username.toLowerCase(), type, delta, note || null);
  return newAmount;
}

function hashPassword(password, salt) {
  return crypto.createHmac('sha256', salt).update(password).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createUser(username, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  stmtInsertUser.run(username.toLowerCase(), username, hash, salt);
}

function userExists(username) {
  return !!stmtFindUser.get(username);
}

function verifyUser(username, password) {
  const u = stmtFindUser.get(username);
  if (!u) return false;
  return hashPassword(password, u.salt) === u.hash;
}

function issueToken(username) {
  const token = generateToken();
  stmtInsertToken.run(token, username.toLowerCase());
  return token;
}

function validateToken(token) {
  if (!token) return null;
  const row = stmtFindToken.get(token);
  return row ? row.username : null;
}

// Migrate: add mc_player column if missing
try { db.exec('ALTER TABLE users ADD COLUMN mc_player TEXT'); } catch(e) {}

console.log(`[DB] SQLite database ready: ${DB_PATH}`);


let gameState = {
  players: {},       // { name: amount }
  totalStakes: 0,
  timerActive: false,
  timerSeconds: CONFIG.ROUND_DURATION,
  phase: 'waiting',  // waiting | active | drawing | winner
  winners: [],
  lastWinner: null,
  timerInterval: null,
  nextRound: {},     // { name: amount } — mises en attente pour le prochain round
  nextRoundTotal: 0,
};

// ─── HTTP SERVER (Sert le frontend + API) ─────
const httpServer = http.createServer((req, res) => {

  // ── API: POST /api/auth/signup ──
  if (req.url === '/api/auth/signup' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { username, password } = JSON.parse(body);
        if (!username || !password) throw new Error('Missing fields');
        const key = username.trim().toLowerCase();
        if (!/^[a-zA-Z0-9_.]{3,20}$/.test(username.trim())) {
          res.writeHead(400, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({ error: 'Username must be 3–20 chars (letters, numbers, _ .)' }));
          return;
        }
        if (userExists(username.trim())) {
          res.writeHead(409, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({ error: 'Username already taken.' }));
          return;
        }
        createUser(username.trim(), password);
        const token = issueToken(username.trim());
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ ok: true, token }));
        console.log(`[AUTH] New user registered: ${username.trim()}`);
      } catch(e) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ error: 'Bad request' }));
      }
    });
    return;
  }

  // ── API: POST /api/auth/login ──
  if (req.url === '/api/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { username, password } = JSON.parse(body);
        if (!username || !password) throw new Error('Missing fields');
        if (!verifyUser(username.trim(), password)) {
          res.writeHead(401, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({ error: 'Invalid username or password.' }));
          return;
        }
        const token = issueToken(username.trim());
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ ok: true, token }));
        console.log(`[AUTH] Login: ${username.trim()}`);
      } catch(e) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ error: 'Bad request' }));
      }
    });
    return;
  }

  // ── API: GET /api/auth/verify ──
  if (req.url.startsWith('/api/auth/verify') && req.method === 'GET') {
    const token = new URL('http://x' + req.url).searchParams.get('token');
    const user = validateToken(token);
    if (user) {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ ok: true, username: user }));
    } else {
      res.writeHead(401, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ ok: false }));
    }
    return;
  }

  // ── Serve login.html ──
  if (req.url === '/login' || req.url === '/login.html') {
    const loginPath = path.join(__dirname, 'login.html');
    fs.readFile(loginPath, (err, data) => {
      if (err) { res.writeHead(404); res.end('login.html not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // ── API: GET /api/balance ──
  if (req.url.startsWith('/api/balance') && req.method === 'GET') {
    const token = new URL('http://x' + req.url).searchParams.get('token');
    const user = validateToken(token);
    if (!user) { res.writeHead(401, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const amount = getBalance(user);
    const txs = stmtGetTransactions.all(user);
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ ok: true, balance: amount, transactions: txs }));
    return;
  }

  // ── API: POST /api/deposit (called by minecraft-watcher.py) ──
  // mc_player paid the casino → credit their linked casino account
  if (req.url === '/api/deposit' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.secret !== CONFIG.ADMIN_TOKEN) { res.writeHead(403, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
        const mcPlayer = String(data.player || '').trim();
        const amount = Math.floor(parseFloat(data.amount || 0));
        if (!mcPlayer || amount <= 0) { res.writeHead(400, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ error: 'Invalid' })); return; }

        // Find casino account linked to this Minecraft username
        const userRow = db.prepare('SELECT username FROM users WHERE mc_player = ? COLLATE NOCASE').get(mcPlayer);
        if (!userRow) {
          // No linked account — fall back to old jackpot behaviour
          addPayment(mcPlayer, amount);
          res.writeHead(200, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({ ok: true, mode: 'jackpot', player: mcPlayer, amount }));
          return;
        }

        const newBalance = adjustBalance(userRow.username, amount, 'deposit', `Deposit from MC: ${mcPlayer}`);
        console.log(`[DEPOSIT] ${mcPlayer} → ${userRow.username} +$${amount.toLocaleString()} | Balance: $${newBalance.toLocaleString()}`);

        broadcastToUser(userRow.username, { type: 'balance_update', balance: newBalance, delta: amount, txType: 'deposit' });

        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ ok: true, mode: 'balance', username: userRow.username, amount, newBalance }));
      } catch(e) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ error: 'Bad JSON' }));
      }
    });
    return;
  }

  // ── API: POST /api/withdraw ──
  if (req.url === '/api/withdraw' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const user = validateToken(data.token);
        if (!user) { res.writeHead(401, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
        const amount = Math.floor(parseFloat(data.amount || 0));
        if (amount <= 0) { res.writeHead(400, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ error: 'Invalid amount' })); return; }

        // Get linked MC player
        const userRow = stmtFindUser.get(user);
        if (!userRow || !userRow.mc_player) {
          res.writeHead(400, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({ error: 'No Minecraft username linked. Set it in your profile.' }));
          return;
        }

        const balance = getBalance(user);
        if (amount > balance) { res.writeHead(400, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ error: 'Insufficient balance' })); return; }

        // Deduct immediately, queue payout
        const newBalance = adjustBalance(user, -amount, 'withdraw', `Withdraw to MC: ${userRow.mc_player}`);
        const withdrawId = stmtInsertWithdraw.run(user, userRow.mc_player, amount).lastInsertRowid;

        // Write pay_command.txt for the Python watcher to execute
        const command = `/pay ${userRow.mc_player} ${amount}`;
        try { fs.writeFileSync('pay_command.txt', `${withdrawId}|${command}`, 'utf8'); } catch(e) {}

        console.log(`[WITHDRAW] ${user} → ${userRow.mc_player} $${amount.toLocaleString()} | New balance: $${newBalance.toLocaleString()}`);
        broadcastToUser(user, { type: 'balance_update', balance: newBalance, delta: -amount, txType: 'withdraw' });

        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ ok: true, newBalance, amount, command }));
      } catch(e) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ error: 'Bad request' }));
      }
    });
    return;
  }

  // ── API: POST /api/link-mc ── (link Minecraft username to account)
  if (req.url === '/api/link-mc' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const user = validateToken(data.token);
        if (!user) { res.writeHead(401, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
        const mcPlayer = String(data.mc_player || '').trim();
        if (!mcPlayer) { res.writeHead(400, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ error: 'Invalid username' })); return; }
        db.prepare('UPDATE users SET mc_player = ? WHERE username = ? COLLATE NOCASE').run(mcPlayer, user);
        console.log(`[LINK] ${user} linked to MC player: ${mcPlayer}`);
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ ok: true, mc_player: mcPlayer }));
      } catch(e) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ error: 'Bad request' }));
      }
    });
    return;
  }

  // ── API: GET /api/profile ──
  if (req.url.startsWith('/api/profile') && req.method === 'GET') {
    const token = new URL('http://x' + req.url).searchParams.get('token');
    const user = validateToken(token);
    if (!user) { res.writeHead(401, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const userRow = stmtFindUser.get(user);
    const balance = getBalance(user);
    const txs = stmtGetTransactions.all(user);
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ ok: true, username: userRow.display_name, mc_player: userRow.mc_player || null, balance, transactions: txs }));
    return;
  }




  // ── API: POST /api/jackpot/join ── (balance-based jackpot entry)
  if (req.url === '/api/jackpot/join' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const user = validateToken(data.token);
        if (!user) { res.writeHead(401, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
        const amount = Math.floor(parseFloat(data.amount || 0));
        if (amount <= 0) { res.writeHead(400, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ error: 'Invalid amount' })); return; }
        const balance = getBalance(user);
        if (amount > balance) { res.writeHead(400, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ error: 'Insufficient balance' })); return; }
        const newBalance = adjustBalance(user, -amount, 'jackpot_entry', `Jackpot entry: $${amount.toLocaleString()}`);
        addPayment(user, amount);
        broadcastToUser(user, { type: 'balance_update', balance: newBalance, delta: -amount, txType: 'jackpot_entry' });
        console.log(`[JACKPOT] ${user} joined with $${amount.toLocaleString()} | New balance: $${newBalance.toLocaleString()}`);
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ ok: true, newBalance, amount }));
      } catch(e) { res.writeHead(400, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ error: 'Bad request' })); }
    });
    return;
  }

  // ── API: POST /api/game/bet ── (deduct bet from balance before a game)
  if (req.url === '/api/game/bet' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const user = validateToken(data.token);
        if (!user) { res.writeHead(401, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
        const amount = Math.floor(parseFloat(data.amount || 0));
        if (amount <= 0) { res.writeHead(400, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ error: 'Invalid amount' })); return; }
        const balance = getBalance(user);
        if (amount > balance) { res.writeHead(400, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ error: 'Insufficient balance' })); return; }
        const newBalance = adjustBalance(user, -amount, 'game_bet', `${data.game || 'game'} bet: $${amount.toLocaleString()}`);
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ ok: true, newBalance }));
      } catch(e) { res.writeHead(400, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ error: 'Bad request' })); }
    });
    return;
  }

  // ── API: POST /api/game/payout ── (credit winnings after a game)
  if (req.url === '/api/game/payout' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const user = validateToken(data.token);
        if (!user) { res.writeHead(401, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
        const amount = Math.floor(parseFloat(data.amount || 0));
        if (amount <= 0) { res.writeHead(400, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ error: 'Invalid amount' })); return; }
        const newBalance = adjustBalance(user, amount, 'game_win', data.note || `${data.game || 'game'} win`);
        broadcastToUser(user, { type: 'balance_update', balance: newBalance, delta: amount, txType: 'game_win' });
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ ok: true, newBalance }));
      } catch(e) { res.writeHead(400, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ error: 'Bad request' })); }
    });
    return;
  }

  // ── API: POST /api/game/loss ── (record a loss for transaction history)
  if (req.url === '/api/game/loss' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const user = validateToken(data.token);
        if (!user) { res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ ok: true })); return; }
        stmtAddTransaction.run(user, 'game_loss', -Math.abs(Math.floor(parseFloat(data.amount||0))), data.note || `${data.game || 'game'} loss`);
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ ok: true }));
      } catch(e) { res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ ok: true })); }
    });
    return;
  }

  if (req.url === '/api/payment' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.secret !== CONFIG.ADMIN_TOKEN) {
          res.writeHead(403, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        const player = String(data.player || '').trim();
        const amount = Math.floor(parseFloat(data.amount || 0));
        if (!player || amount <= 0) {
          res.writeHead(400, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({ error: 'Invalid player or amount' }));
          return;
        }
        addPayment(player, amount);
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ ok: true, player, amount }));
      } catch(e) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ error: 'Bad JSON' }));
      }
    });
    return;
  }

  // ── API: GET /api/status ──
  if (req.url === '/api/status' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(getPublicState()));
    return;
  }

  // ── Fichiers statiques ──
  let filePath = path.join(CONFIG.PUBLIC_DIR, req.url === '/' ? 'index.html' : req.url);
  if (!filePath.startsWith(CONFIG.PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html', '.css': 'text/css',
    '.js': 'application/javascript', '.json': 'application/json',
    '.png': 'image/png', '.ico': 'image/x-icon',
  };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    res.end(data);
  });
});

// ─── WEBSOCKET SERVER ─────────────────────────
const wss = new WebSocket.Server({ port: CONFIG.WS_PORT });

function broadcastToUser(username, msg) {
  const raw = JSON.stringify(msg);
  const lc = username.toLowerCase();
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.casinoUser === lc) {
      client.send(raw);
    }
  });
}

function broadcastAll(msg) {
  const raw = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(raw);
  });
}

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');

  // Envoyer l'état complet au nouveau client
  ws.send(JSON.stringify({
    type: 'state',
    data: getPublicState()
  }));

  ws.on('message', (rawMsg) => {
    try {
      const msg = JSON.parse(rawMsg);
      // Tag connection with user identity
      if (msg.type === 'auth' && msg.token) {
        const user = validateToken(msg.token);
        if (user) ws.casinoUser = user;
      }
      handleClientMessage(ws, msg);
    } catch(e) {
      console.error('[WS] Bad message from client:', e.message);
    }
  });

  ws.on('close', () => console.log('[WS] Client disconnected'));
  ws.on('error', (e) => console.error('[WS] Client error:', e.message));
});

// ─── CLIENT MESSAGE HANDLER ───────────────────
function handleClientMessage(ws, msg) {
  switch(msg.type) {

    case 'admin_add':
      // Ajouter un joueur manuellement (admin)
      addPayment(msg.player, parseInt(msg.amount));
      break;

    case 'admin_reset':
      resetGame();
      break;

    case 'admin_force_end':
      if (gameState.phase === 'active' || gameState.phase === 'waiting') {
        if (Object.keys(gameState.players).length > 0) {
          gameState.phase = 'ending';
          endRound();
        }
      }
      break;

    case 'confirm_paid':
      // Gardé pour compatibilité mais le reset est maintenant géré côté serveur
      break;

    case 'clear_winners':
      gameState.winners = [];
      broadcastAll({ type: 'clear_winners' });
      broadcastAll({ type: 'state', data: getPublicState() });
      break;

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;
  }
}

// ─── GAME LOGIC ───────────────────────────────

/**
 * Ajouter un paiement (nouveau joueur ou remise)
 */
function addPayment(playerName, amount) {
  if (!playerName || !amount || amount <= 0) return;

  // Si un round est en cours de tirage ou gagnant → mettre en file d'attente
  if (gameState.phase === 'drawing' || gameState.phase === 'winner' || gameState.phase === 'ending') {
    const isNew = !gameState.nextRound[playerName];
    gameState.nextRound[playerName] = (gameState.nextRound[playerName] || 0) + amount;
    gameState.nextRoundTotal += amount;
    console.log(`[NEXT ROUND] ${playerName} → $${amount.toLocaleString()} (file d'attente prochain round)`);
    broadcastAll({
      type: 'next_round_payment',
      player: playerName,
      amount: amount,
      isNew: isNew,
      nextRoundTotal: gameState.nextRoundTotal,
    });
    return;
  }

  const isNew = !gameState.players[playerName];
  gameState.players[playerName] = (gameState.players[playerName] || 0) + amount;
  gameState.totalStakes += amount;

  console.log(`[PAYMENT] ${playerName} → $${amount.toLocaleString()} | Total: $${gameState.totalStakes.toLocaleString()}`);

  broadcastAll({
    type: 'payment',
    player: playerName,
    amount: amount,
    isNew: isNew,
  });

  broadcastAll({ type: 'state', data: getPublicState() });

  // Démarrer le timer seulement si 2+ joueurs différents
  if (!gameState.timerActive && gameState.phase === 'waiting') {
    if (Object.keys(gameState.players).length >= 2) {
      startTimer();
    }
  }
}

/**
 * Démarrer le timer de 60 secondes
 */
function startTimer() {
  gameState.timerActive = true;
  gameState.timerSeconds = CONFIG.ROUND_DURATION;
  gameState.phase = 'active';

  console.log('[TIMER] Round started — 60 seconds');
  broadcastAll({ type: 'timer_start' });

  gameState.timerInterval = setInterval(() => {
    gameState.timerSeconds--;

    broadcastAll({
      type: 'timer_tick',
      seconds: gameState.timerSeconds
    });

    if (gameState.timerSeconds <= 0) {
      clearInterval(gameState.timerInterval);
      gameState.timerInterval = null;
      gameState.phase = 'ending'; // Bloquer les nouveaux paiements immédiatement
      endRound();
    }
  }, 1000);
}

/**
 * Terminer le round et sélectionner le gagnant
 */
function endRound() {
  if (gameState.phase === 'drawing' || gameState.phase === 'winner') return;

  clearInterval(gameState.timerInterval);
  gameState.timerInterval = null;
  gameState.timerActive = false;
  gameState.phase = 'drawing';

  const players = { ...gameState.players };
  const total = gameState.totalStakes;

  if (Object.keys(players).length === 0) {
    console.log('[GAME] No players, skipping draw');
    resetGame();
    return;
  }

  // Sélection du gagnant pondérée par mise
  const winner = weightedRandom(players, total);
  const payout = Math.floor(total * (1 - CONFIG.HOUSE_EDGE));
  const command = `/pay ${winner} ${payout}`;

  console.log(`[DRAW] Winner: ${winner} | Payout: $${payout.toLocaleString()} | Command: ${command}`);

  gameState.phase = 'winner';
  gameState.lastWinner = { name: winner, amount: payout };

  // Ajouter aux winners
  gameState.winners.unshift({
    name: winner,
    amount: payout,
    time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
  });
  if (gameState.winners.length > 20) gameState.winners.pop();

  // Envoyer l'événement de draw (pour l'animation reel)
  broadcastAll({
    type: 'draw_start',
    winner,
    players,
    total,
    payout
  });

  // Après animation (7 secondes), envoyer l'événement winner
  setTimeout(() => {
    broadcastAll({
      type: 'winner',
      player: winner,
      amount: payout,
      command
    });
    broadcastAll({ type: 'state', data: getPublicState() });
    console.log(`[GAME] >>> EXECUTE IN MINECRAFT: ${command}`);

    // Écrire la commande pour le script Python
    try {
      require('fs').writeFileSync('pay_command.txt', command, 'utf8');
    } catch(e) {}

    // Compte à rebours de 5s côté SERVEUR, puis reset
    let countdown = 5;
    broadcastAll({ type: 'auto_countdown', seconds: countdown });
    const cdInterval = setInterval(() => {
      countdown--;
      broadcastAll({ type: 'auto_countdown', seconds: countdown });
      if (countdown <= 0) {
        clearInterval(cdInterval);
        resetGame();
      }
    }, 1000);

  }, 7000);
}

/**
 * Sélection aléatoire pondérée
 */
function weightedRandom(players, total) {
  let rand = Math.random() * total;
  for (const [name, amount] of Object.entries(players)) {
    rand -= amount;
    if (rand <= 0) return name;
  }
  // Fallback (ne devrait jamais arriver)
  return Object.keys(players)[0];
}

/**
 * Réinitialiser le jeu
 */
function resetGame() {
  clearInterval(gameState.timerInterval);

  // Récupérer les mises en attente pour le prochain round
  const pendingPlayers = { ...gameState.nextRound };
  const pendingTotal = gameState.nextRoundTotal;

  gameState.players = {};
  gameState.totalStakes = 0;
  gameState.timerActive = false;
  gameState.timerSeconds = CONFIG.ROUND_DURATION;
  gameState.phase = 'waiting';
  gameState.timerInterval = null;
  gameState.nextRound = {};
  gameState.nextRoundTotal = 0;

  console.log('[GAME] Reset');
  broadcastAll({ type: 'reset' });

  // Injecter les mises en attente dans le nouveau round (délai pour laisser le frontend reset)
  setTimeout(() => {
    if (Object.keys(pendingPlayers).length > 0) {
      console.log(`[GAME] Injection de ${Object.keys(pendingPlayers).length} joueur(s) en attente`);
      for (const [name, amount] of Object.entries(pendingPlayers)) {
        gameState.players[name] = amount;
        gameState.totalStakes += amount;
      }
      broadcastAll({ type: 'state', data: getPublicState() });
      // Démarrer le timer seulement si 2+ joueurs différents
      if (Object.keys(gameState.players).length >= 2) {
        startTimer();
      }
    } else {
      broadcastAll({ type: 'state', data: getPublicState() });
    }
  }, 800);
}

/**
 * Retourner l'état public (envoyé aux clients)
 */
function getPublicState() {
  return {
    players: gameState.players,
    totalStakes: gameState.totalStakes,
    timerActive: gameState.timerActive,
    timerSeconds: gameState.timerSeconds,
    phase: gameState.phase,
    winners: gameState.winners,
  };
}

// ─── MINECRAFT LOG WATCHER ────────────────────
/**
 * OPTION A: Lire le fichier latest.log en temps réel
 * Détecte les messages: "PlayerName paid you $XXXXX."
 */
function watchMinecraftLog() {
  const logPath = CONFIG.MINECRAFT_LOG_PATH;

  if (!logPath || logPath === '/path/to/your/minecraft/server/logs/latest.log') {
    console.log('[LOG] No Minecraft log path configured. Use Admin Panel or HTTP API to add players.');
    return;
  }

  if (!fs.existsSync(logPath)) {
    console.warn(`[LOG] Log file not found: ${logPath}`);
    return;
  }

  console.log(`[LOG] Watching Minecraft log: ${logPath}`);

  // Lire depuis la fin du fichier (tail -f)
  let fileSize = fs.statSync(logPath).size;

  fs.watch(logPath, (eventType) => {
    if (eventType !== 'change') return;

    const newSize = fs.statSync(logPath).size;
    if (newSize <= fileSize) { fileSize = newSize; return; }

    // Lire uniquement les nouveaux octets
    const stream = fs.createReadStream(logPath, { start: fileSize, end: newSize });
    fileSize = newSize;

    const rl = readline.createInterface({ input: stream });
    rl.on('line', (line) => {
      parseMinecraftLine(line);
    });
  });
}

/**
 * Parser une ligne du log Minecraft
 */
function parseMinecraftLine(line) {
  // Format attendu dans le log: [HH:MM:SS] [Server thread/INFO]: PlayerName paid you $103489.
  // On extrait la partie après ]: 
  const match = line.match(/\]: (.+)$/);
  if (!match) return;

  const content = match[1];
  const payMatch = content.match(CONFIG.PAYMENT_REGEX);
  if (!payMatch) return;

  const playerName = payMatch[1];
  const amount = Math.floor(parseFloat(payMatch[2]));

  console.log(`[MINECRAFT] Detected payment: ${playerName} → $${amount}`);
  addPayment(playerName, amount);
}

// (API intégrée dans le httpServer principal ci-dessus)

// ─── DÉMARRAGE ────────────────────────────────
httpServer.listen(CONFIG.HTTP_PORT, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════╗');
  console.log('║        🎰  BLAZE CASINO  🎰           ║');
  console.log('╠═══════════════════════════════════════╣');
  console.log(`║  Frontend  → http://localhost:${CONFIG.HTTP_PORT}      ║`);
  console.log(`║  WebSocket → ws://localhost:${CONFIG.WS_PORT}         ║`);
  console.log(`║  API       → http://localhost:${CONFIG.HTTP_PORT}/api  ║`);
  console.log('╚═══════════════════════════════════════╝');
  console.log('');
  console.log('  Press A in browser to open Admin Panel');
  console.log('');

  // Log watcher disabled — minecraft-watcher.py handles log reading and posts to /api/payment
  // Enabling both would cause every payment to be counted twice
  // watchMinecraftLog();
});