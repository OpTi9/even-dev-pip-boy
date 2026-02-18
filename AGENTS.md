# AGENTS.md

This file is a practical build guide for this repository. It documents:
- what each app does,
- how each app is implemented,
- reusable patterns you can apply to build new apps quickly.

## 1. Core Architecture (How This Monorepo Works)

### App loading and selection
- `src/Main.ts` auto-discovers apps under `apps/*/index.ts`.
- It also supports submodule apps via adapters in `src/*-submodule-adapter.ts`.
- Selected app comes from `VITE_APP_NAME` (set by `start-even.sh`), else defaults to `demo`.

### Shared app contract
- Every local app implements `AppModule` from `apps/_shared/app-types.ts`.
- `createActions(setStatus)` returns two actions:
  - `connect()` for bridge/setup flow
  - `action()` for the secondary button behavior

### Launcher/runtime workflow
- `start-even.sh`:
  - discovers apps,
  - prompts selection (or uses `APP_NAME`),
  - ensures dependencies,
  - starts Vite with `VITE_APP_NAME=<selected_app>`,
  - launches Even Hub simulator.
- `start-g2-stack.sh` (new full-stack runner):
  - starts `g2claude` Vite app (fixed port + strictPort),
  - starts `claude-code-telegram` bot from subrepo,
  - aligns bot callback URL to localhost (`EVEN_G2_URL=http://127.0.0.1:<port>`),
  - prints/generates QR for Tailscale host URL.
- npm shortcuts:
  - `npm run g2:up`
  - `npm run g2:down`
  - `npm run g2:status`
  - `npm run g2:qr`
  - `npm run g2:logs`

### Dev server middleware
- `vite.config.ts` adds utilities used by apps:
  - `/__restapi_proxy` for arbitrary GET proxy requests
  - `/reddit-api` and `/__reddit_proxy` for Reddit fetches
  - `/__open_editor` and `/__open_external` helpers
  - Stockfish asset serving for chess.
  - G2 Claude bridge endpoints:
    - `/__g2_session` (session/token bootstrap)
    - `/__groq_transcribe` (audio transcription proxy)
    - `/__g2_send` (forward prompt to bot webhook)
    - `/__g2_receive` (bot callback back into Vite)
    - `/__g2_poll` (app-side response polling)
  - Host validation in Vite must allow your external host (for example Tailscale)
    via `server.allowedHosts` / `VITE_ALLOWED_HOSTS`.

## 2. Even G2 Capability Reference (Hardware + SDK)

This section is a practical capability baseline for building G2 apps in this repo.
Source snapshot date: February 18, 2026.

### Official hardware/display specs (Even G2)
- Display tech: Micro LED, green display color.
- Resolution: 640 x 350.
- Field of view: 27.5 deg.
- Refresh rate: 60 Hz.
- Brightness: 1200 nits.
- Optics: binocular waveguide display, 98% passthrough.
- Connectivity: BLE 5.4.
- Input surfaces: G2 temple touch controls and R1 ring touchpad.

### Official control model (G2 + R1)
- Single tap: confirm/select in lists; switch card view mode.
- Double tap: dashboard/back behavior depending context.
- Press and hold (~1s): menu.
- Scroll up/down: navigate up/down.
- Device/system combos: restart, regulatory info, silent mode shortcuts.

### SDK UI coordinate space and limits (Even Hub SDK)
- Logical canvas/coordinate range: x in [0..576], y in [0..288], origin at top-left.
- Maximum containers per page: 4 total (across list + text + image).
- Exactly one container should be event-capture (`isEventCapture: 1`), others `0`.
- `containerName` max length: 16 chars.
- Text content limits:
  - startup text container content: up to 1000 chars
  - `textContainerUpgrade` content: up to 2000 chars
- List limits:
  - up to 20 items per list
  - item label up to 64 chars
- Image container limits from SDK docs:
  - width: 20..200
  - height: 20..100
  - some experimental simulator code in this repo uses larger image regions; treat official bounds as the hardware-safe contract.
- Startup behavior:
  - create page with `createStartUpPageContainer` once
  - do subsequent layout updates with `rebuildPageContainer`
  - image pixels are not carried by container creation alone; call `updateImageRawData` after create/rebuild.

### Image format + render transport
- `updateImageRawData.imageData` supports:
  - `number[]` (recommended by SDK docs)
  - `Uint8Array` / `ArrayBuffer` (SDK converts)
  - base64 string
- Repo examples:
  - `chess`: 1-bit BMP/PNG byte payloads for compact transport.
  - `stars`: base64 PNG updates from canvas.
