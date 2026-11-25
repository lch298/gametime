import { GAMES, SCORING, CUSTOM_COLORS, makeCustomGame, normalizeUrl, hostOf } from './games.js';
import { SITE_NAME, SHEETS_URL, CARD_IMAGES } from './config.js';

const isConfigured = /^https:\/\/script\.google\.com\/.+\/exec$/.test(String(SHEETS_URL).trim());
const POLL_MS = 30000;

// ── helpers ──────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function weekStart(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Monday
  return ymd(x);
}
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (name) =>
  String(name || '?').replace(/^@/, '')
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
const prettyDate = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
};
// "Maya R." → "maya-r". Same name on any device = same leaderboard row.
const toPlayerKey = (name) =>
  String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
class WrongPassword extends Error {}
const PREVIEW_KEY = 'gamtime-previews-v1';
function loadPreviewCache() {
  try {
    return JSON.parse(localStorage.getItem(PREVIEW_KEY)) || {};
  } catch {
    return {};
  }
}

// ── data stores ──────────────────────────────────────────────
// Every store has the same shape, so the rest of the app doesn't care where data lives.

// Google Sheet + Apps Script. Saves go straight to the sheet; the page re-checks every
// 30 seconds and whenever you come back to this tab (e.g. after playing a game).
function sheetsStore(url) {
  const SKEY = 'gamtime-session';
  const ls = {
    get() {
      try {
        return JSON.parse(localStorage.getItem(SKEY));
      } catch {
        return null;
      }
    },
    set(v) {
      try {
        v == null ? localStorage.removeItem(SKEY) : localStorage.setItem(SKEY, JSON.stringify(v));
      } catch {}
    },
  };
  let session = ls.get();
  let sessionCb = null;
  // Last data this device saw, so the page draws the right cards in the right order instantly.
  const CACHE = 'gamtime-cache-v1';
  const loadCache = () => {
    try {
      return JSON.parse(localStorage.getItem(CACHE));
    } catch {
      return null;
    }
  };
  const saveCache = () => {
    try {
      localStorage.setItem(CACHE, JSON.stringify(data));
    } catch {}
  };
  let data = (session && loadCache()) || { scores: [], games: [] };
  let fresh = false; // true once Google has answered at least once
  let scoreL = [];
  let gameL = [];
  let errL = [];
  let timer = null;
  let inflight = null;

  async function call(action, payload = {}) {
    // text/plain keeps this a "simple" request, which Apps Script accepts from any site
    const res = await fetch(url, { method: 'POST', body: JSON.stringify({ action, token: session?.token, ...payload }) });
    const j = await res.json();
    if (!j.ok) {
      if (/wrong password/i.test(j.error)) throw new WrongPassword();
      const e = new Error(j.error || 'Request failed');
      if (/unauthorized/i.test(j.error)) e.code = 'permission-denied';
      throw e;
    }
    return j;
  }
  function emit() {
    scoreL.forEach((l) => l([...data.scores]));
    gameL.forEach((l) => l([...data.games]));
  }
  function refresh() {
    if (!session) return Promise.resolve();
    if (inflight) return inflight;
    inflight = call('data')
      .then((j) => {
        data = { scores: j.scores || [], games: (j.games || []).map((g) => ({ ...g, createdAt: Number(g.createdAt) || 0 })) };
        fresh = true;
        saveCache();
        emit();
      })
      .catch((e) => errL.forEach((f) => f(e)))
      .finally(() => (inflight = null));
    return inflight;
  }
  function startPolling() {
    if (timer) return;
    refresh();
    timer = setInterval(() => document.visibilityState === 'visible' && refresh(), POLL_MS);
  }
  function stopPollingIfIdle() {
    if (!scoreL.length && !gameL.length && timer) {
      clearInterval(timer);
      timer = null;
    }
  }
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && timer && refresh());
  const subscribe = (list, cb, onErr) => {
    list.push(cb);
    if (onErr) errL.push(onErr);
    // draw from the saved copy right away; Google's answer replaces it a moment later
    if (!fresh && loadCache()) setTimeout(() => cb(list === scoreL ? [...data.scores] : [...data.games]), 0);
    startPolling();
    return () => {
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
      errL = errL.filter((f) => f !== onErr);
      stopPollingIfIdle();
    };
  };

  return {
    mode: 'live',
    onSession(cb) {
      sessionCb = cb;
      setTimeout(() => cb(session ? session.user : null), 0);
    },
    async enter(password, name) {
      const j = await call('login', { password, name });
      session = { token: j.token, user: { uid: j.user.playerKey, ...j.user } };
      ls.set(session);
      sessionCb?.(session.user);
    },
    async leave() {
      session = null;
      ls.set(null);
      data = { scores: [], games: [] };
      fresh = false;
      try {
        localStorage.removeItem(CACHE);
      } catch {}
      sessionCb?.(null);
    },
    subscribeScores: (cb, onErr) => subscribe(scoreL, cb, onErr),
    subscribeGames: (cb, onErr) => subscribe(gameL, cb, onErr),
    async saveScore(e) {
      await call('saveScore', { entry: e });
      const id = `${e.gameId}_${e.date}_${e.playerKey}`;
      data.scores = [...data.scores.filter((s) => s.id !== id), { id, ...e }]; // show it right away
      emit();
      refresh();
    },
    async deleteScore(id) {
      await call('deleteScore', { id });
      data.scores = data.scores.filter((s) => s.id !== id);
      emit();
      refresh();
    },
    async addGame(g) {
      await call('addGame', { game: g });
      await refresh();
    },
    async removeGame(id) {
      await call('removeGame', { id });
      data.games = data.games.filter((g) => g.id !== id);
      emit();
      refresh();
    },
    async hideGame(gameId) {
      await call('hideGame', { gameId });
      data.games = [...data.games.filter((g) => g.id !== `hide:${gameId}`), { id: `hide:${gameId}`, name: gameId, scoring: 'hidden', createdAt: Date.now() }];
      emit();
      refresh();
    },
    async previews(urls) {
      return (await call('previews', { urls })).previews || {};
    },
    async setOrder(order) {
      await call('setOrder', { order });
      data.games = [...data.games.filter((g) => g.id !== 'order'), { id: 'order', name: order.join(','), scoring: 'order', createdAt: 0 }];
      emit();
      refresh();
    },
    async unhideGame(gameId) {
      await call('unhideGame', { gameId });
      data.games = data.games.filter((g) => g.id !== `hide:${gameId}`);
      emit();
      refresh();
    },
  };
}

