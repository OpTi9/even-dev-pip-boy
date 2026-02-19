# Even Realities G2 App UI Guide

Based on analysis of the weather app (`apps/weather/weather-even-g2/`).

---

## Overview

G2 apps render UI as **PNG images pushed to the glasses display** (576×288 px). There is no reactive DOM or widget system — everything is drawn manually using the **HTML5 Canvas 2D API**, then converted to bytes and sent via the Even Hub SDK bridge.

A separate **React settings panel** runs in the browser for configuration (city search, connecting glasses). The two UIs are completely decoupled.

---

## Display Specifications

```typescript
// layout.ts
DISPLAY_WIDTH  = 576   // px
DISPLAY_HEIGHT = 288   // px
PADDING        = 12    // px (standard margin from edges)
```

All layout math uses these constants. Never hardcode pixel values inline.

---

## Core Rendering Pipeline

### 1. Create a canvas

```typescript
const canvas = document.createElement('canvas')
canvas.width  = 576
canvas.height = 288
const ctx = canvas.getContext('2d')!
```

### 2. Clear to black

Always start each frame with a full black fill, then reset stroke/fill to white:

```typescript
function clear(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle   = '#000'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle   = '#fff'
  ctx.strokeStyle = '#fff'
}
```

### 3. Draw content

See layout sections below.

### 4. Convert canvas to PNG bytes

```typescript
function canvasToBytes(canvas: HTMLCanvasElement): number[] {
  const dataUrl = canvas.toDataURL('image/png')
  const binary  = atob(dataUrl.split(',')[1])
  const bytes: number[] = []
  for (let i = 0; i < binary.length; i++) {
    bytes.push(binary.charCodeAt(i))
  }
  return bytes
}
```

### 5. Push image to glasses via SDK

```typescript
await bridge.updateImageRawData(
  new ImageRawDataUpdate({
    containerID:   1,
    containerName: 'screen',
    imageData:     bytes,
  })
)
```

### 6. Register containers (first render vs subsequent)

On first render use `createStartUpPageContainer`, then `rebuildPageContainer` for updates:

```typescript
async function rebuildPage(config) {
  if (!state.startupRendered) {
    await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(config))
    state.startupRendered = true
    return
  }
  await bridge.rebuildPageContainer(new RebuildPageContainer(config))
}
```

The config includes an image container for the rendered frame and a hidden 1×1 list container for capturing user input events:

```typescript
await rebuildPage({
  containerTotalNum: 2,
  imageObject: [
    new ImageContainerProperty({
      containerID: 1, containerName: 'screen',
      xPosition: 0,   yPosition: 0,
      width: 576,     height: 288,
    }),
  ],
  listObject: [
    new ListContainerProperty({
      containerID: 2,  containerName: 'evt',
      xPosition: 0,    yPosition: 0,
      width: 1,        height: 1,
      borderWidth: 0,  borderColor: 0,
      borderRdaius: 0, paddingLength: 0,
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: 1, itemWidth: 1,
        isItemSelectBorderEn: 0,
        itemName: [' '],
      }),
    }),
  ],
})
```

> **Why the hidden list?** A 1-item list is always at both scroll boundaries, so every swipe fires `SCROLL_TOP` or `SCROLL_BOTTOM`. This is the standard event-capture trick.

---

## Typography

### Font helper

```typescript
function font(ctx: CanvasRenderingContext2D, size: number, weight = ''): void {
  ctx.font = `${weight} ${size}px system-ui, -apple-system, sans-serif`.trim()
}

// Usage:
font(ctx, 15)           // 15px normal
font(ctx, 18, 'bold')   // 18px bold
```

### Standard font sizes

| Usage | Size | Weight |
|---|---|---|
| Current temperature (hero) | 36px | bold |
| High temp / daily | 18px | bold |
| Card values | 17px | bold |
| Screen headers | 15px | normal |
| City name (conditions) | 14px | normal |
| Secondary text, labels | 13px | normal or bold |
| Day names, descriptions | 12px | normal |
| Hourly time, precip % | 11px | normal |
| Axis labels, small tags | 10px | normal |
| Fine detail, wind data | 9px | normal |

### Text alignment

```typescript
ctx.textAlign    = 'left'   // default — left-align from x
ctx.textAlign    = 'center' // center on x
ctx.textAlign    = 'right'  // right-align to x
ctx.textBaseline = 'top'    // y is top of cap height
ctx.textBaseline = 'middle' // y is vertical center
```

---

## Color Palette

All colors are monochrome. The display is black-and-white with shades for hierarchy.

| Role | Value |
|---|---|
| Background | `#000` |
| Primary text / borders / highlights | `#fff` |
| Secondary text (city names, descriptions) | `#aaa` |
| Labels, wind info, de-emphasized | `#888` |
| Low temperatures, faded values | `#777` |
| Separators, grid lines | `#555` or `#444` |
| Card borders | `#333` |
| Fine grid lines | `#222` |
| Bar backgrounds | `#181818` |
| Gust area fill (wind chart) | `#1a1a1a` |
| High-precipitation highlight (≥50%) | `#aaf` |

---

## Layout Patterns

### Multi-column equal split

