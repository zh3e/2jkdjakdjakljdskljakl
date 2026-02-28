/* =============================================
   BLAZE CASINO — FRONTEND JS
   Connects to backend via WebSocket
   ============================================= */

// ─── CONFIG ───────────────────────────────────
const WS_URL = `ws://${location.hostname}:3001`;

// Player color palette (assigned sequentially)
const PLAYER_COLORS = [
  '#f5b942', '#e052a0', '#52b4e0', '#52e07a',
  '#e09652', '#a052e0', '#52e0c4', '#e05252',
  '#e0d452', '#5274e0'
];

// ─── STATE ────────────────────────────────────
let state = {
  players: {},        // { name: { amount, color } }
  totalStakes: 0,
  timerActive: false,
  timerSeconds: 60,
  phase: 'waiting',   // waiting | active | drawing | winner
  winners: [],
  colorIndex: 0,
};

let ws = null;
let wsReconnectTimer = null;

// ─── WEBSOCKET CONNECTION ─────────────────────
function connectWS() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('[WS] Connected to Blaze Casino backend');
    showToast('Connected to server', 'gold');
    clearTimeout(wsReconnectTimer);
    // Send auth so server can tag this connection for targeted balance updates
    const token = sessionStorage.getItem('casino_token');
    if (token) sendWS({ type: 'auth', token });
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch(e) {
      console.error('[WS] Bad message:', e);
    }
  };

  ws.onclose = () => {
    console.warn('[WS] Disconnected. Reconnecting in 3s...');
    showToast('Server disconnected — reconnecting...', '');
    wsReconnectTimer = setTimeout(connectWS, 3000);
  };

  ws.onerror = (err) => {
    console.error('[WS] Error:', err);
  };
}

