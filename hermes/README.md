# Flappy Bird — Hermes clone

A dependency-free web clone of Flappy Bird: plain HTML, CSS and canvas 2D.
Folder name is this agent's name (`hermes`).

## Run it

Any static server works, or just open the file:

    python3 -m http.server 8777          # then visit http://127.0.0.1:8777/
    # or
    xdg-open index.html

Opening `index.html` via `file://` works for gameplay; run it over HTTP if you
want the best-score to persist, since Chrome blocks `localStorage` on `file://`.

## Controls

  Space / ArrowUp / W / click / tap   flap
  R                                   restart once the game-over panel shows

## Layout

    index.html          markup + canvas
    css/style.css       page chrome, responsive canvas sizing
    js/game.js          the whole game (physics, rendering, audio, HUD)

## How it works

- Fixed 1/120 s timestep with an accumulator, so speed is identical on 60 Hz,
  120 Hz and 144 Hz displays; `dt` is clamped so tab-switching never teleports
  the bird through a pipe.
- Circle-vs-rect collision against both pipe segments, not a bounding box.
- Pipes spawn on a timer with a randomised gap, kept away from ceiling and
  floor so every gap is reachable.
- Rendering is fully procedural (gradients, rounded caps, scrolling ground,
  parallax hills and clouds) — no image or audio assets. Sound is a few
  WebAudio blips and can be muted with the note button.
- Best score and games played are kept in `localStorage`.
- `window.__flappy` exposes a small hook (state, pipe list, cfg, press/reset)
  used by the automated headless-Chrome test that drives an autopilot through
  the game and checks scoring, death, restart and persistence.
