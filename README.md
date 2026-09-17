# Flappy Bird — bake-off

One written spec, three coding agents, three independent clones of Flappy Bird.
Each entry is a self-contained folder that runs straight from `file://` — no
server, no build step, no dependencies.

**Live: https://robspectre.github.io/flappy-bird-bake-off/**

| Entry | Folder | Look | Lines |
| ----- | ------ | ---- | ----- |
| Claude Code | [`claude/`](claude/) | faithful to the original: daytime palette, smoothstep difficulty ramp | 1,494 |
| OpenAI Codex | [`codex/`](codex/) | **Skyline Flap** — original dusk arcade treatment | 905 |
| Hermes | [`hermes/`](hermes/) | original palette plus medal tiers and a CDP test harness | 918 |

The landing page at the repo root embeds all three in `<iframe>`s, so you can
compare them side by side and play any of them inline.

## Run it

Open the root `index.html` (or any entry's `index.html`) directly in a browser —
it works from `file://` with no server. Or serve the whole set, which is nicer
for mobile testing on your LAN:

```sh
python3 -m http.server 8765
# then open http://localhost:8765/
```

## The spec every entry implements

- Dependency-free: plain HTML/CSS/JS on a `<canvas>` — no libraries, no build.
- Every sprite (bird, pipes, ground, skyline) drawn procedurally at runtime, so
  there are no image, font or audio files to load; the sound effects are
  synthesised with the Web Audio API.
- Fixed logical resolution of 288×512 (the original's phone viewport),
  CSS-scaled to fit the window, so the art stays pixel-consistent at any size.
- Fixed 60Hz timestep with an accumulator, so behaviour is frame-rate
  independent.
- Gravity pulls the bird down; each flap gives a fixed upward impulse. Pass a
  pipe to score a point. Hitting a pipe or the ground ends the run; touching the
  ceiling is clamped, not fatal — same as the original.
- The gap narrows from 118px toward 92px and the scroll speed rises from 2.0 to
  2.75 px/frame as the score climbs, both clamped so runs get harder without
  becoming impossible.
- Best score persisted in `localStorage`.
- A `window.__flappy` debug object for driving the game from the console or from
  an automated test:

```js
__flappy.state        // 'ready' | 'playing' | 'dying' | 'over'
__flappy.score        // current score
__flappy.best         // best score
__flappy.pipes        // [{x, top, gap}, ...]
__flappy.bird         // {x, y, vy}
__flappy.flap()
__flappy.restart()
__flappy.forceGameOver()
__flappy.setScore(n)
```

Entries may extend that hook (Claude's exposes accessors plus `step(n)` and
`setBird`; Hermes' exposes accessors plus `geometry()` and `clearPipes()`) — the
list above is the contract, not a ceiling.

Controls in all three: flap with click / tap / `Space` / `↑` / `W`, restart with
`R` or the game-over button, mute with `M` or the on-screen speaker.

## Per-entry notes

Each folder's own `README.md` documents the tuning that agent chose and the
verification it ran — worth reading before the source:

- [`claude/README.md`](claude/README.md) — a flap apex of ~39px against the 118px
  gap, the smoothstep ramp (gap 118 at score 0 → 92 from 30 on), `__flappy.step(n)`
  for driving the game without `requestAnimationFrame`, and the one input path it
  couldn't confirm end-to-end.
- [`codex/README.md`](codex/README.md) — Skyline Flap's art direction and its DOM
  scene fallback for previews that don't expose the canvas 2D API.
- [`hermes/README.md`](hermes/README.md) — medal tiers, the clamped ramp, and
  `verify-flappy.mjs`, a zero-dependency CDP harness that drove the game over
  headless Chrome for 23/23 assertions.

## Where they diverge

Measured in headless Chrome, over HTTP, on this tree — not read off the source.

| | claude | codex | hermes |
| --- | --- | --- | --- |
| canvas renders | yes (288×512) | **no** — 360×640 canvas never paints | yes (288×512) |
| debug hook | `__flappy`, accessors | `__skylineFlap`, accessors | `__flappy`, functions |
| best-score key | `flappy.best.v1` | `skyline-flap.best.v1` | `flappy.best.v1` |
| bot score over HTTP (one 14s scripted run) | 11 | 3 | 8 |

Two things worth knowing before you compare them:

- **Codex's canvas never paints.** Its game column and its canvas both carry
  `codex/index.html:52` and `:65`), so
  `document.getElementById('game')` in `codex/game.js:27` returns the `<section>`,
  `typeof canvas.getContext !== 'function'`, and `ctx` is `null` for the life of
  the page. The entry then runs the DOM fallback scene it ships for canvas-less
  environments — so it is fully playable and looks deliberate, just on the
  degraded path. Sampling the canvas' pixels returns a single colour. This is
  published as the agent shipped it; a one-line fix (`querySelector('canvas#game')`)
  is the difference.
- **Codex also goes its own way on the spec**: a 360×640 logical viewport rather
  than 288×512, its own gravity/flap/pipe constants, and `__skylineFlap` instead
  of `__flappy`. Claude hews to the documented hook (accessors); Hermes keeps the
  names but turns them into functions.

## Repository layout

```
index.html        landing page: embeds all three games, links to the full pages
.nojekyll         serve the tree as static files on GitHub Pages, no Jekyll pass
claude/           entry 1: index.html, style.css, game.js, README.md
codex/            entry 2: index.html, style.css, game.js, README.md
hermes/           entry 3: index.html, style.css, game.js, README.md, verify-flappy.mjs
verify-site.mjs   drives the whole site over CDP: layout, embeds, per-entry render checks
verify-play.mjs   drives all three entries with a scripted bot and reports the scores
```

## Verifying it

Serve the tree and start a headless Chrome on a debug port, then run the two
harnesses (node only, no dependencies, exit non-zero on failure):

```sh
python3 -m http.server 8791
google-chrome --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --mute-audio --window-size=1280,1000 --user-data-dir=/tmp/probe-site \
  --remote-debugging-port=9222 about:blank

node verify-site.mjs     # landing layout at 1360/1180/1100/960/420px, all three embeds,
                         # each entry's own canvas size, paint state and debug hook: 42 checks
node verify-play.mjs     # bots each entry for 14s and reports its score: 7 checks
node hermes/verify-flappy.mjs            # Hermes' own 23-check harness (URL_MATCH to point it)
```

Last run on this tree: `verify-site.mjs` 42/42, `verify-play.mjs` 7/7,
`hermes/verify-flappy.mjs` 23/23 — all over `http://localhost:8791`.

## GitHub Pages

The site is the repository root, deployed straight from the `main` branch, so
every push republishes:

- Landing page — `/`
- Each entry — `/claude/`, `/codex/`, `/hermes/`

`.nojekyll` is present so the tree is served verbatim.
