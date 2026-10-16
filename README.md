# traza

*agent sessions, woven*

Drop an agent session export; traza weaves it into cloth — every step a
knot, every subagent a strand that unthreads and returns — then lets you
run the shuttle and watch the work replay at reading pace.

![traza](docs/hero.png)

**[traza-sand.vercel.app](https://traza-sand.vercel.app)** — live, free, no account.
Everything happens in the browser; nothing leaves your machine.

## What it does

- **The weave.** A session becomes a piece of charcoal cloth: the main
  run is the warp strand, each spawned subagent unthreads into its own
  weft, work items hang off the nearest knot, and the selvedge stabs on
  the edge name every session. Knots get real step titles —
  `edit src/app.ts`, `npm test → failed` — never "message".
- **Ask it questions.** *Time on the loom* is a waterfall: one lane per
  thread, bars by real wall-clock duration, the longest spans flagged.
  Click a bar and the camera flies to that exact knot. Filters dim by
  agent, tool kind, errors-only, or full-text search across every step.
- **Run the shuttle.** Press play and the lamps dim; a wooden shuttle
  walks knot to knot while the inspector follows — reasoning, tool
  arguments, diffs, tokens and elapsed time for every step. Three paces:
  `tour`, `study`, or `real` (wall-clock scaled).
- **Tethers.** When a Codex or Cursor reviewer's session was launched by
  the main run, a gold thread ties its strand to the step that spawned
  it — "codex picked it up here" is a real link you can ride along.
- **Explore.** Drag the cloth with inertia, wheel/pinch to zoom, click
  knots, `j`/`k` steps turn by turn, `/` searches the weave and flies
  the camera to any knot, strand or work item by name.

## What it reads

traza parses real session exports from the agent CLIs people actually
use:

- **Devin** — `nodes.jsonl` / ATIF session logs
- **Codex** — `rollout-*.jsonl` transcripts
- **Cursor** — decoded `messages.jsonl` exports
- **Anything text-shaped** — `.jsonl`, `.ndjson`, `.txt`, `.md`, `.log`,
  `.csv` fall through to a generic event stream parser

Drop a file, a folder, or a whole export directory. Three synthetic
sessions ship as a demo so you can run the shuttle before you have an
export handy.

## How it works

- **Local-first.** Parsing, layout and rendering all happen client-side.
  There is no server, no account, no telemetry; secrets and paths are
  redacted before anything touches the DOM. `traza.html` in this repo is
  the whole product bundled into a single file — it runs from `file://`.
- **The weave is solved, not drawn.** Strands, unthreads and parallel
  runs are laid out by a dedicated graph pass (`src/lib/metro.ts`) that
  keeps every thread readable, then a label-placement pass reserves
  collision boxes so names never tangle.
- **The shuttle follows geometry.** It isn't animated along a timeline;
  it interpolates the actual strand polylines (`src/lib/ride.ts`), and
  `study` pace dwells per turn — consecutive calls, results and
  reasoning grouped into one labelled beat.
- **Direct manipulation everywhere.** The camera is imperative: drag,
  wheel and pinch cancel flights, panning works while the inspector
  sheet is open, and on a phone the sheet springs between detents and
  flings away on a fast downward throw.

## Local run

```bash
npm install
npm run dev
```

Build + preview:

```bash
npm run build
npm run preview
```

Single-file artifact (what `traza.html` is):

```bash
npm run build:single   # writes dist-single/index.html
```

## Tests

```bash
node test/engine.mjs        # parsers + model
node test/metro.mjs         # layout invariants (octilinear, reachability, bounds)
node test/ride.mjs          # ride construction + interpolation
node test/render.mjs        # plano SVG render + PNG smoke
node test/live-check.mjs    # chromium + firefox + webkit: ride, selection, finder, night
node test/gesture-check.mjs # pan-while-open, fling-to-close, gesture-cancel of the opening dive
node test/perf-check.mjs    # 1200-step network, display-rate panning, reduced motion
```

## Stack

React 19 + TypeScript + Vite, hand-rolled SVG + imperative camera, zero
runtime dependencies beyond fonts and haptics. No map library, no
animation library — the whole thing is ~90 KB of product code.

## License

MIT
