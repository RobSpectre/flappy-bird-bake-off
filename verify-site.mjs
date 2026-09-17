// Run against a locally served tree: python3 -m http.server 8791, plus a headless Chrome
// on a debug port (`google-chrome --headless=new --remote-debugging-port=9222 ...`).
// Node only, no dependencies. Exits non-zero on any failed check.
//   BASE=http://localhost:8791 CDP_PORT=9222 node verify-site.mjs
// Verify the bake-off site: landing page + all three entries, over HTTP, in real Chrome.
// usage: node /tmp/verify-site.mjs   (needs Chrome on :9222 and a server on :8791)
const BASE = process.env.BASE || 'http://localhost:8791';
const PORT = Number(process.env.CDP_PORT) || 9222;
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = list.find((t) => t.type === 'page');
if (!target) { console.error('no page target'); process.exit(2); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalIn = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval threw');
  return r.result?.result?.value;
};
await send('Runtime.enable');
await send('Page.enable');

const NAV = async (url) => {
  await send('Page.navigate', { url });
  for (let i = 0; i < 80; i++) {
    await sleep(150);
    if (await evalIn(`document.readyState === 'complete' && !!document.body`).catch(() => false)) return;
  }
  throw new Error('timed out waiting for ' + url);
};

// distinct-colour probe over the FIRST canvas of the current document
const paint = `(() => {
  const cv = document.querySelector('canvas');
  if (!cv || typeof cv.getContext !== 'function') return { found: false };
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  const set = new Set();
  for (let i = 0; i < d.length; i += 4 * 97) set.add(d[i] + ',' + d[i+1] + ',' + d[i+2]);
  return { found: true, w: cv.width, h: cv.height, colours: set.size };
})()`;

console.log(`\n== ${BASE}/ (landing page) ==`);
await NAV(`${BASE}/`);
await sleep(1500);

check('landing: title names the bake-off', /Bake-Off/i.test(await evalIn('document.title')));
const cards = await evalIn(`[...document.querySelectorAll('.card')].map(c => ({
  name: c.querySelector('h2').textContent.trim().toUpperCase(),
  href: c.querySelector('.cta').getAttribute('href'),
  iframe: c.querySelector('iframe')?.getAttribute('src') || null,
  frameH: Math.round(c.querySelector('iframe').getBoundingClientRect().height),
  cardH: Math.round(c.getBoundingClientRect().height)
}))`);
check('landing: three cards', cards.length === 3, `got ${cards.length}`);
for (const want of [['CLAUDE', 'claude/index.html'], ['CODEX', 'codex/index.html'], ['HERMES', 'hermes/index.html']]) {
  const got = cards.find((c) => c.name === want[0]);
  check(`landing: card ${want[0]} links to and embeds ${want[1]}`, !!got && got.href === want[1] && got.iframe === want[1], JSON.stringify(got));
}
check('landing: no horizontal overflow at 1280', await evalIn('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1'));

// The three cards must line up: same bar height, same play-area top, same button top, same card height.
for (const w of [1360, 1180, 1100, 1040]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 1200, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  const align = await evalIn(`(() => {
    const one = (sel) => [...document.querySelectorAll('.card')].map(c => Math.round(c.querySelector(sel).getBoundingClientRect().top));
    const heights = [...document.querySelectorAll('.card')].map(c => Math.round(c.getBoundingClientRect().height));
    const spread = (a) => Math.max(...a) - Math.min(...a);
    return { stageTop: one('.stage'), spread: spread(one('.stage')) + spread(one('.cta')) + spread(heights), cardHeights: heights };
  })()`);
  check(`landing: cards line up at ${w}px (stages, buttons and heights within 1px)`, align.spread <= 3, JSON.stringify(align));
}
// Regression guard for the embedding case: in a frame narrow enough to stack the cards
// (<=1000px), every preview must still have loaded, even the ones below the frame's fold.
// With loading="lazy" those two sit blank forever, which is what an OBS browser source sized
// 900x700 or a narrow blog iframe sees.
await send('Emulation.setDeviceMetricsOverride', { width: 960, height: 700, deviceScaleFactor: 1, mobile: false });
await sleep(2500);
const stacked = await evalIn(`[...document.querySelectorAll('.card iframe')].map((f) => {
  const d = f.contentDocument;
  const cv = d && d.querySelector('canvas');
  const r = f.getBoundingClientRect();
  return { entry: f.dataset.entry, offscreenInFrame: r.top > window.innerHeight, loaded: !!cv, canvas: cv ? cv.width + 'x' + cv.height : null };
})`);
check('landing: all three previews load in a 960x700 frame, including the off-screen ones',
  stacked.length === 3 && stacked.every((s) => s.loaded),
  JSON.stringify(stacked));
console.log('    off-screen previews: ' + stacked.filter((s) => s.offscreenInFrame).map((s) => s.entry + ':loaded=' + s.loaded).join(' ') || '    (none off-screen)');
await send('Emulation.clearDeviceMetricsOverride');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
await sleep(400);
await NAV(`${BASE}/`);
await sleep(1500);

