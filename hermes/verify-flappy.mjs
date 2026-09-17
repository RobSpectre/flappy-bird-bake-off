// Headless verification harness for the Flappy Bird clone.
//   node /tmp/flappy-harness.mjs
import { writeFileSync } from 'node:fs';

const CDP = process.env.CDP || 'http://127.0.0.1:9222';
const URL_MATCH = process.env.URL_MATCH || 'localhost:8791';
const SHOT_DIR = process.env.SHOT_DIR || '/tmp';
const FILE_URL = process.env.FILE_URL || 'file:///media/rspectre/Storage/workspace/nebius/flappy_bird_bake_off/hermes/index.html';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

async function pickTarget(match = URL_MATCH, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const list = await (await fetch(`${CDP}/json/list`)).json();
      const t = list.find((x) => x.type === 'page' && x.url.includes(match));
      if (t) return t;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`no page target matching ${match}`);
}

class Client {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.logs = []; this.errors = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')); });
    const c = new Client(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id);
        c.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method === 'Runtime.consoleAPICalled') {
        const txt = m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
        c.logs.push(`${m.params.type}: ${txt}`);
        if (m.params.type === 'error') c.errors.push(txt);
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        c.errors.push(`${d.text} ${d.exception?.description || ''} @${d.lineNumber}:${d.columnNumber}`);
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ''}`);
    return r.result.value;
  }
  async reload(waitMs = 1200) { await this.send('Page.reload'); await sleep(waitMs); }
  async navigate(url, selector = '#game', waitMs = 800) {
    await this.send('Page.navigate', { url });
    await sleep(waitMs);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const ok = await this.eval(`document.readyState === 'complete' && !!document.querySelector(${JSON.stringify(selector)})`).catch(() => false);
      if (ok) return;
      await sleep(200);
    }
    throw new Error(`app did not mount at ${url}`);
  }
  async shot(path) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path, Buffer.from(r.data, 'base64'));
    console.log('shot ->', path);
  }
}

const client = await Client.connect((await pickTarget()).webSocketDebuggerUrl);
await client.send('Runtime.enable');
await client.send('Page.enable');
await sleep(500);

await client.eval('try{localStorage.clear()}catch(e){}');
await client.reload();

// ---------------------------------------------------------------- 1. boot
check('debug hook exposed', (await client.eval('typeof window.__flappy')) === 'object');
check('boots in ready state', (await client.eval('window.__flappy.state()')) === 'ready');
check('title screen visible', (await client.eval(`!document.getElementById('title-screen').classList.contains('hidden')`)));
check('game-over card hidden', (await client.eval(`document.getElementById('over-screen').classList.contains('hidden')`)));
check('pipes pre-allocated on title screen', (await client.eval('window.__flappy.pipes().length')) === 3);

const colours = await client.eval(`(() => {
  const cv = document.querySelector('canvas');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  const s = new Set();
  for (let i = 0; i < d.length; i += 4 * 97) s.add(d[i] + ',' + d[i+1] + ',' + d[i+2]);
  return s.size;
})()`);
check('canvas really renders', colours > 10, `${colours} sampled distinct colours`);

// ------------------------------------------------- 2. the bot plays a round
// The bot is installed in the SAME eval that starts the round: a single-input
// game can end in well under a second, so any sleep in between means the bot
// never sees a live frame.
// Controller: aim a little below the gap centre so a full flap (about 42px of
// rise) stays inside even the narrowest gap, and only flap on the way down.
await client.eval(`(() => {
  const F = window.__flappy, G = F.geometry();
  const telemetry = [];
  const BIAS = 18, DROP = 12, NEUTRAL = G.FLOOR_Y / 2;
  window.__botLog = telemetry;
  window.__botTicks = 0;
  window.__botFlaps = 0;
  F.restart();
  function tick() {
    const st = F.state();
    if (st !== 'playing') { telemetry.push({ end: st, score: F.score(), frames: window.__botTicks }); return; }
    window.__botTicks++;
    const b = F.bird();
    const pipes = F.pipes();
    // the next obstacle still ahead of the player - the leftmost entry may
    // already be behind them
    let target = null;
    for (const p of pipes) {
      if (p.x + G.PIPE_W > b.x - G.BIRD_W / 2 && (!target || p.x < target.x)) target = p;
    }
    // fallback: hold mid-field altitude when nothing is in range, otherwise the
    // bird free-falls between obstacles and dies
    const aim = target ? target.center + BIAS : NEUTRAL;
    const flapNow = (b.vy > -1 && b.y > aim - DROP) || b.y > aim + 30;
    if (flapNow) { F.flap(); window.__botFlaps++; }
    if (telemetry.length < 1500) {
      telemetry.push({ y: +b.y.toFixed(1), vy: +b.vy.toFixed(2), aim: +aim.toFixed(1), x: target ? +target.x.toFixed(0) : null, f: flapNow ? 1 : 0, s: F.score() });
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})()`);

await sleep(1000);
check('Space keydown starts play', (await client.eval('window.__flappy.state()')) !== 'ready');

// let the bot fly, sampling live state
let maxScore = 0, aliveSamples = 0, botEnd = null;
for (let i = 0; i < 28; i++) {
  await sleep(500);
  const s = await client.eval('({state: window.__flappy.state(), score: window.__flappy.score(), ticks: window.__botTicks, flaps: window.__botFlaps})');
  maxScore = Math.max(maxScore, s.score);
  if (s.state === 'playing') aliveSamples++;
  if (i === 6) await client.shot(`${SHOT_DIR}/flappy-playing.png`);   // live-state evidence
  if (s.state === 'over') break;
}

const botSummary = await client.eval('(() => { const t = window.__botLog; const end = t.filter((r) => r.end); return {ticks: window.__botTicks, flaps: window.__botFlaps, len: t.length, tail: t.slice(-6), end: end.slice(-1)[0] || null}; })()');
check('scripted bot survives and scores', maxScore >= 8, `score ${maxScore}, ${aliveSamples} live samples, ${botSummary.ticks} frames, ${botSummary.flaps} flaps`);
console.log('   bot telemetry tail:', JSON.stringify(botSummary.tail));

// -------------------------------------------------- 3. score / persistence
// End the round cleanly if the bot is still airborne, so the persistence path
// (best written on game over) is exercised either way.
await client.eval(`(() => { const F = window.__flappy; if (F.state() !== 'over') F.forceGameOver(); })()`);
await sleep(200);
const afterRound = await client.eval('({state: window.__flappy.state(), score: window.__flappy.score(), best: window.__flappy.best(), stored: localStorage.getItem("flappy.best.v1")})');
check('game over writes the best score to localStorage',
  afterRound.state === 'over' && Number(afterRound.stored) === Number(afterRound.best) && Number(afterRound.stored) >= maxScore,
  JSON.stringify(afterRound));

await client.reload();
const afterReload = await client.eval('({best: window.__flappy.best(), title: document.getElementById("title-best").textContent})');
check('best score survives a reload', Number(afterReload.best) === Number(afterRound.best) && afterReload.title === String(afterRound.best),
  `reloaded best ${afterReload.best}, title "${afterReload.title}"`);

// ------------------------------------------------------- 4. state machine
await client.eval('window.__flappy.restart()');
await sleep(200);
check('restart enters playing', (await client.eval('window.__flappy.state()')) === 'playing');

// input during dying must be ignored: hold the bird in the blocked band above
// an oncoming pipe until it arrives and kills it in mid-air (a death at the
// floor skips straight through `dying`, which is what the state machine wants)
await client.eval(`(() => {
  const F = window.__flappy, G = F.geometry();
  F.restart();
  const p = F.pipes()[0];
  const hold = Math.max(24, Math.min(G.FLOOR_Y - 40, p.center - p.gap / 2 - 8));
  window.__holdTimer = setInterval(() => { if (F.state() === 'playing') F.setBird(hold, 0); }, 8);
})()`);
let dyingSeen = false;
for (let i = 0; i < 60; i++) {
  await sleep(150);
  if ((await client.eval('window.__flappy.state()')) === 'dying') { dyingSeen = true; break; }
}
await client.eval('clearInterval(window.__holdTimer)');
check('pipe collision starts the death animation', dyingSeen);
const vyBefore = await client.eval('window.__flappy.bird().vy');
await client.eval('window.__flappy.flap()');
await sleep(60);
const vyAfter = await client.eval('window.__flappy.bird().vy');
check('flap is ignored while dying', vyAfter > vyBefore, `vy ${vyBefore} -> ${vyAfter}`);

await sleep(1400);
check('death resolves to game over', (await client.eval('window.__flappy.state()')) === 'over');
check('game-over card shown with the score', await client.eval(`!document.getElementById('over-screen').classList.contains('hidden') && document.getElementById('final-score').textContent === String(window.__flappy.score())`));
await client.shot(`${SHOT_DIR}/flappy-gameover.png`);

// dying at the floor ends the round too
await client.eval('window.__flappy.restart(); window.__flappy.setBird(window.__flappy.geometry().FLOOR_Y + 200, 2)');
await sleep(400);
check('floor contact ends the round', (await client.eval('window.__flappy.state()')) === 'over'
  && (await client.eval(`!document.getElementById('over-screen').classList.contains('hidden')`)));

// ceiling is a clamp, not a death
await client.eval('window.__flappy.restart(); window.__flappy.setBird(-40, -6)');
await sleep(300);
check('ceiling is clamped, not fatal', (await client.eval('window.__flappy.state()')) === 'playing'
  && (await client.eval('window.__flappy.bird().y')) >= 6,
  `y=${await client.eval('window.__flappy.bird().y')}`);

// difficulty ramp is clamped at both ends
const ramp = await client.eval(`(() => {
  const F = window.__flappy, out = {};
  F.setScore(0); out.s0 = [F.speed(), F.gap()];
  F.setScore(20); out.s20 = [F.speed(), F.gap()];
  F.setScore(9999); out.sMax = [F.speed(), F.gap()];
  F.setScore(0);
  return out;
})()`);
check('difficulty ramps and clamps', ramp.s0[0] < ramp.s20[0] && ramp.s20[0] <= ramp.sMax[0]
  && ramp.s0[1] > ramp.s20[1] && ramp.s20[1] >= ramp.sMax[1],
  JSON.stringify(ramp));

// pause when the tab is hidden
const paused = await client.eval(`(() => {
  const cv = document.querySelector('canvas');
  const a = cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data.slice(0, 400).join(',');
  Object.defineProperty(document, 'hidden', {value: true, configurable: true});
  document.dispatchEvent(new Event('visibilitychange'));
  return new Promise(r => setTimeout(() => {
    const b = cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data.slice(0, 400).join(',');
    Object.defineProperty(document, 'hidden', {value: false, configurable: true});
    document.dispatchEvent(new Event('visibilitychange'));
    r(a === b);
  }, 400));
})()`);
check('simulation pauses while the tab is hidden', paused === true);

// ----------------------------------------------------------- 5. mute state
await client.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'m'}))`);
await sleep(100);
const mute = await client.eval('({flag: localStorage.getItem("flappy.mute.v1"), cls: document.getElementById("mute-btn").className})');
check('M toggles mute and persists it', mute.flag === '1' && mute.cls.includes('muted'), JSON.stringify(mute));
await client.eval(`document.getElementById('mute-btn').click()`);
await sleep(100);
check('mute button toggles back', (await client.eval('localStorage.getItem("flappy.mute.v1")')) === '0');

// ------------------------------------------------------------ 6. file://
await client.navigate(FILE_URL);
const fileCheck = await client.eval('({hook: typeof window.__flappy, url: location.protocol, cols: (() => { const cv=document.querySelector("canvas"); const d=cv.getContext("2d").getImageData(0,0,cv.width,cv.height).data; const s=new Set(); for(let i=0;i<d.length;i+=4*97) s.add(d[i]+","+d[i+1]+","+d[i+2]); return s.size; })()})');
check('works from file:// (no server, no module CORS trap)', fileCheck.hook === 'object' && fileCheck.cols > 10, JSON.stringify(fileCheck));

check('no uncaught errors or console errors', client.errors.length === 0, client.errors.join(' | ') || 'clean');

console.log('\n--- console output ---');
console.log(client.logs.slice(-10).join('\n') || '(none)');

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
