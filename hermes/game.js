/* Flappy Bird - dependency-free canvas clone.
 *
 * Fixed logical resolution (288x512), rendered to <canvas>, CSS-scaled to fit
 * the window. Simulation runs on a fixed 60Hz timestep with an accumulator so
 * the game plays identically at 60Hz, 144Hz or on a throttled tab.
 *
 * All tunables live in the block below. Everything else is loop, collision,
 * rendering and audio. Classic <script>, no modules - so file:// works.
 */
(function () {
  'use strict';

  /* ---- tunables -------------------------------------------------------- */

  const VIEW_W = 288;          // logical viewport width, px
  const VIEW_H = 512;          // logical viewport height, px
  const GROUND_H = 96;         // ground strip height
  const FLOOR_Y = VIEW_H - GROUND_H;

  const STEP = 1000 / 60;      // simulation step
  const MAX_STEPS = 5;         // catch-up ceiling for one animation frame

  const GRAVITY = 0.32;        // px per step^2
  const FLAP_V = -5.2;         // upward impulse, px per step
  const MAX_FALL = 9;          // terminal velocity

  const BIRD_X = 70;           // bird centre, fixed horizontally
  const BIRD_W = 17;           // drawn sprite size
  const BIRD_H = 12;
  const HITBOX_INSET = 2;      // collision box sits this far inside the art on
                               // every edge - a visible-equals-hitbox bird feels
                               // like it dies for no reason

  const PIPE_W = 52;
  const PIPE_SPACING = 160;    // horizontal distance between pipe pairs
  const PIPE_MARGIN = 46;      // min distance from ceiling / ground to a gap

  const GAP_START = 118;       // gap height at score 0
  const GAP_MIN = 92;          // ... and its floor
  const GAP_RAMP = 30;         // score at which the gap bottoms out
  const SPEED_START = 2.0;     // px per step at score 0
  const SPEED_MAX = 2.75;      // ... and its ceiling
  const SPEED_RAMP = 40;       // score at which the speed tops out

  const FLAP_DEBOUNCE = 0;     // ms; 0 disables

  const BEST_KEY = 'flappy.best.v1';
  const MUTE_KEY = 'flappy.mute.v1';
  const MEDALS = [              // [minScore, css class, label]
    [40, 'platinum', 'Platinum'],
    [30, 'gold', 'Gold'],
    [20, 'silver', 'Silver'],
    [10, 'bronze', 'Bronze']
  ];

  /* ---- dom ------------------------------------------------------------- */

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const shell = document.getElementById('shell');
  const titleScreen = document.getElementById('title-screen');
  const overScreen = document.getElementById('over-screen');
  const titleBest = document.getElementById('title-best');
  const finalScore = document.getElementById('final-score');
  const finalBest = document.getElementById('final-best');
  const newBest = document.getElementById('new-best');
  const medalEl = document.getElementById('medal');
  const muteBtn = document.getElementById('mute-btn');
  document.getElementById('start-btn').addEventListener('click', start);
  document.getElementById('restart-btn').addEventListener('click', start);
  muteBtn.addEventListener('click', toggleMute);

  /* ---- persistence ----------------------------------------------------- */

  function readInt(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : fallback;
    } catch (e) { return fallback; }
  }

  function write(key, value) {
    try { window.localStorage.setItem(key, String(value)); } catch (e) { /* private mode */ }
  }

  let best = readInt(BEST_KEY, 0);
  let muted = readInt(MUTE_KEY, 0) === 1;

  /* ---- audio -----------------------------------------------------------
     Oscillators only, no audio files. The AudioContext is created *and*
     resumed inside the first user gesture, as autoplay policy requires. */

  let actx = null;

  function unlock() {
    try {
      if (!actx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        actx = new AC();
      }
      if (actx.state === 'suspended') actx.resume();
    } catch (e) { actx = null; }
  }

  function tone(opts) {
    if (muted || !actx) return;
    try {
      const type = opts.type || 'square';
      const from = opts.from || 440;
      const to = opts.to || from;
      const dur = opts.dur || 0.1;
      const vol = opts.vol == null ? 0.12 : opts.vol;
      const t0 = actx.currentTime + (opts.delay || 0);
      const osc = actx.createOscillator();
      const gain = actx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(from, t0);
      if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(vol, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain);
      gain.connect(actx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    } catch (e) { /* audio is never load-bearing */ }
  }

  const sfx = {
    flap: function () { tone({ type: 'square', from: 480, to: 760, dur: 0.08, vol: 0.10 }); },
    score: function () {
      tone({ type: 'square', from: 880, to: 880, dur: 0.07, vol: 0.09 });
      tone({ type: 'square', from: 1320, to: 1320, dur: 0.09, vol: 0.08, delay: 0.07 });
    },
    hit: function () { tone({ type: 'sawtooth', from: 240, to: 70, dur: 0.18, vol: 0.18 }); },
    die: function () { tone({ type: 'triangle', from: 420, to: 90, dur: 0.42, vol: 0.14, delay: 0.06 }); }
  };

  function toggleMute() {
    muted = !muted;
    write(MUTE_KEY, muted ? 1 : 0);
    muteBtn.classList.toggle('muted', muted);
    muteBtn.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
    if (!muted) { unlock(); sfx.flap(); }
  }

  /* ---- state ----------------------------------------------------------- */

  const STATE = { READY: 'ready', PLAYING: 'playing', DYING: 'dying', OVER: 'over' };

  let state = STATE.READY;
  let score = 0;
  let pipes = [];
  let speed = SPEED_START;
  let gap = GAP_START;
  let groundScroll = 0;
  let lastFlapAt = -Infinity;
  let timeMs = 0;
  let deathAt = 0;

  const bird = { x: BIRD_X, y: VIEW_H * 0.42, vy: 0, rot: 0, wing: 0 };

  const clouds = [];
  for (let i = 0; i < 5; i++) {
    clouds.push({
      x: Math.random() * (VIEW_W + 80) - 40,
      y: 30 + Math.random() * 190,
      s: 0.7 + Math.random() * 0.8
    });
  }

  let skylineScroll = 0;

  function difficultyFor(s) {
    const g = Math.max(GAP_MIN, GAP_START - (GAP_START - GAP_MIN) * Math.min(1, s / GAP_RAMP));
    const v = Math.min(SPEED_MAX, SPEED_START + (SPEED_MAX - SPEED_START) * Math.min(1, s / SPEED_RAMP));
    return { gap: g, speed: v };
  }

  function spawnedGapCenter() {
    const lowerBound = PIPE_MARGIN + gap / 2;
    const upperBound = FLOOR_Y - PIPE_MARGIN - gap / 2;
    return lowerBound + Math.random() * Math.max(0, upperBound - lowerBound);
  }

  function spawnPipe(x) {
    pipes.push({ x: x, center: spawnedGapCenter(), gap: gap, scored: false });
  }

  function reset() {
    score = 0;
    const d = difficultyFor(0);
    gap = d.gap;
    speed = d.speed;
    pipes = [];
    groundScroll = 0;
    timeMs = 0;
    bird.y = VIEW_H * 0.42;
    bird.vy = 0;
    bird.rot = 0;
    bird.wing = 0;
    for (let i = 0; i < 3; i++) spawnPipe(VIEW_W + 60 + i * PIPE_SPACING);
  }

  function showTitle() {
    state = STATE.READY;
    reset();
    titleBest.textContent = best;
    titleScreen.classList.remove('hidden');
    overScreen.classList.add('hidden');
  }

  function start() {
    unlock();
    state = STATE.PLAYING;
    reset();
    titleScreen.classList.add('hidden');
    overScreen.classList.add('hidden');
    flap();
  }

  function flap() {
    if (state !== STATE.PLAYING) return;
    if (FLAP_DEBOUNCE && timeMs - lastFlapAt < FLAP_DEBOUNCE) return;
    lastFlapAt = timeMs;
    bird.vy = FLAP_V;
    bird.wing = 1;
    sfx.flap();
  }

  function hitbox() {
    return {
      x: bird.x - BIRD_W / 2 + HITBOX_INSET,
      y: bird.y - BIRD_H / 2 + HITBOX_INSET,
      w: BIRD_W - HITBOX_INSET * 2,
      h: BIRD_H - HITBOX_INSET * 2
    };
  }

  function collides(box, pipe) {
    if (box.x + box.w < pipe.x || box.x > pipe.x + PIPE_W) return false;
    const top = pipe.center - pipe.gap / 2;
    const bottom = pipe.center + pipe.gap / 2;
    return box.y < top || box.y + box.h > bottom;
  }

  function die() {
    state = STATE.DYING;
    deathAt = timeMs;
    sfx.hit();
    sfx.die();
  }

  function gameOver() {
    state = STATE.OVER;
    const isNewBest = score > best;
    if (isNewBest) {
      best = score;
      write(BEST_KEY, best);
    }
    finalScore.textContent = score;
    finalBest.textContent = best;
    newBest.classList.toggle('hidden', !isNewBest);
    let cls = 'none';
    for (let i = 0; i < MEDALS.length; i++) {
      if (score >= MEDALS[i][0]) { cls = MEDALS[i][1]; break; }
    }
    medalEl.className = 'medal ' + cls;
    medalEl.setAttribute('aria-label', cls === 'none' ? 'No medal' : cls + ' medal');
    overScreen.classList.remove('hidden');
  }

  /* ---- update ---------------------------------------------------------- */

  function update() {
    timeMs += STEP;

    if (state === STATE.READY) {
      // gentle idle bob so the title screen is alive
      bird.y = VIEW_H * 0.42 + Math.sin(timeMs / 260) * 7;
      bird.rot = Math.sin(timeMs / 260) * 0.12;
      bird.wing = (Math.sin(timeMs / 90) + 1) / 2;
      groundScroll += SPEED_START * 0.35;
      skylineScroll += SPEED_START * 0.2;
      return;
    }

    const scrolling = state === STATE.PLAYING;
    const step = scrolling ? speed : 0;

    groundScroll += step;
    skylineScroll += step * 0.55;

    for (let i = 0; i < clouds.length; i++) {
      const c = clouds[i];
      c.x -= step * 0.22 * c.s;
      if (c.x < -50) { c.x = VIEW_W + 40; c.y = 30 + Math.random() * 190; c.s = 0.7 + Math.random() * 0.8; }
    }

    if (state === STATE.PLAYING) {
      bird.vy = Math.min(bird.vy + GRAVITY, MAX_FALL);
      bird.y += bird.vy;
      const targetRot = Math.max(-0.45, Math.min(1.4, bird.vy / MAX_FALL * 1.1));
      bird.rot += (targetRot - bird.rot) * 0.22;

      // ceiling is a clamp, never a death
      if (bird.y - BIRD_H / 2 < 0) { bird.y = BIRD_H / 2; if (bird.vy < 0) bird.vy = 0; }

      for (let i = 0; i < pipes.length; i++) pipes[i].x -= step;
      while (pipes.length && pipes[0].x + PIPE_W < -PIPE_W) pipes.shift();

      const last = pipes[pipes.length - 1];
      if (!last || last.x <= VIEW_W - PIPE_SPACING) spawnPipe(VIEW_W + PIPE_W);

      const box = hitbox();
      for (let i = 0; i < pipes.length; i++) {
        const p = pipes[i];
        if (!p.scored && box.x > p.x + PIPE_W) {
          p.scored = true;
          score++;
          const d = difficultyFor(score);
          gap = d.gap;
          speed = d.speed;
          sfx.score();
        }
        if (collides(box, p)) { die(); return; }
      }

      if (bird.y + BIRD_H / 2 >= FLOOR_Y) {
        bird.y = FLOOR_Y - BIRD_H / 2;
        die();
        return;
      }
      return;
    }

    if (state === STATE.DYING) {
      bird.vy = Math.min(bird.vy + GRAVITY * 1.15, MAX_FALL * 1.2);
      bird.y += bird.vy;
      bird.rot = Math.min(1.55, bird.rot + 0.09);
      if (bird.y + BIRD_H / 2 >= FLOOR_Y) {
        bird.y = FLOOR_Y - BIRD_H / 2;
        gameOver();
      }
    }
  }

  /* ---- rendering ------------------------------------------------------- */

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawSky() {
    const grad = ctx.createLinearGradient(0, 0, 0, FLOOR_Y);
    grad.addColorStop(0, '#4ec0ca');
    grad.addColorStop(0.55, '#7fd0d8');
    grad.addColorStop(1, '#bfe7e0');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, VIEW_W, FLOOR_Y);
  }

  function drawCloud(x, y, s) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
    ctx.beginPath();
    ctx.ellipse(x, y, 26 * s, 12 * s, 0, 0, Math.PI * 2);
    ctx.ellipse(x + 18 * s, y + 3 * s, 18 * s, 9 * s, 0, 0, Math.PI * 2);
    ctx.ellipse(x - 18 * s, y + 4 * s, 15 * s, 8 * s, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawSkyline() {
    const baseY = FLOOR_Y;
    const w = 22;
    const offset = -(skylineScroll % (w * 3));
    ctx.fillStyle = 'rgba(90, 168, 152, 0.55)';
    for (let i = -1; i < VIEW_W / w + 2; i++) {
      const x = offset + i * w;
      const idx = i + Math.floor(skylineScroll / (w * 3)) * 3;
      const h = 26 + ((idx * 37) % 5) * 9;
      ctx.fillRect(x, baseY - h, w - 4, h);
      ctx.fillRect(x + 4, baseY - h - 8, 6, 8);
    }
  }

  function drawPipe(p) {
    const top = p.center - p.gap / 2;
    const bottom = p.center + p.gap / 2;
    const x = p.x;

    const body = ctx.createLinearGradient(x, 0, x + PIPE_W, 0);
    body.addColorStop(0, '#5f9e2f');
    body.addColorStop(0.28, '#9ede4e');
    body.addColorStop(0.62, '#79c333');
    body.addColorStop(1, '#4d7f24');

    // upper pipe
    ctx.fillStyle = body;
    ctx.fillRect(x, 0, PIPE_W, top - 22);
    // lower pipe
    ctx.fillRect(x, bottom + 22, PIPE_W, FLOOR_Y - bottom - 22);

    // caps
    ctx.fillStyle = body;
    ctx.fillRect(x - 4, top - 22, PIPE_W + 8, 22);
    ctx.fillRect(x - 4, bottom, PIPE_W + 8, 22);

    ctx.strokeStyle = '#2f4f16';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, 1, PIPE_W - 2, top - 23);
    ctx.strokeRect(x - 3, top - 21, PIPE_W + 6, 20);
    ctx.strokeRect(x - 3, bottom + 1, PIPE_W + 6, 20);
    ctx.strokeRect(x + 1, bottom + 23, PIPE_W - 2, FLOOR_Y - bottom - 24);
  }

  function drawGround() {
    ctx.fillStyle = '#ded895';
    ctx.fillRect(0, FLOOR_Y, VIEW_W, GROUND_H);
    ctx.fillStyle = '#7ec850';
    ctx.fillRect(0, FLOOR_Y, VIEW_W, 12);
    ctx.fillStyle = '#5da33a';
    ctx.fillRect(0, FLOOR_Y + 12, VIEW_W, 3);

    // scrolling ground markings
    const dashW = 14;
    const offset = -(groundScroll % (dashW + 8));
    ctx.fillStyle = 'rgba(140, 130, 70, 0.5)';
    for (let x = offset; x < VIEW_W + dashW; x += dashW + 8) {
      ctx.fillRect(x, FLOOR_Y + 22, dashW, 4);
      ctx.fillRect(x + 6, FLOOR_Y + 40, dashW, 4);
    }
    ctx.fillStyle = 'rgba(120, 110, 60, 0.35)';
    for (let x = offset; x < VIEW_W + dashW; x += dashW + 8) {
      ctx.fillRect(x + 6, FLOOR_Y + 58, dashW, 4);
    }
  }

  function drawBird() {
    const x = bird.x;
    const y = bird.y;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(bird.rot);

    // body
    const body = ctx.createLinearGradient(0, -BIRD_H / 2, 0, BIRD_H / 2);
    body.addColorStop(0, '#ffe066');
    body.addColorStop(0.55, '#f7c948');
    body.addColorStop(1, '#d99b1f');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(0, 0, BIRD_W / 2, BIRD_H / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#4a3610';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // wing - flaps upward on a fresh impulse, settles back down
    const wingLift = bird.wing * 4;
    ctx.fillStyle = '#fff6cf';
    ctx.strokeStyle = '#4a3610';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(-2, 1 - wingLift, 6, 4, -0.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // eye
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(3.4, -2.4, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#4a3610';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#2a2118';
    ctx.beginPath();
    ctx.arc(4.4, -2.4, 1.4, 0, Math.PI * 2);
    ctx.fill();

    // beak
    ctx.fillStyle = '#f4795b';
    ctx.beginPath();
    ctx.moveTo(6.5, -1);
    ctx.lineTo(12.5, 0.6);
    ctx.lineTo(6.5, 2.6);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#8a3520';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.restore();
  }

  function drawScore() {
    if (state === STATE.READY) return;
    const text = String(score);
    ctx.save();
    ctx.font = 'bold 30px "Trebuchet MS", Verdana, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#221a12';
    ctx.fillStyle = '#fff';
    ctx.strokeText(text, VIEW_W / 2, 34);
    ctx.fillText(text, VIEW_W / 2, 34);
    ctx.restore();
  }

  function render() {
    ctx.clearRect(0, 0, VIEW_W, VIEW_H);
    drawSky();
    for (let i = 0; i < clouds.length; i++) drawCloud(clouds[i].x, clouds[i].y, clouds[i].s);
    drawSkyline();
    for (let i = 0; i < pipes.length; i++) drawPipe(pipes[i]);
    drawGround();
    drawBird();
    drawScore();
  }

  /* ---- scaling --------------------------------------------------------- */

  function resize() {
    const pad = 24;
    const maxW = Math.max(120, window.innerWidth - pad);
    const maxH = Math.max(200, window.innerHeight - pad);
    let scale = Math.min(maxW / VIEW_W, maxH / VIEW_H);
    scale = Math.max(0.4, Math.min(3, scale));
    shell.style.width = Math.round(VIEW_W * scale) + 'px';
    shell.style.height = Math.round(VIEW_H * scale) + 'px';
  }

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);

  /* ---- input ----------------------------------------------------------- */

  const FLAP_KEYS = { ' ': 1, 'Spacebar': 1, 'ArrowUp': 1, 'w': 1, 'W': 1 };

  function isUiTarget(target) {
    return !!(target && target.closest && target.closest('button'));
  }

  shell.addEventListener('pointerdown', function (e) {
    if (isUiTarget(e.target)) return;
    unlock();
    if (state === STATE.READY) start();
    else if (state === STATE.OVER) start();
    else flap();
  });

  shell.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  window.addEventListener('keydown', function (e) {
    if (e.repeat) { if (FLAP_KEYS[e.key]) e.preventDefault(); return; }
    if (FLAP_KEYS[e.key]) {
      e.preventDefault();
      unlock();
      if (state === STATE.READY || state === STATE.OVER) start();
      else flap();
      return;
    }
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); start(); return; }
    if (e.key === 'm' || e.key === 'M') { e.preventDefault(); toggleMute(); }
  }, { passive: false });

  /* ---- loop ------------------------------------------------------------ */

  let last = 0;
  let acc = 0;
  let running = true;

  function frame(now) {
    if (!running) return;
    if (!last) last = now;
    let dt = now - last;
    last = now;
    if (dt > 250) dt = 250;             // a backgrounded tab hands back a huge delta
    acc += dt;
    let steps = 0;
    while (acc >= STEP && steps < MAX_STEPS) { update(); acc -= STEP; steps++; }
    if (steps === MAX_STEPS) acc = 0;   // drop the backlog rather than spiralling
    render();
    window.requestAnimationFrame(frame);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      running = false;
    } else if (!running) {
      running = true;
      last = 0;
      acc = 0;
      window.requestAnimationFrame(frame);
    }
  });

  /* ---- debug hook -------------------------------------------------------
     Drives the game from the console or from a headless harness. */

  window.__flappy = {
    state: function () { return state; },
    score: function () { return score; },
    best: function () { return best; },
    pipes: function () { return pipes.map(function (p) { return { x: p.x, center: p.center, gap: p.gap, scored: p.scored }; }); },
    bird: function () { return { x: bird.x, y: bird.y, vy: bird.vy, rot: bird.rot }; },
    geometry: function () {
      return { VIEW_W: VIEW_W, VIEW_H: VIEW_H, FLOOR_Y: FLOOR_Y, BIRD_X: BIRD_X, BIRD_W: BIRD_W, BIRD_H: BIRD_H, PIPE_W: PIPE_W };
    },
    speed: function () { return speed; },
    gap: function () { return gap; },
    flap: flap,
    start: start,
    restart: start,
    showTitle: showTitle,
    forceGameOver: function () { if (state === STATE.PLAYING || state === STATE.DYING) gameOver(); },
    setScore: function (n) {
      score = n | 0;
      const d = difficultyFor(score);
      gap = d.gap;
      speed = d.speed;
    },
    setBird: function (y, vy) { bird.y = y; bird.vy = vy == null ? 0 : vy; },
    clearPipes: function () { pipes = []; }
  };

  /* ---- boot ------------------------------------------------------------ */

  muteBtn.classList.toggle('muted', muted);
  muteBtn.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
  reset();
  showTitle();
  resize();
  window.requestAnimationFrame(frame);
})();
