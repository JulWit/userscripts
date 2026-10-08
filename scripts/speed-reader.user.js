// ==UserScript==
// @name         Speed Reader
// @namespace    https://github.com/JulWit/userscripts
// @version      1.0.0
// @description  Shows the text of a page (or the selected text) word by word in a reader window (RSVP), with adjustable speed and font size
// @author       Julian
// @homepageURL  https://github.com/JulWit/userscripts
// @supportURL   https://github.com/JulWit/userscripts/issues
// @icon         data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTQiIGZpbGw9IiMyYjJmMzYiLz48ZyBmaWxsPSIjOWFhM2FkIj48cmVjdCB4PSI4IiB5PSIxNyIgd2lkdGg9IjQ4IiBoZWlnaHQ9IjIiIHJ4PSIxIiBvcGFjaXR5PSIuNiIvPjxyZWN0IHg9IjgiIHk9IjQ1IiB3aWR0aD0iNDgiIGhlaWdodD0iMiIgcng9IjEiIG9wYWNpdHk9Ii42Ii8+PHJlY3QgeD0iMjYiIHk9IjExIiB3aWR0aD0iMyIgaGVpZ2h0PSI4IiByeD0iMS41Ii8+PHJlY3QgeD0iMjYiIHk9IjQ1IiB3aWR0aD0iMyIgaGVpZ2h0PSI4IiByeD0iMS41Ii8+PHJlY3QgeD0iMTAiIHk9IjI3IiB3aWR0aD0iMTIiIGhlaWdodD0iMTAiIHJ4PSIzIi8+PHJlY3QgeD0iMzMiIHk9IjI3IiB3aWR0aD0iMjEiIGhlaWdodD0iMTAiIHJ4PSIzIi8+PC9nPjxyZWN0IHg9IjIzLjUiIHk9IjI1IiB3aWR0aD0iOCIgaGVpZ2h0PSIxNCIgcng9IjMiIGZpbGw9IiNmZjVhNDUiLz48L3N2Zz4K
// @updateURL    https://raw.githubusercontent.com/JulWit/userscripts/main/scripts/speed-reader.user.js
// @downloadURL  https://raw.githubusercontent.com/JulWit/userscripts/main/scripts/speed-reader.user.js
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// ==/UserScript==
// @ts-check

