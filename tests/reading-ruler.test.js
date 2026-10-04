/**
 * @fileoverview Unit tests for the pure functions of
 * scripts/reading-ruler.user.js. Run with `node --test` (Node.js 18+).
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {describe, it} = require('node:test');
const vm = require('node:vm');

/**
 * Runs the userscript with the test hook and returns its pure functions. The
 * script stops before touching the DOM or storage.
 * @return {!Object}
 */
function loadCore() {
  const file = path.join(__dirname, '..', 'scripts', 'reading-ruler.user.js');
  let core = null;
  globalThis.readingRulerTestHook = (api) => {
    core = api;
  };
  try {
    vm.runInThisContext(fs.readFileSync(file, 'utf8'), {filename: file});
  } finally {
    delete globalThis.readingRulerTestHook;
  }
  assert.ok(core, 'test hook was not called');
  return core;
}

const core = loadCore();

/**
 * @param {number} top
 * @param {number} bottom
 * @param {number} left
 * @param {number} right
 * @param {number=} source
 * @return {!Object} Rect with a source.
 */
function rect(top, bottom, left, right, source = 0) {
  return {top, bottom, left, right, source};
}

/**
 * Lines of 20 px text with 30 px line height, 600 px wide.
 * @param {number} count
 * @return {!Array<!Object>}
 */
function paragraphLines(count) {
  return Array.from({length: count},
      (unused, index) => rect(100 + index * 30, 120 + index * 30, 0, 600,
          index));
}

describe('groupRectsIntoLines', () => {
  it('merges the fragments of inline elements on one line', () => {
    // "Some <a>linked</a> and <em>emphasized</em> text" on one line.
    const lines = core.groupRectsIntoLines([
      rect(100, 120, 0, 80, 0),
      rect(100, 120, 80, 150, 1),
      rect(100, 120, 150, 190, 2),
      rect(101, 121, 190, 300, 3),
    ]);
    assert.deepEqual(lines, [rect(100, 121, 0, 300, 0)]);
  });

  it('separates consecutive lines', () => {
    const lines = core.groupRectsIntoLines([
      rect(100, 120, 0, 600, 0),
      rect(130, 150, 0, 600, 1),
      rect(160, 180, 0, 250, 2),
    ]);
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.map((line) => line.source), [0, 1, 2]);
  });

  it('keeps the first fragment in document order as source', () => {
    // A text node ends on line 1; the next one continues on lines 1 and 2.
    const lines = core.groupRectsIntoLines([
      rect(100, 120, 0, 300, 0),
      rect(100, 120, 300, 600, 1),
      rect(130, 150, 0, 400, 2),
    ]);
    assert.deepEqual(lines.map((line) => line.source), [0, 2]);
  });

  it('merges superscripts and smaller fonts into their line', () => {
    const lines = core.groupRectsIntoLines([
      rect(100, 120, 0, 200, 0),
      rect(96, 110, 200, 210, 1),
      rect(104, 118, 210, 400, 2),
    ]);
    assert.deepEqual(lines, [rect(96, 120, 0, 400, 0)]);
  });

  it('does not merge lines that overlap slightly (tight line height)', () => {
    const lines = core.groupRectsIntoLines([
      rect(100, 120, 0, 600, 0),
      rect(117, 137, 0, 600, 1),
    ]);
    assert.equal(lines.length, 2);
  });

  it('ignores empty rects', () => {
    const lines = core.groupRectsIntoLines([
      rect(100, 120, 0, 0, 0),
      rect(100, 100, 0, 50, 1),
      rect(130, 150, 0, 600, 2),
    ]);
    assert.deepEqual(lines, [rect(130, 150, 0, 600, 2)]);
  });

  it('ignores tall outliers such as drop caps', () => {
    const lines = core.groupRectsIntoLines([
      rect(100, 190, 0, 60, 0),
      rect(100, 120, 60, 600, 1),
      rect(130, 150, 60, 600, 2),
      rect(160, 180, 60, 600, 3),
    ]);
    assert.equal(lines.length, 3);
    assert.deepEqual(lines[0], rect(100, 120, 60, 600, 1));
  });

  it('returns lines sorted from top to bottom', () => {
    const lines = core.groupRectsIntoLines([
      rect(160, 180, 0, 100, 0),
      rect(100, 120, 0, 100, 1),
    ]);
    assert.deepEqual(lines.map((line) => line.top), [100, 160]);
  });

  it('returns no lines without rects', () => {
    assert.deepEqual(core.groupRectsIntoLines([]), []);
  });
});

