// ─────────────────────────────────────────────────────────────
// The game list. To add a game, copy one block and edit it.
//   lowerIsBetter: true for guesses/mistakes/time, false for points
//   manual:        how the "enter it yourself" field looks
//   fromManual:    turns that field's value into a score
//   parse:         reads the game's Share text (return null if it can't)
// ─────────────────────────────────────────────────────────────

const num = (s) => Number(String(s).replace(/[^\d]/g, ''));
export const fmtTime = (s) => {
  s = Math.round(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

export const GAMES = [
  {
    id: 'wordle',
    name: 'Wordle',
    maker: 'NYT Games',
    url: 'https://www.nytimes.com/games/wordle/index.html',
    blurb: 'Six tries to find the five-letter word.',
    color: '#6aaa64',
    lowerIsBetter: true,
    manual: {
      type: 'select',
      label: 'Guesses',
      options: [['1', '1/6'], ['2', '2/6'], ['3', '3/6'], ['4', '4/6'], ['5', '5/6'], ['6', '6/6'], ['X', 'X/6 (missed it)']],
    },
    fromManual(v) {
      if (!v) return { error: 'Pick how many guesses it took.' };
      return v === 'X' ? { score: 7, display: 'X/6', failed: true } : { score: +v, display: `${v}/6`, failed: false };
    },
    parse(t) {
      const m = t.match(/Wordle\s+#?(\d[\d,.]*)\s+([1-6X])\/6/i);
      if (!m) return null;
      const v = m[2].toUpperCase();
      return { ...this.fromManual(v), puzzle: num(m[1]), manualValue: v };
    },
    formatAvg: (a) => a.toFixed(2),
    demo: () => (Math.random() < 0.08 ? 'X' : String(rand(2, 6))),
  },
  {
    id: 'connections',
    name: 'Connections',
    maker: 'NYT Games',
    url: 'https://www.nytimes.com/games/connections',
    blurb: 'Sort sixteen words into four hidden groups.',
    color: '#ba81c5',
    lowerIsBetter: true,
    manual: {
      type: 'select',
      label: 'Mistakes',
      options: [['0', 'Perfect (0 mistakes)'], ['1', '1 mistake'], ['2', '2 mistakes'], ['3', '3 mistakes'], ['4', "Didn't solve it"]],
    },
    fromManual(v) {
      if (v === '' || v == null) return { error: 'Pick how many mistakes you made.' };
      const n = +v;
      if (n >= 4) return { score: 4, display: 'Missed', failed: true };
      return { score: n, display: n === 0 ? 'Perfect' : plural(n, 'mistake'), failed: false };
    },
    parse(t) {
      if (!/Connections/i.test(t)) return null;
      const rows = t
        .split(/\r?\n/)
        .map((line) => [...line.matchAll(/🟨|🟩|🟦|🟪/gu)].map((m) => m[0]))
        .filter((r) => r.length === 4);
      if (!rows.length) return null;
      const solved = rows.filter((r) => r.every((c) => c === r[0])).length;
      const mistakes = solved === 4 ? rows.length - 4 : 4;
      const pm = t.match(/Puzzle\s*#\s*(\d[\d,]*)/i);
      return { ...this.fromManual(String(mistakes)), puzzle: pm ? num(pm[1]) : null, manualValue: String(mistakes) };
    },
    formatAvg: (a) => a.toFixed(2),
    demo: () => String(Math.random() < 0.15 ? 4 : rand(0, 3)),
  },
  {
    id: 'strands',
    name: 'Strands',
    maker: 'NYT Games',
    url: 'https://www.nytimes.com/games/strands',
    blurb: 'Find the themed words hiding in the grid.',
    color: '#4fa3c7',
    lowerIsBetter: true,
    manual: { type: 'number', label: 'Hints used', min: 0, max: 20, placeholder: '0' },
    fromManual(v) {
      if (v === '' || v == null || isNaN(+v) || +v < 0) return { error: 'Enter how many hints you used.' };
      const n = Math.round(+v);
      return { score: n, display: n === 0 ? 'No hints' : plural(n, 'hint'), failed: false };
    },
    parse(t) {
      const m = t.match(/Strands\s*#\s*(\d[\d,]*)/i);
      if (!m) return null;
      const hints = [...t.matchAll(/💡/gu)].length;
      return { ...this.fromManual(String(hints)), puzzle: num(m[1]), manualValue: String(hints) };
    },
    formatAvg: (a) => a.toFixed(2),
    demo: () => String(Math.random() < 0.55 ? 0 : rand(1, 3)),
  },
  {
    id: 'mini',
    name: 'The Mini',
    maker: 'NYT Games',
    url: 'https://www.nytimes.com/crosswords/game/mini',
    blurb: 'A five-by-five crossword. Fastest time wins.',
    color: '#5c8fd6',
    lowerIsBetter: true,
    manual: { type: 'text', label: 'Time (m:ss)', placeholder: '0:42' },
    fromManual(v) {
      const s = String(v ?? '').trim();
      let secs = null;
      const m = s.match(/^(\d{1,3}):([0-5]\d)$/);
      if (m) secs = +m[1] * 60 + +m[2];
      else if (/^\d+$/.test(s)) secs = +s;
      if (secs == null || secs <= 0) return { error: 'Enter your time like 1:05.' };
      return { score: secs, display: fmtTime(secs), failed: false };
    },
    parse(t) {
      if (!/mini/i.test(t)) return null;
      const m = t.match(/(\d{1,3}):([0-5]\d)/);
      if (!m) return null;
      const v = `${+m[1]}:${m[2]}`;
      return { ...this.fromManual(v), puzzle: null, manualValue: v };
    },
    formatAvg: (a) => fmtTime(a),
    demo: () => fmtTime(rand(22, 150)),
  },
  {
    id: 'krillion',
    name: 'Krillion',
    maker: 'krillion.io',
    url: 'https://krillion.io/',
    blurb: 'Daily trivia where the rarest right answers score highest.',
    color: '#e0795b',
    lowerIsBetter: false,
    manual: { type: 'number', label: 'Score', min: 0, max: 100000, placeholder: '4200' },
    fromManual(v) {
      if (v === '' || v == null || isNaN(+v) || +v < 0) return { error: 'Enter your score.' };
      const n = Math.round(+v);
      return { score: n, display: n.toLocaleString(), failed: false };
    },
    // Share text looks like:
    //   Krillion #133 🦐
    //   230
    //   🦑🫧🐟🐟🫧🐟🦑
    parse(t) {
      if (!/krillion/i.test(t)) return null;
      const pm = t.match(/krillion\s*#\s*(\d[\d,]*)/i);
      const m = t.match(/^\s*(\d[\d,]*)\s*$/m) || t.match(/(\d[\d,]*)\s*(?:pts|points)\b/i);
      if (!m) return null;
      const v = String(num(m[1]));
      return { ...this.fromManual(v), puzzle: pm ? num(pm[1]) : null, manualValue: v };
    },
    formatAvg: (a) => Math.round(a).toLocaleString(),
    demo: () => String(rand(15, 65) * 100),
  },
];


// ── Games people add with the + button ───────────────────────
// Each one picks a scoring style; these supply the form field and the share-text reader.
export const SCORING = {
  points: {
    label: 'Points',
    hint: 'Higher score wins',
    lowerIsBetter: false,
    manual: { type: 'number', label: 'Score', min: 0, placeholder: '1200' },
    fromManual(v) {
      if (v === '' || v == null || isNaN(+v) || +v < 0) return { error: 'Enter your score.' };
      const n = Math.round(+v);
      return { score: n, display: n.toLocaleString(), failed: false };
    },
    // Looks for a number with a unit ("1,797m", "850 pts"), then "Score: 850", then a number on its own line.
    // Puzzle numbers like "#133" or "No. 60" are picked up separately and never used as the score.
    parse(t) {
      const m =
        t.match(/(\d[\d,]*)\s*(?:pts|points|m|meters|metres|ft|feet)\b/i) ||
        t.match(/score\s*[:=]?\s*(\d[\d,]*)/i) ||
        t.match(/^\s*(\d[\d,]*)\s*$/m);
      if (!m) return null;
      const pm = t.match(/(?:#|\bNo\.?\s*)(\d[\d,]*)/i);
      const v = String(num(m[1]));
      return { ...this.fromManual(v), puzzle: pm ? num(pm[1]) : null, manualValue: v };
    },
    formatAvg: (a) => Math.round(a).toLocaleString(),
  },
  guesses: {
    label: 'Guesses',
    hint: 'Fewest tries wins',
    lowerIsBetter: true,
    manual: { type: 'number', label: 'Guesses', min: 1, placeholder: '4' },
    fromManual(v) {
      if (v === '' || v == null || isNaN(+v) || +v < 1) return { error: 'Enter how many guesses it took.' };
      const n = Math.round(+v);
      return { score: n, display: `${n} ${n === 1 ? 'guess' : 'guesses'}`, failed: false };
    },
    parse(t) {
      const m = t.match(/\b(\d{1,2}|X)\s*\/\s*(\d{1,2})\b/i);
      if (!m) return null;
      if (m[1].toUpperCase() === 'X') {
        const n = +m[2] + 1;
        return { score: n, display: `X/${m[2]}`, failed: true, puzzle: null, manualValue: String(n) };
      }
      return { score: +m[1], display: `${m[1]}/${m[2]}`, failed: false, puzzle: null, manualValue: m[1] };
    },
    formatAvg: (a) => a.toFixed(2),
  },
  lowest: {
    label: 'Lowest score',
    hint: 'Lowest score wins',
    lowerIsBetter: true,
    manual: { type: 'text', label: 'Score', placeholder: '3' },
    fromManual(v) {
      const raw = String(v ?? '').trim().replace('−', '-');
      if (/^e(ven)?$/i.test(raw)) return { score: 0, display: 'E', failed: false }; // golf "even"
      const f = raw.match(/^(\d{1,3}|X)\s*\/\s*(\d{1,3})$/i); // "3/6", or "X/6" for a miss
      if (f) {
        if (f[1].toUpperCase() === 'X') return { score: +f[2] + 1, display: `X/${f[2]}`, failed: true };
        return { score: +f[1], display: `${f[1]}/${f[2]}`, failed: false };
      }
      const money = raw.match(/^\$\s?(\d[\d,]*(?:\.\d{1,2})?)$/); // "$26.99"
      if (money) {
        const n = Number(money[1].replace(/,/g, ''));
        return { score: n, display: `$${n.toFixed(2)}`, failed: false };
      }
      const m = raw.match(/^([+-]?)(\d{1,5}(?:\.\d+)?)$/);
      if (!m) return { error: 'Enter your score, like 3, 3/6, $26.99, 72 or -2.' };
      const n = Number(m[1] === '-' ? -m[2] : m[2]);
      return { score: n, display: `${m[1] === '+' && n > 0 ? '+' : ''}${n}`, failed: false };
    },
    // Reads "$26.99 off" (Costcodle receipt), "3/6", "Score: 72", golf "-2" / "E", or a number on its own line.
    // Puzzle numbers like "#988" are recorded separately and never taken as the score.
    parse(t) {
      const pm = t.match(/(?:#|\bNo\.?\s*)(\d[\d,]*)/i);
      const puzzle = pm ? num(pm[1]) : null;
      const tries = [
        t.match(/(\$\s?\d[\d,]*(?:\.\d{1,2})?)\s+off\b/i), // Costcodle receipt: "$26.99 off the mark"
        t.match(/(?:^|\s)((?:\d{1,3}|X)\s*\/\s*\d{1,3})(?=\s|$)/im),
        t.match(/(?:score|total|final|strokes)\s*[:=]?\s*([+\-−]?\d{1,5}|E\b)/i),
        t.match(/(?:^|[\s(])([+\-−]\d{1,3}|E)(?=[\s)]|$)/m),
        t.match(/^\s*([+\-−]?\d{1,5})\s*$/m),
      ];
      for (const m of tries) {
        if (!m) continue;
        const v = m[1].replace('−', '-').replace(/\s+/g, '');
        const r = this.fromManual(v);
        if (!r.error) return { ...r, puzzle, manualValue: v };
      }
      return null;
    },
    formatAvg: (a) => (Math.round(a * 100) / 100).toString(),
  },
  time: {
    label: 'Time',
    hint: 'Fastest time wins',
    lowerIsBetter: true,
    manual: { type: 'text', label: 'Time (m:ss)', placeholder: '1:30' },
    fromManual(v) {
      const s = String(v ?? '').trim();
      let secs = null;
      const m = s.match(/^(\d{1,3}):([0-5]\d)$/);
      if (m) secs = +m[1] * 60 + +m[2];
      else if (/^\d+$/.test(s)) secs = +s;
      if (secs == null || secs <= 0) return { error: 'Enter your time like 1:05.' };
      return { score: secs, display: fmtTime(secs), failed: false };
    },
    parse(t) {
      const m = t.match(/(\d{1,3}):([0-5]\d)/);
      if (!m) return null;
      const v = `${+m[1]}:${m[2]}`;
      return { ...this.fromManual(v), puzzle: null, manualValue: v };
    },
    formatAvg: (a) => fmtTime(a),
  },
};

export const CUSTOM_COLORS = ['#d4a72c', '#3f9c8f', '#c25e8a', '#7a6fd1', '#5f8f3a', '#cc6f3c', '#3d7fb8', '#9b5fb0'];

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'web';
  }
}

export function makeCustomGame(d) {
  const k = SCORING[d.scoring] || SCORING.points;
  return {
    id: d.id,
    custom: true,
    name: d.name,
    maker: hostOf(d.url),
    url: d.url,
    blurb: `${k.hint}.`,
    color: d.color || CUSTOM_COLORS[0],
    lowerIsBetter: k.lowerIsBetter,
    manual: k.manual,
    fromManual: k.fromManual,
    parse: k.parse,
    formatAvg: k.formatAvg,
    createdAt: d.createdAt || 0,
  };
}

// Cleans up what someone typed in the "Add a game" form. Returns { url } or { error }.
export function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return { error: 'Paste the game’s link.' };
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) throw new Error();
    return { url: u.href };
  } catch {
    return { error: 'That doesn’t look like a web link.' };
  }
}
