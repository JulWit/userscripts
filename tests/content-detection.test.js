/**
 * @fileoverview Unit tests for the pure functions of
 * lib/content-detection.js, and for how the scripts require it. Run with
 * `node --test` (Node.js 18+).
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {describe, it} = require('node:test');
const {ROOT, loadLibrary, requiredFiles} = require('./load-script.js');

const core = loadLibrary('content-detection.js', 'ContentDetection');

describe('library version', () => {
  const library = fs.readFileSync(
      path.join(ROOT, 'lib', 'content-detection.js'), 'utf8');
  const version = /^ \* @version (\S+)$/m.exec(library)?.[1];

  for (const name of ['reading-ruler.user.js', 'speed-reader.user.js']) {
    it(`is the one ${name} requires`, () => {
      assert.ok(version, 'no @version in the library');
      const source = fs.readFileSync(path.join(ROOT, 'scripts', name), 'utf8');
      const required = requiredFiles(source).filter((entry) =>
        entry.file === path.join(ROOT, 'lib', 'content-detection.js'));
      assert.equal(required.length, 1);
      assert.equal(new URL(required[0].url).searchParams.get('v'), version);
    });
  }
});

describe('footnote markers', () => {
  it('recognizes markers', () => {
    for (const text of ['[1]', '12', '[a]', ' [note 3] ', 'b']) {
      assert.ok(core.isFootnoteText(text), text);
    }
  });

  it('rejects words and long numbers', () => {
    for (const text of ['see', '[sic]', '1234', '[Ed.]', '']) {
      assert.ok(!core.isFootnoteText(text), text);
    }
  });
});

describe('class and ID names', () => {
  it('splits names into words', () => {
    assert.deepEqual(core.nameTokens('main-nav sideBar').sort(),
        ['bar', 'main', 'nav', 'side', 'sidebar']);
  });

  const excluded = ['sidebar', 'left-sidebar', 'sideBar', 'main-menu',
    'navbar', 'subnav', 'comments', 'comment-list', 'site-footer', 'ad',
    'ad-slot', ' ad-slot ads', 'adContainer', 'promo-box', 'related-posts',
    'share-buttons'];
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
    assert.equal(core.classWeight('article-body'), 25);
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
    assert.equal(core.paragraphScore({textLength: 250, commaCount: 2}), 5);
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

  it('counts text containers as paragraphs only with line breaks', () => {
    const tags = core.textContainerTagsFor('skip');
    assert.ok(core.countsAsParagraph('p', false, tags));
    assert.ok(core.countsAsParagraph('li', false, tags));
    assert.ok(core.countsAsParagraph('div', true, tags));
    assert.ok(core.countsAsParagraph('td', true, tags));
    // Cells and divs of web apps (mail lists, dashboards) hold no prose.
    assert.ok(!core.countsAsParagraph('div', false, tags));
    assert.ok(!core.countsAsParagraph('td', false, tags));
    assert.ok(!core.countsAsParagraph('span', true, tags));
  });

  it('counts code blocks as paragraphs only if they are read', () => {
    assert.ok(core.countsAsParagraph('pre', false,
        core.textContainerTagsFor('text')));
    assert.ok(!core.countsAsParagraph('pre', false,
        core.textContainerTagsFor('skip')));
    assert.ok(!core.countsAsParagraph('pre', true,
        core.textContainerTagsFor('skip')));
  });

  it('requires a minimum of paragraph text', () => {
    const {minText} = core.config.scoring;
    assert.ok(core.hasEnoughText([{textLength: minText}]));
    assert.ok(core.hasEnoughText(
        [{textLength: minText / 2}, {textLength: minText / 2}]));
    assert.ok(!core.hasEnoughText([{textLength: minText - 1}]));
    assert.ok(!core.hasEnoughText([]));
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
