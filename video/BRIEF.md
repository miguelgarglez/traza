---
flow: product-launch
length: 25-32s
resolution: 1080x1080 (square)
narration: none — works muted, on-screen text carries the story
music: none (silent film; must read without sound)
audience: builders and agent-CLI users on X/Twitter
tone: railway-authority poise, quiet engineering pride, dry transit wink
---

# traza — launch video brief

**Product:** traza — "Drop an agent session export; traza draws it as the
metro map of the work — every step a station, every subagent a branch line —
then lets you ride the line." A local-first viewer: real exports from
Devin / Codex / Cursor become an octilinear transit map you can pan, read,
and replay as a night service. Live at https://traza-sand.vercel.app

**Source of truth:** the running app at https://traza-sand.vercel.app (also
http://localhost:4174 preview build) — capture the real UI with Playwright
`recordVideo` at 2x device scale, never mockups.

**Brand:** plano paper (`#edf0f5`), ink navy (`#0f4e9e` trunk / line colors
per service), route-casing + pale ballast slit at reading zoom, station
labels in Fira Sans Condensed, wordmark + LED board in Fira Sans Extra
Condensed / Fira Code. Night service is warm sodium (`#1d1712` field,
`#ffd97a` train light, `#efe5cf` text) — brown-gold, never cool blue.
Motion language: infrastructure with manners — tracks lay in, cameras fly
with ease-in-out, text morphs instead of cutting, the terminus holds.

**Story (follows the product's own first-run guide, as the Lab spec asks):**
1. Hook (0–2s): the plano mid-track-lay on paper, one word over it —
   "your agent session, as a metro map" (or a beat earlier: just the map
   materializing while the wordmark stamps).
2. Every step a station (2–8s): slow push into the trunk; station labels
   and `USER · STOP N` sub-lines fade on at reading zoom; a station is
   selected and the inspector panel lands — "click a stop".
3. Every subagent a branch line (8–13s): camera pulls to a junction;
   branch lines fan out; the KEY rows show S1/S2/S3 services —
   "subagents become branch lines".
4. Ride the line (13–22s): press play, day folds into warm sodium night,
   the train follows the real route with its LED board morphing stop by
   stop — the signature moment, longest hold.
5. Terminus + URL (22–30s): the train arrives, corridor flares, the board
   reads ALL CHANGE, hold a beat; then a final plate — wordmark,
   "open source · local-first", traza-sand.vercel.app.

**Footage notes:** boot sequence shows map-only first paint (chrome fades
in late — that restraint is part of the story). Capture: (a) cold load →
track-laying + wide hold + dive, (b) near-zoom reading pass with labels +
dual-rail casing, (c) station select + inspector, (d) junction/key beat,
(e) full ride night sequence incl. terminus ALL CHANGE, (f) title plate
is composed in the composition itself (wordmark, URL).
