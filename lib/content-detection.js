// @ts-check

/**
 * @fileoverview Detection of the main text of a page (Readability-like
 * heuristics), shared by the Reading Ruler and the Speed Reader. The scripts
 * load it with @require; it only defines the global ContentDetection and
 * does nothing on its own.
 * Pure functions (scoring, class names) are free of DOM access, so the unit
 * tests call them directly. createDetector() returns the functions that read
 * the page, with their own per-operation caches.
 * Versioning: the scripts require this file with "?v=<version>" in the URL,
 * so that the script manager downloads it again when it changes. After a
 * change, bump the version below and the URLs (and @version) of both
 * scripts; tests/content-detection.test.js checks that they match.
 * Code style: Google JavaScript Style Guide.
 * @version 1.0.0
 */

/* exported ContentDetection */
const ContentDetection = (function() {
  'use strict';

  // ===========================================================================
  // Types
  // ===========================================================================

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

  /**
   * How a script reads the page. codeBlocks: 'text' reads <pre> like a
   * paragraph, 'skip' leaves out <pre> and code styled as a block.
   * skipAriaHidden and skipFootnoteReferences leave out aria-hidden subtrees
   * and footnote links such as "[1]". With requireBlockLikeRoot, text
   * directly inside a content root that is not laid out as a block (no
   * nearer block) is left out.
   * @typedef {{codeBlocks: ('text'|'skip'), skipAriaHidden: boolean,
   *     skipFootnoteReferences: boolean,
   *     requireBlockLikeRoot: boolean}} DetectorOptions
   */

  /**
   * 'hard': landmark, control, hidden, fixed …; 'name': only the element's
   * ID or classes suggest a non-content element; '': may hold body text.
   * @typedef {('hard'|'name'|'')} Exclusion
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
    // Elements that hold paragraphs of text.
    blockTags: ['p', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'dt', 'dd'],
    headingTags: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    // Elements that may hold body text without paragraphs. For the content
    // detection they count as paragraphs only if they break their text with
    // <br>: table cells and divs of web apps hold text too, but not prose.
    // If they also contain blocks, each run of their own text between those
    // blocks counts as a paragraph. With codeBlocks 'text', <pre> is one of
    // them and always counts as a paragraph.
    textContainerTags: ['div', 'section', 'td', 'figcaption'],
    // Text outside every block tag belongs to its nearest ancestor with one
    // of these computed display values.
    blockDisplays: ['block', 'flow-root', 'list-item', 'table-cell',
      'table-caption'],
    // Subtrees without body text. A header is only skipped outside an
    // article: inside, it holds the article's title. With codeBlocks
    // 'skip', <pre> is one of them.
    excludedTags: ['nav', 'aside', 'footer', 'button', 'select', 'textarea',
      'input', 'label', 'option', 'script', 'style', 'noscript', 'template',
      'svg', 'math', 'canvas', 'video', 'audio', 'iframe', 'object', 'embed'],
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
    // "content-with-sidebar" (like Readability's "maybe a candidate"). Not
    // "main": "main-menu" is a menu.
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
    // The winner needs minText characters of paragraph text; pages without
    // such a container (web apps, link lists) have no content root.
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

  // Footnote markers such as [1], [2–4], [a] or [note 3], without brackets.
  const FOOTNOTE_MARKER = String.raw`\d{1,3}(?:\s*[,–-]\s*\d{1,3})*|[a-z]|` +
      String.raw`(?:note|nb|fn)\.?\s*\d{1,3}`;
  const FOOTNOTE_TEXT_PATTERN =
      new RegExp(String.raw`^\[?(?:${FOOTNOTE_MARKER})\]?$`, 'i');

  // ===========================================================================
  // Pure functions (no DOM)
  // ===========================================================================

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
   * Whether the text of an element is a footnote marker ("[1]", "2", "a").
   * @param {string} text
   * @return {boolean}
   */
  function isFootnoteText(text) {
    return FOOTNOTE_TEXT_PATTERN.test(text.trim());
  }

  /**
   * Splits the ID and class names of an element into lower-case words: the
   * parts between punctuation ("article-body" → "article", "body"), and their
   * camel-case parts ("sideBar" → "sidebar", "side", "bar").
   * @param {string} name
   * @return {!Array<string>}
   */
  function nameTokens(name) {
    /** @type {!Set<string>} */
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
   * @param {('text'|'skip')} codeBlocks See DetectorOptions.
   * @return {!Array<string>} The text container tags for this setting.
   */
  function textContainerTagsFor(codeBlocks) {
    return codeBlocks === 'text' ?
        [...CONFIG.textContainerTags, 'pre'] :
        [...CONFIG.textContainerTags];
  }

  /**
   * Whether an element without nested blocks counts as a paragraph for the
   * content detection: block tags always, text containers if they break
   * their text with <br>, <pre> if it is a text container.
   * @param {string} tagName Lower case.
   * @param {boolean} hasLineBreak Whether it has a <br> child.
   * @param {!ReadonlyArray<string>} textContainerTags From
   *     textContainerTagsFor.
   * @return {boolean}
   */
  function countsAsParagraph(tagName, hasLineBreak, textContainerTags) {
    return CONFIG.blockTags.includes(tagName) ||
        (textContainerTags.includes(tagName) &&
         (hasLineBreak || tagName === 'pre'));
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

  // ===========================================================================
  // Reading the page
  // ===========================================================================

  const BLOCK_TAGS = new Set(CONFIG.blockTags);
  const HEADING_TAGS = new Set(CONFIG.headingTags);
  const EXCLUDED_ROLES = new Set(CONFIG.excludedRoles);
  const SEMANTIC_SELECTOR = 'article, main, [role="main"]';

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
   * Creates the functions that read the page for one script. Their results
   * are cached until resetCaches(): page styles can change at any time, so
   * a script resets the caches at the start of each operation.
   * @param {!DetectorOptions} options
   */
  function createDetector(options) {
    const textContainerTags = textContainerTagsFor(options.codeBlocks);
    const excludedTags = new Set(options.codeBlocks === 'skip' ?
        [...CONFIG.excludedTags, 'pre'] :
        CONFIG.excludedTags);
    // Paragraph-like elements for the content detection.
    const paragraphSelector =
        [...CONFIG.blockTags, ...textContainerTags].join(', ');

    /** @type {!WeakMap<!Element, !CSSStyleDeclaration>} */
    let styles = new WeakMap();
    /** @type {!WeakMap<!Element, !Exclusion>} */
    let exclusions = new WeakMap();
    /** @type {!WeakMap<!Element, number>} */
    let linkDensities = new WeakMap();

    /** Forgets everything measured so far. */
    function resetCaches() {
      styles = new WeakMap();
      exclusions = new WeakMap();
      linkDensities = new WeakMap();
    }

    /**
     * Cached getComputedStyle.
     * @param {!Element} element
     * @return {!CSSStyleDeclaration}
     */
    function styleOf(element) {
      let style = styles.get(element);
      if (!style) {
        style = getComputedStyle(element);
        styles.set(element, style);
      }
      return style;
    }

    /**
     * @param {!Element} element
     * @return {!Exclusion} Why the element's subtree has no body text.
     */
    function computeExclusion(element) {
      const tag = element.localName;
      if (excludedTags.has(tag)) return 'hard';
      if (tag === 'header' && !element.parentElement?.closest('article')) {
        return 'hard';
      }
      const role = (element.getAttribute('role') || '').trim().toLowerCase()
          .split(/\s+/)[0];
      if (EXCLUDED_ROLES.has(role)) return 'hard';
      if (options.skipAriaHidden &&
          element.getAttribute('aria-hidden') === 'true') {
        return 'hard';
      }
      if (element instanceof HTMLElement && element.isContentEditable) {
        return 'hard';
      }
      const style = styleOf(element);
      if (style.display === 'none' || style.visibility === 'hidden' ||
          style.visibility === 'collapse') {
        return 'hard';
      }
      // Code blocks styled as blocks, without a pre element.
      if (options.codeBlocks === 'skip' && tag === 'code' &&
          style.display === 'block') {
        return 'hard';
      }
      // Sticky headings and paragraphs (section titles that stick while their
      // section scrolls by) are text, not widgets.
      const pinned = style.position === 'fixed' ||
          (style.position === 'sticky' && !BLOCK_TAGS.has(tag));
      if (pinned && isWidgetSized(element)) return 'hard';
      if (isVisuallyHidden(element, style)) return 'hard';
      if (options.skipFootnoteReferences && isFootnoteReference(element)) {
        return 'hard';
      }
      if (isExcludedName(nameOf(element))) return 'name';
      return '';
    }

    /**
     * Cached computeExclusion.
     * @param {!Element} element
     * @return {!Exclusion}
     */
    function exclusionOf(element) {
      let result = exclusions.get(element);
      if (result === undefined) {
        result = computeExclusion(element);
        exclusions.set(element, result);
      }
      return result;
    }

    /**
     * @param {!Element} element
     * @return {number} Share of the element's text inside links.
     */
    function linkDensityOf(element) {
      let result = linkDensities.get(element);
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
        linkDensities.set(element, result);
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
     *     text directly inside it forms a paragraph (and lines) of its own.
     */
    function isBlockLike(element) {
      return CONFIG.blockDisplays.includes(styleOf(element).display);
    }

    /**
     * Whether an element and its ancestors below a container may contain
     * body text.
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
     * belongs to, or null if it is not body text: blank, outside the root, in
     * an excluded element or in a link-heavy block. Text outside every block
     * tag (a <div> with <br>, a table cell, <pre>) belongs to its nearest
     * block-like ancestor.
     * @param {!Text} text
     * @param {!Element} root
     * @return {?Element}
     */
    function blockOf(text, root) {
      if (!/\S/.test(text.data) || !root.contains(text)) return null;
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
      if (!block) {
        block = container ||
            (!options.requireBlockLikeRoot || isBlockLike(root) ? root : null);
      }
      return block && !isLinkHeavy(block) ? block : null;
    }

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
          if (child.matches(paragraphSelector) ||
              child.querySelector(paragraphSelector)) {
            flush();
          } else if (!exclusionOf(child)) {
            parts.push(child.textContent || '');
            const links = child.localName === 'a' ?
                [child] :
                child.querySelectorAll('a');
            for (const link of links) {
              linkLength += normalizedText(link).length;
            }
          }
        }
      }
      flush();
      return runs;
    }

    /**
     * Paragraphs below a container for the content detection: paragraph-like
     * elements without nested ones (see countsAsParagraph), and the runs of
     * text that a text container with nested ones breaks into lines next to
     * them (looseTextRuns). Paragraphs outside the body text and link-heavy
     * ones are left out.
     * @param {!Element} container
     * @return {!Array<{text: string, parent: ?Element}>} parent is the first
     *     element whose score the paragraph raises.
     */
    function paragraphsIn(container) {
      /** @type {!Array<{text: string, parent: ?Element}>} */
      const paragraphs = [];
      for (const element of container.querySelectorAll(paragraphSelector)) {
        const hasLineBreak = !!element.querySelector(':scope > br');
        const nested = !!element.querySelector(paragraphSelector);
        const counts = nested ?
            hasLineBreak && textContainerTags.includes(element.localName) :
            countsAsParagraph(element.localName, hasLineBreak,
                textContainerTags);
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
     * itself and not inside a landmark, control or hidden element. Class
     * names of ancestors are not checked: wrappers such as
     * "page-with-sidebar" contain the content.
     * @param {!Element} element
     * @return {boolean}
     */
    function isRootCandidate(element) {
      if (!element.getClientRects().length || exclusionOf(element)) {
        return false;
      }
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
      const indices =
          new Map(elements.map((element, index) => [element, index]));
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
        return {
          textLength,
          parent: ancestor ? indices.get(ancestor) ?? -1 : -1,
        };
      });
      const index = chooseSemanticRoot(candidates);
      return index >= 0 ? elements[index] : null;
    }

    /**
     * Finds the content root by scoring the ancestors of all paragraphs,
     * like Readability.
     * @return {?Element} null if no container holds enough text.
     */
    function findScoredRoot() {
      if (!document.body) return null;
      /** @type {!Map<!Element, !ContainerFeatures>} */
      const features = new Map();
      for (const {text, parent} of paragraphsIn(document.body)) {
        if (text.length < CONFIG.scoring.minParagraphLength) continue;
        let ancestor = parent;
        for (let depth = 0;
          ancestor && ancestor !== document.documentElement &&
            depth < CONFIG.scoring.maxDepth;
          depth++) {
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
      const indices =
          new Map(elements.map((element, index) => [element, index]));
      const candidates = elements.map((element) => {
        const entry =
            /** @type {!ContainerFeatures} */ (features.get(element));
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

    /**
     * Finds the element that holds the main text of the page.
     * @return {?Element} null if the page has no article-like content.
     */
    function findRoot() {
      return findSemanticRoot() || findScoredRoot();
    }

    return Object.freeze({
      resetCaches,
      styleOf,
      exclusionOf,
      blockOf,
      findRoot,
    });
  }

  return Object.freeze({
    config: CONFIG,
    footnoteMarker: FOOTNOTE_MARKER,
    isFootnoteText,
    nameTokens,
    isExcludedName,
    classWeight,
    countCommas,
    textContainerTagsFor,
    countsAsParagraph,
    hasEnoughText,
    paragraphScore,
    ancestorShare,
    scoreContainer,
    pickBestCandidate,
    chooseSemanticRoot,
    createDetector,
  });
})();