// Every embedded frame must be showing its game, measured in ONE coordinate space:
// the frame's own viewport, which is what the reader sees.
const frames = await evalIn(`[...document.querySelectorAll('.card iframe')].map(f => {
  const win = f.contentWindow, doc = f.contentDocument;
  const fr = f.getBoundingClientRect();
  const cv = doc.querySelector('canvas');
  const cvr = cv ? cv.getBoundingClientRect() : null;
  const scene = doc.querySelector('.fallback-scene');
  const scr = scene ? scene.getBoundingClientRect() : null;
  const art = cvr && cvr.width > 100 ? cvr : scr;   // whichever renderer is on screen
  const scrollbar = win.innerWidth - doc.documentElement.clientWidth;
  return {
    hasCanvas: !!cv,
    logical: cv ? cv.width + 'x' + cv.height : null,
    artBox: art ? [Math.round(art.left), Math.round(art.top), Math.round(art.width), Math.round(art.height)] : null,
    artFullyVisible: art ? (art.top >= -1 && art.bottom <= win.innerHeight + 1 && art.left >= -1 && art.right <= win.innerWidth + 1) : false,
    frameIs288x512: Math.round(fr.width) === 288 && Math.round(fr.height) === 512,
    innerScrollbar: scrollbar,
    hook: cv ? (typeof win.__flappy === 'object' || typeof win.__skylineFlap === 'object') : false
  };
})`);
check('landing: three iframes mounted', frames.length === 3, `got ${frames.length}`);
frames.forEach((f, i) => {
  check(`landing: frame ${i + 1} is 288x512`, f.frameIs288x512, JSON.stringify(f));
  check(`landing: frame ${i + 1} shows its play area fully inside the frame`, f.artFullyVisible, JSON.stringify(f.artBox));
  check(`landing: frame ${i + 1} exposes the game's debug hook`, f.hook);
  check(`landing: frame ${i + 1} has no scrollbar`, f.innerScrollbar === 0, `scrollbar=${f.innerScrollbar}`);
});

// the two purpose-built game pages paint; codex's shipped entry does not (documented below)
const painted = await evalIn(`[...document.querySelectorAll('.card iframe')].map(f => {
  const doc = f.contentDocument, win = f.contentWindow;
  const cv = doc.querySelector('canvas');
  if (!cv || typeof cv.getContext !== 'function') return { paint: 'no ctx', hook: false };
  if (typeof cv.getContext('2d') !== 'object' || cv.getContext('2d') === null) return { paint: 'ctx null', hook: false };
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  return { paint: 'ctx', hasCtxMethod: true };
})`).catch((e) => 'threw: ' + e.message);
console.log('    frame canvas capability:', JSON.stringify(painted));

console.log('\n== narrow viewport (420x900) ==');
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(700);
check('landing: no horizontal overflow at 420', await evalIn('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1'),
  `scrollW=${await evalIn('document.documentElement.scrollWidth')} clientW=${await evalIn('document.documentElement.clientWidth')}`);
check('landing: cards stack to one column at 420', await evalIn(`new Set([...document.querySelectorAll('.card')].map(c => Math.round(c.getBoundingClientRect().top))).size === 3`));
await send('Emulation.clearDeviceMetricsOverride');

// per-entry expectations, taken from what each entry actually ships
const entries = {
  claude: { logical: '288x512', hook: '__flappy', paints: true },
  codex: { logical: '360x640', hook: '__skylineFlap', paints: false },
  hermes: { logical: '288x512', hook: '__flappy', paints: true }
};
for (const [dir, want] of Object.entries(entries)) {
  console.log(`\n== ${BASE}/${dir}/ ==`);
  await NAV(`${BASE}/${dir}/`);
  await sleep(1000);
  const p = await evalIn(paint);
  check(`${dir}: canvas is ${want.logical}`, p.found && p.w + 'x' + p.h === want.logical, JSON.stringify(p));
  check(`${dir}: ${want.hook} debug hook present`, (await evalIn(`typeof window.${want.hook}`)) === 'object');
  const state = await evalIn(`(() => { const h = window.${want.hook}; return typeof h.state === 'function' ? h.state() : h.state; })()`);
  check(`${dir}: boot state is ready`, state === 'ready', String(state));
  check(`${dir}: canvas ${want.paints ? 'paints (>50 colours)' : 'is not painted by the shipped entry (known defect)'}`,
    want.paints ? p.colours > 50 : p.colours <= 2, `colours=${p.colours}`);
  const rect = await evalIn(`(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  check(`${dir}: canvas scaled to fill a desktop window`, rect.w >= 288 && rect.h >= 512, JSON.stringify(rect));
  // codex keeps its canvas blank, so its visible renderer must be the DOM fallback
  const visible = await evalIn(`(() => {
    const s = document.querySelector('.fallback-scene');
    if (!s) return 'no fallback scene';
    return getComputedStyle(s).display !== 'none' && s.getBoundingClientRect().height > 100 ? 'fallback on screen' : 'fallback hidden';
  })()`);
  if (!want.paints) check(`${dir}: DOM fallback scene is what renders`, visible === 'fallback on screen', visible);
}

check('no console errors / uncaught exceptions across the whole run', errors.length === 0, errors.slice(0, 5).join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
ws.close();
process.exit(fail === 0 ? 0 : 1);
