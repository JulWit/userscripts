# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project

A collection of personal userscripts, located in `scripts/` as `*.user.js` files.

## Runtime environment

- The scripts run in **Firefox on Windows** (and possibly **Firefox on Android**).
- They are installed and executed via the **Violentmonkey** extension.
- Only use APIs available in that setup: the `GM_*` functions supported by
  Violentmonkey, declared via `@grant` in the metadata block, and web APIs
  supported by current Firefox (desktop and Android).
- Keep the metadata block (`// ==UserScript==`) complete and bump `@version`
  whenever a script changes, so Violentmonkey picks up the update via
  `@updateURL` / `@downloadURL`.

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
