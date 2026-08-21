# Streaks — a five-habit tracker

A habit tracker for a phone. One HTML file, no build step, no framework, no
network calls. Everything you do stays in your browser's `localStorage`.

**Live:** `https://elboiler.github.io/Nun-thing-is-impossible/` *(once Pages is
switched on — see below)*

## The idea

Most trackers make you tick a box every day, so a busy day looks the same as a
failed one. This one inverts that:

> **Every day counts as done. You only tap when you *didn't* do it.**

So a perfect week costs zero taps. The circle on each habit is filled by
default; tapping it turns it into a dashed cross and breaks the streak. Tap it
again to undo. The squares under each habit are its recent history — tap any of
them (or any square in Insights) to correct a day you forgot to mark.

Five habits maximum, one decision per habit per day. That's the whole app.

## It doesn't scroll

The app is a fixed three-row shell — header, one content region, tab bar — so
the page itself never moves: no rubber-banding, no address bar sliding in and
out, no scroll position to lose. Everything is sized to the viewport instead.

Rather than pad that space out, each habit card spends it on history: the strip
under a habit grows to however many weeks fit, measured after layout. Five
habits on a small phone get one week each; two habits on a large one get seven.
Squares stay weekday-aligned in their columns either way, with today at the
bottom right.

The one place content can still exceed the viewport is Insights or Habits on a
landscape phone, where the content region — not the page — scrolls.

## Tabs

| Tab | What's in it |
| --- | --- |
| **Today** | Each habit with its current streak, a big tap-to-miss button, and its recent history. |
| **Insights** | Perfect-day streak, longest streak, days logged, misses this month; then per habit: current/best streak, misses, a 30-day rate bar, and a five-week calendar. |
| **Habits** | Add, rename, re-icon, recolour, delete. Export/import a JSON backup. Erase everything. |

## Files

```
index.html            the entire app — markup, styles, logic
sw.js                 service worker, so it opens offline
manifest.webmanifest  makes it installable to the home screen
icon.svg              app icon
apple-touch-icon.png  iOS home-screen icon (180px)
icon-512.png          Android maskable icon (512px)
.nojekyll             skip Jekyll processing on Pages
```

Dependencies: none. No fonts are fetched, no analytics, no CDN. The app works
opened straight from disk, though the service worker only registers over
`http(s)`.

## Deploying to GitHub Pages

**As its own site**, from this repo:

1. Merge to `main`.
2. Settings → Pages → Source: *Deploy from a branch* → `main` / `/ (root)`.
3. It appears at `https://elboiler.github.io/Nun-thing-is-impossible/`.

**As a sub-page of something else** (e.g. `…/grill-me/habits/`): every path in
the app is relative, so it works from any folder. Copy the files into a
subdirectory of whichever repo serves that site:

```bash
mkdir -p grill-me/habits
cp index.html sw.js manifest.webmanifest icon.svg apple-touch-icon.png icon-512.png grill-me/habits/
```

No paths need editing. The service worker's scope is the folder it sits in, so
several small apps can live side by side under one Pages site without
interfering with each other.

## On a phone

Open it in Safari or Chrome and use *Add to Home Screen*. It then launches
full-screen with its own icon and opens instantly with no signal.

## Your data

It lives in `localStorage` on that one browser, on that one device. It isn't
synced or backed up anywhere. Clearing site data — or, on iOS, not opening a
web app for a long stretch — can wipe it, so use **Habits → Export backup**
occasionally. The export is a small JSON file that **Import backup** restores.

Stored shape, if you ever want to edit it by hand:

```json
{ "v": 1,
  "habits": [
    { "id": "a1b2c3d", "name": "Read", "icon": "📚", "color": "#f59e0b",
      "start": "2026-08-01", "misses": ["2026-08-09", "2026-08-14"] }
  ] }
```

Only the misses are recorded — every other day since `start` is a kept day.
That is why the file stays tiny however long you use it.

## Changing it

Edit `index.html` and reload. If you change any file after the service worker
has cached it, bump `CACHE` in `sw.js` (`streaks-v1` → `streaks-v2`) so
installed copies pick up the new version.
