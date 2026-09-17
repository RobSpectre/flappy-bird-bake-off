// Run against a locally served tree: python3 -m http.server 8791, plus a headless Chrome
// on a debug port (`google-chrome --headless=new --remote-debugging-port=9222 ...`).
// Node only, no dependencies. Exits non-zero on any failed check.
//   BASE=http://localhost:8791 CDP_PORT=9222 node verify-play.mjs
// Play each entry over HTTP with a scripted bot, and screenshot the landing page + each game mid-run.
const BASE = process.env.BASE || 'http://localhost:8791';
const PORT = Number(process.env.CDP_PORT) || 9222;
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { if (ok) { pass++; console.log(`PASS  ${n}`); } else { fail++; console.log(`FAIL  ${n}${d ? ' — ' + d : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = await import('node:fs');

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const t = list.find((x) => x.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pending = new Map(); const errs = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) return 'THREW: ' + (r.result.exceptionDetails.exception?.description || '').split('\n')[0]; return r.result?.result?.value; };
const shot = async (path) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path, Buffer.from(r.result.data, 'base64')); };
const nav = async (url) => { await send('Page.navigate', { url }); for (let i = 0; i < 80; i++) { await sleep(150); if (await ev(`document.readyState === 'complete'`)) return; } };
await send('Runtime.enable'); await send('Page.enable');
// Load a blank page first: any page a previous harness run left loaded may still be holding a
// stale setInterval that throws, and those exceptions would be attributed to this run.
await nav('about:blank');
await sleep(400);
errs.length = 0;

// Every entry exposes a debug hook, but the contract is loose: Claude's state/score/bird are
// accessors, Hermes' are functions. Read either shape. Skyline Flap has no bird accessor at all,
// so its bot reads the geometry of the DOM fallback scene it actually renders with.
const PRELUDE = `
  const hook = () => window.__flappy || window.__skylineFlap;
  const get = (o, k) => (typeof o[k] === 'function' ? o[k]() : o[k]);
  const pipeCentre = (p) => (p.center != null ? p.center : p.top + p.gap / 2);
`;
const BOT = {
  claude: `(() => { ${PRELUDE}
    const h = hook();
    setInterval(() => {
      const st = get(h, 'state');
      if (st !== 'playing') { if (st === 'over') h.restart(); return; }
      const b = get(h, 'bird'), ps = get(h, 'pipes');
      const next = ps.filter((p) => p.x + 60 > b.x).sort((a, c) => a.x - c.x)[0];
      if (next && b.y > pipeCentre(next) + 4) h.flap();
    }, 16);
  })()`,
  hermes: `(() => { ${PRELUDE}
    const h = hook();
    setInterval(() => {
      const st = get(h, 'state');
      if (st !== 'playing') { if (st === 'over') h.restart(); return; }
      const b = get(h, 'bird'), ps = get(h, 'pipes');
      const next = ps.filter((p) => p.x + 60 > b.x).sort((a, c) => a.x - c.x)[0];
      if (next && b.y > pipeCentre(next) + 4) h.flap();
    }, 16);
  })()`,
  codex: `(() => { ${PRELUDE}
    const h = hook();
    const scene = document.querySelector('.fallback-scene');
    if (!scene) return 'no scene';
    setInterval(() => {
      const st = get(h, 'state');
      if (st !== 'playing') { if (st === 'over') h.restart(); return; }
      const sr = scene.getBoundingClientRect();
      const bird = scene.querySelector('.fallback-bird').getBoundingClientRect();
      const top = scene.querySelector('.fallback-pipe-top').getBoundingClientRect();
      const bottom = scene.querySelector('.fallback-pipe-bottom').getBoundingClientRect();
      const birdY = bird.top + bird.height / 2 - sr.top;
      const centre = (top.bottom + bottom.top) / 2 - sr.top;
      if (birdY > centre + 4) h.flap();
    }, 16);
  })()`
};

for (const dir of ['claude', 'codex', 'hermes']) {
  console.log(`\n== ${BASE}/${dir}/ — bot run ==`);
  await nav(`${BASE}/${dir}/`);
  await sleep(1200);
  const started = await ev(`(() => { const h = window.__flappy || window.__skylineFlap;
    const get = (o,k) => (typeof o[k] === 'function' ? o[k]() : o[k]);
    if (typeof h.start === 'function') h.start(); else if (typeof h.flap === 'function') h.flap();
    return get(h, 'state'); })()`);
  check(`${dir}: run starts`, started === 'playing', String(started));
  const bot = await ev(BOT[dir]);
  if (typeof bot === 'string' && bot.startsWith('THREW')) check(`${dir}: bot installed`, false, bot);
  let peak = 0, last = '';
  for (let i = 0; i < 14; i++) {
    await sleep(1000);
    const s = await ev(`(() => { const h = window.__flappy || window.__skylineFlap;
      const get = (o,k) => (typeof o[k] === 'function' ? o[k]() : o[k]);
      return JSON.stringify({ score: get(h,'score'), state: get(h,'state') }); })()`);
    const o = JSON.parse(s);
    last = s;
    if (o.score > peak) peak = o.score;
    if (i === 3) await shot(`/tmp/play-${dir}.png`);
  }
  check(`${dir}: bot survives and scores (peak ${peak})`, peak >= 1, `last=${last}`);
}

console.log('\n== landing page screenshot ==');
await send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 1180, deviceScaleFactor: 1, mobile: false });
await nav(`${BASE}/`);
await sleep(2500);
await shot('/tmp/landing.png');
console.log('screenshot: /tmp/landing.png');
await send('Emulation.clearDeviceMetricsOverride');
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 1500, deviceScaleFactor: 1, mobile: true });
await sleep(1500);
await shot('/tmp/landing-narrow.png');
console.log('screenshot: /tmp/landing-narrow.png');

check('no uncaught exceptions across the bot runs', errs.length === 0, errs.slice(0, 3).join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
ws.close();
process.exit(fail ? 1 : 0);
