/**
 * @fileoverview End-to-end tests of scripts/steam-dealscore.user.js in
 * Firefox, on the Steam fixture pages in tests/fixtures/. Playwright serves
 * them at https://store.steampowered.com (the script picks its page adapter
 * by path) and answers the review histogram requests, so no request leaves
 * the machine. Needs Playwright: `npm install`,
 * `npx playwright install firefox`, then `npm run test:e2e`.
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {after, before, describe, it} = require('node:test');
const {firefox} = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const STEAM = 'https://store.steampowered.com';

/**
 * Review histograms by app ID: [upTotal, downTotal, up30, down30].
 * @type {!Object<string, !Array<number>>}
 */
const HISTOGRAMS = {
  100: [9000, 1000, 90, 10],
  200: [400, 600, 4, 6],
  400: [50, 50, 0, 0],
};

/**
 * @param {!Array<number>} counts See HISTOGRAMS.
 * @return {!Object} Response of /appreviewhistogram.
 */
function histogramJson([upTotal, downTotal, up30, down30]) {
  return {
    success: 1,
    results: {
      recent: [{recommendations_up: up30, recommendations_down: down30}],
      rollups: [
        {recommendations_up: upTotal, recommendations_down: downTotal},
      ],
    },
  };
}

/**
 * @param {string} pathname
 * @return {?string} Fixture file for a Steam page path.
 */
function fixtureFor(pathname) {
  if (pathname.startsWith('/wishlist/')) return 'steam-wishlist.html';
  if (pathname.startsWith('/cart')) return 'steam-cart.html';
  if (/^\/app\/\d+/.test(pathname)) return 'steam-store.html';
  return null;
}

/** @type {?import('playwright').Browser} */
let browser = null;

before(async () => {
  browser = await firefox.launch();
});

after(async () => {
  await browser?.close();
});

/**
 * @typedef {{
 *   preset: (!Object<string, *>|undefined),
 *   transform: ((function(string): string)|undefined),
 *   hang: (!Array<string>|undefined),
 *   clock: (boolean|undefined),
 * }} PageOptions
 * preset: GM values stored before the script starts. transform: rewrites the
 * fixture HTML. hang: app IDs whose histogram request never gets an answer.
 * clock: install Playwright's fake clock.
 */

/**
 * Runs a test on a Steam fixture page and closes the page afterwards, also
 * when the test fails.
 * @param {string} pagePath Path on store.steampowered.com.
 * @param {!PageOptions} options
 * @param {function(!import('playwright').Page, !Array<string>):
 *     !Promise<void>} test Gets the page and the app IDs whose histogram
 *     was requested so far.
 * @return {!Promise<void>}
 */
async function withSteamPage(pagePath, options, test) {
  const page = await browser.newPage({
    viewport: {width: 900, height: 700},
    reducedMotion: 'reduce',
  });
  /** @type {!Array<string>} */
  const requested = [];
  /** @type {!Array<!import('playwright').Route>} */
  const hanging = [];
  await page.route(`${STEAM}/**`, async (route) => {
    const {pathname} = new URL(route.request().url());
    const histogram = pathname.match(/^\/appreviewhistogram\/(\d+)/);
    if (histogram) {
      const appid = histogram[1];
      requested.push(appid);
      if (options.hang?.includes(appid)) {
        hanging.push(route);
        return;
      }
      const counts = HISTOGRAMS[appid];
      await route.fulfill({json: counts ? histogramJson(counts) : {}});
      return;
    }
    if (/^\/(?:scripts|tests)\//.test(pathname)) {
      await route.fulfill({
        path: path.join(ROOT, pathname),
        contentType: 'text/javascript',
      });
      return;
    }
    const fixture = fixtureFor(pathname);
    if (!fixture) {
      await route.fulfill({status: 404});
      return;
    }
    const html = fs.readFileSync(
        path.join(ROOT, 'tests', 'fixtures', fixture), 'utf8');
    await route.fulfill({
      body: options.transform ? options.transform(html) : html,
      contentType: 'text/html; charset=utf-8',
    });
  });
  if (options.preset) {
    await page.addInitScript((values) => {
      window.harnessPreset = values;
    }, options.preset);
  }
  if (options.clock) await page.clock.install();
  try {
    await page.goto(STEAM + pagePath);
    await test(page, requested);
  } finally {
    await Promise.all(hanging.map((route) => route.abort().catch(() => {})));
    await page.close();
  }
}