function demoStore() {
  const KEY = 'puzzle-club-demo-v2';
  const SESSION = 'puzzle-club-demo-session';
  const DEMO_PASSWORD = 'puzzle';
  const ls = {
    get(k) {
      try {
        return JSON.parse(localStorage.getItem(k));
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v));
      } catch {}
    },
  };
  function seed() {
    const players = ['Maya', 'Jordan', 'Sam', 'Priya'];
    const games = [{ id: 'demo-geogrid', name: 'Geo Grid', url: 'https://example.com/geogrid', scoring: 'points', color: CUSTOM_COLORS[0], createdBy: 'Sam', createdAt: 1 }];
    const all = [...GAMES, ...games.map(makeCustomGame)];
    const scores = [];
    for (let back = 0; back < 12; back++) {
      const d = new Date();
      d.setDate(d.getDate() - back);
      const date = ymd(d);
      for (const name of players)
        for (const g of all) {
          if (Math.random() < 0.3) continue;
          const v = g.demo ? g.demo() : g.lowerIsBetter ? String(30 + Math.floor(Math.random() * 90)) : String(Math.floor(Math.random() * 50) * 100);
          const r = g.fromManual(v);
          const playerKey = toPlayerKey(name);
          scores.push({ id: `${g.id}_${date}_${playerKey}`, gameId: g.id, date, playerKey, name, ...r, puzzle: null });
        }
    }
    return { scores, games };
  }
  let data = ls.get(KEY) || seed();
  const persist = () => ls.set(KEY, data);
  persist();
  let sessionCb = null;
  let scoreL = [];
  let gameL = [];
  const emit = () => {
    scoreL.forEach((l) => l([...data.scores]));
    gameL.forEach((l) => l([...data.games]));
  };
  return {
    mode: 'demo',
    onSession(cb) {
      sessionCb = cb;
      setTimeout(() => cb(ls.get(SESSION)), 0);
    },
    async enter(password, name) {
      await new Promise((r) => setTimeout(r, 250));
      if (password.trim() !== DEMO_PASSWORD) throw new WrongPassword();
      const user = { uid: 'demo', name: name.trim(), playerKey: toPlayerKey(name) };
      ls.set(SESSION, user);
      sessionCb?.(user);
    },
    async leave() {
      ls.set(SESSION, null);
      sessionCb?.(null);
    },
    subscribeScores(cb) {
      scoreL.push(cb);
      setTimeout(() => cb([...data.scores]), 0);
      return () => (scoreL = scoreL.filter((l) => l !== cb));
    },
    subscribeGames(cb) {
      gameL.push(cb);
      setTimeout(() => cb([...data.games]), 0);
      return () => (gameL = gameL.filter((l) => l !== cb));
    },
    async saveScore(e) {
      const id = `${e.gameId}_${e.date}_${e.playerKey}`;
      data.scores = [...data.scores.filter((s) => s.id !== id), { id, ...e }];
      persist();
      emit();
    },
    async deleteScore(id) {
      data.scores = data.scores.filter((s) => s.id !== id);
      persist();
      emit();
    },
    async addGame(g) {
      data.games = [...data.games, { id: `g${Date.now().toString(36)}`, ...g, createdAt: Date.now() }];
      persist();
      emit();
    },
    async removeGame(id) {
      data.games = data.games.filter((g) => g.id !== id);
      persist();
      emit();
    },
    async hideGame(gameId) {
      data.games = [...data.games.filter((g) => g.id !== `hide:${gameId}`), { id: `hide:${gameId}`, name: gameId, scoring: 'hidden', createdAt: Date.now() }];
      persist();
      emit();
    },
    async setOrder(order) {
      data.games = [...data.games.filter((g) => g.id !== 'order'), { id: 'order', name: order.join(','), scoring: 'order', createdAt: 0 }];
      persist();
      emit();
    },
    async unhideGame(gameId) {
      data.games = data.games.filter((g) => g.id !== `hide:${gameId}`);
      persist();
      emit();
    },
    reset() {
      data = seed();
      persist();
      emit();
    },
  };
}

// ── state ────────────────────────────────────────────────────
const state = {
  store: null,
  user: null,
  phase: 'loading', // loading | gate | ready | error
  gateMsg: '',
  error: '',
  scores: [],
  customGames: [],
  hiddenBuiltins: new Set(),
  order: [],
  previews: loadPreviewCache(),
  arranging: false,
  gamesReady: false, // false until the game list (saved or from Google) has arrived
  lbGame: null, // null = whichever game is first in the current order
  lbPeriod: 'today',
  lbDay: null,
  cardPeriod: {}, // per-card Day / Week / All choice // null = follow today; otherwise 'YYYY-MM-DD' when browsing past days
};
let unsubs = [];

const $app = document.getElementById('app');
const $modal = document.getElementById('modal-root');
const $toast = document.getElementById('toast');
document.title = SITE_NAME;

function allGames() {
  const list = [...GAMES.filter((g) => !state.hiddenBuiltins.has(g.id)), ...state.customGames];
  if (!state.order.length) return list;
  const pos = new Map(state.order.map((id, i) => [id, i]));
  const at = (g, i) => (pos.has(g.id) ? pos.get(g.id) : 10000 + i); // games not in the saved order go last
  return list.map((g, i) => [g, at(g, i)]).sort((a, b) => a[1] - b[1]).map(([g]) => g);
}
const gameById = (id) => allGames().find((g) => g.id === id);
const hiddenGames = () => GAMES.filter((g) => state.hiddenBuiltins.has(g.id));

// ── leaderboard math ────────────────────────────────────────
function standings(gameId, period, day = ymd()) {
  const g = gameById(gameId);
  if (!g) return [];
  const today = ymd();
  const ws = weekStart();
  const rows = state.scores.filter(
    (s) =>
      s.gameId === gameId &&
      (period === 'all' || (period === 'today' ? s.date === day : s.date >= ws && s.date <= today))
  );
  const by = new Map();
  for (const s of rows) {
    const r = by.get(s.playerKey) || { key: s.playerKey, name: s.name, n: 0, sum: 0, best: null, bestDisplay: '', last: null };
    r.n++;
    r.sum += s.score;
    if (r.best === null || (g.lowerIsBetter ? s.score < r.best : s.score > r.best)) {
      r.best = s.score;
      r.bestDisplay = s.display;
    }
    if (!r.last || s.date > r.last.date) {
      r.last = s;
      r.name = s.name;
    }
    by.set(s.playerKey, r);
  }
  const list = [...by.values()].map((r) => ({ ...r, avg: r.sum / r.n }));
  list.sort((a, b) => (g.lowerIsBetter ? a.avg - b.avg : b.avg - a.avg) || b.n - a.n);
  let rank = 0;
  let prev = null;
  list.forEach((r, i) => {
    if (prev === null || r.avg !== prev) rank = i + 1;
    r.rank = rank;
    prev = r.avg;
  });
  return list;
}
const isMe = (key) => key === state.user?.playerKey;
const myScore = (gameId, date = ymd()) => state.scores.find((s) => s.gameId === gameId && s.date === date && isMe(s.playerKey));