function sendWS(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ─── SERVER MESSAGE HANDLER ───────────────────
function handleServerMessage(msg) {
  switch(msg.type) {

    case 'state':
      // Full state sync from server
      syncFullState(msg.data);
      break;

    case 'payment':
      // Toast notification uniquement — le state complet arrive juste après via 'state'
      if (msg.isNew) {
        showToast(msg.player + ' joined!', 'gold');
      } else {
        showToast(msg.player + ' added $' + formatMoney(msg.amount), 'green');
      }
      // Flash écran
      document.body.classList.remove('flash');
      void document.body.offsetWidth;
      document.body.classList.add('flash');
      break;

    case 'timer_start':
      state.timerActive = true;
      state.timerSeconds = 60;
      state.phase = 'active';
      updateTimer(60);
      updateStatus('ROUND ACTIVE', true);
      document.querySelector('.ring-glow').classList.add('active');
      break;

    case 'timer_tick':
      state.timerSeconds = msg.seconds;
      state.timerActive = true;
      state.phase = 'active';
      // Mettre à jour directement le DOM sans passer par renderAll
      const el = document.getElementById('timerDisplay');
      const ring = document.getElementById('timerRing');
      const glow = document.querySelector('.ring-glow');
      if (el) el.textContent = msg.seconds;
      if (ring) {
        const circ = 2 * Math.PI * 148;
        ring.style.strokeDashoffset = circ * (1 - msg.seconds / 60);
        ring.classList.toggle('urgent', msg.seconds <= 10);
      }
      if (glow) glow.classList.add('active');
      if (msg.seconds <= 10) {
        const elNum = document.getElementById('timerDisplay');
        if (elNum) elNum.classList.add('urgent');
      } else {
        const elNum = document.getElementById('timerDisplay');
        if (elNum) elNum.classList.remove('urgent');
      }
      break;

    case 'draw_start':
      state.phase = 'drawing';
      startReelAnimation(msg.winner, msg.players);
      break;

    case 'winner':
      showWinner(msg.player, msg.amount, msg.command);
      break;

    case 'reset':
      resetUI();
      break;

    case 'clear_winners':
      state.winners = [];
      document.getElementById('winnersList').innerHTML = '<div class="empty-state">No winners yet.</div>';
      break;

    case 'auto_countdown':
      // Compte a rebours serveur apres le winner
      const numEl = document.getElementById('autoCountdownNum');
      const fillEl = document.getElementById('autoCountdownFill');
      if (numEl) numEl.textContent = msg.seconds;
      if (fillEl) fillEl.style.width = (msg.seconds / 5 * 100) + '%';
      break;

    case 'next_round_payment':
      if (msg.isNew) {
        showToast(msg.player + ' joined NEXT ROUND — $' + formatMoney(msg.amount), 'gold');
      } else {
        showToast(msg.player + ' added $' + formatMoney(msg.amount) + ' — NEXT ROUND', 'gold');
      }
      document.body.classList.remove('flash');
      void document.body.offsetWidth;
      document.body.classList.add('flash');
      break;

    case 'error':
      showToast('Error: ' + msg.message, '');
      break;

    case 'balance_update':
      if (window._onBalanceUpdate) window._onBalanceUpdate(msg);
      break;
  }
}

function syncFullState(data) {
  // Le serveur stocke players[name] = amount (number simple)
  const newPlayers = {};
  if (data.players) {
    for (const [name, value] of Object.entries(data.players)) {
      const amount = typeof value === 'number' ? value : (value.amount || 0);
      newPlayers[name] = {
        amount: amount,
        color: getNextColor(name)
      };
    }
  }
  state.players = newPlayers;
  state.totalStakes = data.totalStakes || 0;
  state.timerSeconds = data.timerSeconds || 60;
  state.timerActive = data.timerActive || false;
  state.winners = data.winners || [];
  state.phase = data.phase || 'waiting';
  renderAll();
}

// ─── PAYMENT HANDLER ──────────────────────────
function handlePayment(playerName, amount) {
  // Assign color if new player
  if (!state.players[playerName]) {
    state.players[playerName] = { amount: 0, color: getNextColor(playerName) };
    showToast(`${playerName} joined!`, 'gold');
  } else {
    showToast(`${playerName} added $${formatMoney(amount)}`, 'green');
  }

  state.players[playerName].amount += amount;
  state.totalStakes += amount;

  // Flash
  document.body.classList.remove('flash');
  void document.body.offsetWidth;
  document.body.classList.add('flash');

  renderAll();
}

// ─── RENDER ALL ───────────────────────────────
function renderAll() {
  renderTimer();
  renderStakes();
  renderEntries();
  renderWinners();
  renderPlayerCount();
  updateStatus(
    state.timerActive ? 'ROUND ACTIVE' :
    state.phase === 'drawing' ? 'DRAWING...' : 'OPEN — PLACE YOUR BET',
    state.timerActive
  );
}

// ─── TIMER ────────────────────────────────────
const TIMER_CIRCUMFERENCE = 2 * Math.PI * 148; // r=148

function renderTimer() {
  updateTimer(state.timerSeconds);
}

function updateTimer(seconds) {
  state.timerSeconds = seconds;
  const el = document.getElementById('timerDisplay');
  const ring = document.getElementById('timerRing');
  const glow = document.querySelector('.ring-glow');

  el.textContent = seconds;

  // Progress ring: full = 0 offset, empty = full circumference
  const progress = seconds / 60;
  ring.style.strokeDashoffset = TIMER_CIRCUMFERENCE * (1 - progress);

  const urgent = seconds <= 10 && state.timerActive;
  el.classList.toggle('urgent', urgent);
  ring.classList.toggle('urgent', urgent);
  glow.classList.toggle('active', state.timerActive);
}

// ─── STAKES ───────────────────────────────────
function renderStakes() {
  document.getElementById('totalStakes').textContent = '$' + formatMoney(state.totalStakes);
  document.getElementById('payoutAmount').textContent = '$' + formatMoney(Math.floor(state.totalStakes * 0.95));
}

// ─── ENTRIES ──────────────────────────────────
function renderEntries() {
  const list = document.getElementById('entriesList');
  const entries = Object.entries(state.players);

  if (entries.length === 0) {
    list.innerHTML = '<div class="empty-state">No players yet.<br>Waiting for entries...</div>';
    return;
  }

  // Sort by amount desc
  entries.sort((a, b) => b[1].amount - a[1].amount);

  // Si 1 seul joueur et timer pas encore lancé → afficher carte d'attente
  const waitingCard = (entries.length === 1 && !state.timerActive && state.phase === 'waiting') ? `
    <div class="entry-card waiting-card">
      <div class="entry-name waiting-name">⏳ WAITING FOR MORE PLAYERS...</div>
      <div class="entry-amount" style="color:var(--text-muted)">Need 1 more</div>
      <div class="entry-chance" style="color:var(--text-muted)">—</div>
      <div class="entry-bar"><div class="entry-bar-fill" style="width:0%"></div></div>
    </div>` : '';

  list.innerHTML = entries.map(([name, info]) => {
    const chance = state.totalStakes > 0
      ? ((info.amount / state.totalStakes) * 100).toFixed(1)
      : '0.0';

    return `
      <div class="entry-card" style="--player-color: ${info.color}">
        <div class="entry-name">${escapeHtml(name)}</div>
        <div class="entry-amount">$${formatMoney(info.amount)}</div>
        <div class="entry-chance">${chance}%</div>
        <div class="entry-bar">
          <div class="entry-bar-fill" style="width:${chance}%; background:${info.color}; box-shadow:0 0 6px ${info.color}"></div>
        </div>
      </div>
    `;
  }).join('') + waitingCard;
}

// ─── WINNERS ──────────────────────────────────
function renderWinners() {
  const list = document.getElementById('winnersList');

  if (state.winners.length === 0) {
    list.innerHTML = '<div class="empty-state">No winners yet.</div>';
    return;
  }

  list.innerHTML = state.winners.slice(0, 10).map(w => `
    <div class="winner-card">
      <div>
        <div class="winner-card-name">♛ ${escapeHtml(w.name)}</div>
        <div class="winner-card-time">${w.time}</div>
      </div>
      <div class="winner-card-amount">+$${formatMoney(w.amount)}</div>
    </div>
  `).join('');
}

// ─── PLAYER COUNT ─────────────────────────────
function renderPlayerCount() {
  document.getElementById('playerCount').textContent = Object.keys(state.players).length;
}

// ─── STATUS BAR ───────────────────────────────
function updateStatus(text, active) {
  document.getElementById('statusText').textContent = text;
  const dot = document.getElementById('statusDot');
  dot.className = 'status-dot' + (active ? ' active' : state.phase === 'drawing' ? ' drawing' : '');
}

// ─── REEL ANIMATION ───────────────────────────
function startReelAnimation(winner, players) {
  const overlay = document.getElementById('reelOverlay');
  const track = document.getElementById('reelTrack');
  const winnerBanner = document.getElementById('winnerBanner');

  overlay.classList.add('visible');
  winnerBanner.classList.remove('visible');

  // Build weighted item list for reel
  const items = buildReelItems(players, winner);

  // Render items × 4 for long strip
  const fullItems = [...items, ...items, ...items, ...items];
  track.innerHTML = fullItems.map((item, i) => `
    <div class="reel-item" id="reel-${i}"
         style="background:${item.color}18; min-width:${item.width}px">
      <div class="reel-item-name" style="color:${item.color}">${escapeHtml(item.name)}</div>
      <div class="reel-item-chance">${item.chance}%</div>
    </div>
  `).join('');

  // Find target index — winner in the 3rd repetition
  let targetIndex = -1;
  const baseOffset = 2 * items.length;
  for (let i = baseOffset; i < baseOffset + items.length; i++) {
    if (fullItems[i].name === winner) { targetIndex = i; break; }
  }
  if (targetIndex === -1) targetIndex = baseOffset;

  // ✅ FIX: Lire les vraies largeurs APRÈS que le browser a calculé le layout
  // On force un reflow en lisant offsetWidth sur le track, puis on lit chaque item
  void track.offsetWidth; // force reflow

  const itemEls = Array.from(track.querySelectorAll('.reel-item'));

  // Largeur du wrapper reel (900px d'après le CSS, mais on le lit pour être sûr)
  const wrapperWidth = track.parentElement?.offsetWidth || 900;
  const centerX = wrapperWidth / 2;

  // Lire les vraies largeurs maintenant que le DOM est rendu
  const itemWidths = itemEls.map(el => el.getBoundingClientRect().width || el.offsetWidth || 120);

  // Calculer la position X du centre de la case gagnante
  let offsetToTarget = 0;
  for (let i = 0; i < targetIndex; i++) offsetToTarget += itemWidths[i];
  const winnerCenter = offsetToTarget + itemWidths[targetIndex] / 2;

  // translateX négatif pour que le centre du gagnant soit aligné au centre du wrapper
  const finalOffset = -(winnerCenter - centerX);

  // Reset position sans transition
  track.style.transition = 'none';
  track.style.transform = 'translateX(0)';

  // Lancer l'animation après un frame pour que le reset soit appliqué
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      track.style.transition = 'transform 5s cubic-bezier(0.15, 0.85, 0.35, 1.0)';
      track.style.transform = `translateX(${finalOffset}px)`;
    });
  });

  // Après l'animation, surligner le gagnant
  setTimeout(() => {
    const winnerEl = itemEls[targetIndex];
    if (winnerEl) {
      const col = state.players[winner]?.color || '#f5b942';
      winnerEl.style.background = col + '44';
      winnerEl.style.border = `2px solid ${col}`;
      winnerEl.style.boxShadow = `0 0 20px ${col}66`;
    }
    setTimeout(() => showWinnerBanner(winner), 800);
  }, 5300);
}