```typescript
const W      = 576
const colW   = Math.floor((W - PADDING * 2) / numCols)
const startX = PADDING

for (let i = 0; i < numCols; i++) {
  const cx = startX + colW * i + colW / 2  // center of column
}
```

### Two-panel split (33% / 67%)

```typescript
const gap    = 8
const totalW = W - PADDING * 2
const leftW  = Math.floor((totalW - gap) * 0.33)
const rightW = totalW - leftW - gap
const leftX  = PADDING
const rightX = leftX + leftW + gap
```

### 2×N card grid

```typescript
const cardGap = 6
const cardW   = Math.floor((rightW - cardGap) / 2)
const cardH   = Math.floor((contentH - cardGap * (rows - 1)) / rows)

for (let i = 0; i < cards.length; i++) {
  const col = i % 2
  const row = Math.floor(i / 2)
  const x   = rightX + col * (cardW + cardGap)
  const y   = y0     + row * (cardH + cardGap)
}
```

### Horizontal separator line

```typescript
ctx.strokeStyle = '#444'
ctx.lineWidth   = 1
ctx.beginPath()
ctx.moveTo(PADDING, y)
ctx.lineTo(W - PADDING, y)
ctx.stroke()
```

### Outlined box / card

```typescript
ctx.strokeStyle = '#444'
ctx.lineWidth   = 1
rr(ctx, x, y, w, h, 4)  // see rounded rect helper below
ctx.stroke()
```

---

## Primitive Helpers

### Rounded rectangle

```typescript
function rr(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  w: number, h: number,
  r: number
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y,     x + w, y + r,     r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h,     x, y + h - r,     r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y,         x + r, y,         r)
  ctx.closePath()
}

// Fill:
rr(ctx, x, y, w, h, 4)
ctx.fill()

// Stroke:
rr(ctx, x, y, w, h, 4)
ctx.stroke()
```

### Page indicator dots

```typescript
function drawPageDots(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  totalScreens: number,
  currentIndex: number
): void {
  const dotR  = 3
  const gap   = 12
  const totalW = totalScreens * dotR * 2 + (totalScreens - 1) * gap
  const startX = (w - totalW) / 2 + dotR
  const y      = h - 10

  for (let i = 0; i < totalScreens; i++) {
    const x = startX + i * (dotR * 2 + gap)
    ctx.beginPath()
    ctx.arc(x, y, dotR, 0, Math.PI * 2)
    if (i === currentIndex) {
      ctx.fillStyle = '#fff'
      ctx.fill()
    } else {
      ctx.strokeStyle = '#fff'
      ctx.lineWidth   = 1
      ctx.stroke()
    }
  }
}
```

---

## Data Visualisation

### Vertical bar chart (e.g. precipitation)

```typescript
const chartX  = PADDING
const chartW  = W - PADDING * 2
const barTop  = 44
const barBot  = 242
const barMaxH = barBot - barTop
const slotW   = chartW / numBars

for (let i = 0; i < numBars; i++) {
  const cx   = chartX + (i + 0.5) * slotW
  const barW = Math.max(4, slotW - 3)

  // Background
  ctx.fillStyle = '#181818'
  rr(ctx, cx - barW / 2, barTop, barW, barMaxH, 3)
  ctx.fill()

  // Fill proportional to value (0–100)
  const pct   = value / 100
  const fillH = Math.max(4, pct * barMaxH)
  const fillY = barBot - fillH
  ctx.fillStyle = pct >= 0.6 ? '#fff' : pct >= 0.3 ? '#aaa' : '#555'
  rr(ctx, cx - barW / 2, fillY, barW, fillH, 3)
  ctx.fill()
}
```

### Area chart (e.g. wind / temperature)

```typescript
const chartX   = PADDING + 30  // leave room for Y-axis labels
const chartW   = W - chartX - PADDING
const chartTop = 44
const chartBot = 230
const chartH   = chartBot - chartTop
const slotW    = chartW / count
const maxVal   = /* computed from data */

// Draw Y-axis grid
const gridSteps = 4
for (let g = 0; g <= gridSteps; g++) {
  const y = chartBot - (g / gridSteps) * chartH
  ctx.strokeStyle = '#222'
  ctx.lineWidth   = 1
  ctx.beginPath()
  ctx.moveTo(chartX, y)
  ctx.lineTo(chartX + chartW, y)
  ctx.stroke()
}

// Area fill
ctx.beginPath()
ctx.moveTo(chartX, chartBot)
for (let i = 0; i < count; i++) {
  const x = chartX + (i + 0.5) * slotW
  const y = chartBot - (data[i] / maxVal) * chartH
  ctx.lineTo(x, y)
}
ctx.lineTo(chartX + (count - 0.5) * slotW, chartBot)
ctx.closePath()
ctx.fillStyle = '#1a1a1a'
ctx.fill()

// Line overlay
ctx.beginPath()
for (let i = 0; i < count; i++) {
  const x = chartX + (i + 0.5) * slotW
  const y = chartBot - (data[i] / maxVal) * chartH
  i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
}
ctx.strokeStyle = '#fff'
ctx.lineWidth   = 2
ctx.stroke()
```

### Table / row list

