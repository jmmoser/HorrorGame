---
name: verify
description: Build, run, and drive The Descent Ledger to verify changes at its real surface (browser, mobile-first touch controls).
---

# Verifying The Descent Ledger

Vite + three.js web game, no test suite. Verify by driving the running game.

## Build / run

- `npm run build` — tsc --noEmit + vite build (needs `npm install` first).
- Dev server: `npm run dev -- --port <p> --strictPort`. Served at `http://localhost:<p>/HorrorGame/` (note the base path).
- DEV mode exposes `window.__game` with debug hooks (`src/game.ts` `get debug`): `state`, `player` (pos/yaw/controls), `teleport`, `logAllTargets`, `depart`. Production builds do not.

## Driving it headless

Playwright is in devDependencies; launch with `executablePath: '/opt/pw-browsers/chromium'` if the default browser download is missing. Emulate mobile with `devices['iPhone 13']` (`pointer: coarse` match makes the game bind touch controls).

Flow to reach gameplay: tap `#gate-continue` → tap `#btn-begin` → `waitForFunction(() => window.__game?.debug.state === 'play')` (arrival fade ~1.6s).

- Joystick / look drags: use a CDP session, `Input.dispatchTouchEvent` (`touchStart` with `{x,y,id}`, `touchMove`, then `touchEnd` with `touchPoints: []` to release). Left 45% of screen = move stick, right 55% = look/tap-inspect.
- Desktop: WASD via keyboard, pointer lock via canvas click.

## Gotchas

- Headless software GL is extremely janky (ReadPixels stalls): a scripted 16ms tap arrives at the page as ~1000ms between touchstart/touchend, so the tap-to-inspect gate (`dt < 300ms` in `src/player/controls.ts`) fails for environment reasons, not product ones. To verify tap-to-inspect, dispatch synthetic `TouchEvent`s synchronously in-page instead.
- Saves persist in localStorage; use a fresh browser context per run to avoid resume-state surprises.