/**
 * @param {!import('playwright').Page} page
 * @param {string} key Badge key, e.g. "app/100".
 * @return {!import('playwright').Locator} The badge's pill.
 */
function pill(page, key) {
  return page.locator(`.sws-badge[data-key="${key}"] .sws-pill`);
}

/**
 * Waits until a badge shows a score.
 * @param {!import('playwright').Page} page
 * @param {string} key
 * @return {!Promise<number>} The score.
 */
async function scoreOf(page, key) {
  const locator = pill(page, key);
  await locator.filter({hasText: /^\d+$/}).waitFor();
  return Number(await locator.textContent());
}

/**
 * @param {!import('playwright').Page} page
 * @return {!import('playwright').Locator}
 */
function tooltip(page) {
  return page.locator('#sws-tooltip');
}

/**
 * Presses Tab until an element matching the predicate has focus.
 * @param {!import('playwright').Page} page
 * @param {function(!Element): boolean} predicate Runs in the page.
 * @return {!Promise<!Array<string>>} Outer HTML openings of the elements
 *     focused on the way, including the target.
 */
async function tabTo(page, predicate) {
  /** @type {!Array<string>} */
  const visited = [];
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    const [found, html] = await page.evaluate((source) => {
      const element = document.activeElement;
      const matches = new Function('element', `return (${source})(element);`);
      return [Boolean(element && matches(element)),
        element ? element.outerHTML.slice(0, 80) : ''];
    }, predicate.toString());
    visited.push(html);
    if (found) return visited;
  }
  throw new Error(`No matching element reached: ${visited.join(' | ')}`);
}

describe('wishlist', () => {
  it('scores priced rows and does not request data for unpriced ones', () =>
    withSteamPage('/wishlist/id/tester/', {}, async (page, requested) => {
      for (const key of ['app/100', 'app/200', 'app/400']) {
        const score = await scoreOf(page, key);
        assert.ok(score >= 1 && score <= 100, `${key}: ${score}`);
      }
      assert.equal(await pill(page, 'app/300').textContent(), '–');
      assert.deepEqual([...requested].sort(), ['100', '200', '400']);
    }));

  it('lists the best deals in the panel', () => withSteamPage(
      '/wishlist/id/tester/', {}, async (page) => {
        const scores = {};
        for (const [key, title] of [['app/100', 'Alpha Quest'],
          ['app/200', 'Beta Saga'], ['app/400', 'Delta Bargain']]) {
          scores[title] = await scoreOf(page, key);
        }
        const expected = Object.keys(scores)
            .sort((a, b) => scores[b] - scores[a] || a.localeCompare(b));
        const titles = page.locator('.sws-panel-title');
        await titles.nth(2).waitFor();
        assert.deepEqual(await titles.allTextContents(), expected);
      }));

  it('opens the tooltip while a title link has keyboard focus, without ' +
      'extra tab stops', () => withSteamPage(
      '/wishlist/id/tester/', {}, async (page) => {
        await scoreOf(page, 'app/100');
        assert.equal(await page.locator('.sws-badge[tabindex]').count(), 0);
        assert.equal(
            await page.locator('.sws-badge[role="img"]').count(), 4);

        const visited = await tabTo(page, (element) =>
          element.textContent === 'Alpha Quest');
        assert.ok(visited.every((html) => !html.includes('sws-badge')));
        await tooltip(page).waitFor();
        assert.match(await tooltip(page).textContent(), /Deal score \d+/);
        const link = page.locator('#wishlist a', {hasText: 'Alpha Quest'});
        assert.equal(
            await link.getAttribute('aria-describedby'), 'sws-tooltip');

        await page.keyboard.press('Tab');
        await tooltip(page).waitFor({state: 'hidden'});
        assert.equal(await link.getAttribute('aria-describedby'), null);
      }));

  it('detects the store currency from the prices', () => withSteamPage(
      '/wishlist/id/tester/', {
        transform: (html) =>
          html.replace(/(\d+),(\d\d)€/g, (match, whole, cents) =>
            `$${whole}.${cents}`),
      }, async (page) => {
        await scoreOf(page, 'app/100');
        assert.equal(
            await page.evaluate(() => GM_getValue('detectedCurrency')),
            'USD');
        await page.locator('.sws-badge[data-key="app/100"]').hover();
        await tooltip(page).waitFor();
        assert.match(await tooltip(page).textContent(), /\$9\.99/);
      }));

  it('takes over settings and panel preferences changed in another tab',
      () => withSteamPage('/wishlist/id/tester/', {}, async (page) => {
        await scoreOf(page, 'app/100');
        const body = page.locator('.sws-panel-body');
        await body.waitFor();

        await page.evaluate(() => harnessSetRemoteValue(
            'panel', {size: 10, collapsed: true}));
        await body.waitFor({state: 'hidden'});

        // Prices in EUR are not recognized as USD: no badge gets a score.
        await page.evaluate(() => harnessSetRemoteValue(
            'settings', {currency: 'USD'}));
        await pill(page, 'app/100').filter({hasText: '–'}).waitFor();
        assert.deepEqual(
            await page.locator('.sws-badge .sws-pill').allTextContents(),
            ['–', '–', '–', '–']);
        assert.equal(await page.locator('.sws-panel').isVisible(), false);
      }));

  it('replaces outdated and malformed cache entries', () => {
    const now = Date.now();
    const fresh = {upTotal: 50, downTotal: 50, up30: 0, down30: 0, t: now};
    return withSteamPage('/wishlist/id/tester/', {
      preset: {
        'hist:100': fresh,
        'hist:v1:200': {upTotal: 'many', t: now},
        'hist:v1:400': fresh,
      },
    }, async (page, requested) => {
      for (const key of ['app/100', 'app/200', 'app/400']) {
        await scoreOf(page, key);
      }
      assert.deepEqual([...requested].sort(), ['100', '200']);
      const keys = await page.evaluate(() => GM_listValues());
      assert.ok(!keys.includes('hist:100'), keys.join());
      assert.ok(keys.includes('hist:v1:100'), keys.join());
    });
  });

  it('gives up on a hanging request after the timeout', () => withSteamPage(
      '/wishlist/id/tester/', {hang: ['100'], clock: true},
      async (page, requested) => {
        await scoreOf(page, 'app/200');
        await scoreOf(page, 'app/400');
        assert.ok(requested.includes('100'));
        assert.equal(await pill(page, 'app/100').textContent(), '…');

        await page.clock.fastForward(16 * 1000);
        await scoreOf(page, 'app/100');
        await page.locator('.sws-badge[data-key="app/100"]').hover();
        await tooltip(page).waitFor();
        assert.match(await tooltip(page).textContent(),
            /review data unavailable/);
      }));
});

