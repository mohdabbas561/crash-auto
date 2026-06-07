# Crash Bot Pro

On-chain crash game tracker with live stats, pattern analysis, and auto-betting.

## Features

- **Prediction Engine** — Gap analysis, cluster detection, streak patterns, cycle detection
- **Gap Tracker** — Rounds since each multiplier threshold was last hit
- **Global Stats** — Tracked rounds, average multiplier, highest crash
- **Recent Crashes** — Last 30 results with color-coded display
- **Distribution Chart** — Multiplier frequency breakdown
- **Auto Bot** — Automated betting with configurable strategy and stop-loss
- **Live Polling** — Auto-fetches latest rounds every 15 seconds

## Setup

```bash
npm install
npm start
```

## Environment Variables

Configure via your deployment platform's environment settings:

| Variable | Description |
|---|---|
| `REACT_APP_API_URL` | Backend API URL |
| `REACT_APP_RPC_URL` | Solana RPC endpoint |
| `REACT_APP_PRIVATE_KEY` | Wallet private key (optional, can be entered in UI) |
| `REACT_APP_PLAYER_PDA` | Player account address (optional, can be entered in UI) |