/**
 * @fileoverview Unit tests for the pure functions of
 * scripts/speed-reader.user.js. Run with `node --test` (Node.js 18+).
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
  const file = path.join(__dirname, '..', 'scripts', 'speed-reader.user.js');
  let core = null;
  globalThis.speedReaderTestHook = (api) => {
    core = api;
  };
  try {
    vm.runInThisContext(fs.readFileSync(file, 'utf8'), {filename: file});
  } finally {
    delete globalThis.speedReaderTestHook;
  }
  assert.ok(core, 'test hook was not called');
  return core;
}

const core = loadCore();

/**
 * @param {...string} texts Paragraph texts; a leading "# " marks a heading.
 * @return {!Array<{text: string, heading: boolean}>}
 */
function paragraphs(...texts) {
  return texts.map((text) => text.startsWith('# ') ?
      {text: text.slice(2), heading: true} :
      {text, heading: false});
}

describe('cleanText', () => {
  it('removes soft hyphens and zero-width characters', () => {
    assert.equal(core.cleanText('Schiff­fahrt zero​width ' +
        '﻿word⁠joiner'), 'Schifffahrt zerowidth wordjoiner');
  });

  it('keeps zero-width joiners of emoji', () => {
    assert.equal(core.cleanText('👩‍💻 codes'), '👩‍💻 codes');
  });

  it('removes footnote markers', () => {
    assert.equal(core.cleanText('Fact[1] and claim [2–4]. Note[a] ' +
        'end[note 3].'), 'Fact and claim. Note end.');
  });

  it('keeps bracketed words', () => {
    assert.equal(core.cleanText('A [sic] quote [Ed.]'), 'A [sic] quote [Ed.]');
  });

  it('collapses white space', () => {
    assert.equal(core.cleanText('  a\n\tb  c  '), 'a b c');
  });
});