describe('isSameVisualLine', () => {
  it('detects the same line', () => {
    assert.ok(core.isSameVisualLine(rect(100, 120, 0, 300),
        rect(101, 121, 200, 600)));
  });

  it('distinguishes lines side by side', () => {
    assert.ok(!core.isSameVisualLine(rect(100, 120, 0, 100),
        rect(100, 120, 120, 600)));
  });

  it('distinguishes lines below each other', () => {
    assert.ok(!core.isSameVisualLine(rect(100, 120, 0, 600),
        rect(130, 150, 0, 600)));
  });
});

describe('nearestLineIndex', () => {
  const lines = paragraphLines(3);

  it('finds the line containing y', () => {
    assert.equal(core.nearestLineIndex(lines, 135), 1);
  });

  it('falls back to the closest line', () => {
    assert.equal(core.nearestLineIndex(lines, 0), 0);
    assert.equal(core.nearestLineIndex(lines, 1000), 2);
    assert.equal(core.nearestLineIndex(lines, 124), 0);
    assert.equal(core.nearestLineIndex(lines, 127), 1);
  });

  it('returns -1 without lines', () => {
    assert.equal(core.nearestLineIndex([], 100), -1);
  });
});

describe('lineIndexAt', () => {
  const lines = paragraphLines(3);

  it('finds the clicked line', () => {
    assert.equal(core.lineIndexAt(lines, 110), 0);
    assert.equal(core.lineIndexAt(lines, 170), 2);
  });

  it('assigns the gap between lines to the closer line', () => {
    assert.equal(core.lineIndexAt(lines, 123), 0);
    assert.equal(core.lineIndexAt(lines, 127), 1);
  });

  it('accepts the highlight padding around the paragraph', () => {
    assert.equal(core.lineIndexAt(lines, 97), 0);
    assert.equal(core.lineIndexAt(lines, 183), 2);
  });

  it('rejects clicks clearly outside the lines', () => {
    assert.equal(core.lineIndexAt(lines, 80), -1);
    assert.equal(core.lineIndexAt(lines, 200), -1);
  });
});

describe('pickEntryLine', () => {
  const lines = paragraphLines(3);

  it('enters at the first line when moving down', () => {
    assert.equal(core.pickEntryLine(lines, rect(40, 60, 0, 600), 1), 0);
  });

  it('enters at the last line when moving up', () => {
    assert.equal(core.pickEntryLine(lines, rect(300, 320, 0, 600), -1), 2);
  });

  it('skips a line that coincides with the current one', () => {
    assert.equal(core.pickEntryLine(lines, rect(100, 120, 0, 300), 1), 1);
    assert.equal(core.pickEntryLine(lines, rect(160, 180, 0, 300), -1), 1);
  });

  it('returns -1 if there is no other line', () => {
    assert.equal(core.pickEntryLine([], null, 1), -1);
    assert.equal(
        core.pickEntryLine([lines[0]], rect(100, 120, 0, 600), 1), -1);
  });
});

