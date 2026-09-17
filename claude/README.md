# claude — Flappy Bird entry

Implements the spec in the repo-root `README.md`: dependency-free HTML/CSS/JS,
a 288×512 logical canvas CSS-scaled to the window, every sprite drawn
procedurally, sound synthesised with the Web Audio API, fixed 60Hz simulation.

```
index.html   markup, DOM overlays and the canvas
style.css    shell, overlay and button styling
game.js      loop, physics, collision, rendering, audio
```

Open `index.html` directly (works from `file://`), or serve the folder.

## Tuning chosen here

`GRAVITY = 0.52`, `FLAP_V = -6.4`, so a flap's apex rise is
`FLAP_V² / (2 · GRAVITY) ≈ 39px` — about a third of the 118px starting gap.
This matters more than it looks: an earlier pass used a 59px rise against a
59px half-gap, which meant flapping from the centre of a gap landed the bird
exactly on the pipe lip. The current values leave ~20px of headroom and give
the original's rapid small-tap cadence.

`difficultyFor(score)` in `game.js` shapes the ramp between the spec's fixed
endpoints (gap 118→92, speed 2.0→2.75). It uses a smoothstep over the first
30 points: forgiving early, steepest through the middle, easing out so the
cap doesn't arrive as a wall. Measured: gap 118 at score 0, 114 at 10, 102 at
20, 92 from 30 on.

## Deviations from the root README

Two additions, both supersets of the documented contract:

- **`__flappy.step(frames = 1)`** — advances the simulation by n fixed ticks
  and repaints, without waiting on `requestAnimationFrame`. Since the physics
  are already decoupled from the render clock, a harness can drive a whole run
  synchronously. This also works in a background tab, where browsers suspend
  rAF entirely — which is the only way to drive the game from an automated
  test that isn't holding the window in the foreground.
- **`flappy.muted.v1`** in `localStorage`, alongside the specified
  `flappy.best.v1`, so the mute toggle survives a reload.

## Verification notes

Driven through `__flappy.step()`: an autopilot run reached score 45 without
dying; the ceiling clamps at y=7 leaving `state === 'playing'`; medal tiers
switch exactly at 10/20/30/40; `best` persists to `localStorage`. Keyboard
input (`Space`, `R`, `M`) was exercised as real key events.

Pointer input was verified only via a dispatched `PointerEvent` — synthesized
mouse clicks never reached the page in the test environment (clicks on a
native `<button>` were dropped too), so click/tap is the one path not
confirmed end-to-end against real browser input.
