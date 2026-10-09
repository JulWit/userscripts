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

  it('ends before a floating box beside the line', () => withPage(
      'float.html', async (page) => {
        const boxLeft = await page.evaluate(() =>
          document.querySelector('#box').getBoundingClientRect().left +
              scrollX);
        const columnRight = await page.evaluate(() =>
          document.querySelector('article').getBoundingClientRect().right +
              scrollX);
        const beside = await clickWord(page, '#beside', 'Alpha');
        let box = await ruler(page);
        assert.ok(covers(box, beside));
        assert.ok(box.right <= boxLeft + 0.5, `${box.right} > ${boxLeft}`);
        // Below the box, the highlight spans the column again.
        const below = await clickWord(page, '#below', 'Omega');
        box = await ruler(page);
        assert.ok(covers(box, below));
        assert.ok(box.right > columnRight, `${box.right} <= ${columnRight}`);
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

  it('probes few points for fixed headers and still finds them', () =>
    withPage('article.html', async (page) => {
      await clickWord(page, '#indented', 'aliquip');
      const cost = await moveCost(page, 6);
      // Probing every 16 px across 70 % of the view took about 100.
      assert.ok(cost.probes <= 30, `${cost.probes} probes per key`);
      // The line is centered below the fixed header (48 px), not in the
      // whole view.
      await page.keyboard.press('ArrowDown');
      const box = await ruler(page);
      const center = await page.evaluate((box) =>
        (box.top + box.bottom) / 2 - window.scrollY, box);
      const band = (48 + 700) / 2;
      assert.ok(Math.abs(center - band) < Math.abs(center - 700 / 2),
          `line center ${center}`);
    }));
});

describe('focus outside the selected text', () => {
  /**
   * Waits until an element has scrolled (keyboard scrolling may be smooth).
   * @param {!import('playwright').Page} page
   * @param {string} id
   * @return {!Promise<void>}
   */
  async function waitForScroll(page, id) {
    await page.waitForFunction(
        (id) => document.getElementById(id).scrollTop > 0, id,
        {timeout: 2000});
  }

  it('leaves the arrow keys and Escape to a modal dialog', () => withPage(
      'focus.html', async (page) => {
        await clickWord(page, '#intro', 'clauses');
        const start = await ruler(page);
        await page.evaluate(() => {
          document.getElementById('dialog').showModal();
          document.getElementById('options').focus();
        });
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        assertSameBox(await ruler(page), start);
        await waitForScroll(page, 'options');

        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() =>
          document.getElementById('dialog').open), false);
        assertSameBox(await ruler(page), start);
        // Back in the text, the arrow keys move the line again.
        await page.keyboard.press('ArrowDown');
        assert.ok((await ruler(page)).top > start.top);
      }));

  it('leaves the arrow keys to a focused scroll region', () => withPage(
      'focus.html', async (page) => {
        await clickWord(page, '#intro', 'clauses');
        const start = await ruler(page);
        await page.focus('#code');
        await page.keyboard.press('ArrowDown');
        assertSameBox(await ruler(page), start);
        await waitForScroll(page, 'code');
      }));

  it('moves through a focused scroll region that holds the line', () =>
    withPage('focus.html', async (page) => {
      // The click focuses the code block (it has a tabindex).
      await clickWord(page, '#code', 'line1');
      assert.equal(
          await page.evaluate(() => document.activeElement.id), 'code');
      const start = await ruler(page);
      await page.keyboard.press('ArrowDown');
      const next = await ruler(page);
      assert.ok(next && Math.abs(next.top - start.top - 24) < 1,
          `${start.top} → ${next && next.top}`);
    }));

  it('moves through a dialog that holds the text', () => withPage(
      'overlay.html', async (page) => {
        await clickWord(page, '#first', 'clauses');
        assert.equal(
            await page.evaluate(() => document.activeElement.id), 'overlay');
        const start = await ruler(page);
        await page.keyboard.press('ArrowDown');
        assert.ok((await ruler(page)).top > start.top);
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

describe('text between nested blocks', () => {
  it('selects text in a div with line breaks and a figure', () => withPage(
      'loose-text.html', async (page) => {
        const word = await clickWord(page, '#story', 'legend');
        assert.ok(covers(await ruler(page), word));
      }));

  it('moves past the figure to the text after it', () => withPage(
      'loose-text.html', async (page) => {
        await clickWord(page, '#story', 'legend');
        const target =
            await page.evaluate(() => wordPoint('#story', 'Toronto'));
        let reached = false;
        for (let step = 0; step < 10 && !reached; step++) {
          await page.keyboard.press('ArrowDown');
          reached = covers(await ruler(page), target);
        }
        assert.ok(reached);
      }));
});

describe('body that passes its overflow to the viewport', () => {
  it('scrolls the page to keep the line in view', () => withPage(
      'body-scroll.html', async (page) => {
        await clickWord(page, '#story', 'Paragraph');
        for (let step = 0; step < 30; step++) {
          await page.keyboard.press('ArrowDown');
          const state = await page.evaluate(() => {
            const box = rulerBox();
            return {
              top: box.top - window.scrollY,
              bottom: box.bottom - window.scrollY,
              height: window.innerHeight,
            };
          });
          assert.ok(state.top >= 0 && state.bottom <= state.height,
              `step ${step}: ${state.top}-${state.bottom}`);
        }
        assert.ok(await page.evaluate(() => window.scrollY) > 0);
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
 * Work the script does per arrow key, measured inside the page, so that the
 * round trips of the test driver do not count: the expensive layout calls
 * (text measurements, hit tests for fixed headers) and the time. The calls
 * do not depend on the machine; the time only serves as a generous safety
 * net. The key events are dispatched by the page; the script does not
 * require trusted key events.
 * @param {!import('playwright').Page} page
 * @param {number} presses
 * @return {!Promise<{rects: number, probes: number, ms: number}>} Medians
 *     per key: Range.getClientRects calls, elementFromPoint and
 *     elementsFromPoint calls, and milliseconds.
 */
function moveCost(page, presses) {
  return page.evaluate((presses) => {
    const counts = {rects: 0, probes: 0};
    /**
     * Counts the calls of a method until the returned function restores it.
     * @param {!Object} proto
     * @param {string} name
     * @param {string} counter
     * @return {function(): void}
     */
    const count = (proto, name, counter) => {
      const original = proto[name];
      proto[name] = function(...args) {
        counts[counter]++;
        return original.apply(this, args);
      };
      return () => {
        proto[name] = original;
      };
    };
    const restore = [
      count(Range.prototype, 'getClientRects', 'rects'),
      count(Document.prototype, 'elementFromPoint', 'probes'),
      count(Document.prototype, 'elementsFromPoint', 'probes'),
    ];
    const samples = [];
    try {
      for (let step = 0; step < presses; step++) {
        const before = {...counts};
        const start = performance.now();
        document.body.dispatchEvent(new KeyboardEvent('keydown',
            {key: 'ArrowDown', bubbles: true, cancelable: true}));
        samples.push({
          ms: performance.now() - start,
          rects: counts.rects - before.rects,
          probes: counts.probes - before.probes,
        });
      }
    } finally {
      restore.forEach((undo) => undo());
    }
    const median = (key) => samples.map((sample) => sample[key])
        .sort((a, b) => a - b)[Math.floor(samples.length / 2)];
    return {rects: median('rects'), probes: median('probes'), ms: median('ms')};
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
        // Measuring the whole block measured its 12000 text nodes per key
        // (about 100 ms); a window has at most 3 × CONFIG.maxSegmentTexts.
        const cost = await moveCost(page, 40);
        assert.ok(cost.rects < 1000, `${cost.rects} text measurements`);
        assert.ok(cost.ms < 200, `median ${cost.ms} ms`);
      }));

  it('moves line by line and quickly in a single long text node',
      () => withPage('plain.html', async (page) => {
        await clickWord(page, '#code', 'value10 ');
        await assertLineByLine(page, 'ArrowDown', 20, 24);
        await assertLineByLine(page, 'ArrowUp', 20, 24);
        // The node yields thousands of rects; grouping them in linear time
        // is covered by the unit tests (groupRectsIntoLines).
        const cost = await moveCost(page, 40);
        assert.ok(cost.rects < 100, `${cost.rects} text measurements`);
        assert.ok(cost.probes <= 30, `${cost.probes} probes`);
        assert.ok(cost.ms < 200, `median ${cost.ms} ms`);
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
