# Userscripts

A collection of my personal userscripts.

## Scripts

| Script | Description | Install |
|---|---|---|
| [Steam Deal Score](scripts/steam-dealscore.user.js) | Shows a deal score (1–100) based on reviews, discount, price and popularity on the Steam wishlist, cart and store pages. | [Install](https://raw.githubusercontent.com/JulWit/userscripts/main/scripts/steam-dealscore.user.js) |

## Installation

1. Install a userscript manager such as [Violentmonkey](https://violentmonkey.github.io/) or
   [Tampermonkey](https://www.tampermonkey.net/).
2. Click the **Install** link of a script above and confirm in the manager's dialog.

Installed scripts update automatically from this repository.

## Development

No build step and no dependencies. With [Node.js](https://nodejs.org/) 18+:

```bash
node --test
```

runs the unit tests in `tests/`, and

```bash
npx -p typescript tsc -p jsconfig.json
```

type-checks the scripts against their JSDoc annotations (editors such as
VS Code and Zed do this automatically via `jsconfig.json`).