describe('isFootnoteText', () => {
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

describe('pauseAfter', () => {
  it('detects sentence ends, also before closing quotes', () => {
    for (const word of ['end.', 'why?', 'wow!', 'so…', 'said."', 'Ende.«',
      'gesagt.“', '(end.)']) {
      assert.equal(core.pauseAfter(word), 'sentence', word);
    }
  });

  it('detects clauses', () => {
    for (const word of ['first,', 'list:', 'semi;', 'word –', 'word—']) {
      assert.equal(core.pauseAfter(word), 'clause', word);
    }
  });

  it('ignores abbreviations, ordinals and hyphenated prefixes', () => {
    for (const word of ['z.B.', 'e.g.', 'U.S.', '3.', '24.', 'Ein-',
      'word']) {
      assert.equal(core.pauseAfter(word), '', word);
    }
  });

  it('keeps years at the end of a sentence', () => {
    assert.equal(core.pauseAfter('1990.'), 'sentence');
  });
});

describe('splitLongWord', () => {
  const {maxLength} = core.config.split;

  it('keeps short words', () => {
    assert.deepEqual(core.splitLongWord('Wort'), ['Wort']);
    assert.deepEqual(core.splitLongWord('E-Mail-Adresse'), ['E-Mail-Adresse']);
  });

  it('splits at hyphens first', () => {
    assert.deepEqual(core.splitLongWord('Rhein-Main-Donau-Kanal-Verwaltung'),
        ['Rhein-Main-Donau-', 'Kanal-Verwaltung']);
  });

  it('splits URLs at slashes', () => {
    const pieces =
        core.splitLongWord('https://example.com/news/2026/a-long-article');
    assert.equal(pieces.join(''),
        'https://example.com/news/2026/a-long-article');
    for (const piece of pieces) assert.ok(piece.length <= maxLength, piece);
  });

  it('cuts long compounds into hyphenated chunks of similar length', () => {
    const pieces = core.splitLongWord('Donaudampfschifffahrtsgesellschaft');
    assert.equal(pieces.length, 2);
    assert.ok(pieces[0].endsWith('-'));
    assert.equal(pieces.join('').replace('-', ''),
        'Donaudampfschifffahrtsgesellschaft');
    for (const piece of pieces) assert.ok(piece.length <= maxLength, piece);
    assert.ok(Math.abs(pieces[0].length - pieces[1].length) <= 5);
  });

  it('prefers cuts between a vowel and a consonant', () => {
    const [first] = core.splitLongWord('Donaudampfschifffahrtsgesellschaft');
    const letters = first.slice(0, -1);
    assert.match(letters.at(-1), /[aeiouäöü]/i);
  });

  it('cuts very long words into several chunks', () => {
    const word = 'a'.repeat(70);
    const pieces = core.splitLongWord(word);
    assert.equal(pieces.join('').replace(/-/g, ''), word);
    for (const piece of pieces) assert.ok(piece.length <= maxLength, piece);
  });

  it('counts code points, not UTF-16 units', () => {
    const word = '😀'.repeat(maxLength);
    assert.deepEqual(core.splitLongWord(word), [word]);
  });
});

describe('tokenize', () => {
  it('splits paragraphs into words with pauses and sentences', () => {
    const text = core.tokenize(paragraphs('# Title here',
        'One, two. Three four.'));
    assert.deepEqual(text.words.map((word) => [word.text, word.pause]), [
      ['Title', ''],
      ['here', 'heading'],
      ['One,', 'clause'],
      ['two.', 'sentence'],
      ['Three', ''],
      ['four.', 'paragraph'],
    ]);
    assert.deepEqual(text.sentences,
        [{start: 0, end: 2}, {start: 2, end: 4}, {start: 4, end: 6}]);
    assert.deepEqual(text.words.map((word) => word.sentence),
        [0, 0, 1, 1, 2, 2]);
  });

  it('attaches dashes and stray punctuation to the word before', () => {
    const text = core.tokenize(paragraphs('Yes – no . End'));
    assert.deepEqual(text.words.map((word) => word.text),
        ['Yes –', 'no.', 'End']);
    assert.equal(text.words[0].pause, 'clause');
  });

  it('keeps a leading dash as a word of its own', () => {
    const text = core.tokenize(paragraphs('– quoted'));
    assert.deepEqual(text.words.map((word) => word.text), ['–', 'quoted']);
  });

  it('maps pieces of long words to their word', () => {
    const text = core.tokenize(paragraphs(
        'Die Donaudampfschifffahrtsgesellschaft fährt.'));
    assert.equal(text.words.length, 3);
    assert.equal(text.pieces.length, 4);
    assert.deepEqual(text.pieces.map((piece) => piece.word), [0, 1, 1, 2]);
    assert.deepEqual(text.words.map((word) => word.piece), [0, 1, 3]);
  });

  it('skips empty paragraphs and cleans text', () => {
    const text = core.tokenize(paragraphs('  ', 'Schiff­fahrt[1]'));
    assert.deepEqual(text.words.map((word) => word.text), ['Schifffahrt']);
  });

  it('returns an empty text for no paragraphs', () => {
    assert.deepEqual(core.tokenize([]),
        {words: [], pieces: [], sentences: []});
  });
});

describe('pivotIndex', () => {
  it('follows the rule of thumb by word length', () => {
    assert.equal(core.pivotIndex('a'), 0);
    assert.equal(core.pivotIndex('an'), 1);
    assert.equal(core.pivotIndex('house'), 1);
    assert.equal(core.pivotIndex('houses'), 2);
    assert.equal(core.pivotIndex('beautiful'), 2);
    assert.equal(core.pivotIndex('beautifully'), 3);
    assert.equal(core.pivotIndex('unbelievables'), 3);
    assert.equal(core.pivotIndex('incomprehensible'), 4);
  });

  it('ignores leading and trailing punctuation', () => {
    assert.equal(core.pivotIndex('"house"'), 2);
    assert.equal(core.pivotIndex('„Haus“,'), 2);
    assert.equal(core.pivotIndex('(a)'), 1);
    assert.equal(core.pivotIndex('word.'), 1);
  });

  it('counts code points', () => {
    assert.equal(core.pivotIndex('𝐀bc'), 1);
    assert.equal(core.pivotIndex('😀ab'), 2);
  });

  it('returns 0 without letters', () => {
    assert.equal(core.pivotIndex('–'), 0);
    assert.equal(core.pivotIndex(''), 0);
  });
});

describe('pieceFactors and durations', () => {
  const {delay} = core.config;

  it('lengthens pauses and long words', () => {
    const text = core.tokenize(paragraphs('# Head', 'One, two. Extraordinarily',
        'short'));
    assert.deepEqual(core.pieceFactors(text), [
      delay.heading,
      delay.clause,
      delay.sentence,
      delay.longWord * delay.paragraph,
      delay.paragraph,
    ]);
  });

  it('applies the pause of a split word to its last piece', () => {
    const text = core.tokenize(paragraphs(
        'Donaudampfschifffahrtsgesellschaft, ja'));
    const factors = core.pieceFactors(text);
    assert.equal(factors.length, 3);
    assert.equal(factors[0], delay.longWord);
    assert.equal(factors[1], delay.longWord * delay.clause);
  });

  it('computes durations from words per minute', () => {
    assert.equal(core.pieceDuration(1, 300), 200);
    assert.equal(core.pieceDuration(2, 600), 200);
  });

  it('computes the remaining time from suffix sums', () => {
    const sums = core.suffixSums([1, 2, 1.5]);
    assert.deepEqual(sums, [4.5, 3.5, 1.5, 0]);
    assert.equal(core.remainingMs(sums, 0, 300), 900);
    assert.equal(core.remainingMs(sums, 2, 300), 300);
    assert.equal(core.remainingMs(sums, 3, 300), 0);
    assert.equal(core.remainingMs(sums, 99, 300), 0);
  });

  it('formats the remaining time', () => {
    assert.equal(core.formatRemaining(0), '0:00 left');
    assert.equal(core.formatRemaining(1), '0:01 left');
    assert.equal(core.formatRemaining(59500), '1:00 left');
    assert.equal(core.formatRemaining(125000), '2:05 left');
    assert.equal(core.formatRemaining(-5), '0:00 left');
  });
});

describe('jumpTarget', () => {
  const text = core.tokenize(paragraphs(
      'a Donaudampfschifffahrtsgesellschaft b c d'));

  it('skips words, not pieces', () => {
    assert.equal(core.jumpTarget(text, 0, 1), 1);
    assert.equal(core.jumpTarget(text, 0, 2), 3);
    assert.equal(core.jumpTarget(text, 2, 1), 3);
    assert.equal(core.jumpTarget(text, 2, -1), 0);
  });

  it('goes back to the start of a word', () => {
    assert.equal(core.jumpTarget(text, 2, 0), 1);
  });

  it('stops at the start and the end', () => {
    assert.equal(core.jumpTarget(text, 1, -10), 0);
    assert.equal(core.jumpTarget(text, 1, 10), text.pieces.length - 1);
  });

  it('handles an empty text', () => {
    assert.equal(core.jumpTarget(core.tokenize([]), 0, 5), 0);
  });
});

describe('sanitizeSettings', () => {
  it('uses defaults for missing or invalid values', () => {
    const defaults = {wpm: 300, fontSize: 48, skip: 10};
    assert.deepEqual(core.sanitizeSettings(undefined), defaults);
    assert.deepEqual(core.sanitizeSettings('x'), defaults);
    assert.deepEqual(core.sanitizeSettings({wpm: 'fast', fontSize: NaN,
      skip: null}), defaults);
    assert.deepEqual(core.sanitizeSettings({wpm: Infinity, fontSize: {},
      skip: ''}), defaults);
  });

  it('clamps to the range and rounds to the step', () => {
    assert.deepEqual(core.sanitizeSettings({wpm: 5000, fontSize: 1,
      skip: 7.4}), {wpm: 1000, fontSize: 24, skip: 7});
    assert.deepEqual(core.sanitizeSettings({wpm: 312, fontSize: 49,
      skip: -3}), {wpm: 300, fontSize: 48, skip: 1});
    assert.deepEqual(core.sanitizeSettings({wpm: 313, fontSize: 51,
      skip: 50}), {wpm: 325, fontSize: 52, skip: 50});
  });

  it('accepts numeric strings from inputs', () => {
    assert.equal(core.sanitizeSetting('wpm', '450'), 450);
    assert.equal(core.sanitizeSetting('skip', ' 5 '), 5);
  });
});

describe('keyAction', () => {
  it('maps keys without a focused control', () => {
    assert.equal(core.keyAction(' ', 'other', false), 'toggle');
    assert.equal(core.keyAction('ArrowLeft', 'other', false), 'back');
    assert.equal(core.keyAction('ArrowRight', 'other', false), 'forward');
    assert.equal(core.keyAction('ArrowUp', 'other', false), 'faster');
    assert.equal(core.keyAction('ArrowDown', 'other', false), 'slower');
    assert.equal(core.keyAction('a', 'other', false), '');
  });

  it('leaves Space to buttons and arrows to sliders', () => {
    assert.equal(core.keyAction(' ', 'button', false), '');
    assert.equal(core.keyAction('ArrowRight', 'button', false), 'forward');
    assert.equal(core.keyAction(' ', 'range', false), 'toggle');
    assert.equal(core.keyAction('ArrowRight', 'range', false), '');
    assert.equal(core.keyAction('ArrowUp', 'range', false), '');
  });

  it('leaves every key to text fields and shortcuts', () => {
    assert.equal(core.keyAction(' ', 'text', false), '');
    assert.equal(core.keyAction('ArrowLeft', 'text', false), '');
    assert.equal(core.keyAction('ArrowLeft', 'other', true), '');
  });
});

describe('fitWord', () => {
  const {pivotShare, stagePadding} = core.config;

  it('puts the center of the fixation letter at the anchor', () => {
    const {scale, left} = core.fitWord({before: 20, pivot: 10, after: 40},
        1000);
    assert.equal(scale, 1);
    assert.equal(left + 20 + 5, 1000 * pivotShare);
  });

  it('shrinks words that do not fit', () => {
    const width = 400;
    const widths = {before: 60, pivot: 20, after: 600};
    const {scale, left} = core.fitWord(widths, width);
    assert.ok(scale < 1);
    const right = left + (widths.before + widths.pivot + widths.after) * scale;
    assert.ok(left >= stagePadding - 1e-9);
    assert.ok(right <= width - stagePadding + 1e-9);
    assert.ok(Math.abs(left + (60 + 10) * scale - width * pivotShare) < 1e-9);
  });

  it('never shrinks below the minimum scale', () => {
    const {scale} = core.fitWord({before: 0, pivot: 10, after: 1e6}, 300);
    assert.equal(scale, core.config.minScale);
  });

  it('keeps empty words in place', () => {
    assert.deepEqual(core.fitWord({before: 0, pivot: 0, after: 0}, 500),
        {scale: 1, left: 500 * pivotShare});
  });
});

describe('content scoring (from the Reading Ruler)', () => {
  it('excludes navigation and ads by name, but keeps content wrappers', () => {
    assert.ok(core.isExcludedName('site-sidebar'));
    assert.ok(core.isExcludedName(' ad-slot ads'));
    assert.ok(!core.isExcludedName('content-with-sidebar'));
    assert.ok(!core.isExcludedName('header'));
  });

  it('weights class names', () => {
    assert.equal(core.classWeight('article-body'), 25);
    assert.equal(core.classWeight('comments'), -25);
  });

  it('does not count code blocks as paragraphs', () => {
    assert.ok(!core.countsAsParagraph('pre', false));
    assert.ok(core.countsAsParagraph('p', false));
    assert.ok(core.countsAsParagraph('div', true));
  });

  it('scores paragraphs and picks the best container', () => {
    assert.equal(core.paragraphScore({textLength: 10, commaCount: 3}), 0);
    assert.equal(core.paragraphScore({textLength: 250, commaCount: 2}), 5);
    assert.ok(core.scoreContainer({tagName: 'article', name: '',
      paragraphs: [{textLength: 300, commaCount: 3, depth: 0}],
      linkDensity: 0}) > 0);
    assert.equal(core.pickBestCandidate(
        [{score: 10, parent: -1}, {score: 30, parent: 0}]), 1);
    assert.ok(core.hasEnoughText([{textLength: 600}]));
  });

  it('picks a nested article that holds most text', () => {
    assert.equal(core.chooseSemanticRoot([
      {textLength: 1000, parent: -1},
      {textLength: 900, parent: 0},
    ]), 1);
  });
});