- SDK guidance: do not send image updates concurrently; queue one-at-a-time.

### Event/control channels and event codes
- Event channels:
  - `textEvent`: primary path for scroll/swipe; also tap/double-tap.
  - `sysEvent`: tap/double-tap and sometimes scroll.
  - `listEvent`: list selection clicks (`currentSelectItemIndex`, `currentSelectItemName`).
- OsEventTypeList mapping:
  - `0`: click
  - `1`: scroll top (up)
  - `2`: scroll bottom (down)
  - `3`: double click
  - `4`: foreground enter
  - `5`: foreground exit
  - `6`: abnormal exit
- Practical compatibility rule: `eventType === undefined` is often a click-equivalent.

### Refresh rate and practical app render cadence
- Hardware panel is 60 Hz, but app payload throughput is bridge/bandwidth constrained.
- SDK explicitly warns to avoid high-frequency image pushes.
- Repo-proven behavior:
  - 5-10 FPS image update loops are common/stable targets.
  - keep text updates independent via `textContainerUpgrade` (lighter than full page rebuild).
  - use dirty-region updates and caching where possible.

### Bandwidth budgeting (engineering estimates for this repo)

No official end-to-end app payload throughput limit is published by Even. Use conservative budgeting:

- Audio uplink payload (from SDK PCM contract):
  - 40 bytes every 10 ms => ~4,000 bytes/s (~32 kbps) raw PCM bytes.
- Example image payload math:
  - 200 x 100 at 1-bit BMP: about 2,862 bytes/frame.
    - 5 FPS: ~14.3 KB/s
    - 10 FPS: ~28.6 KB/s
    - base64 transport overhead (~33%) raises that further.
  - 576 x 288 at 1-bit BMP: about 20,798 bytes/frame.
    - 10 FPS: ~208 KB/s before protocol overhead (typically too aggressive for BLE-style real-time updates).

Practical guidance:
- Favor <=200x100 image containers (or tile into multiple containers).
- Send one image update at a time (queued).
- Target 2-10 FPS based on frame size/complexity.
- Prefer text upgrades for high-frequency state feedback.

### Recommended default profile for new G2 apps
- Layout:
  - up to 2 image containers at 200x100
  - 1 active text container for event capture
  - 1 text/status container
- Loop:
  - start with 100-200 ms image cadence
  - back off cadence if updates queue up or latency appears
- Input handling:
  - process `textEvent`, `sysEvent`, `listEvent` in separate `if` blocks
  - apply swipe throttle (~250-350 ms)
  - dedupe click handling across channels

### Primary sources
- Even G2 product specs: `https://www.evenrealities.com/smart-glasses`
- G2 controls: `https://support.evenrealities.com/hc/en-us/articles/13754911116047-How-to-Control`
- R1 controls with G2 mapping: `https://support.evenrealities.com/hc/en-us/articles/13772400722063-How-to-Control`
- SDK limits and API semantics (local package docs in this repo):
  - `node_modules/@evenrealities/even_hub_sdk/README.md`
  - `apps/stars/SDK_DOCUMENTATION.md`

## 3. App-by-App Analysis

### `demo`
- Functionality:
  - baseline Even bridge connect flow
  - renders startup screen
  - logs simulated ring input/events in browser
- How it's built:
  - `apps/demo/even.ts` uses `EvenBetterSdk` page/text/list elements
  - robust event normalization (handles numeric/string event variants)
  - bridge timeout fallback to mock mode when unavailable

### `clock`
- Functionality:
  - real-time digital clock on glasses
  - pause/resume ticking from UI button
- How it's built:
  - `apps/clock/main.ts` builds text containers once, then updates time each second
  - uses `updateWithEvenHubSdk()` fast path, falls back to full `page.render()`
  - keeps render-in-flight guard to avoid overlapping updates

### `timer`
- Functionality:
  - list-based countdown presets (1/5/15/60/120 min)
  - click to start, double-click to stop
  - live current time while idle
- How it's built:
  - `apps/timer/main.ts` uses low-level SDK containers:
    - startup: list + title + clock
    - running: hides list and keeps tiny capture container for double-click
  - normalizes incomplete simulator events (missing index/name edge cases)
  - uses interval-driven state machine + `rebuildPageContainer`

### `restapi`
- Functionality:
  - configurable list of URLs
  - run GET requests from browser or glasses list selection
  - mirror response status/preview to glasses
