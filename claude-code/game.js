/* Flappy Bird — Claude Code
 *
 * Everything is drawn procedurally (no image assets) into a 400x640 logical
 * canvas. The backing store is resized to match devicePixelRatio so the vector
 * art stays crisp when CSS scales the canvas up.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------- constants

  const W = 400;              // logical canvas width
  const H = 640;              // logical canvas height
  const GROUND_H = 96;
  const PLAY_H = H - GROUND_H; // playable column height

  const CFG = {
    gravity:  1900,   // px/s^2
    flap:     -520,   // px/s, instantaneous impulse
    maxFall:   780,   // terminal velocity
    birdX:      96,
    birdR:      13,
    pipeW:      62,
    capH:       26,
    capOut:      5,   // how far the cap overhangs each side of the pipe body
    edgeMargin: 58,   // min distance from ceiling/ground to a gap edge
  };

  const STATE = { READY: 'ready', PLAYING: 'playing', DYING: 'dying', OVER: 'over' };
  const STEP = 1 / 120;       // fixed physics timestep (s)
  const BEST_KEY = 'flappy.claude-code.best';

  // Enabled with ?debug — exposes internals on window.flappy for inspection
  // and automated play-testing. Off by default, costs one boolean per frame.
  const DEBUG = { on: false, god: false };

  /**
   * The difficulty curve.
   *
   * Returns the pipe geometry for a given score. `spacing` is the horizontal
   * distance between consecutive pipes, so spacing/speed is the time the player
   * gets between obstacles — growing both together keeps the rhythm playable
   * while the window itself gets meaner.
   */
  function difficultyAt(score) {
    const t = clamp(score / 25, 0, 1);   // ramp over the first 25 points
    return {
      gap:     lerp(172, 128, t),
      speed:   lerp(155, 225, t),
      spacing: lerp(215, 262, t),
    };
  }

  /** Medal thresholds, highest first. */
  const MEDALS = [
    { at: 40, name: 'platinum', a: '#e8f4ff', b: '#9bb6cc' },
    { at: 30, name: 'gold',     a: '#ffe98a', b: '#d19b22' },
    { at: 20, name: 'silver',   a: '#f0f2f5', b: '#98a3ad' },
    { at: 10, name: 'bronze',   a: '#f0b787', b: '#a9612c' },
  ];

  // ------------------------------------------------------------------- helpers

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp  = (a, b, t) => a + (b - a) * t;
  const rand  = (a, b) => a + Math.random() * (b - a);
  const easeOut = t => 1 - Math.pow(1 - t, 3);

  function circleHitsRect(cx, cy, r, rx, ry, rw, rh) {
    const nx = clamp(cx, rx, rx + rw);
    const ny = clamp(cy, ry, ry + rh);
    const dx = cx - nx, dy = cy - ny;
    return dx * dx + dy * dy < r * r;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,     x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x,     y + h, r);
    ctx.arcTo(x,     y + h, x,     y,     r);
    ctx.arcTo(x,     y,     x + w, y,     r);
    ctx.closePath();
  }

  // --------------------------------------------------------------------- audio

  // Tiny WebAudio blip synth — no asset loading, no autoplay warnings, because
  // the context is only created inside the first real user gesture.
  const Sound = {
    ctx: null,
    muted: false,

    unlock() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) this.ctx = new AC();
      }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },

    tone(freq, endFreq, dur, type, vol) {
      if (this.muted || !this.ctx) return;
      const t0 = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      osc.frequency.exponentialRampToValueAtTime(Math.max(endFreq, 1), t0 + dur);
      gain.gain.setValueAtTime(vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    },

    flap()  { this.tone(620, 320, 0.10, 'square',   0.05); },
    score() { this.tone(880, 880, 0.07, 'triangle', 0.07);
              setTimeout(() => this.tone(1320, 1320, 0.10, 'triangle', 0.07), 70); },
    hit()   { this.tone(240, 60,  0.22, 'sawtooth', 0.10); },
    fall()  { this.tone(420, 70,  0.45, 'sine',     0.06); },
  };

  // ---------------------------------------------------------------- canvas set

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const rect = canvas.getBoundingClientRect();
    const cssW = rect.width || W;
    const cssH = rect.height || H;
    canvas.width  = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    // One transform maps the whole 400x640 logical space onto the real pixels,
    // so every draw call below can pretend the canvas is exactly 400x640.
    const s = (cssW / W) * dpr;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.imageSmoothingEnabled = true;
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  // ---------------------------------------------------------------- game state

  let state, bird, pipes, clouds, bushes, feathers, popups;
  let groundScroll, cloudScroll, bushScroll;
  let score, best, isNewBest, shake, flash, overAnim, readyTime;

  best = loadBest();

  function loadBest() {
    try { return parseInt(localStorage.getItem(BEST_KEY), 10) || 0; }
    catch { return 0; }
  }
  function saveBest(v) {
    try { localStorage.setItem(BEST_KEY, String(v)); } catch { /* private mode */ }
  }

  function reset() {
    state = STATE.READY;
    bird = { y: PLAY_H * 0.42, v: 0, angle: 0, flapT: 0, wing: 0 };
    pipes = [];
    feathers = [];
    popups = [];
    score = 0;
    isNewBest = false;
    shake = 0;
    flash = 0;
    overAnim = 0;
    readyTime = 0;
  }

  function initScenery() {
    clouds = [];
    for (let i = 0; i < 6; i++) {
      clouds.push({ x: rand(0, W), y: rand(40, 220), s: rand(0.55, 1.15), o: rand(0.35, 0.8) });
    }
    bushes = [];
    for (let i = 0; i < 12; i++) {
      bushes.push({ x: rand(0, W), r: rand(26, 52), o: rand(0.5, 1) });
    }
    groundScroll = cloudScroll = bushScroll = 0;
  }

  initScenery();
  reset();

  // -------------------------------------------------------------------- input

  function flap() {
    Sound.unlock();

    if (state === STATE.READY) {
      state = STATE.PLAYING;
      spawnPipe(W + 80);
    }
    if (state === STATE.PLAYING) {
      bird.v = CFG.flap;
      bird.flapT = 0.24;
      Sound.flap();
    } else if (state === STATE.OVER && overAnim > 0.55) {
      // Small delay before restart is accepted, so the click that killed you
      // doesn't immediately restart the run.
      reset();
    }
  }

  let paused = false;

  canvas.addEventListener('pointerdown', e => { e.preventDefault(); flap(); });
  window.addEventListener('keydown', e => {
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
      e.preventDefault();
      flap();
    } else if (e.code === 'KeyM') {
      Sound.muted = !Sound.muted;
    } else if (e.code === 'KeyP') {
      paused = !paused;
    }
  });
  // Losing focus mid-flight would otherwise dump one giant timestep on resume.
  window.addEventListener('blur', () => { if (state === STATE.PLAYING) paused = true; });

  // -------------------------------------------------------------------- pipes

  function spawnPipe(x) {
    const { gap } = difficultyAt(score);
    const half = gap / 2;
    const centre = rand(CFG.edgeMargin + half, PLAY_H - CFG.edgeMargin - half);
    pipes.push({
      x,
      top: centre - half,      // y of the top pipe's lower edge
      bottom: centre + half,   // y of the bottom pipe's upper edge
      scored: false,
    });
  }

  function updatePipes(dt) {
    const { speed, spacing } = difficultyAt(score);

    for (const p of pipes) p.x -= speed * dt;

    // Spawn by distance rather than on a timer: changing `speed` then never
    // desynchronises the gap rhythm.
    const last = pipes[pipes.length - 1];
    if (!last || last.x < W - spacing) spawnPipe(W);

    while (pipes.length && pipes[0].x + CFG.pipeW < -20) pipes.shift();

    for (const p of pipes) {
      if (!p.scored && p.x + CFG.pipeW * 0.5 < CFG.birdX) {
        p.scored = true;
        score++;
        popups.push({ y: 0, life: 1 });
        Sound.score();
      }
    }
  }

  function collides() {
    if (DEBUG.god) return false;
    const r = CFG.birdR - 2;  // a couple of forgiving pixels
    for (const p of pipes) {
      if (p.x > CFG.birdX + r || p.x + CFG.pipeW < CFG.birdX - r) continue;
      if (circleHitsRect(CFG.birdX, bird.y, r, p.x, -100, CFG.pipeW, p.top + 100)) return true;
      if (circleHitsRect(CFG.birdX, bird.y, r, p.x, p.bottom, CFG.pipeW, PLAY_H - p.bottom + 100)) return true;
    }
    return false;
  }

  function die() {
    state = STATE.DYING;
    shake = 1;
    flash = 1;
    Sound.hit();
    setTimeout(() => Sound.fall(), 120);
    for (let i = 0; i < 10; i++) {
      feathers.push({
        x: CFG.birdX, y: bird.y,
        vx: rand(-90, 40), vy: rand(-200, -40),
        rot: rand(0, Math.PI * 2), vr: rand(-6, 6), life: 1,
      });
    }
    if (score > best) { best = score; isNewBest = true; saveBest(best); }
  }

  // ------------------------------------------------------------------- update

  function update(dt) {
    // Scenery keeps drifting on every screen — a frozen menu looks dead.
    const sceneSpeed = state === STATE.PLAYING ? difficultyAt(score).speed : 120;
    cloudScroll += sceneSpeed * 0.12 * dt;
    bushScroll  += sceneSpeed * 0.32 * dt;
    if (state === STATE.PLAYING || state === STATE.READY) groundScroll += sceneSpeed * dt;

    shake = Math.max(0, shake - dt * 3);
    flash = Math.max(0, flash - dt * 4);

    for (const f of feathers) {
      f.vy += 900 * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.rot += f.vr * dt;
      f.life -= dt * 0.8;
    }
    feathers = feathers.filter(f => f.life > 0);

    for (const p of popups) { p.y -= 60 * dt; p.life -= dt * 1.6; }
    popups = popups.filter(p => p.life > 0);

    if (state === STATE.READY) {
      readyTime += dt;
      bird.y = PLAY_H * 0.42 + Math.sin(readyTime * 3.4) * 9;
      bird.angle = Math.sin(readyTime * 3.4) * 0.12;
      bird.wing = (bird.wing + dt * 9) % (Math.PI * 2);
      return;
    }

    if (state === STATE.OVER) {
      overAnim = Math.min(1, overAnim + dt * 2.4);
      return;
    }

    // --- PLAYING / DYING share the same ballistics -------------------------
    bird.v = Math.min(bird.v + CFG.gravity * dt, CFG.maxFall);
    bird.y += bird.v * dt;

    if (bird.flapT > 0) bird.flapT = Math.max(0, bird.flapT - dt);

    // Nose up quickly on a flap, tip over slowly on the way down.
    const target = bird.v < 0 ? -0.5 : clamp(bird.v / CFG.maxFall, 0, 1) * 1.45;
    const rate = bird.v < 0 ? 14 : 5;
    bird.angle += (target - bird.angle) * Math.min(1, rate * dt);

    if (state === STATE.PLAYING) {
      // The ceiling bumps you instead of killing you, as in the original.
      if (bird.y < CFG.birdR) { bird.y = CFG.birdR; bird.v = Math.max(bird.v, 0); }

      updatePipes(dt);

      if (collides()) { die(); return; }
      if (bird.y + CFG.birdR >= PLAY_H) { bird.y = PLAY_H - CFG.birdR; die(); }
    } else {
      // DYING: tumble until the ground stops us.
      if (bird.y + CFG.birdR >= PLAY_H) {
        bird.y = PLAY_H - CFG.birdR;
        bird.v = 0;
        bird.angle = 1.55;
        state = STATE.OVER;
      }
    }
  }

  // ------------------------------------------------------------------ drawing

  function drawSky() {
    const g = ctx.createLinearGradient(0, 0, 0, PLAY_H);
    g.addColorStop(0,    '#4ec0ca');
    g.addColorStop(0.55, '#7ad4dc');
    g.addColorStop(1,    '#c3ecef');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, PLAY_H);

    // sun
    ctx.fillStyle = 'rgba(255,248,214,.55)';
    ctx.beginPath();
    ctx.arc(W - 72, 78, 34, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawCloud(x, y, s, o) {
    ctx.save();
    ctx.globalAlpha = o;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x,            y,            22 * s, 0, Math.PI * 2);
    ctx.arc(x + 24 * s,   y + 6 * s,    17 * s, 0, Math.PI * 2);
    ctx.arc(x - 24 * s,   y + 8 * s,    15 * s, 0, Math.PI * 2);
    ctx.arc(x + 6 * s,    y - 14 * s,   16 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawClouds() {
    const span = W + 140;
    for (const c of clouds) {
      // Wrap into [-70, W+70) so a cloud reappears on the left seamlessly.
      let x = ((c.x - cloudScroll) % span + span) % span - 70;
      drawCloud(x, c.y, c.s, c.o);
    }
  }

  function drawBushes() {
    const span = W + 120;
    const baseY = PLAY_H + 4;
    for (const b of bushes) {
      let x = ((b.x - bushScroll) % span + span) % span - 60;
      ctx.save();
      ctx.globalAlpha = 0.55 * b.o;
      ctx.fillStyle = '#5ea832';
      ctx.beginPath();
      ctx.arc(x, baseY, b.r, Math.PI, 0);
      ctx.arc(x + b.r * 0.7, baseY, b.r * 0.72, Math.PI, 0);
      ctx.arc(x - b.r * 0.7, baseY, b.r * 0.6, Math.PI, 0);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawPipe(p) {
    const { pipeW, capH, capOut } = CFG;

    const body = ctx.createLinearGradient(p.x, 0, p.x + pipeW, 0);
    body.addColorStop(0,    '#4a8f22');
    body.addColorStop(0.18, '#8ed14f');
    body.addColorStop(0.45, '#6cb833');
    body.addColorStop(0.85, '#3f7a1d');
    body.addColorStop(1,    '#2f5d14');

    ctx.lineWidth = 2;
    ctx.strokeStyle = '#2a4d12';

    // Top pipe: shaft then cap sitting on the gap edge.
    ctx.fillStyle = body;
    ctx.fillRect(p.x, -40, pipeW, p.top + 40 - capH);
    ctx.strokeRect(p.x, -40, pipeW, p.top + 40 - capH);
    ctx.fillRect(p.x - capOut, p.top - capH, pipeW + capOut * 2, capH);
    ctx.strokeRect(p.x - capOut, p.top - capH, pipeW + capOut * 2, capH);

    // Bottom pipe.
    const bh = PLAY_H - p.bottom + 40;
    ctx.fillRect(p.x, p.bottom + capH, pipeW, bh - capH);
    ctx.strokeRect(p.x, p.bottom + capH, pipeW, bh - capH);
    ctx.fillRect(p.x - capOut, p.bottom, pipeW + capOut * 2, capH);
    ctx.strokeRect(p.x - capOut, p.bottom, pipeW + capOut * 2, capH);

    // Glossy highlight stripe down the left third of both shafts.
    ctx.fillStyle = 'rgba(255,255,255,.18)';
    ctx.fillRect(p.x + 9, -40, 9, p.top + 40 - capH);
    ctx.fillRect(p.x + 9, p.bottom + capH, 9, bh - capH);
  }

  function drawGround() {
    const y = PLAY_H;

    // grass band
    ctx.fillStyle = '#7ec850';
    ctx.fillRect(0, y, W, 14);
    ctx.fillStyle = '#5ea832';
    ctx.beginPath();
    const off = groundScroll % 16;
    for (let x = -off; x < W + 16; x += 16) {
      ctx.moveTo(x, y + 14);
      ctx.lineTo(x + 8, y + 6);
      ctx.lineTo(x + 16, y + 14);
    }
    ctx.fill();

    // dirt
    const g = ctx.createLinearGradient(0, y + 14, 0, H);
    g.addColorStop(0, '#ded895');
    g.addColorStop(1, '#c4b775');
    ctx.fillStyle = g;
    ctx.fillRect(0, y + 14, W, GROUND_H - 14);

    // scrolling diagonal hatching so motion reads even when pipes are far apart
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y + 14, W, GROUND_H - 14);
    ctx.clip();
    ctx.strokeStyle = 'rgba(160,145,90,.45)';
    ctx.lineWidth = 6;
    const d = groundScroll % 28;
    for (let x = -d - 40; x < W + 40; x += 28) {
      ctx.beginPath();
      ctx.moveTo(x, H);
      ctx.lineTo(x + 40, y + 14);
      ctx.stroke();
    }
    ctx.restore();

    ctx.strokeStyle = '#a89a5e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, y + 15);
    ctx.lineTo(W, y + 15);
    ctx.stroke();
  }

  function drawBird() {
    const r = CFG.birdR;
    ctx.save();
    ctx.translate(CFG.birdX, bird.y);
    ctx.rotate(bird.angle);

    // Wing sweeps through one full down-up stroke over the flap window;
    // while idling it just cycles.
    let wing;
    if (state === STATE.READY) wing = Math.sin(bird.wing) * 0.9;
    else if (bird.flapT > 0)   wing = Math.sin((1 - bird.flapT / 0.24) * Math.PI) * 1.6 - 0.6;
    else                       wing = -0.35;

    // tail
    ctx.fillStyle = '#e8a33d';
    ctx.strokeStyle = '#3d2b12';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-r * 0.9, -2);
    ctx.lineTo(-r * 1.85, -7);
    ctx.lineTo(-r * 1.75, 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // body
    const bg = ctx.createLinearGradient(0, -r, 0, r);
    bg.addColorStop(0, '#ffe45e');
    bg.addColorStop(0.6, '#f7c52d');
    bg.addColorStop(1, '#e0a020');
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 1.18, r, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // belly
    ctx.fillStyle = 'rgba(255,255,255,.45)';
    ctx.beginPath();
    ctx.ellipse(1, r * 0.34, r * 0.72, r * 0.44, 0, 0, Math.PI * 2);
    ctx.fill();

    // wing
    ctx.save();
    ctx.translate(-2, 0);
    ctx.rotate(wing);
    ctx.fillStyle = '#fff6d0';
    ctx.strokeStyle = '#3d2b12';
    ctx.beginPath();
    ctx.ellipse(-2, 2, r * 0.72, r * 0.46, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // beak
    ctx.fillStyle = '#ff8a24';
    ctx.beginPath();
    ctx.moveTo(r * 0.95, -2);
    ctx.lineTo(r * 1.75, 2);
    ctx.lineTo(r * 0.95, 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // eye
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(r * 0.45, -r * 0.35, r * 0.36, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#20180c';
    ctx.beginPath();
    ctx.arc(r * 0.58, -r * 0.35, r * 0.16, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function drawFeathers() {
    for (const f of feathers) {
      ctx.save();
      ctx.globalAlpha = clamp(f.life, 0, 1);
      ctx.translate(f.x, f.y);
      ctx.rotate(f.rot);
      ctx.fillStyle = '#ffe45e';
      ctx.beginPath();
      ctx.ellipse(0, 0, 5, 2.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function outlinedText(text, x, y, size, fill = '#fff', stroke = '#2a2013') {
    ctx.font = `700 ${size}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(3, size * 0.16);
    ctx.strokeStyle = stroke;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  }

  function drawScore() {
    if (state === STATE.READY) return;
    outlinedText(String(score), W / 2, 92, 52);
    for (const p of popups) {
      ctx.save();
      ctx.globalAlpha = clamp(p.life, 0, 1);
      outlinedText('+1', W / 2 + 46, 92 + p.y, 20, '#ffe45e');
      ctx.restore();
    }
  }

  function drawReady() {
    outlinedText('FLAPPY BIRD', W / 2, 150, 34, '#ffe45e');
    outlinedText('claude code', W / 2, 182, 14, '#e6f7f8');

    const pulse = 0.72 + Math.sin(readyTime * 4) * 0.28;
    ctx.save();
    ctx.globalAlpha = pulse;
    outlinedText('TAP  or  SPACE  to  start', W / 2, PLAY_H - 120, 17);
    ctx.restore();

    // finger/arrow pointing up at the bird
    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.translate(W / 2, PLAY_H - 172);
    ctx.strokeStyle = '#2a2013';
    ctx.fillStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, -12); ctx.lineTo(11, 6); ctx.lineTo(-11, 6); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  function medalFor(s) {
    return MEDALS.find(m => s >= m.at) || null;
  }

  function drawMedal(cx, cy, medal) {
    ctx.save();
    ctx.translate(cx, cy);
    const g = ctx.createLinearGradient(-22, -22, 22, 22);
    g.addColorStop(0, medal.a);
    g.addColorStop(1, medal.b);
    ctx.fillStyle = g;
    ctx.strokeStyle = 'rgba(0,0,0,.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 23, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.arc(0, 0, 15, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.beginPath();
    ctx.ellipse(-7, -9, 8, 5, -0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawGameOver() {
    const t = easeOut(clamp(overAnim, 0, 1));

    ctx.fillStyle = `rgba(0,0,0,${0.32 * t})`;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.globalAlpha = t;
    ctx.translate(0, (1 - t) * 40);

    outlinedText('GAME OVER', W / 2, 176, 36, '#ffd23f');

    const pw = 272, ph = 138, px = (W - pw) / 2, py = 214;
    ctx.fillStyle = '#e8d9a0';
    ctx.strokeStyle = '#7c6a3a';
    ctx.lineWidth = 3;
    roundRect(ctx, px, py, pw, ph, 10);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    roundRect(ctx, px + 6, py + 6, pw - 12, 30, 6);
    ctx.fill();

    const medal = medalFor(score);
    if (medal) drawMedal(px + 52, py + ph / 2, medal);
    else {
      ctx.strokeStyle = 'rgba(124,106,58,.5)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(px + 52, py + ph / 2, 23, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const rx = px + pw - 24;

    ctx.font = '700 13px ui-monospace, monospace';
    ctx.fillStyle = '#8a7434';
    ctx.fillText('SCORE', rx, py + 40);
    ctx.fillText('BEST',  rx, py + 92);

    ctx.font = '700 30px ui-monospace, monospace';
    ctx.fillStyle = '#5a4a1e';
    ctx.fillText(String(score), rx, py + 64);
    ctx.fillText(String(best),  rx, py + 116);

    if (isNewBest) {
      ctx.save();
      ctx.translate(px + 100, py + 108);
      ctx.rotate(-0.14);
      ctx.fillStyle = '#e2382f';
      roundRect(ctx, -22, -10, 44, 20, 4);
      ctx.fill();
      ctx.font = '700 12px ui-monospace, monospace';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText('NEW!', 0, 1);
      ctx.restore();
    }

    if (overAnim > 0.55) {
      const pulse = 0.65 + Math.sin(performance.now() / 260) * 0.35;
      ctx.save();
      ctx.globalAlpha = pulse;
      outlinedText('TAP  or  SPACE  to  retry', W / 2, py + ph + 42, 16);
      ctx.restore();
    }

    ctx.restore();
  }

  function drawWatermark() {
    ctx.save();
    ctx.font = '600 10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(60,48,20,.45)';
    ctx.fillText('claude code', W - 10, H - 8);
    if (Sound.muted) {
      ctx.textAlign = 'left';
      ctx.fillText('muted (M)', 10, H - 8);
    }
    ctx.restore();
  }

  function render() {
    ctx.save();
    if (shake > 0) {
      const m = shake * 7;
      ctx.translate(rand(-m, m), rand(-m, m));
    }

    drawSky();
    drawClouds();
    drawBushes();
    for (const p of pipes) drawPipe(p);
    drawGround();
    drawFeathers();
    drawBird();
    drawScore();

    if (state === STATE.READY) drawReady();
    if (state === STATE.OVER)  drawGameOver();

    if (flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${flash * 0.65})`;
      ctx.fillRect(0, 0, W, H);
    }

    ctx.restore();
    drawWatermark();

    if (paused) {
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      ctx.fillRect(0, 0, W, H);
      outlinedText('PAUSED', W / 2, H / 2 - 12, 32);
      outlinedText('press P', W / 2, H / 2 + 22, 14);
    }
  }

  // -------------------------------------------------------------- debug hook

  if (new URLSearchParams(location.search).has('debug')) {
    DEBUG.on = true;
    window.flappy = {
      get state()  { return state; },
      get score()  { return score; },
      get best()   { return best; },
      get bird()   { return { ...bird }; },
      get pipes()  { return pipes.map(p => ({ ...p })); },
      get paused() { return paused; },
      get god()    { return DEBUG.god; },
      set god(v)   { DEBUG.god = !!v; },
      flap,
      reset,
      difficultyAt,
    };
  }

  // --------------------------------------------------------------------- loop

  let lastTime = performance.now();
  let accumulator = 0;

  function frame(now) {
    requestAnimationFrame(frame);

    // Clamp: a backgrounded tab can hand us a multi-second delta, which would
    // otherwise teleport the bird through a pipe before collision ever runs.
    const dt = Math.min((now - lastTime) / 1000, 0.25);
    lastTime = now;

    if (!paused) {
      accumulator += dt;
      while (accumulator >= STEP) {
        update(STEP);
        accumulator -= STEP;
      }
    }

    render();
  }

  requestAnimationFrame(frame);
})();
