/**
 * @fileoverview End-to-end tests of scripts/speed-reader.user.js in
 * Firefox, on the fixture pages in tests/fixtures/. Needs Playwright:
 * `npm install`, `npx playwright install firefox`, then `npm run test:e2e`.
 * Tests that involve playback never depend on how fast it runs: they wait
 * for progress, check that a paused reader stays where it is, or record
 * the shown words in the reader window.
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
const MENU = 'Speed Reader: Read this page';

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
 * Runs a test on a fixture page and closes its context afterwards (with the
 * reader window), also when the test fails.
 * @param {string} name File name in tests/fixtures/.
 * @param {(page: !import('playwright').Page) => !Promise<void>} test
 * @param {!Object=} preset Stored values (GM_getValue) before the page loads.
 * @return {!Promise<void>}
 */
async function withPage(name, test, preset = {}) {
  const context = await browser.newContext({
    viewport: {width: 1000, height: 700},
    reducedMotion: 'reduce',
  });
  try {
    await context.addInitScript((values) => {
      window.harnessPreset = values;
    }, preset);
    const page = await context.newPage();
    await page.goto(`${baseUrl}/tests/fixtures/${name}`);
    await test(page);
  } finally {
    await context.close();
  }
}

/**
 * Runs the menu command and returns the reader window.
 * @param {!import('playwright').Page} page
 * @return {!Promise<!import('playwright').Page>}
 */
async function openReader(page) {
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.evaluate((caption) => harnessRunMenuCommand(caption), MENU),
  ]);
  await popup.waitForSelector('.sr-position', {state: 'attached'});
  return popup;
}

/**
 * @param {!import('playwright').Page} popup
 * @return {!Promise<{word: string, mark: ?string, index: number,
 *     total: number, playing: boolean, contextVisible: boolean,
 *     remaining: string, message: string}>} What the reader shows; index
 *     is 1-based, 0 without text.
 */
function readerState(popup) {
  return popup.evaluate(() => {
    const element = (selector) => document.querySelector(selector);
    const match = /Word (\d+) of (\d+)/.exec(
        element('.sr-position').textContent);
    const context = element('.sr-context');
    return {
      word: element('.sr-word').textContent,
      mark: element('.sr-mark')?.textContent ?? null,
      index: match ? Number(match[1]) : 0,
      total: match ? Number(match[2]) : 0,
      playing: element('.sr-play').getAttribute('aria-label') === 'Pause',
      contextVisible: context.style.visibility !== 'hidden',
      remaining: element('.sr-remaining').textContent,
      message: element('.sr-message').style.display === 'none' ?
          '' :
          element('.sr-message').textContent,
    };
  });
}

/**
 * Starts recording every shown word and position in the reader window.
 * @param {!import('playwright').Page} popup
 * @return {!Promise<void>}
 */
function startRecording(popup) {
  return popup.evaluate(() => {
    window.recorded = [];
    const word = document.querySelector('.sr-word');
    const position = document.querySelector('.sr-position');
    const record = () => {
      const entry = `${position.textContent}: ${word.textContent}`;
      if (window.recorded.at(-1) !== entry) window.recorded.push(entry);
    };
    record();
    new MutationObserver(record).observe(word,
        {childList: true, subtree: true, characterData: true});
    new MutationObserver(record).observe(position,
        {childList: true, subtree: true, characterData: true});
  });
}

/**
 * Collects all words of the text by stepping through it word by word with
 * the Forward button (needs a skip setting of 1). The marked word in the
 * sentence below shows each whole word, also when it is split into pieces.
 * @param {!import('playwright').Page} popup
 * @return {!Promise<!Array<string>>}
 */
function collectWords(popup) {
  return popup.evaluate(() => {
    const words = [];
    const forward = document.querySelector('.sr-forward');
    const position = document.querySelector('.sr-position');
    for (let guard = 0; guard < 1000; guard++) {
      words.push(document.querySelector('.sr-mark').textContent);
      const [, index, total] = /Word (\d+) of (\d+)/.exec(
          position.textContent);
      if (index === total) break;
      forward.click();
    }
    return words;
  });
}

/**
 * @param {!import('playwright').Page} page
 * @return {!Promise<*>} The stored settings.
 */
function storedSettings(page) {
  return page.evaluate(() => GM_getValue('settings'));
}

