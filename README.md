# Flips 💸

A personal, mobile-first PWA for tracking resale flips — stuff you pick up at
garage sales, estate sales, and FB Marketplace, and sell for profit.

**Live app:** https://flipping-production.up.railway.app
(GitHub Pages mirror at https://builtbybean.github.io/Flipping/ runs in
local-only mode — no sync server there.)

## Features

- **Quick capture** — big + button, name, price, source, category, owner, optional photo. Built for one-handed use standing in someone's driveway.
- **Owners & leaderboard** — every flip belongs to a person; the dashboard ranks everyone by total flipped profit (🥇🥈🥉, best flip, items holding).
- **Inventory & Sold views** — search, sort, days-held badges, month-grouped sales history.
- **Mark sold in seconds** — live profit/ROI preview as you type the sale price.
- **Analytics dashboard** — total & monthly profit chart (tap the bars), ROI, avg days to sell, profit by source and category, best flips.
- **Offline-first PWA with sync** — installs to your home screen and works with zero signal; everything saves to IndexedDB first, then syncs to a Railway Postgres when online. Multiple devices share one dataset via a shared sync key (Settings → Sync & people).
- **Backups** — one-tap JSON backup/restore and CSV export for Excel/Sheets.

## Install on your phone

1. Open the live URL above in Safari (iPhone) or Chrome (Android).
2. iPhone: **Share → Add to Home Screen**. Android: **Install app** prompt or browser menu.
3. Launch from the home screen, then enter the sync key once in **Settings → Sync & people** and pick who the device belongs to.

## Architecture

- `index.html` + `app.js` — the whole client. Vanilla JS, hand-rolled SVG charts, IndexedDB (localStorage fallback), service worker for offline.
- `server.py` — small Flask app: serves the static client and `POST /api/sync`, a single-endpoint push+pull backed by Postgres (`items` table, JSONB). Conflicts resolve last-write-wins on the client `updatedAt`; the pull watermark uses server time so device clock skew can't hide rows. Deletes are tombstones so they propagate. Auth is a shared `X-Flips-Key` header checked against the `FLIPS_KEY` env var.
- Railway runs `gunicorn server:app` (see `railway.json` / `Procfile`) with `DATABASE_URL` referenced from the Postgres service. Deploys automatically on push to `main`.

## Dev

```
pip install -r requirements.txt
python server.py          # http://localhost:4180 (add ?sw=1 to test the service worker)
```

Create a `.env` in the repo root (gitignored) with `DATABASE_URL=` (the
Postgres public proxy URL from Railway) and `FLIPS_KEY=` to test sync
locally. Without a database the app still runs — it just stays local-only.

Icons are generated with `python tools/make_icons.py` (needs Pillow).