// ── rendering ────────────────────────────────────────────────
const TROPHY = `<svg class="logo" viewBox="0 0 44 44" aria-hidden="true"><path d="M13 6h18v8a9 9 0 0 1-18 0z" fill="#f5c66b"/><path d="M13 9H7a6 6 0 0 0 6 8M31 9h6a6 6 0 0 1-6 8" fill="none" stroke="#f5c66b" stroke-width="2.5"/><rect x="19.5" y="22" width="5" height="8" fill="#f5c66b"/><rect x="13" y="30" width="18" height="6" rx="2" fill="#a78bfa"/></svg>`;

const avatar = (name, size = 'sm') => `<span class="avatar ${size}" aria-hidden="true">${esc(initials(name))}</span>`;

function header() {
  const u = state.user;
  return `
  <header class="topbar">
    <div class="brand">${TROPHY}${esc(SITE_NAME)}</div>
    <div class="top-right">
      <button class="qr-btn" data-action="qr" aria-label="Get Gamtime on your phone" title="Get the app on your phone">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14 14h2v2h-2zM18 14h2v2h-2zM16 16h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z" fill="currentColor"/></svg>
        <span>Get the app</span>
      </button>
      ${
        u && state.phase === 'ready'
          ? `<div class="me">${avatar(u.name)}<button class="me-name name-link" data-action="profile" data-player="${esc(u.playerKey)}">${esc(u.name)}</button>
             <button class="btn ghost small" data-action="leave">Log out</button></div>`
          : ''
      }
    </div>
  </header>
  ${
    state.store?.mode === 'demo'
      ? `<div class="demo-banner">Demo mode: the password is <strong>puzzle</strong>, players are samples, and everything saves only in this browser.
         ${state.phase === 'ready' ? '<button class="linklike" data-action="reset-demo">Reset demo data</button>' : ''}</div>`
      : ''
  }`;
}

function gateScreen() {
  return `${header()}<main class="gate"><form class="gate-card" id="gate-form" novalidate>
    <div class="gate-mark">${TROPHY}</div>
    <h1>${esc(SITE_NAME)}</h1>
    <p>Enter the password and name you want on the leaderboard #lockin</p>
    <label class="field left"><span class="lbl">Username</span>
      <span class="at-input"><span class="at" aria-hidden="true">@</span><input id="gate-name" class="input" type="text" maxlength="20" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required></span></label>
    <p class="hint left">Letters, numbers and underscores. Use the same one on every device so your scores stay together.</p>
    <label class="field left"><span class="lbl">Password</span>
      <input id="gate-pw" class="input" type="password" autocomplete="current-password" required></label>
    <p class="form-err left" id="gate-err" role="alert">${esc(state.gateMsg)}</p>
    <button class="btn primary big wide" type="submit">Enter</button>
  </form></main>`;
}

function thumb(g) {
  const img = (CARD_IMAGES || {})[g.url] || state.previews[g.url];
  return `<a class="thumb" href="${esc(g.url)}" target="_blank" rel="noopener noreferrer" aria-label="Play ${esc(g.name)}" data-action="play" data-game="${esc(g.id)}">
    <span class="play-hint" aria-hidden="true">Play ↗</span>
    <span class="thumb-fallback">${esc(String(g.name).trim().charAt(0).toUpperCase())}</span>
    ${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
  </a>`;
}

let previewsInFlight = false;
async function ensurePreviews() {
  if (!state.store?.previews || previewsInFlight) return;
  const missing = [...new Set(allGames().map((g) => g.url))].filter((u) => !(u in state.previews));
  if (!missing.length) return;
  previewsInFlight = true;
  try {
    const found = await state.store.previews(missing);
    state.previews = { ...state.previews, ...found };
    for (const u of missing) if (!(u in state.previews)) state.previews[u] = '';
    try {
      localStorage.setItem(PREVIEW_KEY, JSON.stringify(state.previews));
    } catch {}
    if (state.phase === 'ready' && !state.arranging) render();
  } catch {
    /* previews are a nice-to-have; ignore failures */
  } finally {
    previewsInFlight = false;
  }
}

function arrangeCard(g, i, n) {
  return `
  <article class="card arranging" style="--accent:${esc(g.color)}">
    <div class="card-top"><div><p class="maker">${esc(g.maker)}</p><h3>${esc(g.name)}</h3></div>
      <span class="pos">${i + 1}</span></div>
    <div class="card-actions">
      <button class="btn" data-action="move" data-game="${esc(g.id)}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(g.name)} earlier">← Earlier</button>
      <button class="btn" data-action="move" data-game="${esc(g.id)}" data-dir="1" ${i === n - 1 ? 'disabled' : ''} aria-label="Move ${esc(g.name)} later">Later →</button>
    </div>
    <button class="remove" data-action="move-first" data-game="${esc(g.id)}" ${i === 0 ? 'hidden' : ''}>Move to front</button>
  </article>`;
}

function gameCard(g) {
  const mine = myScore(g.id);
  return `
  <article class="card game-card" style="--accent:${esc(g.color)}">
    ${thumb(g)}
    <div class="card-row">
      <h3 title="${esc(g.name)}">${esc(g.name)}</h3>
      <div class="card-btns">
        <button class="btn small ${mine ? 'logged' : ''}" data-action="log" data-game="${esc(g.id)}">${mine ? 'Edit score' : 'Log'}</button>
        <button class="btn small icon-btn" data-action="remove-game" data-game="${esc(g.id)}" aria-label="Remove ${esc(g.name)}" title="Remove game">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>
    ${miniBoard(g)}
  </article>`;
}

// ── stats: streaks, champions, profiles ─────────────────────
// A "win" = the top score in a game on a given day. Ties all get the win.
function nameOf(key) {
  let best = null;
  for (const s of state.scores) if (s.playerKey === key && (!best || s.date >= best.date)) best = s;
  return best ? best.name : key;
}
function playerKeys() {
  return [...new Set(state.scores.map((s) => s.playerKey))];
}
function streak(key, gameId) {
  const days = new Set(state.scores.filter((s) => s.playerKey === key && (!gameId || s.gameId === gameId)).map((s) => s.date));
  let d = ymd();
  if (!days.has(d)) d = shiftDay(d, -1); // today isn't over yet, so a streak through yesterday still counts
  let n = 0;
  while (days.has(d)) {
    n++;
    d = shiftDay(d, -1);
  }
  return n;
}
function bestStreak(key, gameId) {
  const days = [...new Set(state.scores.filter((s) => s.playerKey === key && (!gameId || s.gameId === gameId)).map((s) => s.date))].sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of days) {
    run = prev && shiftDay(prev, 1) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}
