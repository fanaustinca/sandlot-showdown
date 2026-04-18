# Sandlot Showdown ⚾

An Angular baseball game with single-player (vs. CPU) and networked multiplayer. Pitch types, swing timing, base running, 6 innings. Ships as a single container for Google Cloud Run.

## Run locally

Two processes. One for the Node server (statics + WebSocket relay), one for Angular dev:

```bash
npm install
npm run build        # produces dist/baseball-game/browser
node server.js       # serves on :8080
```

Then visit http://localhost:8080 in two browser tabs to try multiplayer.

For iterative UI work:

```bash
node server.js       # terminal 1 — :8080
npm start            # terminal 2 — :4200, proxies /ws to :8080
```

## Gameplay

- Pitcher picks one of: **straight**, **curl**, **zigzag**, **flyball**. Each has its own flight time + trajectory.
- Batter presses **Space** (or taps the field) to swing. 500 ms swing cooldown.
- Swing offset (ms from ball-at-plate) decides the hit quality:
  - `< 30 ms`: HOME RUN (clears bases)
  - `< 75 ms`: triple
  - `< 140 ms`: double
  - `< 210 ms`: single
  - otherwise: strike
- Half-inning ends at **3 strikeouts** or **5 runs**. 6 innings total.

## Deploy to Google Cloud Run

```bash
gcloud run deploy sandlot-showdown \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --max-instances 1 \
  --cpu 1 --memory 512Mi \
  --session-affinity
```

**Why `--max-instances=1`:** Room state (the in-memory WebSocket pairings) lives in the container. A second instance wouldn't see the same rooms. With one instance, Cloud Run will queue up to 80 concurrent connections per container by default, which is plenty for a hobby game. If you need horizontal scale, back the `rooms` map with Redis/Firestore.

**Session affinity** keeps each client pinned to the instance where their WebSocket upgrade landed.

The Dockerfile is multi-stage: `node:22-slim` builds the Angular app, then a slim runtime image serves it with `server.js`. Cloud Run injects `$PORT` (8080 by default).

## Project layout

```
src/app/
  game/          models, engine, AI, WebSocket service
  menu/          landing page (pick mode / create / join room)
  play/          field, ball animation, pitch selector, scoreboard
server.js        Express + ws. Serves /dist + relays /ws room events.
Dockerfile       Cloud Run container.
```
