# EnrichedLab desktop

A thin Electron window around the web surface the person's engine serves. It finds or starts the engine (`el
serve`), trades the engine token for a one-time link, and opens it with the platform material behind the sidebar
(vibrancy on macOS, Mica on Windows 11). Sessions and tools are the same ones the terminal uses.

What the window adds: browser panes that are real Chromium views (with a browsing profile apart from the app, PDF
viewing, and the agent's browser actions in `main.mjs`), a native folder picker, and `enrichedlab://join` invite
links.

- `npm install && npm start` runs it against an installed `el`, or the engine already running.
- `npm run pack` builds an unsigned app into `dist/desktop/` with the binary from `dist/stage/<os>-<arch>/`.
- Releases are built by `scripts/release.ts`: a universal macOS app in a home-folder package, a per-user Windows
  setup, and Linux AppImages, none needing administrator rights.
- `EL_SHOT=/path/shot.png npm start` writes a screenshot of the window without taking focus and quits
  (`EL_SHOT_DELAY` in milliseconds waits longer first).