function buildReelItems(players, winner) {
  // Build items proportional to chance, min 1 item per player
  const items = [];
  const total = Object.values(players).reduce((s, a) => s + a, 0);

  for (const [name, amount] of Object.entries(players)) {
    const chance = total > 0 ? ((amount / total) * 100).toFixed(1) : 0;
    const slots = Math.max(1, Math.round(amount / total * 20)); // 1-20 slots
    const color = state.players[name]?.color || '#f5b942';
    const width = Math.max(80, Math.round(amount / total * 300));

    for (let i = 0; i < slots; i++) {
      items.push({ name, chance, color, width });
    }
  }

  // Shuffle
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }

  return items;
}

function showWinnerBanner(name) {
  const payout = Math.floor(state.totalStakes * 0.95);
  document.getElementById('winnerName').textContent = name;
  document.getElementById('winnerAmount').textContent = '+$' + formatMoney(payout);
  document.getElementById('winnerBanner').classList.add('visible');
  document.getElementById('reelTitle') && (document.querySelector('.reel-title').style.display = 'none');

  // Add to recent winners
  state.winners.unshift({
    name,
    amount: payout,
    time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
  });
}

function showWinner(name, amount, command) {
  document.getElementById('winnerName').textContent = name;
  document.getElementById('winnerAmount').textContent = '+$' + formatMoney(amount);
  // Le countdown est géré par le serveur via auto_countdown
  const numEl = document.getElementById('autoCountdownNum');
  const fillEl = document.getElementById('autoCountdownFill');
  numEl.textContent = '5';
  fillEl.style.width = '100%';
}