describe('pickColumn and overlayBox', () => {
  it('picks the box at the height of the line', () => {
    const columns = [rect(100, 400, 0, 300), rect(100, 400, 340, 640)];
    const line = rect(130, 150, 340, 600);
    assert.equal(core.pickColumn(columns, line), columns[1]);
  });

  it('prefers a box at the line height over a closer one beside it', () => {
    const columns = [rect(0, 90, 0, 600), rect(100, 400, 700, 900)];
    assert.equal(core.pickColumn(columns, rect(130, 150, 0, 600)),
        columns[1]);
  });

  it('returns null without boxes', () => {
    assert.equal(core.pickColumn([], rect(0, 20, 0, 100)), null);
  });

  it('spans the column and pads the line', () => {
    const box = core.overlayBox(rect(100, 120, 20, 300),
        {left: 20, right: 620});
    const {x} = core.config.padding;
    assert.deepEqual(box, {
      top: 96,
      left: 20 - x,
      width: 600 + 2 * x,
      height: 28,
    });
  });

  it('limits the vertical padding', () => {
    const {yMin, yMax} = core.config.padding;
    assert.equal(core.overlayBox(rect(0, 5, 0, 10), null).top, -yMin);
    assert.equal(core.overlayBox(rect(0, 100, 0, 10), null).top, -yMax);
  });

  it('covers text that overflows the column', () => {
    const box = core.overlayBox(rect(0, 20, -10, 700), {left: 0, right: 600});
    assert.equal(box.left, -10 - core.config.padding.x);
    assert.equal(box.width, 710 + 2 * core.config.padding.x);
  });
});

describe('findFirst and firstNonSpace', () => {
  it('finds the first index of a monotonic predicate', () => {
    assert.equal(core.findFirst(0, 100, (index) => index >= 42), 42);
    assert.equal(core.findFirst(0, 100, () => true), 0);
    assert.equal(core.findFirst(0, 100, () => false), 100);
    assert.equal(core.findFirst(5, 5, () => true), 5);
  });

  it('skips white space', () => {
    assert.equal(core.firstNonSpace('  \n word', 0), 4);
    assert.equal(core.firstNonSpace('word', 2), 2);
  });

  it('stays inside the text', () => {
    assert.equal(core.firstNonSpace('word  ', 4), 4);
    assert.equal(core.firstNonSpace('word', 9), 3);
  });
});

describe('class and ID names', () => {
  it('splits names into words', () => {
    assert.deepEqual(core.nameTokens('main-nav sideBar').sort(),
        ['bar', 'main', 'nav', 'side', 'sidebar']);
  });

  const excluded = ['sidebar', 'left-sidebar', 'sideBar', 'main-menu',
    'navbar', 'subnav', 'comments', 'comment-list', 'site-footer', 'ad',
    'ad-slot', 'adContainer', 'promo-box', 'related-posts', 'share-buttons'];
  for (const name of excluded) {
    it(`excludes "${name}"`, () => {
      assert.ok(core.isExcludedName(name));
    });
  }

  const included = ['header', 'article-body', 'post', 'loaded', 'shadow',
    'canvas-wrapper', 'readability', 'threads', 'unavailable'];
  for (const name of included) {
    it(`keeps "${name}"`, () => {
      assert.ok(!core.isExcludedName(name));
    });
  }

  it('keeps content wrappers despite a negative word', () => {
    assert.ok(!core.isExcludedName('content-with-sidebar'));
    assert.ok(!core.isExcludedName('article share-enabled'));
  });

  it('weights positive and negative names', () => {
    assert.equal(core.classWeight('article-content'), 25);
    assert.equal(core.classWeight('comments'), -25);
    assert.equal(core.classWeight('wrapper'), 0);
    assert.equal(core.classWeight('post-comments'), 0);
  });
});

