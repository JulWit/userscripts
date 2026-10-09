/**
 * @fileoverview End-to-end tests of scripts/speed-reader.user.js in
 * Firefox, on the fixture pages in tests/fixtures/. Needs Playwright:
 * `npm install`, `npx playwright install firefox`, then `npm run test:e2e`.
 * Tests that involve playback never depend on how fast it runs: they wait
 * for progress, check that a paused reader stays where it is, or record
 * the shown words in the reader. The harness opens the reader's shadow
 * root, so Playwright's selectors reach into it; code that runs in the
 * page finds the elements with reader().
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
 * Runs a test on a fixture page and closes its context afterwards, also
 * when the test fails. The page gets a function reader(selector) that finds
 * an element in the reader's shadow root.
 * @param {string} name File name in tests/fixtures/.
 * @param {(page: !import('playwright').Page) => !Promise<void>} test
 * @param {!Object=} preset Stored values (GM_getValue) before the page loads.
 * @param {{incognito: (boolean|undefined)}=} options incognito makes
 *     GM_info report a private window.
 * @return {!Promise<void>}
 */
async function withPage(name, test, preset = {}, {incognito = false} = {}) {
  const context = await browser.newContext({
    viewport: {width: 1000, height: 700},
    reducedMotion: 'reduce',
  });
  try {
    await context.addInitScript(({values, incognito}) => {
      window.harnessPreset = values;
      window.harnessIncognito = incognito;
      window.reader = (selector) => document.querySelector('speed-reader')
          ?.shadowRoot?.querySelector(selector) ?? null;
    }, {values: preset, incognito});
    const page = await context.newPage();
    await page.goto(`${baseUrl}/tests/fixtures/${name}`);
    await test(page);
  } finally {
    await context.close();
  }
}

/**
 * Runs the menu command and waits for the reader.
 * @param {!import('playwright').Page} page
 * @return {!Promise<void>}
 */
async function openReader(page) {
  await page.evaluate((caption) => harnessRunMenuCommand(caption), MENU);
  await page.waitForSelector('.sr-position', {state: 'attached'});
}

/**
 * @param {!import('playwright').Page} page
 * @return {!Promise<boolean>} Whether the reader is in the page.
 */
function isOpen(page) {
  return page.evaluate(() => !!document.querySelector('speed-reader'));
}

/**
 * @param {!import('playwright').Page} page
 * @return {!Promise<{word: string, mark: ?string, index: number,
 *     total: number, playing: boolean, contextVisible: boolean,
 *     remaining: string, message: string}>} What the reader shows; index
 *     is 1-based, 0 without text.
 */
function readerState(page) {
  return page.evaluate(() => {
    const match = /Word (\d+) of (\d+)/.exec(
        reader('.sr-position').textContent);
    const context = reader('.sr-context');
    return {
      word: reader('.sr-word').textContent,
      mark: reader('.sr-mark')?.textContent ?? null,
      index: match ? Number(match[1]) : 0,
      total: match ? Number(match[2]) : 0,
      playing: reader('.sr-play').getAttribute('aria-label') === 'Pause',
      contextVisible: context.style.visibility !== 'hidden',
      remaining: reader('.sr-remaining').textContent,
      message: reader('.sr-message').style.display === 'none' ?
          '' :
          reader('.sr-message').textContent,
    };
  });
}

/**
 * Starts recording every shown word and position in the reader.
 * @param {!import('playwright').Page} page
 * @return {!Promise<void>}
 */