// ─── RESET UI ─────────────────────────────────
function resetUI() {
  state.players = {};
  state.totalStakes = 0;
  state.timerSeconds = 60;
  state.timerActive = false;
  state.colorIndex = 0;
  state.phase = 'waiting';

  // Fermer l'overlay avec un délai pour laisser le temps au state d'arriver
  setTimeout(() => {
    document.getElementById('reelOverlay').classList.remove('visible');
    document.getElementById('winnerBanner').classList.remove('visible');
    document.getElementById('reelTrack').innerHTML = '';
  }, 200);

  renderAll();
}

// ─── ADMIN PANEL ──────────────────────────────
let adminVisible = false;

document.addEventListener('keydown', (e) => {
  if (e.key === 'a' || e.key === 'A') {
    // Ouvrir seulement si aucun input n'est focus
    const active = document.activeElement;
    const isTyping = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
    if (!isTyping) {
      adminVisible = !adminVisible;
      document.getElementById('adminPanel').classList.toggle('visible', adminVisible);
    }
  }
  if (e.key === 'Escape') {
    adminVisible = false;
    document.getElementById('adminPanel').classList.remove('visible');
  }
});

// Fermer si clic en dehors du panel
document.addEventListener('click', (e) => {
  const panel = document.getElementById('adminPanel');
  if (adminVisible && !panel.contains(e.target)) {
    adminVisible = false;
    panel.classList.remove('visible');
  }
});