describe('container scoring', () => {
  it('counts commas in several scripts', () => {
    assert.equal(core.countCommas('a, b، c、d，e'), 4);
    assert.equal(core.countCommas('none'), 0);
  });

  it('scores paragraphs by length and commas', () => {
    assert.equal(core.paragraphScore({textLength: 10, commaCount: 3}), 0);
    assert.equal(core.paragraphScore({textLength: 150, commaCount: 2}), 4);
    assert.equal(core.paragraphScore({textLength: 900, commaCount: 0}), 4);
  });

  it('passes scores to ancestors with decreasing shares', () => {
    assert.deepEqual([0, 1, 2, 3].map(core.ancestorShare),
        [1, 0.5, 1 / 6, 1 / 9]);
  });

  /**
   * @param {number} count
   * @param {number=} depth
   * @return {!Array<!Object>} Paragraphs of 300 characters with 4 commas.
   */
  function paragraphs(count, depth = 0) {
    return Array.from({length: count},
        () => ({textLength: 300, commaCount: 4, depth}));
  }

  it('prefers many paragraphs with commas', () => {
    const article = core.scoreContainer({tagName: 'div', name: '',
      paragraphs: paragraphs(8), linkDensity: 0.05});
    const teaser = core.scoreContainer({tagName: 'div', name: '',
      paragraphs: paragraphs(2), linkDensity: 0.05});
    assert.ok(article > teaser);
  });

  it('penalizes link density', () => {
    const text = core.scoreContainer({tagName: 'div', name: '',
      paragraphs: paragraphs(5), linkDensity: 0.1});
    const links = core.scoreContainer({tagName: 'div', name: '',
      paragraphs: paragraphs(5), linkDensity: 0.8});
    assert.ok(text > links * 3);
    assert.equal(core.scoreContainer({tagName: 'div', name: '',
      paragraphs: paragraphs(5), linkDensity: 1}), 0);
  });

  it('applies the tag and class weights', () => {
    const base = {paragraphs: paragraphs(3), linkDensity: 0};
    const div = core.scoreContainer({...base, tagName: 'div', name: ''});
    const list = core.scoreContainer({...base, tagName: 'ul', name: ''});
    const content = core.scoreContainer(
        {...base, tagName: 'div', name: 'entry-content'});
    const comments = core.scoreContainer(
        {...base, tagName: 'div', name: 'comments'});
    assert.equal(div - list, 8);
    assert.equal(content - div, 25);
    assert.equal(div - comments, 25);
  });

  it('weights deeper paragraphs less', () => {
    const direct = core.scoreContainer({tagName: 'div', name: '',
      paragraphs: paragraphs(4, 0), linkDensity: 0});
    const nested = core.scoreContainer({tagName: 'div', name: '',
      paragraphs: paragraphs(4, 2), linkDensity: 0});
    assert.ok(direct > nested);
  });
});

describe('pickBestCandidate', () => {
  it('picks the highest score', () => {
    assert.equal(core.pickBestCandidate([
      {score: 10, parent: -1},
      {score: 40, parent: 0},
      {score: 5, parent: 0},
    ]), 1);
  });

  it('moves to a parent that scores almost as well', () => {
    assert.equal(core.pickBestCandidate([
      {score: 35, parent: -1},
      {score: 40, parent: 0},
    ]), 0);
  });

  it('moves to the parent of substantial sibling sections', () => {
    assert.equal(core.pickBestCandidate([
      {score: 20, parent: -1},
      {score: 40, parent: 0},
      {score: 15, parent: 0},
    ]), 0);
  });

  it('ignores small siblings', () => {
    assert.equal(core.pickBestCandidate([
      {score: 20, parent: -1},
      {score: 40, parent: 0},
      {score: 3, parent: 0},
    ]), 1);
  });

  it('returns -1 without positive scores', () => {
    assert.equal(core.pickBestCandidate([]), -1);
    assert.equal(core.pickBestCandidate([{score: -3, parent: -1}]), -1);
  });
});