function startRecording(page) {
  return page.evaluate(() => {
    window.recorded = [];
    const word = reader('.sr-word');
    const position = reader('.sr-position');
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
 * @param {!import('playwright').Page} page
 * @return {!Promise<!Array<string>>}
 */
function collectWords(page) {
  return page.evaluate(() => {
    const words = [];
    const forward = reader('.sr-forward');
    const position = reader('.sr-position');
    for (let guard = 0; guard < 1000; guard++) {
      words.push(reader('.sr-mark').textContent);
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
      let popups = 0;
      page.on('popup', () => popups++);
      await openReader(page);
      const state = await readerState(page);
      assert.equal(state.word, 'Steam');
      assert.equal(state.index, 1);
      assert.equal(state.total, ARTICLE_TEXT.split(' ').length);
      assert.equal(state.playing, false);
      assert.equal(state.contextVisible, true);
      assert.equal(state.mark, 'Steam');
      assert.equal(await page.textContent('.sr-heading'),
          'Fixture: speed reader');
      // The fixation letter of "Steam" is its second letter.
      assert.equal(await page.textContent('.sr-pivot'), 't');
      // The reader is an overlay, not a window of its own.
      assert.equal(popups, 0);
      assert.equal(page.context().pages().length, 1);
    });
  });

  it('reads the article without navigation, sidebar, comments, hidden ' +
      'text, code and footnote markers', async () => {
    await withPage('speed-reader.html', async (page) => {
      await openReader(page);
      const words = await collectWords(page);
      assert.equal(words.join(' '), ARTICLE_TEXT);
    }, {settings: {skip: 1}});
  });

  it('shows long words in pieces', async () => {
    await withPage('speed-reader.html', async (page) => {
      await openReader(page);
      // Go to "The" before the long compound and play from there.
      await page.evaluate(() => {
        const forward = reader('.sr-forward');
        for (let index = 0; index < 31; index++) forward.click();
      });
      assert.equal((await readerState(page)).mark, 'The');
      await startRecording(page);
      await page.click('.sr-play');
      await page.waitForFunction(() => /Word 3[5-9] of/.test(
          reader('.sr-position').textContent));
      await page.click('.sr-play');
      const recorded = await page.evaluate(() => window.recorded);
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
      await openReader(page);
      const state = await readerState(page);
      assert.equal(state.word, 'Today,');
      assert.equal(state.total, 3);
    });
  });
});

describe('controls', () => {
  it('plays, pauses and skips with the buttons', async () => {
    await withPage('speed-reader.html', async (page) => {
      await openReader(page);
      await page.click('.sr-forward');
      assert.equal((await readerState(page)).index, 11);
      await page.click('.sr-back');
      assert.equal((await readerState(page)).index, 1);
      // Back stops at the start.
      await page.click('.sr-back');
      assert.equal((await readerState(page)).index, 1);

      await page.click('.sr-play');
      let state = await readerState(page);
      assert.equal(state.playing, true);
      assert.equal(state.contextVisible, false);
      await page.waitForFunction(() => /Word ([3-9]|\d\d+) of/.test(
          reader('.sr-position').textContent));

      // Skipping while playing continues at the new place.
      const before = (await readerState(page)).index;
      await page.click('.sr-forward');
      state = await readerState(page);
      assert.equal(state.playing, true);
      assert.ok(state.index >= before + 10, `${state.index} < ${before} + 10`);

      await page.click('.sr-play');
      state = await readerState(page);
      assert.equal(state.playing, false);
      assert.equal(state.contextVisible, true);
      await delay(400);
      assert.equal((await readerState(page)).index, state.index);

      // A click on the word toggles playback too.
      await page.click('.sr-stage');
      assert.equal((await readerState(page)).playing, true);
      await page.click('.sr-stage');
      assert.equal((await readerState(page)).playing, false);
    }, {settings: {wpm: 1000}});
  });

  it('stops at the end and starts over on Play', async () => {
    await withPage('speed-reader.html', async (page) => {
      await openReader(page);
      // Forward stops at the last word.
      for (let index = 0; index < 12; index++) {
        await page.click('.sr-forward');
      }
      let state = await readerState(page);
      assert.equal(state.index, state.total);
      await page.click('.sr-back');
      await startRecording(page);
      await page.click('.sr-play');
      await page.waitForFunction(() => reader('.sr-play')
          .getAttribute('aria-label') === 'Play');
      state = await readerState(page);
      assert.equal(state.index, state.total);
      assert.equal(state.remaining, '0:00 left');
      assert.equal(await page.evaluate(() =>
        reader('.sr-fill').style.width), '100%');

      await page.click('.sr-play');
      const recorded = await page.evaluate(() => window.recorded);
      assert.ok(recorded.at(-1).startsWith('Word 1 of'), recorded.at(-1));
      await page.click('.sr-play');
    }, {settings: {wpm: 1000}});
  });

  it('works with the keyboard without taking keys from controls',
      async () => {
        await withPage('speed-reader.html', async (page) => {
          await openReader(page);
          await page.keyboard.press('ArrowRight');
          assert.equal((await readerState(page)).index, 11);
          await page.keyboard.press('ArrowLeft');
          assert.equal((await readerState(page)).index, 1);
          await page.keyboard.press('ArrowUp');
          assert.equal(await page.inputValue('.sr-wpm'), '325');
          assert.equal((await storedSettings(page)).wpm, 325);
          await page.keyboard.press('ArrowDown');
          await page.keyboard.press('ArrowDown');
          assert.equal(await page.textContent('.sr-wpm-value'), '275 wpm');

          await page.keyboard.press('Space');
          assert.equal((await readerState(page)).playing, true);
          await page.keyboard.press('Space');
          assert.equal((await readerState(page)).playing, false);

          // A clicked button keeps no focus: Space still toggles playback.
          await page.click('.sr-forward');
          const index = (await readerState(page)).index;
          await page.keyboard.press('Space');
          assert.equal((await readerState(page)).playing, true);
          await page.keyboard.press('Space');
          assert.equal((await readerState(page)).playing, false);
          assert.ok((await readerState(page)).index >= index);

          // A focused slider keeps its arrow keys.
          const position = (await readerState(page)).index;
          await page.focus('.sr-fontSize');
          await page.keyboard.press('ArrowRight');
          assert.equal(await page.inputValue('.sr-fontSize'), '52');
          assert.equal((await readerState(page)).index, position);
          assert.equal((await storedSettings(page)).fontSize, 52);

          // A focused button keeps Space (and presses itself).
          await page.focus('.sr-back');
          await page.keyboard.press('Space');
          const state = await readerState(page);
          assert.equal(state.playing, false);
          assert.equal(state.index, Math.max(1, position - 10));

          // The number field keeps every key.
          await page.focus('.sr-skip');
          await page.keyboard.press('ArrowLeft');
          await page.keyboard.press('Space');
          assert.equal((await readerState(page)).playing, false);
        });
      });

  it('keeps its keys from the page', async () => {
    await withPage('speed-reader.html', async (page) => {
      await page.evaluate(() => {
        window.pageKeys = 0;
        document.addEventListener('keydown', () => window.pageKeys++);
        // Also listeners on the window in the capture phase, which run
        // before any listener in the reader.
        window.addEventListener('keydown', () => window.pageKeys++, true);
        window.addEventListener('keyup', () => window.pageKeys++, true);
      });
      await openReader(page);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('a');
      assert.equal((await readerState(page)).index, 11);
      assert.equal(await page.evaluate(() => window.pageKeys), 0);
      // Closed, the reader leaves the keys to the page again.
      await page.keyboard.press('Escape');
      await page.keyboard.press('a');
      assert.ok(await page.evaluate(() => window.pageKeys) > 0);
    });
  });

  it('keeps clicks and wheel events from the page', async () => {
    await withPage('speed-reader.html', async (page) => {
      await page.evaluate(() => {
        window.pageEvents = 0;
        for (const type of ['click', 'pointerdown', 'wheel']) {
          document.addEventListener(type, () => window.pageEvents++);
        }
      });
      await openReader(page);
      await page.click('.sr-forward');
      await page.mouse.move(500, 350);
      await page.mouse.wheel(0, 200);
      assert.equal(await page.evaluate(() => window.pageEvents), 0);
    });
  });

  it('resumes a few words back after a pause', async () => {
    await withPage('speed-reader.html', async (page) => {
      await openReader(page);
      await page.click('.sr-play');
      // Pause in the middle of the sentence of words 20 to 31 ("Ships …
      // banks.").
      await page.waitForFunction(() => /Word 2[4-7] of/.test(
          reader('.sr-position').textContent));
      await page.click('.sr-play');
      const paused = (await readerState(page)).index;
      assert.ok(paused >= 24 && paused <= 31, String(paused));
      await page.click('.sr-play');
      const resumed = (await readerState(page)).index;
      await page.click('.sr-play');
      assert.equal(resumed, Math.max(20, paused - 5));
    }, {settings: {wpm: 600}});
  });

  it('skips on a tap near the edges of the word', async () => {
    await withPage('speed-reader.html', async (page) => {
      await openReader(page);
      const tap = (share) => page.evaluate((share) => {
        const stage = reader('.sr-stage');
        const box = stage.getBoundingClientRect();
        stage.dispatchEvent(new PointerEvent('pointerdown',
            {bubbles: true, composed: true, pointerType: 'touch'}));
        stage.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          composed: true,
          clientX: box.left + box.width * share,
          clientY: box.top + box.height / 2,
        }));
      }, share);
      await tap(0.95);
      assert.equal((await readerState(page)).index, 4);
      await tap(0.05);
      assert.equal((await readerState(page)).index, 1);
      await tap(0.5);
      assert.equal((await readerState(page)).playing, true);
      await tap(0.5);
    }, {settings: {skip: 3}});
  });

  it('reaches the words of the sentence with the keyboard', async () => {
    await withPage('speed-reader.html', async (page) => {
      await openReader(page);
      const focused = () => page.evaluate(() => {
        const active = reader('.sr-panel').getRootNode().activeElement;
        return active ? `${active.className}: ${active.textContent}` : '';
      });
      // The sentence is one stop in the tab order, at the current word.
      for (let index = 0; index < 10; index++) {
        if ((await focused()).startsWith('sr-mark')) break;
        await page.keyboard.press('Tab');
      }
      assert.equal(await focused(), 'sr-mark: Steam');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      assert.equal(await focused(), 'sr-context-word: the');
      assert.equal((await readerState(page)).index, 1);
      await page.keyboard.press('Enter');
      assert.equal((await readerState(page)).index, 3);
      assert.equal(await focused(), 'sr-mark: the');
      await page.keyboard.press('End');
      await page.keyboard.press('Space');
      const state = await readerState(page);
      assert.equal(state.index, 4);
      assert.equal(state.playing, false);
    });
  });

  it('goes to a word clicked in the sentence', async () => {
    await withPage('speed-reader.html', async (page) => {
      await openReader(page);
      await page.click('.sr-forward');
      await page.click('.sr-context-word:text-is("first")');
      const state = await readerState(page);
      assert.equal(state.mark, 'first');
      assert.equal(state.word, 'first');
      assert.equal(state.playing, false);
    });
  });

  it('pauses when the page is hidden', async () => {
    await withPage('speed-reader.html', async (page) => {
      await openReader(page);
      await page.click('.sr-play');
      assert.equal((await readerState(page)).playing, true);
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState',
            {configurable: true, get: () => 'hidden'});
        document.dispatchEvent(new Event('visibilitychange'));
      });
      assert.equal((await readerState(page)).playing, false);
    });
  });
});

