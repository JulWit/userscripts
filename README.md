# Userscripts

A collection of my personal userscripts.

## Scripts

| Script | Description | Install |
|---|---|---|
| [Steam Deal Score](scripts/steam-dealscore.user.js) | Shows a deal score (1–100) based on reviews, discount, price and popularity on the Steam wishlist, cart and store pages. | [Install](https://raw.githubusercontent.com/JulWit/userscripts/main/scripts/steam-dealscore.user.js) |
| [Reading Ruler](scripts/reading-ruler.user.js) | Highlights one line of an article at a time: click or tap a line, then move with the arrow keys (or floating buttons on touch devices). Stays off on pages without article-like content and can be disabled per site from the script menu. | [Install](https://raw.githubusercontent.com/JulWit/userscripts/main/scripts/reading-ruler.user.js) |
| [Speed Reader](scripts/speed-reader.user.js) | Shows the main text of a page, or the selected text, word by word in an overlay on the page (RSVP), aligned at a highlighted fixation letter. Leaves out code, tables of data (such as infoboxes) and lists of references. Play, pause, skip back and forward (keys, buttons, or a tap near the edges of the word on touch screens), adjustable speed and font size; resumes a few words back after a pause, shows the current sentence while paused (click a word, or move to it with the arrow keys, to go there) and remembers the position in the last 50 pages read (stored locally by the script manager under a hash of the page's address, not in private windows; "Forget reading positions" in the script menu clears them). Started from the script menu. | [Install](https://raw.githubusercontent.com/JulWit/userscripts/main/scripts/speed-reader.user.js) |

## Installation

1. Install a userscript manager such as [Violentmonkey](https://violentmonkey.github.io/) or
   [Tampermonkey](https://www.tampermonkey.net/).
2. Click the **Install** link of a script above and confirm in the manager's dialog.

Installed scripts update automatically from this repository.

## Development

No build step. The Reading Ruler and the Speed Reader share their detection
of the main text of a page, `lib/content-detection.js`; they load it with
`@require`, so the script manager installs it along with them.

With [Node.js](https://nodejs.org/) 18+:

```bash
node --test
```

runs the unit tests in `tests/` (no dependencies), and

```bash
npx -p typescript tsc -p jsconfig.json
```

type-checks the scripts against their JSDoc annotations in strict mode
(editors such as VS Code and Zed do this automatically via `jsconfig.json`).

The end-to-end tests in `tests/e2e/` run the scripts in Firefox on the
pages in `tests/fixtures/` and need [Playwright](https://playwright.dev/).
The Steam fixtures are served by Playwright under
`https://store.steampowered.com`, together with made-up review data, so the
tests never contact Steam:

```bash
npm install
npx playwright install firefox
npm run test:e2e
```

The fixture pages also work in a normal browser when served over HTTP from
the repository root, for example without Node.js on Windows with

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File tests/serve.ps1
```

and then <http://localhost:8765/tests/fixtures/article.html>.
`tests/fixtures/harness.js` stands in for Violentmonkey; with `?touch` in
the URL the page reports a touch screen, so the Reading Ruler shows its
floating buttons. The Steam fixtures (`steam-*.html`) are meant for the
end-to-end tests: the script picks its page type by the Steam URL path and
loads review data from Steam, which only the tests provide.
On the Speed Reader fixtures (`speed-reader*.html`), the harness stands in
for the script menu too: run
`harnessRunMenuCommand('Speed Reader: Read this page')` in the browser
console.

Script icons live as SVG in `icons/` and are embedded in each script's
`@icon` as a base64 data URI. After editing an icon, regenerate the URI:

```bash
echo "data:image/svg+xml;base64,$(base64 -w0 icons/reading-ruler.svg)"
```

`tests/icons.test.js` fails if a script's `@icon` and its SVG differ.
