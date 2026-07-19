# Flips 💸

A personal, mobile-first PWA for tracking resale flips — stuff you pick up at
garage sales, estate sales, and FB Marketplace, and sell for profit.

**Live app:** https://builtbybean.github.io/Flipping/

## Features

- **Quick capture** — big + button, name, price, source, category, optional photo. Built for one-handed use standing in someone's driveway.
- **Inventory & Sold views** — search, sort, days-held badges, month-grouped sales history.
- **Mark sold in seconds** — live profit/ROI preview as you type the sale price.
- **Analytics dashboard** — total & monthly profit chart (tap the bars), ROI, avg days to sell, profit by source and category, best flips leaderboard.
- **Offline-first PWA** — installs to your home screen, works with zero signal (estate-sale basements included). All data stays on your device (IndexedDB).
- **Backups** — one-tap JSON backup/restore and CSV export for Excel/Sheets.

## Install on your phone

1. Open the live URL above in Safari (iPhone) or Chrome (Android).
2. iPhone: **Share → Add to Home Screen**. Android: **Install app** prompt or browser menu.
3. Launch from the home screen — it runs full-screen like a native app.

## Dev

No build step, no dependencies. Serve the folder statically:

```
python -m http.server 4173
```

Then open `http://localhost:4173/?sw=1` (the `sw` flag opts into the service
worker locally; it's always on over HTTPS).

Icons are generated with `python tools/make_icons.py` (needs Pillow).

## Stack

Vanilla JS + hand-rolled SVG charts. IndexedDB (localStorage fallback) for
storage, service worker for offline, web manifest for install. That's it.