describe('settings', () => {
  it('apply at once and are stored', async () => {
    await withPage('speed-reader.html', async (page) => {
      await openReader(page);
      await page.fill('.sr-fontSize', '72');
      assert.equal(await page.evaluate(() =>
        reader('.sr-word').style.fontSize), '72px');
      assert.equal(await page.textContent('.sr-fontSize-value'), '72 px');
      const remaining = (await readerState(page)).remaining;
      await page.fill('.sr-wpm', '600');
      assert.notEqual((await readerState(page)).remaining, remaining);
      await page.fill('.sr-skip', '3');
      await page.click('.sr-forward');
      assert.equal((await readerState(page)).index, 4);
      assert.deepEqual(await storedSettings(page),
          {wpm: 600, fontSize: 72, skip: 3});

      await page.keyboard.press('Escape');
      await openReader(page);
      assert.equal(await page.inputValue('.sr-fontSize'), '72');
      assert.equal(await page.inputValue('.sr-wpm'), '600');
      assert.equal(await page.inputValue('.sr-skip'), '3');
    });
  });

  it('replaces invalid stored values', async () => {
    await withPage('speed-reader.html', async (page) => {
      await openReader(page);
      assert.equal(await page.inputValue('.sr-wpm'), '1000');
      assert.equal(await page.inputValue('.sr-fontSize'), '48');
      assert.equal(await page.inputValue('.sr-skip'), '10');
    }, {settings: {wpm: 99999, fontSize: 'huge', skip: null}});
  });

  it('stores a slider value when the slider is released', async () => {
    await withPage('speed-reader.html', async (page) => {
      await openReader(page);
      await page.evaluate(() => {
        const slider = reader('.sr-wpm');
        slider.value = '700';
        slider.dispatchEvent(new Event('input', {bubbles: true}));
      });
      assert.equal(await page.textContent('.sr-wpm-value'), '700 wpm');
      assert.equal(await storedSettings(page), undefined);
      await page.evaluate(() =>
        reader('.sr-wpm').dispatchEvent(new Event('change', {bubbles: true})));
      assert.equal((await storedSettings(page)).wpm, 700);
    });
  });

  it('follow changes made in another tab', async () => {
    await withPage('speed-reader.html', async (page) => {
      await openReader(page);
      await page.evaluate(() => harnessSetRemoteValue('settings',
          {wpm: 450, fontSize: 64, skip: 4}));
      assert.equal(await page.textContent('.sr-wpm-value'), '450 wpm');
      assert.equal(await page.evaluate(() =>
        reader('.sr-word').style.fontSize), '64px');
      await page.click('.sr-forward');
      assert.equal((await readerState(page)).index, 5);
    });
  });

  it('corrects an invalid skip value when the field is left', async () => {
    await withPage('speed-reader.html', async (page) => {
      await openReader(page);
      await page.fill('.sr-skip', '500');
      await page.focus('.sr-wpm');
      assert.equal(await page.inputValue('.sr-skip'), '50');
      assert.equal((await storedSettings(page)).skip, 50);
    });
  });
});