```typescript
const rowH = 24
const y0   = 40  // top of first row

for (let i = 0; i < rows.length; i++) {
  const y = y0 + i * rowH

  // Row separator (skip first)
  if (i > 0) {
    ctx.strokeStyle = '#222'
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.moveTo(x0, y)
    ctx.lineTo(x0 + colW, y)
    ctx.stroke()
  }

  // Cells — adjust textAlign per column
  font(ctx, 11)
  ctx.fillStyle  = '#fff'
  ctx.textAlign  = 'left'
  ctx.fillText(rows[i].label, x0 + 4, y + rowH / 2)

  ctx.textAlign  = 'right'
  ctx.fillText(rows[i].value, x0 + colW - 4, y + rowH / 2)
}
```

---

## Drawing Directional Arrows

```typescript
function drawArrow(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  angleDeg: number,  // direction the arrow points
  size: number
): void {
  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate((angleDeg * Math.PI) / 180)
  ctx.beginPath()
  ctx.moveTo(0,            -size)          // tip
  ctx.lineTo(-size * 0.35,  size * 0.4)   // left base
  ctx.lineTo(0,             size * 0.15)  // notch
  ctx.lineTo( size * 0.35,  size * 0.4)   // right base
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}
```

---

## Programmatic Icon Rendering

All icons are drawn with Canvas primitives — no image assets. Save/restore context around each icon to avoid state bleed.

### Sun

```typescript
function drawSun(ctx, cx, cy, r) {
  ctx.save()
  ctx.fillStyle   = '#fff'
  ctx.strokeStyle = '#fff'
  ctx.lineWidth   = Math.max(1.5, r * 0.15)

  // Core disc
  ctx.beginPath()
  ctx.arc(cx, cy, r * 0.4, 0, Math.PI * 2)
  ctx.fill()

  // 8 rays
  for (let i = 0; i < 8; i++) {
    const angle = (i * Math.PI * 2) / 8
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(angle) * r * 0.55, cy + Math.sin(angle) * r * 0.55)
    ctx.lineTo(cx + Math.cos(angle) * r,         cy + Math.sin(angle) * r)
    ctx.stroke()
  }
  ctx.restore()
}
```

### Cloud

```typescript
function drawCloud(ctx, cx, cy, w, h) {
  ctx.save()
  ctx.fillStyle = '#fff'
  ctx.beginPath()
  ctx.arc(cx - w * 0.25, cy,          h * 0.45, 0, Math.PI * 2)
  ctx.arc(cx,            cy - h * 0.2, h * 0.55, 0, Math.PI * 2)
  ctx.arc(cx + w * 0.25, cy,          h * 0.45, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillRect(cx - w * 0.35, cy, w * 0.7, h * 0.3)
  ctx.restore()
}
```

### Rain lines

```typescript
function drawRain(ctx, cx, cy, w, s) {
  ctx.save()
  ctx.strokeStyle = '#fff'
  ctx.lineWidth   = Math.max(1, s * 0.15)
  const xs = [cx - w * 0.35, cx - w * 0.18, cx, cx + w * 0.18, cx + w * 0.35]
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]
    const y = cy + (i % 2 === 0 ? 0 : s * 0.2)
    ctx.beginPath()
    ctx.moveTo(x,            y)
    ctx.lineTo(x - s * 0.25, y + s)
    ctx.stroke()
  }
  ctx.restore()
}
```

### Icon dispatch by WMO weather code

```typescript
// Map WMO code → icon type
function wmoToIconType(code: number): string {
  if (code === 0)                          return 'clear'
  if (code <= 2)                           return 'partly-cloudy'
  if (code === 3)                          return 'cloudy'
  if (code === 45 || code === 48)          return 'fog'
  if (code >= 51 && code <= 67)            return 'rain'
  if (code >= 71 && code <= 77)            return 'snow'
  if (code >= 80 && code <= 82)            return 'rain'
  if (code >= 95)                          return 'storm'
  return 'cloudy'
}

// Render icon at position
function drawWeatherIconAt(ctx, wmoCode, cx, cy, size) {
  const type = wmoToIconType(wmoCode)
  const scaleMap = {
    'clear': 1, 'partly-cloudy': 1.3, 'cloudy': 1.5,
    'fog': 1.4, 'rain': 1.4, 'snow': 1.4, 'storm': 1.3,
  }
  const s = size * (scaleMap[type] ?? 1)

  switch (type) {
    case 'clear':        drawSun(ctx, cx, cy, s);   break
    case 'partly-cloudy': /* sun + cloud */          break
    case 'cloudy':       drawCloud(ctx, cx, cy, s * 1.2, s * 0.7); break
    case 'rain':         /* cloud + drawRain */      break
    // ...
  }
}
```

---

## Event Handling

### Normalize SDK events

The SDK can deliver events in several formats. Always normalize:

```typescript
import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'

function resolveEventType(event: EvenHubEvent): OsEventTypeList | undefined {
  const raw =
    event.listEvent?.eventType ??
    event.textEvent?.eventType ??
    event.sysEvent?.eventType ??
    (event.jsonData as Record<string, unknown>)?.eventType ??
    (event.jsonData as Record<string, unknown>)?.event_type

  if (typeof raw === 'number') {
    switch (raw) {
      case 0: return OsEventTypeList.CLICK_EVENT
      case 1: return OsEventTypeList.SCROLL_TOP_EVENT
      case 2: return OsEventTypeList.SCROLL_BOTTOM_EVENT
      case 3: return OsEventTypeList.DOUBLE_CLICK_EVENT
    }
  }
  if (typeof raw === 'string') {
    const v = raw.toUpperCase()
    if (v.includes('DOUBLE'))               return OsEventTypeList.DOUBLE_CLICK_EVENT
    if (v.includes('CLICK'))                return OsEventTypeList.CLICK_EVENT
    if (v.includes('SCROLL_TOP')  || v.includes('UP'))   return OsEventTypeList.SCROLL_TOP_EVENT
    if (v.includes('SCROLL_BOTTOM') || v.includes('DOWN')) return OsEventTypeList.SCROLL_BOTTOM_EVENT
  }
}
```

### Dispatch events + scroll throttle

```typescript
const SCROLL_COOLDOWN_MS = 300
let lastScrollTime = 0

function scrollThrottled(): boolean {
  const now = Date.now()
  if (now - lastScrollTime < SCROLL_COOLDOWN_MS) return true
  lastScrollTime = now
  return false
}

function onEvenHubEvent(event: EvenHubEvent): void {
  const type = resolveEventType(event)
  switch (type) {
    case OsEventTypeList.CLICK_EVENT:
      nextScreen(); void showScreen()
      break
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      if (!scrollThrottled()) { nextScreen(); void showScreen() }
      break
    case OsEventTypeList.SCROLL_TOP_EVENT:
      if (!scrollThrottled()) { prevScreen(); void showScreen() }
      break
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      firstScreen(); void refresh()
      break
  }
}
```

### Input summary

| Gesture | Event | Default action |
|---|---|---|
| Single tap | `CLICK_EVENT` | Next screen |
| Swipe down | `SCROLL_BOTTOM_EVENT` | Next screen (throttled) |
| Swipe up | `SCROLL_TOP_EVENT` | Previous screen (throttled) |
| Double tap | `DOUBLE_CLICK_EVENT` | Go to first screen + refresh |

---

## State Management

Use a single exported state object:

```typescript
// state.ts
export type AppState = {
  screenIndex:     number
  startupRendered: boolean
  data:            YourDataType | null
}

export const state: AppState = {
  screenIndex:     0,
  startupRendered: false,
  data:            null,
}

export let bridge: EvenAppBridge | null = null
export function setBridge(b: EvenAppBridge) { bridge = b }
```

---

## Multi-Screen Navigation

```typescript
const SCREENS = ['forecast', 'now', 'rain', 'wind', 'hours'] as const
type Screen = typeof SCREENS[number]

function nextScreen()  { state.screenIndex = (state.screenIndex + 1) % SCREENS.length }
function prevScreen()  { state.screenIndex = (state.screenIndex - 1 + SCREENS.length) % SCREENS.length }
function firstScreen() { state.screenIndex = 0 }

async function showScreen() {
  const screen = SCREENS[state.screenIndex]
  const canvas = document.createElement('canvas')
  canvas.width  = 576
  canvas.height = 288
  const ctx = canvas.getContext('2d')!

  clear(ctx, 576, 288)

  switch (screen) {
    case 'forecast': drawForecastScreen(ctx); break
    case 'now':      drawNowScreen(ctx);      break
    // ...
  }

  drawPageDots(ctx, 576, 288, SCREENS.length, state.screenIndex)

  await pushImage(canvasToBytes(canvas))
}
```

Always draw page dots on every screen so the user knows their position.

---

## React Settings Panel

The browser-side settings UI uses React + `@jappyjan/even-realities-ui`.

```tsx
// ui.tsx
import React, { useState, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { Card, CardHeader, CardContent, Button, Input, Text }
  from '@jappyjan/even-realities-ui'
import '@jappyjan/even-realities-ui/dist/even-realities-ui.css'

function SettingsPanel() {
  return (
    <Card>
      <CardHeader><Text>Settings</Text></CardHeader>
      <CardContent>
        {/* your config UI */}
      </CardContent>
    </Card>
  )
}

export function initUI(
  root: HTMLElement,
  callbacks: { onRefresh: () => void; onConnect: () => void }
) {
  createRoot(root).render(<SettingsPanel {...callbacks} />)
}
```

---

## File Structure for a New App

```
my-app/
  g2/
    index.ts      – module exports & registration
    main.ts       – bridge init, action definitions
    app.ts        – initApp(), refresh logic, auto-interval
    state.ts      – AppState type + singleton + bridge ref
    layout.ts     – DISPLAY_WIDTH, DISPLAY_HEIGHT, PADDING
    renderer.ts   – showScreen(), drawXxxScreen(), helpers
    icons.ts      – programmatic icon drawing
    events.ts     – resolveEventType(), onEvenHubEvent()
    ui.tsx        – React settings panel
  package.json
  vite.config.ts
```

---

## Quick Reference Checklist

