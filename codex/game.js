(function () {
  'use strict';

  const VIEW_W = 360;
  const VIEW_H = 640;
  const FLOOR_H = 106;
  const FLOOR_Y = VIEW_H - FLOOR_H;
  const STEP = 1000 / 60;
  const MAX_STEPS = 5;

  const GRAVITY = 0.31;
  const FLAP_V = -5.45;
  const MAX_FALL = 9.4;
  const BIRD_X = 92;
  const BIRD_W = 25;
  const BIRD_H = 19;
  const PIPE_W = 60;
  const PIPE_SPACING = 190;
  const PIPE_MARGIN = 57;
  const GAP_START = 154;
  const GAP_MIN = 112;
  const SPEED_START = 2.15;
  const SPEED_MAX = 3.1;
  const BEST_KEY = 'skyline-flap.best.v1';
  const MUTE_KEY = 'skyline-flap.mute.v1';

  const canvas = document.getElementById('game');
  const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  const wrap = document.getElementById('game-wrap');
  const fallbackScene = document.getElementById('fallback-scene');
  const fallbackBird = fallbackScene.querySelector('.fallback-bird');
  const fallbackTopPipe = fallbackScene.querySelector('.fallback-pipe-top');
  const fallbackBottomPipe = fallbackScene.querySelector('.fallback-pipe-bottom');
  const titleScreen = document.getElementById('title-screen');
  const overScreen = document.getElementById('over-screen');
  const startBtn = document.getElementById('start-btn');
  const restartBtn = document.getElementById('restart-btn');
  const soundBtn = document.getElementById('sound-btn');
  const soundText = document.getElementById('sound-text');
  const panelBest = document.getElementById('panel-best');
  const panelScore = document.getElementById('panel-score');
  const progressMeter = document.getElementById('progress-meter');
  const finalScore = document.getElementById('final-score');
  const finalBest = document.getElementById('final-best');
  const newBest = document.getElementById('new-best');

  const STATE = { READY: 'ready', PLAYING: 'playing', DYING: 'dying', OVER: 'over' };
  let state = STATE.READY;
  let score = 0;
  let best = readInt(BEST_KEY, 0);
  let muted = readInt(MUTE_KEY, 0) === 1;
  let pipes = [];
  let speed = SPEED_START;
  let gap = GAP_START;
  let groundScroll = 0;
  let skylineScroll = 0;
  let timeMs = 0;
  let deathAt = 0;
  let audio = null;

  const bird = { x: BIRD_X, y: VIEW_H * .42, vy: 0, rotation: 0, wing: 0 };
  const clouds = [
    { x: 18, y: 126, scale: .8 },
    { x: 315, y: 205, scale: .56 },
    { x: 175, y: 62, scale: .42 }
  ];

  function readInt(key, fallback) {
    try {
      const value = parseInt(localStorage.getItem(key), 10);
      return Number.isFinite(value) ? value : fallback;
    } catch (error) { return fallback; }
  }

  function save(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (error) { /* private mode */ }
  }

  function formatScore(value) { return String(value).padStart(3, '0'); }

  function difficultyFor(value) {
    const progress = Math.min(1, value / 38);
    return {
      gap: GAP_START - (GAP_START - GAP_MIN) * progress,
      speed: SPEED_START + (SPEED_MAX - SPEED_START) * progress
    };
  }

  function unlockAudio() {
    try {
      if (!audio) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        audio = new AudioContext();
      }
      if (audio.state === 'suspended') audio.resume();
    } catch (error) { audio = null; }
  }

  function tone(from, to, duration, type, volume, delay) {
    if (!audio || muted) return;
    try {
      const start = audio.currentTime + (delay || 0);
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = type || 'square';
      oscillator.frequency.setValueAtTime(from, start);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, to || from), start + duration);
      gain.gain.setValueAtTime(.0001, start);
      gain.gain.linearRampToValueAtTime(volume || .08, start + .012);
      gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.start(start);
      oscillator.stop(start + duration + .03);
    } catch (error) { /* sound is never load-bearing */ }
  }

  const sfx = {
    flap: function () { tone(490, 770, .08, 'square', .07); },
    score: function () { tone(880, 880, .06, 'square', .07); tone(1320, 1320, .08, 'square', .055, .07); },
    hit: function () { tone(230, 65, .2, 'sawtooth', .12); }
  };

  function updateMuteUi() {
    soundBtn.classList.toggle('muted', muted);
    soundBtn.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
    soundText.textContent = muted ? 'Sound off' : 'Sound on';
  }

  function toggleMute() {
    muted = !muted;
    save(MUTE_KEY, muted ? 1 : 0);
    updateMuteUi();
    if (!muted) { unlockAudio(); sfx.flap(); }
  }

  function reset() {
    score = 0;
    const difficulty = difficultyFor(score);
    gap = difficulty.gap;
    speed = difficulty.speed;
    pipes = [];
    timeMs = 0;
    groundScroll = 0;
    skylineScroll = 0;
    bird.y = VIEW_H * .42;
    bird.vy = 0;
    bird.rotation = 0;
    bird.wing = 0;
    for (let index = 0; index < 3; index += 1) spawnPipe(VIEW_W + 94 + index * PIPE_SPACING);
    updateScoreUi();
  }

  function spawnPipe(x) {
    const minimum = PIPE_MARGIN + gap / 2;
    const maximum = FLOOR_Y - PIPE_MARGIN - gap / 2;
    const center = minimum + Math.random() * Math.max(0, maximum - minimum);
    pipes.push({ x: x, center: center, gap: gap, scored: false });
  }

  function showTitle() {
    state = STATE.READY;
    reset();
    titleScreen.classList.remove('hidden');
    overScreen.classList.add('hidden');
    updateScoreUi();
  }

  function start() {
    unlockAudio();
    state = STATE.PLAYING;
    reset();
    titleScreen.classList.add('hidden');
    overScreen.classList.add('hidden');
    flap();
  }

  function flap() {
    if (state !== STATE.PLAYING) return;
    bird.vy = FLAP_V;
    bird.wing = 1;
    sfx.flap();
  }

  function hitbox() {
    return { x: bird.x - BIRD_W / 2 + 4, y: bird.y - BIRD_H / 2 + 3, w: BIRD_W - 8, h: BIRD_H - 6 };
  }

  function collides(box, pipe) {
    if (box.x + box.w < pipe.x || box.x > pipe.x + PIPE_W) return false;
    const top = pipe.center - pipe.gap / 2;
    const bottom = pipe.center + pipe.gap / 2;
    return box.y < top || box.y + box.h > bottom;
  }

  function die() {
    if (state !== STATE.PLAYING) return;
    state = STATE.DYING;
    deathAt = timeMs;
    sfx.hit();
  }

  function finish() {
    state = STATE.OVER;
    const isNewBest = score > best;
    if (isNewBest) { best = score; save(BEST_KEY, best); }
    finalScore.textContent = formatScore(score);
    finalBest.textContent = formatScore(best);
    newBest.classList.toggle('hidden', !isNewBest);
    overScreen.classList.remove('hidden');
    updateScoreUi();
  }

  function updateScoreUi() {
    panelBest.textContent = formatScore(best);
    panelScore.textContent = formatScore(score);
    progressMeter.style.width = Math.min(100, score / Math.max(1, best, 10) * 100) + '%';
  }

  function update() {
    timeMs += STEP;
    if (state === STATE.READY) {
      bird.y = VIEW_H * .42 + Math.sin(timeMs / 260) * 7;
      bird.rotation = Math.sin(timeMs / 260) * .1;
      bird.wing = (Math.sin(timeMs / 90) + 1) / 2;
      groundScroll += SPEED_START * .3;
      skylineScroll += SPEED_START * .16;
      return;
    }

    const moving = state === STATE.PLAYING;
    const step = moving ? speed : 0;
    groundScroll += step;
    skylineScroll += step * .42;

    clouds.forEach(function (cloud) {
      cloud.x -= step * .16 * cloud.scale;
      if (cloud.x < -70) cloud.x = VIEW_W + 50;
    });

    if (state === STATE.PLAYING) {
      bird.vy = Math.min(bird.vy + GRAVITY, MAX_FALL);
      bird.y += bird.vy;
      const target = Math.max(-.45, Math.min(1.45, bird.vy / MAX_FALL * 1.25));
      bird.rotation += (target - bird.rotation) * .2;
      bird.wing *= .78;
      if (bird.y - BIRD_H / 2 < 0) { bird.y = BIRD_H / 2; bird.vy = Math.max(0, bird.vy); }

      pipes.forEach(function (pipe) { pipe.x -= step; });
      while (pipes.length && pipes[0].x + PIPE_W < -PIPE_W) pipes.shift();
      const last = pipes[pipes.length - 1];
      if (!last || last.x <= VIEW_W - PIPE_SPACING) spawnPipe(VIEW_W + PIPE_W);

      const box = hitbox();
      for (let index = 0; index < pipes.length; index += 1) {
        const pipe = pipes[index];
        if (!pipe.scored && box.x > pipe.x + PIPE_W) {
          pipe.scored = true;
          score += 1;
          const difficulty = difficultyFor(score);
          gap = difficulty.gap;
          speed = difficulty.speed;
          sfx.score();
          updateScoreUi();
        }
        if (collides(box, pipe)) { die(); return; }
      }
      if (bird.y + BIRD_H / 2 >= FLOOR_Y) { bird.y = FLOOR_Y - BIRD_H / 2; die(); }
      return;
    }

    if (state === STATE.DYING) {
      bird.vy = Math.min(bird.vy + GRAVITY * 1.25, MAX_FALL * 1.2);
      bird.y += bird.vy;
      bird.rotation = Math.min(1.6, bird.rotation + .1);
      if (bird.y + BIRD_H / 2 >= FLOOR_Y || timeMs - deathAt > 800) {
        bird.y = Math.min(bird.y, FLOOR_Y - BIRD_H / 2);
        finish();
      }
    }
  }

  function roundRect(x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  function drawSky() {
    const gradient = ctx.createLinearGradient(0, 0, 0, FLOOR_Y);
    gradient.addColorStop(0, '#83ced0');
    gradient.addColorStop(.46, '#a4dcdc');
    gradient.addColorStop(1, '#f2c682');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, VIEW_W, FLOOR_Y);
    ctx.fillStyle = 'rgba(255, 244, 201, .42)';
    ctx.fillRect(0, FLOOR_Y * .62, VIEW_W, FLOOR_Y * .38);
  }

  function drawCloud(cloud) {
    ctx.save();
    ctx.globalAlpha = .56;
    ctx.fillStyle = '#fff3cf';
    ctx.beginPath();
    ctx.ellipse(cloud.x, cloud.y, 34 * cloud.scale, 12 * cloud.scale, 0, 0, Math.PI * 2);
    ctx.ellipse(cloud.x - 21 * cloud.scale, cloud.y + 3 * cloud.scale, 17 * cloud.scale, 8 * cloud.scale, 0, 0, Math.PI * 2);
    ctx.ellipse(cloud.x + 22 * cloud.scale, cloud.y + 3 * cloud.scale, 21 * cloud.scale, 10 * cloud.scale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawSun() {
    const gradient = ctx.createRadialGradient(278, 76, 4, 278, 76, 42);
    gradient.addColorStop(0, 'rgba(255,248,194,.94)');
    gradient.addColorStop(1, 'rgba(255,223,133,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(236, 34, 84, 84);
  }

  function drawSkyline() {
    const base = FLOOR_Y;
    const offset = -(skylineScroll % 132);
    ctx.fillStyle = 'rgba(59, 129, 121, .33)';
    for (let index = -2; index < 8; index += 1) {
      const x = offset + index * 132;
      const seed = (index + 10) % 5;
      ctx.fillRect(x, base - 53 - seed * 11, 44, 53 + seed * 11);
      ctx.fillRect(x + 51, base - 31 - (4 - seed) * 7, 29, 31 + (4 - seed) * 7);
      ctx.fillRect(x + 87, base - 72 + seed * 5, 20, 72 - seed * 5);
      ctx.fillRect(x + 89, base - 82 + seed * 5, 2, 10);
      ctx.fillStyle = 'rgba(231, 178, 111, .26)';
      for (let windowIndex = 0; windowIndex < 3; windowIndex += 1) ctx.fillRect(x + 8 + windowIndex * 12, base - 33 - seed * 7, 4, 4);
      ctx.fillStyle = 'rgba(59, 129, 121, .33)';
    }
  }

  function drawPipe(pipe) {
    const top = pipe.center - pipe.gap / 2;
    const bottom = pipe.center + pipe.gap / 2;
    const x = pipe.x;
    const body = ctx.createLinearGradient(x, 0, x + PIPE_W, 0);
    body.addColorStop(0, '#3c725e');
    body.addColorStop(.22, '#98c76c');
    body.addColorStop(.55, '#78aa60');
    body.addColorStop(1, '#345e50');
    ctx.fillStyle = body;
    ctx.fillRect(x, 0, PIPE_W, top - 24);
    ctx.fillRect(x, bottom + 24, PIPE_W, FLOOR_Y - bottom - 24);
    ctx.fillRect(x - 5, top - 24, PIPE_W + 10, 24);
    ctx.fillRect(x - 5, bottom, PIPE_W + 10, 24);
    ctx.strokeStyle = '#2b5148';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, 1, PIPE_W - 2, top - 25);
    ctx.strokeRect(x - 4, top - 23, PIPE_W + 8, 22);
    ctx.strokeRect(x - 4, bottom + 1, PIPE_W + 8, 22);
    ctx.strokeRect(x + 1, bottom + 25, PIPE_W - 2, FLOOR_Y - bottom - 26);
    ctx.fillStyle = 'rgba(255, 247, 195, .16)';
    ctx.fillRect(x + 10, 0, 7, Math.max(0, top - 26));
    ctx.fillRect(x + 5, top - 20, 8, 15);
    ctx.fillRect(x + 5, bottom + 5, 8, 15);
  }

  function drawGround() {
    ctx.fillStyle = '#e8cd91';
    ctx.fillRect(0, FLOOR_Y, VIEW_W, FLOOR_H);
    ctx.fillStyle = '#6b9d60';
    ctx.fillRect(0, FLOOR_Y, VIEW_W, 13);
    ctx.fillStyle = '#b6d078';
    ctx.fillRect(0, FLOOR_Y + 13, VIEW_W, 5);
    const offset = -(groundScroll % 28);
    ctx.fillStyle = 'rgba(145, 111, 68, .33)';
    for (let x = offset; x < VIEW_W + 30; x += 28) {
      ctx.fillRect(x, FLOOR_Y + 32, 17, 4);
      ctx.fillRect(x + 9, FLOOR_Y + 60, 19, 4);
      ctx.fillRect(x - 6, FLOOR_Y + 84, 11, 4);
    }
  }

  function drawBird() {
    ctx.save();
    ctx.translate(bird.x, bird.y);
    ctx.rotate(bird.rotation);
    ctx.shadowColor = 'rgba(44, 62, 54, .24)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 3;
    const body = ctx.createLinearGradient(0, -10, 0, 10);
    body.addColorStop(0, '#ff9d68');
    body.addColorStop(.56, '#f5785f');
    body.addColorStop(1, '#ca554c');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(0, 0, BIRD_W / 2, BIRD_H / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = '#693c39';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.fillStyle = '#ffe7a1';
    ctx.beginPath();
    ctx.ellipse(-4, 3 - bird.wing * 4, 8, 5, -.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#693c39';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = '#fffbe6';
    ctx.beginPath();
    ctx.arc(5, -4, 4.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#693c39';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#172229';
    ctx.beginPath();
    ctx.arc(6.5, -4, 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e04e45';
    ctx.beginPath();
    ctx.moveTo(-2, -9);
    ctx.lineTo(9, -9);
    ctx.lineTo(7, -6);
    ctx.lineTo(-3, -6);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#f3bd53';
    ctx.beginPath();
    ctx.moveTo(10, -1);
    ctx.lineTo(18, 1);
    ctx.lineTo(10, 4);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#8b493e';
    ctx.stroke();
    ctx.restore();
  }

  function drawScore() {
    if (state === STATE.READY) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = '900 34px "Arial Black", "Trebuchet MS", sans-serif';
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(34, 56, 51, .85)';
    ctx.fillStyle = '#fff4c9';
    ctx.strokeText(String(score), VIEW_W / 2, 37);
    ctx.fillText(String(score), VIEW_W / 2, 37);
    ctx.restore();
  }

  function setFallbackRect(element, x, y, width, height) {
    element.style.display = height > 0 ? 'block' : 'none';
    element.style.left = (x / VIEW_W * 100) + '%';
    element.style.top = (y / VIEW_H * 100) + '%';
    element.style.width = (width / VIEW_W * 100) + '%';
    element.style.height = (height / VIEW_H * 100) + '%';
  }

  function renderFallback() {
    const firstPipe = pipes[0];
    if (firstPipe) {
      const top = firstPipe.center - firstPipe.gap / 2;
      const bottom = firstPipe.center + firstPipe.gap / 2;
      setFallbackRect(fallbackTopPipe, firstPipe.x, 0, PIPE_W, top);
      setFallbackRect(fallbackBottomPipe, firstPipe.x, bottom, PIPE_W, FLOOR_Y - bottom);
    }
    fallbackBird.style.left = ((bird.x - BIRD_W / 2) / VIEW_W * 100) + '%';
    fallbackBird.style.top = ((bird.y - BIRD_H / 2) / VIEW_H * 100) + '%';
    fallbackBird.style.transform = 'rotate(' + bird.rotation + 'rad)';
  }

  function render() {
    if (!ctx) { renderFallback(); return; }
    ctx.clearRect(0, 0, VIEW_W, VIEW_H);
    drawSky();
    drawSun();
    clouds.forEach(drawCloud);
    drawSkyline();
    pipes.forEach(drawPipe);
    drawGround();
    drawBird();
    drawScore();
  }

  function resize() {
    const availableWidth = Math.max(200, window.innerWidth - 28);
    const availableHeight = Math.max(320, window.innerHeight - 30);
    const scale = Math.min(1.32, availableWidth / VIEW_W, availableHeight / VIEW_H);
    wrap.style.width = Math.round(VIEW_W * Math.max(.62, scale)) + 'px';
  }

  const flapKeys = { ' ': true, Spacebar: true, ArrowUp: true, w: true, W: true };

  function isButton(target) { return !!(target && target.closest && target.closest('button')); }

  wrap.addEventListener('pointerdown', function (event) {
    if (isButton(event.target)) return;
    unlockAudio();
    if (state === STATE.READY || state === STATE.OVER) start();
    else flap();
  });

  window.addEventListener('keydown', function (event) {
    if (event.repeat && flapKeys[event.key]) { event.preventDefault(); return; }
    if (flapKeys[event.key]) {
      event.preventDefault();
      unlockAudio();
      if (state === STATE.READY || state === STATE.OVER) start(); else flap();
    } else if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();
      start();
    } else if (event.key === 'm' || event.key === 'M') {
      event.preventDefault();
      toggleMute();
    }
  }, { passive: false });

  startBtn.addEventListener('click', function (event) { event.stopPropagation(); start(); });
  restartBtn.addEventListener('click', function (event) { event.stopPropagation(); start(); });
  soundBtn.addEventListener('click', function (event) { event.stopPropagation(); toggleMute(); });
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { lastFrame = 0; accumulator = 0; } });

  let lastFrame = 0;
  let accumulator = 0;
  function frame(now) {
    if (!lastFrame) lastFrame = now;
    let delta = Math.min(250, now - lastFrame);
    lastFrame = now;
    accumulator += delta;
    let steps = 0;
    while (accumulator >= STEP && steps < MAX_STEPS) { update(); accumulator -= STEP; steps += 1; }
    if (steps === MAX_STEPS) accumulator = 0;
    render();
    window.requestAnimationFrame(frame);
  }

  updateMuteUi();
  wrap.classList.toggle('canvas-fallback', !ctx);
  reset();
  showTitle();
  resize();
  window.requestAnimationFrame(frame);

  window.__skylineFlap = {
    state: function () { return state; },
    score: function () { return score; },
    best: function () { return best; },
    flap: flap,
    start: start,
    restart: start,
    forceGameOver: finish,
    setScore: function (value) { score = value | 0; updateScoreUi(); }
  };
})();