const fire = (n) => (n >= 2 ? `<span class="streak" title="${n}-day streak">🔥${n}</span>` : '');
function winsOn(date) {
  const wins = new Map();
  for (const g of allGames()) {
    const rows = state.scores.filter((s) => s.gameId === g.id && s.date === date);
    if (!rows.length) continue;
    const top = g.lowerIsBetter ? Math.min(...rows.map((r) => r.score)) : Math.max(...rows.map((r) => r.score));
    rows.filter((r) => r.score === top).forEach((r) => wins.set(r.playerKey, (wins.get(r.playerKey) || 0) + 1));
  }
  return wins;
}
function datesFor(period) {
  const today = ymd();
  const all = [...new Set(state.scores.map((s) => s.date))].filter((d) => d <= today);
  if (period === 'today') return [today];
  if (period === 'week') return all.filter((d) => d >= weekStart());
  return all;
}
function champions(period) {
  const dates = datesFor(period);
  const wins = new Map();
  for (const d of dates) for (const [k, n] of winsOn(d)) wins.set(k, (wins.get(k) || 0) + n);
  const ids = new Set(allGames().map((g) => g.id));
  const played = new Map();
  for (const s of state.scores) if (dates.includes(s.date) && ids.has(s.gameId)) played.set(s.playerKey, (played.get(s.playerKey) || 0) + 1);
  const list = [...played.keys()].map((k) => ({ key: k, name: nameOf(k), wins: wins.get(k) || 0, played: played.get(k) }));
  list.sort((a, b) => b.wins - a.wins || b.played - a.played || a.name.localeCompare(b.name));
  let rank = 0;
  let prev = null;
  list.forEach((r, i) => {
    const sig = `${r.wins}|${r.played}`;
    if (sig !== prev) rank = i + 1;
    r.rank = rank;
    prev = sig;
  });
  return list;
}
const who = (key, name) =>
  `<button class="name-link" data-action="profile" data-player="${esc(key)}">${esc(name || nameOf(key))}</button>`;

function champBanner() {
  const pill = (period, icon, label) => {
    const list = champions(period);
    const top = list.filter((r) => r.wins > 0 && r.wins === list[0]?.wins);
    const text = top.length
      ? `${top.length > 2 ? `${top.length}-way tie` : top.map((r) => esc(r.name)).join(' & ')} <span class="champ-wins">· ${top[0].wins} win${top[0].wins === 1 ? '' : 's'}</span>`
      : '<span class="champ-wins">No champ yet</span>';
    return `<button class="champ" data-action="champs" data-period="${period}"><span class="champ-icon" aria-hidden="true">${icon}</span><span class="champ-label">${label}</span><span class="champ-name">${text}</span></button>`;
  };
  return `<div class="champs">${pill('today', '👑', 'Today')}${pill('week', '🏆', 'This week')}</div>`;
}

function champModalBody() {
  const p = state.champPeriod || 'today';
  const list = champions(p);
  const rows = list
    .map(
      (r) => `<li class="${isMe(r.key) ? 'me' : ''}">
        <span class="rk ${r.rank === 1 && r.wins ? 'first' : ''}">${r.rank === 1 && r.wins ? '👑' : r.rank}</span>
        ${avatar(r.name, 'xs')}<span class="nm">${who(r.key, r.name)} ${fire(streak(r.key))}</span>
        <span class="sc">${r.wins} win${r.wins === 1 ? '' : 's'}</span><span class="pl">${r.played} played</span></li>`
    )
    .join('');
  return `
    <p class="maker">Champions</p>
    <h2 id="modal-title">Who's winning</h2>
    <div class="seg" role="tablist" aria-label="Period">
      ${['today', 'week', 'all']
        .map(
          (k) =>
            `<button role="tab" aria-selected="${p === k}" class="${p === k ? 'on' : ''}" data-action="champ-period" data-period="${k}">${
              { today: 'Today', week: 'This week', all: 'All time' }[k]
            }</button>`
        )
        .join('')}
    </div>
    <ol class="champ-list">${rows || '<li class="empty">No scores yet.</li>'}</ol>
    <p class="muted small">A win is the top score in a game that day. Ties all get the win. 🔥 is a streak of days in a row with at least one score.</p>`;
}
function openChampModal(period) {
  state.champPeriod = period || 'today';
  showModal('<div id="champ-modal-body"></div>', '#f5c66b', () => {});
  renderPanels();
}

function profileBody(key) {
  const name = nameOf(key);
  const mine = state.scores.filter((s) => s.playerKey === key);
  const ids = new Set(allGames().map((g) => g.id));
  const winsAll = champions('all').find((r) => r.key === key)?.wins || 0;
  const winsWeek = champions('week').find((r) => r.key === key)?.wins || 0;
  const games = allGames()
    .map((g) => {
      const rows = mine.filter((s) => s.gameId === g.id);
      if (!rows.length) return '';
      const avg = rows.reduce((t, r) => t + r.score, 0) / rows.length;
      const best = rows.reduce((b, r) => (b == null || (g.lowerIsBetter ? r.score < b.score : r.score > b.score) ? r : b), null);
      const st = streak(key, g.id);
      return `<tr><td><span class="gdot" style="--accent:${esc(g.color)}"></span>${esc(g.name)}</td><td>${rows.length}</td>
        <td>${esc(g.formatAvg(avg))}</td><td>${esc(best.display)}</td><td>${st ? `🔥${st}` : '—'}</td></tr>`;
    })
    .join('');
  const tile = (label, val) => `<div class="tile"><span class="tile-v">${val}</span><span class="tile-l">${label}</span></div>`;
  return `
    <div class="prof-head">${avatar(name, 'lg')}<div><h2 id="modal-title">${esc(name)}</h2>
      <p class="muted small">${isMe(key) ? 'That’s you' : 'Player'} · ${mine.filter((s) => ids.has(s.gameId)).length} scores logged</p></div></div>
    <div class="tiles">
      ${tile('Current streak', streak(key) ? `🔥${streak(key)}` : '0')}
      ${tile('Best streak', bestStreak(key))}
      ${tile('Wins this week', winsWeek)}
      ${tile('Wins all time', winsAll)}
    </div>
    ${
      games
        ? `<div class="scroll"><table class="table prof-table"><thead><tr><th>Game</th><th>Played</th><th>Avg</th><th>Best</th><th>Streak</th></tr></thead><tbody>${games}</tbody></table></div>`
        : '<div class="board-empty">No scores yet.</div>'
    }`;
}
function openProfile(key) {
  state.profileKey = key;
  showModal('<div id="profile-modal-body"></div>', '#a78bfa', () => {});
  $modal.querySelector('.modal').classList.add('wide');
  renderPanels();
}
function renderPanels() {
  renderBoardModal();
  const c = document.getElementById('champ-modal-body');
  if (c) c.innerHTML = champModalBody();
  const pr = document.getElementById('profile-modal-body');
  if (pr && state.profileKey) pr.innerHTML = profileBody(state.profileKey);
}