- [ ] Canvas is 576×288, always cleared to `#000` before drawing
- [ ] All text uses `system-ui, -apple-system, sans-serif`
- [ ] Layout uses `PADDING = 12` from edges; column widths computed with `Math.floor`
- [ ] Page dots drawn at bottom-center of every screen
- [ ] Hidden 1×1 list container registered alongside image container for event capture
- [ ] Scroll events throttled at 300 ms to prevent duplicate navigation
- [ ] SDK events normalized via `resolveEventType()` before dispatch
- [ ] Icons drawn programmatically — no image files
- [ ] `ctx.save()` / `ctx.restore()` used around icon drawing to prevent state leakage
- [ ] `state.startupRendered` guards `createStartUpPageContainer` vs `rebuildPageContainer`

---

## Chess App UI Approach

Based on analysis of `apps/chess/src/render/`.

The chess app uses a fundamentally **different rendering strategy** from the weather app. Instead of one full-screen canvas PNG, it uses **mixed container types** (text + multiple images), renders graphics to **raw 1-bit pixel buffers** encoded as BMP, and applies **dirty-tracking** to only re-send the image halves that actually changed.

---

### Layout: Three Containers Side-by-Side

```
┌────────────────────────────────────┬──────────┐
│  TextContainerProperty             │  Brand   │  ← y=4, centered horizontally
│  (chess-hud)                       │  200×24  │
│  x=0, y=0, w=368, h=288           ├──────────┤
│                                    │ Board    │  ← top half, 200×100
│  Plain text — SDK renders natively │ (top)    │
│  isEventCapture=1                  ├──────────┤
│                                    │ Board    │  ← bottom half, 200×100
│                                    │ (bottom) │
└────────────────────────────────────┴──────────┘
```

Key dimension constants (`composer.ts`):

```typescript
const DISPLAY_HEIGHT   = 288
const IMAGE_WIDTH      = 200   // SDK image container max width
const IMAGE_HEIGHT     = 100   // SDK image container max height
const RIGHT_X          = 376   // where image panel starts (px from left)
const LEFT_WIDTH       = 368   // text container width
const BRAND_WIDTH      = 200
const BRAND_HEIGHT     = 24
```

The board is 200×200 px but **SDK image containers are capped at 200×100**, so the board is split into top and bottom halves, registered as two separate `ImageContainerProperty` objects stacked vertically.

---

### Container Registration

```typescript
// composer.ts — buildContainers()

// 1. Full-height text panel on the left (also captures events)
textObjects.push(new TextContainerProperty({
  xPosition: 0, yPosition: 0,
  width: LEFT_WIDTH, height: DISPLAY_HEIGHT,
  containerID: CONTAINER_ID_TEXT,
  containerName: 'chess-hud',
  content: getCombinedDisplayText(state),
  isEventCapture: 1,   // ← no hidden list needed; text container captures events
}))

// 2. Top half of board
const boardTopY = Math.floor((DISPLAY_HEIGHT - IMAGE_HEIGHT * 2) / 2) // vertically center 200px in 288px
imageObjects.push(new ImageContainerProperty({
  xPosition: RIGHT_X, yPosition: boardTopY,
  width: IMAGE_WIDTH,  height: IMAGE_HEIGHT,
  containerID: CONTAINER_ID_IMAGE_TOP,
  containerName: 'board-top',
}))

// 3. Bottom half of board
imageObjects.push(new ImageContainerProperty({
  xPosition: RIGHT_X, yPosition: boardTopY + IMAGE_HEIGHT,
  width: IMAGE_WIDTH,  height: IMAGE_HEIGHT,
  containerID: CONTAINER_ID_IMAGE_BOTTOM,
  containerName: 'board-bot',
}))

// 4. Branding strip (centered horizontally at top)
const brandX = Math.floor((DISPLAY_WIDTH - BRAND_WIDTH) / 2)
imageObjects.push(new ImageContainerProperty({
  xPosition: brandX, yPosition: 4,
  width: BRAND_WIDTH, height: BRAND_HEIGHT,
  containerID: CONTAINER_ID_BRAND,
  containerName: 'brand',
}))
```

> **Event capture**: The text container has `isEventCapture: 1`, so it receives all gesture events. No hidden 1×1 list is needed — text containers can serve the same role.

---

### 1-Bit Pixel Buffer Rendering (No Canvas)

Instead of drawing on a `<canvas>`, the chess board renders into a flat `Uint8Array` of 1-bit pixels (0 = black, 1 = white), then encodes to BMP or PNG.

```typescript
// boardimage.ts

const BUF_W = 200          // image width
const BUF_H = 200          // total board height (top + bottom halves combined)

class BoardRenderer {
  private basePixels: Uint8Array = new Uint8Array(BUF_W * BUF_H)  // board + pieces, no highlights
  private workPixels: Uint8Array = new Uint8Array(BUF_W * BUF_H)  // scratch buffer
  private cachedTopBmp:    Uint8Array = initBmpBuffer()
  private cachedBottomBmp: Uint8Array = initBmpBuffer()
}
```

**setPixel** — the primitive write operation:

```typescript
function setPixel(pixels: Uint8Array, x: number, y: number, value: number): void {
  if (x >= 0 && x < BUF_W && y >= 0 && y < BUF_H) {
    pixels[y * BUF_W + x] = value
  }
}
```

**fillCell** — fill an entire square with one value:

```typescript
const CELL = 23  // px per chess square

function cellX(file: number) { return GRID_X + file * CELL }
function cellY(rank: number) { return GRID_Y + rank * CELL }

function fillCell(pixels: Uint8Array, file: number, rank: number, value: number): void {
  const x0 = cellX(file)
  const y0 = cellY(rank)
  for (let dy = 0; dy < CELL; dy++)
    for (let dx = 0; dx < CELL; dx++)
      setPixel(pixels, x0 + dx, y0 + dy, value)
}
```

**Board construction** — called whenever FEN changes:

```typescript
function rebuildBase(chess: ChessService): void {
  pixels.fill(0)  // start with all-black

  // 1. Fill entire grid area white
  for (let y = GRID_Y; y < GRID_Y + GRID_SIZE; y++)
    for (let x = GRID_X; x < GRID_X + GRID_SIZE; x++)
      setPixel(pixels, x, y, 1)

  // 2. Black out dark squares
  for (let rank = 0; rank < 8; rank++)
    for (let file = 0; file < 8; file++)
      if ((rank + file) % 2 === 1) fillCell(pixels, file, rank, 0)

  // 3. Draw border, labels, pieces
  drawBorder(pixels)
  drawFileLabels(pixels)
  drawRankLabels(pixels)
  for each piece: drawPiece(pixels, file, rank, color, type)
}
```

---

### BMP Encoding

The pixel buffer is encoded into a **1-bit monochrome BMP** file entirely in JavaScript — no browser APIs required.

```typescript
// bmp-constants.ts
BMP_FILE_HEADER_SIZE = 14
BMP_DIB_HEADER_SIZE  = 40
BMP_COLOR_TABLE_SIZE = 8      // 2 colors × 4 bytes
BMP_HEADER_SIZE      = 62     // total header

// Row stride must be 4-byte aligned
function getBmpRowStride(width: number): number {
  return Math.ceil(Math.ceil(width / 8) / 4) * 4
}
```

**Writing pixel data** (BMP stores rows bottom-up):

```typescript
function encodeBmpPixels(bmpBuffer: Uint8Array, pixels: Uint8Array): void {
  bmpBuffer.fill(0, BMP_HEADER_SIZE)

  for (let y = 0; y < IMAGE_HEIGHT; y++) {
    const srcRow    = IMAGE_HEIGHT - 1 - y   // BMP bottom-up flip
    const dstOffset = BMP_HEADER_SIZE + y * BMP_ROW_STRIDE

    for (let x = 0; x < IMAGE_WIDTH; x++) {
      if (pixels[srcRow * IMAGE_WIDTH + x]) {
        const byteIdx = dstOffset + Math.floor(x / 8)
        const bitIdx  = 7 - (x % 8)          // MSB = leftmost
        bmpBuffer[byteIdx]! |= 1 << bitIdx
      }
    }
  }
}
```

**BMP header initialisation** (color table: black=0, white=1):

```typescript
function initBmpBuffer(): Uint8Array {
  const buf  = new ArrayBuffer(BMP_FILE_SIZE)
  const view = new DataView(buf)
  // ... write signature, file size, offsets, DIB header ...
  view.setUint32(54, 0x00000000, true)   // color 0 = black
  view.setUint32(58, 0x00ffffff, true)   // color 1 = white
  return new Uint8Array(buf)
}
```

---

### PNG Fallback (Smaller BLE Payload)

For lower bandwidth over BLE, the renderer can encode to PNG using a reusable canvas pool:

```typescript
// png-encode.ts — 4 canvas slots for parallel encoding (top+bottom, plus next+prev prefetch)
const reusedCanvases: (HTMLCanvasElement | null)[] = new Array(4).fill(null)

export function encodePixelsToPng(
  pixels: Uint8Array, width: number, height: number, slot: 0 | 1 | 2 | 3 = 0
): Promise<Uint8Array> {
  const canvas = reusedCanvases[slot] ??= document.createElement('canvas')
  canvas.width  = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!

  // Convert 1-bit pixels to RGBA ImageData
  const imageData = ctx.createImageData(width, height)
  for (let i = 0; i < width * height; i++) {
    const v = pixels[i] ? 255 : 0
    imageData.data[i * 4]     = v   // R
    imageData.data[i * 4 + 1] = v   // G
    imageData.data[i * 4 + 2] = v   // B
    imageData.data[i * 4 + 3] = 255 // A
  }
  ctx.putImageData(imageData, 0, 0)

  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      const reader = new FileReader()
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
      reader.readAsArrayBuffer(blob!)
    }, 'image/png')
  })
}
```

Use BMP (sync) for fast updates; use PNG (async) when bandwidth is the bottleneck.

---

### Dirty-Tracking: Only Re-Encode Changed Halves

The split board enables **per-half dirty tracking** — if a highlight only moves within the top half, only the top BMP is re-encoded and sent.

