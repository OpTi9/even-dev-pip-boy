# Even G2 Development Environment

Development environment for building and testing Even G2 apps with the Even Hub Simulator.

## Apps

| App | Description |
|:---|:---|
| [codex](./apps/codex/) | Codex CLI running on G2 - full Claude Code access via glasses |
| [g2claude](./apps/g2claude/) | Alternative Claude integration for G2 glasses |

---

## Quick Start

### Codex App

```bash
npm run codex:up
```

This starts:
- Codex app-server (Rust)
- Vite dev server (port 5175)
- Even Hub Simulator

### G2Claude App

```bash
npm run g2:up
```

This starts:
- Telegram bot backend
- Vite dev server (port 5174)
- Even Hub Simulator

---

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm run codex:up` | Start Codex stack with QR |
| `npm run codex:up:noqr` | Start Codex stack without QR |
| `npm run codex:down` | Stop Codex stack |
| `npm run codex:restart` | Restart Codex stack |
| `npm run codex:status` | Check Codex stack status |
| `npm run codex:qr` | Generate QR code |
| `npm run g2:up` | Start G2Claude stack with QR |
| `npm run g2:up:noqr` | Start G2Claude stack without QR |
| `npm run g2:down` | Stop G2Claude stack |

---

## Project Structure

```
apps/
├── codex/           # Codex G2 app
├── g2claude/        # G2Claude app
└── _shared/         # Shared types

services/
└── claude-code-telegram/  # Telegram bot backend

start-codex-stack.sh  # Codex launcher
start-g2-stack.sh     # G2Claude launcher
vite.config.ts        # Vite configuration
```

---

## Requirements

- Node.js
- npm
- [Codex CLI](https://github.com/anthropics/claude-code) (for codex app)
- Even Hub Simulator

---

## Development Notes

See [dev-notes.md](./dev-notes.md) for detailed G2 development documentation.

---

## Disclaimer

This is a development environment for experimentation. APIs may change as the Even ecosystem evolves.
