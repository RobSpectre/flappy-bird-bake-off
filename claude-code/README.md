# Flappy Bird — Claude Code

A dependency-free, single-canvas Flappy Bird clone. No build step, no assets:
every sprite is drawn with 2D canvas primitives at runtime.

## Run

    python3 -m http.server 8421
    # then open http://localhost:8421/

Opening `index.html` directly over `file://` also works.

## Controls

| Input | Action |
| --- | --- |
| `Space` / `↑` / `W` / click / tap | Flap |
| `M` | Mute |
| `P` | Pause |

## Files

- `index.html` — canvas element and page shell
- `style.css` — page framing; the canvas letterboxes itself via `aspect-ratio: 5/8`
- `game.js` — the whole game (physics, spawning, collision, rendering, audio)

## Design notes

**Fixed timestep.** Physics runs in 1/120 s steps drained from an accumulator,
so the game plays identically on 60 Hz and 144 Hz displays. The frame delta is
clamped to 250 ms, otherwise a backgrounded tab resumes with one huge step and
teleports the bird straight through a pipe before collision ever runs.

**Distance-based spawning.** A new pipe is queued when the last one is more than
`spacing` px from the right edge, rather than on a timer. Scroll speed can then
change mid-run without disturbing the rhythm of the gaps.

**Difficulty curve.** `difficultyAt(score)` in `game.js` is the single tuning
knob. Gap narrows 172 → 128 px and speed rises 155 → 225 px/s over the first 25
points, while spacing grows 215 → 262 px so the time between pipes only tightens
from 1.39 s to 1.16 s. One flap gains ~71 px of apex, comfortably under the
128 px floor, so every gap stays clearable.

**Fair collision.** The bird collides as a circle 2 px smaller than it is drawn —
the standard trick for making near-misses feel like near-misses instead of
cheap deaths. Hitting the ceiling bumps you rather than killing you, as in the
original.

## Debug mode

Load `index.html?debug` to expose the internals on `window.flappy`:

    flappy.state     // 'ready' | 'playing' | 'dying' | 'over'
    flappy.score
    flappy.bird      // { y, v, angle, ... }
    flappy.pipes     // [{ x, top, bottom, scored }]
    flappy.god = true    // disable collision
    flappy.flap()
    flappy.reset()
    flappy.difficultyAt(score)

Useful for tuning, and for driving the game from an automated play-test. A
working bang-bang autopilot, which clears 25+ pipes, is roughly:

    const p = flappy.pipes.filter(q => q.x + 62 > 83).sort((a,b) => a.x - b.x)[0];
    const centre = p ? (p.top + p.bottom) / 2 : 245;
    if (flappy.bird.y > centre + 32 && flappy.bird.v > -60) flappy.flap();

Note the `+ 32` bias: one flap buys ~71 px of apex, so aiming straight at the
gap centre makes the bird overshoot into the top lip every time.