```typescript
render(state: GameState, chess: ChessService): ImageRawDataUpdate[] {
  const fenChanged = state.fen !== this.lastFen
  if (fenChanged) {
    this.rebuildBase(chess)   // expensive: redraw all pieces
    this.lastFen = state.fen
  }

  const highlights = getHighlights(state)  // selected square + destination
  this.currentHighlightKeys.clear()
  for (const h of highlights)
    this.currentHighlightKeys.add(`${h.file},${h.rank},${h.style}`)

  if (!fenChanged) {
    // Check which halves have changed highlights
    let topDirty = false, bottomDirty = false
    const allKeys = new Set([...this.prevHighlightKeys, ...this.currentHighlightKeys])
    for (const key of allKeys) {
      if (this.prevHighlightKeys.has(key) !== this.currentHighlightKeys.has(key)) {
        const rank = parseInt(key.split(',')[1]!, 10)
        if (cellY(rank) + CELL <= SPLIT_Y) topDirty = true
        else bottomDirty = true
      }
    }
    if (!topDirty && !bottomDirty) return []   // nothing changed, send nothing
  }

  // Apply highlights to work buffer, encode only dirty halves
  this.workPixels.set(this.basePixels)
  for (const hl of highlights) highlightCell(this.workPixels, hl.file, hl.rank, hl.style)

  const dirty: ImageRawDataUpdate[] = []
  if (topDirty || fenChanged) {
    encodeBmpPixels(this.cachedTopBmp, this.workPixels.subarray(0, BUF_W * IMAGE_HEIGHT))
    dirty.push(new ImageRawDataUpdate({ containerID: CONTAINER_ID_IMAGE_TOP, ... imageData: this.cachedTopBmp.slice() }))
  }
  if (bottomDirty || fenChanged) {
    encodeBmpPixels(this.cachedBottomBmp, this.workPixels.subarray(BUF_W * IMAGE_HEIGHT))
    dirty.push(new ImageRawDataUpdate({ containerID: CONTAINER_ID_IMAGE_BOTTOM, ... imageData: this.cachedBottomBmp.slice() }))
  }
  return dirty
}
```

---

### Highlight Styles

Two visual styles drawn directly into the pixel buffer:

**`selected`** — diagonal striped border, 3 px wide:

```typescript
// Each border pixel alternates on/off based on (dx + t) % 4 < 2
const borderWidth = 3
for (let t = 0; t < borderWidth; t++) {
  for (let dx = 0; dx < CELL; dx++) {
    const stripe = (dx + t) % 4 < 2 ? 1 : 0
    setPixel(pixels, x0 + dx, y0 + t,           stripe)  // top edge
    setPixel(pixels, x0 + dx, y0 + CELL - 1 - t, stripe) // bottom edge
  }
  for (let dy = 0; dy < CELL; dy++) {
    const stripe = (dy + t) % 4 < 2 ? 1 : 0
    setPixel(pixels, x0 + t,           y0 + dy, stripe)  // left edge
    setPixel(pixels, x0 + CELL - 1 - t, y0 + dy, stripe) // right edge
  }
}
```

**`destination`** — outlined X (two-pass: white outline first, black X on top):

```typescript
const pad = 5, size = CELL - pad * 2
// Pass 1: white halo around where the X will be
// Pass 2: black X pixels on top
for (let i = 0; i < size; i++) {
  const d1 = i, d2 = size - 1 - i
  for (let t = -1; t <= 0; t++) {
    setPixel(pixels, x0 + pad + d1 + t, y0 + pad + i, 0)  // black X
    setPixel(pixels, x0 + pad + d2 + t, y0 + pad + i, 0)
  }
}
```

---

### Piece Silhouettes as Bitmasks

Each piece is a **19×19 bitmap** — an array of 19 numbers where each number's bits represent one row (MSB = leftmost pixel):

```typescript
// pieces.ts
export const PIECE_SIZE = 19

export const PIECE_SILHOUETTES: Record<string, number[]> = {
  k: [  // King
    0b0000000010000000000,  // row 0: cross top
    0b0000000111000000000,  // row 1: cross horizontal
    // ...
  ],
  q: [ /* Queen */ ],
  r: [ /* Rook  */ ],
  b: [ /* Bishop */ ],
  n: [ /* Knight */ ],
  p: [ /* Pawn  */ ],
}
```

**Drawing a piece** — iterate bitmask, write pixels with color logic:

```typescript
function drawPiece(pixels, file, rank, color, type) {
  const isDark     = (rank + file) % 2 === 1
  const silhouette = PIECE_SILHOUETTES[type]

  // Bottom-align piece within cell (seat on the square)
  const bottomRow = findBottomRow(silhouette)
  const x0 = cellX(file) + Math.floor((CELL - PIECE_SIZE) / 2)
  const y0 = cellY(rank) + CELL - 4 - bottomRow

  if (color === 'b') {
    // Black pieces: fill with 0 (black); add white outline on dark squares for contrast
    drawOutline(pixels, silhouette, x0, y0, isDark ? 1 : 0)  // outline value inverts
    drawFill(pixels, silhouette, x0, y0, 0)

  } else {
    // White pieces: outline + stipple interior ((row+col)%2 alternates)
    const outlineVal = isDark ? 1 : 0
    const stippleVal = isDark ? 1 : 0
    for (let row = 0; row < PIECE_SIZE; row++) {
      for (let col = 0; col < PIECE_SIZE; col++) {
        if (silhouette[row] & (1 << (PIECE_SIZE - 1 - col))) {
          const edge = isEdgePixel(silhouette, row, col)
          setPixel(pixels, x0+col, y0+row, edge ? outlineVal : (row+col)%2 === 0 ? stippleVal : baseVal)
        }
      }
    }
  }
}
```

