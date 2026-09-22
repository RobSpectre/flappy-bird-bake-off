const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('overlay');
const startButton = document.getElementById('startButton');
const bestScoreEl = document.getElementById('bestScore');
const scoreStatEl = document.getElementById('scoreStat');
const pipesStatEl = document.getElementById('pipesStat');
const soundButton = document.getElementById('soundButton');

const W = canvas.width;
const H = canvas.height;
const groundY = H - 42;
const bird = { x: 102, y: 275, radius: 14, velocity: 0, rotation: 0 };
let pipes = [];
let score = 0;
let running = false;
let gameOver = false;
let startedAt = 0;
let lastTime = 0;
let spawnTimer = 0;
let animationFrame;
let muted = false;

const storedBest = Number(localStorage.getItem('codex-flappy-best') || 0);
bestScoreEl.textContent = String(storedBest).padStart(2, '0');

function resetGame() {
  bird.y = 275;
  bird.velocity = 0;
  bird.rotation = 0;
  pipes = [];
  score = 0;
  spawnTimer = 0;
  gameOver = false;
  scoreStatEl.textContent = '00';
  pipesStatEl.textContent = '00';
}

function startGame() {
  resetGame();
  running = true;
  startedAt = performance.now();
  overlay.classList.add('is-hidden');
  flap();
  cancelAnimationFrame(animationFrame);
  animationFrame = requestAnimationFrame(loop);
  canvas.focus();
}

function endGame() {
  running = false;
  gameOver = true;
  const best = Math.max(score, Number(localStorage.getItem('codex-flappy-best') || 0));
  localStorage.setItem('codex-flappy-best', best);
  bestScoreEl.textContent = String(best).padStart(2, '0');
  overlay.classList.remove('is-hidden');
  overlay.querySelector('.overlay-kicker').textContent = 'RUN COMPLETE';
  overlay.querySelector('h2').innerHTML = `${String(score).padStart(2, '0')}<br /><span>POINTS</span>`;
  overlay.querySelector('p').innerHTML = 'The sky is still there.<br />Take another lap.';
  startButton.innerHTML = 'TRY AGAIN <span>↗</span>';
  draw();
}

function flap() {
  if (!running) return;
  bird.velocity = -350;
  if (!muted) tone(540, 0.045);
}

function addPipe() {
  const gap = Math.max(139, 172 - score * 1.3);
  const minTop = 90;
  const maxTop = groundY - gap - 95;
  const top = minTop + Math.random() * Math.max(1, maxTop - minTop);
  pipes.push({ x: W + 25, width: 62, top, gap, counted: false });
}

function tone(frequency, duration) {
  if (muted) return;
  try {
    const audio = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.frequency.value = frequency;
    oscillator.type = 'sine';
    gain.gain.setValueAtTime(0.035, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + duration);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime + duration);
  } catch (_) { /* audio is a nice-to-have */ }
}

function update(dt) {
  const speed = 158 + Math.min(score * 2.7, 74);
  bird.velocity += 1120 * dt;
  bird.y += bird.velocity * dt;
  bird.rotation = Math.min(Math.PI / 2.5, Math.max(-.5, bird.velocity / 530));
  spawnTimer += dt;
  if (spawnTimer > 1.65) { addPipe(); spawnTimer = 0; }

  pipes.forEach(pipe => {
    pipe.x -= speed * dt;
    if (!pipe.counted && pipe.x + pipe.width < bird.x - bird.radius) {
      pipe.counted = true;
      score += 1;
      scoreStatEl.textContent = String(score).padStart(2, '0');
      pipesStatEl.textContent = String(score).padStart(2, '0');
      tone(760, 0.07);
    }
  });
  pipes = pipes.filter(pipe => pipe.x + pipe.width > -10);

  const hitGround = bird.y + bird.radius > groundY;
  const hitCeiling = bird.y - bird.radius < 0;
  const hitPipe = pipes.some(pipe => {
    const withinX = bird.x + bird.radius > pipe.x && bird.x - bird.radius < pipe.x + pipe.width;
    const outsideGap = bird.y - bird.radius < pipe.top || bird.y + bird.radius > pipe.top + pipe.gap;
    return withinX && outsideGap;
  });
  if (hitGround || hitCeiling || hitPipe) endGame();
}

