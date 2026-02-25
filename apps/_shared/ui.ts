export const LAYOUT = {
  CANVAS_W: 576,
  CANVAS_H: 288,
  TITLE_X: 4,
  TITLE_Y: 0,
  TITLE_W: 568,
  TITLE_H: 28,
  BODY_X: 4,
  BODY_Y: 28,
  BODY_H: 260,
  BODY_W_FULL: 568,
  BODY_W_SCROLL: 568,
  BODY_PADDING: 4,
  SCROLLBAR_X: 562,
  SCROLLBAR_W: 10,
  TITLE_BORDER_WIDTH: 0,
  TITLE_BORDER_COLOR: 8,
} as const

export const DISPLAY = {
  MAX_WRAP_CHARS: 58,
  DISPLAY_WINDOW_LINES: 9,
  MAX_TITLE_CHARS: 35,
  CHARS_PER_LINE: 58,
  LINES_PER_PAGE: 9,
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
      const chars = Array.from(word)
      if (chars.length <= maxChars) {
        current = word
        continue
      }

      for (let i = 0; i < chars.length; i += maxChars) {
        lines.push(chars.slice(i, i + maxChars).join(''))
      }
      current = ''
      continue
    }

    const candidate = `${current} ${word}`
    const candidateChars = Array.from(candidate)
    if (candidateChars.length <= maxChars) {
      current = candidate
      continue
    }

    lines.push(current)

    const wordChars = Array.from(word)
    if (wordChars.length <= maxChars) {
      current = word
      continue
    }

    for (let i = 0; i < wordChars.length; i += maxChars) {
      lines.push(wordChars.slice(i, i + maxChars).join(''))
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
  const chars = Array.from(text)
  if (chars.length <= maxLen) {
    return text
  }

  if (maxLen <= 1) {
    return '…'
  }

  return `${chars.slice(0, maxLen - 1).join('')}…`
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

export function truncateToByteLimit(text: string, maxBytes: number = 1000): string {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(text)

  if (bytes.length <= maxBytes) {
    return text
  }

  const chars = Array.from(text)
  let safeLength = 0
  let safeString = ''

  for (const char of chars) {
    const charBytes = encoder.encode(char).length
    if (safeLength + charBytes > maxBytes - 3) {
      return safeString + '...'
    }
    safeLength += charBytes
    safeString += char
  }

  return safeString
}

export function paginateLines(
  lines: string[],
  pageIndex: number,
  linesPerPage: number = DISPLAY.LINES_PER_PAGE,
): { page: string[], totalPages: number } {
  if (lines.length === 0) {
    return { page: [], totalPages: 1 }
  }

  const totalPages = Math.max(1, Math.ceil(lines.length / linesPerPage))
  const safePageIndex = Math.max(0, Math.min(totalPages - 1, pageIndex))

  const start = safePageIndex * linesPerPage
  const page = lines.slice(start, start + linesPerPage)

  while (page.length < linesPerPage) {
    page.push('')
  }

  return { page, totalPages }
}

export function buildPageIndicator(
  pageIndex: number,
  totalPages: number,
  segments: number = 8,
): string {
  if (totalPages <= 1) {
    return ''
  }

  const safeSegments = Math.max(2, Math.floor(segments))
  const filled = Math.max(1, Math.min(safeSegments, Math.round(((pageIndex + 1) / totalPages) * safeSegments)))
  const empty = safeSegments - filled

  return `[${DISPLAY.SCROLL_INDICATOR_FILLED.repeat(filled)}${DISPLAY.SCROLL_INDICATOR_EMPTY.repeat(empty)}]`
}
