/* ===================================================================
   Flappy Bird — loop, physics, collision, rendering and audio.

   No images, no fonts, no audio files: the bird, pipes, ground and
   skyline are all drawn with canvas primitives at startup or per frame,
   and the sound effects are synthesised with the Web Audio API.

   The simulation runs on a fixed 60Hz timestep driven by an accumulator,
   so physics behave identically on a 60Hz and a 144Hz display.
   =================================================================== */

(() => {
  'use strict';

  /* ------------------------------------------------------------------
     Tuning
     ------------------------------------------------------------------ */

  // Logical resolution: the original's phone viewport. Everything below is
  // in these units; CSS scales the result up to the window.
  const W = 288;
  const H = 512;

  const GROUND_H = 112;              // height of the scrolling base strip
  const GROUND_Y = H - GROUND_H;     // 400 — top of the ground, the death line

  // A flap's apex rise is FLAP_V^2 / (2 * GRAVITY) = ~39px, right about a
  // third of the opening gap. That's what produces the original's rapid
  // small-tap cadence: aim for the gap centre and you still have ~20px of
  // headroom, rather than arriving exactly on the pipe lip.
  const GRAVITY = 0.52;              // px per frame, per frame
  const FLAP_V = -6.4;               // instant upward velocity on a flap
  const MAX_FALL = 10.5;             // terminal velocity, keeps dives readable

  const BIRD_X = 78;                 // the bird never moves horizontally
  const READY_Y = 236;               // bobs here on the title screen, in the
                                     // band the overlay text leaves clear
  const BIRD_ART_SCALE = 1.28;       // sprite is ~31x23, near the original's 34x24
  const BIRD_HALF_W = 12;            // collision box is a touch smaller than
  const BIRD_HALF_H = 9;             // the sprite, which feels fairer

  const PIPE_W = 52;
  const PIPE_CAP_H = 26;
  const PIPE_CAP_OVERHANG = 3;       // cap is this much wider on each side
  const PIPE_SPACING = 132;          // horizontal distance between pipe pairs

  const GAP_START = 118;             // vertical opening at score 0
  const GAP_MIN = 92;                // ...and once the ramp has topped out
  const SPEED_START = 2.0;           // scroll speed in px/frame at score 0
  const SPEED_MAX = 2.75;
  const RAMP_SCORE = 30;             // score at which difficulty maxes out

  const PIPE_TOP_MIN = 48;           // shortest a top pipe may be
  const PIPE_BOTTOM_MIN = 84;        // shortest a bottom pipe may be

  const STEP_MS = 1000 / 60;         // one simulation tick
  const MAX_CATCHUP_MS = 200;        // clamp dt so a backgrounded tab can't
                                     // fast-forward the whole run at once

  const MEDAL_TIERS = [
    { min: 40, tier: 'platinum', label: 'Platinum' },
    { min: 30, tier: 'gold', label: 'Gold' },
    { min: 20, tier: 'silver', label: 'Silver' },
    { min: 10, tier: 'bronze', label: 'Bronze' },
  ];

  const BEST_KEY = 'flappy.best.v1';
  const MUTE_KEY = 'flappy.muted.v1';

  /* ------------------------------------------------------------------
     Difficulty curve

     The endpoints are fixed by the design (gap 118 -> 92, speed 2.0 ->
     2.75) but the *shape* of the ramp between them is what the run
     actually feels like. This uses a smoothstep: forgiving for the first
     few points, steepest through the middle, then easing out so the hard
     cap doesn't arrive as a wall.
     ------------------------------------------------------------------ */

  /**
   * @param {number} score points banked so far
   * @returns {{gap: number, speed: number}} pipe opening and scroll speed
   */
  function difficultyFor(score) {
    const t = Math.min(Math.max(score / RAMP_SCORE, 0), 1);
    const eased = t * t * (3 - 2 * t); // smoothstep
    return {
      gap: GAP_START + (GAP_MIN - GAP_START) * eased,
      speed: SPEED_START + (SPEED_MAX - SPEED_START) * eased,
    };
  }

  /* ------------------------------------------------------------------
     DOM
     ------------------------------------------------------------------ */

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const stage = document.getElementById('stage');
  const readyEl = document.getElementById('ready');
  const overEl = document.getElementById('over');
  const medalEl = document.getElementById('medal');
  const medalLabelEl = document.getElementById('medal-label');
  const finalScoreEl = document.getElementById('final-score');
  const finalBestEl = document.getElementById('final-best');
  const newBadgeEl = document.getElementById('new-badge');
  const restartBtn = document.getElementById('restart');
  const muteBtn = document.getElementById('mute');

  ctx.imageSmoothingEnabled = false;

  /* ------------------------------------------------------------------
     Small helpers
     ------------------------------------------------------------------ */

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // Deterministic PRNG so the pre-rendered skyline looks hand-placed but
  // identical on every load — handy when comparing screenshots.
  function mulberry32(seed) {
    return function () {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function offscreen(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    return { canvas: c, ctx: g };
  }

  function readBest() {
    try {
      const raw = Number(localStorage.getItem(BEST_KEY));
      return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    } catch {
      return 0; // private mode / blocked storage — just play without a best
    }
  }

  function writeBest(value) {
    try {
      localStorage.setItem(BEST_KEY, String(value));
    } catch {
      /* non-fatal */
    }
  }

  /* ------------------------------------------------------------------
     Audio — everything is synthesised on demand
     ------------------------------------------------------------------ */

  const sound = {
    ctx: null,
    master: null,
    noise: null,
    muted: false,

    boot() {
      if (this.ctx) return;
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.7;
      this.master.connect(this.ctx.destination);

      // One short buffer of white noise, reused for the impact sounds.
      const len = Math.floor(this.ctx.sampleRate * 0.3);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    },

    resume() {
      this.boot();
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },

    setMuted(value) {
      this.muted = value;
      if (this.master) {
        // Ramp rather than snap, so toggling mid-tone doesn't click.
        const now = this.ctx.currentTime;
        this.master.gain.cancelScheduledValues(now);
        this.master.gain.setTargetAtTime(value ? 0 : 0.7, now, 0.015);
      }
      muteBtn.setAttribute('aria-pressed', String(value));
      muteBtn.setAttribute('aria-label', value ? 'Unmute sound' : 'Mute sound');
      try {
        localStorage.setItem(MUTE_KEY, value ? '1' : '0');
      } catch {
        /* non-fatal */
      }
    },

    /** A pitched blip: oscillator + exponential gain decay. */
    tone(type, from, to, dur, peak, delay = 0) {
      if (!this.ctx || this.muted) return;
      const t0 = this.ctx.currentTime + delay;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(from, t0);
      osc.frequency.exponentialRampToValueAtTime(Math.max(to, 1), t0 + dur);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain).connect(this.master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    },

    /** A filtered noise burst, for thuds and impacts. */
    thud(dur, cutoff, peak, delay = 0) {
      if (!this.ctx || this.muted || !this.noise) return;
      const t0 = this.ctx.currentTime + delay;
      const src = this.ctx.createBufferSource();
      const filter = this.ctx.createBiquadFilter();
      const gain = this.ctx.createGain();
      src.buffer = this.noise;
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(cutoff, t0);
      filter.frequency.exponentialRampToValueAtTime(120, t0 + dur);
      gain.gain.setValueAtTime(peak, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(filter).connect(gain).connect(this.master);
      src.start(t0);
      src.stop(t0 + dur + 0.02);
    },

    flap() {
      this.tone('triangle', 640, 260, 0.1, 0.2);
      this.thud(0.07, 1800, 0.06);
    },

    point() {
      this.tone('square', 880, 880, 0.07, 0.12);
      this.tone('square', 1320, 1320, 0.1, 0.1, 0.06);
    },

    hit() {
      this.thud(0.16, 2600, 0.5);
      this.tone('sawtooth', 220, 70, 0.16, 0.22);
    },

    die() {
      this.tone('sawtooth', 500, 70, 0.5, 0.16, 0.08);
    },

    land() {
      this.thud(0.12, 900, 0.3);
    },
  };

  /* ------------------------------------------------------------------
     Pre-rendered scenery

     The sky layers and the ground never change, so they are drawn once
     into tileable offscreen canvases and then blitted twice per frame at
     a scrolling offset. Far cheaper than re-drawing a few hundred
     building and stripe paths every frame.
     ------------------------------------------------------------------ */

  const SKYLINE_H = 110;
  const BUSH_H = 64;

  const skyline = (() => {
    const { canvas: c, ctx: g } = offscreen(W, SKYLINE_H);
    const rand = mulberry32(20240917);

    // Hazy back row.
    g.fillStyle = '#69c9cf';
    let x = 0;
    while (x < W) {
      const w = 22 + Math.floor(rand() * 26);
      const h = 26 + Math.floor(rand() * 26);
      // Keep buildings clear of the tile seam so tiling stays invisible.
      g.fillRect(x, SKYLINE_H - h, Math.min(w, W - x), h);
      x += w + 4 + Math.floor(rand() * 10);
    }

    // Front row, more saturated, with windows.
    x = -6;
    while (x < W) {
      const w = 26 + Math.floor(rand() * 30);
      const h = 36 + Math.floor(rand() * 40);
      const top = SKYLINE_H - h;
      const drawW = Math.min(w, W - x);

      g.fillStyle = '#4aaeb6';
      g.fillRect(x, top, drawW, h);
      // Sunlit left edge and a roof cap.
      g.fillStyle = '#5fc3ca';
      g.fillRect(x, top, Math.min(4, drawW), h);
      g.fillRect(x, top, drawW, 3);

      g.fillStyle = 'rgba(214, 248, 250, 0.55)';
      for (let wy = top + 9; wy < SKYLINE_H - 6; wy += 9) {
        for (let wx = x + 7; wx < x + drawW - 4; wx += 8) {
          if (rand() > 0.45) g.fillRect(wx, wy, 3, 4);
        }
      }

      x += w + 8 + Math.floor(rand() * 14);
    }

    return c;
  })();

  const bushes = (() => {
    const { canvas: c, ctx: g } = offscreen(W, BUSH_H);
    const rand = mulberry32(777);

    // Dark backing mounds.
    g.fillStyle = '#4f9c3f';
    for (let x = -10; x < W + 20; x += 18) {
      const r = 14 + rand() * 9;
      g.beginPath();
      g.arc(x, BUSH_H - 12 + rand() * 4, r, Math.PI, 0);
      g.fill();
    }
    g.fillRect(0, BUSH_H - 14, W, 14);

    // Bright front mounds.
    g.fillStyle = '#74bf2e';
    for (let x = -8; x < W + 20; x += 22) {
      const r = 12 + rand() * 10;
      g.beginPath();
      g.arc(x, BUSH_H - 4 + rand() * 3, r, Math.PI, 0);
      g.fill();
    }
    g.fillRect(0, BUSH_H - 6, W, 6);

    // Highlight along the tops of the front mounds.
    g.fillStyle = 'rgba(190, 233, 120, 0.5)';
    for (let x = -8; x < W + 20; x += 22) {
      g.beginPath();
      g.arc(x, BUSH_H - 4, 12, Math.PI * 1.15, Math.PI * 1.7);
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(190, 233, 120, 0.5)';
      g.stroke();
    }

    return c;
  })();

  // Ground tile. 24px wide: the diagonal dashes are periodic with that
  // period, so the tile repeats seamlessly.
  const GROUND_TILE_W = 24;
  const ground = (() => {
    const { canvas: c, ctx: g } = offscreen(GROUND_TILE_W, GROUND_H);

    // Grass cap.
    g.fillStyle = '#74bf2e';
    g.fillRect(0, 0, GROUND_TILE_W, 10);
    g.fillStyle = '#5a9c2c';
    g.fillRect(0, 10, GROUND_TILE_W, 3);
    g.fillStyle = 'rgba(190, 233, 120, 0.45)';
    g.fillRect(0, 0, GROUND_TILE_W, 2);

    // Sand body.
    const sand = g.createLinearGradient(0, 13, 0, GROUND_H);
    sand.addColorStop(0, '#ded895');
    sand.addColorStop(1, '#cfc784');
    g.fillStyle = sand;
    g.fillRect(0, 13, GROUND_TILE_W, GROUND_H - 13);

    // Diagonal dashes in the top band.
    g.save();
    g.beginPath();
    g.rect(0, 13, GROUND_TILE_W, 30);
    g.clip();
    g.fillStyle = '#c8bf74';
    for (let x = -48; x < GROUND_TILE_W + 48; x += GROUND_TILE_W) {
      g.beginPath();
      g.moveTo(x, 43);
      g.lineTo(x + 30, 13);
      g.lineTo(x + 42, 13);
      g.lineTo(x + 12, 43);
      g.closePath();
      g.fill();
    }
    g.restore();

    g.fillStyle = '#b4ad6e';
    g.fillRect(0, 43, GROUND_TILE_W, 2);

    return c;
  })();

  // Pixel-font digits, pre-rendered once with their dark outline baked in.
  const DIGIT_GLYPHS = [
    ['111', '101', '101', '101', '111'], // 0
    ['110', '010', '010', '010', '111'], // 1
    ['111', '001', '111', '100', '111'], // 2
    ['111', '001', '111', '001', '111'], // 3
    ['101', '101', '111', '001', '001'], // 4
    ['111', '100', '111', '001', '111'], // 5
    ['111', '100', '111', '101', '111'], // 6
    ['111', '001', '001', '001', '001'], // 7
    ['111', '101', '111', '101', '111'], // 8
    ['111', '101', '111', '001', '111'], // 9
  ];
  const DIGIT_PX = 6;  // size of one font pixel
  const DIGIT_OUT = 3; // outline thickness
  const DIGIT_W = 3 * DIGIT_PX + DIGIT_OUT * 2;
  const DIGIT_H = 5 * DIGIT_PX + DIGIT_OUT * 2;
  const DIGIT_KERN = 2;

  const digits = DIGIT_GLYPHS.map((rows) => {
    const { canvas: c, ctx: g } = offscreen(DIGIT_W, DIGIT_H);
    // Expanding every lit block by the outline thickness and unioning the
    // results is exactly an outline — no per-edge bookkeeping needed.
    const paint = (color, grow) => {
      g.fillStyle = color;
      rows.forEach((row, ry) => {
        for (let rx = 0; rx < 3; rx++) {
          if (row[rx] !== '1') continue;
          g.fillRect(
            DIGIT_OUT + rx * DIGIT_PX - grow,
            DIGIT_OUT + ry * DIGIT_PX - grow,
            DIGIT_PX + grow * 2,
            DIGIT_PX + grow * 2
          );
        }
      });
    };
    paint('#3b2a1c', DIGIT_OUT);
    paint('#fdfdf6', 0);
    return c;
  });

  function drawNumber(value, cx, top) {
    const str = String(value);
    const total = str.length * DIGIT_W + (str.length - 1) * DIGIT_KERN;
    let x = Math.round(cx - total / 2);
    for (const ch of str) {
      ctx.drawImage(digits[Number(ch)], x, top);
      x += DIGIT_W + DIGIT_KERN;
    }
  }

  /* ------------------------------------------------------------------
     Game state
     ------------------------------------------------------------------ */

  /** @type {'ready'|'playing'|'dying'|'over'} */
  let state = 'ready';
  let score = 0;
  let best = readBest();
  let pipes = [];
  let speed = SPEED_START;

  const bird = { y: 0, vy: 0, tilt: 0 };

  let scrollGround = 0;
  let scrollBush = 0;
  let scrollSky = 0;
  let wingPhase = 0;
  let bobPhase = 0;
  let flash = 0;   // white hit flash, 1 -> 0
  let shake = 0;   // impact shake magnitude, decays
  let ticks = 0;

  function resetRun() {
    state = 'ready';
    score = 0;
    pipes = [];
    speed = SPEED_START;
    bird.y = READY_Y;
    bird.vy = 0;
    bird.tilt = 0;
    flash = 0;
    shake = 0;
    bobPhase = 0;
    ticks = 0;

    readyEl.classList.remove('is-hidden');
    readyEl.setAttribute('aria-hidden', 'false');
    overEl.classList.add('is-hidden');
    overEl.setAttribute('aria-hidden', 'true');
  }

  function startPlaying() {
    state = 'playing';
    bird.vy = 0;
    readyEl.classList.add('is-hidden');
    readyEl.setAttribute('aria-hidden', 'true');
    spawnPipe(W + 72);
    flap();
  }

  function flap() {
    bird.vy = FLAP_V;
    wingPhase = 0;
    sound.flap();
  }

  function spawnPipe(x) {
    const { gap } = difficultyFor(score);
    const maxTop = GROUND_Y - gap - PIPE_BOTTOM_MIN;
    const top = PIPE_TOP_MIN + Math.random() * Math.max(maxTop - PIPE_TOP_MIN, 0);
    pipes.push({ x, top: Math.round(top), gap: Math.round(gap), scored: false });
  }

  function medalFor(value) {
    return (
      MEDAL_TIERS.find((m) => value >= m.min) || { tier: 'none', label: 'No medal' }
    );
  }

  function die(hitPipe) {
    if (state !== 'playing') return;
    state = 'dying';
    flash = 1;
    shake = hitPipe ? 6 : 3;
    sound.hit();
    sound.die();
    if (!hitPipe) finishRun(); // already on the deck
  }

  function finishRun() {
    state = 'over';

    const isNewBest = score > best;
    if (isNewBest) {
      best = score;
      writeBest(best);
    }

    const medal = medalFor(score);
    medalEl.dataset.tier = medal.tier;
    medalLabelEl.textContent = medal.label;
    finalScoreEl.textContent = String(score);
    finalBestEl.firstChild.nodeValue = String(best);
    newBadgeEl.classList.toggle('is-hidden', !isNewBest);

    overEl.classList.remove('is-hidden');
    overEl.setAttribute('aria-hidden', 'false');
    // Don't steal focus on touch, but make the button reachable by keyboard.
    if (window.matchMedia('(hover: hover)').matches) restartBtn.focus();
  }

  /* ------------------------------------------------------------------
     Simulation — one fixed 60Hz tick
     ------------------------------------------------------------------ */

  function tick() {
    ticks++;
    if (flash > 0) flash = Math.max(0, flash - 0.09);
    if (shake > 0) shake = Math.max(0, shake - 0.45);

    const scrolling = state === 'ready' || state === 'playing';
    if (scrolling) {
      scrollGround = (scrollGround + speed) % GROUND_TILE_W;
      scrollBush = (scrollBush + speed * 0.42) % W;
      scrollSky = (scrollSky + speed * 0.16) % W;
    }

    // Wing beats fast on the way up, idles on the way down.
    if (state !== 'over') {
      wingPhase += state === 'dying' ? 0 : bird.vy < 0 ? 0.42 : 0.16;
    }

    if (state === 'ready') {
      bobPhase += 0.09;
      bird.y = READY_Y + Math.sin(bobPhase) * 6;
      bird.tilt = Math.sin(bobPhase) * 0.06;
      return;
    }

    if (state === 'over') return;

    // --- gravity, for both 'playing' and 'dying'
    bird.vy = Math.min(bird.vy + GRAVITY, MAX_FALL);
    bird.y += bird.vy;

    // Nose up when climbing, progressively nose-down as the dive builds.
    const targetTilt =
      bird.vy < 0 ? -0.42 : clamp((bird.vy / MAX_FALL) * 1.45, 0, 1.45);
    bird.tilt += (targetTilt - bird.tilt) * (bird.vy < 0 ? 0.45 : 0.14);

    if (state === 'dying') {
      if (bird.y + BIRD_HALF_H >= GROUND_Y) {
        bird.y = GROUND_Y - BIRD_HALF_H;
        bird.vy = 0;
        bird.tilt = 1.45;
        shake = Math.max(shake, 3);
        sound.land();
        finishRun();
      }
      return;
    }

    // --- ceiling is a clamp, not a kill (same as the original)
    if (bird.y < BIRD_HALF_H) {
      bird.y = BIRD_HALF_H;
      if (bird.vy < 0) bird.vy = 0;
    }

    // --- difficulty ramp
    speed = difficultyFor(score).speed;

    // --- pipes
    for (const pipe of pipes) pipe.x -= speed;

    const last = pipes[pipes.length - 1];
    if (!last || last.x <= W - PIPE_SPACING) spawnPipe(W);
    if (pipes.length && pipes[0].x + PIPE_W + PIPE_CAP_OVERHANG < 0) pipes.shift();

    // --- scoring: the pipe's trailing edge has passed the bird
    for (const pipe of pipes) {
      if (!pipe.scored && pipe.x + PIPE_W < BIRD_X - BIRD_HALF_W) {
        pipe.scored = true;
        score++;
        sound.point();
      }
    }

    // --- collision
    const bl = BIRD_X - BIRD_HALF_W;
    const br = BIRD_X + BIRD_HALF_W;
    const bt = bird.y - BIRD_HALF_H;
    const bb = bird.y + BIRD_HALF_H;

    if (bb >= GROUND_Y) {
      bird.y = GROUND_Y - BIRD_HALF_H;
      die(false);
      return;
    }

    for (const pipe of pipes) {
      if (br < pipe.x || bl > pipe.x + PIPE_W) continue;
      if (bt < pipe.top || bb > pipe.top + pipe.gap) {
        die(true);
        return;
      }
    }
  }

  /* ------------------------------------------------------------------
     Rendering
     ------------------------------------------------------------------ */

  function drawPipe(pipe) {
    const gapTop = pipe.top;
    const gapBottom = pipe.top + pipe.gap;

    drawPipeSegment(pipe.x, 0, gapTop, true);
    drawPipeSegment(pipe.x, gapBottom, GROUND_Y - gapBottom, false);
  }

  function drawPipeSegment(x, y, h, capAtBottom) {
    if (h <= 0) return;

    // Shaft.
    const shaft = ctx.createLinearGradient(x, 0, x + PIPE_W, 0);
    shaft.addColorStop(0, '#5a9c2c');
    shaft.addColorStop(0.18, '#8ed14a');
    shaft.addColorStop(0.5, '#74bf2e');
    shaft.addColorStop(0.88, '#4e8a24');
    shaft.addColorStop(1, '#3d6e1c');
    ctx.fillStyle = shaft;
    ctx.fillRect(x, y, PIPE_W, h);
    ctx.strokeStyle = '#2f4f1a';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y - 1, PIPE_W - 2, h + 2);

    // Cap, sitting at the end that faces the gap.
    const capY = capAtBottom ? y + h - PIPE_CAP_H : y;
    const capX = x - PIPE_CAP_OVERHANG;
    const capW = PIPE_W + PIPE_CAP_OVERHANG * 2;
    const cap = ctx.createLinearGradient(capX, 0, capX + capW, 0);
    cap.addColorStop(0, '#64a832');
    cap.addColorStop(0.16, '#9bda55');
    cap.addColorStop(0.52, '#7cc734');
    cap.addColorStop(0.9, '#549126');
    cap.addColorStop(1, '#3d6e1c');
    ctx.fillStyle = cap;
    ctx.fillRect(capX, capY, capW, PIPE_CAP_H);
    ctx.strokeStyle = '#2f4f1a';
    ctx.strokeRect(capX + 1, capY + 1, capW - 2, PIPE_CAP_H - 2);
  }

  function drawBird() {
    const wing = Math.floor(wingPhase) % 3; // 0 up, 1 level, 2 down

    ctx.save();
    ctx.translate(BIRD_X, bird.y);
    ctx.rotate(bird.tilt);
    // The art below is authored around a 24x18 body; one scale call sizes the
    // whole bird without having to retune a dozen offsets.
    ctx.scale(BIRD_ART_SCALE, BIRD_ART_SCALE);

    const outline = '#4a3a12';
    ctx.lineWidth = 2 / BIRD_ART_SCALE;
    ctx.strokeStyle = outline;

    // Body.
    ctx.fillStyle = '#f6d33c';
    ctx.beginPath();
    ctx.ellipse(0, 0, 12, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Belly.
    ctx.fillStyle = '#f0ab2c';
    ctx.beginPath();
    ctx.ellipse(1, 4, 8.5, 4.5, 0, 0, Math.PI);
    ctx.fill();

    // Cheek highlight.
    ctx.fillStyle = 'rgba(255, 246, 190, 0.55)';
    ctx.beginPath();
    ctx.ellipse(-3, -4, 5, 3, -0.4, 0, Math.PI * 2);
    ctx.fill();

    // Wing: three-frame beat, drawn as a rotated ellipse.
    const wingAngle = wing === 0 ? -0.75 : wing === 1 ? 0 : 0.7;
    const wingY = wing === 0 ? -2 : wing === 1 ? 1 : 4;
    ctx.save();
    ctx.translate(-3, wingY);
    ctx.rotate(wingAngle);
    ctx.fillStyle = '#fdfdf6';
    ctx.beginPath();
    ctx.ellipse(0, 0, 7, 4.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = outline;
    ctx.stroke();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
    ctx.beginPath();
    ctx.ellipse(1, 1.4, 5.5, 2.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Eye.
    ctx.fillStyle = '#fdfdf6';
    ctx.beginPath();
    ctx.arc(5, -3.5, 4.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = outline;
    ctx.lineWidth = 1.6 / BIRD_ART_SCALE;
    ctx.stroke();
    ctx.fillStyle = '#2b2118';
    ctx.beginPath();
    ctx.arc(6.6, -3.5, 1.9, 0, Math.PI * 2);
    ctx.fill();

    // Beak.
    ctx.fillStyle = '#f4832a';
    ctx.beginPath();
    ctx.moveTo(8, 0.5);
    ctx.lineTo(18, 1.5);
    ctx.lineTo(8, 5.5);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 1.6 / BIRD_ART_SCALE;
    ctx.strokeStyle = outline;
    ctx.stroke();
    ctx.fillStyle = '#d96a1c';
    ctx.beginPath();
    ctx.moveTo(8, 3.2);
    ctx.lineTo(15.4, 3.9);
    ctx.lineTo(8, 5.4);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  function render() {
    ctx.save();

    if (shake > 0.1) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    }

    // Sky.
    const sky = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    sky.addColorStop(0, '#4ec0ca');
    sky.addColorStop(0.72, '#71d3da');
    sky.addColorStop(1, '#9be0d4');
    ctx.fillStyle = sky;
    ctx.fillRect(-8, -8, W + 16, GROUND_Y + 8);

    // Parallax scenery. Each layer is one tile blitted twice.
    const skyX = -Math.floor(scrollSky);
    ctx.drawImage(skyline, skyX, GROUND_Y - BUSH_H - SKYLINE_H + 26);
    ctx.drawImage(skyline, skyX + W, GROUND_Y - BUSH_H - SKYLINE_H + 26);

    const bushX = -Math.floor(scrollBush);
    ctx.drawImage(bushes, bushX, GROUND_Y - BUSH_H);
    ctx.drawImage(bushes, bushX + W, GROUND_Y - BUSH_H);

    // Pipes.
    for (const pipe of pipes) drawPipe(pipe);

    // Bird sits behind the ground, so it sinks out of sight when it lands.
    drawBird();

    // Ground. A solid backing rect first, so the impact shake can never
    // slide the tiled strip far enough to reveal the canvas edge.
    ctx.fillStyle = '#cfc784';
    ctx.fillRect(-8, GROUND_Y, W + 16, GROUND_H + 8);
    const gx = -Math.floor(scrollGround);
    for (let x = gx; x < W + GROUND_TILE_W; x += GROUND_TILE_W) {
      ctx.drawImage(ground, x, GROUND_Y);
    }

    // Live score: hidden on the title and game-over screens, which have
    // their own DOM overlays.
    if (state === 'playing' || state === 'dying') {
      drawNumber(score, W / 2, 44);
    }

    ctx.restore();

    if (flash > 0) {
      ctx.fillStyle = `rgba(255, 255, 255, ${flash * 0.72})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  /* ------------------------------------------------------------------
     Main loop — fixed timestep with an accumulator
     ------------------------------------------------------------------ */

  let lastTime = performance.now();
  let accumulator = 0;

  function frame(now) {
    let dt = now - lastTime;
    lastTime = now;
    if (dt > MAX_CATCHUP_MS) dt = MAX_CATCHUP_MS;
    accumulator += dt;

    while (accumulator >= STEP_MS) {
      tick();
      accumulator -= STEP_MS;
    }

    render();
    requestAnimationFrame(frame);
  }

  /* ------------------------------------------------------------------
     Input
     ------------------------------------------------------------------ */

  function primaryAction() {
    sound.resume();
    if (state === 'ready') startPlaying();
    else if (state === 'playing') flap();
    else if (state === 'over') resetRun();
    // 'dying' deliberately ignores input — let the fall play out.
  }

  stage.addEventListener('pointerdown', (event) => {
    // Let the real buttons handle their own clicks.
    if (event.target.closest('button')) return;
    event.preventDefault();
    primaryAction();
  });

  window.addEventListener('keydown', (event) => {
    if (event.repeat) return;

    switch (event.code) {
      case 'Space':
      case 'ArrowUp':
      case 'KeyW':
        event.preventDefault();
        primaryAction();
        break;
      case 'KeyR':
        event.preventDefault();
        sound.resume();
        if (state === 'over' || state === 'playing') resetRun();
        break;
      case 'KeyM':
        event.preventDefault();
        sound.boot();
        sound.setMuted(!sound.muted);
        break;
      default:
        break;
    }
  });

  restartBtn.addEventListener('click', () => {
    sound.resume();
    resetRun();
  });

  muteBtn.addEventListener('click', () => {
    sound.boot();
    sound.setMuted(!sound.muted);
    muteBtn.blur();
  });

  // A backgrounded tab shouldn't resume mid-dive with a stale clock.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    lastTime = performance.now();
    accumulator = 0;
  });

  /* ------------------------------------------------------------------
     Scaling: one transform on #stage drives canvas and overlays alike
     ------------------------------------------------------------------ */

  function fit() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scale = Math.min(vw / W, vh / H);
    stage.style.setProperty('--scale', String(scale));
  }

  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', fit);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fit);
  }

  /* ------------------------------------------------------------------
     Boot
     ------------------------------------------------------------------ */

  let startMuted = false;
  try {
    startMuted = localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    /* non-fatal */
  }
  sound.muted = startMuted;
  muteBtn.setAttribute('aria-pressed', String(startMuted));
  muteBtn.setAttribute('aria-label', startMuted ? 'Unmute sound' : 'Mute sound');

  fit();
  resetRun();
  requestAnimationFrame(frame);

  /* ------------------------------------------------------------------
     Debug hook — drive the game from the console or a test runner
     ------------------------------------------------------------------ */

  window.__flappy = {
    get state() {
      return state;
    },
    get score() {
      return score;
    },
    get best() {
      return best;
    },
    get pipes() {
      return pipes.map((p) => ({ x: p.x, top: p.top, gap: p.gap }));
    },
    get bird() {
      return { x: BIRD_X, y: bird.y, vy: bird.vy };
    },
    flap() {
      if (state === 'ready') startPlaying();
      else if (state === 'playing') flap();
    },
    restart() {
      resetRun();
    },
    forceGameOver() {
      if (state === 'ready') startPlaying();
      if (state === 'playing') die(true);
    },
    setScore(n) {
      score = Math.max(0, Math.floor(n));
    },
    /**
     * Advance the simulation by n fixed ticks and repaint, without waiting on
     * requestAnimationFrame. Because the physics are already decoupled from
     * the render clock, a harness can drive a whole run synchronously — which
     * also works in a background tab, where the browser suspends rAF.
     */
    step(frames = 1) {
      const count = Math.max(1, Math.floor(frames));
      for (let i = 0; i < count; i++) tick();
      render();
      return state;
    },
  };
})();
