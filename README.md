# Flappy Bird Bake-Off

One prompt, three coding agents, three playable Flappy Bird clones — all vanilla
HTML/CSS/JavaScript with no dependencies and no build step.

**Live:** https://robspectre.github.io/flappy-bird-bake-off/

The brief each agent received, verbatim, with nothing else:

> Create a web based clone of flappy bird in a subdirectory with your coding
> agent name as the name of the folder. open a web browser when you are done.

## The three versions

| Path | Agent | Layout | Notes |
|---|---|---|---|
| [`/hermes/`](hermes/) | Hermes Agent | `index.html`, `css/`, `js/` | Fixed 1/120 s timestep (identical feel at 60/120/144 Hz), circle-vs-rect collision, fully procedural art and WebAudio blips, best score in `localStorage` |
| [`/claude-code/`](claude-code/) | Claude Code | `index.html`, `style.css`, `game.js` | Portrait "arcade cabinet" frame, cloud parallax, P pauses and M mutes |
| [`/codex/`](codex/) | OpenAI Codex CLI | `index.html`, `style.css`, `game.js` | Full arcade landing page around the canvas — hero copy, live best-score and pipes-cleared stats, start-run overlay |

The repository root is a landing page that presents all three, loading each game
into the page on demand (so three animation loops aren't running at once).

## Run locally

Any static server works — all three are plain files with relative asset paths:

```bash
python3 -m http.server 8777
# http://127.0.0.1:8777/           landing page
# http://127.0.0.1:8777/hermes/
# http://127.0.0.1:8777/claude-code/
# http://127.0.0.1:8777/codex/
```

Opening a version's `index.html` directly over `file://` also plays; serve over
HTTP if you want the saved best score to persist, since browsers block
`localStorage` on `file://`.

## Controls

| Version | Flap | Other |
|---|---|---|
| Hermes | Space / ArrowUp / W / click / tap | R restarts after game over, ♫ mutes |
| Claude Code | Space / click / tap | M mutes, P pauses |
| Codex | Space / tap (after START RUN) | ♫ mutes |

## Hosting

Published with GitHub Pages from the `main` branch root — each version is
self-contained in its own directory, so no build step or path rewriting is
needed. `.nojekyll` keeps Jekyll from touching the served files.

## Verification

Each version was smoke-tested in real headless Chrome (153) before publishing:
the page loads with no JavaScript exceptions and no 4xx asset requests, the
canvas paints, and its frame contents change over time — both idle and after
synthetic input. The Hermes build was additionally driven by an autopilot script
that plays through the game and checks scoring, pipe collision, death, restart,
the ceiling clamp and best-score persistence in `localStorage`.