function miniBoard(g) {
  const p = state.cardPeriod[g.id] || 'today';
  const list = standings(g.id, p);
  const top = list.slice(0, 3);
  const meRow = list.find((r) => isMe(r.key));
  const show = meRow && !top.includes(meRow) ? [...top, meRow] : top;
  const val = (r) => esc(p === 'today' ? r.last.display : g.formatAvg(r.avg));
  const empty = { today: 'No scores yet today.', week: 'No scores this week.', all: 'No scores yet.' }[p];
  return `
    <div class="mini-seg" role="tablist" aria-label="${esc(g.name)} leaderboard period">
      ${['today', 'week', 'all']
        .map(
          (k) =>
            `<button role="tab" aria-selected="${p === k}" class="${p === k ? 'on' : ''}" data-action="card-period" data-game="${esc(g.id)}" data-period="${k}">${
              { today: 'Day', week: 'Week', all: 'All' }[k]
            }</button>`
        )
        .join('')}
    </div>
    <ol class="mini-lb">
      ${
        show.length
          ? show
              .map(
                (r) => `<li class="${isMe(r.key) ? 'me' : ''}">
                  <span class="rk ${r.rank === 1 ? 'first' : ''}">${r.rank}</span>
                  <span class="nm">${who(r.key, r.name)} ${fire(streak(r.key, g.id))}</span>
                  <span class="sc">${val(r)}</span></li>`
              )
              .join('')
          : `<li class="empty">${empty}</li>`
      }
    </ol>
    <button class="see-all" data-action="see-all" data-game="${esc(g.id)}">${
      list.length > 3 ? `See all ${list.length} →` : 'Full leaderboard →'
    }</button>`;
}

function openBoardModal(gameId) {
  const g = gameById(gameId);
  if (!g) return;
  state.lbGame = gameId;
  state.lbPeriod = state.cardPeriod[gameId] || 'today';
  state.lbDay = null;
  showModal(`<div id="board-modal-body"></div>`, g.color, () => {});
  $modal.querySelector('.modal').classList.add('wide');
  renderBoardModal();
}
function renderBoardModal() {
  const host = document.getElementById('board-modal-body');
  if (host) host.innerHTML = leaderboard(true);
}

const addCard = () => `
  <button class="card add-card" data-action="add-game" aria-label="Add a game">
    <span class="plus" aria-hidden="true">+</span>
    <span class="add-title">Add a game</span>
    <span class="add-sub">Paste a link and it gets its own card and leaderboard.</span>
  </button>`;

function shiftDay(d, n) {
  const [y, m, dd] = d.split('-').map(Number);
  const x = new Date(y, m - 1, dd);
  x.setDate(x.getDate() + n);
  return ymd(x);
}
function dayLabel(d) {
  if (d === ymd()) return 'Today';
  if (d === shiftDay(ymd(), -1)) return 'Yesterday';
  const [y, m, dd] = d.split('-').map(Number);
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (y !== new Date().getFullYear()) opts.year = 'numeric';
  return new Date(y, m - 1, dd).toLocaleDateString(undefined, opts);
}