function clearWinners() {
  console.log('[CLEAR] Clearing winners...');
  state.winners = [];
  document.getElementById('winnersList').innerHTML = '<div class="empty-state">No winners yet.</div>';
  sendWS({ type: 'clear_winners' });
}

function closeAdmin() {
  adminVisible = false;
  document.getElementById('adminPanel').classList.remove('visible');
}

function adminAddPlayer() {
  const name = document.getElementById('adminPlayer').value.trim();
  const amount = parseInt(document.getElementById('adminAmount').value);
  if (!name || !amount || amount <= 0) { showToast('Invalid input', ''); return; }
  sendWS({ type: 'admin_add', player: name, amount });
  document.getElementById('adminPlayer').value = '';
  document.getElementById('adminAmount').value = '';
}

function adminReset() {
  sendWS({ type: 'admin_reset' });
  adminVisible = false;
  document.getElementById('adminPanel').classList.remove('visible');
}

function adminForceEnd() {
  sendWS({ type: 'admin_force_end' });
}

// ─── PARTICLES BACKGROUND ─────────────────────
(function initParticles() {
  const canvas = document.getElementById('particles');
  const ctx = canvas.getContext('2d');
  let W, H, particles;

  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  function createParticle() {
    return {
      x: Math.random() * W,
      y: Math.random() * H,
      r: Math.random() * 1.5 + 0.3,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      alpha: Math.random() * 0.4 + 0.1,
      gold: Math.random() > 0.85
    };
  }

  function init() {
    resize();
    particles = Array.from({ length: 120 }, createParticle);
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    for (const p of particles) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.gold
        ? `rgba(245,185,66,${p.alpha})`
        : `rgba(255,255,255,${p.alpha * 0.4})`;
      ctx.fill();

      p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x = W;
      if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H;
      if (p.y > H) p.y = 0;
    }
    requestAnimationFrame(draw);
  }

  window.addEventListener('resize', resize);
  init();
  draw();
})();

// ─── TOAST ────────────────────────────────────
function showToast(message, type) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast' + (type ? ' ' + type : '');
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ─── UTILS ────────────────────────────────────
function formatMoney(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return n.toLocaleString('en-US');
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function getNextColor(name) {
  // Deterministic by name
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return PLAYER_COLORS[Math.abs(hash) % PLAYER_COLORS.length];
}

// ─── INIT ─────────────────────────────────────
connectWS();

// Timer animation loop (client-side fallback)
setInterval(() => {
  if (state.timerActive && state.timerSeconds > 0) {
    // Timer is driven by server ticks, this is just UI update
  }
}, 100);