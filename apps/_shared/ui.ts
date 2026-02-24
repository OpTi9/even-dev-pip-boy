export const LAYOUT = {
  CANVAS_W: 576,
  CANVAS_H: 288,
  TITLE_X: 8,
  TITLE_Y: 0,
  TITLE_W: 560,
  TITLE_H: 28,
  BODY_X: 8,
  BODY_Y: 28,
  BODY_H: 260,
  BODY_W_FULL: 560,
  BODY_W_SCROLL: 548,
  BODY_PADDING: 4,
  SCROLLBAR_X: 562,
  SCROLLBAR_W: 10,
  TITLE_BORDER_WIDTH: 1,
  TITLE_BORDER_COLOR: 8,
} as const

export const DISPLAY = {
  MAX_WRAP_CHARS: 40,
  DISPLAY_WINDOW_LINES: 9,
  MAX_TITLE_CHARS: 35,
  SCROLL_TRACK_CHAR: '·',
  SCROLL_THUMB_CHAR: '•',
  SCROLL_ARROW_TOP: '▲',
  SCROLL_ARROW_BOTTOM: '▼',
  PROGRESS_FILLED: '▰',
  PROGRESS_EMPTY: '▱',
  PROGRESS_SEGMENTS: 8,
  SPINNER_CHARS: ['◌', '◎', '◉', '◎'] as const,
  SPINNER_CHARS_ASCII: ['-', '\\', '|', '/'] as const,
  SCROLL_ARROW_ASCII_TOP: '^',
  SCROLL_ARROW_ASCII_BOTTOM: 'v',
  PROGRESS_FILLED_ASCII: '=',
  PROGRESS_EMPTY_ASCII: '.',
  SCROLL_INDICATOR_FILLED: '▮',
  SCROLL_INDICATOR_EMPTY: '▯',
} as const

export function sanitizeDisplayText(text: string): string {
  return text
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\r/g, '')
    .trim()
}

export function wrapLine(line: string, maxChars: number): string[] {
  const normalized = line
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')

  if (!normalized.trim()) {
    return []
  }

  const words = normalized.trim().split(/\s+/)
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    if (!current) {
      if (word.length <= maxChars) {
        current = word
        continue
      }

      for (let i = 0; i < word.length; i += maxChars) {
        lines.push(word.slice(i, i + maxChars))
      }
      current = ''
      continue
    }

    const candidate = `${current} ${word}`
    if (candidate.length <= maxChars) {
      current = candidate
      continue
    }

    lines.push(current)

    if (word.length <= maxChars) {
      current = word
      continue
    }

    for (let i = 0; i < word.length; i += maxChars) {
      lines.push(word.slice(i, i + maxChars))
    }
    current = ''
  }

  if (current) {
    lines.push(current)
  }

  return lines
}

export function wrapText(text: string, maxChars = DISPLAY.MAX_WRAP_CHARS): string[] {
  const source = sanitizeDisplayText(text)
  const rows = source.split('\n')
  const wrapped: string[] = []

  for (const row of rows) {
    wrapped.push(...wrapLine(row, maxChars))
  }

  if (wrapped.length === 0) {
    return ['(empty)']
  }

  return wrapped
}

export function truncateStatus(text: string, maxLen: number = DISPLAY.MAX_TITLE_CHARS): string {
  if (text.length <= maxLen) {
    return text
  }

  if (maxLen <= 1) {
    return '…'
  }

  return `${text.slice(0, maxLen - 1)}…`
}

export function buildProgressBar(pct: number, segments = DISPLAY.PROGRESS_SEGMENTS): string {
  const clampedPct = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0))
  const safeSegments = Math.max(1, Math.floor(segments))
  const filled = Math.round((clampedPct / 100) * safeSegments)
  const empty = safeSegments - filled
  return `${DISPLAY.PROGRESS_FILLED.repeat(filled)}${DISPLAY.PROGRESS_EMPTY.repeat(empty)}`
}

export function buildScrollbarLines(
  totalLines: number,
  scrollOffset: number,
  visible: number,
): string[] {
  const rows: string[] = Array.from({ length: DISPLAY.DISPLAY_WINDOW_LINES }, () => DISPLAY.SCROLL_TRACK_CHAR)
  const safeVisible = Math.max(1, visible)
  const total = Math.max(safeVisible, totalLines)
  const maxOffset = Math.max(0, total - safeVisible)

  const thumbSize = Math.max(
    1,
    Math.min(
      safeVisible,
      Math.round((safeVisible * safeVisible) / total),
    ),
  )
  const maxThumbTop = Math.max(0, safeVisible - thumbSize)
  const thumbTop = maxOffset > 0
    ? Math.round((Math.max(0, Math.min(maxOffset, scrollOffset)) / maxOffset) * maxThumbTop)
    : 0

  for (let i = 0; i < thumbSize; i += 1) {
    const rowIndex = Math.max(0, Math.min(rows.length - 1, thumbTop + i))
    rows[rowIndex] = DISPLAY.SCROLL_THUMB_CHAR
  }

  if (scrollOffset > 0 && rows.length > 0) {
    rows[0] = DISPLAY.SCROLL_ARROW_TOP
  }

  if (scrollOffset + safeVisible < totalLines && rows.length > 0) {
    rows[rows.length - 1] = DISPLAY.SCROLL_ARROW_BOTTOM
  }

  return rows
}

export function buildScrollIndicator(
  scrollOffset: number,
  totalLines: number,
  visibleRows: number,
  segments = 6,
): string {
  const safeVisible = Math.max(1, visibleRows)
  if (totalLines <= safeVisible) {
    return ''
  }

  const safeSegments = Math.max(1, Math.floor(segments))
  const maxOffset = Math.max(1, totalLines - safeVisible)
  const clampedOffset = Math.max(0, Math.min(maxOffset, scrollOffset))
  const ratio = clampedOffset / maxOffset
  const filled = Math.max(1, Math.min(safeSegments, Math.round(ratio * safeSegments)))
  const empty = safeSegments - filled

  return `${DISPLAY.SCROLL_INDICATOR_FILLED.repeat(filled)}${DISPLAY.SCROLL_INDICATOR_EMPTY.repeat(empty)}`
}
