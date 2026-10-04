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
 * Opens a fixture page. Scrolling is instant (reduced motion), so positions
 * can be checked right after a key press.
 * @param {string} name File name in tests/fixtures/.
 * @return {!Promise<!import('playwright').Page>}
 */
async function open(name) {
  const page = await browser.newPage({
    viewport: {width: 800, height: 700},
    reducedMotion: 'reduce',
  });
  await page.goto(`${baseUrl}/tests/fixtures/${name}`);
  return page;
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
 * Clicks a word.
 * @param {!import('playwright').Page} page
 * @param {string} selector
 * @param {string} word
 * @return {!Promise<{top: number, bottom: number}>} The word's extent in
 *     document coordinates.
 */
async function clickWord(page, selector, word) {
  const point = await page.evaluate(([selector, word]) =>
    wordPoint(selector, word), [selector, word]);
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
  it('highlights the clicked line', async () => {
    const page = await open('article.html');
    const word = await clickWord(page, '#indented', 'aliquip');
    assert.ok(covers(await ruler(page), word));
    await page.close();
  });

  it('moves down and back up to the same line', async () => {
    const page = await open('article.html');
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
    await page.close();
  });

  it('selects text in a div without paragraphs', async () => {
    const page = await open('article.html');
    const word = await clickWord(page, '#plain', 'Bravo');
    assert.ok(covers(await ruler(page), word));
    await page.close();
  });

  it('selects a sticky heading', async () => {
    const page = await open('article.html');
    const word = await clickWord(page, '#sticky', 'sticky');
    assert.ok(covers(await ruler(page), word));
    await page.close();
  });

  it('treats the lines of an inline block as lines, not columns',
      async () => {
        const page = await open('article.html');
        const lines = await page.evaluate(() => {
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
        await page.close();
      });

  it('moves from the left to the right CSS column', async () => {
    const page = await open('article.html');
    const lines = await page.evaluate(() => {
      const element = document.querySelector('#split');
      const range = document.createRange();
      range.selectNodeContents(element);
      const middle = element.getBoundingClientRect().left + 300;
      const rects = [...range.getClientRects()].filter((rect) => rect.width);
      const left = rects.filter((rect) => rect.left < middle);
      const right = rects.filter((rect) => rect.left >= middle);
      const lastLeft = left.reduce((a, b) => (b.top > a.top ? b : a));
      const firstRight = right.reduce((a, b) => (b.top < a.top ? b : a));
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
    await page.close();
  });

  it('ignores clicks dispatched by the page', async () => {
    const page = await open('article.html');
    await clickWord(page, '#indented', 'aliquip');
    const before = await ruler(page);
    await page.evaluate(() => {
      document.querySelector('#title').click();
      document.querySelector('#plain').dispatchEvent(new MouseEvent('click',
          {bubbles: true, clientX: 5, clientY: 600}));
    });
    assertSameBox(await ruler(page), before);
    await page.close();
  });

  it('continues at a visible line after scrolling away', async () => {
    const page = await open('article.html');
    await clickWord(page, '#indented', 'aliquip');
    await page.evaluate(() => window.scrollTo(0,
        wordPoint('#last', 'last').top - 300));
    const scrollY = await page.evaluate(() => window.scrollY);
    await page.keyboard.press('ArrowDown');
    const box = await ruler(page);
    const first = await page.evaluate(() => wordPoint('#last', 'last'));
    assert.ok(covers(box, first));
    assert.equal(await page.evaluate(() => window.scrollY), scrollY);
    await page.close();
  });

  it('clears the selection with Escape', async () => {
    const page = await open('article.html');
    await clickWord(page, '#indented', 'aliquip');
    await page.keyboard.press('Escape');
    assert.equal(await ruler(page), null);
    await page.close();
  });
});

describe('page without an article', () => {
  it('leaves clicks on text alone', async () => {
    const page = await open('webapp.html');
    await clickWord(page, '#message', 'Meeting');
    await clickWord(page, '#status', 'messages');
    assert.equal(await ruler(page), null);
    await page.close();
  });

  it('leaves a web app with a main landmark alone', async () => {
    const page = await open('inbox.html');
    await clickWord(page, '#subject', 'planning');
    assert.equal(await ruler(page), null);
    await page.close();
  });
});

describe('nested scroll container', () => {
  it('keeps the line in view of the pane and the page', async () => {
    const page = await open('scroller.html');
    await clickWord(page, '#first', 'first');
    for (let step = 0; step < 6; step++) {
      await page.keyboard.press('ArrowDown');
      const state = await page.evaluate(() => {
        const box = rulerBox();
        const pane = document.querySelector('.pane').getBoundingClientRect();
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
    await page.close();
  });
});