/**
 * @fileoverview Speed reader (Rapid Serial Visual Presentation): shows the
 * main text of a page, or the selected text, one word at a time at the same
 * place in a window of its own, so the eyes do not have to move. Each word
 * is aligned at its fixation letter (optimal recognition point), which is
 * highlighted and stays at the same horizontal position. Words are shown
 * longer after punctuation, at the end of paragraphs and after headings.
 * The script registers a menu command and does nothing else until it is
 * used. The reader window is built by this script in an empty document and
 * driven from the page that opened it, so it closes with that page.
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
   * A word of the text. pause is the kind of pause after it ('' for none,
   * 'clause', 'sentence', 'paragraph' or 'heading'), sentence the index of
   * its sentence and piece the index of its first piece.
   * @typedef {{text: string, pause: string, sentence: number,
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

  /** @typedef {{min: number, max: number, step: number,
   *     fallback: number}} Range */

  /**
   * Rendered widths of the parts of a word (before the fixation letter, the
   * letter itself, after it) at the configured font size.
   * @typedef {{before: number, pivot: number, after: number}} WordWidths
   */

  /**
   * Paragraph below a candidate container; depth 0 is a direct child.
   * @typedef {{textLength: number, commaCount: number,
   *     depth: number}} ParagraphFeatures
   */

  /**
   * Input of the Readability-like container score. name holds the element's
   * ID and classes.
   * @typedef {{tagName: string, name: string,
   *     paragraphs: !Array<!ParagraphFeatures>,
   *     linkDensity: number}} ContainerFeatures
   */

  /**
   * Scored container; parent is the index of the nearest candidate ancestor
   * or -1.
   * @typedef {{score: number, parent: number}} ScoredCandidate
   */

  /**
   * Semantic container (article, main); textLength counts paragraph text.
   * @typedef {{textLength: number, parent: number}} SemanticCandidate
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
    // Words with more characters are split, at hyphens and slashes first,
    // then into pieces of equal length with a hyphen. A cut may move up to
    // cutWindow characters to fall between a vowel and a consonant.
    split: {maxLength: 20, cutWindow: 2},
    // Fixation letter: the first letter of a word of length 1, the second
    // up to length 5, the third up to 9, the fourth up to 13, the fifth
    // beyond.
    pivotSteps: [1, 5, 9, 13],
    // Horizontal position of the fixation letter as a share of the stage
    // width, and the space kept free at the stage edges in px.
    pivotShare: 0.35,
    stagePadding: 12,
    // Words are never shrunk below this share of the font size.
    minScale: 0.2,
    // A timer that fires later than this (in ms, e.g. while the window was
    // throttled) restarts the schedule instead of catching up.
    maxLag: 1000,
    // Below this window width the buttons show icons only.
    compactWidth: 420,
    window: {width: 760, height: 540},
    storageSettings: 'settings',

    // Content detection, as in the Reading Ruler.
    // Elements that hold paragraphs of text.
    blockTags: ['p', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'dt', 'dd'],
    headingTags: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    // Elements that may hold body text without paragraphs. For the content
    // detection they count as paragraphs only if they break their text with
    // <br>: table cells and divs of web apps hold text too, but not prose.
    // If they also contain blocks, each run of their own text between those
    // blocks counts as a paragraph.
    textContainerTags: ['div', 'section', 'td', 'figcaption'],
    // Text outside every block tag belongs to its nearest ancestor with one
    // of these computed display values.
    blockDisplays: ['block', 'flow-root', 'list-item', 'table-cell',
      'table-caption'],
    // Subtrees without body text. A header is only skipped outside an
    // article: inside, it holds the article's title. Code blocks (pre) are
    // not read either.
    excludedTags: ['nav', 'aside', 'footer', 'button', 'select', 'textarea',
      'input', 'label', 'option', 'script', 'style', 'noscript', 'template',
      'svg', 'math', 'canvas', 'video', 'audio', 'iframe', 'object', 'embed',
      'pre'],
    excludedRoles: ['navigation', 'complementary', 'banner', 'contentinfo',
      'menu', 'menubar', 'search'],
    // Words in class names or IDs of non-content elements. A word matches if
    // it starts or ends with one of them ("navbar", "subnav", "comments").
    negativeNames: ['sidebar', 'menu', 'nav', 'comment', 'footer', 'promo',
      'related', 'share'],
    // Advertisement words, only as whole words: "ad" is part of "header".
    adNames: ['ad', 'ads', 'adbox', 'adslot', 'adunit', 'adsense', 'advert',
      'adverts', 'advertisement', 'advertising', 'sponsor', 'sponsored'],
    // Words that keep an element despite a negative word, e.g. the wrapper
    // "content-with-sidebar". Not "main": "main-menu" is a menu.
    keepNames: ['article', 'body', 'content'],
    // Words that raise a container's score (Readability).
    positiveNames: ['article', 'blog', 'body', 'content', 'entry', 'main',
      'page', 'post', 'story', 'text'],
    // Blocks with a larger share of link text are skipped (except headings).
    maxLinkDensity: 0.5,
    // Readability-like scoring of content containers: paragraphs shorter than
    // minParagraphLength are ignored, scores are passed up maxDepth levels.
    // The parent of the best container wins if it scores at least
    // parentRatio of the best score, or if a sibling scores siblingRatio.
    // The winner needs minText characters of paragraph text.
    scoring: {
      minParagraphLength: 25,
      maxDepth: 5,
      parentRatio: 0.75,
      siblingRatio: 0.2,
      minText: 500,
    },
    // An article or main element needs this much paragraph text. A nested
    // one is preferred if it holds semanticDominance of the outer's text.
    minSemanticText: 250,
    semanticDominance: 0.7,
    // Fixed or sticky elements narrower or lower than this share of the
    // viewport are widgets (headers, sidebars); larger ones are layout shells
    // that contain the whole page.
    widgetShare: 0.6,
  });

  // ===========================================================================
  // Pure functions: text, timing, settings (no DOM, no storage)
  // ===========================================================================

  // Soft hyphens and zero-width characters that sites insert for line
  // breaking. Zero-width joiners stay: they form emoji and ligatures.
  const INVISIBLE_PATTERN = /[­​⁠﻿]/g;
  // Footnote markers such as [1], [2–4], [a] or [note 3].
  const FOOTNOTE_MARKER = String.raw`\d{1,3}(?:\s*[,–-]\s*\d{1,3})*|[a-z]|` +
      String.raw`(?:note|nb|fn)\.?\s*\d{1,3}`;
  const FOOTNOTE_PATTERN =
      new RegExp(String.raw`\s*\[(?:${FOOTNOTE_MARKER})\]`, 'gi');
  const FOOTNOTE_TEXT_PATTERN =
      new RegExp(String.raw`^\[?(?:${FOOTNOTE_MARKER})\]?$`, 'i');
  const LETTER_PATTERN = /[\p{L}\p{N}]/u;
  const VOWEL_PATTERN = /[aeiouyäöüàáâèéêëìíîïòóôùúûæøå]/iu;

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
   * Removes footnote markers such as "[1]" from a text.
   * @param {string} text
   * @return {string}
   */
  function stripFootnoteMarkers(text) {
    return text.replace(FOOTNOTE_PATTERN, '');
  }

  /**
   * Whether the text of an element is a footnote marker ("[1]", "2", "a").
   * @param {string} text
   * @return {boolean}
   */
  function isFootnoteText(text) {
    return FOOTNOTE_TEXT_PATTERN.test(text.trim());
  }

  /**
   * Prepares the text of a paragraph for reading: removes soft hyphens,
   * zero-width characters and footnote markers and collapses white space.
   * @param {string} text
   * @return {string}
   */
  function cleanText(text) {
    return stripFootnoteMarkers(text.replace(INVISIBLE_PATTERN, ''))
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
   * The pause after a word inside a paragraph, from its punctuation.
   * Closing quotes and brackets are ignored. Abbreviations such as "z.B."
   * and ordinal numbers such as "3." do not end a sentence.
   * @param {string} word
   * @return {string} '', 'clause' or 'sentence'.
   */
  function pauseAfter(word) {
    const text = word.replace(/["'“”‘’»«›‹)\]}]+$/u, '');
    if (/[.!?…]$/.test(text)) {
      return /^(?:\p{L}\.){2,}$/u.test(text) || /^\d{1,2}\.$/.test(text) ?
          '' :
          'sentence';
    }
    return /(?:[,;:]|\s[-–—]|[–—])$/.test(text) ? 'clause' : '';
  }

  /**
   * Cuts a run of characters without break opportunities into pieces of
   * about equal length, each but the last ending with a hyphen. Cuts move
   * by up to CONFIG.split.cutWindow characters to fall between a vowel and
   * a consonant, which often matches a syllable boundary.
   * @param {!Array<string>} chars
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
   * into pieces of at most CONFIG.split.maxLength characters: at hyphens,
   * dashes, slashes and underscores, which stay at the end of a piece, and
   * where there are none, into chunks with a hyphen.
   * @param {string} word
   * @return {!Array<string>} The word itself if it is short enough.
   */
  function splitLongWord(word) {
    const {maxLength} = CONFIG.split;
    if (Array.from(word).length <= maxLength) return [word];
    const segments = word.match(/[^-–/_]*(?:[-–/_]+|$)/gu) || [word];
    /** @type {!Array<string>} */
    const merged = [];
    for (const segment of segments) {
      if (!segment) continue;
      const last = merged.length - 1;
      if (last >= 0 &&
          Array.from(merged[last] + segment).length <= maxLength) {
        merged[last] += segment;
      } else {
        merged.push(segment);
      }
    }
    return merged.flatMap((part) => {
      const chars = Array.from(part);
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
        let pause = pauseAfter(text);
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
   * Index of the fixation letter of a word (in code points): see
   * CONFIG.pivotSteps. Leading and trailing punctuation does not count
   * towards the length, and the letter is never a leading quote.
   * @param {string} text
   * @return {number}
   */
  function pivotIndex(text) {
    const chars = Array.from(text);
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
        const factors = /** @type {!Object<string, number>} */ (delay);
        if (pause) factor *= factors[pause];
      }
      return factor;
    });
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
   * Validates a setting: numbers are clamped to the range and rounded to its
   * step, anything else becomes the default.
   * @param {string} name Key of CONFIG.settings.
   * @param {*} value
   * @return {number}
   */
  function sanitizeSetting(name, value) {
    const range = /** @type {!Object<string, !Range>} */ (
      CONFIG.settings)[name];
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

  /**
   * The reader action of a key press. Keys that the focused control uses
   * itself keep their normal behavior: Space and Enter press a button, the
   * arrow keys move a slider, and text fields take every key.
   * @param {string} key KeyboardEvent.key.
   * @param {string} target Kind of the focused element: 'button', 'range',
   *     'text' or 'other'.
   * @param {boolean} modified Whether Ctrl, Alt or Meta is held.
   * @return {string} 'toggle', 'back', 'forward', 'faster', 'slower' or ''.
   */
  function keyAction(key, target, modified) {
    if (modified || target === 'text') return '';
    const actions = /** @type {!Object<string, string>} */ ({
      ' ': 'toggle',
      'ArrowLeft': 'back',
      'ArrowRight': 'forward',
      'ArrowUp': 'faster',
      'ArrowDown': 'slower',
    });
    const action = actions[key] || '';
    if (target === 'button' && action === 'toggle') return '';
    if (target === 'range' && action && action !== 'toggle') return '';
    return action;
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
  // Pure functions: content scoring (from the Reading Ruler)
  // ===========================================================================

  /**
   * Splits the ID and class names of an element into lower-case words: the
   * parts between punctuation ("article-body" → "article", "body"), and their
   * camel-case parts ("sideBar" → "sidebar", "side", "bar").
   * @param {string} name
   * @return {!Array<string>}
   */
  function nameTokens(name) {
    const tokens = new Set();
    for (const chunk of name.split(/[^A-Za-z0-9]+/)) {
      if (!chunk) continue;
      tokens.add(chunk.toLowerCase());
      for (const part of chunk.split(/(?<=[a-z0-9])(?=[A-Z])/)) {
        tokens.add(part.toLowerCase());
      }
    }
    return [...tokens];
  }

  /**
   * @param {!Array<string>} tokens
   * @param {!ReadonlyArray<string>} words
   * @return {boolean} Whether a token starts or ends with one of the words.
   */
  function hasAffix(tokens, words) {
    return tokens.some((token) => words.some((word) => token.startsWith(word) ||
        token.endsWith(word) || token.endsWith(`${word}s`)));
  }

  /**
   * @param {!Array<string>} tokens
   * @return {boolean} Whether the words suggest a non-content element.
   */
  function hasNegativeName(tokens) {
    return hasAffix(tokens, CONFIG.negativeNames) ||
        tokens.some((token) => CONFIG.adNames.includes(token));
  }

  /**
   * Whether an element's ID and classes mark it as a sidebar, menu, comment
   * section, ad etc.
   * @param {string} name ID and class names.
   * @return {boolean}
   */
  function isExcludedName(name) {
    const tokens = nameTokens(name);
    return hasNegativeName(tokens) && !tokens.some((token) =>
      CONFIG.keepNames.some((word) => token.startsWith(word)));
  }

  /**
   * Score bonus or penalty from ID and class names (Readability: ±25).
   * @param {string} name
   * @return {number}
   */
  function classWeight(name) {
    const tokens = nameTokens(name);
    let weight = 0;
    if (tokens.some((token) =>
      CONFIG.positiveNames.some((word) => token.startsWith(word)))) {
      weight += 25;
    }
    if (hasNegativeName(tokens)) weight -= 25;
    return weight;
  }

  /**
   * @param {string} text
   * @return {number} Number of commas, including CJK and Arabic commas.
   */
  function countCommas(text) {
    return (text.match(/[,،、，]/g) || []).length;
  }

  /**
   * Whether an element without nested blocks counts as a paragraph for the
   * content detection.
   * @param {string} tagName Lower case.
   * @param {boolean} hasLineBreak Whether it has a <br> child.
   * @return {boolean}
   */
  function countsAsParagraph(tagName, hasLineBreak) {
    return CONFIG.blockTags.includes(tagName) ||
        (CONFIG.textContainerTags.includes(tagName) && hasLineBreak);
  }

  /**
   * Whether a container holds enough paragraph text to be the content root.
   * @param {!Array<{textLength: number}>} paragraphs
   * @return {boolean}
   */
  function hasEnoughText(paragraphs) {
    let total = 0;
    for (const paragraph of paragraphs) total += paragraph.textLength;
    return total >= CONFIG.scoring.minText;
  }

  /**
   * Content score of one paragraph (Readability): one point, one per comma
   * and one per 100 characters, up to three.
   * @param {{textLength: number, commaCount: number}} paragraph
   * @return {number}
   */
  function paragraphScore(paragraph) {
    if (paragraph.textLength < CONFIG.scoring.minParagraphLength) return 0;
    return 1 + paragraph.commaCount +
        Math.min(Math.floor(paragraph.textLength / 100), 3);
  }

  /**
   * Share of a paragraph's score that an ancestor receives: the parent all,
   * the grandparent half, then 1 / (3 · depth).
   * @param {number} depth 0 for the parent.
   * @return {number}
   */
  function ancestorShare(depth) {
    if (depth === 0) return 1;
    if (depth === 1) return 0.5;
    return 1 / (depth * 3);
  }

  /**
   * @param {string} tagName Lower case.
   * @return {number} Initial score by element type (Readability).
   */
  function tagBaseScore(tagName) {
    switch (tagName) {
      case 'div':
      case 'article':
        return 5;
      case 'pre':
      case 'td':
      case 'blockquote':
        return 3;
      case 'address':
      case 'ol':
      case 'ul':
      case 'dl':
      case 'dd':
      case 'dt':
      case 'li':
      case 'form':
        return -3;
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
      case 'th':
        return -5;
      default:
        return 0;
    }
  }

  /**
   * Readability-like score of a content container: element type, class
   * names, amount of text, paragraphs and commas, reduced by the share of
   * link text.
   * @param {!ContainerFeatures} features
   * @return {number}
   */
  function scoreContainer(features) {
    let score = tagBaseScore(features.tagName) + classWeight(features.name);
    for (const paragraph of features.paragraphs) {
      score += paragraphScore(paragraph) * ancestorShare(paragraph.depth);
    }
    return score * (1 - clamp(features.linkDensity, 0, 1));
  }

  /**
   * Picks the content container from scored candidates. Starts with the best
   * score and moves to the parent if it scores almost as well or holds
   * another substantial candidate (text split into sections).
   * @param {!Array<!ScoredCandidate>} candidates
   * @return {number} Index, -1 if no candidate has a positive score.
   */
  function pickBestCandidate(candidates) {
    let best = -1;
    candidates.forEach((candidate, index) => {
      if (candidate.score > 0 &&
          (best < 0 || candidate.score > candidates[best].score)) {
        best = index;
      }
    });
    if (best < 0) return -1;
    const top = candidates[best].score;
    const parent = candidates[best].parent;
    if (parent < 0) return best;
    const hasSibling = candidates.some((candidate, index) =>
      index !== best && candidate.parent === parent &&
        candidate.score >= top * CONFIG.scoring.siblingRatio);
    if (hasSibling) return parent;
    while (candidates[best].parent >= 0 &&
        candidates[candidates[best].parent].score >=
            top * CONFIG.scoring.parentRatio) {
      best = candidates[best].parent;
    }
    return best;
  }

  /**
   * @param {!Array<{parent: number}>} candidates
   * @param {number} index
   * @param {number} ancestor
   * @return {boolean} Whether candidate ancestor contains candidate index.
   */
  function isDescendant(candidates, index, ancestor) {
    let current = candidates[index].parent;
    for (let guard = 0; current >= 0 && guard < candidates.length; guard++) {
      if (current === ancestor) return true;
      current = candidates[current].parent;
    }
    return false;
  }

  /**
   * Picks the content root among semantic elements (article, main): the one
   * with the most text, or a nested one that holds most of that text (an
   * article inside main next to a short comment section).
   * @param {!Array<!SemanticCandidate>} candidates
   * @return {number} Index or -1.
   */
  function chooseSemanticRoot(candidates) {
    let best = -1;
    candidates.forEach((candidate, index) => {
      if (candidate.textLength >= CONFIG.minSemanticText &&
          (best < 0 || candidate.textLength > candidates[best].textLength)) {
        best = index;
      }
    });
    while (best >= 0) {
      let child = -1;
      candidates.forEach((candidate, index) => {
        if (isDescendant(candidates, index, best) &&
            (child < 0 ||
             candidate.textLength > candidates[child].textLength)) {
          child = index;
        }
      });
      if (child < 0 || candidates[child].textLength <
          candidates[best].textLength * CONFIG.semanticDominance) {
        break;
      }
      best = child;
    }
    return best;
  }

  /** The pure functions, for unit tests. */
  const CORE = Object.freeze({
    config: CONFIG,
    stripFootnoteMarkers,
    isFootnoteText,
    cleanText,
    letterCount,
    pauseAfter,
    splitLongWord,
    tokenize,
    pivotIndex,
    pieceFactors,
    suffixSums,
    pieceDuration,
    remainingMs,
    formatRemaining,
    jumpTarget,
    sanitizeSetting,
    sanitizeSettings,
    keyAction,
    fitWord,
    nameTokens,
    isExcludedName,
    classWeight,
    countsAsParagraph,
    hasEnoughText,
    paragraphScore,
    scoreContainer,
    pickBestCandidate,
    chooseSemanticRoot,
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
  /* global GM_getValue, GM_setValue, GM_registerMenuCommand */

  /**
   * Elements of the reader window. themed lists the elements with colors
   * from the theme: CSS property names mapped to keys of THEMES.light.
   * @typedef {{stage: !HTMLElement, guide: !HTMLElement,
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
   *         styles: !Object<string, string>}>}} Ui
   */

  /**
   * An open reader window. index is the shown piece; finished tells that
   * playback ran to the end, so that Play starts over. nextDue is the time
   * (performance.now() of the window) at which the next piece is due.
   * @typedef {{win: !Window, doc: !Document, ui: !Ui, text: !ReaderText,
   *     key: string, factors: !Array<number>, sums: !Array<number>,
   *     index: number, playing: boolean, finished: boolean, timer: number,
   *     nextDue: number, darkQuery: ?MediaQueryList}} Reader
   */

  /**
   * Text to read and the title of its page.
   * @typedef {{title: string, paragraphs: !Array<!Paragraph>}} Content
   */

  /**
   * Per-operation caches: page styles can change at any time, so they only
   * live for one extraction.
   * @typedef {{style: !WeakMap<!Element, !CSSStyleDeclaration>,
   *     exclusion: !WeakMap<!Element, string>,
   *     linkDensity: !WeakMap<!Element, number>}} Caches
   */

  /**
   * Mutable state of the script.
   * @typedef {Object} State
   * @property {!Settings} settings
   * @property {?Reader} reader The open reader window.
   * @property {?Content} pending Content waiting for the window to open,
   *     while the notice about a blocked pop-up is shown.
   * @property {?HTMLElement} notice Host of that notice.
   * @property {boolean} pageHideListener Whether the page's pagehide
   *     listener is attached.
   * @property {!Caches} caches
   */

  /** @return {!Caches} */
  function newCaches() {
    return {
      style: new WeakMap(),
      exclusion: new WeakMap(),
      linkDensity: new WeakMap(),
    };
  }

  /** @type {!State} */
  const state = {
    settings: sanitizeSettings(null),
    reader: null,
    pending: null,
    notice: null,
    pageHideListener: false,
    caches: newCaches(),
  };

  // A name of its own for the reader window of this tab: window.open with
  // the name of another tab's reader would take that window over.
  const WINDOW_NAME =
      `speed-reader-${Math.random().toString(36).slice(2, 10)}`;

  // ===========================================================================
  // Classifying elements and text (from the Reading Ruler)
  // ===========================================================================

  const BLOCK_TAGS = new Set(CONFIG.blockTags);
  const HEADING_TAGS = new Set(CONFIG.headingTags);
  const EXCLUDED_TAGS = new Set(CONFIG.excludedTags);
  const EXCLUDED_ROLES = new Set(CONFIG.excludedRoles);
  // Paragraph-like elements for the content detection.
  const PARAGRAPH_SELECTOR =
      [...CONFIG.blockTags, ...CONFIG.textContainerTags].join(', ');
  const SEMANTIC_SELECTOR = 'article, main, [role="main"]';

  /**
   * Cached getComputedStyle.
   * @param {!Element} element
   * @return {!CSSStyleDeclaration}
   */
  function styleOf(element) {
    let style = state.caches.style.get(element);
    if (!style) {
      style = getComputedStyle(element);
      state.caches.style.set(element, style);
    }
    return style;
  }

  /**
   * @param {!Element} element
   * @return {string} ID and class names.
   */
  function nameOf(element) {
    return `${element.id} ${element.getAttribute('class') || ''}`;
  }

  /**
   * @param {!Element} element
   * @return {string} Text with collapsed white space.
   */
  function normalizedText(element) {
    return (element.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Whether a fixed or sticky element is a widget (header, toolbar, sidebar)
   * rather than a layout shell that contains the whole page.
   * @param {!Element} element
   * @return {boolean}
   */
  function isWidgetSized(element) {
    const rect = element.getBoundingClientRect();
    return rect.width < window.innerWidth * CONFIG.widgetShare ||
        rect.height < window.innerHeight * CONFIG.widgetShare;
  }

  /**
   * Whether an element is hidden visually but kept for screen readers
   * (absolutely positioned and clipped or 1 px small).
   * @param {!Element} element
   * @param {!CSSStyleDeclaration} style
   * @return {boolean}
   */
  function isVisuallyHidden(element, style) {
    if (style.position !== 'absolute' && style.position !== 'fixed') {
      return false;
    }
    if (style.clip && style.clip !== 'auto') return true;
    const rect = element.getBoundingClientRect();
    return rect.width <= 1 || rect.height <= 1;
  }

  /**
   * Whether an element is a footnote reference: a superscript or link with
   * a marker such as "[1]" that links to a place on the same page.
   * @param {!Element} element
   * @return {boolean}
   */
  function isFootnoteReference(element) {
    const tag = element.localName;
    if (tag !== 'sup' && tag !== 'a') return false;
    if (!isFootnoteText(normalizedText(element))) return false;
    const link = tag === 'a' ?
        element :
        element.querySelector('a[href]') || element.closest('a[href]');
    return !!link && (link.getAttribute('href') || '').startsWith('#');
  }

  /**
   * @param {!Element} element
   * @return {string} Why the element's subtree has no body text: 'hard'
   *     (landmark, control, code, hidden, fixed …), 'name' (only its ID or
   *     classes suggest so) or '' if it may contain body text.
   */
  function computeExclusion(element) {
    const tag = element.localName;
    if (EXCLUDED_TAGS.has(tag)) return 'hard';
    if (tag === 'header' && !element.parentElement?.closest('article')) {
      return 'hard';
    }
    const role = (element.getAttribute('role') || '').trim().toLowerCase()
        .split(/\s+/)[0];
    if (EXCLUDED_ROLES.has(role)) return 'hard';
    if (element.getAttribute('aria-hidden') === 'true') return 'hard';
    if (element instanceof HTMLElement && element.isContentEditable) {
      return 'hard';
    }
    const style = styleOf(element);
    if (style.display === 'none' || style.visibility === 'hidden' ||
        style.visibility === 'collapse') {
      return 'hard';
    }
    // Code blocks styled as blocks, without a pre element.
    if (tag === 'code' && style.display === 'block') return 'hard';
    const pinned = style.position === 'fixed' ||
        (style.position === 'sticky' && !BLOCK_TAGS.has(tag));
    if (pinned && isWidgetSized(element)) return 'hard';
    if (isVisuallyHidden(element, style)) return 'hard';
    if (isFootnoteReference(element)) return 'hard';
    if (isExcludedName(nameOf(element))) return 'name';
    return '';
  }

  /**
   * Cached computeExclusion.
   * @param {!Element} element
   * @return {string}
   */
  function exclusionOf(element) {
    let result = state.caches.exclusion.get(element);
    if (result === undefined) {
      result = computeExclusion(element);
      state.caches.exclusion.set(element, result);
    }
    return result;
  }

  /**
   * @param {!Element} element
   * @return {number} Share of the element's text inside links.
   */
  function linkDensityOf(element) {
    let result = state.caches.linkDensity.get(element);
    if (result === undefined) {
      result = 0;
      const length = normalizedText(element).length;
      if (length) {
        let links = 0;
        for (const link of element.querySelectorAll('a')) {
          links += normalizedText(link).length;
        }
        result = links / length;
      }
      state.caches.linkDensity.set(element, result);
    }
    return result;
  }

  /**
   * Whether a block consists mostly of links (link lists, "read more").
   * Headings are never link-heavy: a linked title is still a title.
   * @param {!Element} block
   * @return {boolean}
   */
  function isLinkHeavy(block) {
    return !HEADING_TAGS.has(block.localName) &&
        linkDensityOf(block) > CONFIG.maxLinkDensity;
  }

  /**
   * @param {!Element} element
   * @return {boolean} Whether the element is laid out as a block, so that
   *     text directly inside it forms a paragraph of its own.
   */
  function isBlockLike(element) {
    return CONFIG.blockDisplays.includes(styleOf(element).display);
  }

  /**
   * Whether an element and its ancestors below a container may contain body
   * text.
   * @param {!Element} element
   * @param {!Element} container Not checked itself.
   * @return {boolean}
   */
  function isIncluded(element, container) {
    for (let node = /** @type {?Element} */ (element);
      node && node !== container; node = node.parentElement) {
      if (exclusionOf(node)) return false;
    }
    return true;
  }

  /**
   * Returns the block (paragraph, list item, heading …) that a text node
   * belongs to, or null if it is not read: blank, in an excluded element or
   * in a link-heavy block. Text outside every block tag (a <div> with <br>,
   * a table cell) belongs to its nearest block-like ancestor.
   * @param {!Text} text
   * @param {!Element} root
   * @return {?Element}
   */
  function blockOf(text, root) {
    if (!/\S/.test(text.data)) return null;
    /** @type {?Element} */
    let block = null;
    /** @type {?Element} */
    let container = null;
    for (let element = text.parentElement; element && element !== root;
      element = element.parentElement) {
      if (exclusionOf(element)) return null;
      if (block) continue;
      if (BLOCK_TAGS.has(element.localName)) {
        block = element;
      } else if (!container && isBlockLike(element)) {
        container = element;
      }
    }
    if (!block && BLOCK_TAGS.has(root.localName)) block = root;
    if (!block) block = container || root;
    return isLinkHeavy(block) ? null : block;
  }

  // ===========================================================================
  // Content root (Readability-like heuristics, from the Reading Ruler)
  // ===========================================================================

  /**
   * Text directly inside a text container, outside its nested
   * paragraph-like elements: split at those elements into runs, like the
   * paragraphs Readability wraps such text in. Excluded children and runs
   * that consist mostly of links are left out.
   * @param {!Element} element
   * @return {!Array<string>} Runs with collapsed white space.
   */
  function looseTextRuns(element) {
    /** @type {!Array<string>} */
    const runs = [];
    /** @type {!Array<string>} */
    let parts = [];
    let linkLength = 0;
    const flush = () => {
      const text = parts.join(' ').replace(/\s+/g, ' ').trim();
      if (text && linkLength / text.length <= CONFIG.maxLinkDensity) {
        runs.push(text);
      }
      parts = [];
      linkLength = 0;
    };
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        parts.push(/** @type {!Text} */ (child).data);
      } else if (child instanceof Element) {
        if (child.matches(PARAGRAPH_SELECTOR) ||
            child.querySelector(PARAGRAPH_SELECTOR)) {
          flush();
        } else if (!exclusionOf(child)) {
          parts.push(child.textContent || '');
          const links = child.localName === 'a' ?
              [child] :
              child.querySelectorAll('a');
          for (const link of links) linkLength += normalizedText(link).length;
        }
      }
    }
    flush();
    return runs;
  }

  /**
   * Paragraphs below a container for the content detection: paragraph-like
   * elements without nested ones, and the runs of text that a text
   * container with nested ones breaks into lines next to them. Paragraphs
   * outside the body text and link-heavy ones are left out.
   * @param {!Element} container
   * @return {!Array<{text: string, parent: ?Element}>} parent is the first
   *     element whose score the paragraph raises.
   */
  function paragraphsIn(container) {
    /** @type {!Array<{text: string, parent: ?Element}>} */
    const paragraphs = [];
    for (const element of container.querySelectorAll(PARAGRAPH_SELECTOR)) {
      const hasLineBreak = !!element.querySelector(':scope > br');
      const nested = !!element.querySelector(PARAGRAPH_SELECTOR);
      const counts = nested ?
          hasLineBreak && CONFIG.textContainerTags.includes(element.localName) :
          countsAsParagraph(element.localName, hasLineBreak);
      if (!counts || !isIncluded(element, container)) continue;
      if (nested) {
        for (const text of looseTextRuns(element)) {
          paragraphs.push({text, parent: element});
        }
      } else if (!isLinkHeavy(element)) {
        paragraphs.push({
          text: normalizedText(element),
          parent: element.parentElement,
        });
      }
    }
    return paragraphs;
  }

  /**
   * Whether an element can be the content root: visible, not excluded
   * itself and not inside a landmark, control or hidden element. Class names
   * of ancestors are not checked: wrappers such as "page-with-sidebar"
   * contain the content.
   * @param {!Element} element
   * @return {boolean}
   */
  function isRootCandidate(element) {
    if (!element.getClientRects().length || exclusionOf(element)) return false;
    for (let node = element.parentElement;
      node && node !== document.documentElement; node = node.parentElement) {
      if (exclusionOf(node) === 'hard') return false;
    }
    return true;
  }

  /**
   * Finds the content root among article, main and [role="main"].
   * @return {?Element}
   */
  function findSemanticRoot() {
    const elements = [...document.querySelectorAll(SEMANTIC_SELECTOR)]
        .filter(isRootCandidate);
    const indices = new Map(elements.map((element, index) => [element, index]));
    /** @type {!Array<!SemanticCandidate>} */
    const candidates = elements.map((element) => {
      let textLength = 0;
      for (const paragraph of paragraphsIn(element)) {
        textLength += paragraph.text.length;
      }
      let ancestor = element.parentElement?.closest(SEMANTIC_SELECTOR);
      while (ancestor && !indices.has(ancestor)) {
        ancestor = ancestor.parentElement?.closest(SEMANTIC_SELECTOR);
      }
      return {textLength, parent: ancestor ? indices.get(ancestor) ?? -1 : -1};
    });
    const index = chooseSemanticRoot(candidates);
    return index >= 0 ? elements[index] : null;
  }

  /**
   * Finds the content root by scoring the ancestors of all paragraphs, like
   * Readability.
   * @return {?Element} null if no container holds enough text.
   */
  function findScoredRoot() {
    if (!document.body) return null;
    /** @type {!Map<!Element, !ContainerFeatures>} */
    const features = new Map();
    for (const {text, parent} of paragraphsIn(document.body)) {
      if (text.length < CONFIG.scoring.minParagraphLength) continue;
      let ancestor = parent;
      for (let depth = 0; ancestor && ancestor !== document.documentElement &&
        depth < CONFIG.scoring.maxDepth; depth++) {
        let entry = features.get(ancestor);
        if (!entry) {
          entry = {
            tagName: ancestor.localName,
            name: nameOf(ancestor),
            paragraphs: [],
            linkDensity: 0,
          };
          features.set(ancestor, entry);
        }
        entry.paragraphs.push({
          textLength: text.length,
          commaCount: countCommas(text),
          depth,
        });
        ancestor = ancestor.parentElement;
      }
    }
    const elements = [...features.keys()];
    const indices = new Map(elements.map((element, index) => [element, index]));
    const candidates = elements.map((element) => {
      const entry = /** @type {!ContainerFeatures} */ (features.get(element));
      entry.linkDensity = linkDensityOf(element);
      let parent = element.parentElement;
      while (parent && !features.has(parent)) parent = parent.parentElement;
      return {
        score: scoreContainer(entry),
        parent: parent ? indices.get(parent) ?? -1 : -1,
      };
    });
    const index = pickBestCandidate(candidates);
    if (index < 0) return null;
    const element = elements[index];
    const entry = /** @type {!ContainerFeatures} */ (features.get(element));
    return hasEnoughText(entry.paragraphs) ? element : null;
  }

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
    const root = findSemanticRoot() || findScoredRoot();
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
          if (exclusionOf(element)) return NodeFilter.FILTER_REJECT;
          return element.localName === 'br' ?
              NodeFilter.FILTER_ACCEPT :
              NodeFilter.FILTER_SKIP;
        });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType !== Node.TEXT_NODE) {
        parts.push(' ');
        continue;
      }
      const owner = blockOf(/** @type {!Text} */ (node), root);
      if (!owner) continue;
      if (owner !== block) {
        flush();
        block = owner;
      }
      parts.push(/** @type {!Text} */ (node).data);
    }
    flush();
    return paragraphs;
  }

  /**
   * Collects the text to read: the selection if there is one, the main
   * text of the page otherwise.
   * @return {!Content}
   */
  function extractContent() {
    state.caches = newCaches();
    const title = document.title.trim() || location.hostname;
    return {title, paragraphs: selectedParagraphs() || pageParagraphs()};
  }

  // ===========================================================================
  // Reader window: elements and styles
  // ===========================================================================

  // Colors of the reader in light and dark mode. The looks are set inline
  // through the CSSOM, which no Content Security Policy blocks: the reader
  // window inherits the page's policy, and in Firefox a script manager may
  // have to run the script as a content script, where a constructed style
  // sheet cannot be adopted. The color scheme is therefore followed through
  // matchMedia instead of a media query, and the style sheet below only
  // adds what inline styles cannot express.
  const THEMES = deepFreeze({
    light: {
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

  const READER_STYLES = `
    .sr-button:focus-visible,
    .sr-input:focus-visible {
      outline: 2px solid currentColor;
      outline-offset: 2px;
    }

    .sr-button:not(:disabled):hover {
      filter: brightness(.94);
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
  });

  /**
   * Sets inline styles.
   * @param {!Element} element
   * @param {!Object<string, string>} styles CSS property names and values.
   */
  function setStyles(element, styles) {
    const style = /** @type {!HTMLElement} */ (element).style;
    for (const [name, value] of Object.entries(styles)) {
      style.setProperty(name, value);
    }
  }

  /**
   * Creates an element with inline styles in a document.
   * @param {!Document} doc
   * @param {string} tag
   * @param {!Object<string, string>=} styles
   * @param {string=} className
   * @return {!HTMLElement}
   */
  function createElement(doc, tag, styles = {}, className = '') {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    setStyles(element, styles);
    return element;
  }

  /**
   * Adds a style sheet to the reader document: a constructed one, created
   * in the reader window, or a style element if adopting fails.
   * @param {!Window} win
   * @param {!Document} doc
   */
  function applyReaderStyles(win, doc) {
    try {
      const Sheet = /** @type {typeof CSSStyleSheet} */ (
        /** @type {*} */ (win).CSSStyleSheet);
      const sheet = new Sheet();
      sheet.replaceSync(READER_STYLES);
      doc.adoptedStyleSheets = [sheet];
      if (doc.adoptedStyleSheets.length) return;
    } catch {
      // Fall back to a style element below.
    }
    const style = doc.createElement('style');
    style.textContent = READER_STYLES;
    (doc.head || doc.documentElement).append(style);
  }

  /**
   * Creates an SVG icon.
   * @param {!Document} doc
   * @param {string} path
   * @return {{icon: !SVGSVGElement, shape: !SVGPathElement}}
   */
  function createIcon(doc, path) {
    const svgNs = 'http://www.w3.org/2000/svg';
    const icon = /** @type {!SVGSVGElement} */ (
      doc.createElementNS(svgNs, 'svg'));
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
      doc.createElementNS(svgNs, 'path'));
    shape.setAttribute('d', path);
    icon.append(shape);
    return {icon, shape};
  }

  /**
   * Builds the reader interface in the window's document.
   * @param {!Window} win
   * @param {!Document} doc
   * @param {string} title Title of the page that is read.
   * @return {!Ui}
   */
  function buildUi(win, doc, title) {
    /** @type {!Array<{element: !Element, styles: !Object<string, string>}>} */
    const themed = [];
    /**
     * @param {!Element} element
     * @param {!Object<string, string>} styles Theme keys by CSS property.
     * @return {!Element}
     */
    const theme = (element, styles) => {
      themed.push({element, styles});
      return element;
    };

    doc.title = `Speed Reader – ${title}`;
    doc.documentElement.lang = 'en';
    // Without a viewport, Firefox for Android lays the tab out for a
    // desktop width.
    const viewport = /** @type {!HTMLMetaElement} */ (
      doc.createElement('meta'));
    viewport.name = 'viewport';
    viewport.content = 'width=device-width, initial-scale=1';
    (doc.head || doc.documentElement).append(viewport);
    applyReaderStyles(win, doc);

    const body = doc.body || doc.documentElement.appendChild(
        doc.createElement('body'));
    body.replaceChildren();
    setStyles(body, {
      'font': '16px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, ' +
          'sans-serif',
      'margin': '0',
      'overflow-x': 'hidden',
    });
    theme(body, {'background': 'background', 'color': 'text'});

    const root = createElement(doc, 'main', {
      'box-sizing': 'border-box',
      'display': 'flex',
      'flex-direction': 'column',
      'gap': '12px',
      'margin': '0 auto',
      'max-width': '960px',
      'min-height': '100vh',
      'padding': '12px 16px max(16px, env(safe-area-inset-bottom))',
    });

    const heading = createElement(doc, 'h1', {
      'font-size': '14px',
      'font-weight': '500',
      'margin': '0',
      'overflow': 'hidden',
      'text-align': 'center',
      'text-overflow': 'ellipsis',
      'white-space': 'nowrap',
    });
    heading.textContent = title;
    theme(heading, {'color': 'muted'});

    const stage = createElement(doc, 'div', {
      '-webkit-tap-highlight-color': 'transparent',
      'cursor': 'pointer',
      'flex': '1 1 auto',
      'min-height': '160px',
      'overflow': 'hidden',
      'position': 'relative',
      'touch-action': 'manipulation',
      'user-select': 'none',
    }, 'sr-stage');
    stage.title = 'Play or pause (Space)';

    const guide = createElement(doc, 'div', {
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
      const tick = createElement(doc, 'div', {
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

    const word = createElement(doc, 'div', {
      'font-weight': '500',
      'left': '0',
      'line-height': '1.2',
      'position': 'absolute',
      'top': '50%',
      'transform': 'translateY(-50%)',
      'white-space': 'pre',
    }, 'sr-word');
    const before = createElement(doc, 'span', {}, 'sr-before');
    const pivot = createElement(doc, 'span', {}, 'sr-pivot');
    theme(pivot, {'color': 'pivot'});
    const after = createElement(doc, 'span', {}, 'sr-after');
    word.append(before, pivot, after);

    const message = createElement(doc, 'p', {
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

    const context = createElement(doc, 'p', {
      'font-size': '16px',
      'height': '4.2em',
      'margin': '0',
      'overflow-y': 'auto',
      'position': 'relative',
      'text-align': 'center',
    }, 'sr-context');
    theme(context, {'color': 'muted'});

    const track = createElement(doc, 'div', {
      'border-radius': '3px',
      'height': '6px',
      'overflow': 'hidden',
    });
    theme(track, {'background': 'line'});
    const fill = createElement(doc, 'div', {
      'height': '100%',
      'transition': 'width 120ms linear',
      'width': '0',
    }, 'sr-fill');
    theme(fill, {'background': 'fill'});
    track.append(fill);

    const status = createElement(doc, 'div', {
      'display': 'flex',
      'font-size': '14px',
      'font-variant-numeric': 'tabular-nums',
      'gap': '12px',
      'justify-content': 'space-between',
    });
    theme(status, {'color': 'muted'});
    const position = createElement(doc, 'span', {}, 'sr-position');
    const remaining = createElement(doc, 'span', {}, 'sr-remaining');
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
      const button = /** @type {!HTMLButtonElement} */ (createElement(doc,
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
      const {icon, shape} = createIcon(doc, path);
      const text = createElement(doc, 'span');
      text.textContent = label;
      labels.push(text);
      button.append(icon, text);
      // A click keeps the focus where it is, so that Space keeps toggling
      // playback instead of pressing the clicked button again.
      button.addEventListener('mousedown', (event) => event.preventDefault());
      return {button, shape, text};
    };
    const controls = createElement(doc, 'div', {
      'display': 'flex',
      'gap': '12px',
      'justify-content': 'center',
    });
    const back = createButton('Back', ICONS.back, 'sr-back', false);
    const play = createButton('Play', ICONS.play, 'sr-play', true);
    const forward = createButton('Forward', ICONS.forward, 'sr-forward',
        false);
    controls.append(back.button, play.button, forward.button);

    const settings = createElement(doc, 'div', {
      'display': 'flex',
      'flex-wrap': 'wrap',
      'gap': '4px 24px',
      'justify-content': 'center',
    });
    /**
     * @param {string} label
     * @param {string} name Key of CONFIG.settings.
     * @param {string} type 'range' or 'number'.
     * @return {{input: !HTMLInputElement, value: !HTMLElement}}
     */
    const createSetting = (label, name, type) => {
      const range = /** @type {!Object<string, !Range>} */ (
        CONFIG.settings)[name];
      const field = createElement(doc, 'label', {
        'align-items': 'center',
        'display': 'flex',
        'flex': type === 'range' ? '1 1 240px' : '0 1 auto',
        'font-size': '14px',
        'gap': '10px',
        'max-width': '340px',
        'min-height': '44px',
      });
      const caption = createElement(doc, 'span', {'min-width': '3em'});
      caption.textContent = label;
      theme(caption, {'color': 'muted'});
      const input = /** @type {!HTMLInputElement} */ (createElement(doc,
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
      const value = createElement(doc, 'span', {
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

    root.append(heading, stage, context, track, status, controls, settings);
    body.append(root);

    return {
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
   * Applies the light or dark colors.
   * @param {!Reader} reader
   */
  function applyTheme(reader) {
    const dark = !!reader.darkQuery?.matches;
    const colors = /** @type {!Object<string, string>} */ (
      dark ? THEMES.dark : THEMES.light);
    reader.doc.documentElement.style.setProperty(
        'color-scheme', dark ? 'dark' : 'light');
    for (const {element, styles} of reader.ui.themed) {
      for (const [name, key] of Object.entries(styles)) {
        /** @type {!HTMLElement} */ (element).style.setProperty(
            name, colors[key]);
      }
    }
  }

  /**
   * Shows the button labels only if the window is wide enough.
   * @param {!Reader} reader
   */
  function applyWidth(reader) {
    const compact = reader.win.innerWidth < CONFIG.compactWidth;
    for (const label of reader.ui.labels) {
      label.style.setProperty('display', compact ? 'none' : 'inline');
    }
  }

  // ===========================================================================
  // Reader window: rendering
  // ===========================================================================

  /**
   * Shows the current piece, aligned at its fixation letter.
   * @param {!Reader} reader
   */
  function renderWord(reader) {
    const {ui, text} = reader;
    const size = state.settings.fontSize;
    ui.guide.style.setProperty('height', `${Math.round(size * 1.7)}px`);
    ui.stage.style.setProperty('min-height',
        `${Math.max(160, Math.round(size * 2.6))}px`);
    const piece = text.pieces[reader.index];
    if (!piece) {
      ui.before.textContent = '';
      ui.pivot.textContent = '';
      ui.after.textContent = '';
      return;
    }
    const chars = Array.from(piece.text);
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
   * current word marked.
   * @param {!Reader} reader
   */
  function renderContext(reader) {
    const {ui, text, doc} = reader;
    const piece = text.pieces[reader.index];
    ui.context.style.setProperty('visibility',
        reader.playing || !piece ? 'hidden' : 'visible');
    if (reader.playing || !piece) return;
    const current = text.words[piece.word];
    const sentence = text.sentences[current.sentence];
    /**
     * @param {number} from
     * @param {number} to
     * @return {string}
     */
    const join = (from, to) => text.words.slice(from, to)
        .map((word) => word.text).join(' ');
    const mark = createElement(doc, 'mark', {
      'background': 'transparent',
      'font-weight': '600',
    }, 'sr-mark');
    mark.style.setProperty('color', /** @type {!Object<string, string>} */ (
      reader.darkQuery?.matches ? THEMES.dark : THEMES.light).mark);
    mark.textContent = current.text;
    const head = join(sentence.start, piece.word);
    const tail = join(piece.word + 1, sentence.end);
    ui.context.replaceChildren(
        head ? `${head} ` : '', mark, tail ? ` ${tail}` : '');
    ui.context.scrollTop = Math.max(0,
        mark.offsetTop - (ui.context.clientHeight - mark.offsetHeight) / 2);
  }

  /**
   * Updates everything that depends on the position, the playback state and
   * the settings.
   * @param {!Reader} reader
   */
  function render(reader) {
    const {ui, text} = reader;
    const empty = !text.pieces.length;
    const settings = state.settings;
    ui.message.style.setProperty('display', empty ? 'flex' : 'none');
    ui.message.textContent = empty ?
        'No text found on this page. Select the text you want to read, ' +
            'then start Speed Reader again.' :
        '';
    ui.guide.style.setProperty('visibility', empty ? 'hidden' : 'visible');
    for (const button of [ui.back, ui.play, ui.forward]) {
      button.disabled = empty;
      button.style.setProperty('opacity', empty ? '.45' : '1');
      button.style.setProperty('cursor', empty ? 'default' : 'pointer');
    }
    renderWord(reader);
    renderContext(reader);

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
            remainingMs(reader.sums, reader.index, settings.wpm)) :
        '';

    const label = reader.playing ? 'Pause' : 'Play';
    ui.playLabel.textContent = label;
    ui.play.setAttribute('aria-label', label);
    ui.play.title = `${label} (Space)`;
    ui.playIcon.setAttribute('d', reader.playing ? ICONS.pause : ICONS.play);
    ui.back.title = `Back ${settings.skip} words (←)`;
    ui.back.setAttribute('aria-label', `Back ${settings.skip} words`);
    ui.forward.title = `Forward ${settings.skip} words (→)`;
    ui.forward.setAttribute('aria-label', `Forward ${settings.skip} words`);
    ui.wpm.value = String(settings.wpm);
    ui.wpmValue.textContent = `${settings.wpm} wpm`;
    ui.fontSize.value = String(settings.fontSize);
    ui.fontSizeValue.textContent = `${settings.fontSize} px`;
    // Keep what the user is typing.
    if (reader.doc.activeElement !== ui.skip) {
      ui.skip.value = String(settings.skip);
    }
  }

  // ===========================================================================
  // Playback
  // ===========================================================================

  /** @param {!Reader} reader */
  function clearTimer(reader) {
    if (reader.timer) reader.win.clearTimeout(reader.timer);
    reader.timer = 0;
  }

  /**
   * @param {!Reader} reader
   * @return {number} Display time of the current piece in ms.
   */
  function currentDuration(reader) {
    return pieceDuration(reader.factors[reader.index] || 1,
        state.settings.wpm);
  }

  /**
   * Schedules the next piece at reader.nextDue with the timers of the
   * reader window: the page that opened it is often hidden or in the
   * background, where its timers are throttled. Each piece is due a fixed
   * time after the one before, so delays of single timers do not add up;
   * after a long delay the schedule restarts.
   * @param {!Reader} reader
   */
  function schedule(reader) {
    clearTimer(reader);
    if (!reader.playing) return;
    const now = reader.win.performance.now();
    if (reader.nextDue < now - CONFIG.maxLag) {
      reader.nextDue = now + currentDuration(reader);
    }
    reader.timer = reader.win.setTimeout(() => advance(reader),
        Math.max(0, reader.nextDue - now));
  }

  /**
   * Shows the next piece, or stops at the end.
   * @param {!Reader} reader
   */
  function advance(reader) {
    reader.timer = 0;
    if (state.reader !== reader || reader.win.closed || !reader.playing) {
      return;
    }
    if (reader.index >= reader.text.pieces.length - 1) {
      reader.playing = false;
      reader.finished = true;
    } else {
      reader.index++;
      reader.nextDue += currentDuration(reader);
    }
    render(reader);
    schedule(reader);
  }

  /**
   * Starts playback at the current piece, or from the start after the end.
   * @param {!Reader} reader
   */
  function play(reader) {
    if (!reader.text.pieces.length) return;
    if (reader.finished) {
      reader.index = 0;
      reader.finished = false;
    }
    reader.playing = true;
    reader.nextDue = reader.win.performance.now() + currentDuration(reader);
    render(reader);
    schedule(reader);
  }

  /** @param {!Reader} reader */
  function pause(reader) {
    reader.playing = false;
    clearTimer(reader);
    render(reader);
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
   * Skips words; playback continues at the new place.
   * @param {!Reader} reader
   * @param {number} direction 1 (forward) or -1 (back).
   */
  function skipWords(reader, direction) {
    if (!reader.text.pieces.length) return;
    reader.index = jumpTarget(reader.text, reader.index,
        direction * state.settings.skip);
    reader.finished = false;
    if (reader.playing) {
      reader.nextDue = reader.win.performance.now() + currentDuration(reader);
      schedule(reader);
    }
    render(reader);
  }

  /**
   * Stores a changed setting and shows its effect.
   * @param {!Reader} reader
   * @param {string} name Key of CONFIG.settings.
   * @param {*} value
   */
  function changeSetting(reader, name, value) {
    const settings = /** @type {!Settings} */ ({
      ...state.settings,
      [name]: sanitizeSetting(name, value),
    });
    state.settings = settings;
    GM_setValue(CONFIG.storageSettings, settings);
    render(reader);
  }

  // ===========================================================================
  // Reader window: input
  // ===========================================================================

  /**
   * @param {?EventTarget} target
   * @return {string} Kind of a focused element for keyAction.
   */
  function targetKind(target) {
    // Elements of the reader window come from another realm, so instanceof
    // checks against this window's classes would fail.
    const element = /** @type {?Element} */ (
      target && 'localName' in target ? target : null);
    if (!element) return 'other';
    const tag = element.localName;
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      return /** @type {!HTMLInputElement} */ (element).type === 'range' ?
          'range' :
          'text';
    }
    if (tag === 'textarea' || tag === 'select') return 'text';
    return 'other';
  }

  /**
   * Adds the listeners of the reader window.
   * @param {!Reader} reader
   */
  function attachReaderListeners(reader) {
    const {win, doc, ui} = reader;
    ui.play.addEventListener('click', () => togglePlay(reader));
    ui.back.addEventListener('click', () => skipWords(reader, -1));
    ui.forward.addEventListener('click', () => skipWords(reader, 1));
    ui.stage.addEventListener('click', () => togglePlay(reader));
    ui.wpm.addEventListener('input',
        () => changeSetting(reader, 'wpm', ui.wpm.value));
    ui.fontSize.addEventListener('input',
        () => changeSetting(reader, 'fontSize', ui.fontSize.value));
    ui.skip.addEventListener('input', () => {
      if (ui.skip.value.trim() && ui.skip.checkValidity()) {
        changeSetting(reader, 'skip', ui.skip.value);
      }
    });
    ui.skip.addEventListener('change', () => {
      changeSetting(reader, 'skip', ui.skip.value);
      ui.skip.value = String(state.settings.skip);
    });
    doc.addEventListener('keydown', (event) => {
      const action = keyAction(event.key, targetKind(event.target),
          event.ctrlKey || event.altKey || event.metaKey);
      if (!action) return;
      event.preventDefault();
      if (action === 'toggle') {
        if (!event.repeat) togglePlay(reader);
      } else if (action === 'back' || action === 'forward') {
        skipWords(reader, action === 'back' ? -1 : 1);
      } else {
        changeSetting(reader, 'wpm', state.settings.wpm +
            (action === 'faster' ? 1 : -1) * CONFIG.wpmKeyStep);
      }
    });
    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'hidden' && reader.playing) pause(reader);
    });
    win.addEventListener('resize', () => {
      applyWidth(reader);
      renderWord(reader);
    });
    // Closing the window ends the reader; its timers end with it.
    win.addEventListener('pagehide', () => releaseReader(reader));
    reader.darkQuery?.addEventListener('change', () => {
      applyTheme(reader);
      renderContext(reader);
    });
  }

  // ===========================================================================
  // Opening and closing the reader
  // ===========================================================================

  /**
   * Forgets a reader whose window was closed.
   * @param {!Reader} reader
   */
  function releaseReader(reader) {
    reader.playing = false;
    if (!reader.win.closed) clearTimer(reader);
    reader.timer = 0;
    if (state.reader === reader) state.reader = null;
  }

  /**
   * Closes the reader window and the notice when the page is left: the
   * reader is driven by this page.
   */
  function onPageHide() {
    const reader = state.reader;
    if (reader) {
      releaseReader(reader);
      if (!reader.win.closed) reader.win.close();
    }
    removeNotice();
  }

  /**
   * Shows new content in a reader, paused at its first word. The same text
   * keeps its position.
   * @param {!Reader} reader
   * @param {!Content} content
   */
  function loadContent(reader, content) {
    const key = content.paragraphs.map((paragraph) => paragraph.text)
        .join('\n');
    reader.doc.title = `Speed Reader – ${content.title}`;
    if (key === reader.key) {
      pause(reader);
      return;
    }
    clearTimer(reader);
    reader.text = tokenize(content.paragraphs);
    reader.key = key;
    reader.factors = pieceFactors(reader.text);
    reader.sums = suffixSums(reader.factors);
    reader.index = 0;
    reader.playing = false;
    reader.finished = false;
    render(reader);
  }

  /**
   * Shows content in the reader window, opening the window if needed.
   * @param {!Content} content
   * @return {boolean} false if the browser blocked the window.
   */
  function showReader(content) {
    state.settings = sanitizeSettings(
        GM_getValue(CONFIG.storageSettings, null));
    const open = state.reader;
    if (open && !open.win.closed) {
      loadContent(open, content);
      open.win.focus();
      return true;
    }
    const {width, height} = CONFIG.window;
    // An empty URL keeps the initial document: loading about:blank would
    // replace the interface built below.
    const win = window.open('', WINDOW_NAME,
        `popup,width=${width},height=${height}`);
    if (!win) return false;
    const doc = win.document;
    /** @type {!Reader} */
    const reader = {
      win,
      doc,
      ui: buildUi(win, doc, content.title),
      text: {words: [], pieces: [], sentences: []},
      key: '\u0000',
      factors: [],
      sums: [0],
      index: 0,
      playing: false,
      finished: false,
      timer: 0,
      nextDue: 0,
      darkQuery: win.matchMedia ?
          win.matchMedia('(prefers-color-scheme: dark)') :
          null,
    };
    state.reader = reader;
    applyTheme(reader);
    applyWidth(reader);
    attachReaderListeners(reader);
    loadContent(reader, content);
    // The window may get its final size after this script ran.
    win.requestAnimationFrame(() => {
      applyWidth(reader);
      renderWord(reader);
    });
    if (!state.pageHideListener) {
      window.addEventListener('pagehide', onPageHide);
      state.pageHideListener = true;
    }
    win.focus();
    return true;
  }

  // ===========================================================================
  // Notice about a blocked pop-up (Shadow DOM in the page)
  // ===========================================================================

  /** Removes the notice. */
  function removeNotice() {
    state.notice?.remove();
    state.notice = null;
    state.pending = null;
  }

  /**
   * Creates a button of the notice.
   * @param {string} label
   * @param {!Object<string, string>} styles
   * @param {() => void} action
   * @return {!HTMLButtonElement}
   */
  function createNoticeButton(label, styles, action) {
    const button = /** @type {!HTMLButtonElement} */ (createElement(document,
        'button', {
          'border': '1px solid',
          'border-radius': '22px',
          'box-sizing': 'border-box',
          'cursor': 'pointer',
          'font': 'inherit',
          'margin': '0',
          'min-height': '44px',
          'min-width': '44px',
          'padding': '0 16px',
          ...styles,
        }));
    button.type = 'button';
    button.textContent = label;
    // Keep the selection of the page.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', action);
    return button;
  }

  /**
   * Shows a notice in the page whose button opens the reader: a click is a
   * user action, which pop-up blockers allow.
   */
  function showNotice() {
    if (state.notice?.isConnected) return;
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const colors = dark ? THEMES.dark : THEMES.light;
    const host = /** @type {!HTMLElement} */ (
      document.createElement('speed-reader-notice'));
    host.style.cssText = 'all: initial; bottom: 16px; display: block; ' +
        'position: fixed; right: 16px; z-index: 2147483647;';
    const shadow = host.attachShadow({mode: 'closed'});
    const card = createElement(document, 'div', {
      'background': colors.surface,
      'border': `1px solid ${colors.border}`,
      'border-radius': '12px',
      'box-shadow': '0 4px 16px rgba(0, 0, 0, .25)',
      'box-sizing': 'border-box',
      'color': colors.text,
      'display': 'flex',
      'flex-direction': 'column',
      'font': '14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, ' +
          'sans-serif',
      'gap': '8px',
      'max-width': 'min(320px, calc(100vw - 32px))',
      'padding': '12px 12px 12px 16px',
    });
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Speed Reader');
    const header = createElement(document, 'div', {
      'align-items': 'center',
      'display': 'flex',
      'gap': '8px',
      'justify-content': 'space-between',
    });
    const title = createElement(document, 'strong', {'font-size': '15px'});
    title.textContent = 'Speed Reader';
    const close = createNoticeButton('×', {
      'background': 'transparent',
      'border-color': 'transparent',
      'color': colors.muted,
      'font-size': '22px',
      'padding': '0',
    }, removeNotice);
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    header.append(title, close);
    const text = createElement(document, 'p', {'margin': '0'});
    text.textContent = 'The browser blocked the reader window. Allow ' +
        'pop-ups for this site to skip this step next time.';
    const open = createNoticeButton('Open reader', {
      'align-self': 'flex-start',
      'background': colors.text,
      'border-color': colors.text,
      'color': colors.background,
    }, () => {
      const content = state.pending;
      if (content && showReader(content)) removeNotice();
    });
    open.className = 'sr-open';
    card.append(header, text, open);
    shadow.append(card);
    document.documentElement.append(host);
    state.notice = host;
    if (!state.pageHideListener) {
      window.addEventListener('pagehide', onPageHide);
      state.pageHideListener = true;
    }
  }

  // ===========================================================================
  // Menu command and startup
  // ===========================================================================

  /**
   * Reads the selection or the page in the reader window, or shows the
   * notice if the browser blocks the window.
   */
  function onMenuCommand() {
    const content = extractContent();
    if (showReader(content)) {
      removeNotice();
    } else {
      showNotice();
      state.pending = content;
    }
  }

  GM_registerMenuCommand('Speed Reader: Read this page', onMenuCommand,
      {id: 'read', autoClose: true});
})();