describe('cart', () => {
  it('scores games and bundles with the reviews of all included games',
      () => withSteamPage('/cart/', {}, async (page, requested) => {
        await scoreOf(page, 'app/100');
        await scoreOf(page, 'bundle/55');
        assert.deepEqual([...requested].sort(), ['100', '200', '400']);
        await page.locator('.sws-badge[data-key="bundle/55"]').hover();
        await tooltip(page).waitFor();
        assert.match(await tooltip(page).textContent(),
            /reviews of 2 included titles combined/);
      }));

  it('opens the tooltip while the head link has keyboard focus', () =>
    withSteamPage('/cart/', {}, async (page) => {
      await scoreOf(page, 'bundle/55');
      await tabTo(page, (element) =>
        (element.getAttribute('href') || '').includes('/bundle/55/'));
      await tooltip(page).waitFor();
      assert.match(await tooltip(page).textContent(), /Bundle/);
    }));
});

describe('store page', () => {
  it('scores the title and each edition, but not bundles', () =>
    withSteamPage('/app/100/Alpha_Quest/', {}, async (page) => {
      await scoreOf(page, 'app/100');
      await scoreOf(page, 'sub/1001');
      await scoreOf(page, 'sub/1002');
      assert.equal(await page.locator('.sws-badge').count(), 3);
    }));

  it('makes badges buttons that toggle the tooltip', () => withSteamPage(
      '/app/100/Alpha_Quest/', {}, async (page) => {
        await scoreOf(page, 'app/100');
        const badge = page.locator('.sws-badge[data-key="app/100"]');
        assert.equal(await badge.getAttribute('role'), 'button');

        await tabTo(page, (element) =>
          element.getAttribute('data-key') === 'app/100');
        await tooltip(page).waitFor();
        assert.equal(await badge.getAttribute('aria-expanded'), 'true');
        assert.equal(
            await badge.getAttribute('aria-describedby'), 'sws-tooltip');

        await page.keyboard.press('Enter');
        await tooltip(page).waitFor({state: 'hidden'});
        assert.equal(await badge.getAttribute('aria-expanded'), 'false');

        await page.keyboard.press(' ');
        await tooltip(page).waitFor();
        await page.keyboard.press('Escape');
        await tooltip(page).waitFor({state: 'hidden'});
      }));
});