function leaderboard(single = false) {
  const g = (state.lbGame && gameById(state.lbGame)) || allGames()[0];
  if (!g) return '';
  const p = state.lbPeriod;
  const today = ymd();
  if (state.lbDay && state.lbDay >= today) state.lbDay = null;
  const day = state.lbDay || today;
  const isToday = day === today;
  const list = standings(g.id, p, day);
  const periodLabel = p === 'today' ? dayLabel(day) : { week: 'This week', all: 'All time' }[p];
  const rows = list
    .map((r) => {
      const me = isMe(r.key);
      const main = p === 'today' ? esc(r.last.display) : esc(g.formatAvg(r.avg));
      const extra =
        p === 'today' ? (r.last.puzzle ? `#${r.last.puzzle.toLocaleString()}` : '') : `${r.n} played · best ${esc(r.bestDisplay)}`;
      return `<tr class="${me ? 'is-me' : ''}">
        <td class="rank">${r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : r.rank}</td>
        <td class="player">${avatar(r.name)}<span>${who(r.key, r.name)}${me ? ' <span class="muted">(you)</span>' : ''} ${fire(streak(r.key, g.id))}</span></td>
        <td class="score">${main}</td>
        <td class="extra">${extra}${
          me && p === 'today'
            ? ` <button class="row-remove" data-action="remove-score" data-id="${esc(r.last.id || `${g.id}_${r.last.date}_${r.key}`)}" title="Remove this score">Remove</button>`
            : ''
        }</td>
      </tr>`;
    })
    .join('');
  return `
  <section class="board" aria-labelledby="board-title">
    <div class="board-head">
      <h2 id="board-title">${single ? esc(g.name) : 'Leaderboard'}</h2>
      <div class="seg" role="tablist" aria-label="Time period">
        ${['today', 'week', 'all']
          .map(
            (k) =>
              `<button role="tab" aria-selected="${p === k}" class="${p === k ? 'on' : ''}" data-action="period" data-period="${k}">${
                { today: 'By day', week: 'This week', all: 'All time' }[k]
              }</button>`
          )
          .join('')}
      </div>
    </div>
    ${single ? '' : `<div class="chips" role="tablist" aria-label="Game">
      ${allGames()
        .map(
          (x) =>
            `<button role="tab" aria-selected="${x.id === g.id}" class="chip ${x.id === g.id ? 'on' : ''}" style="--accent:${esc(x.color)}" data-action="lb-game" data-game="${esc(x.id)}">${esc(x.name)}</button>`
        )
        .join('')}
    </div>`}
    ${
      p === 'today'
        ? `<div class="daynav" aria-label="Choose a day">
            <button class="daybtn" data-action="day-prev" aria-label="Previous day">←</button>
            <span class="daylabel">${esc(dayLabel(day))}</span>
            <button class="daybtn" data-action="day-next" aria-label="Next day" ${isToday ? 'disabled' : ''}>→</button>
            ${isToday ? '' : '<button class="linklike today-link" data-action="day-today">Back to today</button>'}
          </div>`
        : ''
    }
    <p class="board-note">${esc(g.name)} · ${periodLabel}${
      p === 'today' ? '' : ` · ranked by average${g.lowerIsBetter ? ' (lower is better)' : ''}`
    }</p>
    ${
      list.length
        ? `<table class="table"><thead><tr><th>#</th><th>Player</th><th>${p === 'today' ? 'Score' : 'Average'}</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
        : `<div class="board-empty">No ${esc(g.name)} scores ${p === 'today' ? (isToday ? 'today' : `on ${esc(dayLabel(day))}`) : p === 'week' ? 'this week' : 'yet'}.</div>`
    }
  </section>`;
}

function render() {
  if (state.phase === 'loading') {
    $app.innerHTML = `${header()}<main class="gate"><p class="muted">Loading…</p></main>`;
    return;
  }
  if (state.phase === 'error') {
    $app.innerHTML = `${header()}<main class="gate"><div class="gate-card"><h1>Something went wrong</h1><p>${esc(state.error)}</p></div></main>`;
    return;
  }
  if (state.phase === 'gate') {
    $app.innerHTML = gateScreen();
    bindGate();
    return;
  }
  const games = allGames();
  queueMicrotask(renderPanels);
  $app.innerHTML = `${header()}
  <main class="wrap">
    <section class="hero">
      <p class="eyebrow">${esc(prettyDate(ymd()))}</p>
      <h1>Time to lock in.</h1>
      ${state.gamesReady ? champBanner() : ''}
    </section>
    <div class="grid-head">
      ${
        state.arranging
          ? `<p class="arrange-hint">Move the cards into the order you want, then save. Everyone sees the same order.</p>
             <div class="arrange-actions"><button class="btn ghost" data-action="arrange-cancel">Cancel</button>
             <button class="btn primary" data-action="arrange-save">Save order</button></div>`
          : state.gamesReady ? `<button class="btn small" data-action="arrange">⇅ Rearrange</button>` : ''
      }
    </div>
    <section class="grid" aria-label="Games" aria-busy="${!state.gamesReady}">${
      !state.gamesReady
        ? Array.from({ length: 6 }, () => '<div class="card skeleton" aria-hidden="true"><div class="sk-img"></div><div class="sk-line"></div><div class="sk-line short"></div></div>').join('')
        : state.arranging ? games.map((g, i) => arrangeCard(g, i, games.length)).join('') : games.map(gameCard).join('') + addCard()
    }</section>
  </main>`;
}

function bindGate() {
  const form = document.getElementById('gate-form');
  const pw = document.getElementById('gate-pw');
  const nm = document.getElementById('gate-name');
  const err = document.getElementById('gate-err');
  try {
    nm.value = localStorage.getItem('gamtime-last-username') || '';
  } catch {}
  nm.addEventListener('input', () => {
    const clean = nm.value.toLowerCase().replace(/^@+/, '').replace(/[^a-z0-9_]/g, '');
    if (clean !== nm.value) nm.value = clean;
  });
  (nm.value ? pw : nm).focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (!pw.value.trim()) return (err.textContent = 'Enter the password.'), pw.focus();
    const username = nm.value.trim().toLowerCase().replace(/^@+/, '');
    if (!/^[a-z0-9_]{2,20}$/.test(username))
      return (err.textContent = 'Pick a username with 2–20 letters, numbers or underscores.'), nm.focus();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      try {
        localStorage.setItem('gamtime-last-username', username);
      } catch {}
      await state.store.enter(pw.value, `@${username}`);
      state.gateMsg = '';
    } catch (ex) {
      btn.disabled = false;
      btn.textContent = 'Enter';
      err.textContent = ex instanceof WrongPassword ? 'That password isn’t right.' : `Couldn’t get in: ${ex.message || ex}`;
      pw.select();
    }
  });
}

// ── modals ──────────────────────────────────────────────────
let modalCleanup = null;
function showModal(html, accent, onClick, afterOpen) {
  modalCleanup?.();
  $modal.innerHTML = `<div class="backdrop" data-modal="backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" style="--accent:${esc(accent)}">
    <button class="x" data-modal="close" aria-label="Close">×</button>${html}</div></div>`;
  const close = () => {
    $modal.innerHTML = '';
    document.removeEventListener('keydown', onKey);
    modalCleanup = null;
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  modalCleanup = () => document.removeEventListener('keydown', onKey);
  $modal.querySelector('.backdrop').addEventListener('click', (e) => {
    if (e.target.dataset.modal === 'backdrop') return close();
    const act = e.target.closest('[data-modal]')?.dataset.modal;
    if (act === 'close') return close();
    if (act) onClick(act, e, close);
  });
  afterOpen?.(close);
}

function manualField(g) {
  const m = g.manual;
  if (m.type === 'select') {
    return `<select id="manual" class="input"><option value="">Choose…</option>${m.options
      .map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`)
      .join('')}</select>`;
  }
  return `<input id="manual" class="input" type="${m.type === 'number' ? 'number' : 'text'}" inputmode="${
    m.type === 'number' ? 'numeric' : 'text'
  }" ${m.min != null ? `min="${m.min}"` : ''} ${m.max != null ? `max="${m.max}"` : ''} placeholder="${esc(m.placeholder || '')}">`;
}