describe('chooseSemanticRoot', () => {
  it('prefers an article that holds most of the text of main', () => {
    assert.equal(core.chooseSemanticRoot([
      {textLength: 5000, parent: -1},  // main
      {textLength: 4500, parent: 0},  // article
    ]), 1);
  });

  it('keeps main around several articles of similar size', () => {
    assert.equal(core.chooseSemanticRoot([
      {textLength: 6000, parent: -1},
      {textLength: 2000, parent: 0},
      {textLength: 2100, parent: 0},
      {textLength: 1900, parent: 0},
    ]), 0);
  });

  it('descends through several levels', () => {
    assert.equal(core.chooseSemanticRoot([
      {textLength: 5000, parent: -1},
      {textLength: 4800, parent: 0},
      {textLength: 4700, parent: 1},
    ]), 2);
  });

  it('ignores elements with little text', () => {
    assert.equal(core.chooseSemanticRoot([{textLength: 100, parent: -1}]), -1);
    assert.equal(core.chooseSemanticRoot([]), -1);
  });

  it('picks the larger of two unrelated articles', () => {
    assert.equal(core.chooseSemanticRoot([
      {textLength: 300, parent: -1},
      {textLength: 3000, parent: -1},
    ]), 1);
  });
});

describe('uncoveredBand', () => {
  const view = {top: 0, bottom: 800};
  const column = {left: 100, right: 700};

  it('excludes a fixed header and footer', () => {
    assert.deepEqual(core.uncoveredBand([
      rect(0, 60, 0, 1000),
      rect(740, 800, 0, 1000),
    ], view, column), {top: 60, bottom: 740});
  });

  it('stacks headers', () => {
    assert.deepEqual(core.uncoveredBand([
      rect(0, 50, 0, 1000),
      rect(50, 90, 0, 1000),
    ], view, column), {top: 90, bottom: 800});
  });

  it('ignores elements beside the column', () => {
    assert.deepEqual(core.uncoveredBand([rect(0, 300, 720, 1000)], view,
        column), view);
  });

  it('ignores elements that cover most of the view', () => {
    assert.deepEqual(core.uncoveredBand([rect(0, 700, 0, 1000)], view,
        column), view);
  });

  it('ignores elements away from the edges', () => {
    assert.deepEqual(core.uncoveredBand([rect(300, 360, 0, 1000)], view,
        column), view);
  });

  it('uses the whole view if too little remains', () => {
    assert.deepEqual(core.uncoveredBand([
      rect(0, 390, 0, 1000),
      rect(500, 800, 0, 1000),
    ], view, column), view);
  });
});

describe('computeScrollTarget', () => {
  const base = {
    lineTop: 600,
    lineBottom: 620,
    bandTop: 0,
    bandBottom: 800,
    scrollTop: 1000,
    maxScrollTop: 5000,
  };

  it('centers the line in the view', () => {
    // Line center 610 → 400.
    assert.equal(core.computeScrollTarget(base), 1210);
  });

  it('centers the line below a sticky header', () => {
    // Band 100–800, center 450.
    assert.equal(core.computeScrollTarget({...base, bandTop: 100}), 1160);
  });

  it('scrolls up for lines above the center', () => {
    assert.equal(core.computeScrollTarget(
        {...base, lineTop: 100, lineBottom: 120}), 710);
  });

  it('clamps at the start of the document', () => {
    assert.equal(core.computeScrollTarget(
        {...base, lineTop: 100, lineBottom: 120, scrollTop: 50}), 0);
  });

  it('clamps at the end of the document', () => {
    assert.equal(core.computeScrollTarget(
        {...base, lineTop: 700, lineBottom: 720, scrollTop: 4900}), 5000);
  });

  it('does not scroll pages that fit the view', () => {
    assert.equal(core.computeScrollTarget(
        {...base, scrollTop: 0, maxScrollTop: -10}), 0);
  });
});

describe('site list', () => {
  it('toggles a site', () => {
    assert.deepEqual(core.toggleSite(['a.com'], 'b.org'), ['a.com', 'b.org']);
    assert.deepEqual(core.toggleSite(['a.com', 'b.org'], 'a.com'), ['b.org']);
  });

  it('sanitizes stored values', () => {
    assert.deepEqual(core.sanitizeSites(['a.com', 3, null]), ['a.com']);
    assert.deepEqual(core.sanitizeSites('a.com'), []);
    assert.deepEqual(core.sanitizeSites(undefined), []);
  });
});