**Stipple fill** gives white pieces visual texture on a white background — alternating pixels create a 50% grey-like appearance in 1-bit rendering.

---

### Bitmap Font Rendering

Board labels (A–H, 1–8) and the branding logo both use **bitmask fonts** — no system font rendering.

**Board labels** — 5×7 pixel font (`boardimage.ts`):

```typescript
const FONT: Record<string, number[]> = {
  'A': [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  'B': [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  // ... all needed chars
}

function drawChar(pixels: Uint8Array, x: number, y: number, ch: string): void {
  const glyph = FONT[ch]
  if (!glyph) return
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 5; col++) {
      if (glyph[row]! & (1 << (4 - col)))
        setPixel(pixels, x + col, y + row, 1)
    }
  }
}
```

**Branding logo** — 12×16 pixel font (`branding.ts`):

```typescript
const BRAND_FONT: Record<string, number[]> = {
  'E': [0b011111111110, 0b111111111111, /* 16 rows */],
  'V': [ /* ... */ ],
  // E, V, N, C, H, S, K, '.', '!'
}

function drawBrandChar(pixels, x, y, ch): number {
  const charWidth = ch === '.' ? 4 : 12   // dot is narrower
  // iterate rows × cols, setPixel for each '1' bit
  return charWidth + 2  // advance including 2px spacing
}
```

**Rendering "EVEN.CHESS" + knight icon**:

```typescript
let xPos = 2
const yPos = Math.floor((BRAND_HEIGHT - 16) / 2)

for (const ch of 'EVEN.CHESS') {
  xPos += drawBrandChar(pixels, xPos, yPos, ch)
}

// Append the knight silhouette icon after the text
const knightX = xPos + 4
drawKnightIcon(pixels, knightX, Math.floor((BRAND_HEIGHT - 19) / 2))
```

---

### Text Container as HUD

The left panel uses a `TextContainerProperty` — the SDK renders the text natively, so no pixel drawing is needed for the HUD.

**Content** is plain text with newlines and Unicode characters for visual structure:

```typescript
const SEPARATOR_LINE = '────────'   // box-drawing chars for horizontal rule
const ARROW_LEFT  = '◀'
const ARROW_RIGHT = '▶'
const ARROW_UP    = '▲'
const ARROW_DOWN  = '▼'
```

**Menu list** pattern (shows selected item with `>` prefix):

```typescript
function getMenuDisplayText(state: GameState): string {
  const lines = ['', 'MENU', '']
  MENU_LABELS.forEach((label, i) => {
    lines.push(`${i === state.menuSelectedIndex ? '> ' : '  '}${label}`)
  })
  return lines.join('\n')
}
```

**Carousel / selector** pattern (item shown between arrows):

```typescript
const selectionLine = `${ARROW_LEFT} ${current} (${index+1}/${total}) ${ARROW_RIGHT}`
// Unicode arrows are ~2× wide, so compensate label centering:
const padding = Math.max(0, Math.floor((selectionLine.length + 2 - label.length) / 2) + 3)
lines.push(' '.repeat(padding) + label)
lines.push(selectionLine)
```

> **SDK text limit**: The text container content must stay under **2000 characters**. The move log truncates to the 40 most recent move pairs to stay within this.

---

### Branding Strip Caching

The "EVEN.CHESS" logo never changes, so it is rendered once and cached:

```typescript
let cachedBrandImage: ImageRawDataUpdate | null = null

export function renderBrandingImage(): ImageRawDataUpdate {
  if (cachedBrandImage) return cachedBrandImage
  // ... render logo pixels → BMP → ImageRawDataUpdate ...
  cachedBrandImage = new ImageRawDataUpdate({ containerID: CONTAINER_ID_BRAND, ... })
  return cachedBrandImage
}

// Variants:
renderBrandingImage()       // "EVEN.CHESS ♞" — normal
renderBlankBrandingImage()  // all-black pixels — used when branding should be hidden
renderCheckBrandingImage()  // "CHECK!" — flashed when player is in check
```

---

### Chess vs Weather: Key Differences

| Aspect | Weather app | Chess app |
|---|---|---|
| Image format | PNG via `canvas.toDataURL()` | 1-bit BMP (manual encoding) or PNG via canvas |
| Pixel source | Canvas 2D API drawing calls | Raw `Uint8Array` with `setPixel()` |
| Container types | Image only (+ hidden list for events) | Text + multiple image containers |
| Event capture | Hidden 1×1 list container | `isEventCapture=1` on text container |
| Board split | N/A — single 576×288 canvas | 200×200 board split into two 200×100 halves |
| Dirty tracking | Full redraw every frame | Per-half dirty tracking; unchanged halves skipped |
| Text / HUD | Drawn on canvas with `ctx.fillText()` | SDK-native `TextContainerProperty` |
| Font rendering | System font via Canvas | Bitmask font arrays (5×7 and 12×16) |
| Icon/piece art | Canvas drawing primitives | 19×19 bitmask silhouettes |
| Caching | None | `basePixels` (board+pieces), BMP buffers, brand image |