function openScoreModal(gameId) {
  const g = gameById(gameId);
  if (!g) return;
  const existing = myScore(g.id);
  let parsed = null;
  showModal(
    `<p class="maker">${esc(g.maker)}</p>
    <h2 id="modal-title">Log your ${esc(g.name)} score</h2>
    ${navigator.clipboard?.readText ? '<button class="btn paste-btn" data-modal="paste">📋 Paste result</button>' : ''}
    <label class="lbl" for="share">${navigator.clipboard?.readText ? 'Or paste your share text here' : 'Paste your share text'}</label>
    <textarea id="share" class="input" rows="5" placeholder="Hit “Share” in ${esc(g.name)}, then paste here"></textarea>
    <p id="parse-msg" class="parse-msg" aria-live="polite"></p>
    <div class="or"><span>check, change or enter your score</span></div>
    <div class="row">
      <label class="field"><span class="lbl">${esc(g.manual.label)}</span>${manualField(g)}</label>
      <label class="field"><span class="lbl">Date</span><input id="date" class="input" type="date" value="${ymd()}" max="${ymd()}"></label>
    </div>
    <p id="form-err" class="form-err" role="alert"></p>
    ${existing ? `<p class="muted small">You already logged ${esc(existing.display)} today. Saving replaces it.</p>` : ''}
    <div class="modal-actions">
      ${existing ? `<button class="btn ghost danger" data-modal="delete">Remove today’s score</button>` : '<span></span>'}
      <div><button class="btn ghost" data-modal="close">Cancel</button>
      <button class="btn primary" data-modal="save">Save score</button></div>
    </div>`,
    g.color,
    async (act, e, close) => {
      const $manual = $modal.querySelector('#manual');
      const $err = $modal.querySelector('#form-err');
      if (act === 'paste') {
        const $share = $modal.querySelector('#share');
        const $msg = $modal.querySelector('#parse-msg');
        try {
          const text = await navigator.clipboard.readText();
          if (!text.trim()) throw new Error('empty');
          $share.value = text;
          $share.dispatchEvent(new Event('input'));
          if ($msg.classList.contains('ok')) $modal.querySelector('[data-modal=save]').focus();
        } catch {
          $msg.textContent = 'Couldn’t read what you copied. Tap Share in the game first, or paste into the box below.';
          $msg.className = 'parse-msg warn';
        }
        return;
      }
      if (act === 'delete' && existing) {
        await state.store.deleteScore(existing.id);
        close();
        toast(`Removed your ${g.name} score.`);
      }
      if (act !== 'save') return;
      const r = parsed && $manual.value === parsed.manualValue ? parsed : g.fromManual($manual.value);
      if (r.error) {
        $err.textContent = r.error;
        return $manual.focus();
      }
      const date = $modal.querySelector('#date').value || ymd();
      if (date > ymd()) return ($err.textContent = 'That date is in the future.');
      const btn = e.target.closest('button');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        await state.store.saveScore({
          gameId: g.id,
          date,
          playerKey: state.user.playerKey,
          name: state.user.name,
          score: r.score,
          display: r.display,
          failed: !!r.failed,
          puzzle: r.puzzle ?? null,
        });
        close();
        state.lbGame = g.id;
        render();
        toast(`Saved ${r.display} for ${g.name}.`);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Save score';
        $err.textContent = `Couldn’t save: ${err.message || err}`;
      }
    },
    () => {
      const $share = $modal.querySelector('#share');
      const $manual = $modal.querySelector('#manual');
      const $msg = $modal.querySelector('#parse-msg');
      setTimeout(() => $share.focus(), 30);
      $share.addEventListener('input', () => {
        const t = $share.value.trim();
        $modal.querySelector('#form-err').textContent = '';
        parsed = null;
        if (!t) {
          $msg.textContent = '';
          $msg.className = 'parse-msg';
          return;
        }
        const r = g.parse(t);
        if (r && !r.error) {
          parsed = r;
          $manual.value = r.manualValue;
          $msg.textContent = `Got it: ${r.display}${r.puzzle ? ` on puzzle #${r.puzzle.toLocaleString()}` : ''}.`;
          $msg.className = 'parse-msg ok';
        } else {
          $msg.textContent = `Couldn’t read a score from that. Enter it below instead.`;
          $msg.className = 'parse-msg warn';
        }
      });
    }
  );
}

function openAddGameModal() {
  const color = CUSTOM_COLORS[state.customGames.length % CUSTOM_COLORS.length];
  showModal(
    `<p class="maker">New card</p>
    <h2 id="modal-title">Add a game</h2>
    <label class="field"><span class="lbl">Link to the game</span>
      <input id="ng-url" class="input" type="url" inputmode="url" placeholder="https://…" autocomplete="off"></label>
    <label class="field"><span class="lbl">Name</span>
      <input id="ng-name" class="input" type="text" maxlength="40" placeholder="e.g. Tradle"></label>
    <fieldset class="scoring">
      <legend class="lbl">How is it scored?</legend>
      ${Object.entries(SCORING)
        .map(
          ([k, s], i) => `<label class="opt"><input type="radio" name="ng-scoring" value="${k}" ${i === 0 ? 'checked' : ''}>
          <span><strong>${esc(s.label)}</strong><small>${esc(s.hint)}</small></span></label>`
        )
        .join('')}
    </fieldset>
    ${
      hiddenGames().length
        ? `<div class="restore"><span class="lbl">Bring back a removed game</span><div class="restore-list">${hiddenGames()
            .map(
              (g) =>
                `<button class="chip" style="--accent:${esc(g.color)}" data-modal="restore" data-game="${esc(g.id)}">${esc(g.name)} <span aria-hidden="true">↺</span></button>`
            )
            .join('')}</div></div>`
        : ''
    }
    <p id="ng-err" class="form-err" role="alert"></p>
    <div class="modal-actions"><span></span><div>
      <button class="btn ghost" data-modal="close">Cancel</button>
      <button class="btn primary" data-modal="add">Add game</button></div></div>`,
    color,
    async (act, e, close) => {
      if (act === 'restore') {
        const id = e.target.closest('[data-game]').dataset.game;
        const g = GAMES.find((x) => x.id === id);
        try {
          await state.store.unhideGame(id);
          close();
          toast(`${g?.name || 'Game'} is back.`);
        } catch (err) {
          $modal.querySelector('#ng-err').textContent = `Couldn’t restore it: ${err.message || err}`;
        }
        return;
      }
      if (act !== 'add') return;
      const $err = $modal.querySelector('#ng-err');
      const u = normalizeUrl($modal.querySelector('#ng-url').value);
      if (u.error) return ($err.textContent = u.error), $modal.querySelector('#ng-url').focus();
      const name = $modal.querySelector('#ng-name').value.trim();
      if (!name) return ($err.textContent = 'Give it a name.'), $modal.querySelector('#ng-name').focus();
      if (allGames().some((g) => g.name.toLowerCase() === name.toLowerCase()))
        return ($err.textContent = `There’s already a game called ${name}.`);
      const scoring = $modal.querySelector('input[name=ng-scoring]:checked').value;
      const btn = e.target.closest('button');
      btn.disabled = true;
      btn.textContent = 'Adding…';
      try {
        await state.store.addGame({ name, url: u.url, scoring, color, createdBy: state.user.name });
        close();
        toast(`Added ${name}.`);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Add game';
        $err.textContent = `Couldn’t add it: ${err.message || err}`;
      }
    },
    () => {
      const $url = $modal.querySelector('#ng-url');
      const $name = $modal.querySelector('#ng-name');
      setTimeout(() => $url.focus(), 30);
      // Suggest a name from the link, e.g. "tradle.net" → "Tradle"
      $url.addEventListener('input', () => {
        if ($name.dataset.touched) return;
        const u = normalizeUrl($url.value);
        if (u.error) return;
        const base = hostOf(u.url).split('.')[0];
        $name.value = base ? base[0].toUpperCase() + base.slice(1) : '';
      });
      $name.addEventListener('input', () => ($name.dataset.touched = '1'));
    }
  );
}