- How it's built:
  - browser control panel generated in `apps/restapi/main.ts`
  - glasses list UI rendered via SDK list/text containers
  - all HTTP calls route through Vite endpoint `/__restapi_proxy` to avoid CORS issues
  - keeps browser select and glasses selected index synchronized

### `quicktest`
- Functionality:
  - fast iteration sandbox for generated Even SDK UI code
  - paste/edit source, render immediately on glasses
- How it's built:
  - imports `generated-ui.ts` as raw string (`?raw`)
  - compiles source at runtime with `new Function(...)` and SDK classes injected
  - first render uses `createStartUpPageContainer`; rerenders use `rebuildPageContainer`
  - includes editor helper link backed by `/__open_editor`

### `g2claude`
- Functionality:
  - voice prompt from G2 glasses mic to Claude
  - response rendered back on glasses, with scrollable pagination
  - optional mirror to Telegram (configured in bot repo)
- How it's built:
  - session/token bootstrap through `/__g2_session`
  - real-device audio capture uses SDK mic APIs:
    - `bridge.audioControl(true/false)` to open/close mic
    - `event.audioEvent.audioPcm` stream for PCM chunks
  - PCM is wrapped as 16 kHz / 16-bit mono WAV before `/__groq_transcribe`
  - transcript forwarded via `/__g2_send`; response awaited via `/__g2_poll`
  - bot posts final answer to `/__g2_receive` (Bearer auth via `EVEN_G2_BRIDGE_SECRET`)
  - ring controls:
    - tap start/stop listening
    - double-tap reset
    - scroll up/down paginate response lines

### `services/claude-code-telegram` (subrepo)
- Purpose:
  - colocated bot backend for G2 voice prompt execution and callback delivery.
- Notes:
  - tracked as a git submodule in `.gitmodules`.
  - default URL points to `https://github.com/OpTi9/claude-code-telegram.git`.
  - one-line stack startup now uses this subrepo path by default.

### `chess` (submodule)
- Functionality:
  - full chess app with multiple modes (AI play, bullet, academy drills)
  - persistent game/difficulty/board-marker preferences
  - Stockfish integration with fallback behavior
- How it's built:
  - architecture centered in `apps/chess/src/app.ts`:
    - `ChessService` + reducer store + turn loop + render composer + bridge
  - aggressive performance strategy:
    - debounced display flush
    - dirty image updates (top/bottom board halves)
    - async pre-render caches for likely next/prev selections
  - event-driven state transitions and side-effect orchestration

### `epub` (submodule)
- Functionality:
  - upload EPUB in browser, read on glasses with chapter/page navigation
  - progress bar + reading position persistence
- How it's built:
  - `apps/epub/src/epub-parser.ts` parses EPUB via JSZip + OPF spine extraction
  - text extraction normalizes HTML to readable plain text
  - `apps/epub/src/paginator.ts` wraps text with optional language-aware hyphenation
  - `apps/epub/src/even-client.ts` manages `library` and `reading` views with saved position in bridge local storage
  - optional `MockBridge` supports browser-only testing

### `reddit` (submodule)
- Functionality:
  - browse feed options, posts, comment lists, and comment detail
  - refreshable feed with on-device navigation
- How it's built:
  - `apps/reddit/src/even-client.ts` uses explicit view-state machine (`feeds/posts/comments/comment-detail`)
  - fetch layer in `apps/reddit/src/reddit-api.ts` retries network failures and 5xx/429
  - per-feed/per-post caching via bridge local storage with TTL
  - handles events from `textEvent`, `sysEvent`, and `listEvent` channels

### `transit` (submodule)
- Functionality:
  - configure saved routes in React UI
  - select route on glasses and view itineraries + leg details
- How it's built:
  - dual-surface architecture:
    - React configuration UI (`apps/transit/src/App.tsx`)
    - glasses state loop (`apps/transit/src/main.tsx`)
  - saved connections stored in bridge local storage
  - Motis API client (`apps/transit/src/motis.ts`) for geocode + route planning
  - glasses pages split into dedicated renderers (`pages/home.ts`, `pages/results.ts`, `pages/details.ts`)

### `stars` (submodule)
- Functionality:
  - real-time sky compass/overlay driven by head orientation
  - mode switching (finder/hints/time), target finding, explain overlays
- How it's built:
  - `apps/stars/src/main.ts` orchestrates:
    - gyroscope tracking,
    - offscreen canvas sky rendering,
    - text/image updates to glasses.
  - throttled render loop (10 FPS target), plus queued image transmission to avoid concurrent updates
  - modular subsystems:
    - `sky/` (catalogs/calculations/rendering),
    - `speech/` (target finding + model/API key flow),
    - `time/`, `explain/`, `ui/`.

