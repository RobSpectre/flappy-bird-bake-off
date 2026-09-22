/* Flappy Bird clone — vanilla canvas, no dependencies.
 * Physics runs on a fixed 1/120 s step so play feels identical on any refresh rate.
 */
(() => {
  'use strict';

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const soundBtn = document.getElementById('sound');

  // ---- logical (design) resolution -----------------------------------------
  const W = 400;
  const H = 600;
  const GROUND_H = 80;
  const FLOOR = H - GROUND_H;

  // ---- tuning --------------------------------------------------------------
  const CFG = {
    gravity: 1750,        // px/s^2
    flap: -480,           // px/s
    maxFall: 780,         // px/s terminal velocity
    pipeSpeed: 165,       // px/s
    pipeW: 62,
    gap: 158,             // vertical opening
    gapMargin: 70,        // min distance of gap from ceiling/floor
    spawnEvery: 1.42,     // seconds between pipes
    birdX: 104,
    birdR: 13,
    readyBob: { amp: 7, freq: 3.1 },
    restartLock: 0.45,    // seconds before a click can restart
  };

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const rand = (a, b) => a + Math.random() * (b - a);

  // ---- state ---------------------------------------------------------------
  const state = {
    phase: 'ready',       // ready | playing | dying | over
    t: 0,                 // seconds in current phase
    score: 0,
    best: Number(localStorage.getItem('flappy.best') || 0),
    blink: 0,
    shake: 0,
    flash: 0,
    muted: false,
    debut: Number(localStorage.getItem('flappy.games') || 0),
  };

  const bird = { y: H * 0.42, vy: 0, rot: 0, wing: 0, squash: 1 };

  const pipes = [];
  const clouds = [];
  const particles = [];
  const hills = { offset: 0 };

  let lastGroundY = FLOOR;

  // ---- audio (procedural, no assets) ---------------------------------------
  let audio = null;
  const blip = (freq, dur, type = 'square', vol = 0.05) => {
    if (state.muted) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, audio.currentTime);
      gain.gain.setValueAtTime(vol, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + dur);
      osc.connect(gain).connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + dur);
    } catch (_) { /* audio is a nice-to-have */ }
  };

  // ---- world setup ---------------------------------------------------------
  function seedClouds() {
    clouds.length = 0;
    for (let i = 0; i < 6; i++) {
      clouds.push({
        x: rand(0, W + 120),
        y: rand(40, FLOOR - 210),
        s: rand(0.55, 1.25),
        v: rand(9, 22),
      });
    }
  }

  function reset() {
    state.phase = 'ready';
    state.t = 0;
    state.score = 0;
    state.shake = 0;
    state.flash = 0;
    bird.y = H * 0.42;
    bird.vy = 0;
    bird.rot = 0;
    bird.squash = 1;
    pipes.length = 0;
    particles.length = 0;
    hills.offset = 0;
    spawnClock = CFG.spawnEvery * 0.35;
    seedClouds();
  }

  let spawnClock = 0;

  function spawnPipe() {
    const lo = CFG.gapMargin;
    const hi = FLOOR - CFG.gapMargin - CFG.gap;
    const gapY = rand(lo, Math.max(lo + 1, hi));   // gapY = top of the opening
    pipes.push({ x: W + CFG.pipeW, gapY, scored: false, hue: rand(-8, 8) });
  }

  // ---- input ---------------------------------------------------------------
  function press() {
    if (state.phase === 'ready') {
      state.phase = 'playing';
      state.t = 0;
      flap();
    } else if (state.phase === 'playing') {
      flap();
    } else if (state.phase === 'over' && state.t > CFG.restartLock) {
      reset();
    }
  }

  function flap() {
    bird.vy = CFG.flap;
    bird.wing = 1;
    bird.squash = 0.86;
    blip(680, 0.07, 'square', 0.04);
    for (let i = 0; i < 4; i++) {
      particles.push({
        x: CFG.birdX - 8, y: bird.y + 6,
        vx: rand(-70, -20), vy: rand(-20, 40),
        life: 0.4, max: 0.4, r: rand(1.5, 3), c: 'rgba(255,255,255,0.85)',
      });
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
      e.preventDefault();
      press();
    } else if (e.code === 'KeyR' && state.phase === 'over') {
      e.preventDefault();
      reset();
    }
  }, { passive: false });

  canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); press(); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  soundBtn.addEventListener('click', () => {
    state.muted = !state.muted;
    soundBtn.setAttribute('aria-pressed', String(!state.muted));
  });

  // ---- simulation ----------------------------------------------------------
  function step(dt) {
    state.t += dt;
    if (state.wing > 0) bird.wing = Math.max(0, bird.wing - dt * 3.2);
    bird.squash += (1 - bird.squash) * Math.min(1, dt * 12);
    state.shake = Math.max(0, state.shake - dt * 3.5);
    state.flash = Math.max(0, state.flash - dt * 4);

    const moving = state.phase === 'playing' || state.phase === 'dying';
    const speed = CFG.pipeSpeed;

    // clouds drift forever (parallax flavour, even on the menu)
    for (const c of clouds) {
      c.x -= c.v * dt * (state.phase === 'playing' ? 1.35 : 1);
      if (c.x < -90 * c.s) { c.x = W + 40; c.y = rand(40, FLOOR - 210); c.s = rand(0.55, 1.25); }
    }

    if (state.phase === 'ready') {
      bird.y = H * 0.42 + Math.sin(state.t * CFG.readyBob.freq) * CFG.readyBob.amp;
      bird.rot = Math.sin(state.t * CFG.readyBob.freq) * 0.08;
    }

    if (moving) {
      hills.offset = (hills.offset + speed * dt * 0.55) % 80;
    }

    if (state.phase === 'playing') {
      spawnClock -= dt;
      if (spawnClock <= 0) { spawnPipe(); spawnClock += CFG.spawnEvery; }

      for (const p of pipes) p.x -= speed * dt;

      while (pipes.length && pipes[0].x + CFG.pipeW < -10) pipes.shift();

      // bird integration
      bird.vy = clamp(bird.vy + CFG.gravity * dt, CFG.flap, CFG.maxFall);
      bird.y += bird.vy * dt;
      bird.rot = clamp(bird.vy / 620, -0.45, 1.1);

      // ceiling: soft stop, no cheap death
      if (bird.y < CFG.birdR) { bird.y = CFG.birdR; bird.vy = Math.max(bird.vy, 0); }

      for (const p of pipes) {
        if (!p.scored && p.x + CFG.pipeW < CFG.birdX - CFG.birdR) {
          p.scored = true;
          state.score += 1;
          blip(900, 0.08, 'triangle', 0.05);
        }
        if (hits(bird.y, p)) { die(); break; }
      }

      if (state.phase === 'playing' && bird.y + CFG.birdR >= FLOOR) {
        bird.y = FLOOR - CFG.birdR;
        die(true);
      }
    }

    if (state.phase === 'dying') {
      bird.vy = clamp(bird.vy + CFG.gravity * dt, CFG.flap, CFG.maxFall);
      bird.y += bird.vy * dt;
      bird.rot = clamp(bird.vy / 620, -0.45, 1.4);
      if (bird.y + CFG.birdR >= FLOOR) {
        bird.y = FLOOR - CFG.birdR;
        bird.vy = 0;
        toOver();
      }
    }

    // puff particles
    for (let i = particles.length - 1; i >= 0; i--) {
      const q = particles[i];
      q.life -= dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.vy += 40 * dt;
      q.x -= moving ? CFG.pipeSpeed * dt : 0;
      if (q.life <= 0) particles.splice(i, 1);
    }
  }

  // circle vs pipe (two rects) overlap test
  function hits(by, p) {
    const r = CFG.birdR;
    return circleRect(CFG.birdX, by, r, p.x, 0, CFG.pipeW, p.gapY) ||
           circleRect(CFG.birdX, by, r, p.x, p.gapY + CFG.gap, CFG.pipeW, FLOOR - p.gapY - CFG.gap);
  }

  function circleRect(cx, cy, r, x, y, w, h) {
    const nx = clamp(cx, x, x + w);
    const ny = clamp(cy, y, y + h);
    const dx = cx - nx, dy = cy - ny;
    return dx * dx + dy * dy < r * r;
  }

  function die(fromGround) {
    if (state.phase !== 'playing') return;
    state.phase = 'dying';
    state.t = 0;
    state.flash = 1;
    state.shake = 1;
    blip(180, 0.16, 'sawtooth', 0.06);
    if (state.score > state.best) {
      state.best = state.score;
      localStorage.setItem('flappy.best', String(state.best));
    }
    if (!fromGround) bird.vy = Math.max(bird.vy, -120);
  }

  function toOver() {
    state.phase = 'over';
    state.t = 0;
    state.debut += 1;
    localStorage.setItem('flappy.games', String(state.debut));
  }

  // ---- rendering -----------------------------------------------------------
  function drawSky() {
    const g = ctx.createLinearGradient(0, 0, 0, FLOOR);
    g.addColorStop(0, '#3fa8c4');
    g.addColorStop(0.55, '#79d3dc');
    g.addColorStop(1, '#cdeee4');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, FLOOR);

    // sun glow
    const s = ctx.createRadialGradient(318, 92, 6, 318, 92, 120);
    s.addColorStop(0, 'rgba(255,246,214,0.95)');
    s.addColorStop(1, 'rgba(255,246,214,0)');
    ctx.fillStyle = s;
    ctx.fillRect(180, 0, 260, 260);
  }

  function cloudShape(c) {
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.scale(c.s, c.s);
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.beginPath();
    ctx.arc(0, 0, 20, 0, Math.PI * 2);
    ctx.arc(24, 6, 15, 0, Math.PI * 2);
    ctx.arc(-24, 6, 14, 0, Math.PI * 2);
    ctx.arc(4, 12, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawHills() {
    ctx.fillStyle = '#63c9a8';
    ctx.beginPath();
    ctx.moveTo(0, FLOOR);
    for (let x = -80; x <= W + 80; x += 80) {
      const px = x - hills.offset;
      ctx.quadraticCurveTo(px + 40, FLOOR - 88, px + 80, FLOOR - 26);
    }
    ctx.lineTo(W, FLOOR);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fillRect(0, FLOOR - 30, W, 30);
  }

  function drawPipe(p) {
    const bodyTop = 0, bodyBottom = FLOOR;
    const capH = 26, capOver = 6;
    const gradient = ctx.createLinearGradient(p.x, 0, p.x + CFG.pipeW, 0);
    gradient.addColorStop(0, `hsl(96,52%,34%)`);
    gradient.addColorStop(0.22, `hsl(96,58%,${52 + p.hue}%)`);
    gradient.addColorStop(0.6, `hsl(96,58%,${46 + p.hue}%)`);
    gradient.addColorStop(1, `hsl(96,52%,28%)`);

    const topH = p.gapY;
    const botY = p.gapY + CFG.gap;
    const botH = bodyBottom - botY;
    if (topH <= 0 && botH <= 0) return;

    ctx.fillStyle = gradient;
    ctx.strokeStyle = 'rgba(20,40,20,0.55)';
    ctx.lineWidth = 2;

    // upper pipe
    if (topH > 0) {
      ctx.fillRect(p.x, bodyTop, CFG.pipeW, topH - capH);
      ctx.strokeRect(p.x + 1, bodyTop - 2, CFG.pipeW - 2, topH - capH + 2);
      roundRect(p.x - capOver, topH - capH, CFG.pipeW + capOver * 2, capH, 4, gradient);
      // inner shadow on the opening
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(p.x + 6, topH - 6, CFG.pipeW - 12, 6);
      ctx.fillStyle = gradient;
    }
    // lower pipe
    if (botH > 0) {
      ctx.fillRect(p.x, botY + capH, CFG.pipeW, botH - capH);
      ctx.strokeRect(p.x + 1, botY, CFG.pipeW - 2, botH - capH);
      const g2 = ctx.createLinearGradient(p.x, botY, p.x, botY + capH);
      g2.addColorStop(0, `hsl(96,58%,${44 + p.hue}%)`);
      g2.addColorStop(1, `hsl(96,52%,30%)`);
      roundRect(p.x - capOver, botY, CFG.pipeW + capOver * 2, capH, 4, g2);
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(p.x + 6, botY + capH - 4, CFG.pipeW - 12, 5);
    }
  }

  function roundRect(x, y, w, h, r, fill) {
    ctx.beginPath();
    const rr = Math.min(r, h / 2, w / 2);
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = 'rgba(20,40,20,0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function drawGround() {
    const g = ctx.createLinearGradient(0, FLOOR, 0, H);
    g.addColorStop(0, '#e5d38a');
    g.addColorStop(0.18, '#d9c26b');
    g.addColorStop(1, '#b99f4d');
    ctx.fillStyle = g;
    ctx.fillRect(0, FLOOR, W, GROUND_H);

    ctx.fillStyle = '#6cbb52';
    ctx.fillRect(0, FLOOR, W, 12);
    ctx.fillStyle = 'rgba(0,0,0,0.14)';
    ctx.fillRect(0, FLOOR + 12, W, 3);

    // scrolling hatches
    const unit = 40;
    const off = state.phase === 'playing' || state.phase === 'dying'
      ? (hills.offset / 0.55 * 0.5) % unit
      : 0;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, FLOOR + 15, W, GROUND_H - 15);
    ctx.clip();
    ctx.strokeStyle = 'rgba(120,96,40,0.35)';
    ctx.lineWidth = 3;
    for (let x = -unit; x < W + unit; x += unit) {
      ctx.beginPath();
      ctx.moveTo(x - off, FLOOR + 16);
      ctx.lineTo(x - off - 26, H);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawBird() {
    const r = CFG.birdR;

    // soft contact shadow on the ground so the bird reads as grounded
    const h = Math.max(0, FLOOR - (bird.y + r));
    const k = clamp(1 - h / 340, 0.15, 1);
    ctx.save();
    ctx.globalAlpha = 0.38 * k;
    ctx.fillStyle = '#2f2606';
    ctx.beginPath();
    ctx.ellipse(CFG.birdX + 2, FLOOR + 8, 10 * k + 6, 4 * k + 1.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(CFG.birdX, bird.y);
    ctx.rotate(bird.rot);
    ctx.scale(1 / bird.squash, bird.squash);

    // body
    const g = ctx.createLinearGradient(-r, -r, r, r);
    g.addColorStop(0, '#ffe066');
    g.addColorStop(1, '#f2a91b');
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 1.15, r, 0, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#8a5a10';
    ctx.stroke();

    // belly
    ctx.beginPath();
    ctx.ellipse(-1, r * 0.42, r * 0.7, r * 0.42, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fill();

    // wing (flaps up when state.wing is high)
    const w = Math.sin((1 - state.wing) * Math.PI) * 0.5;
    ctx.save();
    ctx.translate(-2, 1);
    ctx.rotate(-w);
    ctx.beginPath();
    ctx.ellipse(-3, 2, r * 0.72, r * 0.44, -0.25, 0, Math.PI * 2);
    ctx.fillStyle = '#fff4c2';
    ctx.fill();
    ctx.strokeStyle = '#c08a1c';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    // eye
    ctx.beginPath();
    ctx.arc(r * 0.42, -r * 0.34, r * 0.42, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#8a5a10';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.beginPath();
    const blinkOpen = state.phase !== 'over' || Math.sin(state.t * 6) > -0.6;
    if (blinkOpen) {
      ctx.arc(r * 0.5, -r * 0.34, r * 0.2, 0, Math.PI * 2);
      ctx.fillStyle = '#20303a';
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(r * 0.24, -r * 0.34);
      ctx.lineTo(r * 0.68, -r * 0.34);
      ctx.strokeStyle = '#20303a';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // beak
    ctx.beginPath();
    ctx.moveTo(r * 1.0, -r * 0.12);
    ctx.lineTo(r * 1.85, r * 0.12);
    ctx.lineTo(r * 1.0, r * 0.42);
    ctx.closePath();
    ctx.fillStyle = '#f2782f';
    ctx.fill();
    ctx.strokeStyle = '#a8481a';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    ctx.restore();
  }

  function drawParticles() {
    for (const q of particles) {
      ctx.globalAlpha = clamp(q.life / q.max, 0, 1);
      ctx.fillStyle = q.c;
      ctx.beginPath();
      ctx.arc(q.x, q.y, q.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawHud() {
    ctx.textAlign = 'center';
    const best = state.best;
    if (state.phase === 'ready') {
      panel(W / 2 - 130, 120, 260, 112, 'Flappy Bird', [
        'Tap, click or press Space',
        `Best score: ${best}`,
      ]);
    } else if (state.phase === 'over') {
      const isBest = state.score >= best && state.score > 0;
      panel(W / 2 - 132, 160, 264, 166, 'Game Over', [
        `Score:  ${state.score}`,
        `Best:   ${Math.max(best, state.score)}`,
        isBest ? 'New record!' : `Games played: ${state.debut}`,
        state.t > CFG.restartLock ? 'Click / Space to play again' : '',
      ], state.t > CFG.restartLock ? 3 : -1);
    }
  }

  // highlight = index of the line drawn in the accent colour (-1 for none)
  function panel(x, y, w, h, title, lines, highlight = -1) {
    ctx.save();
    // solid fill + drop shadow: the panel must stay legible over bright pipes
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = '#13232e';
    roundRectPath(x, y, w, h, 14);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.20)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = '700 26px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(title, x + w / 2, y + 40);

    ctx.font = '15px ui-sans-serif, system-ui, sans-serif';
    lines.forEach((ln, i) => {
      if (!ln) return;
      ctx.fillStyle = i === highlight ? '#7ee0b0' : '#cfe0ea';
      ctx.fillText(ln, x + w / 2, y + 76 + i * 24);
    });
    ctx.restore();
  }

  function roundRectPath(x, y, w, h, r) {
    ctx.beginPath();
    const rr = Math.min(r, h / 2, w / 2);
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function drawScore() {
    if (state.phase !== 'playing' && state.phase !== 'dying') return;
    const txt = String(state.score);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = '700 46px ui-sans-serif, system-ui, sans-serif';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(20,36,44,0.55)';
    ctx.fillStyle = '#fff';
    const pop = state.phase === 'dying' ? 1 : 1;
    ctx.translate(W / 2, 78 * pop);
    ctx.strokeText(txt, 0, 0);
    ctx.fillText(txt, 0, 0);
    ctx.restore();
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const sh = state.shake;
    if (sh > 0) {
      ctx.translate(rand(-6, 6) * sh, rand(-6, 6) * sh);
    }

    drawSky();
    for (const c of clouds) cloudShape(c);
    drawHills();
    for (const p of pipes) drawPipe(p);
    drawGround();
    drawParticles();
    drawBird();
    drawScore();
    drawHud();

    if (state.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${state.flash * 0.5})`;
      ctx.fillRect(-10, -10, W + 20, H + 20);
    }
  }

  // ---- loop ----------------------------------------------------------------
  let dpr = 1;
  function fit() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const STEP = 1 / 120;
  let acc = 0;
  let prev = performance.now();

  function frame(now) {
    const dt = Math.min((now - prev) / 1000, 0.25);
    prev = now;
    acc += dt;
    let guard = 0;
    while (acc >= STEP && guard++ < 40) { step(STEP); acc -= STEP; }
    render();
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', fit);
  document.addEventListener('visibilitychange', () => { prev = performance.now(); acc = 0; });

  fit();
  reset();
  requestAnimationFrame((t) => { prev = t; frame(t); });

  // tiny debug hook for automated checks / tests
  window.__flappy = {
    get state() { return { phase: state.phase, score: state.score, best: state.best, birdY: bird.y, pipeCount: pipes.length }; },
    get pipes() { return pipes.map((p) => ({ x: p.x, gapY: p.gapY })); },
    get birdVel() { return bird.vy; },
    cfg: CFG,
    W, H, FLOOR,
    press,
    reset,
    step,
  };
})();