function openQrModal() {
  const url = location.origin + location.pathname;
  let code = '';
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    code = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true, alt: 'QR code for Gamtime' });
  } catch {
    code = '';
  }
  showModal(
    `<p class="maker">On your phone</p>
    <h2 id="modal-title">Get Gamtime on your phone</h2>
    <div class="qr-wrap">
      <div class="qr-code">${code || '<p class="muted small">Couldn’t draw the code. Use the link below.</p>'}</div>
      <div class="qr-steps">
        <p><strong>1.</strong> Point your phone’s camera at the code and open the link.</p>
        <p><strong>2. iPhone:</strong> tap Share, then <em>Add to Home Screen</em>.</p>
        <p><strong>Android:</strong> tap ⋮, then <em>Install app</em>.</p>
        <p class="qr-url">${esc(url)}</p>
      </div>
    </div>
    <div class="modal-actions"><span></span><div><button class="btn primary" data-modal="close">Done</button></div></div>`,
    '#a78bfa',
    () => {}
  );
}

let toastTimer;
function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 2600);
}

// ── events ──────────────────────────────────────────────────
let pendingRemove = null;
async function onAction(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'qr') openQrModal();
  else if (a === 'leave') await state.store.leave();
  else if (a === 'log') openScoreModal(el.dataset.game);
  else if (a === 'card-period') {
    state.cardPeriod[el.dataset.game] = el.dataset.period;
    render();
  } else if (a === 'see-all') openBoardModal(el.dataset.game);
  else if (a === 'profile') openProfile(el.dataset.player);
  else if (a === 'champs') openChampModal(el.dataset.period);
  else if (a === 'champ-period') {
    state.champPeriod = el.dataset.period;
    renderPanels();
  }
  else if (a === 'play') {
    // the game opens in a new tab; have the score window waiting when they come back
    const id = el.dataset.game;
    setTimeout(() => openScoreModal(id), 150);
  }
  else if (a === 'add-game') openAddGameModal();
  else if (a === 'remove-game') {
    const id = el.dataset.game;
    if (pendingRemove !== id) {
      // two-step confirm without a browser dialog
      pendingRemove = id;
      el.textContent = el.classList.contains('icon-btn') ? 'Remove?' : 'Click again to remove for everyone';
      el.classList.add('armed');
      setTimeout(() => {
        if (pendingRemove === id) {
          pendingRemove = null;
          render();
        }
      }, 4000);
      return;
    }
    pendingRemove = null;
    const g = gameById(id);
    try {
      if (g?.custom) await state.store.removeGame(id);
      else await state.store.hideGame(id);
      toast(`Removed ${g?.name || 'game'}.${g?.custom ? '' : ' You can bring it back from “Add a game”.'}`);
    } catch (err) {
      toast(`Couldn’t remove it: ${err.message || err}`);
      render();
    }
  } else if (a === 'remove-score') {
    const id = el.dataset.id;
    if (pendingRemove !== id) {
      pendingRemove = id;
      el.textContent = 'Confirm';
      el.classList.add('armed');
      setTimeout(() => {
        if (pendingRemove === id) {
          pendingRemove = null;
          render();
        }
      }, 4000);
      return;
    }
    pendingRemove = null;
    try {
      await state.store.deleteScore(id);
      toast('Score removed.');
    } catch (err) {
      toast(`Couldn’t remove it: ${err.message || err}`);
      render();
    }
  } else if (a === 'arrange') {
    state.arranging = true;
    state.orderBackup = [...state.order];
    state.order = allGames().map((g) => g.id);
    render();
  } else if (a === 'move' || a === 'move-first') {
    const ids = allGames().map((g) => g.id);
    const i = ids.indexOf(el.dataset.game);
    const j = a === 'move-first' ? 0 : i + Number(el.dataset.dir);
    if (i < 0 || j < 0 || j >= ids.length) return;
    const [id] = ids.splice(i, 1);
    ids.splice(j, 0, id);
    state.order = ids;
    render();
    document.querySelector(`[data-action="move"][data-game="${CSS.escape(id)}"][data-dir="${el.dataset.dir || -1}"]`)?.focus();
  } else if (a === 'arrange-cancel') {
    state.arranging = false;
    state.order = state.orderBackup || [];
    render();
  } else if (a === 'arrange-save') {
    el.disabled = true;
    el.textContent = 'Saving…';
    try {
      await state.store.setOrder(allGames().map((g) => g.id));
      state.arranging = false;
      render();
      toast('Order saved for everyone.');
    } catch (err) {
      el.disabled = false;
      el.textContent = 'Save order';
      toast(`Couldn’t save the order: ${err.message || err}`);
    }
  } else if (a === 'lb-game') {
    state.lbGame = el.dataset.game;
    render();
  } else if (a === 'period') {
    state.lbPeriod = el.dataset.period;
    render();
  } else if (a === 'day-prev') {
    state.lbDay = shiftDay(state.lbDay || ymd(), -1);
    render();
  } else if (a === 'day-next') {
    const next = shiftDay(state.lbDay || ymd(), 1);
    state.lbDay = next >= ymd() ? null : next;
    render();
  } else if (a === 'day-today') {
    state.lbDay = null;
    render();
  } else if (a === 'reset-demo') state.store.reset?.();
}
$app.addEventListener('click', onAction);
$modal.addEventListener('click', onAction);

// ── boot ────────────────────────────────────────────────────
function stopListening() {
  unsubs.forEach((u) => u?.());
  unsubs = [];
}
async function boot() {
  render();
  try {
    state.store = isConfigured ? sheetsStore(String(SHEETS_URL).trim()) : demoStore();
  } catch (err) {
    state.phase = 'error';
    state.error = `Couldn’t start (${err.message || err}).`;
    return render();
  }
  state.store.onSession((user) => {
    stopListening();
    state.user = user;
    state.scores = [];
    state.customGames = [];
    state.hiddenBuiltins = new Set();
    state.order = [];
    state.arranging = false;
    state.gamesReady = false;
    if (!user) {
      state.phase = 'gate';
      return render();
    }
    state.phase = 'ready';
    const onErr = async (err) => {
      if (err?.code === 'permission-denied') {
        // password was changed since this device signed in
        state.gateMsg = 'Please enter the password again.';
        await state.store.leave();
      } else toast(`Live updates paused: ${err.message || err}`);
    };
    unsubs.push(
      state.store.subscribeScores((scores) => {
        state.scores = scores;
        render();
      }, onErr),
      state.store.subscribeGames((games) => {
        state.hiddenBuiltins = new Set(games.filter((g) => g.scoring === 'hidden').map((g) => g.name));
        const orderRow = games.find((g) => g.scoring === 'order');
        if (!state.arranging) state.order = orderRow && orderRow.name ? String(orderRow.name).split(',') : [];
        state.customGames = games
          .filter((g) => g.scoring !== 'hidden' && g.scoring !== 'order')
          .map(makeCustomGame)
          .sort((a, b) => a.createdAt - b.createdAt);
        state.gamesReady = true;
        ensurePreviews();
        render();
      }, onErr)
    );
    render();
  });
}
boot();