function drawBackground() {
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#0f4357');
  sky.addColorStop(0.56, '#247477');
  sky.addColorStop(1, '#f2b25e');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  const t = (performance.now() - startedAt) * 0.00002;
  ctx.save();
  ctx.globalAlpha = .11;
  ctx.fillStyle = '#ffe6a7';
  ctx.beginPath();
  ctx.arc(323, 122, 66, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = .14;
  for (let i = 0; i < 6; i++) {
    ctx.fillRect((i * 112 - ((performance.now() - startedAt) * .006) % 112) - 30, 150 + (i % 2) * 58, 54, 2);
  }
  ctx.restore();

  ctx.fillStyle = '#4e8170';
  ctx.beginPath();
  ctx.moveTo(0, groundY - 44);
  for (let x = 0; x <= W; x += 28) ctx.lineTo(x, groundY - 37 - Math.sin(x * .028 + t) * 16);
  ctx.lineTo(W, groundY); ctx.lineTo(0, groundY); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#83a578';
  ctx.beginPath();
  ctx.moveTo(0, groundY - 25);
  for (let x = 0; x <= W; x += 20) ctx.lineTo(x, groundY - 21 - Math.cos(x * .043 + t * 2) * 11);
  ctx.lineTo(W, groundY); ctx.lineTo(0, groundY); ctx.closePath(); ctx.fill();

  ctx.fillStyle = '#f5d279';
  ctx.fillRect(0, groundY, W, 8);
  ctx.fillStyle = '#b9854e';
  ctx.fillRect(0, groundY + 8, W, H - groundY - 8);
  ctx.fillStyle = 'rgba(95, 63, 48, .35)';
  const groundOffset = ((performance.now() - startedAt) * .12) % 34;
  for (let x = -34 + groundOffset; x < W; x += 34) ctx.fillRect(x, groundY + 24, 14, 2);
}

function drawPipe(pipe) {
  const pipeGradient = ctx.createLinearGradient(pipe.x, 0, pipe.x + pipe.width, 0);
  pipeGradient.addColorStop(0, '#d6a64e');
  pipeGradient.addColorStop(.45, '#f5d76e');
  pipeGradient.addColorStop(1, '#b77a42');
  ctx.fillStyle = pipeGradient;
  ctx.fillRect(pipe.x, 0, pipe.width, pipe.top - 8);
  ctx.fillRect(pipe.x - 5, pipe.top - 15, pipe.width + 10, 15);
  const bottomY = pipe.top + pipe.gap;
  ctx.fillRect(pipe.x, bottomY + 8, pipe.width, groundY - bottomY);
  ctx.fillRect(pipe.x - 5, bottomY, pipe.width + 10, 15);
  ctx.fillStyle = 'rgba(255, 245, 160, .25)';
  ctx.fillRect(pipe.x + 9, 0, 8, pipe.top - 8);
  ctx.fillRect(pipe.x + 9, bottomY + 8, 8, groundY - bottomY);
}

function drawBird() {
  ctx.save();
  ctx.translate(bird.x, bird.y);
  ctx.rotate(bird.rotation);
  ctx.fillStyle = '#ff765c';
  ctx.beginPath(); ctx.arc(0, 0, bird.radius, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffd46b';
  ctx.beginPath(); ctx.ellipse(-3, 5, 10, 5, -.35, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#f5ce63';
  ctx.beginPath(); ctx.moveTo(10, -2); ctx.lineTo(24, 2); ctx.lineTo(10, 6); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#f7f2e6';
  ctx.beginPath(); ctx.arc(5, -6, 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#172c3a';
  ctx.beginPath(); ctx.arc(6, -6, 2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function draw() {
  drawBackground();
  pipes.forEach(drawPipe);
  drawBird();
}

function loop(now) {
  const dt = Math.min((now - lastTime) / 1000 || 0, .032);
  lastTime = now;
  if (running) update(dt);
  draw();
  if (running) animationFrame = requestAnimationFrame(loop);
}

function action() {
  if (!running) { startGame(); return; }
  flap();
}

startButton.addEventListener('click', action);
canvas.addEventListener('pointerdown', action);
document.addEventListener('keydown', event => {
  if (event.code === 'Space' || event.code === 'ArrowUp') { event.preventDefault(); action(); }
});
soundButton.addEventListener('click', () => {
  muted = !muted;
  soundButton.setAttribute('aria-pressed', String(!muted));
  soundButton.textContent = muted ? '×' : '♫';
});

draw();
