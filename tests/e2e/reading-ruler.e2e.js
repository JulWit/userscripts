/**
 * @fileoverview End-to-end tests of scripts/reading-ruler.user.js in
 * Firefox, on the fixture pages in tests/fixtures/. Needs Playwright:
 * `npm install`, `npx playwright install firefox`, then `npm run test:e2e`.
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {after, before, describe, it} = require('node:test');
const {firefox} = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const TYPES = {'.html': 'text/html', '.js': 'text/javascript'};

/** @type {?import('node:http').Server} */
let server = null;
let baseUrl = '';
/** @type {?import('playwright').Browser} */
let browser = null;

before(async () => {
  // A local server, so that the fixtures can load the script from scripts/.
  server = http.createServer((request, response) => {
    const file = path.join(ROOT, decodeURIComponent(
        new URL(request.url || '/', 'http://localhost').pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) ||
        !fs.statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = /** @type {import('node:net').AddressInfo} */ (
    server.address());
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await firefox.launch();
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server ? server.close(resolve) : resolve());
});

/**
 * Runs a test on a fixture page and closes the page afterwards, also when
 * the test fails. Scrolling is instant (reduced motion), so positions can be
 * checked right after a key press.
 * @param {string} name File name in tests/fixtures/.
 * @param {function(!import('playwright').Page): !Promise<void>} test
 * @return {!Promise<void>}
 */
async function withPage(name, test) {
  const page = await browser.newPage({
    viewport: {width: 800, height: 700},
    reducedMotion: 'reduce',
  });
  try {
    await page.goto(`${baseUrl}/tests/fixtures/${name}`);
    await test(page);
  } finally {
    await page.close();
  }
}

/**
 * @param {!import('playwright').Page} page
 * @return {!Promise<?{top: number, bottom: number, left: number,
 *     right: number}>} The highlight in document coordinates.
 */
function ruler(page) {
  return page.evaluate(() => rulerBox());
}

/**
 * Clicks a word, after scrolling it into view if needed. Fails if the click
 * would not reach the word, so that a test expecting no highlight cannot
 * pass because its click missed.
 * @param {!import('playwright').Page} page
 * @param {string} selector
 * @param {string} word
 * @return {!Promise<{top: number, bottom: number}>} The word's extent in
 *     document coordinates.
 */
async function clickWord(page, selector, word) {
  const point = await page.evaluate(([selector, word]) =>
    revealWord(selector, word), [selector, word]);
  assert.ok(point.hit, `"${word}" in ${selector} cannot be clicked`);
  await page.mouse.click(point.x, point.y);
  return point;
}

/**
 * Asserts that two highlight boxes are equal to the pixel.
 * @param {?Object<string, number>} actual
 * @param {?Object<string, number>} expected
 */
function assertSameBox(actual, expected) {
  assert.ok(actual && expected, 'highlight is hidden');
  for (const side of ['top', 'bottom', 'left', 'right']) {
    assert.ok(Math.abs(actual[side] - expected[side]) < 1,
        `${side}: ${actual[side]} != ${expected[side]}`);
  }
}

/**
 * @param {?{top: number, bottom: number}} box
 * @param {{top: number, bottom: number}} word
 * @return {boolean} Whether the highlight covers the word's line.
 */
function covers(box, word) {
  return !!box && box.top <= word.top && box.bottom >= word.bottom;
}

describe('article page', () => {
  it('highlights the clicked line', () => withPage('article.html',
      async (page) => {
        const word = await clickWord(page, '#indented', 'aliquip');
        assert.ok(covers(await ruler(page), word));
      }));

  it('moves down and back up to the same line', () => withPage(
      'article.html', async (page) => {
        // Every line of #indented starts after collapsed source indentation.
        for (const word of ['eiusmod', 'aliquip', 'pariatur']) {
          await clickWord(page, '#indented', word);
          const start = await ruler(page);
          await page.keyboard.press('ArrowDown');
          const below = await ruler(page);
          assert.ok(below.top > start.top);
          await page.keyboard.press('ArrowUp');
          assertSameBox(await ruler(page), start);
          await page.keyboard.press('Escape');
        }
      }));

  it('selects text in a div without paragraphs', () => withPage(
      'article.html', async (page) => {
        const word = await clickWord(page, '#plain', 'Bravo');
        assert.ok(covers(await ruler(page), word));
      }));

  it('selects a sticky heading', () => withPage('article.html',
      async (page) => {
        const word = await clickWord(page, '#sticky', 'sticky');
        assert.ok(covers(await ruler(page), word));
      }));

  it('treats the lines of an inline block as lines, not columns',
      () => withPage('article.html', async (page) => {
        const lines = await page.evaluate(() => {
          document.querySelector('#terms')
              .scrollIntoView({block: 'center', behavior: 'instant'});
          const range = document.createRange();
          range.selectNodeContents(document.querySelector('#definition'));
          const rects = [...range.getClientRects()].filter((r) => r.width);
          const last = rects[rects.length - 1];
          const column = document.querySelector('#terms')
              .getBoundingClientRect();
          return {
            last: {top: last.top + window.scrollY,
              bottom: last.bottom + window.scrollY},
            // Right of the short last line, inside the column.
            click: {x: (last.right + column.right) / 2,
              y: (last.top + last.bottom) / 2},
            columnLeft: column.left + window.scrollX,
            columnRight: column.right + window.scrollX,
          };
        });
        await page.mouse.click(lines.click.x, lines.click.y);
        const box = await ruler(page);
        assert.ok(covers(box, lines.last));
        // The highlight spans the column, not just the short line.
        assert.ok(box.left <= lines.columnLeft);
        assert.ok(box.right >= lines.columnRight);
      }));

  it('moves from the left to the right CSS column', () => withPage(
      'article.html', async (page) => {
        const lines = await page.evaluate(() => {
          const element = document.querySelector('#split');
          element.scrollIntoView({block: 'center', behavior: 'instant'});
          const range = document.createRange();
          range.selectNodeContents(element);
          const middle = element.getBoundingClientRect().left + 300;
          const rects =
              [...range.getClientRects()].filter((rect) => rect.width);
          const left = rects.filter((rect) => rect.left < middle);
          const right = rects.filter((rect) => rect.left >= middle);
          const lastLeft = left.reduce((a, b) => (b.top > a.top ? b : a));
          const firstRight =
              right.reduce((a, b) => (b.top < a.top ? b : a));
          return {
            middle,
            lastLeft: {x: lastLeft.left + 5,
              y: (lastLeft.top + lastLeft.bottom) / 2},
            firstRight: {top: firstRight.top + window.scrollY,
              bottom: firstRight.bottom + window.scrollY},
          };
        });
        await page.mouse.click(lines.lastLeft.x, lines.lastLeft.y);
        await page.keyboard.press('ArrowDown');
        const box = await ruler(page);
        assert.ok(box.left > lines.middle - 20);
        assert.ok(covers(box, lines.firstRight));
      }));

  it('ignores clicks dispatched by the page', () => withPage('article.html',
      async (page) => {
        await clickWord(page, '#indented', 'aliquip');
        const before = await ruler(page);
        await page.evaluate(() => {
          document.querySelector('#title').click();
          document.querySelector('#plain').dispatchEvent(new MouseEvent(
              'click', {bubbles: true, clientX: 5, clientY: 600}));
        });
        assertSameBox(await ruler(page), before);
      }));

  it('continues at a visible line after scrolling away', () => withPage(
      'article.html', async (page) => {
        await clickWord(page, '#indented', 'aliquip');
        await page.evaluate(() => window.scrollTo(0,
            wordPoint('#last', 'last').top - 300));
        const scrollY = await page.evaluate(() => window.scrollY);
        await page.keyboard.press('ArrowDown');
        const box = await ruler(page);
        const first = await page.evaluate(() => wordPoint('#last', 'last'));
        assert.ok(covers(box, first));
        assert.equal(await page.evaluate(() => window.scrollY), scrollY);
      }));

  it('skips text in a vertical writing mode', () => withPage('article.html',
      async (page) => {
        await clickWord(page, '#vertical', '縦');
        assert.equal(await ruler(page), null);
      }));

  it('hides the highlight when printing', () => withPage('article.html',
      async (page) => {
        await clickWord(page, '#indented', 'aliquip');
        await page.emulateMedia({media: 'print'});
        const display = await page.evaluate(() => getComputedStyle(
            document.querySelector('reading-ruler').shadowRoot
                .querySelector('.rr-ruler')).display);
        assert.equal(display, 'none');
      }));

  it('follows a site switch made in another tab', () => withPage(
      'article.html', async (page) => {
        await clickWord(page, '#indented', 'aliquip');
        await page.evaluate(() => harnessSetRemoteValue('disabledSites',
            [location.hostname]));
        assert.equal(await ruler(page), null);
        await clickWord(page, '#indented', 'aliquip');
        assert.equal(await ruler(page), null);
        await page.evaluate(() => harnessSetRemoteValue('disabledSites', []));
        await clickWord(page, '#indented', 'aliquip');
        assert.ok(await ruler(page));
      }));

  it('keeps the arrow keys from the page while a line is selected',
      () => withPage('article.html', async (page) => {
        await page.evaluate(() => {
          window.pageKeys = 0;
          document.addEventListener('keydown', () => window.pageKeys++);
        });
        await clickWord(page, '#indented', 'aliquip');
        await page.keyboard.press('ArrowDown');
        assert.equal(await page.evaluate(() => window.pageKeys), 0);
        // Without a selection, and for Escape, the page gets its keys.
        await page.keyboard.press('Escape');
        await page.keyboard.press('ArrowDown');
        assert.equal(await page.evaluate(() => window.pageKeys), 2);
      }));

  it('clears the selection with Escape', () => withPage('article.html',
      async (page) => {
        await clickWord(page, '#indented', 'aliquip');
        await page.keyboard.press('Escape');
        assert.equal(await ruler(page), null);
      }));
});

/**
 * Taps one of the ruler's touch controls.
 * @param {!import('playwright').Page} page
 * @param {string} label Accessible name of the button.
 */
async function tapControl(page, label) {
  const point = await page.evaluate((label) => {
    const button = document.querySelector('reading-ruler').shadowRoot
        .querySelector(`button[aria-label="${label}"]`);
    const rect = button.getBoundingClientRect();
    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  }, label);
  await page.mouse.click(point.x, point.y);
}

/**
 * @param {!import('playwright').Page} page
 * @return {!Promise<string>} Computed display of the touch controls.
 */
function controlsDisplay(page) {
  return page.evaluate(() => getComputedStyle(
      document.querySelector('reading-ruler').shadowRoot
          .querySelector('.rr-controls')).display);
}

describe('touch controls', () => {
  it('move the selection and close the ruler', () => withPage(
      'article.html?touch', async (page) => {
        await clickWord(page, '#indented', 'aliquip');
        const start = await ruler(page);
        assert.equal(await controlsDisplay(page), 'flex');
        await tapControl(page, 'Next line');
        const next = await ruler(page);
        assert.ok(Math.abs(next.top - start.top - 24) < 1,
            `${start.top} → ${next.top}`);
        await tapControl(page, 'Previous line');
        assertSameBox(await ruler(page), start);
        await tapControl(page, 'Stop reading ruler');
        assert.equal(await ruler(page), null);
        assert.equal(await controlsDisplay(page), 'none');
      }));

  it('are hidden for a fine pointer', () => withPage('article.html',
      async (page) => {
        await clickWord(page, '#indented', 'aliquip');
        assert.ok(await ruler(page));
        assert.equal(await controlsDisplay(page), 'none');
      }));
});

describe('page without an article', () => {
  it('leaves clicks on text alone', () => withPage('webapp.html',
      async (page) => {
        await clickWord(page, '#message', 'Meeting');
        await clickWord(page, '#status', 'messages');
        assert.equal(await ruler(page), null);
      }));

  it('leaves a web app with a main landmark alone', () => withPage(
      'inbox.html', async (page) => {
        await clickWord(page, '#subject', 'planning');
        assert.equal(await ruler(page), null);
      }));
});

/**
 * Moves the selection by real key presses and checks that every press moves
 * exactly one line.
 * @param {!import('playwright').Page} page
 * @param {string} key
 * @param {number} presses
 * @param {number} lineHeight
 */
async function assertLineByLine(page, key, presses, lineHeight) {
  const sign = key === 'ArrowDown' ? 1 : -1;
  let previous = await ruler(page);
  for (let step = 0; step < presses; step++) {
    await page.keyboard.press(key);
    const box = await ruler(page);
    assert.ok(Math.abs((box.top - previous.top) * sign - lineHeight) < 1,
        `${key} ${step}: ${previous.top} → ${box.top}`);
    previous = box;
  }
}

/**
 * Time the script takes per arrow key, measured inside the page, so that
 * the round trips of the test driver do not count. The key events are
 * dispatched by the page; the script does not require trusted key events.
 * @param {!import('playwright').Page} page
 * @param {number} presses
 * @return {!Promise<number>} Median in ms.
 */
function medianMoveTime(page, presses) {
  return page.evaluate((presses) => {
    const times = [];
    for (let step = 0; step < presses; step++) {
      const start = performance.now();
      document.body.dispatchEvent(new KeyboardEvent('keydown',
          {key: 'ArrowDown', bubbles: true, cancelable: true}));
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)];
  }, presses);
}

describe('long code block', () => {
  it('moves line by line across the measured windows', () => withPage(
      'code.html', async (page) => {
        await clickWord(page, '#code', 'value0');
        // 6 text nodes per line: 120 lines cross several windows of
        // CONFIG.maxSegmentTexts text nodes.
        await assertLineByLine(page, 'ArrowDown', 120, 24);
        await assertLineByLine(page, 'ArrowUp', 120, 24);
      }));

  it('moves quickly in a block with thousands of text nodes', () => withPage(
      'code.html', async (page) => {
        await clickWord(page, '#code', 'value0');
        // Measuring the whole block took about 100 ms per key.
        const median = await medianMoveTime(page, 40);
        assert.ok(median < 40, `median ${median} ms`);
      }));

  it('moves line by line and quickly in a single long text node',
      () => withPage('plain.html', async (page) => {
        await clickWord(page, '#code', 'value10 ');
        await assertLineByLine(page, 'ArrowDown', 20, 24);
        await assertLineByLine(page, 'ArrowUp', 20, 24);
        // Grouping thousands of rects took about 30 ms per key.
        const median = await medianMoveTime(page, 40);
        assert.ok(median < 25, `median ${median} ms`);
      }));
});

describe('strict style policy', () => {
  it('shows the highlight without its style sheet', () => withPage(
      'csp.html', async (page) => {
        const word = await clickWord(page, '#first', 'policy');
        assert.ok(covers(await ruler(page), word));
        const style = await page.evaluate(() => {
          const shadow = document.querySelector('reading-ruler').shadowRoot;
          const computed =
              getComputedStyle(shadow.querySelector('.rr-ruler'));
          return {position: computed.position,
            background: computed.backgroundColor};
        });
        assert.equal(style.position, 'absolute');
        assert.equal(style.background, 'rgba(255, 196, 0, 0.3)');
      }));
});

describe('nested scroll container', () => {
  it('keeps the line in view of the pane and the page', () => withPage(
      'scroller.html', async (page) => {
        // The word is in view: the pane keeps its starting position, with
        // only its top visible.
        await clickWord(page, '#first', 'first');
        for (let step = 0; step < 6; step++) {
          await page.keyboard.press('ArrowDown');
          const state = await page.evaluate(() => {
            const box = rulerBox();
            const pane =
                document.querySelector('.pane').getBoundingClientRect();
            return {
              top: box.top - window.scrollY,
              bottom: box.bottom - window.scrollY,
              paneTop: pane.top,
              paneBottom: pane.bottom,
              height: window.innerHeight,
            };
          });
          assert.ok(state.top >= state.paneTop - 8, `step ${step}`);
          assert.ok(state.bottom <= state.paneBottom + 8, `step ${step}`);
          assert.ok(state.top >= 0 && state.bottom <= state.height,
              `step ${step}`);
        }
      }));
});
