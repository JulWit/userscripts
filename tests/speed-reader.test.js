/**
 * @fileoverview Unit tests for the pure functions of
 * scripts/speed-reader.user.js. Run with `node --test` (Node.js 18+).
 */

'use strict';

const assert = require('node:assert/strict');
const {describe, it} = require('node:test');

const {loadScript} = require('./load-script.js');

const core = loadScript('speed-reader.user.js', 'speedReaderTestHook');

// Invisible and combining characters, written as code points so that they
// are visible in the source.
const SOFT_HYPHEN = String.fromCodePoint(0xAD);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200B);
const WORD_JOINER = String.fromCodePoint(0x2060);
const BYTE_ORDER_MARK = String.fromCodePoint(0xFEFF);
const ZERO_WIDTH_JOINER = String.fromCodePoint(0x200D);
const COMBINING_ACUTE = String.fromCodePoint(0x301);
const COMBINING_DIAERESIS = String.fromCodePoint(0x308);
// Woman technologist: woman, zero-width joiner, laptop.
const TECHNOLOGIST = `👩${ZERO_WIDTH_JOINER}💻`;

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
    assert.equal(core.cleanText(`Schiff${SOFT_HYPHEN}fahrt ` +
        `zero${ZERO_WIDTH_SPACE}width ${BYTE_ORDER_MARK}word` +
        `${WORD_JOINER}joiner`), 'Schifffahrt zerowidth wordjoiner');
  });

  it('keeps zero-width joiners of emoji', () => {
    assert.equal(core.cleanText(`${TECHNOLOGIST} codes`),
        `${TECHNOLOGIST} codes`);
  });

  it('composes letters with their combining accents', () => {
    assert.equal(core.cleanText(
        `Cafe${COMBINING_ACUTE} Mu${COMBINING_DIAERESIS}ller`), 'Café Müller');
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

  it('does not end a sentence after titles and common abbreviations', () => {
    for (const word of ['Dr.', 'Prof.', 'bzw.', 'ca.', 'vgl.', 'Nr.', 'Mr.',
      '(vs.']) {
      assert.equal(core.pauseAfter(word, 'word', 'Next'), '', word);
    }
  });

  it('ends a sentence after "usw." or "etc." before a capital letter', () => {
    assert.equal(core.pauseAfter('usw.', 'Äpfel', 'Danach'), 'sentence');
    assert.equal(core.pauseAfter('etc.', 'pears', 'The'), 'sentence');
    assert.equal(core.pauseAfter('usw.', 'Äpfel', 'gekauft'), '');
    assert.equal(core.pauseAfter('etc.)', 'pears', 'and'), '');
  });

  it('ends no sentence before a lower-case word or a number', () => {
    assert.equal(core.pauseAfter('Abs.', 'in', '2'), '');
    assert.equal(core.pauseAfter('Hauptstr.', 'der', '5'), '');
    assert.equal(core.pauseAfter('bspw.', 'und', 'in'), '');
    assert.equal(core.pauseAfter('12.03.', 'Am', 'fahren'), '');
    assert.equal(core.pauseAfter('end.', 'the', '"and'), '');
  });

  it('ends no sentence after single letters (z. B., initials)', () => {
    assert.equal(core.pauseAfter('z.', 'kaufen', 'B.'), '');
    assert.equal(core.pauseAfter('B.', 'z.', 'Äpfel'), '');
    assert.equal(core.pauseAfter('R.', 'J.', 'Tolkien'), '');
    // But the English "I" often ends a sentence.
    assert.equal(core.pauseAfter('I.', 'than', 'We'), 'sentence');
  });

  it('tells ordinal numbers from numbers at the end of a sentence', () => {
    // Ordinal numbers: after an article or "am", before a month, a
    // lower-case word or a number, and at the start of a paragraph.
    assert.equal(core.pauseAfter('3.', 'am', 'Mai'), '');
    assert.equal(core.pauseAfter('2.', 'der', 'Weltkrieg'), '');
    assert.equal(core.pauseAfter('3.', 'gestern.', 'Mai'), '');
    assert.equal(core.pauseAfter('3.', 'bis', 'und'), '');
    assert.equal(core.pauseAfter('1.', '', 'Einleitung'), '');
    // Counted numbers end the sentence.
    assert.equal(core.pauseAfter('12.', 'zählte', 'Dann'), 'sentence');
    assert.equal(core.pauseAfter('12.', 'counted', 'Then'), 'sentence');
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

  it('counts and keeps grapheme clusters whole', () => {
    const word = TECHNOLOGIST.repeat(maxLength);
    assert.deepEqual(core.splitLongWord(word), [word]);
    const pieces = core.splitLongWord(TECHNOLOGIST.repeat(maxLength + 5));
    assert.equal(pieces.length, 2);
    for (const piece of pieces) {
      const clusters = core.graphemes(piece.replace(/-$/, ''));
      assert.ok(clusters.every((cluster) => cluster === TECHNOLOGIST), piece);
    }
  });
});

describe('graphemes', () => {
  it('keeps letters with combining marks and emoji sequences together', () => {
    assert.deepEqual(core.graphemes(`e${COMBINING_ACUTE}a`),
        [`e${COMBINING_ACUTE}`, 'a']);
    assert.deepEqual(core.graphemes(`${TECHNOLOGIST}!`), [TECHNOLOGIST, '!']);
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

  it('keeps German abbreviations with spaces inside a sentence', () => {
    const text = core.tokenize(paragraphs(
        'Wir kaufen z. B. Äpfel, d. h. Obst, u. a. am 12.03. hier.'));
    assert.deepEqual(text.words.filter((word) => word.pause)
        .map((word) => [word.text, word.pause]), [
      ['Äpfel,', 'clause'],
      ['Obst,', 'clause'],
      ['hier.', 'paragraph'],
    ]);
    assert.equal(text.sentences.length, 1);
  });

  it('passes the neighbors of a word to the sentence detection', () => {
    const text = core.tokenize(paragraphs(
        'Am 3. Mai zählte er bis 12. Dann ging er, z.B. heim.'));
    assert.deepEqual(text.words.filter((word) => word.pause)
        .map((word) => [word.text, word.pause]), [
      ['12.', 'sentence'],
      ['er,', 'clause'],
      ['heim.', 'paragraph'],
    ]);
  });

  it('skips empty paragraphs and cleans text', () => {
    const text = core.tokenize(
        paragraphs('  ', `Schiff${SOFT_HYPHEN}fahrt[1]`));
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

  it('counts grapheme clusters', () => {
    // A letter with a combining accent is one character.
    assert.equal(core.pivotIndex(`e${COMBINING_ACUTE}tude`), 1);
    assert.equal(core.pivotIndex(`${TECHNOLOGIST}ab`), 2);
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

describe('resumeTarget', () => {
  const text = core.tokenize(paragraphs(
      'One two. Three Donaudampfschifffahrtsgesellschaft five six seven ' +
      'eight nine ten.'));
  const {maxResumeRewind} = core.config;
  // Pieces: One 0, two. 1, Three 2, Donau… 3 and 4, five 5, six 6, seven 7,
  // eight 8, nine 9, ten. 10.

  it('goes back to the start of the sentence', () => {
    assert.equal(core.resumeTarget(text, 5, maxResumeRewind), 2);
    assert.equal(core.resumeTarget(text, 1, maxResumeRewind), 0);
  });

  it('goes back at most the given number of words', () => {
    // From "ten." (word 9) five words back is "five" (word 4, piece 5).
    assert.equal(core.resumeTarget(text, 10, 5), 5);
    assert.equal(core.resumeTarget(text, 10, 0), 10);
  });

  it('starts a split word at its first piece', () => {
    assert.equal(core.resumeTarget(text, 4, 0), 3);
  });

  it('handles an empty text', () => {
    assert.equal(core.resumeTarget(core.tokenize([]), 3, 5), 0);
  });
});

describe('rampFactor', () => {
  const {pieces, start} = core.config.rampUp;

  it('starts slower and reaches the normal speed', () => {
    assert.equal(core.rampFactor(0), start);
    for (let step = 1; step < pieces; step++) {
      assert.ok(core.rampFactor(step) < core.rampFactor(step - 1));
      assert.ok(core.rampFactor(step) > 1);
    }
    assert.equal(core.rampFactor(pieces), 1);
    assert.equal(core.rampFactor(1000), 1);
  });
});

describe('stageAction', () => {
  const {touchZone} = core.config;

  it('toggles playback on a click anywhere', () => {
    for (const share of [0, 0.5, 1]) {
      assert.equal(core.stageAction(share, 'mouse'), 'toggle');
      assert.equal(core.stageAction(share, ''), 'toggle');
    }
  });

  it('skips on a tap near the edges', () => {
    assert.equal(core.stageAction(touchZone / 2, 'touch'), 'back');
    assert.equal(core.stageAction(0.5, 'touch'), 'toggle');
    assert.equal(core.stageAction(1 - touchZone / 2, 'touch'), 'forward');
  });
});

describe('remembered positions', () => {
  it('hashes texts', () => {
    assert.equal(core.hashText('abc'), core.hashText('abc'));
    assert.notEqual(core.hashText('abc'), core.hashText('abd'));
    assert.match(core.hashText(''), /^[0-9a-z]+$/);
  });

  it('ignores the hash of a URL', () => {
    assert.equal(core.withoutHash('https://a.example/x?y=1#part'),
        'https://a.example/x?y=1');
    assert.equal(core.withoutHash('https://a.example/'), 'https://a.example/');
  });

  it('keys pages by a hash of their URL, not the URL itself', () => {
    const key = core.pageKey('https://a.example/article?id=7#comments');
    assert.equal(key, core.pageKey('https://a.example/article?id=7'));
    assert.notEqual(key, core.pageKey('https://a.example/article?id=8'));
    assert.doesNotMatch(key, /example|article/);
  });

  it('keeps valid stored positions only', () => {
    assert.deepEqual(core.sanitizePositions(null), []);
    assert.deepEqual(core.sanitizePositions([
      {page: 'a', hash: 'h', word: 3, extra: true},
      {page: 'b', hash: 'h', word: 0},
      {page: 'c', hash: 'h', word: 1.5},
      {page: 7, hash: 'h', word: 2},
      'd',
    ]), [{page: 'a', hash: 'h', word: 3}]);
  });

  it('drops positions of older versions, which hold the URL', () => {
    assert.deepEqual(core.sanitizePositions([
      {url: 'https://a.example/', hash: 'h', word: 3},
      {page: 'p', url: 'https://a.example/', hash: 'h', word: 3},
    ]), []);
  });

  it('puts the newest position first and limits their number', () => {
    const {maxPositions} = core.config;
    let positions = [];
    for (let index = 0; index < maxPositions + 5; index++) {
      positions = core.withPosition(positions,
          {page: `p${index}`, hash: 'h', word: 1});
    }
    assert.equal(positions.length, maxPositions);
    assert.equal(positions[0].page, `p${maxPositions + 4}`);
    positions = core.withPosition(positions, {page: 'p10', hash: 'h', word: 9});
    assert.deepEqual(positions[0], {page: 'p10', hash: 'h', word: 9});
    assert.equal(positions.filter((entry) => entry.page === 'p10').length, 1);
    assert.equal(core.withoutPosition(positions, 'p10').length,
        maxPositions - 1);
  });

  it('restores a position only for the same text', () => {
    const positions = [{page: 'a', hash: 'h1', word: 12}];
    assert.equal(core.rememberedWord(positions, 'a', 'h1'), 12);
    assert.equal(core.rememberedWord(positions, 'a', 'h2'), 0);
    assert.equal(core.rememberedWord(positions, 'b', 'h1'), 0);
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

  it('leaves Space and Left/Right to the words of the sentence', () => {
    assert.equal(core.keyAction(' ', 'word', false), '');
    assert.equal(core.keyAction('ArrowLeft', 'word', false), '');
    assert.equal(core.keyAction('ArrowRight', 'word', false), '');
    assert.equal(core.keyAction('ArrowUp', 'word', false), 'faster');
    assert.equal(core.keyAction('Escape', 'word', false), 'close');
  });

  it('closes on Escape, also in text fields', () => {
    assert.equal(core.keyAction('Escape', 'other', false), 'close');
    assert.equal(core.keyAction('Escape', 'text', false), 'close');
    assert.equal(core.keyAction('Escape', 'other', true), '');
  });
});

describe('wordFocusTarget', () => {
  it('moves between the words with the arrow keys, Home and End', () => {
    assert.equal(core.wordFocusTarget('ArrowRight', 2, 5), 3);
    assert.equal(core.wordFocusTarget('ArrowLeft', 2, 5), 1);
    assert.equal(core.wordFocusTarget('Home', 2, 5), 0);
    assert.equal(core.wordFocusTarget('End', 2, 5), 4);
  });

  it('stays at the first and the last word', () => {
    assert.equal(core.wordFocusTarget('ArrowLeft', 0, 5), 0);
    assert.equal(core.wordFocusTarget('ArrowRight', 4, 5), 4);
  });

  it('ignores other keys', () => {
    assert.equal(core.wordFocusTarget('ArrowUp', 2, 5), -1);
    assert.equal(core.wordFocusTarget(' ', 2, 5), -1);
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
