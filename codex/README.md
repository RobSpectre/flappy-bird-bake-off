# Skyline Flap

A dependency-free, web-based Flappy Bird clone with an original dusk arcade treatment.

## Run

Open `index.html` directly, or serve this folder:

```sh
python3 -m http.server 8765
```

Then visit `http://localhost:8765/`.

## Controls

- Tap or click the game to flap
- Press `Space`, `Arrow Up`, or `W` to flap
- Press `R` to restart
- Press `M` or use the sound pill to mute

Scores and mute preference are saved locally in the browser. The game renders through canvas in a normal browser and includes a DOM scene fallback for constrained previews that do not expose the canvas 2D API.
