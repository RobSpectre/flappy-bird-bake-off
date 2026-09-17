# Flappy Bird — web clone

A dependency-free clone of Flappy Bird. Plain HTML/CSS/JS on a `<canvas>`;
every sprite (bird, pipes, ground, skyline, clouds) is drawn procedurally at
runtime, so there are no image, font or audio files to load — the sound effects
are synthesised with the Web Audio API.

## Run it

Just open `index.html` in a browser. It works from `file://` with no server.

Or serve it, which is nicer for mobile testing on your LAN:

```sh
python3 -m http.server 8765
# then open http://localhost:8765/
```

## Controls

| Action  | Input                                                  |
| ------- | ------------------------------------------------------ |
| Flap    | Click / tap anywhere, `Space`, `↑`, `W`                |
| Restart | `R`, `Space`, or the button on the game-over screen    |
| Mute    | `M` or the speaker button in the corner                |

## Game rules

- Gravity pulls the bird down; each flap gives a fixed upward impulse.
- Pass a pipe to score a point. Pass 10 / 20 / 30 / 40 points for the
  bronze / silver / gold / platinum medal on the game-over card.
- The gap narrows from 118px toward 92px and the scroll speed rises from
  2.0 to 2.75 px/frame as your score climbs, so runs get harder — both ramp
  and speed are clamped, so the game stays playable instead of becoming
  impossible.
- Hitting a pipe or the ground ends the run. Touching the ceiling is
  clamped, not fatal — same as the original.
- Best score is kept in `localStorage` (`flappy.best.v1`), written only when
  it is beaten. The mute flag lives in `flappy.mute.v1`.

## Layout

```
index.html   markup, overlays and the canvas
style.css    shell, overlay and button styling
game.js      the whole game: loop, physics, collision, rendering, audio
```

`game.js` renders at a fixed logical resolution of 288×512 (the original's
phone viewport) and CSS-scales the canvas up to fit the window, so the art
stays pixel-consistent at any size.

### Physics constants

Tuning lives at the top of `game.js` as named constants — `GRAVITY`, `FLAP_V`,
`MAX_FALL`, `PIPE_SPACING`, `GAP_START`, `SPEED_START`, etc. Simulation runs on
a fixed 60Hz timestep with an accumulator, so behaviour is frame-rate
independent (and identical on a 144Hz monitor).

## Debug hook

`game.js` exposes a small `window.__flappy` object for driving the game from
the console or from automated tests:

```js
__flappy.state()        // 'ready' | 'playing' | 'dying' | 'over'
__flappy.score()        // current score
__flappy.best()         // best score
__flappy.pipes()        // [{x, center, gap, scored}, ...]
__flappy.bird()         // {x, y, vy, rot}
__flappy.geometry()     // logical viewport + sprite metrics
__flappy.speed(), __flappy.gap()
__flappy.flap()
__flappy.start() / __flappy.restart()
__flappy.showTitle()
__flappy.forceGameOver()
__flappy.setScore(n)    // re-tunes the difficulty ramp
__flappy.setBird(y, vy)
__flappy.clearPipes()
```

## Verified

Driven headlessly over the DevTools Protocol (Chrome `--headless=new`), 23/23
assertions passed: boot state and overlays, canvas actually paints (284 distinct
sampled colours), a scripted bot survives ~14s and scores 8, best score written
to `localStorage` on game over and surviving a reload, `dying` ignores input
while a flap does alter velocity in `playing`, the ceiling is a clamp while the
floor ends the round, the difficulty ramp is clamped at both ends, the
simulation pauses on `visibilitychange`, mute persists, and the page works from
`file://` as well as over HTTP — with no console errors or uncaught exceptions.

`verify-flappy.mjs` is that harness (node, no dependencies). To re-run it:

```sh
python3 -m http.server 8791          # in this directory
google-chrome --headless=new --disable-gpu --no-first-run \
  --no-default-browser-check --mute-audio --window-size=900,900 \
  --user-data-dir=/tmp/probe-profile --remote-debugging-port=9222 \
  http://localhost:8791/index.html
node verify-flappy.mjs               # exits non-zero on any failed check
```
