# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project

A collection of personal userscripts, located in `scripts/` as `*.user.js` files.
Code shared by several scripts lives in `lib/` (see "Shared libraries").

## Runtime environment

- The scripts run in **Firefox on Windows** (and possibly **Firefox on Android**).
- They are installed and executed via the **Violentmonkey** extension.
- Only use APIs available in that setup: the `GM_*` functions supported by
  Violentmonkey, declared via `@grant` in the metadata block, and web APIs
  supported by current Firefox (desktop and Android).
- Keep the metadata block (`// ==UserScript==`) complete and bump `@version`
  whenever a script changes, so Violentmonkey picks up the update via
  `@updateURL` / `@downloadURL`.

## Shared libraries

- A library in `lib/` defines one global (e.g. `ContentDetection` in
  `lib/content-detection.js`) and does nothing else. Scripts load it with
  `@require https://raw.githubusercontent.com/JulWit/userscripts/main/lib/<file>?v=<version>`;
  Violentmonkey runs it in the script's scope before the script.
- The `?v=` query makes Violentmonkey download a changed library: it keeps
  required files cached by URL. When a library changes, bump the
  `@version` in its file overview, the `?v=` of every script that requires
  it, and those scripts' `@version`. `tests/content-detection.test.js`
  checks that the versions match.
- The unit tests load a script together with its required files
  (`tests/load-script.js`), and the fixture pages load them with a
  `<script>` tag before the script.

## Tests and type checking

- Pure logic (parsing, scoring, formatting) is kept free of DOM, storage and
  network access, so it can be unit-tested. A script exposes it to the tests
  through a hook (see `dealScoreTestHook` in `steam-dealscore.user.js`) and
  stops before touching the page.
- Tests live in `tests/*.test.js` and use `node:test`; run them with
  `node --test`.
- Behavior on real pages is covered by end-to-end tests in `tests/e2e/`
  (Playwright, Firefox) on the fixture pages in `tests/fixtures/`; run them
  with `npm run test:e2e`. The Steam fixtures are served by Playwright at
  `https://store.steampowered.com`, which also answers the histogram
  requests, so the tests never reach the real site.
- Scripts are type-checked in strict mode from their JSDoc annotations
  (`tsc -p jsconfig.json`); GM_* declarations live in `types/`. Write
  function types TypeScript-style (`(x: number) => string`): current
  TypeScript no longer parses Closure's `function(number): string`. Keep
  both passing after every change.

## Git workflow

- Do **not** create new branches.
- Always commit directly to `main` and push to `origin main`.

## Language

- All code, comments, commit messages and documentation are written in
  **English**, even when the conversation with the agent is in German.

## Diagrams

- Create diagrams with [Mermaid.js](https://mermaid.js.org/) (e.g. as
  ` ```mermaid ` code blocks in Markdown files).

## Code style

- **JavaScript** follows the
  [Google JavaScript Style Guide](https://google.github.io/styleguide/jsguide.html).
- **HTML/CSS** (e.g. injected markup and styles) follows the
  [Google HTML/CSS Style Guide](https://google.github.io/styleguide/htmlcssguide.html).