/**
 * @param {number} ms
 * @return {!Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ARTICLE_TEXT = [
  'Steam on the Danube',
  'The first steamboat reached Vienna in 1830, and travel on the river ' +
      'changed for good. Ships carried coal, grain, and passengers between ' +
      'the cities along its banks.',
  'The Donaudampfschifffahrtsgesellschaft became the largest inland ' +
      'shipping company of its time; its fleet grew every year. Zerowidth ' +
      'spaces must vanish too.',
  'Canals and routes',
  'Plans for the Rhein-Main-Donau-Kanal-Verbindung are described at ' +
      'https://example.com/history/canals/rhein-main-donau in great detail, ' +
      'with maps.',
  'Today, cruise ships follow the same route, and many travelers enjoy ' +
      'the slow pace of the journey through several countries.',
].join(' ');

describe('article page', () => {
  it('opens paused on the first word of the article', async () => {
    await withPage('speed-reader.html', async (page) => {
      const popup = await openReader(page);
      const state = await readerState(popup);
      assert.equal(state.word, 'Steam');
      assert.equal(state.index, 1);
      assert.equal(state.total, ARTICLE_TEXT.split(' ').length);
      assert.equal(state.playing, false);
      assert.equal(state.contextVisible, true);
      assert.equal(state.mark, 'Steam');
      assert.equal(await popup.title(),
          'Speed Reader – Fixture: speed reader');
      // The fixation letter of "Steam" is its second letter.
      assert.equal(await popup.textContent('.sr-pivot'), 't');
    });
  });

  it('reads the article without navigation, sidebar, comments, hidden ' +
      'text, code and footnote markers', async () => {
    await withPage('speed-reader.html', async (page) => {
      const popup = await openReader(page);
      const words = await collectWords(popup);
      assert.equal(words.join(' '), ARTICLE_TEXT);
    }, {settings: {skip: 1}});
  });

  it('shows long words in pieces', async () => {
    await withPage('speed-reader.html', async (page) => {
      const popup = await openReader(page);
      // Go to "The" before the long compound and play from there.
      await popup.evaluate(() => {
        const forward = document.querySelector('.sr-forward');
        for (let index = 0; index < 31; index++) forward.click();
      });
      assert.equal((await readerState(popup)).mark, 'The');
      await startRecording(popup);
      await popup.click('.sr-play');
      await popup.waitForFunction(() => /Word 3[5-9] of/.test(
          document.querySelector('.sr-position').textContent));
      await popup.click('.sr-play');
      const recorded = await popup.evaluate(() => window.recorded);
      const pieces = recorded.filter((entry) => entry.startsWith('Word 33 '))
          .map((entry) => entry.split(': ')[1]);
      assert.equal(pieces.length, 2);
      assert.ok(pieces[0].endsWith('-'));
      assert.equal(pieces.join('').replace('-', ''),
          'Donaudampfschifffahrtsgesellschaft');
    }, {settings: {wpm: 1000, skip: 1}});
  });

  it('reads the selection instead of the article', async () => {
    await withPage('speed-reader.html', async (page) => {
      await page.evaluate(() => {
        const text = document.querySelector('#last').firstChild;
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, text.data.indexOf(' follow'));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      });
      const popup = await openReader(page);
      const state = await readerState(popup);
      assert.equal(state.word, 'Today,');
      assert.equal(state.total, 3);
    });
  });
});

describe('controls', () => {
  it('plays, pauses and skips with the buttons', async () => {
    await withPage('speed-reader.html', async (page) => {
      const popup = await openReader(page);
      await popup.click('.sr-forward');
      assert.equal((await readerState(popup)).index, 11);
      await popup.click('.sr-back');
      assert.equal((await readerState(popup)).index, 1);
      // Back stops at the start.
      await popup.click('.sr-back');
      assert.equal((await readerState(popup)).index, 1);

      await popup.click('.sr-play');
      let state = await readerState(popup);
      assert.equal(state.playing, true);
      assert.equal(state.contextVisible, false);
      await popup.waitForFunction(() => /Word ([3-9]|\d\d+) of/.test(
          document.querySelector('.sr-position').textContent));

      // Skipping while playing continues at the new place.
      const before = (await readerState(popup)).index;
      await popup.click('.sr-forward');
      state = await readerState(popup);
      assert.equal(state.playing, true);
      assert.ok(state.index >= before + 10, `${state.index} < ${before} + 10`);

      await popup.click('.sr-play');
      state = await readerState(popup);
      assert.equal(state.playing, false);
      assert.equal(state.contextVisible, true);
      await delay(400);
      assert.equal((await readerState(popup)).index, state.index);

      // A click on the word toggles playback too.
      await popup.click('.sr-stage');
      assert.equal((await readerState(popup)).playing, true);
      await popup.click('.sr-stage');
      assert.equal((await readerState(popup)).playing, false);
    }, {settings: {wpm: 1000}});
  });

  it('stops at the end and starts over on Play', async () => {
    await withPage('speed-reader.html', async (page) => {
      const popup = await openReader(page);
      // Forward stops at the last word.
      for (let index = 0; index < 12; index++) {
        await popup.click('.sr-forward');
      }
      let state = await readerState(popup);
      assert.equal(state.index, state.total);
      await popup.click('.sr-back');
      await startRecording(popup);
      await popup.click('.sr-play');
      await popup.waitForFunction(() => document.querySelector('.sr-play')
          .getAttribute('aria-label') === 'Play');
      state = await readerState(popup);
      assert.equal(state.index, state.total);
      assert.equal(state.remaining, '0:00 left');
      assert.equal(await popup.evaluate(() =>
        document.querySelector('.sr-fill').style.width), '100%');

      await popup.click('.sr-play');
      const recorded = await popup.evaluate(() => window.recorded);
      assert.ok(recorded.at(-1).startsWith('Word 1 of'), recorded.at(-1));
      await popup.click('.sr-play');
    }, {settings: {wpm: 1000}});
  });

  it('works with the keyboard without taking keys from controls',
      async () => {
        await withPage('speed-reader.html', async (page) => {
          const popup = await openReader(page);
          await popup.keyboard.press('ArrowRight');
          assert.equal((await readerState(popup)).index, 11);
          await popup.keyboard.press('ArrowLeft');
          assert.equal((await readerState(popup)).index, 1);
          await popup.keyboard.press('ArrowUp');
          assert.equal(await popup.inputValue('.sr-wpm'), '325');
          assert.equal((await storedSettings(page)).wpm, 325);
          await popup.keyboard.press('ArrowDown');
          await popup.keyboard.press('ArrowDown');
          assert.equal(await popup.textContent('.sr-wpm-value'), '275 wpm');

          await popup.keyboard.press('Space');
          assert.equal((await readerState(popup)).playing, true);
          await popup.keyboard.press('Space');
          assert.equal((await readerState(popup)).playing, false);

          // A clicked button keeps no focus: Space still toggles playback.
          await popup.click('.sr-forward');
          const index = (await readerState(popup)).index;
          await popup.keyboard.press('Space');
          assert.equal((await readerState(popup)).playing, true);
          await popup.keyboard.press('Space');
          assert.equal((await readerState(popup)).playing, false);
          assert.ok((await readerState(popup)).index >= index);

          // A focused slider keeps its arrow keys.
          const position = (await readerState(popup)).index;
          await popup.focus('.sr-fontSize');
          await popup.keyboard.press('ArrowRight');
          assert.equal(await popup.inputValue('.sr-fontSize'), '52');
          assert.equal((await readerState(popup)).index, position);
          assert.equal((await storedSettings(page)).fontSize, 52);

          // A focused button keeps Space (and presses itself).
          await popup.focus('.sr-back');
          await popup.keyboard.press('Space');
          const state = await readerState(popup);
          assert.equal(state.playing, false);
          assert.equal(state.index, Math.max(1, position - 10));

          // The number field keeps every key.
          await popup.focus('.sr-skip');
          await popup.keyboard.press('ArrowLeft');
          await popup.keyboard.press('Space');
          assert.equal((await readerState(popup)).playing, false);
        });
      });

  it('pauses when the window is hidden', async () => {
    await withPage('speed-reader.html', async (page) => {
      const popup = await openReader(page);
      await popup.click('.sr-play');
      assert.equal((await readerState(popup)).playing, true);
      await popup.evaluate(() => {
        Object.defineProperty(document, 'visibilityState',
            {configurable: true, get: () => 'hidden'});
        document.dispatchEvent(new Event('visibilitychange'));
      });
      assert.equal((await readerState(popup)).playing, false);
    });
  });
});

describe('settings', () => {
  it('apply at once and are stored', async () => {
    await withPage('speed-reader.html', async (page) => {
      let popup = await openReader(page);
      await popup.fill('.sr-fontSize', '72');
      assert.equal(await popup.evaluate(() =>
        document.querySelector('.sr-word').style.fontSize), '72px');
      assert.equal(await popup.textContent('.sr-fontSize-value'), '72 px');
      const remaining = (await readerState(popup)).remaining;
      await popup.fill('.sr-wpm', '600');
      assert.notEqual((await readerState(popup)).remaining, remaining);
      await popup.fill('.sr-skip', '3');
      await popup.click('.sr-forward');
      assert.equal((await readerState(popup)).index, 4);
      assert.deepEqual(await storedSettings(page),
          {wpm: 600, fontSize: 72, skip: 3});

      await popup.close();
      popup = await openReader(page);
      assert.equal(await popup.inputValue('.sr-fontSize'), '72');
      assert.equal(await popup.inputValue('.sr-wpm'), '600');
      assert.equal(await popup.inputValue('.sr-skip'), '3');
    });
  });

  it('replaces invalid stored values', async () => {
    await withPage('speed-reader.html', async (page) => {
      const popup = await openReader(page);
      assert.equal(await popup.inputValue('.sr-wpm'), '1000');
      assert.equal(await popup.inputValue('.sr-fontSize'), '48');
      assert.equal(await popup.inputValue('.sr-skip'), '10');
    }, {settings: {wpm: 99999, fontSize: 'huge', skip: null}});
  });

  it('corrects an invalid skip value when the field is left', async () => {
    await withPage('speed-reader.html', async (page) => {
      const popup = await openReader(page);
      await popup.fill('.sr-skip', '500');
      await popup.focus('.sr-wpm');
      assert.equal(await popup.inputValue('.sr-skip'), '50');
      assert.equal((await storedSettings(page)).skip, 50);
    });
  });
});

describe('reader window', () => {
  it('is reused by a second call from the same tab', async () => {
    await withPage('speed-reader.html', async (page) => {
      const popup = await openReader(page);
      await popup.click('.sr-forward');
      let popups = 0;
      page.on('popup', () => popups++);
      await page.evaluate((caption) => harnessRunMenuCommand(caption), MENU);
      // The same text keeps its place.
      assert.equal((await readerState(popup)).index, 11);

      await popup.click('.sr-play');
      await page.evaluate(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('#title'));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      });
      await page.evaluate((caption) => harnessRunMenuCommand(caption), MENU);
      const state = await readerState(popup);
      assert.equal(state.word, 'Steam');
      assert.equal(state.total, 4);
      assert.equal(state.playing, false);
      // No timer of the old text keeps running.
      await delay(400);
      assert.equal((await readerState(popup)).index, 1);
      assert.equal(popups, 0);
      assert.equal(page.context().pages().length, 2);
    }, {settings: {wpm: 1000}});
  });

  it('opens again after it was closed', async () => {
    await withPage('speed-reader.html', async (page) => {
      const popup = await openReader(page);
      await popup.close();
      const second = await openReader(page);
      assert.equal((await readerState(second)).word, 'Steam');
    });
  });

  it('closes when the page is reloaded', async () => {
    await withPage('speed-reader.html', async (page) => {
      const popup = await openReader(page);
      await Promise.all([popup.waitForEvent('close'), page.reload()]);
      assert.ok(popup.isClosed());
    });
  });

  it('follows the color scheme', async () => {
    await withPage('speed-reader.html', async (page) => {
      const popup = await openReader(page);
      const background = () => popup.evaluate(() =>
        getComputedStyle(document.body).backgroundColor);
      await popup.emulateMedia({colorScheme: 'light'});
      assert.equal(await background(), 'rgb(247, 246, 242)');
      await popup.emulateMedia({colorScheme: 'dark'});
      await popup.waitForFunction(() =>
        getComputedStyle(document.body).backgroundColor ===
            'rgb(22, 24, 27)');
    });
  });

  it('fits long words into a phone-width window at the largest size',
      async () => {
        await withPage('speed-reader.html', async (page) => {
          const popup = await openReader(page);
          await popup.setViewportSize({width: 360, height: 640});
          await popup.waitForFunction(() => window.innerWidth === 360);
          await popup.evaluate(() => {
            window.overflows = [];
            const word = document.querySelector('.sr-word');
            const stage = document.querySelector('.sr-stage');
            const check = () => {
              const box = word.getBoundingClientRect();
              const frame = stage.getBoundingClientRect();
              if (box.left < frame.left - 0.5 ||
                  box.right > frame.right + 0.5) {
                window.overflows.push(word.textContent);
              }
            };
            new MutationObserver(check).observe(word,
                {childList: true, subtree: true, attributes: true});
          });
          // Play through the paragraphs with long words.
          await popup.evaluate(() => {
            const forward = document.querySelector('.sr-forward');
            for (let index = 0; index < 31; index++) forward.click();
          });
          await popup.click('.sr-play');
          await popup.waitForFunction(() => /Word 6[4-9] of/.test(
              document.querySelector('.sr-position').textContent));
          await popup.click('.sr-play');
          assert.deepEqual(await popup.evaluate(() => window.overflows), []);

          const layout = await popup.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            width: window.innerWidth,
            buttons: [...document.querySelectorAll('button, input')]
                .map((element) => {
                  const box = element.getBoundingClientRect();
                  return {
                    name: element.className,
                    height: box.height,
                    width: box.width,
                    right: box.right,
                  };
                }),
          }));
          assert.ok(layout.scrollWidth <= layout.width,
              `${layout.scrollWidth} > ${layout.width}`);
          for (const button of layout.buttons) {
            assert.ok(button.height >= 44, `${button.name}: ${button.height}`);
            assert.ok(button.width >= 44, `${button.name}: ${button.width}`);
            assert.ok(button.right <= layout.width, button.name);
          }
        }, {settings: {wpm: 1000, fontSize: 96, skip: 1}});
      });
});

describe('page with a strict style policy', () => {
  it('styles the reader inline', async () => {
    await withPage('speed-reader-csp.html', async (page) => {
      const popup = await openReader(page);
      // The policy applies in the reader window: style elements are blocked.
      const blocked = await popup.evaluate(() => {
        const style = document.createElement('style');
        style.textContent = '.probe { color: rgb(1, 2, 3); }';
        document.head.append(style);
        const probe = document.createElement('span');
        probe.className = 'probe';
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        style.remove();
        return color !== 'rgb(1, 2, 3)';
      });
      assert.ok(blocked, 'the policy does not apply in the reader window');
      const looks = await popup.evaluate(() => ({
        word: document.querySelector('.sr-word').textContent,
        fontSize: getComputedStyle(document.querySelector('.sr-word'))
            .fontSize,
        pivot: getComputedStyle(document.querySelector('.sr-pivot')).color,
        play: document.querySelector('.sr-play').getBoundingClientRect()
            .height,
        background: getComputedStyle(document.body).backgroundColor,
      }));
      assert.deepEqual(looks, {
        word: 'Strict',
        fontSize: '48px',
        pivot: 'rgb(210, 56, 31)',
        play: 48,
        background: 'rgb(247, 246, 242)',
      });
    });
  });
});

describe('blocked pop-up', () => {
  it('shows a notice whose button opens the reader', async () => {
    await withPage('speed-reader.html', async (page) => {
      await page.evaluate(() => {
        window.realOpen = window.open;
        window.open = () => null;
      });
      await page.evaluate((caption) => harnessRunMenuCommand(caption), MENU);
      const open = page.locator('speed-reader-notice .sr-open');
      await open.waitFor();
      await page.evaluate(() => {
        window.open = window.realOpen;
      });
      const [popup] = await Promise.all([
        page.waitForEvent('popup'),
        open.click(),
      ]);
      await popup.waitForSelector('.sr-position', {state: 'attached'});
      assert.equal((await readerState(popup)).word, 'Steam');
      assert.equal(await page.locator('speed-reader-notice').count(), 0);
    });
  });

  it('closes the notice', async () => {
    await withPage('speed-reader.html', async (page) => {
      await page.evaluate(() => {
        window.realOpen = window.open;
        window.open = () => null;
      });
      await page.evaluate((caption) => harnessRunMenuCommand(caption), MENU);
      await page.locator('speed-reader-notice [aria-label="Close"]').click();
      assert.equal(await page.locator('speed-reader-notice').count(), 0);
    });
  });
});

describe('page without text', () => {
  it('explains how to read anyway', async () => {
    await withPage('speed-reader-empty.html', async (page) => {
      const popup = await openReader(page);
      const state = await readerState(popup);
      assert.match(state.message, /No text found/);
      assert.equal(state.total, 0);
      assert.ok(await popup.isDisabled('.sr-play'));
      await popup.keyboard.press('Space');
      assert.equal((await readerState(popup)).playing, false);
    });
  });
});
