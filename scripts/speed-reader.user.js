// ==UserScript==
// @name         Speed Reader
// @namespace    https://github.com/JulWit/userscripts
// @version      1.4.1
// @description  Shows the text of a page (or the selected text) word by word in a reader overlay on the page (RSVP), with adjustable speed and font size
// @author       Julian
// @homepageURL  https://github.com/JulWit/userscripts
// @supportURL   https://github.com/JulWit/userscripts/issues
// @icon         data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTQiIGZpbGw9IiMyYjJmMzYiLz48ZyBmaWxsPSIjOWFhM2FkIj48cmVjdCB4PSI4IiB5PSIxNyIgd2lkdGg9IjQ4IiBoZWlnaHQ9IjIiIHJ4PSIxIiBvcGFjaXR5PSIuNiIvPjxyZWN0IHg9IjgiIHk9IjQ1IiB3aWR0aD0iNDgiIGhlaWdodD0iMiIgcng9IjEiIG9wYWNpdHk9Ii42Ii8+PHJlY3QgeD0iMjYiIHk9IjExIiB3aWR0aD0iMyIgaGVpZ2h0PSI4IiByeD0iMS41Ii8+PHJlY3QgeD0iMjYiIHk9IjQ1IiB3aWR0aD0iMyIgaGVpZ2h0PSI4IiByeD0iMS41Ii8+PHJlY3QgeD0iMTAiIHk9IjI3IiB3aWR0aD0iMTIiIGhlaWdodD0iMTAiIHJ4PSIzIi8+PHJlY3QgeD0iMzMiIHk9IjI3IiB3aWR0aD0iMjEiIGhlaWdodD0iMTAiIHJ4PSIzIi8+PC9nPjxyZWN0IHg9IjIzLjUiIHk9IjI1IiB3aWR0aD0iOCIgaGVpZ2h0PSIxNCIgcng9IjMiIGZpbGw9IiNmZjVhNDUiLz48L3N2Zz4K
// @updateURL    https://raw.githubusercontent.com/JulWit/userscripts/main/scripts/speed-reader.user.js
// @downloadURL  https://raw.githubusercontent.com/JulWit/userscripts/main/scripts/speed-reader.user.js
// @require      https://raw.githubusercontent.com/JulWit/userscripts/main/lib/content-detection.js?v=1.2.0
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @run-at       document-start
// @noframes
// ==/UserScript==
// @ts-check

/**
 * @fileoverview Speed reader (Rapid Serial Visual Presentation): shows the
 * main text of a page, or the selected text, one word at a time at the same
 * place in an overlay on the page, so the eyes do not have to move. Each word
 * is aligned at its fixation letter (optimal recognition point), which is
 * highlighted and stays at the same horizontal position. Words are shown
 * longer after punctuation, at the end of paragraphs and after headings;
 * playback starts a little slower and, after a pause, resumes a few words
 * back. The position in a page's text is remembered for the next visit,
 * except in private windows.
 * The script registers menu commands and a key listener and does nothing
 * else until it is used. The reader is a modal dialog in the top layer with
 * its interface in a closed shadow root, rather than a window of its own,
 * which pop-up blockers would stop: script manager menu commands do not count
 * as user actions in the page. The script runs at document-start, so that
 * its key listener usually comes before the page's own and keeps keys from
 * the page while the reader is open. Violentmonkey does not guarantee that
 * (in Firefox, a page script may run first), so a page that adds a key
 * listener to the window in the capture phase very early still sees the
 * keys.
 * The content detection is shared with the Reading Ruler
 * (lib/content-detection.js, loaded with @require).
 * Known limitations: text in iframes and in shadow DOM (web components) is
 * not read.
 * Code style: Google JavaScript Style Guide, Google HTML/CSS Style Guide.
 */