## 4. Build-Anything Playbook (In This Repo)

### Choose one of these proven patterns
- Pattern A: Simple action app (`demo`, `clock`)
  - best for small prototypes and API checks
- Pattern B: State-machine app (`timer`, `restapi`, `reddit`, `epub`)
  - best for list-driven flows and multi-screen interaction
- Pattern C: Dual-surface app (`transit`, `stars`)
  - best when phone/browser config UI and glasses UI both matter
- Pattern D: Heavy engine app (`chess`)
  - best for high-frequency rendering and complex domain logic

### Recommended implementation sequence
1. Add `apps/<name>/index.ts` + `main.ts` implementing `AppModule`.
2. Define explicit state model first (view/state enums + transitions).
3. Implement bridge init with timeout + graceful mock fallback.
4. Render startup container once, then mutate with rebuild/upgrade APIs.
5. Normalize ring event types (number/string/undefined variants).
6. Add throttles/debounces before performance issues appear.
7. Add local persistence only for user-value state (selection, progress, settings).
8. Add browser debug logging (`#event-log`) and clear status messages.

### Event handling rules that prevent bugs
- Read all channels: `textEvent`, `sysEvent`, `listEvent`.
- Treat click as `CLICK_EVENT` **or** `undefined` when SDK parsing is inconsistent.
- For list UIs, guard missing `currentSelectItemIndex` and infer fallback index.
- Throttle repeated scroll/swipe events (`~300ms`) for stable navigation.

### Rendering/performance rules
- Do not send overlapping image updates; queue or skip while one is in flight.
- Prefer targeted updates (`textContainerUpgrade`) over full rebuild when possible.
- Keep a single source of truth state object; derive UI from state each render.
- For high-frequency apps, use:
  - dirty-region/partial updates,
  - precomputed caches,
  - coalesced render flushes.

### Network/API rules
- Use server-side proxy middleware for third-party HTTP in dev (`vite.config.ts`).
- Wrap requests with timeout + retry for unstable APIs.
- Cache expensive responses (bridge local storage is useful for on-device persistence).

### Real-device networking rules (G2 + Tailscale)
- Use Tailscale host only for device/browser entry URL + QR.
  - Example: `http://<tailscale-host>:5174/`
- If bot and Vite run on the same machine, set bot callback URL to localhost:
  - `EVEN_G2_URL=http://127.0.0.1:<vite-port>`
  - This avoids callback failures caused by local DNS/network path differences.
- Keep one fixed Vite port in active runs (`--strictPort`) and align:
  - QR URL port
  - `EVEN_G2_URL` port in bot `.env`
  - Vite `G2_BOT_PORT` target for `/__g2_send`
- For server-side middleware secrets/ports, prefer env loaded via Vite `loadEnv(...)`
  (not raw `process.env` only), so `.env.local` values are honored reliably.

### SDK-specific safety checks
- Instantiate SDK classes (`new TextContainerProperty(...)`), do not pass plain object types where class instances are expected.
- Keep container IDs stable across rebuild/update cycles.
- Ensure at least one capture container for interaction paths that need events.
- Handle bridge absence explicitly; never assume simulator/device is always connected.

## 5. Quick Start Templates

### Minimal new app skeleton
- Copy `apps/demo/index.ts` and `apps/demo/main.ts`.
- Replace action bodies with your connect/action logic.
- Run with `APP_NAME=<your-app> ./start-even.sh`.

### List-driven app skeleton
- Start from `apps/timer/main.ts` or `apps/restapi/main.ts`.
- Keep:
  - `state` object,
  - `renderPage()` function,
  - `registerEventLoop()` function,
  - event normalization helper.

### "Generated UI from tool" skeleton
- Start from `apps/quicktest/main.ts`.
- Keep runtime compile + rebuild pattern for iterative UI generation workflows.

## 6. Practical Build Tips

- Keep app-specific dependencies inside app folder only when needed (submodule style).
- Put shared pure helpers in app-local files first; promote to `apps/_shared` only after reuse appears.
- Prefer explicit `setStatus()` + log entries for every major state transition.
- If behavior depends on simulator quirks, encode that in normalization helpers once, not ad hoc in handlers.
- For complex apps, split into modules by responsibility (rendering, domain logic, input mapping, persistence).

---

If you are building a new feature and unsure where to start, use this decision order:
1. pick closest existing app pattern,
2. copy its state + render/event skeleton,
3. replace domain logic incrementally,
4. verify interaction channels (`text/sys/list`) before polishing UI.