describe('overlay', () => {
  it('is reused by a second call', async () => {
    await withPage('speed-reader.html', async (page) => {
      await openReader(page);
      await page.click('.sr-forward');
      await page.evaluate((caption) => harnessRunMenuCommand(caption), MENU);
      // The same text keeps its place.
      assert.equal((await readerState(page)).index, 11);

      // A second call while it is open keeps the text: the page is inert,
      // so nothing new can be selected.
      await page.evaluate((caption) => harnessRunMenuCommand(caption), MENU);
      assert.equal((await readerState(page)).total,
          ARTICLE_TEXT.split(' ').length);

      // Closed while playing and opened with a selection, it reads that.
      await page.click('.sr-play');
      await page.keyboard.press('Escape');
      await page.evaluate(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('#title'));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      });
      await page.evaluate((caption) => harnessRunMenuCommand(caption), MENU);
      const state = await readerState(page);
      assert.equal(state.word, 'Steam');
      assert.equal(state.total, 4);
      assert.equal(state.playing, false);
      // No timer of the old text keeps running.
      await delay(400);
      assert.equal((await readerState(page)).index, 1);
      assert.equal(await page.locator('speed-reader').count(), 1);
    }, {settings: {wpm: 1000}});
  });

  it('closes with its button, Escape and a click beside the panel',
      async () => {
        await withPage('speed-reader.html', async (page) => {
          await openReader(page);
          await page.click('.sr-forward');
          await page.click('.sr-play');
          await page.click('.sr-close');
          assert.equal(await isOpen(page), false);

          // Opened again, the same text continues where it was, paused.
          await openReader(page);
          let state = await readerState(page);
          assert.ok(state.index >= 11, String(state.index));
          assert.equal(state.playing, false);
          await page.keyboard.press('Escape');
          assert.equal(await isOpen(page), false);

          await openReader(page);
          await page.mouse.click(10, 10);
          assert.equal(await isOpen(page), false);

          // Dragging a slider out of the panel does not close it.
          await openReader(page);
          const box = await page.locator('.sr-wpm').boundingBox();
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          await page.mouse.move(10, box.y + box.height / 2);
          await page.mouse.up();
          assert.equal(await isOpen(page), true);
          assert.equal(await page.inputValue('.sr-wpm'), '100');
        }, {settings: {wpm: 1000}});
      });

  it('keeps the page behind it inert and gives the focus back', async () => {
    await withPage('speed-reader.html', async (page) => {
      await page.focus('nav a');
      await openReader(page);
      const inside = () => page.evaluate(() =>
        document.activeElement === document.querySelector('speed-reader'));
      // A modal dialog makes the rest of the page inert.
      assert.equal(await page.evaluate(() => document
          .querySelector('speed-reader').parentElement.matches('dialog:modal')),
      true);
      assert.equal(await inside(), true);
      for (let index = 0; index < 12; index++) {
        await page.keyboard.press('Tab');
        assert.equal(await inside(), true);
      }
      await page.keyboard.press('Escape');
      assert.deepEqual(await page.evaluate(() => ({
        dialog: !!document.querySelector('dialog'),
        focus: document.activeElement.textContent,
      })), {dialog: false, focus: 'Home'});
    });
  });

  it('keeps the page from scrolling while it is open', async () => {
    await withPage('speed-reader.html', async (page) => {
      await page.evaluate(() =>
        document.documentElement.style.setProperty('overflow', 'scroll'));
      await openReader(page);
      const overflow = () => page.evaluate(() =>
        getComputedStyle(document.documentElement).overflowY);
      assert.equal(await overflow(), 'hidden');
      await page.mouse.move(500, 350);
      await page.mouse.wheel(0, 400);
      await delay(200);
      assert.equal(await page.evaluate(() => scrollY), 0);
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() =>
        document.documentElement.style.overflow), 'scroll');
    });
  });

  it('lies above a modal dialog of the page', async () => {
    await withPage('speed-reader.html', async (page) => {
      await page.evaluate(() => {
        const dialog = document.createElement('dialog');
        dialog.id = 'page-dialog';
        dialog.style.cssText = 'width: 90vw; height: 90vh;';
        document.body.append(dialog);
        dialog.showModal();
      });
      await openReader(page);
      await page.click('.sr-forward');
      assert.equal((await readerState(page)).index, 11);
      await page.keyboard.press('Escape');
      assert.equal(await isOpen(page), false);
      assert.equal(await page.evaluate(() =>
        document.querySelector('#page-dialog').open), true);
    });
  });

  it('cleans up when the page closes its dialog', async () => {
    await withPage('speed-reader.html', async (page) => {
      await openReader(page);
      await page.evaluate(() => {
        for (const dialog of document.querySelectorAll('dialog')) {
          dialog.close();
        }
      });
      await page.waitForFunction(() => !document.querySelector('speed-reader'));
      assert.equal(await page.evaluate(() =>
        document.documentElement.style.overflow), '');
    });
  });

  it('remembers the position in the text of a page', async () => {
    let positions = null;
    await withPage('speed-reader.html', async (page) => {
      await openReader(page);
      await page.click('.sr-forward');
      await page.click('.sr-forward');
      await page.keyboard.press('Escape');
      positions = await page.evaluate(() => GM_getValue('positions'));
    });
    assert.equal(positions.length, 1);
    assert.equal(positions[0].word, 20);
    await withPage('speed-reader.html', async (page) => {
      await openReader(page);
      assert.equal((await readerState(page)).index, 21);
      // The position is forgotten at the end of the text.
      for (let index = 0; index < 10; index++) {
        await page.click('.sr-forward');
      }
      await page.click('.sr-play');
      await page.waitForFunction(() =>
        reader('.sr-play').getAttribute('aria-label') === 'Play');
      assert.deepEqual(await page.evaluate(() => GM_getValue('positions')),
          []);
    }, {positions, settings: {wpm: 1000}});
  });

  it('does not remember a position in selected text', async () => {
    await withPage('speed-reader.html', async (page) => {
      await page.evaluate(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('#last'));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      });
      await openReader(page);
      await page.click('.sr-forward');
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => GM_getValue('positions')),
          undefined);
    });
  });

  it('neither stores nor uses positions in a private window', async () => {
    const url = `${baseUrl}/tests/fixtures/speed-reader.html`;
    const stored = [{url, hash: 'any', word: 30}];
    await withPage('speed-reader.html', async (page) => {
      await openReader(page);
      assert.equal((await readerState(page)).index, 1);
      await page.click('.sr-forward');
      await page.keyboard.press('Escape');
      assert.deepEqual(await page.evaluate(() => GM_getValue('positions')),
          stored);
    }, {positions: stored}, {incognito: true});
  });

  it('forgets the positions on request', async () => {
    await withPage('speed-reader.html', async (page) => {
      await openReader(page);
      await page.click('.sr-forward');
      await page.keyboard.press('Escape');
      assert.equal((await page.evaluate(() => GM_getValue('positions')))
          .length, 1);
      await page.evaluate(() =>
        harnessRunMenuCommand('Speed Reader: Forget reading positions'));
      assert.deepEqual(await page.evaluate(() => GM_getValue('positions')),
          []);
      // Read on, the position is stored again.
      await openReader(page);
      await page.click('.sr-forward');
      await page.keyboard.press('Escape');
      assert.equal((await page.evaluate(() => GM_getValue('positions')))
          .length, 1);
    });
  });

  it('hides the page\'s styles for the dialog backdrop', async () => {
    await withPage('speed-reader.html', async (page) => {
      await page.addStyleTag(
          {content: '::backdrop { background: rgb(255, 0, 0); }'});
      await openReader(page);
      assert.equal(await page.evaluate(() => getComputedStyle(
          document.querySelector('dialog'), '::backdrop').display), 'none');
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() =>
        document.adoptedStyleSheets.length), 0);
    });
  });

  it('keeps the page in place without its scroll bar', async () => {
    await withPage('speed-reader.html', async (page) => {
      await page.evaluate(() => {
        document.body.style.minHeight = '3000px';
      });
      const hasScrollBar = await page.evaluate(() =>
        window.innerWidth > document.documentElement.clientWidth);
      const left = () => page.evaluate(() =>
        document.querySelector('main').getBoundingClientRect().left);
      const before = await left();
      await openReader(page);
      assert.equal(await left(), before);
      assert.equal(await page.evaluate(() => document.documentElement.style
          .getPropertyValue('scrollbar-gutter')),
      hasScrollBar ? 'stable' : '');
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() =>
        document.documentElement.style.cssText), '');
    });
  });

  it('gives a page without a viewport one while it is open', async () => {
    await withPage('speed-reader.html', async (page) => {
      const viewport = () => page.evaluate(() =>
        document.querySelector('meta[name="viewport"]')?.content ?? null);
      assert.equal(await viewport(), null);
      await openReader(page);
      assert.equal(await viewport(),
          'width=device-width, initial-scale=1, minimum-scale=1');
      await page.click('.sr-close');
      assert.equal(await viewport(), null);
    });
  });

  it('follows the color scheme', async () => {
    await withPage('speed-reader.html', async (page) => {
      await openReader(page);
      const background = () => page.evaluate(() =>
        getComputedStyle(reader('.sr-panel')).backgroundColor);
      await page.emulateMedia({colorScheme: 'light'});
      assert.equal(await background(), 'rgb(247, 246, 242)');
      await page.emulateMedia({colorScheme: 'dark'});
      await page.waitForFunction(() =>
        getComputedStyle(reader('.sr-panel')).backgroundColor ===
            'rgb(22, 24, 27)');
    });
  });

  it('fills a phone-width window and fits long words into it at the ' +
      'largest size', async () => {
    await withPage('speed-reader.html', async (page) => {
      await page.setViewportSize({width: 360, height: 640});
      await openReader(page);
      await page.evaluate(() => {
        window.overflows = [];
        const word = reader('.sr-word');
        const stage = reader('.sr-stage');
        const check = () => {
          const box = word.getBoundingClientRect();
          const frame = stage.getBoundingClientRect();
          if (box.left < frame.left - 0.5 || box.right > frame.right + 0.5) {
            window.overflows.push(word.textContent);
          }
        };
        new MutationObserver(check).observe(word,
            {childList: true, subtree: true, attributes: true});
      });
      // Play through the paragraphs with long words.
      await page.evaluate(() => {
        const forward = reader('.sr-forward');
        for (let index = 0; index < 31; index++) forward.click();
      });
      await page.click('.sr-play');
      await page.waitForFunction(() => /Word 6[4-9] of/.test(
          reader('.sr-position').textContent));
      await page.click('.sr-play');
      assert.deepEqual(await page.evaluate(() => window.overflows), []);

      const layout = await page.evaluate(() => {
        const backdrop = reader('.sr-backdrop');
        const panel = reader('.sr-panel').getBoundingClientRect();
        return {
          scrollWidth: backdrop.scrollWidth,
          width: backdrop.clientWidth,
          panel: {width: panel.width, height: panel.height},
          buttons: [...backdrop.querySelectorAll('button, input')]
              .map((element) => {
                const box = element.getBoundingClientRect();
                return {
                  name: element.className,
                  height: box.height,
                  width: box.width,
                  right: box.right,
                };
              }),
        };
      });
      assert.ok(layout.scrollWidth <= layout.width,
          `${layout.scrollWidth} > ${layout.width}`);
      assert.equal(layout.panel.width, 360);
      assert.ok(layout.panel.height >= 640, String(layout.panel.height));
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
      await openReader(page);
      // The policy blocks style elements, also in the shadow root.
      const blocked = await page.evaluate(() => {
        const style = document.createElement('style');
        style.textContent = '.probe { color: rgb(1, 2, 3); }';
        const probe = document.createElement('span');
        probe.className = 'probe';
        const panel = reader('.sr-panel');
        panel.getRootNode().append(style);
        panel.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        style.remove();
        return color !== 'rgb(1, 2, 3)';
      });
      assert.ok(blocked, 'the policy does not apply in the shadow root');
      const looks = await page.evaluate(() => ({
        word: reader('.sr-word').textContent,
        fontSize: getComputedStyle(reader('.sr-word')).fontSize,
        pivot: getComputedStyle(reader('.sr-pivot')).color,
        play: reader('.sr-play').getBoundingClientRect().height,
        background: getComputedStyle(reader('.sr-panel')).backgroundColor,
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

describe('page without text', () => {
  it('explains how to read anyway', async () => {
    await withPage('speed-reader-empty.html', async (page) => {
      await openReader(page);
      const state = await readerState(page);
      assert.match(state.message, /No text found/);
      assert.equal(state.total, 0);
      assert.ok(await page.isDisabled('.sr-play'));
      await page.keyboard.press('Space');
      assert.equal((await readerState(page)).playing, false);
    });
  });
});
