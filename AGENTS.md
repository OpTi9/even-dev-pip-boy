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

### Dev server middleware
- `vite.config.ts` adds utilities used by apps:
  - `/__restapi_proxy` for arbitrary GET proxy requests
  - `/reddit-api` and `/__reddit_proxy` for Reddit fetches
  - `/__open_editor` and `/__open_external` helpers
  - Stockfish asset serving for chess.

## 2. App-by-App Analysis

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

## 3. Build-Anything Playbook (In This Repo)

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

### SDK-specific safety checks
- Instantiate SDK classes (`new TextContainerProperty(...)`), do not pass plain object types where class instances are expected.
- Keep container IDs stable across rebuild/update cycles.
- Ensure at least one capture container for interaction paths that need events.
- Handle bridge absence explicitly; never assume simulator/device is always connected.

## 4. Quick Start Templates

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

## 5. Practical Build Tips

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