(function() {
  'use strict';

  // ===========================================================================
  // Types
  // ===========================================================================

  /**
   * A paragraph of the text to read; heading tells whether it is a heading.
   * @typedef {{text: string, heading: boolean}} Paragraph
   */

  /**
   * The kind of pause after a word ('' for none).
   * @typedef {(''|'clause'|'sentence'|'paragraph'|'heading')} Pause
   */

  /**
   * A word of the text. pause is the kind of pause after it, sentence the
   * index of its sentence and piece the index of its first piece.
   * @typedef {{text: string, pause: !Pause, sentence: number,
   *     piece: number}} Word
   */

  /**
   * What is shown at a time: a word or, for a long word, a part of it.
   * @typedef {{text: string, word: number}} Piece
   */

  /**
   * Words of a sentence: from start (inclusive) to end (exclusive).
   * @typedef {{start: number, end: number}} Sentence
   */

  /**
   * @typedef {{words: !Array<!Word>, pieces: !Array<!Piece>,
   *     sentences: !Array<!Sentence>}} ReaderText
   */

  /**
   * Stored reader settings: words per minute, font size in px and the
   * number of words that Back and Forward skip.
   * @typedef {{wpm: number, fontSize: number, skip: number}} Settings
   */

  /** @typedef {('wpm'|'fontSize'|'skip')} SettingName */

  /** @typedef {{min: number, max: number, step: number,
   *     fallback: number}} Range */

  /**
   * Rendered widths of the parts of a word (before the fixation letter, the
   * letter itself, after it) at the configured font size.
   * @typedef {{before: number, pivot: number, after: number}} WordWidths
   */

  /**
   * What a key press does in the reader ('' for nothing).
   * @typedef {(''|'toggle'|'back'|'forward'|'faster'|'slower'|
   *     'close')} KeyAction
   */

  /**
   * Kind of the focused element in the reader, for keyAction: 'word' is a
   * word of the sentence shown while paused.
   * @typedef {('button'|'word'|'range'|'text'|'other')} TargetKind
   */

  /**
   * What a click or tap on the word does.
   * @typedef {('back'|'toggle'|'forward')} StageAction
   */

  /**
   * Remembered reading position in the text of a page: page is the hash of
   * its URL (pageKey), so that the storage holds no readable history, hash
   * the hash of its text (hashText) and word the index of the word.
   * @typedef {{page: string, hash: string, word: number}} Position
   */

  // ===========================================================================
  // Configuration
  // ===========================================================================

  /**
   * Freezes an object including nested objects and arrays.
   * @param {T} value
   * @return {T}
   * @template T
   */
  function deepFreeze(value) {
    for (const child of Object.values(/** @type {!Object} */ (value))) {
      if (child && typeof child === 'object') deepFreeze(child);
    }
    return Object.freeze(value);
  }

  const CONFIG = deepFreeze({
    // Reader settings and their ranges; values are rounded to the step.
    settings: {
      wpm: {min: 100, max: 1000, step: 25, fallback: 300},
      fontSize: {min: 24, max: 96, step: 4, fallback: 48},
      skip: {min: 1, max: 50, step: 1, fallback: 10},
    },
    // Change of the speed by the up and down arrow keys.
    wpmKeyStep: 25,
    // Display time of a word relative to 60000 / wpm ms, by the pause after
    // it. Words with at least longWordLength letters or digits are shown
    // longWord times as long.
    delay: {
      clause: 1.5,
      sentence: 2,
      paragraph: 2.5,
      heading: 3,
      longWord: 1.2,
      longWordLength: 12,
    },
    // Playback starts slower: the first piece is shown start times as long,
    // and the factor falls evenly to 1 over the first pieces.
    rampUp: {pieces: 4, start: 2},
    // After a pause, playback resumes at the start of the sentence, but at
    // most this many words back.
    maxResumeRewind: 5,
    // Words with more characters are split, at hyphens and slashes first,
    // then into pieces of equal length with a hyphen. A cut may move up to
    // cutWindow characters to fall between a vowel and a consonant.
    split: {maxLength: 20, cutWindow: 2},
    // Fixation letter: the first letter of a word of length 1, the second
    // up to length 5, the third up to 9, the fourth up to 13, the fifth
    // beyond.
    pivotSteps: [1, 5, 9, 13],
    // Abbreviations (lower case, without the period) that usually come
    // before a capitalized word or a name, so that their period ends no
    // sentence. Before a lower-case word or a number, no period does.
    abbreviations: ['abb', 'abs', 'approx', 'bd', 'bspw', 'bzw', 'ca', 'cf',
      'dr', 'evtl', 'fig', 'fr', 'ggf', 'hr', 'hrn', 'hrsg', 'inkl', 'jr',
      'kap', 'mio', 'mr', 'mrd', 'mrs', 'ms', 'nr', 'pp', 'prof', 'sog', 'sr',
      'st', 'str', 'tel', 'vgl', 'vol', 'vs', 'zzgl'],
    // Words after which a number with a period is an ordinal number ("am 3.
    // Mai", "der 2. Platz"), and months that follow one ("3. Mai").
    ordinalWords: ['am', 'beim', 'das', 'dem', 'den', 'der', 'des', 'die',
      'ihr', 'ihre', 'ihrem', 'ihren', 'im', 'jedem', 'jeden', 'jeder',
      'jedes', 'sein', 'seine', 'seinem', 'seinen', 'vom', 'zum', 'zur'],
    monthNames: ['januar', 'jänner', 'februar', 'märz', 'april', 'mai',
      'juni', 'juli', 'august', 'september', 'oktober', 'november',
      'dezember', 'january', 'february', 'march', 'may', 'june', 'july',
      'october', 'december'],
    // Horizontal position of the fixation letter as a share of the stage
    // width, and the space kept free at the stage edges in px.
    pivotShare: 0.35,
    stagePadding: 12,
    // Words are never shrunk below this share of the font size.
    minScale: 0.2,
    // A tap (not a click) on this share of the stage at its left or right
    // edge skips back or forward instead of toggling playback.
    touchZone: 0.25,
    // A timer that fires later than this (in ms, e.g. while the window was
    // throttled) restarts the schedule instead of catching up.
    maxLag: 1000,
    // Below this window width the buttons show icons only.
    compactWidth: 420,
    // Size of the reader panel in px. Below fullScreenWidth it fills the
    // window.
    panel: {maxWidth: 760, minHeight: 540},
    fullScreenWidth: 600,
    storageSettings: 'settings',
    // Reading positions of the most recently read pages, newest first.
    storagePositions: 'positions',
    maxPositions: 50,
  });

  // ===========================================================================
  // Pure functions: text, timing, settings (no DOM, no storage)
  // ===========================================================================

  // Soft hyphens and zero-width characters (U+00AD, U+200B, U+2060, U+FEFF)
  // that sites insert for line breaking. Zero-width joiners stay: they form
  // emoji and ligatures.
  const INVISIBLE_PATTERN = /[\u00AD\u200B\u2060\uFEFF]/g;
  // Footnote markers such as [1], [2–4], [a] or [note 3].
  const FOOTNOTE_PATTERN = new RegExp(
      String.raw`\s*\[(?:${ContentDetection.footnoteMarker})\]`, 'gi');
  const LETTER_PATTERN = /[\p{L}\p{N}]/u;
  const VOWEL_PATTERN = /[aeiouyäöüàáâèéêëìíîïòóôùúûæøå]/iu;
  // Quotes and brackets around a word.
  const OPENING_PATTERN = /^["'“”‘’„»«›‹(\[{]+/u;
  const CLOSING_PATTERN = /["'“”‘’»«›‹)\]}]+$/u;
  const GRAPHEME_SEGMENTER = typeof Intl.Segmenter === 'function' ?
      new Intl.Segmenter(undefined, {granularity: 'grapheme'}) :
      null;

  /**
   * @param {number} value
   * @param {number} min
   * @param {number} max
   * @return {number}
   */
  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /**
   * Splits a text into the characters a reader sees (grapheme clusters): a
   * letter with its combining marks, a flag or an emoji sequence stays
   * whole.
   * @param {string} text
   * @return {!Array<string>}
   */
  function graphemes(text) {
    return GRAPHEME_SEGMENTER ?
        Array.from(GRAPHEME_SEGMENTER.segment(text), (part) => part.segment) :
        Array.from(text);
  }

  /**
   * Removes footnote markers such as "[1]" from a text.
   * @param {string} text
   * @return {string}
   */
  function stripFootnoteMarkers(text) {
    return text.replace(FOOTNOTE_PATTERN, '');
  }

  /**
   * Prepares the text of a paragraph for reading: composes letters with
   * their accents (NFC), removes soft hyphens, zero-width characters and
   * footnote markers and collapses white space.
   * @param {string} text
   * @return {string}
   */
  function cleanText(text) {
    return stripFootnoteMarkers(
        text.normalize('NFC').replace(INVISIBLE_PATTERN, ''))
        .replace(/\s+/g, ' ').trim();
  }

  /**
   * @param {string} text
   * @return {number} Number of letters and digits.
   */
  function letterCount(text) {
    let count = 0;
    for (const char of text) {
      if (LETTER_PATTERN.test(char)) count++;
    }
    return count;
  }

  /**
   * @param {string} word
   * @return {string} The word without surrounding quotes, brackets and
   *     trailing punctuation, in lower case.
   */
  function bareWord(word) {
    return word.replace(OPENING_PATTERN, '').replace(CLOSING_PATTERN, '')
        .replace(/[.,;:!?…]+$/u, '').toLowerCase();
  }

  /**
   * Whether a period ends a sentence. It does not before a lower-case word
   * or a number ("usw. gekauft", "Abs. 2", "12.03. fahren"), after a single
   * letter ("z. B.", initials such as "J. R. R."), after letters with
   * periods ("z.B.") or after a common abbreviation ("Dr.", "bzw."). A
   * number of one or two digits, or a date such as "12.03.", is an ordinal
   * number ("am 3. Mai") and ends no sentence at the start of a paragraph (a
   * numbered heading or list item), after an article or a contraction such
   * as "am", or before a month.
   * @param {string} text The word without closing quotes and brackets.
   * @param {string} previous The word before, '' at the paragraph start.
   * @param {string} next The word after, '' at the paragraph end.
   * @return {boolean}
   */
  function endsSentenceAtPeriod(text, previous, next) {
    const following = next.replace(OPENING_PATTERN, '');
    if (/^[\p{Ll}\d]/u.test(following)) return false;
    const word = text.replace(OPENING_PATTERN, '');
    // Not the English "I" and the times of day "a.m." and "p.m.", which often
    // end a sentence ("than I.", "at 5 p.m.").
    if (/^(?:\p{L}\.)+$/u.test(word) && word !== 'I.' &&
        !/^[ap]\.m\.$/i.test(word)) {
      return false;
    }
    const stem = word.slice(0, -1).toLowerCase();
    if (CONFIG.abbreviations.includes(stem)) return false;
    if (/^\d{1,2}(?:\.\d{1,2})?$/.test(stem)) {
      const ordinal = !previous ||
          CONFIG.ordinalWords.includes(bareWord(previous)) ||
          CONFIG.monthNames.includes(bareWord(following));
      return !ordinal;
    }
    return true;
  }

  /**
   * The pause after a word inside a paragraph, from its punctuation (see
   * endsSentenceAtPeriod for periods). Closing quotes and brackets are
   * ignored. An exclamation or question mark or an ellipsis before a
   * lower-case word ("„Halt!“ rief er", "wartete … und") ends no sentence,
   * but gets the pause of a clause.
   * @param {string} word
   * @param {string=} previous The word before, '' at the paragraph start.
   * @param {string=} next The word after, '' at the paragraph end.
   * @return {!Pause} '', 'clause' or 'sentence'.
   */
  function pauseAfter(word, previous = '', next = '') {
    const text = word.replace(CLOSING_PATTERN, '');
    if (/(?:[!?…]|\.\.\.)$/.test(text)) {
      return /^\p{Ll}/u.test(next.replace(OPENING_PATTERN, '')) ?
          'clause' :
          'sentence';
    }
    if (text.endsWith('.')) {
      return endsSentenceAtPeriod(text, previous, next) ? 'sentence' : '';
    }
    return /(?:[,;:]|\s[-–—]|[–—])$/.test(text) ? 'clause' : '';
  }

  /**
   * Cuts a run of characters without break opportunities into pieces of
   * about equal length, each but the last ending with a hyphen. Cuts move
   * by up to CONFIG.split.cutWindow characters to fall between a vowel and
   * a consonant, which often matches a syllable boundary.
   * @param {!Array<string>} chars Grapheme clusters.
   * @return {!Array<string>}
   */
  function cutIntoChunks(chars) {
    const {maxLength, cutWindow} = CONFIG.split;
    const limit = maxLength - 1;
    const count = Math.ceil(chars.length / limit);
    /** @type {!Array<string>} */
    const chunks = [];
    let start = 0;
    for (let left = count; left > 1; left--) {
      const target = start + Math.ceil((chars.length - start) / left);
      let cut = target;
      for (let distance = 1; distance <= cutWindow; distance++) {
        const options = [target - distance, target + distance];
        const found = options.find((position) =>
          position > start && position - start <= limit &&
            chars.length - position >= 2 &&
            VOWEL_PATTERN.test(chars[position - 1]) &&
            LETTER_PATTERN.test(chars[position]) &&
            !VOWEL_PATTERN.test(chars[position]));
        if (found !== undefined) {
          cut = found;
          break;
        }
      }
      chunks.push(`${chars.slice(start, cut).join('')}-`);
      start = cut;
    }
    chunks.push(chars.slice(start).join(''));
    return chunks;
  }

  /**
   * Splits a word that is too long to be read at a glance (compounds, URLs)
   * into pieces of at most CONFIG.split.maxLength characters (grapheme
   * clusters): at hyphens, dashes, slashes and underscores, which stay at
   * the end of a piece, and where there are none, into chunks with a hyphen.
   * @param {string} word
   * @return {!Array<string>} The word itself if it is short enough.
   */
  function splitLongWord(word) {
    const {maxLength} = CONFIG.split;
    // A word has at most as many grapheme clusters as UTF-16 code units, so
    // most words need no segmentation.
    if (word.length <= maxLength || graphemes(word).length <= maxLength) {
      return [word];
    }
    const segments = word.match(/[^-–/_]*(?:[-–/_]+|$)/gu) || [word];
    /** @type {!Array<string>} */
    const merged = [];
    for (const segment of segments) {
      if (!segment) continue;
      const last = merged.length - 1;
      if (last >= 0 &&
          graphemes(merged[last] + segment).length <= maxLength) {
        merged[last] += segment;
      } else {
        merged.push(segment);
      }
    }
    return merged.flatMap((part) => {
      const chars = graphemes(part);
      return chars.length > maxLength ? cutIntoChunks(chars) : [part];
    });
  }

  /**
   * Splits paragraphs into words and the pieces shown one at a time. Tokens
   * without letters or digits (dashes, stray punctuation) are attached to
   * the word before them. A sentence ends after sentence punctuation and at
   * the end of a paragraph.
   * @param {!Array<!Paragraph>} paragraphs
   * @return {!ReaderText}
   */
  function tokenize(paragraphs) {
    /** @type {!Array<!Word>} */
    const words = [];
    /** @type {!Array<!Piece>} */
    const pieces = [];
    /** @type {!Array<!Sentence>} */
    const sentences = [];
    let sentenceStart = 0;
    for (const paragraph of paragraphs) {
      /** @type {!Array<string>} */
      const texts = [];
      for (const token of cleanText(paragraph.text).split(' ')) {
        if (!token) continue;
        if (!LETTER_PATTERN.test(token) && texts.length) {
          const last = texts.length - 1;
          texts[last] += /^[.,;:!?…]/.test(token) ? token : ` ${token}`;
        } else {
          texts.push(token);
        }
      }
      texts.forEach((text, index) => {
        /** @type {!Pause} */
        let pause = pauseAfter(text, texts[index - 1] || '',
            texts[index + 1] || '');
        if (index === texts.length - 1) {
          pause = paragraph.heading ? 'heading' : 'paragraph';
        }
        words.push({
          text,
          pause,
          sentence: sentences.length,
          piece: pieces.length,
        });
        for (const part of splitLongWord(text)) {
          pieces.push({text: part, word: words.length - 1});
        }
        if (pause && pause !== 'clause') {
          sentences.push({start: sentenceStart, end: words.length});
          sentenceStart = words.length;
        }
      });
    }
    return {words, pieces, sentences};
  }

  /**
   * Index of the fixation letter of a word, in grapheme clusters (see
   * graphemes): see CONFIG.pivotSteps. Leading and trailing punctuation does
   * not count towards the length, and the letter is never a leading quote.
   * @param {string} text
   * @return {number}
   */
  function pivotIndex(text) {
    const chars = graphemes(text);
    let start = 0;
    while (start < chars.length && !LETTER_PATTERN.test(chars[start])) {
      start++;
    }
    if (start === chars.length) return 0;
    let end = chars.length;
    while (!LETTER_PATTERN.test(chars[end - 1])) end--;
    const length = end - start;
    return start + CONFIG.pivotSteps.filter((step) => length > step).length;
  }

  /**
   * Display time of each piece relative to 60000 / wpm ms: longer for long
   * pieces and, for the last piece of a word, by the pause after the word.
   * @param {!ReaderText} text
   * @return {!Array<number>}
   */
  function pieceFactors(text) {
    const {delay} = CONFIG;
    return text.pieces.map((piece, index) => {
      let factor = letterCount(piece.text) >= delay.longWordLength ?
          delay.longWord :
          1;
      const next = text.pieces[index + 1];
      if (!next || next.word !== piece.word) {
        const pause = text.words[piece.word].pause;
        if (pause) factor *= delay[pause];
      }
      return factor;
    });
  }

  /**
   * Factor of the display time at the start of playback (CONFIG.rampUp).
   * @param {number} step Pieces shown since playback started; 0 for the
   *     first.
   * @return {number}
   */
  function rampFactor(step) {
    const {pieces, start} = CONFIG.rampUp;
    if (step >= pieces) return 1;
    return 1 + (start - 1) * (pieces - Math.max(0, step)) / pieces;
  }

  /**
   * @param {!Array<number>} factors
   * @return {!Array<number>} Sums of the factors from each index to the end,
   *     with one more entry (0) for the end.
   */
  function suffixSums(factors) {
    const sums = new Array(factors.length + 1).fill(0);
    for (let index = factors.length - 1; index >= 0; index--) {
      sums[index] = sums[index + 1] + factors[index];
    }
    return sums;
  }

  /**
   * @param {number} factor Display time factor of a piece.
   * @param {number} wpm
   * @return {number} Display time in ms.
   */
  function pieceDuration(factor, wpm) {
    return factor * 60000 / wpm;
  }

  /**
   * @param {!Array<number>} sums From suffixSums.
   * @param {number} index Current piece; it counts as not yet read.
   * @param {number} wpm
   * @return {number} Remaining reading time in ms.
   */
  function remainingMs(sums, index, wpm) {
    return pieceDuration(sums[clamp(index, 0, sums.length - 1)] || 0, wpm);
  }

  /**
   * @param {number} ms
   * @return {string} E.g. "2:05 left".
   */
  function formatRemaining(ms) {
    const seconds = Math.ceil(Math.max(0, ms) / 1000);
    const rest = String(seconds % 60).padStart(2, '0');
    return `${Math.floor(seconds / 60)}:${rest} left`;
  }

  /**
   * The piece to show after skipping words: the first piece of the word
   * delta words away from the current one, within the text.
   * @param {!ReaderText} text
   * @param {number} index Current piece.
   * @param {number} delta Words to skip; negative to go back.
   * @return {number} Piece index, 0 for an empty text.
   */
  function jumpTarget(text, index, delta) {
    if (!text.words.length) return 0;
    const word = text.pieces[clamp(index, 0, text.pieces.length - 1)].word;
    return text.words[clamp(word + delta, 0, text.words.length - 1)].piece;
  }

  /**
   * The piece to resume at after a pause, so that the reader finds the
   * thread again: the first piece of the current sentence, but at most
   * maxRewind words back.
   * @param {!ReaderText} text
   * @param {number} index Current piece.
   * @param {number} maxRewind
   * @return {number} Piece index, 0 for an empty text.
   */
  function resumeTarget(text, index, maxRewind) {
    if (!text.words.length) return 0;
    const word = text.pieces[clamp(index, 0, text.pieces.length - 1)].word;
    const sentence = text.sentences[text.words[word].sentence];
    const start = sentence ? sentence.start : word;
    return text.words[Math.max(start, word - maxRewind)].piece;
  }

  /**
   * What a click or tap on the word does: a tap near the left or right edge
   * of the stage skips, anything else toggles playback.
   * @param {number} share Horizontal position as a share of the stage width.
   * @param {string} pointerType PointerEvent.pointerType of the press.
   * @return {!StageAction}
   */
  function stageAction(share, pointerType) {
    if (pointerType !== 'touch') return 'toggle';
    if (share < CONFIG.touchZone) return 'back';
    if (share > 1 - CONFIG.touchZone) return 'forward';
    return 'toggle';
  }

  /**
   * Validates a setting: numbers are clamped to the range and rounded to its
   * step, anything else becomes the default.
   * @param {!SettingName} name
   * @param {*} value
   * @return {number}
   */
  function sanitizeSetting(name, value) {
    const range = CONFIG.settings[name];
    const number = typeof value === 'string' && value.trim() ?
        Number(value) :
        value;
    if (typeof number !== 'number' || !Number.isFinite(number)) {
      return range.fallback;
    }
    const steps = Math.round((clamp(number, range.min, range.max) - range.min) /
        range.step);
    return Math.min(range.min + steps * range.step, range.max);
  }

  /**
   * Validates stored settings.
   * @param {*} value
   * @return {!Settings}
   */
  function sanitizeSettings(value) {
    const stored = value && typeof value === 'object' ? value : {};
    return {
      wpm: sanitizeSetting('wpm', stored.wpm),
      fontSize: sanitizeSetting('fontSize', stored.fontSize),
      skip: sanitizeSetting('skip', stored.skip),
    };
  }

  /** @type {!Readonly<!Record<string, !KeyAction>>} */
  const KEY_ACTIONS = Object.freeze({
    ' ': 'toggle',
    'ArrowLeft': 'back',
    'ArrowRight': 'forward',
    'ArrowUp': 'faster',
    'ArrowDown': 'slower',
  });

  /**
   * The reader action of a key press. Escape closes the reader. Other keys
   * that the focused control uses itself keep their normal behavior: Space
   * and Enter press a button, the arrow keys move a slider and between the
   * words of the sentence (see wordFocusTarget), and text fields take every
   * key.
   * @param {string} key KeyboardEvent.key.
   * @param {!TargetKind} target Kind of the focused element.
   * @param {boolean} modified Whether Ctrl, Alt or Meta is held.
   * @return {!KeyAction}
   */
  function keyAction(key, target, modified) {
    if (modified) return '';
    if (key === 'Escape') return 'close';
    if (target === 'text') return '';
    const action = KEY_ACTIONS[key] || '';
    if ((target === 'button' || target === 'word') && action === 'toggle') {
      return '';
    }
    if (target === 'word' && (action === 'back' || action === 'forward')) {
      return '';
    }
    if (target === 'range' && action && action !== 'toggle') return '';
    return action;
  }

  /**
   * The word of the sentence to focus after a key press on one of them: the
   * words form one stop in the tab order, and the arrow keys, Home and End
   * move between them.
   * @param {string} key KeyboardEvent.key.
   * @param {number} index Index of the focused word in the sentence.
   * @param {number} count Number of words in the sentence.
   * @return {number} Index of the word to focus, -1 for another key.
   */
  function wordFocusTarget(key, index, count) {
    switch (key) {
      case 'ArrowLeft':
        return Math.max(0, index - 1);
      case 'ArrowRight':
        return Math.min(count - 1, index + 1);
      case 'Home':
        return 0;
      case 'End':
        return count - 1;
      default:
        return -1;
    }
  }

  /**
   * Places a word so that the center of its fixation letter is at
   * CONFIG.pivotShare of the stage width, and shrinks it if a side would
   * not fit.
   * @param {!WordWidths} widths At scale 1.
   * @param {number} stageWidth
   * @return {{scale: number, left: number}} Font size factor and left edge
   *     of the word in px.
   */
  function fitWord(widths, stageWidth) {
    const anchor = stageWidth * CONFIG.pivotShare;
    const half = widths.pivot / 2;
    const leftSpace = anchor - CONFIG.stagePadding;
    const rightSpace = stageWidth - anchor - CONFIG.stagePadding;
    let scale = 1;
    if (widths.before + half > 0) {
      scale = Math.min(scale, leftSpace / (widths.before + half));
    }
    if (widths.after + half > 0) {
      scale = Math.min(scale, rightSpace / (widths.after + half));
    }
    scale = clamp(scale, CONFIG.minScale, 1);
    return {scale, left: anchor - (widths.before + half) * scale};
  }

  // ===========================================================================
  // Pure functions: remembered positions
  // ===========================================================================

  /**
   * A short hash of a text (32-bit FNV-1a), to recognize the same text.
   * @param {string} text
   * @return {string}
   */
  function hashText(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  }

  /**
   * @param {string} href
   * @return {string} The URL without its hash, which marks a place on the
   *     same page.
   */
  function withoutHash(href) {
    const index = href.indexOf('#');
    return index < 0 ? href : href.slice(0, index);
  }

  /**
   * @param {string} href
   * @return {string} Key of a page for its remembered position: a hash of
   *     its URL without the hash part.
   */
  function pageKey(href) {
    return hashText(withoutHash(href));
  }

  /**
   * Validates stored positions. Entries of version 1.2 and 1.3.0, with the
   * URL itself, are dropped.
   * @param {*} value
   * @return {!Array<!Position>}
   */
  function sanitizePositions(value) {
    if (!Array.isArray(value)) return [];
    return value.filter((entry) => entry && typeof entry === 'object' &&
        typeof entry.page === 'string' && typeof entry.hash === 'string' &&
        !('url' in entry) && Number.isInteger(entry.word) && entry.word > 0)
        .slice(0, CONFIG.maxPositions)
        .map((entry) => ({page: entry.page, hash: entry.hash,
          word: entry.word}));
  }

  /**
   * @param {!Array<!Position>} positions
   * @param {!Position} position
   * @return {!Array<!Position>} The positions with this one first, replacing
   *     the one of the same page, and at most CONFIG.maxPositions.
   */
  function withPosition(positions, position) {
    return [
      position,
      ...positions.filter((entry) => entry.page !== position.page),
    ].slice(0, CONFIG.maxPositions);
  }

  /**
   * @param {!Array<!Position>} positions
   * @param {string} page Key of the page (pageKey).
   * @return {!Array<!Position>} The positions without the one of the page.
   */
  function withoutPosition(positions, page) {
    return positions.filter((entry) => entry.page !== page);
  }

  /**
   * @param {!Array<!Position>} positions
   * @param {string} page Key of the page (pageKey).
   * @param {string} hash Hash of the text now on the page.
   * @return {number} Remembered word index, 0 if there is none or the text
   *     changed.
   */
  function rememberedWord(positions, page, hash) {
    const entry = positions.find((position) => position.page === page);
    return entry && entry.hash === hash ? entry.word : 0;
  }

  /** The pure functions, for unit tests. */
  const CORE = Object.freeze({
    config: CONFIG,
    graphemes,
    stripFootnoteMarkers,
    cleanText,
    letterCount,
    pauseAfter,
    splitLongWord,
    tokenize,
    pivotIndex,
    pieceFactors,
    rampFactor,
    suffixSums,
    pieceDuration,
    remainingMs,
    formatRemaining,
    jumpTarget,
    resumeTarget,
    stageAction,
    sanitizeSetting,
    sanitizeSettings,
    keyAction,
    wordFocusTarget,
    fitWord,
    hashText,
    withoutHash,
    pageKey,
    sanitizePositions,
    withPosition,
    withoutPosition,
    rememberedWord,
  });

  // Unit tests (tests/*.test.js) load this file with a hook instead of running
  // it on a page. Everything above is free of DOM, storage and network access,
  // so the script stops here.
  if (typeof globalThis.speedReaderTestHook === 'function') {
    globalThis.speedReaderTestHook(CORE);
    return;
  }

  // ===========================================================================
  // State
  // ===========================================================================

  // Script managers provide GM_* as local identifiers, not necessarily as
  // window properties.
  /* global GM_getValue, GM_setValue, GM_registerMenuCommand,
     GM_addValueChangeListener, GM_info */

  /**
   * Elements of the reader overlay. themed lists the elements with colors
   * from the theme: CSS property names mapped to keys of THEMES.light.
   * @typedef {{backdrop: !HTMLElement, panel: !HTMLElement,
   *     heading: !HTMLElement, close: !HTMLButtonElement,
   *     stage: !HTMLElement, guide: !HTMLElement,
   *     word: !HTMLElement, before: !HTMLElement, pivot: !HTMLElement,
   *     after: !HTMLElement, message: !HTMLElement, context: !HTMLElement,
   *     fill: !HTMLElement, position: !HTMLElement, remaining: !HTMLElement,
   *     back: !HTMLButtonElement, play: !HTMLButtonElement,
   *     playIcon: !SVGPathElement, playLabel: !HTMLElement,
   *     forward: !HTMLButtonElement, labels: !Array<!HTMLElement>,
   *     wpm: !HTMLInputElement, wpmValue: !HTMLElement,
   *     fontSize: !HTMLInputElement, fontSizeValue: !HTMLElement,
   *     skip: !HTMLInputElement,
   *     themed: !Array<{element: !Element,
   *         styles: !Object<string, !ThemeKey>}>}} Ui
   */

  /**
   * The reader. dialog is the modal dialog that holds the overlay; it is in
   * the page only while the reader is open. host holds the interface in a
   * closed shadow root. source tells where the text came from; page is the
   * key of the page it came from (pageKey, taken when it was loaded, as a
   * web app may change the URL later), hash identifies the text for the
   * remembered position, and savedWord is the word last stored for it (or
   * the word shown when the positions were forgotten). index is the shown
   * piece; finished tells that playback ran to the end, so that Play starts
   * over. resumeRewind
   * tells that playback was paused (not moved since), so that Play goes back
   * a little. rampStep counts the pieces shown since playback started.
   * nextDue is the time (performance.now()) at which the next piece is due.
   * viewport is the viewport meta element the open reader added to the
   * page, rootStyles the page's inline styles of the root element that it
   * replaced, and focus the element that had the focus before.
   * backdropSheet hides the dialog's ::backdrop (null if it cannot be
   * created). draggedSlider is the slider the pointer is pressed on.
   * @typedef {{dialog: !HTMLDialogElement, host: !HTMLElement,
   *     shadow: !ShadowRoot, ui: !Ui, text: !ReaderText, key: string,
   *     source: ('page'|'selection'), page: string, hash: string,
   *     savedWord: number,
   *     factors: !Array<number>, sums: !Array<number>, index: number,
   *     playing: boolean, finished: boolean, resumeRewind: boolean,
   *     rampStep: number, timer: number, nextDue: number,
   *     darkQuery: !MediaQueryList, viewport: ?HTMLMetaElement,
   *     rootStyles: !Array<{name: string, value: string, priority: string}>,
   *     backdropSheet: ?CSSStyleSheet, draggedSlider: ?HTMLInputElement,
   *     focus: ?HTMLElement}} Reader
   */

  /**
   * Text to read, the title of its page and where it came from.
   * @typedef {{title: string, paragraphs: !Array<!Paragraph>,
   *     source: ('page'|'selection')}} Content
   */

  /**
   * Mutable state of the script.
   * @typedef {Object} State
   * @property {!Settings} settings
   * @property {?Reader} reader Created on first use and kept after closing,
   *     so that the same text continues where it was.
   * @property {!Set<string>} heldKeys Codes of the keys pressed while the
   *     reader was open and not released yet: their other events do not
   *     reach the page either, also after the reader closed (Escape).
   */

  /** @type {!State} */
  const state = {
    settings: sanitizeSettings(null),
    reader: null,
    heldKeys: new Set(),
  };

  // Content detection (lib/content-detection.js). Read word by word, code,
  // tables of data (infoboxes) and lists of references are noise, as are
  // the edit links of wiki headings; nor is what a screen reader would
  // skip read, and footnote links are left out.
  const detector = ContentDetection.createDetector({
    codeBlocks: 'skip',
    skipAriaHidden: true,
    skipFootnoteReferences: true,
    skipDataTables: true,
    skippedNames: ['editsection', 'infobox', 'navbox', 'navframe', 'refbegin',
      'references', 'reflist'],
    requireBlockLikeRoot: false,
  });
  const HEADING_TAGS = new Set(ContentDetection.config.headingTags);

  // ===========================================================================
  // Text extraction
  // ===========================================================================

  /**
   * The selected text of the page, split into paragraphs at line breaks.
   * @return {?Array<!Paragraph>} null without a selection.
   */
  function selectedParagraphs() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return null;
    const text = selection.toString();
    if (!/\S/.test(text)) return null;
    return text.split(/\n/)
        .filter((line) => /\S/.test(line))
        .map((line) => ({text: line, heading: false}));
  }

  /**
   * The paragraphs of the main text of the page, in document order. Text
   * nodes are grouped by their block; a block interrupted by a nested block
   * (a list inside a list item) gives several paragraphs.
   * @return {!Array<!Paragraph>} Empty if the page has no article-like
   *     content.
   */
  function pageParagraphs() {
    const root = detector.findRoot();
    if (!root) return [];
    /** @type {!Array<!Paragraph>} */
    const paragraphs = [];
    /** @type {?Element} */
    let block = null;
    /** @type {!Array<string>} */
    let parts = [];
    const flush = () => {
      const text = parts.join('');
      if (block && /\S/.test(text)) {
        paragraphs.push({text, heading: HEADING_TAGS.has(block.localName)});
      }
      parts = [];
    };
    const walker = document.createTreeWalker(
        root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, (node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            return NodeFilter.FILTER_ACCEPT;
          }
          const element = /** @type {!Element} */ (node);
          if (detector.exclusionOf(element)) return NodeFilter.FILTER_REJECT;
          return element.localName === 'br' ?
              NodeFilter.FILTER_ACCEPT :
              NodeFilter.FILTER_SKIP;
        });
    /** @type {?Element} */
    let box = null;
    // Line breaks since the last text: two or more (<br><br>) separate
    // paragraphs on pages that have no paragraph elements.
    let breaks = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType !== Node.TEXT_NODE) {
        breaks++;
        parts.push(' ');
        continue;
      }
      const text = /** @type {!Text} */ (node);
      // White space of its own ("<b>A</b> <i>B</i>", "&nbsp;" in a span)
      // belongs to no block, but separates the words around it.
      if (!/\S/.test(text.data)) {
        parts.push(' ');
        continue;
      }
      const owner = detector.blockOf(text, root);
      if (!owner) continue;
      if (owner !== block) {
        flush();
        block = owner;
        box = null;
      } else if (breaks >= 2) {
        flush();
      }
      breaks = 0;
      // Boxes of their own inside a block (a kicker above a title, both in
      // the heading) start new lines: their words are separate too.
      const ownBox = boxOf(text, owner);
      if (box && ownBox !== box) parts.push(' ');
      box = ownBox;
      parts.push(text.data);
    }
    flush();
    return paragraphs;
  }

  /**
   * The box a text node is laid out in within its block: its nearest
   * ancestor below the block that is not laid out inline, or the block.
   * @param {!Text} text
   * @param {!Element} block
   * @return {!Element}
   */
  function boxOf(text, block) {
    for (let element = text.parentElement; element && element !== block;
      element = element.parentElement) {
      const display = detector.styleOf(element).display;
      if (!display.startsWith('inline') && display !== 'contents') {
        return element;
      }
    }
    return block;
  }

  /**
   * Collects the text to read: the selection if there is one, the main
   * text of the page otherwise.
   * @return {!Content}
   */
  function extractContent() {
    detector.resetCaches();
    const title = document.title.trim() || location.hostname;
    const selected = selectedParagraphs();
    return selected ?
        {title, paragraphs: selected, source: 'selection'} :
        {title, paragraphs: pageParagraphs(), source: 'page'};
  }

  // ===========================================================================
  // Reader overlay: elements and styles
  // ===========================================================================

  // Colors of the reader in light and dark mode. The looks are set inline
  // through the CSSOM, which no Content Security Policy blocks: in Firefox a
  // script manager may have to run the script as a content script, where a
  // constructed style sheet cannot be adopted, and the page's policy may
  // block a style element. The color scheme is therefore followed through
  // matchMedia instead of a media query, and the style sheet below only
  // adds what inline styles cannot express.
  const THEMES = deepFreeze({
    light: {
      backdrop: 'rgba(0, 0, 0, .45)',
      background: '#f7f6f2',
      text: '#1f2328',
      muted: '#646b73',
      line: '#dcdbd5',
      pivot: '#d2381f',
      surface: '#ffffff',
      border: '#cfd2d6',
      fill: '#56748c',
      mark: '#1f2328',
    },
    dark: {
      backdrop: 'rgba(0, 0, 0, .6)',
      background: '#16181b',
      text: '#e7e6e1',
      muted: '#9aa1a8',
      line: '#33373d',
      pivot: '#ff6b55',
      surface: '#22252a',
      border: '#3d4249',
      fill: '#8fb0c9',
      mark: '#e7e6e1',
    },
  });

  /** @typedef {keyof typeof THEMES.light} ThemeKey */

  const READER_STYLES = `
    .sr-button:focus-visible,
    .sr-input:focus-visible {
      outline: 2px solid currentColor;
      outline-offset: 2px;
    }

    .sr-context-word:focus-visible,
    .sr-mark:focus-visible {
      outline: 2px solid currentColor;
      outline-offset: 1px;
    }

    .sr-button:not(:disabled):hover {
      filter: brightness(.94);
    }

    .sr-context-word:hover {
      text-decoration: underline;
    }

    @media (prefers-reduced-motion: reduce) {
      .sr-fill {
        transition: none !important;
      }
    }
  `;

  // SVG paths of the button icons (24 × 24, filled).
  const ICONS = Object.freeze({
    back: 'M11 6v12l-8.5-6zM21 6v12l-8.5-6z',
    forward: 'M13 6v12l8.5-6zM3 6v12l8.5-6z',
    play: 'M7 5v14l12-7z',
    pause: 'M6 5h4v14H6zM14 5h4v14h-4z',
    close: 'M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 ' +
        '6.4 19 5 17.6 10.6 12 5 6.4z',
  });

  const FONT = '16px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, ' +
      'sans-serif';

  // Events in the reader that do not reach the page's listeners. Key events
  // are stopped earlier, by onWindowKey.
  const CONTAINED_EVENTS = ['auxclick', 'click', 'contextmenu', 'dblclick',
    'input', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchend',
    'touchmove', 'touchstart', 'wheel'];

  /**
   * Sets inline styles.
   * @param {!Element} element
   * @param {!Object<string, string>} styles CSS property names and values.
   * @param {string=} priority 'important' to win over the page's style
   *     sheets.
   */
  function setStyles(element, styles, priority = '') {
    const style = /** @type {!HTMLElement} */ (element).style;
    for (const [name, value] of Object.entries(styles)) {
      style.setProperty(name, value, priority);
    }
  }

  /**
   * Creates an element with inline styles.
   * @param {string} tag
   * @param {!Object<string, string>=} styles
   * @param {string=} className
   * @return {!HTMLElement}
   */
  function createElement(tag, styles = {}, className = '') {
    const element = document.createElement(tag);
    if (className) element.className = className;
    setStyles(element, styles);
    return element;
  }

  /**
   * Adds the style sheet to the shadow root: a constructed one, or a style
   * element if adopting fails.
   * @param {!ShadowRoot} shadow
   */
  function applyReaderStyles(shadow) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(READER_STYLES);
      shadow.adoptedStyleSheets = [sheet];
      if (shadow.adoptedStyleSheets.length) return;
    } catch {
      // Fall back to a style element below.
    }
    const style = document.createElement('style');
    style.textContent = READER_STYLES;
    shadow.append(style);
  }

  /**
   * Creates an SVG icon.
   * @param {string} path
   * @return {{icon: !SVGSVGElement, shape: !SVGPathElement}}
   */
  function createIcon(path) {
    const svgNs = 'http://www.w3.org/2000/svg';
    const icon = /** @type {!SVGSVGElement} */ (
      document.createElementNS(svgNs, 'svg'));
    // Presentation attributes, like inline styles, need no style sheet.
    const attributes = {
      'aria-hidden': 'true',
      'fill': 'currentColor',
      'height': '20',
      'viewBox': '0 0 24 24',
      'width': '20',
    };
    for (const [name, value] of Object.entries(attributes)) {
      icon.setAttribute(name, value);
    }
    setStyles(icon, {'flex': 'none'});
    const shape = /** @type {!SVGPathElement} */ (
      document.createElementNS(svgNs, 'path'));
    shape.setAttribute('d', path);
    icon.append(shape);
    return {icon, shape};
  }

  /**
   * Builds the reader interface: a backdrop over the whole window with the
   * reader panel in its middle.
   * @return {!Ui}
   */
  function buildUi() {
    /**
     * @type {!Array<{element: !Element,
     *     styles: !Object<string, !ThemeKey>}>}
     */
    const themed = [];
    /**
     * @param {!Element} element
     * @param {!Object<string, !ThemeKey>} styles Theme keys by CSS property.
     * @return {!Element}
     */
    const theme = (element, styles) => {
      themed.push({element, styles});
      return element;
    };

    // The backdrop scrolls if the panel is taller than the window, without
    // passing the scrolling on to the page.
    const backdrop = createElement('div', {
      'box-sizing': 'border-box',
      'display': 'flex',
      'height': '100%',
      'overflow': 'auto',
      'overscroll-behavior': 'contain',
      'padding': '16px',
      'width': '100%',
    }, 'sr-backdrop');
    theme(backdrop, {'background': 'backdrop'});

    // A margin of auto centers the panel and, unlike centering by the flex
    // container, keeps its top reachable when it is taller than the window.
    const panel = createElement('div', {
      'border-radius': '12px',
      'box-shadow': '0 8px 32px rgba(0, 0, 0, .3)',
      'box-sizing': 'border-box',
      'display': 'flex',
      'flex-direction': 'column',
      'font': FONT,
      'gap': '12px',
      'margin': 'auto',
      'max-width': `${CONFIG.panel.maxWidth}px`,
      'min-height': `min(${CONFIG.panel.minHeight}px, 100%)`,
      'outline': 'none',
      'padding': '8px 16px max(16px, env(safe-area-inset-bottom))',
      'width': '100%',
    }, 'sr-panel');
    panel.tabIndex = -1;
    theme(panel, {'background': 'background', 'color': 'text'});

    const header = createElement('div', {
      'align-items': 'center',
      'display': 'flex',
      'gap': '8px',
    });
    const heading = createElement('h1', {
      'flex': '1 1 auto',
      'font-size': '14px',
      'font-weight': '500',
      'margin': '0 0 0 44px',
      'min-width': '0',
      'overflow': 'hidden',
      'text-align': 'center',
      'text-overflow': 'ellipsis',
      'white-space': 'nowrap',
    }, 'sr-heading');
    theme(heading, {'color': 'muted'});
    const close = /** @type {!HTMLButtonElement} */ (createElement('button', {
      '-webkit-tap-highlight-color': 'transparent',
      'align-items': 'center',
      'background': 'transparent',
      'border': '0',
      'border-radius': '22px',
      'cursor': 'pointer',
      'display': 'inline-flex',
      'flex': 'none',
      'height': '44px',
      'justify-content': 'center',
      'margin': '0',
      'padding': '0',
      'width': '44px',
    }, 'sr-button sr-close'));
    close.type = 'button';
    close.title = 'Close (Esc)';
    close.setAttribute('aria-label', 'Close');
    close.append(createIcon(ICONS.close).icon);
    close.addEventListener('mousedown', (event) => event.preventDefault());
    theme(close, {'color': 'muted'});
    header.append(heading, close);

    const stage = createElement('div', {
      '-webkit-tap-highlight-color': 'transparent',
      'cursor': 'pointer',
      'flex': '1 1 auto',
      'min-height': '160px',
      'overflow': 'hidden',
      'position': 'relative',
      'touch-action': 'manipulation',
      'user-select': 'none',
    }, 'sr-stage');

    const guide = createElement('div', {
      'border-style': 'solid',
      'border-width': '1px 0',
      'box-sizing': 'border-box',
      'left': '0',
      'pointer-events': 'none',
      'position': 'absolute',
      'right': '0',
      'top': '50%',
      'transform': 'translateY(-50%)',
    });
    theme(guide, {'border-color': 'line'});
    for (const edge of ['top', 'bottom']) {
      const tick = createElement('div', {
        [edge]: '0',
        'height': '10px',
        'left': `${CONFIG.pivotShare * 100}%`,
        'position': 'absolute',
        'transform': 'translateX(-1px)',
        'width': '2px',
      });
      theme(tick, {'background': 'muted'});
      guide.append(tick);
    }

    const word = createElement('div', {
      'font-weight': '500',
      'left': '0',
      'line-height': '1.2',
      'position': 'absolute',
      'top': '50%',
      'transform': 'translateY(-50%)',
      'white-space': 'pre',
    }, 'sr-word');
    const before = createElement('span', {}, 'sr-before');
    const pivot = createElement('span', {}, 'sr-pivot');
    theme(pivot, {'color': 'pivot'});
    const after = createElement('span', {}, 'sr-after');
    word.append(before, pivot, after);

    const message = createElement('p', {
      'align-items': 'center',
      'box-sizing': 'border-box',
      'display': 'none',
      'font-size': '18px',
      'inset': '0',
      'justify-content': 'center',
      'margin': '0',
      'padding': '16px',
      'position': 'absolute',
      'text-align': 'center',
    }, 'sr-message');
    stage.append(guide, word, message);

    // While paused: the current sentence, whose words can be clicked to go
    // to them. Three lines high; a line height of 1.6 makes each word a
    // target of at least 24 px for a finger.
    const context = createElement('p', {
      'font-size': '16px',
      'height': '4.8em',
      'line-height': '1.6',
      'margin': '0',
      'overflow-y': 'auto',
      'position': 'relative',
      'text-align': 'center',
    }, 'sr-context');
    context.setAttribute('role', 'group');
    context.setAttribute('aria-label', 'Current sentence');
    theme(context, {'color': 'muted'});

    const track = createElement('div', {
      'border-radius': '3px',
      'height': '6px',
      'overflow': 'hidden',
    });
    theme(track, {'background': 'line'});
    const fill = createElement('div', {
      'height': '100%',
      'transition': 'width 120ms linear',
      'width': '0',
    }, 'sr-fill');
    theme(fill, {'background': 'fill'});
    track.append(fill);

    const status = createElement('div', {
      'display': 'flex',
      'font-size': '14px',
      'font-variant-numeric': 'tabular-nums',
      'gap': '12px',
      'justify-content': 'space-between',
    });
    theme(status, {'color': 'muted'});
    const position = createElement('span', {}, 'sr-position');
    const remaining = createElement('span', {}, 'sr-remaining');
    status.append(position, remaining);

    /** @type {!Array<!HTMLElement>} */
    const labels = [];
    /**
     * @param {string} label
     * @param {string} path
     * @param {string} className
     * @param {boolean} primary
     * @return {{button: !HTMLButtonElement, shape: !SVGPathElement,
     *     text: !HTMLElement}}
     */
    const createButton = (label, path, className, primary) => {
      const button = /** @type {!HTMLButtonElement} */ (createElement(
          'button', {
            '-webkit-tap-highlight-color': 'transparent',
            'align-items': 'center',
            'border': '1px solid',
            'border-radius': '24px',
            'box-sizing': 'border-box',
            'cursor': 'pointer',
            'display': 'inline-flex',
            'font': 'inherit',
            'gap': '8px',
            'justify-content': 'center',
            'margin': '0',
            'min-height': '48px',
            'min-width': primary ? '120px' : '48px',
            'padding': '0 16px',
            'touch-action': 'manipulation',
          }, `sr-button ${className}`));
      button.type = 'button';
      theme(button, {
        'background': primary ? 'text' : 'surface',
        'border-color': primary ? 'text' : 'border',
        'color': primary ? 'background' : 'text',
      });
      const {icon, shape} = createIcon(path);
      const text = createElement('span');
      text.textContent = label;
      labels.push(text);
      button.append(icon, text);
      // A click keeps the focus where it is, so that Space keeps toggling
      // playback instead of pressing the clicked button again.
      button.addEventListener('mousedown', (event) => event.preventDefault());
      return {button, shape, text};
    };
    const controls = createElement('div', {
      'display': 'flex',
      'gap': '12px',
      'justify-content': 'center',
    });
    const back = createButton('Back', ICONS.back, 'sr-back', false);
    const play = createButton('Play', ICONS.play, 'sr-play', true);
    const forward = createButton('Forward', ICONS.forward, 'sr-forward',
        false);
    controls.append(back.button, play.button, forward.button);

    const settings = createElement('div', {
      'display': 'flex',
      'flex-wrap': 'wrap',
      'gap': '4px 24px',
      'justify-content': 'center',
    });
    /**
     * @param {string} label
     * @param {!SettingName} name
     * @param {string} type 'range' or 'number'.
     * @return {{input: !HTMLInputElement, value: !HTMLElement}}
     */
    const createSetting = (label, name, type) => {
      const range = CONFIG.settings[name];
      const field = createElement('label', {
        'align-items': 'center',
        'display': 'flex',
        'flex': type === 'range' ? '1 1 240px' : '0 1 auto',
        'font-size': '14px',
        'gap': '10px',
        'max-width': '340px',
        'min-height': '44px',
      });
      const caption = createElement('span', {'min-width': '3em'});
      caption.textContent = label;
      theme(caption, {'color': 'muted'});
      const input = /** @type {!HTMLInputElement} */ (createElement(
          'input', type === 'range' ?
              {
                'flex': '1 1 auto',
                'height': '44px',
                'margin': '0',
                'min-width': '80px',
              } :
              {
                'border': '1px solid',
                'border-radius': '8px',
                'box-sizing': 'border-box',
                'font': 'inherit',
                'font-size': '16px',
                'height': '44px',
                'padding': '0 8px',
                'width': '4.5em',
              }, `sr-input sr-${name}`));
      input.type = type;
      input.min = String(range.min);
      input.max = String(range.max);
      input.step = String(range.step);
      theme(input, type === 'range' ?
          {'accent-color': 'fill'} :
          {'background': 'surface', 'border-color': 'border', 'color': 'text'});
      const value = createElement('span', {
        'font-variant-numeric': 'tabular-nums',
        'min-width': '4.5em',
      }, `sr-${name}-value`);
      field.append(caption, input, value);
      settings.append(field);
      return {input, value};
    };
    const wpm = createSetting('Speed', 'wpm', 'range');
    const fontSize = createSetting('Size', 'fontSize', 'range');
    const skip = createSetting('Skip', 'skip', 'number');
    skip.value.textContent = 'words';

    panel.append(header, stage, context, track, status, controls, settings);
    backdrop.append(panel);

    return {
      backdrop,
      panel,
      heading,
      close,
      stage,
      guide,
      word,
      before,
      pivot,
      after,
      message,
      context,
      fill,
      position,
      remaining,
      back: back.button,
      play: play.button,
      playIcon: play.shape,
      playLabel: play.text,
      forward: forward.button,
      labels,
      wpm: wpm.input,
      wpmValue: wpm.value,
      fontSize: fontSize.input,
      fontSizeValue: fontSize.value,
      skip: skip.input,
      themed,
    };
  }

  /**
   * @param {!Reader} reader
   * @return {!Readonly<!Record<!ThemeKey, string>>} The light or dark colors.
   */
  function colorsOf(reader) {
    return reader.darkQuery.matches ? THEMES.dark : THEMES.light;
  }

  /**
   * Applies the light or dark colors.
   * @param {!Reader} reader
   */
  function applyTheme(reader) {
    reader.ui.backdrop.style.setProperty('color-scheme',
        reader.darkQuery.matches ? 'dark' : 'light');
    const colors = colorsOf(reader);
    for (const {element, styles} of reader.ui.themed) {
      for (const [name, key] of Object.entries(styles)) {
        /** @type {!HTMLElement} */ (element).style.setProperty(
            name, colors[key]);
      }
    }
  }

  /**
   * Fits the panel to the window: it fills a narrow window, and the buttons
   * show their labels only if the window is wide enough.
   * @param {!Reader} reader
   */
  function applyWidth(reader) {
    const {ui} = reader;
    const width = window.innerWidth;
    const full = width < CONFIG.fullScreenWidth;
    setStyles(ui.backdrop, {'padding': full ? '0' : '16px'});
    setStyles(ui.panel, {
      'border-radius': full ? '0' : '12px',
      'min-height': full ? '100%' : `min(${CONFIG.panel.minHeight}px, 100%)`,
    });
    const compact = width < CONFIG.compactWidth;
    for (const label of ui.labels) {
      label.style.setProperty('display', compact ? 'none' : 'inline');
    }
  }

  // ===========================================================================
  // Reader overlay: rendering
  // ===========================================================================

  /**
   * Shows the current piece, aligned at its fixation letter.
   * @param {!Reader} reader
   */
  function renderWord(reader) {
    const {ui, text} = reader;
    const piece = text.pieces[reader.index];
    if (!piece) {
      ui.before.textContent = '';
      ui.pivot.textContent = '';
      ui.after.textContent = '';
      return;
    }
    const size = state.settings.fontSize;
    const chars = graphemes(piece.text);
    const pivot = pivotIndex(piece.text);
    ui.before.textContent = chars.slice(0, pivot).join('');
    ui.pivot.textContent = chars[pivot] || '';
    ui.after.textContent = chars.slice(pivot + 1).join('');
    ui.word.style.setProperty('font-size', `${size}px`);
    const stageWidth = ui.stage.clientWidth;
    if (!stageWidth) return;
    const {scale, left} = fitWord({
      before: ui.before.getBoundingClientRect().width,
      pivot: ui.pivot.getBoundingClientRect().width,
      after: ui.after.getBoundingClientRect().width,
    }, stageWidth);
    if (scale < 1) {
      ui.word.style.setProperty('font-size', `${size * scale}px`);
    }
    ui.word.style.setProperty('left', `${left}px`);
  }

  /**
   * Shows the current sentence below the word while paused, with the
   * current word marked. Each word can be clicked to go to it.
   * @param {!Reader} reader
   */
  function renderContext(reader) {
    const {ui, text} = reader;
    const piece = text.pieces[reader.index];
    const focused = ui.context.contains(reader.shadow.activeElement);
    const hidden = reader.playing || !piece;
    ui.context.style.setProperty('visibility', hidden ? 'hidden' : 'visible');
    if (hidden) {
      // A hidden word cannot keep the focus.
      if (focused) ui.panel.focus({preventScroll: true});
      return;
    }
    const sentence = text.sentences[text.words[piece.word].sentence];
    /** @type {!Array<!Node|string>} */
    const nodes = [];
    /** @type {?HTMLElement} */
    let mark = null;
    for (let index = sentence.start; index < sentence.end; index++) {
      const current = index === piece.word;
      // Buttons that look like the words of the sentence. Only the current
      // word is in the tab order; the arrow keys move between them.
      const button = createElement('button', {
        'background': 'transparent',
        'border': '0',
        'border-radius': '3px',
        'color': current ? colorsOf(reader).mark : 'inherit',
        'cursor': 'pointer',
        'display': 'inline',
        'font': 'inherit',
        'font-weight': current ? '600' : 'inherit',
        'margin': '0',
        'padding': '0',
      }, current ? 'sr-mark' : 'sr-context-word');
      button.setAttribute('type', 'button');
      button.tabIndex = current ? 0 : -1;
      if (current) button.setAttribute('aria-current', 'true');
      button.dataset['word'] = String(index);
      button.textContent = text.words[index].text;
      if (current) mark = button;
      if (nodes.length) nodes.push(' ');
      nodes.push(button);
    }
    ui.context.replaceChildren(...nodes);
    if (mark) {
      ui.context.scrollTop = Math.max(0, mark.offsetTop -
          (ui.context.clientHeight - mark.offsetHeight) / 2);
      // The focus stays in the sentence when it is drawn again.
      if (focused) mark.focus({preventScroll: true});
    }
  }

  /**
   * Moves the focus between the words of the sentence (wordFocusTarget).
   * @param {!Reader} reader
   * @param {!HTMLElement} word The focused word.
   * @param {string} key
   * @return {boolean} Whether the key moved the focus.
   */
  function moveWordFocus(reader, word, key) {
    const words = [...reader.ui.context.querySelectorAll('[data-word]')];
    const target = words[wordFocusTarget(key, words.indexOf(word),
        words.length)];
    if (!(target instanceof HTMLElement)) return false;
    word.tabIndex = -1;
    target.tabIndex = 0;
    target.focus();
    return true;
  }

  /**
   * Updates the progress bar, the position and the remaining time.
   * @param {!Reader} reader
   */
  function renderProgress(reader) {
    const {ui, text} = reader;
    const piece = text.pieces[reader.index];
    const word = piece ? piece.word : 0;
    const words = text.words.length;
    const done = reader.finished ? words : word;
    ui.fill.style.setProperty('width',
        `${words ? (done / words) * 100 : 0}%`);
    ui.position.textContent = words ? `Word ${word + 1} of ${words}` : '';
    ui.remaining.textContent = words ?
        formatRemaining(reader.finished ?
            0 :
            remainingMs(reader.sums, reader.index, state.settings.wpm)) :
        '';
  }

  /**
   * Updates the Play button and the sentence shown while paused.
   * @param {!Reader} reader
   */
  function renderPlayState(reader) {
    const {ui} = reader;
    const label = reader.playing ? 'Pause' : 'Play';
    ui.playLabel.textContent = label;
    ui.play.setAttribute('aria-label', label);
    ui.play.title = `${label} (Space)`;
    ui.playIcon.setAttribute('d', reader.playing ? ICONS.pause : ICONS.play);
    renderContext(reader);
  }

  /**
   * Updates everything that depends on the position and the playback state.
   * @param {!Reader} reader
   */
  function renderPosition(reader) {
    renderWord(reader);
    renderProgress(reader);
    renderPlayState(reader);
  }

  /**
   * Updates everything that depends on the settings.
   * @param {!Reader} reader
   */
  function renderSettings(reader) {
    const {ui} = reader;
    const settings = state.settings;
    const size = settings.fontSize;
    ui.guide.style.setProperty('height', `${Math.round(size * 1.7)}px`);
    ui.stage.style.setProperty('min-height',
        `${Math.max(160, Math.round(size * 2.6))}px`);
    ui.back.title = `Back ${settings.skip} words (←)`;
    ui.back.setAttribute('aria-label', `Back ${settings.skip} words`);
    ui.forward.title = `Forward ${settings.skip} words (→)`;
    ui.forward.setAttribute('aria-label', `Forward ${settings.skip} words`);
    // Keep a slider the user drags and what the user is typing.
    if (reader.draggedSlider !== ui.wpm) ui.wpm.value = String(settings.wpm);
    ui.wpmValue.textContent = `${settings.wpm} wpm`;
    if (reader.draggedSlider !== ui.fontSize) {
      ui.fontSize.value = String(settings.fontSize);
    }
    ui.fontSizeValue.textContent = `${settings.fontSize} px`;
    if (reader.shadow.activeElement !== ui.skip) {
      ui.skip.value = String(settings.skip);
    }
    renderWord(reader);
    renderProgress(reader);
  }

  /**
   * Updates everything: after new content was loaded.
   * @param {!Reader} reader
   */
  function render(reader) {
    const {ui} = reader;
    const empty = !reader.text.pieces.length;
    ui.message.style.setProperty('display', empty ? 'flex' : 'none');
    ui.message.textContent = empty ?
        'No text found on this page. Close the reader, select the text ' +
            'you want to read, then start Speed Reader again.' :
        '';
    ui.guide.style.setProperty('visibility', empty ? 'hidden' : 'visible');
    for (const button of [ui.back, ui.play, ui.forward]) {
      button.disabled = empty;
      button.style.setProperty('opacity', empty ? '.45' : '1');
      button.style.setProperty('cursor', empty ? 'default' : 'pointer');
    }
    renderSettings(reader);
    renderPlayState(reader);
  }

  // ===========================================================================
  // Playback
  // ===========================================================================

  /** @param {!Reader} reader */
  function clearTimer(reader) {
    if (reader.timer) clearTimeout(reader.timer);
    reader.timer = 0;
  }

  /**
   * @param {!Reader} reader
   * @return {number} Display time of the current piece in ms.
   */
  function currentDuration(reader) {
    return pieceDuration((reader.factors[reader.index] || 1) *
        rampFactor(reader.rampStep), state.settings.wpm);
  }

  /**
   * Schedules the next piece at reader.nextDue. Each piece is due a fixed
   * time after the one before, so delays of single timers do not add up;
   * after a long delay (a throttled timer) the schedule restarts.
   * @param {!Reader} reader
   */
  function schedule(reader) {
    clearTimer(reader);
    if (!reader.playing) return;
    const now = performance.now();
    if (reader.nextDue < now - CONFIG.maxLag) {
      reader.nextDue = now + currentDuration(reader);
    }
    reader.timer = setTimeout(() => advance(reader),
        Math.max(0, reader.nextDue - now));
  }

  /**
   * Shows the next piece, or stops at the end.
   * @param {!Reader} reader
   */
  function advance(reader) {
    reader.timer = 0;
    if (!reader.playing || !reader.dialog.isConnected) return;
    if (reader.index >= reader.text.pieces.length - 1) {
      reader.playing = false;
      reader.finished = true;
      renderProgress(reader);
      renderPlayState(reader);
      savePosition(reader);
      return;
    }
    reader.index++;
    reader.rampStep++;
    reader.nextDue += currentDuration(reader);
    renderWord(reader);
    renderProgress(reader);
    schedule(reader);
  }

  /**
   * Starts playback at the current piece: from the start after the end, a
   * little before the current piece after a pause.
   * @param {!Reader} reader
   */
  function play(reader) {
    if (!reader.text.pieces.length) return;
    if (reader.finished) {
      reader.index = 0;
      reader.finished = false;
    } else if (reader.resumeRewind) {
      reader.index = resumeTarget(reader.text, reader.index,
          CONFIG.maxResumeRewind);
    }
    reader.resumeRewind = false;
    reader.playing = true;
    reader.rampStep = 0;
    reader.nextDue = performance.now() + currentDuration(reader);
    renderPosition(reader);
    schedule(reader);
  }

  /**
   * Stops playback and remembers the position.
   * @param {!Reader} reader
   */
  function pause(reader) {
    if (reader.playing) reader.resumeRewind = true;
    reader.playing = false;
    clearTimer(reader);
    renderPlayState(reader);
    savePosition(reader);
  }

  /** @param {!Reader} reader */
  function togglePlay(reader) {
    if (reader.playing) {
      pause(reader);
    } else {
      play(reader);
    }
  }

  /**
   * Goes to a piece; playback continues there.
   * @param {!Reader} reader
   * @param {number} index
   */
  function moveTo(reader, index) {
    if (!reader.text.pieces.length) return;
    reader.index = index;
    reader.finished = false;
    reader.resumeRewind = false;
    if (reader.playing) {
      reader.rampStep = 0;
      reader.nextDue = performance.now() + currentDuration(reader);
      schedule(reader);
    }
    renderPosition(reader);
  }

  /**
   * Skips words; playback continues at the new place.
   * @param {!Reader} reader
   * @param {number} direction 1 (forward) or -1 (back).
   */
  function skipWords(reader, direction) {
    moveTo(reader, jumpTarget(reader.text, reader.index,
        direction * state.settings.skip));
  }

  /**
   * Changes a setting and shows its effect. While a slider is dragged, the
   * setting is only stored when it is released.
   * @param {!Reader} reader
   * @param {!SettingName} name
   * @param {*} value
   * @param {boolean=} store
   */
  function changeSetting(reader, name, value, store = true) {
    state.settings = {...state.settings, [name]: sanitizeSetting(name, value)};
    if (store) GM_setValue(CONFIG.storageSettings, state.settings);
    renderSettings(reader);
  }

  // ===========================================================================
  // Remembered positions
  // ===========================================================================

  // The script manager's storage outlives private windows, so pages read in
  // one leave no trace there.
  const REMEMBERS_POSITIONS = GM_info.isIncognito !== true;

  /**
   * Reads the stored positions. Invalid entries, and entries of older
   * versions that hold the URL itself, are removed from the storage.
   * @return {!Array<!Position>}
   */
  function loadPositions() {
    if (!REMEMBERS_POSITIONS) return [];
    const stored = GM_getValue(CONFIG.storagePositions, []);
    const positions = sanitizePositions(stored);
    if (!Array.isArray(stored) || stored.length !== positions.length) {
      GM_setValue(CONFIG.storagePositions, positions);
    }
    return positions;
  }

  /**
   * Stores the position in the text of the page, or forgets it at the start
   * and the end of the text. Selected text has no stored position, and
   * nothing is stored in a private window.
   * @param {!Reader} reader
   */
  function savePosition(reader) {
    if (!REMEMBERS_POSITIONS || reader.source !== 'page' ||
        !reader.text.pieces.length) {
      return;
    }
    const word = currentWord(reader);
    if (word === reader.savedWord) return;
    reader.savedWord = word;
    const positions = loadPositions();
    GM_setValue(CONFIG.storagePositions, word ?
        withPosition(positions, {page: reader.page, hash: reader.hash, word}) :
        withoutPosition(positions, reader.page));
  }

  /**
   * @param {!Reader} reader
   * @return {number} The word to remember: the shown one, 0 at the end.
   */
  function currentWord(reader) {
    const piece = reader.text.pieces[reader.index];
    return piece && !reader.finished ? piece.word : 0;
  }

  /** Forgets the positions of all pages (menu command). */
  function forgetPositions() {
    GM_setValue(CONFIG.storagePositions, []);
    // The shown word counts as stored: only reading on stores a position
    // again, not closing or opening the reader.
    const reader = state.reader;
    if (reader) reader.savedWord = currentWord(reader);
  }

  // ===========================================================================
  // Reader overlay: input
  // ===========================================================================

  /**
   * @param {?Element} element The focused element in the reader.
   * @return {!TargetKind} Kind of a focused element for keyAction.
   */
  function targetKind(element) {
    if (element instanceof HTMLButtonElement) {
      return element.dataset['word'] === undefined ? 'button' : 'word';
    }
    if (element instanceof HTMLInputElement) {
      return element.type === 'range' ? 'range' : 'text';
    }
    if (element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement) {
      return 'text';
    }
    return 'other';
  }

  /**
   * Handles a key press in the reader.
   * @param {!Reader} reader
   * @param {!KeyboardEvent} event
   */
  function onReaderKey(reader, event) {
    const focused = reader.shadow.activeElement;
    const kind = targetKind(focused);
    const modified = event.ctrlKey || event.altKey || event.metaKey;
    if (kind === 'word' && !modified && focused instanceof HTMLElement &&
        moveWordFocus(reader, focused, event.key)) {
      event.preventDefault();
      return;
    }
    const action = keyAction(event.key, kind, modified);
    if (!action) return;
    event.preventDefault();
    if (action === 'close') {
      closeReader(reader);
    } else if (action === 'toggle') {
      if (!event.repeat) togglePlay(reader);
    } else if (action === 'back' || action === 'forward') {
      skipWords(reader, action === 'back' ? -1 : 1);
    } else {
      const wpm = sanitizeSetting('wpm', state.settings.wpm +
          (action === 'faster' ? 1 : -1) * CONFIG.wpmKeyStep);
      // A held key at the end of the range stores nothing.
      if (wpm !== state.settings.wpm) changeSetting(reader, 'wpm', wpm);
    }
  }

  /**
   * Key listener on the window in the capture phase, added at
   * document-start, usually before the page's own (see the file overview):
   * while the reader is open, it handles the keys and keeps every key event
   * from the page's later listeners. Default actions (typing, moving a
   * slider, pressing a button) still happen.
   * @param {!KeyboardEvent} event
   */
  function onWindowKey(event) {
    const reader = state.reader;
    const open = !!reader && reader.dialog.isConnected;
    // The release of a key pressed in the reader (Escape, which closed it)
    // belongs to the reader too; a new press does not.
    const held = event.type !== 'keydown' && state.heldKeys.has(event.code);
    if (event.type === 'keyup') state.heldKeys.delete(event.code);
    if (!open && !held) return;
    event.stopImmediatePropagation();
    if (!reader || !open) return;
    if (event.type === 'keydown') {
      if (event.code) state.heldKeys.add(event.code);
      onReaderKey(reader, event);
    }
  }

  /**
   * Handles a click or tap on the word.
   * @param {!Reader} reader
   * @param {!MouseEvent} event
   * @param {string} pointerType Of the press that led to the click.
   */
  function onStageClick(reader, event, pointerType) {
    const box = reader.ui.stage.getBoundingClientRect();
    const share = box.width ? (event.clientX - box.left) / box.width : 0.5;
    const action = stageAction(share, pointerType);
    if (action === 'toggle') {
      togglePlay(reader);
    } else {
      skipWords(reader, action === 'back' ? -1 : 1);
    }
  }

  /**
   * Adds the listeners of the reader. They stay attached while the reader
   * is closed, since it is opened again with the same elements.
   * @param {!Reader} reader
   */
  function attachReaderListeners(reader) {
    const {ui, dialog} = reader;
    ui.close.addEventListener('click', () => closeReader(reader));
    ui.play.addEventListener('click', () => togglePlay(reader));
    ui.back.addEventListener('click', () => skipWords(reader, -1));
    ui.forward.addEventListener('click', () => skipWords(reader, 1));
    let pointerType = '';
    ui.stage.addEventListener('pointerdown', (event) => {
      pointerType = event.pointerType;
    });
    ui.stage.addEventListener('click', (event) => {
      onStageClick(reader, event, pointerType);
      pointerType = '';
    });
    ui.context.addEventListener('click', (event) => {
      const target = event.target instanceof Element ?
          event.target.closest('[data-word]') :
          null;
      const word = reader.text.words[Number(
          target instanceof HTMLElement ? target.dataset['word'] : NaN)];
      if (word) moveTo(reader, word.piece);
    });
    // Like the buttons: a click on a word keeps the focus where it is.
    ui.context.addEventListener('mousedown', (event) => {
      if (event.target instanceof Element &&
          event.target.closest('[data-word]')) {
        event.preventDefault();
      }
    });
    // A click beside the panel closes the reader. A press that starts on
    // the panel (dragging a slider out of it) does not.
    let pressedBeside = false;
    ui.backdrop.addEventListener('pointerdown', (event) => {
      pressedBeside = event.target === ui.backdrop;
    });
    ui.backdrop.addEventListener('click', (event) => {
      if (pressedBeside && event.target === ui.backdrop) closeReader(reader);
    });
    // Sliders store their value when released, not while dragged. A change
    // from another tab does not move a slider while it is dragged.
    for (const name of /** @type {const} */ (['wpm', 'fontSize'])) {
      const input = ui[name];
      input.addEventListener('pointerdown', () => {
        reader.draggedSlider = input;
      });
      input.addEventListener('input',
          () => changeSetting(reader, name, input.value, false));
      input.addEventListener('change', () => {
        reader.draggedSlider = null;
        changeSetting(reader, name, input.value);
      });
    }
    for (const type of ['pointerup', 'pointercancel']) {
      window.addEventListener(type, () => {
        reader.draggedSlider = null;
      }, true);
    }
    ui.skip.addEventListener('input', () => {
      if (ui.skip.value.trim() && ui.skip.checkValidity()) {
        changeSetting(reader, 'skip', ui.skip.value);
      }
    });
    ui.skip.addEventListener('change', () => {
      changeSetting(reader, 'skip', ui.skip.value);
      ui.skip.value = String(state.settings.skip);
    });
    // Escape (and the back gesture on Android) asks the dialog to close.
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeReader(reader);
    });
    // The page closed the dialog (close() or removing its open attribute).
    // This observer, unlike the close event, also runs while the page is
    // hidden. By the time it runs, closeReader may have removed the dialog
    // already, or the reader may be open again.
    new MutationObserver(() => {
      if (!dialog.open) closeReader(reader);
    }).observe(dialog, {attributes: true, attributeFilter: ['open']});
    // Pointer and other events in the reader do not reach the page.
    for (const type of CONTAINED_EVENTS) {
      dialog.addEventListener(type, (event) => event.stopPropagation());
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && reader.playing) {
        pause(reader);
      }
    });
    window.addEventListener('resize', () => {
      if (!reader.dialog.isConnected) return;
      applyWidth(reader);
      renderWord(reader);
    });
    reader.darkQuery.addEventListener('change', () => {
      applyTheme(reader);
      renderContext(reader);
    });
  }

  // ===========================================================================
  // Opening and closing the reader
  // ===========================================================================

  /**
   * Creates the style sheet that hides the ::backdrop of the reader's
   * dialog: the page's style sheets may style it (a blur, a color), and the
   * reader draws its own backdrop. Only a style sheet in the page reaches
   * the pseudo-element.
   * @return {?CSSStyleSheet} null if constructed style sheets fail.
   */
  function createBackdropSheet() {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(
          'dialog[data-speed-reader]::backdrop { display: none !important; }');
      return sheet;
    } catch {
      return null;
    }
  }

  /**
   * Adds the backdrop style sheet to the page or removes it. Where it
   * cannot be adopted (a Firefox content script), the page's styles for
   * ::backdrop stay in effect: they only change the looks.
   * @param {!Reader} reader
   * @param {boolean} adopted
   */
  function adoptBackdropSheet(reader, adopted) {
    const sheet = reader.backdropSheet;
    if (!sheet) return;
    try {
      const others =
          document.adoptedStyleSheets.filter((entry) => entry !== sheet);
      document.adoptedStyleSheets = adopted ? [...others, sheet] : others;
    } catch {
      // The page keeps its own style sheets.
    }
  }

  /**
   * Creates the reader, closed: a dialog that holds the shadow host. Inline
   * styles with priority win over the page's styles for dialogs.
   * @return {!Reader}
   */
  function createReader() {
    const dialog = /** @type {!HTMLDialogElement} */ (
      document.createElement('dialog'));
    setStyles(dialog, {'all': 'initial'}, 'important');
    setStyles(dialog, {
      'display': 'block',
      'height': '100%',
      'inset': '0',
      'max-height': 'none',
      'max-width': 'none',
      'position': 'fixed',
      'width': '100%',
      'z-index': '2147483647',
    }, 'important');
    dialog.setAttribute('aria-label', 'Speed Reader');
    dialog.setAttribute('data-speed-reader', '');
    const host = /** @type {!HTMLElement} */ (
      document.createElement('speed-reader'));
    setStyles(host, {'all': 'initial'}, 'important');
    setStyles(host, {
      'display': 'block',
      'height': '100%',
      'width': '100%',
    }, 'important');
    const shadow = host.attachShadow({mode: 'closed'});
    applyReaderStyles(shadow);
    const ui = buildUi();
    shadow.append(ui.backdrop);
    dialog.append(host);
    /** @type {!Reader} */
    const reader = {
      dialog,
      host,
      shadow,
      ui,
      text: {words: [], pieces: [], sentences: []},
      key: '\u0000',
      source: 'page',
      page: '',
      hash: '',
      savedWord: 0,
      factors: [],
      sums: [0],
      index: 0,
      playing: false,
      finished: false,
      resumeRewind: false,
      rampStep: 0,
      timer: 0,
      nextDue: 0,
      darkQuery: window.matchMedia('(prefers-color-scheme: dark)'),
      viewport: null,
      rootStyles: [],
      backdropSheet: createBackdropSheet(),
      draggedSlider: null,
      focus: null,
    };
    attachReaderListeners(reader);
    return reader;
  }

  /**
   * Puts the reader over the page as a modal dialog: in the top layer, above
   * the page's own dialogs and pop-overs, with the rest of the page inert,
   * so that neither the focus nor clicks get to it. The page does not
   * scroll meanwhile. A page without a viewport meta element gets one:
   * Firefox for Android lays such a page out for a desktop width, which
   * would shrink the reader too. The minimum scale keeps a page that is
   * wider than the screen from widening the area that the reader covers.
   * @param {!Reader} reader
   */
  function openReader(reader) {
    if (reader.dialog.isConnected) return;
    const active = document.activeElement;
    reader.focus = active instanceof HTMLElement ? active : null;
    if (!document.querySelector('meta[name="viewport"]')) {
      const viewport = /** @type {!HTMLMetaElement} */ (
        document.createElement('meta'));
      viewport.name = 'viewport';
      viewport.content =
          'width=device-width, initial-scale=1, minimum-scale=1';
      (document.head || document.documentElement).append(viewport);
      reader.viewport = viewport;
    }
    // Without its scroll bar, the page would get wider behind the reader:
    // a stable gutter keeps its place (only if there is one, as with
    // classic scroll bars).
    const root = document.documentElement;
    const hasScrollBar = window.innerWidth > root.clientWidth;
    reader.rootStyles = ['overflow', 'scrollbar-gutter'].map((name) => ({
      name,
      value: root.style.getPropertyValue(name),
      priority: root.style.getPropertyPriority(name),
    }));
    root.style.setProperty('overflow', 'hidden', 'important');
    if (hasScrollBar) {
      root.style.setProperty('scrollbar-gutter', 'stable', 'important');
    }
    adoptBackdropSheet(reader, true);
    root.append(reader.dialog);
    try {
      reader.dialog.showModal();
    } catch {
      // Only if the page interferes with the dialog: show it on top of the
      // page without making the page inert.
      reader.dialog.setAttribute('open', '');
    }
    applyTheme(reader);
    applyWidth(reader);
  }

  /**
   * Removes the reader from the page, paused, and gives the page its focus
   * and scrolling back.
   * @param {!Reader} reader
   */
  function closeReader(reader) {
    const {dialog} = reader;
    if (!dialog.isConnected) return;
    pause(reader);
    if (dialog.open) dialog.close();
    dialog.remove();
    const rootStyle = document.documentElement.style;
    for (const {name, value, priority} of reader.rootStyles) {
      if (value) {
        rootStyle.setProperty(name, value, priority);
      } else {
        rootStyle.removeProperty(name);
      }
    }
    reader.rootStyles = [];
    adoptBackdropSheet(reader, false);
    reader.viewport?.remove();
    reader.viewport = null;
    reader.focus?.focus({preventScroll: true});
    reader.focus = null;
  }

  /**
   * Shows new content in the reader, paused at its first word or at the
   * position remembered for the page. The same text keeps its position.
   * @param {!Reader} reader
   * @param {!Content} content
   */
  function loadContent(reader, content) {
    const key = content.paragraphs.map((paragraph) => paragraph.text)
        .join('\n');
    reader.ui.heading.textContent = content.title;
    // Stops playback and stores the position in the previous text.
    pause(reader);
    if (key === reader.key) {
      render(reader);
      return;
    }
    reader.text = tokenize(content.paragraphs);
    reader.key = key;
    reader.source = content.source;
    reader.page = pageKey(location.href);
    reader.hash = hashText(key);
    reader.factors = pieceFactors(reader.text);
    reader.sums = suffixSums(reader.factors);
    reader.finished = false;
    reader.resumeRewind = false;
    const word = content.source === 'page' ?
        rememberedWord(loadPositions(), reader.page, reader.hash) :
        0;
    const remembered = reader.text.words[word];
    reader.index = remembered ? remembered.piece : 0;
    reader.savedWord = remembered ? word : 0;
    render(reader);
  }

  /**
   * Shows content in the reader, opening it if needed.
   * @param {!Content} content
   */
  function showReader(content) {
    state.settings = sanitizeSettings(
        GM_getValue(CONFIG.storageSettings, null));
    if (!state.reader) state.reader = createReader();
    const reader = state.reader;
    openReader(reader);
    loadContent(reader, content);
    reader.ui.panel.focus({preventScroll: true});
    // The layout may still change after this script ran (scroll bars).
    requestAnimationFrame(() => {
      if (!reader.dialog.isConnected) return;
      applyWidth(reader);
      renderWord(reader);
    });
  }

  // ===========================================================================
  // Menu command and startup
  // ===========================================================================

  for (const type of ['keydown', 'keyup', 'keypress']) {
    window.addEventListener(type,
        (event) => onWindowKey(/** @type {!KeyboardEvent} */ (event)), true);
  }
  // Keys released in another window send no keyup here.
  window.addEventListener('blur', () => state.heldKeys.clear());

  // Settings changed in another tab apply here too.
  GM_addValueChangeListener(CONFIG.storageSettings,
      (name, oldValue, value, remote) => {
        if (!remote) return;
        state.settings = sanitizeSettings(value);
        const reader = state.reader;
        if (reader && reader.dialog.isConnected) renderSettings(reader);
      });

  // While the reader is open, the page is inert: nothing new can be
  // selected, and the old selection reads as empty. The command then only
  // gives the reader the focus again.
  GM_registerMenuCommand('Speed Reader: Read this page', () => {
    const reader = state.reader;
    if (reader && reader.dialog.isConnected) {
      reader.ui.panel.focus({preventScroll: true});
    } else {
      showReader(extractContent());
    }
  }, {id: 'read', autoClose: true});
  GM_registerMenuCommand('Speed Reader: Forget reading positions',
      forgetPositions, {
        id: 'forget',
        title: 'Forget where you stopped reading in all pages',
        autoClose: true,
      });
})();
