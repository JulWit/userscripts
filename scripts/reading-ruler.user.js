// ==UserScript==
// @name         Reading Ruler
// @namespace    https://github.com/JulWit/userscripts
// @version      1.4.1
// @description  Highlights one line of an article at a time: click or tap a line, then move with the arrow keys
// @author       Julian
// @homepageURL  https://github.com/JulWit/userscripts
// @supportURL   https://github.com/JulWit/userscripts/issues
// @icon         data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTQiIGZpbGw9IiMyYjJmMzYiLz48ZyBmaWxsPSIjOWFhM2FkIj48cmVjdCB4PSIxNCIgeT0iMTMiIHdpZHRoPSIzNiIgaGVpZ2h0PSI1IiByeD0iMi41Ii8+PHJlY3QgeD0iMTQiIHk9IjQ0IiB3aWR0aD0iMzYiIGhlaWdodD0iNSIgcng9IjIuNSIvPjxyZWN0IHg9IjE0IiB5PSI1NCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjUiIHJ4PSIyLjUiIG9wYWNpdHk9Ii42Ii8+PHJlY3QgeD0iMTQiIHk9IjMiIHdpZHRoPSIzMCIgaGVpZ2h0PSI1IiByeD0iMi41IiBvcGFjaXR5PSIuNiIvPjwvZz48cmVjdCB4PSI2IiB5PSIyNCIgd2lkdGg9IjUyIiBoZWlnaHQ9IjE1IiByeD0iNCIgZmlsbD0iI2ZmYzQwMCIvPjxyZWN0IHg9IjE0IiB5PSIyOSIgd2lkdGg9IjM2IiBoZWlnaHQ9IjUiIHJ4PSIyLjUiIGZpbGw9IiMyYjJmMzYiLz48L3N2Zz4K
// @updateURL    https://raw.githubusercontent.com/JulWit/userscripts/main/scripts/reading-ruler.user.js
// @downloadURL  https://raw.githubusercontent.com/JulWit/userscripts/main/scripts/reading-ruler.user.js
// @require      https://raw.githubusercontent.com/JulWit/userscripts/main/lib/content-detection.js?v=1.2.0
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @run-at       document-idle
// @noframes
// ==/UserScript==
// @ts-check

/**
 * @fileoverview Reading aid that highlights one rendered line of the main
 * text of a page. A click or tap on body text selects the line under the
 * pointer; the arrow keys (or floating buttons on touch devices) move to the
 * next or previous line in reading order and keep it centered in the
 * viewport. The selection is stored as a text position, so it survives
 * reflows, and lines are only measured when needed.
 * Known limitations: text inside shadow DOM (web components) cannot be
 * selected, and text in a vertical writing mode is skipped. In a scroll
 * container inside the page, the highlight follows the text after each
 * scroll event, so it trails by a frame or two while the container scrolls
 * fast (browsers scroll on a separate thread); moving it into the container
 * would change the page's DOM and layout.
 * Code style: Google JavaScript Style Guide, Google HTML/CSS Style Guide.
 */

(function() {
  'use strict';

  // ===========================================================================
  // Types
  // ===========================================================================

  /**
   * Rectangle in viewport coordinates (CSS pixels).
   * @typedef {{top: number, bottom: number, left: number, right: number}} Box
   */

  /**
   * Client rect of a text fragment; source identifies the fragment.
   * @typedef {{top: number, bottom: number, left: number, right: number,
   *     source: number}} Fragment
   */

  /**
   * Visual line: the union of its fragments, with the source of its first
   * fragment in document order. column is the index of the block's box the
   * line lies in (a block split by CSS columns has several), 0 otherwise.
   * @typedef {{top: number, bottom: number, left: number, right: number,
   *     source: number, column: number}} Line
   */

  /** @typedef {{left: number, right: number}} Span */

  /** @typedef {{top: number, bottom: number}} Band */

  /** @typedef {{top: number, left: number, width: number,
   *     height: number}} Placement */

  /**
   * @typedef {{lineTop: number, lineBottom: number, bandTop: number,
   *     bandBottom: number, scrollTop: number,
   *     maxScrollTop: number}} ScrollInput
   */

  /**
   * Selected position: a character in a text node.
   * @typedef {{node: !Text, offset: number}} Anchor
   */

  /**
   * Consecutive selectable text nodes in document order that share a block.
   * @typedef {{block: !Element, texts: !Array<!Text>}} Segment
   */

  /**
   * Measured lines of a segment; fragments maps a line source to the text
   * node and the index of the client rect within that node, columns holds
   * the content boxes of the block.
   * @typedef {{lines: !Array<!Line>,
   *     fragments: !Array<{textIndex: number, rectIndex: number}>,
   *     columns: !Array<!Box>}} SegmentLayout
   */

  /**
   * A line of a measured segment.
   * @typedef {{segment: !Segment, layout: !SegmentLayout,
   *     index: number}} LineRef
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
    // Fragments on one line overlap vertically by at least this share of the
    // smaller height (superscripts, mixed font sizes).
    lineOverlap: 0.5,
    // Fragments taller than this multiple of the median height are left out
    // when grouping lines (drop caps, large inline elements).
    outlierHeight: 2,
    // Space around the highlighted line in CSS pixels. The vertical padding
    // is a share of the line height within limits.
    padding: {x: 6, yShare: 0.2, yMin: 2, yMax: 8},
    // A line that ends at least this far (px) before an edge of its column
    // may have a floating element (image, infobox) beside it; the highlight
    // ends before one.
    minFloatGap: 24,
    // Minimum time between two detections of the content root in ms, while
    // the page keeps changing its DOM.
    redetectInterval: 1000,
    // Search for fixed and sticky headers/footers that cover the viewport:
    // rows of points are probed from each edge inwards, every probeStep px
    // and past every element found, within the top and bottom share of the
    // view; the scan of an edge stops after freeRows rows without one (a
    // gap of up to 32 px between stacked bars is crossed).
    // Elements must start within edgeShare of an edge and may cover at most
    // maxHeightShare; if less than minBandShare remains uncovered, the whole
    // view is used.
    obstruction: {
      probeStep: 16,
      topProbe: 0.4,
      bottomProbe: 0.3,
      freeRows: 3,
      edgeShare: 0.2,
      maxHeightShare: 0.5,
      minBandShare: 0.3,
    },

    // A pointer that moved further between press and click selected text.
    dragDistance: {mouse: 5, touch: 12},
    // Upper limit of text segments without visible lines skipped per move.
    maxSegmentScan: 200,
    // Text nodes measured on each side of the selected one: a highlighted
    // code block has thousands. Moving past them measures the next ones.
    maxSegmentTexts: 200,
    // If the selected line was scrolled out of view, an arrow key selects a
    // visible line instead: points every visibleLineProbe px are probed.
    visibleLineProbe: 12,
    // Floating up/down buttons are shown for this primary pointer.
    touchQuery: '(pointer: coarse)',
    reducedMotionQuery: '(prefers-reduced-motion: reduce)',

    storageDisabledSites: 'disabledSites',
  });

  // ===========================================================================
  // Pure functions: lines, content scoring, scrolling (no DOM, no storage)
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
   * @param {!Box} a
   * @param {!Box} b
   * @return {number} Vertical overlap in px (negative for a gap).
   */
  function verticalOverlap(a, b) {
    return Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  }

  /**
   * Whether two boxes lie on the same text line: they overlap vertically by
   * at least CONFIG.lineOverlap of the smaller height.
   * @param {!Box} a
   * @param {!Box} b
   * @return {boolean}
   */
  function onSameLine(a, b) {
    const height = Math.min(a.bottom - a.top, b.bottom - b.top);
    return height > 0 && verticalOverlap(a, b) >= height * CONFIG.lineOverlap;
  }

  /**
   * Whether two lines are the same visual line: on the same line and
   * overlapping horizontally. Lines side by side (e.g. a term and its
   * definition laid out in a row) are different lines.
   * @param {!Box} a
   * @param {!Box} b
   * @return {boolean}
   */
  function isSameVisualLine(a, b) {
    return onSameLine(a, b) &&
        Math.min(a.right, b.right) > Math.max(a.left, b.left);
  }

  /**
   * Groups the client rects of a run of text into visual lines. Inline
   * elements such as links and emphasis split a line into several rects;
   * they are merged. Empty rects and unusually tall ones (drop caps) are
   * ignored. In a block split by CSS columns, only rects of the same column
   * are merged. Rects come in document order, so a rect belongs to one of
   * the latest lines of its column: the search runs backwards and stops at
   * the first line of the column that lies completely above the rect, which
   * keeps long text nodes (thousands of lines) linear.
   * @param {!Array<!Fragment>} rects Fragment rects in document order.
   * @param {!Array<!Box>=} columns Content boxes of the block.
   * @return {!Array<!Line>} Lines in reading order: by column, then from top
   *     to bottom.
   */
  function groupRectsIntoLines(rects, columns = []) {
    const usable = rects.filter(
        (rect) => rect.right > rect.left && rect.bottom > rect.top);
    if (!usable.length) return [];
    const heights = usable.map((rect) => rect.bottom - rect.top)
        .sort((a, b) => a - b);
    const maxHeight =
        heights[Math.floor(heights.length / 2)] * CONFIG.outlierHeight;
    /** @type {!Array<!Line>} */
    const lines = [];
    for (const rect of usable) {
      if (usable.length >= 3 && rect.bottom - rect.top > maxHeight) continue;
      const column =
          columns.length > 1 ? Math.max(0, pickColumnIndex(columns, rect)) : 0;
      /** @type {?Line} */
      let line = null;
      for (let index = lines.length - 1; index >= 0; index--) {
        const candidate = lines[index];
        if (candidate.column !== column) continue;
        if (onSameLine(candidate, rect)) {
          line = candidate;
          break;
        }
        if (candidate.bottom <= rect.top) break;
      }
      if (line) {
        line.top = Math.min(line.top, rect.top);
        line.bottom = Math.max(line.bottom, rect.bottom);
        line.left = Math.min(line.left, rect.left);
        line.right = Math.max(line.right, rect.right);
      } else {
        lines.push({...rect, column});
      }
    }
    return lines.sort((a, b) => a.column - b.column || a.top - b.top);
  }

  /**
   * @param {!Array<!Line>} lines In reading order.
   * @param {number} y
   * @param {number=} column Only lines of this column; -1 for all.
   * @return {number} Index of the line closest to y, -1 without lines.
   */
  function nearestLineIndex(lines, y, column = -1) {
    let best = -1;
    let bestDistance = Infinity;
    lines.forEach((line, index) => {
      if (column >= 0 && line.column !== column) return;
      const distance = Math.max(line.top - y, y - line.bottom, 0);
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    });
    return best;
  }

  /**
   * Vertical padding of the highlight for a line.
   * @param {!Box} line
   * @return {number}
   */
  function paddingY(line) {
    const {yShare, yMin, yMax} = CONFIG.padding;
    return clamp((line.bottom - line.top) * yShare, yMin, yMax);
  }

  /**
   * Finds the line at a click position. A line covers its highlight padding
   * and half of the gap to its neighbors in the same column, so a click
   * between two lines of a paragraph still hits one of them.
   * @param {!Array<!Line>} lines In reading order.
   * @param {number} y
   * @param {number=} column Only lines of this column; -1 for all.
   * @return {number} Line index, -1 if y is outside every line.
   */
  function lineIndexAt(lines, y, column = -1) {
    let best = -1;
    let bestDistance = Infinity;
    lines.forEach((line, index) => {
      if (column >= 0 && line.column !== column) return;
      const above = lines[index - 1];
      const below = lines[index + 1];
      const pad = paddingY(line);
      const gapAbove = above && above.column === line.column ?
          (line.top - above.bottom) / 2 :
          0;
      const gapBelow = below && below.column === line.column ?
          (below.top - line.bottom) / 2 :
          0;
      const top = line.top - Math.max(pad, gapAbove);
      const bottom = line.bottom + Math.max(pad, gapBelow);
      if (y < top || y > bottom) return;
      const distance = Math.max(line.top - y, y - line.bottom, 0);
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    });
    return best;
  }

  /**
   * Picks the line to enter when moving into a new segment: its first line
   * when moving down, its last when moving up. Lines that coincide with the
   * current line are skipped. If the segment continues the current block
   * (its next text nodes), a line at the height of the current one in the
   * same column is the rest of that line, even without horizontal overlap.
   * @param {!Array<!Line>} lines In reading order.
   * @param {?Line} current
   * @param {number} direction 1 (down) or -1 (up).
   * @param {boolean=} sameBlock Whether the segment continues the block of
   *     the current line.
   * @return {number} Line index or -1.
   */
  function pickEntryLine(lines, current, direction, sameBlock = false) {
    for (let step = 0; step < lines.length; step++) {
      const index = direction > 0 ? step : lines.length - 1 - step;
      const line = lines[index];
      const coincides = !!current && (sameBlock ?
          line.column === current.column && onSameLine(line, current) :
          isSameVisualLine(line, current));
      if (!coincides) return index;
    }
    return -1;
  }

  /**
   * Picks the box of a block that contains a line or point. A block split
   * across CSS columns has several boxes.
   * @param {!Array<!Box>} boxes Content boxes of the block.
   * @param {!Box} line
   * @return {number} Index of the box, -1 without usable boxes.
   */
  function pickColumnIndex(boxes, line) {
    let best = -1;
    let bestDistance = Infinity;
    boxes.forEach((box, index) => {
      if (box.right <= box.left) return;
      const gapY = Math.max(0, -verticalOverlap(box, line));
      const gapX = Math.max(0,
          Math.max(box.left, line.left) - Math.min(box.right, line.right));
      // A box at the height of the line wins over one beside it.
      const distance = gapY * 1000 + gapX;
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    });
    return best;
  }

  /**
   * Computes the highlight: as wide as the text column, as high as the line,
   * plus padding. It ends before floating elements beside the line (an
   * image, an infobox), which shorten the line but not its column.
   * @param {!Box} line
   * @param {?Span} column
   * @param {!Array<!Box>=} obstacles Floating elements in the column.
   * @return {!Placement} In the coordinates of the input.
   */
  function overlayBox(line, column, obstacles = []) {
    const padY = paddingY(line);
    let left = Math.min(column ? column.left : line.left, line.left) -
        CONFIG.padding.x;
    let right = Math.max(column ? column.right : line.right, line.right) +
        CONFIG.padding.x;
    for (const obstacle of obstacles) {
      if (verticalOverlap(obstacle, line) <= 0) continue;
      if (obstacle.left >= line.right) {
        right = Math.min(right,
            Math.max(obstacle.left, line.right + CONFIG.padding.x));
      } else if (obstacle.right <= line.left) {
        left = Math.max(left,
            Math.min(obstacle.right, line.left - CONFIG.padding.x));
      }
    }
    return {
      top: line.top - padY,
      left,
      width: right - left,
      height: line.bottom - line.top + 2 * padY,
    };
  }

  /**
   * Smallest index in [low, high) for which a monotonic predicate holds.
   * @param {number} low
   * @param {number} high
   * @param {(index: number) => boolean} predicate
   * @return {number} high if it holds nowhere.
   */
  function findFirst(low, high, predicate) {
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (predicate(middle)) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }
    return low;
  }

  /**
   * @param {string} text
   * @param {number} from
   * @return {number} Index of the first non-white-space character at or after
   *     from; from itself if there is none.
   */
  function firstNonSpace(text, from) {
    for (let index = from; index < text.length; index++) {
      if (!/\s/.test(text[index])) return index;
    }
    return Math.max(0, Math.min(from, text.length - 1));
  }

  /**
   * Finds the first visible character of a line within a text node that
   * spans several lines, by binary search over the character positions.
   * Collapsed white space has no rect; it is judged by the next visible
   * character, which keeps the search predicate monotonic.
   * @param {number} length Length of the text.
   * @param {(index: number) => ?Box} rectAt Rect of a character, null if it
   *     is not rendered.
   * @param {!Line} line
   * @param {!Array<!Box>} columns Content boxes of the block.
   * @return {number} Offset of the character; length if there is none.
   */
  function lineStartOffset(length, rectAt, line, columns) {
    /**
     * @param {number} from
     * @return {?{index: number, rect: !Box}} First rendered character at or
     *     after from.
     */
    const visibleFrom = (from) => {
      for (let index = from; index < length; index++) {
        const rect = rectAt(index);
        if (rect) return {index, rect};
      }
      return null;
    };
    const start = findFirst(0, length, (index) => {
      const visible = visibleFrom(index);
      if (!visible) return true;
      const column = columns.length > 1 ?
          Math.max(0, pickColumnIndex(columns, visible.rect)) :
          0;
      if (column !== line.column) return column > line.column;
      return (visible.rect.top + visible.rect.bottom) / 2 >= line.top;
    });
    const visible = visibleFrom(start);
    return visible ? visible.index : length;
  }

  /**
   * @param {!Box} line
   * @param {!Band} band
   * @return {boolean} Whether the line lies completely outside the band.
   */
  function isOutsideBand(line, band) {
    return line.bottom <= band.top || line.top >= band.bottom;
  }

  /**
   * @param {!Box} line
   * @param {!Band} band
   * @return {boolean} Whether the line lies completely inside the band.
   */
  function isInsideBand(line, band) {
    return line.top >= band.top && line.bottom <= band.bottom;
  }

  /**
   * Heights at which to look for a visible line: from the top of the band
   * downwards, or from its bottom upwards.
   * @param {!Band} band
   * @param {number} step
   * @param {number} direction 1 (from the top) or -1 (from the bottom).
   * @return {!Array<number>}
   */
  function probeHeights(band, step, direction) {
    const heights = [];
    for (let y = band.top + step / 2; y < band.bottom; y += step) {
      heights.push(y);
    }
    return direction > 0 ? heights : heights.reverse();
  }

  /**
   * Finds fixed and sticky elements at the top and bottom edges of a view.
   * Rows of points are probed from each edge inwards: a row continues past
   * the elements it hits (a header needs one row, not one per probeStep),
   * and the scan of an edge stops after CONFIG.obstruction.freeRows rows
   * without such an element, or at the probe share of the view. Elements
   * that cover more than maxHeightShare of the view (layout shells) do not
   * count as hits.
   * @param {!Band} view
   * @param {!Array<number>} xs Horizontal positions of the probes in a row.
   * @param {(x: number, y: number) => ?Box} hitAt Box of the fixed or stuck
   *     element covering a point, null if there is none.
   * @return {!Array<!Box>}
   */
  function probeEdges(view, xs, hitAt) {
    const {probeStep, topProbe, bottomProbe, freeRows, maxHeightShare} =
        CONFIG.obstruction;
    const height = view.bottom - view.top;
    /** @type {!Array<!Box>} */
    const boxes = [];
    /**
     * @param {number} start
     * @param {number} limit
     * @param {number} direction 1 (downwards from the top edge) or -1.
     */
    const scan = (start, limit, direction) => {
      let free = 0;
      for (let y = start; direction > 0 ? y < limit : y > limit;) {
        let next = y + direction * probeStep;
        let hit = false;
        for (const x of xs) {
          const box = hitAt(x, y);
          if (!box || box.bottom - box.top > height * maxHeightShare) continue;
          hit = true;
          boxes.push(box);
          next = direction > 0 ?
              Math.max(next, box.bottom + 1) :
              Math.min(next, box.top - 1);
        }
        free = hit ? 0 : free + 1;
        if (free >= freeRows) break;
        y = next;
      }
    };
    scan(view.top + 1, view.top + height * topProbe, 1);
    scan(view.bottom - 2, view.bottom - height * bottomProbe, -1);
    return boxes;
  }

  /**
   * Determines the part of a view not covered by fixed or sticky headers and
   * footers. Only elements that overlap the text column horizontally count.
   * @param {!Array<!Box>} boxes Fixed and sticky elements.
   * @param {!Band} view Visible part of the scroll container.
   * @param {!Span} column Horizontal extent of the text.
   * @return {!Band}
   */
  function uncoveredBand(boxes, view, column) {
    const height = view.bottom - view.top;
    const {edgeShare, maxHeightShare, minBandShare} = CONFIG.obstruction;
    let top = view.top;
    let bottom = view.bottom;
    for (const box of boxes) {
      const boxHeight = box.bottom - box.top;
      if (boxHeight <= 0 || boxHeight > height * maxHeightShare) continue;
      if (box.right <= column.left || box.left >= column.right) continue;
      if (box.top <= view.top + height * edgeShare && box.bottom > view.top) {
        top = Math.max(top, box.bottom);
      } else if (box.bottom >= view.bottom - height * edgeShare &&
          box.top < view.bottom) {
        bottom = Math.min(bottom, box.top);
      }
    }
    if (bottom - top < height * minBandShare) return {...view};
    return {top, bottom};
  }

  /**
   * Scroll position that centers a line in the uncovered band, clamped to
   * the scroll range: near the start and end of the document the line is
   * scrolled as far as possible.
   * @param {!ScrollInput} input Line and band in viewport coordinates.
   * @return {number} New scrollTop.
   */
  function computeScrollTarget(input) {
    const lineCenter = (input.lineTop + input.lineBottom) / 2;
    const bandCenter = (input.bandTop + input.bandBottom) / 2;
    const target = input.scrollTop + lineCenter - bandCenter;
    return Math.round(clamp(target, 0, Math.max(0, input.maxScrollTop)));
  }

  /**
   * @param {string} href
   * @return {string} The URL without its fragment: jumping to an anchor on
   *     the same page keeps the page.
   */
  function withoutHash(href) {
    const index = href.indexOf('#');
    return index < 0 ? href : href.slice(0, index);
  }

  /**
   * Adds a site to or removes it from the list of disabled sites. Setting
   * the state explicitly (instead of toggling it) keeps a menu command of a
   * tab with an outdated state from doing the opposite of its caption.
   * @param {!Array<string>} sites
   * @param {string} site
   * @param {boolean} listed Whether the site should be in the list.
   * @return {!Array<string>} New list.
   */
  function withSite(sites, site, listed) {
    const others = sites.filter((entry) => entry !== site);
    return listed ? [...others, site] : others;
  }

  /**
   * @param {string} writingMode Computed writing-mode.
   * @return {boolean} Whether text runs in horizontal lines; the ruler
   *     handles only those.
   */
  function isHorizontalWritingMode(writingMode) {
    return !writingMode || writingMode === 'horizontal-tb' ||
        writingMode === 'lr' || writingMode === 'lr-tb' ||
        writingMode === 'rl' || writingMode === 'rl-tb';
  }

  /**
   * @param {*} value Stored value.
   * @return {!Array<string>}
   */
  function sanitizeSites(value) {
    return Array.isArray(value) ?
        value.filter((entry) => typeof entry === 'string') :
        [];
  }

  /** The pure functions, for unit tests. */
  const CORE = Object.freeze({
    config: CONFIG,
    onSameLine,
    isSameVisualLine,
    groupRectsIntoLines,
    nearestLineIndex,
    lineIndexAt,
    pickEntryLine,
    pickColumnIndex,
    overlayBox,
    findFirst,
    firstNonSpace,
    lineStartOffset,
    isOutsideBand,
    isInsideBand,
    probeHeights,
    probeEdges,
    uncoveredBand,
    computeScrollTarget,
    withoutHash,
    withSite,
    isHorizontalWritingMode,
    sanitizeSites,
  });

  // Unit tests (tests/*.test.js) load this file with a hook instead of running
  // it on a page. Everything above is free of DOM, storage and network access,
  // so the script stops here.
  if (typeof globalThis.readingRulerTestHook === 'function') {
    globalThis.readingRulerTestHook(CORE);
    return;
  }

  // ===========================================================================
  // State
  // ===========================================================================

  // Script managers provide GM_* as local identifiers, not necessarily as
  // window properties.
  /* global GM_getValue, GM_setValue, GM_registerMenuCommand,
     GM_addValueChangeListener */

  if (!document.body) return;

  /**
   * @typedef {{host: !HTMLElement, ruler: !HTMLElement,
   *     controls: !HTMLElement}} Ui
   */

  /**
   * Mutable state of the script.
   * @typedef {Object} State
   * @property {boolean} enabled Whether the input listeners are attached.
   * @property {?Anchor} anchor The selected line, as the text position of
   *     its start.
   * @property {?Ui} ui Highlight and touch controls, created on first use.
   * @property {?Placement} placement Current position of the highlight.
   * @property {?{block: !Element, value: string}} signature Layout of the
   *     selected block when the highlight was placed (see layoutSignature).
   * @property {?{x: number, y: number, type: string}} pointerDown Last
   *     pointer press, to tell clicks from drags.
   * @property {?{element: ?Element, key: string, time: number}} root
   *     Detected content root (null on pages without article-like content)
   *     with the page it belongs to and the time of detection.
   * @property {boolean} rootDirty Whether the DOM changed since the content
   *     root was detected.
   * @property {?MutationObserver} rootWatcher Sets rootDirty.
   * @property {boolean} refreshPending
   * @property {?ResizeObserver} resizeObserver
   * @property {?MutationObserver} mutationObserver
   * @property {?Element} observedBlock Selected block, observed for resizes.
   * @property {?Element} observedRoot Content root, observed for mutations.
   */

  /** @type {!State} */
  const state = {
    enabled: false,
    anchor: null,
    ui: null,
    placement: null,
    signature: null,
    pointerDown: null,
    root: null,
    rootDirty: false,
    rootWatcher: null,
    refreshPending: false,
    resizeObserver: null,
    mutationObserver: null,
    observedBlock: null,
    observedRoot: null,
  };

  // Content detection (lib/content-detection.js). Its caches only live for
  // one click, key press or refresh: page styles can change at any time.
  const detector = ContentDetection.createDetector({
    codeBlocks: 'text',
    skipAriaHidden: false,
    skipFootnoteReferences: false,
    skipDataTables: false,
    skippedNames: [],
    requireBlockLikeRoot: true,
  });

  /** Starts an operation with fresh caches. */
  function beginOperation() {
    detector.resetCaches();
  }

  // ===========================================================================
  // Classifying elements and text
  // ===========================================================================

  // Clicks on these keep their normal behavior.
  const INTERACTIVE_SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'label', 'summary',
    'option', 'audio', 'video', 'iframe', 'object', 'embed', '[role="button"]',
    '[role="link"]', '[role="menuitem"]', '[role="tab"]', '[role="checkbox"]',
    '[role="radio"]', '[role="switch"]', '[role="option"]',
    '[contenteditable]:not([contenteditable="false"])',
  ].join(', ');
  // Focused widgets that use the arrow keys themselves.
  const ARROW_WIDGET_SELECTOR = [
    '[role="slider"]', '[role="listbox"]', '[role="menu"]', '[role="menubar"]',
    '[role="tablist"]', '[role="grid"]', '[role="tree"]', '[role="treegrid"]',
    '[role="radiogroup"]', '[role="combobox"]', '[role="spinbutton"]',
    '[role="scrollbar"]', '[role="textbox"]', '[role="searchbox"]',
    '[role="application"]', 'audio', 'video',
  ].join(', ');
  // Open dialogs, modal or not.
  const DIALOG_SELECTOR = [
    'dialog[open]', '[role="dialog"]', '[role="alertdialog"]',
    '[aria-modal="true"]',
  ].join(', ');
  const MEDIA_TAGS = new Set(['img', 'picture', 'svg', 'video', 'canvas',
    'audio', 'iframe', 'object', 'embed']);

  /**
   * Cached getComputedStyle (cleared by beginOperation).
   * @param {!Element} element
   * @return {!CSSStyleDeclaration}
   */
  function styleOf(element) {
    return detector.styleOf(element);
  }

  /**
   * @param {!Element} element
   * @return {string} Why the element's subtree has no body text: 'hard'
   *     (landmark, control, hidden, fixed …), 'name' (only its ID or classes
   *     suggest so) or '' if it may contain body text.
   */
  function exclusionOf(element) {
    return detector.exclusionOf(element);
  }

  /**
   * Returns the block (paragraph, list item, heading …) whose lines contain a
   * text node, or null if the text is not selectable: blank, outside the
   * content root, in an excluded element, in a link-heavy block or in a
   * vertical writing mode. Text outside every block tag (a <div> with <br>,
   * a table cell, <pre>) belongs to its nearest block-like ancestor.
   * @param {!Text} text
   * @param {!Element} root
   * @return {?Element}
   */
  function blockOf(text, root) {
    const block = detector.blockOf(text, root);
    return block && isHorizontalWritingMode(styleOf(block).writingMode) ?
        block :
        null;
  }

  // ===========================================================================
  // Content root (Readability-like heuristics, lib/content-detection.js)
  // ===========================================================================

  /**
   * Marks the content root as outdated on the next change of the DOM. The
   * observer disconnects itself after the first change, so a page that is
   * not being read costs nothing.
   */
  function watchRoot() {
    state.rootDirty = false;
    let watcher = state.rootWatcher;
    if (!watcher) {
      const observer = new MutationObserver(() => {
        state.rootDirty = true;
        observer.disconnect();
      });
      state.rootWatcher = observer;
      watcher = observer;
    }
    watcher.observe(/** @type {!HTMLElement} */ (document.body),
        {childList: true, subtree: true});
  }

  /**
   * Returns the main content element, detected once per page. It is
   * detected again after it was removed, and on request if the DOM changed
   * since (at most once per CONFIG.redetectInterval).
   * @param {boolean} redetect Detect again if the DOM changed.
   * @return {?Element} null if the page has no article-like content.
   */
  function contentRoot(redetect) {
    const key = withoutHash(location.href);
    const cached = state.root;
    if (cached && cached.key === key &&
        (!cached.element || cached.element.isConnected) &&
        !(redetect && state.rootDirty &&
          Date.now() - cached.time >= CONFIG.redetectInterval)) {
      return cached.element;
    }
    const element = detector.findRoot();
    state.root = {element, key, time: Date.now()};
    watchRoot();
    return element;
  }

  // ===========================================================================
  // Segments and lines
  // ===========================================================================

  /**
   * Walks the selectable text nodes of the content root in document order.
   * Excluded subtrees are skipped as a whole.
   * @param {!Element} root
   * @return {!TreeWalker}
   */
  function createWalker(root) {
    return document.createTreeWalker(
        root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, (node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            return blockOf(/** @type {!Text} */ (node), root) ?
                NodeFilter.FILTER_ACCEPT :
                NodeFilter.FILTER_SKIP;
          }
          return exclusionOf(/** @type {!Element} */ (node)) ?
              NodeFilter.FILTER_REJECT :
              NodeFilter.FILTER_SKIP;
        });
  }

  /**
   * Collects the segment around a text node: the neighboring selectable text
   * nodes with the same block. Text of a block that is interrupted by a
   * nested block (a list inside a list item) forms separate segments, so the
   * segments follow reading order. Long blocks (highlighted code) are cut
   * into windows of CONFIG.maxSegmentTexts text nodes on each side; a
   * segment entered while moving starts (or, moving up, ends) at the text
   * node and extends twice as far in the direction of the move.
   * @param {!Text} text
   * @param {!Element} root
   * @param {number=} direction 0 to center the window on the text node, 1
   *     to start it there, -1 to end it there.
   * @return {?Segment}
   */
  function segmentAround(text, root, direction = 0) {
    const block = blockOf(text, root);
    if (!block) return null;
    const limit = CONFIG.maxSegmentTexts;
    const before = direction === 0 ? limit : (direction < 0 ? 2 * limit : 0);
    const after = direction === 0 ? limit : (direction > 0 ? 2 * limit : 0);
    const walker = createWalker(root);
    const texts = [text];
    walker.currentNode = text;
    for (let count = 0; count < before && walker.previousNode(); count++) {
      const node = /** @type {!Text} */ (walker.currentNode);
      if (blockOf(node, root) !== block) break;
      texts.unshift(node);
    }
    walker.currentNode = text;
    for (let count = 0; count < after && walker.nextNode(); count++) {
      const node = /** @type {!Text} */ (walker.currentNode);
      if (blockOf(node, root) !== block) break;
      texts.push(node);
    }
    return {block, texts};
  }

  /**
   * The segment before or after another one: the next window of the same
   * block, or the next block.
   * @param {!Segment} segment
   * @param {number} direction 1 (next) or -1 (previous).
   * @param {!Element} root
   * @return {?Segment}
   */
  function adjacentSegment(segment, direction, root) {
    const walker = createWalker(root);
    walker.currentNode = direction > 0 ?
        segment.texts[segment.texts.length - 1] :
        segment.texts[0];
    const node = direction > 0 ? walker.nextNode() : walker.previousNode();
    return node ?
        segmentAround(/** @type {!Text} */ (node), root, direction) :
        null;
  }

  /**
   * The element whose boxes form the text column of a block: the block
   * itself, or for a block displayed inline (a <dd> next to its term), whose
   * client rects are its lines, the nearest ancestor with boxes of its own.
   * @param {!Element} block
   * @return {!Element}
   */
  function columnElementOf(block) {
    /** @type {!Element} */
    let element = block;
    while (element.parentElement) {
      const display = styleOf(element).display;
      if (display !== 'inline' && display !== 'contents') break;
      element = element.parentElement;
    }
    return element;
  }

  /**
   * Content boxes of a block's text column (without padding and border), one
   * per fragment (e.g. CSS columns).
   * @param {!Element} block
   * @return {!Array<!Box>}
   */
  function contentBoxes(block) {
    const column = columnElementOf(block);
    const style = styleOf(column);
    const left = (parseFloat(style.paddingLeft) || 0) +
        (parseFloat(style.borderLeftWidth) || 0);
    const right = (parseFloat(style.paddingRight) || 0) +
        (parseFloat(style.borderRightWidth) || 0);
    return [...column.getClientRects()].map((rect) => ({
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left + left,
      right: rect.right - right,
    }));
  }

  /**
   * Measures the lines of a segment from the client rects of its text nodes
   * (one rect per line fragment).
   * @param {!Segment} segment
   * @return {!SegmentLayout}
   */
  function measureSegment(segment) {
    const range = document.createRange();
    /** @type {!Array<!Fragment>} */
    const rects = [];
    /** @type {!Array<{textIndex: number, rectIndex: number}>} */
    const fragments = [];
    segment.texts.forEach((text, textIndex) => {
      range.selectNodeContents(text);
      const list = range.getClientRects();
      for (let rectIndex = 0; rectIndex < list.length; rectIndex++) {
        const {top, bottom, left, right} = list[rectIndex];
        rects.push({top, bottom, left, right, source: fragments.length});
        fragments.push({textIndex, rectIndex});
      }
    });
    const columns = contentBoxes(segment.block);
    return {lines: groupRectsIntoLines(rects, columns), fragments, columns};
  }

  /**
   * @param {!SegmentLayout} layout
   * @param {!Box} box
   * @return {number} Column of the layout that contains the box; -1 if the
   *     block is not split into columns.
   */
  function columnAt(layout, box) {
    return layout.columns.length > 1 ?
        pickColumnIndex(layout.columns, box) :
        -1;
  }

  /**
   * Client rect of the character at an offset.
   * @param {!Range} range Reused range.
   * @param {!Text} text
   * @param {number} offset
   * @return {?DOMRect} null for collapsed white space.
   */
  function rectOfChar(range, text, offset) {
    range.setStart(text, offset);
    range.setEnd(text, offset + 1);
    const rect = range.getClientRects()[0];
    return rect && rect.width > 0 && rect.height > 0 ? rect : null;
  }

  /**
   * Client rect of the visible character closest to an offset.
   * @param {!Text} text
   * @param {number} offset
   * @return {?DOMRect}
   */
  function rectNear(text, offset) {
    const range = document.createRange();
    const length = text.data.length;
    for (let distance = 0; distance < Math.min(length, 64); distance++) {
      for (const candidate of [offset + distance, offset - distance - 1]) {
        if (candidate < 0 || candidate >= length) continue;
        const rect = rectOfChar(range, text, candidate);
        if (rect) return rect;
      }
    }
    return null;
  }

  /**
   * Text anchor at the start of a line: the first character of its first
   * fragment.
   * @param {!LineRef} ref
   * @return {!Anchor}
   */
  function anchorOf(ref) {
    const line = ref.layout.lines[ref.index];
    const fragment = ref.layout.fragments[line.source];
    const text = ref.segment.texts[fragment.textIndex];
    let offset = 0;
    if (fragment.rectIndex > 0) {
      const range = document.createRange();
      offset = lineStartOffset(text.data.length,
          (index) => rectOfChar(range, text, index), line, ref.layout.columns);
    }
    return {node: text, offset: firstNonSpace(text.data, offset)};
  }

  /**
   * Finds the line that currently contains an anchor.
   * @param {!Anchor} anchor
   * @return {?LineRef} null if the text is gone or no longer selectable.
   */
  function resolveAnchor(anchor) {
    const root = contentRoot(false);
    if (!anchor.node.isConnected || !root) return null;
    const segment = segmentAround(anchor.node, root);
    if (!segment) return null;
    const layout = measureSegment(segment);
    const rect = rectNear(anchor.node, anchor.offset);
    if (!layout.lines.length || !rect) return null;
    const y = (rect.top + rect.bottom) / 2;
    let index = nearestLineIndex(layout.lines, y, columnAt(layout, rect));
    if (index < 0) index = nearestLineIndex(layout.lines, y);
    return {segment, layout, index};
  }

  /**
   * @param {!LineRef} ref
   * @return {!Span} Horizontal extent of the line's text column.
   */
  function columnOf(ref) {
    const line = ref.layout.lines[ref.index];
    const box = ref.layout.columns[line.column];
    return box && box.right > box.left ? box : line;
  }

  // ===========================================================================
  // Highlight and touch controls (Shadow DOM, outside the page's layout)
  // ===========================================================================

  // The look of the highlight and the controls is set inline through the
  // CSSOM, which no Content Security Policy blocks: in Firefox, a script
  // manager may have to run the script as a content script on pages with a
  // strict policy, where the style sheet below can fail to apply. The sheet
  // only adds what inline styles cannot express; it overrides inline styles
  // with !important where needed.
  const RULER_STYLE = {
    'background': 'rgba(255, 196, 0, .3)',
    'border-radius': '4px',
    'box-shadow': '0 0 0 1px rgba(255, 166, 0, .55)',
    'box-sizing': 'border-box',
    'left': '0',
    'pointer-events': 'none',
    'position': 'absolute',
    'top': '0',
  };
  const CONTROLS_STYLE = {
    'align-items': 'center',
    'bottom': 'max(16px, env(safe-area-inset-bottom))',
    'display': 'none',
    'flex-direction': 'column',
    'gap': '8px',
    'pointer-events': 'auto',
    'position': 'fixed',
    'right': 'max(12px, env(safe-area-inset-right))',
  };
  const CONTROL_STYLE = {
    '-webkit-tap-highlight-color': 'transparent',
    'align-items': 'center',
    'background': 'rgba(32, 33, 36, .75)',
    'border': '1px solid rgba(255, 255, 255, .3)',
    'border-radius': '50%',
    'box-shadow': '0 2px 8px rgba(0, 0, 0, .35)',
    'color': '#fff',
    'cursor': 'pointer',
    'display': 'flex',
    'height': '44px',
    'justify-content': 'center',
    'margin': '0',
    'padding': '0',
    'touch-action': 'manipulation',
    'width': '44px',
  };
  const CLOSE_CONTROL_STYLE = {'height': '36px', 'width': '36px'};

  const STYLES = `
    .rr-animate {
      transition: top 120ms ease-out, left 120ms ease-out,
          width 120ms ease-out, height 120ms ease-out;
    }

    .rr-control:focus-visible {
      outline: 2px solid #ffc400;
      outline-offset: 2px;
    }

    @media (prefers-reduced-motion: reduce) {
      .rr-animate {
        transition: none;
      }
    }

    @media (forced-colors: active) {
      .rr-ruler {
        background: transparent !important;
        box-shadow: none !important;
        outline: 2px solid highlight;
      }
    }

    @media print {
      .rr-ruler,
      .rr-controls {
        display: none !important;
      }
    }
  `;

  /**
   * Sets inline styles.
   * @param {!HTMLElement} element
   * @param {!Object<string, string>} styles CSS property names and values.
   */
  function setStyles(element, styles) {
    for (const [name, value] of Object.entries(styles)) {
      element.style.setProperty(name, value);
    }
  }

  /**
   * Adds the style sheet to the shadow root. Constructed style sheets are
   * not blocked by a Content Security Policy without 'unsafe-inline'.
   * @param {!ShadowRoot} shadow
   */
  function applyStyles(shadow) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLES);
      shadow.adoptedStyleSheets = [sheet];
      if (shadow.adoptedStyleSheets.length) return;
    } catch {
      // Fall back to a style element below.
    }
    const style = document.createElement('style');
    style.textContent = STYLES;
    shadow.append(style);
  }

  /**
   * Creates a round icon button.
   * @param {string} label Accessible name and tooltip.
   * @param {string} path SVG path of the icon (24 × 24).
   * @param {() => void} action
   * @return {!HTMLButtonElement}
   */
  function createControl(label, path, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rr-control';
    button.title = label;
    button.setAttribute('aria-label', label);
    setStyles(button, CONTROL_STYLE);
    const svgNs = 'http://www.w3.org/2000/svg';
    const icon = document.createElementNS(svgNs, 'svg');
    // Presentation attributes, like inline styles, need no style sheet.
    const attributes = {
      'aria-hidden': 'true',
      'fill': 'none',
      'height': '22',
      'stroke': 'currentColor',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'stroke-width': '2.5',
      'viewBox': '0 0 24 24',
      'width': '22',
    };
    for (const [name, value] of Object.entries(attributes)) {
      icon.setAttribute(name, value);
    }
    const shape = document.createElementNS(svgNs, 'path');
    shape.setAttribute('d', path);
    icon.append(shape);
    button.append(icon);
    // Keep the focus and text selection of the page.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', action);
    return button;
  }

  /**
   * Creates the highlight and the controls on first use. The host is
   * appended to the root element, outside the page's body and layout.
   * @return {!Ui}
   */
  function ensureUi() {
    if (state.ui) {
      if (!state.ui.host.isConnected) {
        document.documentElement.append(state.ui.host);
      }
      return state.ui;
    }
    const host = /** @type {!HTMLElement} */ (
      document.createElement('reading-ruler'));
    host.style.cssText = 'all: initial; display: block; height: 0; left: 0; ' +
        'pointer-events: none; position: absolute; top: 0; width: 0; ' +
        'z-index: 2147483646;';
    const shadow = host.attachShadow({mode: 'closed'});
    applyStyles(shadow);
    const ruler = document.createElement('div');
    ruler.className = 'rr-ruler';
    ruler.hidden = true;
    setStyles(ruler, RULER_STYLE);
    const controls = document.createElement('div');
    controls.className = 'rr-controls';
    controls.hidden = true;
    setStyles(controls, CONTROLS_STYLE);
    const close = createControl(
        'Stop reading ruler', 'M7 7l10 10M17 7L7 17', clearSelection);
    setStyles(close, CLOSE_CONTROL_STYLE);
    controls.append(
        close,
        createControl('Previous line', 'M6 15l6-6 6 6', () => move(-1)),
        createControl('Next line', 'M6 9l6 6 6-6', () => move(1)));
    shadow.append(ruler, controls);
    document.documentElement.append(host);
    state.ui = {host, ruler, controls};
    return state.ui;
  }

  /**
   * Shows or hides the touch controls. Their display is set inline, where
   * it would override the hidden attribute.
   * @param {!HTMLElement} controls
   * @param {boolean} visible
   */
  function showControls(controls, visible) {
    controls.hidden = !visible;
    controls.style.display = visible ? 'flex' : 'none';
  }

  /**
   * @param {?Placement} a
   * @param {?Placement} b
   * @return {boolean} Whether both are equal to the pixel.
   */
  function samePlacement(a, b) {
    return !!a && !!b && Math.round(a.top) === Math.round(b.top) &&
        Math.round(a.left) === Math.round(b.left) &&
        Math.round(a.width) === Math.round(b.width) &&
        Math.round(a.height) === Math.round(b.height);
  }

  /**
   * Position of the selected block and of the anchor character relative to
   * the highlight's host. While it stays the same, the highlight is still in
   * place, and a refresh can skip measuring the lines.
   * @param {!Element} block
   * @return {string} Empty if the anchor or block is gone.
   */
  function layoutSignature(block) {
    const anchor = state.anchor;
    const ui = state.ui;
    if (!anchor || !ui || !anchor.node.isConnected || !block.isConnected) {
      return '';
    }
    const rect = rectNear(anchor.node, anchor.offset);
    if (!rect) return '';
    const origin = ui.host.getBoundingClientRect();
    const box = block.getBoundingClientRect();
    return [
      rect.top - origin.top, rect.left - origin.left, rect.width, rect.height,
      box.top - origin.top, box.left - origin.left, box.width, box.height,
    ].map((value) => Math.round(value)).join(' ');
  }

  /**
   * Floating elements (images, infoboxes) beside a line that ends well
   * before an edge of its column: probes the column's edges at the height
   * of the line. A line that is short by itself (ragged text) finds the
   * block's own background there.
   * @param {!Box} line
   * @param {!Span} column
   * @param {!Element} block
   * @return {!Array<!Box>}
   */
  function floatsBeside(line, column, block) {
    /** @type {!Array<!Box>} */
    const floats = [];
    const y = (line.top + line.bottom) / 2;
    const edges = [
      {x: column.right - 2, free: column.right - line.right},
      {x: column.left + 2, free: line.left - column.left},
    ];
    for (const {x, free} of edges) {
      if (free < CONFIG.minFloatGap) continue;
      const hit = document.elementFromPoint(x, y);
      if (!hit || block.contains(hit) || hit.contains(block)) continue;
      for (let element = /** @type {?Element} */ (hit);
        element && element !== document.body;
        element = element.parentElement) {
        if (element.contains(block)) break;
        if (styleOf(element).float !== 'none') {
          const rect = element.getBoundingClientRect();
          floats.push({top: rect.top, bottom: rect.bottom, left: rect.left,
            right: rect.right});
          break;
        }
      }
    }
    return floats;
  }

  /**
   * Moves the highlight over a line.
   * @param {!LineRef} ref
   * @param {boolean} animate Slide from the previous line.
   */
  function render(ref, animate) {
    const {host, ruler, controls} = ensureUi();
    const line = ref.layout.lines[ref.index];
    const column = columnOf(ref);
    const box = overlayBox(line, column,
        floatsBeside(line, column, ref.segment.block));
    const origin = host.getBoundingClientRect();
    /** @type {!Placement} */
    const next = {
      top: box.top - origin.top,
      left: box.left - origin.left,
      width: box.width,
      height: box.height,
    };
    if (animate && !ruler.hidden) {
      ruler.classList.add('rr-animate');
    } else if (!samePlacement(state.placement, next)) {
      // A reflow jumps; keep a running slide if nothing changed.
      ruler.classList.remove('rr-animate');
    }
    ruler.style.top = `${next.top}px`;
    ruler.style.left = `${next.left}px`;
    ruler.style.width = `${next.width}px`;
    ruler.style.height = `${next.height}px`;
    ruler.hidden = false;
    showControls(controls, matchMedia(CONFIG.touchQuery).matches);
    state.placement = next;
    const block = ref.segment.block;
    state.signature = {block, value: layoutSignature(block)};
  }

  /** Hides the highlight and the controls. */
  function hideUi() {
    state.placement = null;
    state.signature = null;
    const ui = state.ui;
    if (!ui) return;
    ui.ruler.hidden = true;
    ui.ruler.classList.remove('rr-animate');
    showControls(ui.controls, false);
  }

  // ===========================================================================
  // Scrolling
  // ===========================================================================

  /**
   * Whether an element passes its overflow on to the viewport: the body
   * does while the root element's overflow is visible (CSS Overflow 3). Its
   * computed overflow-y may then be auto, but the page scrolls, not the
   * body.
   * @param {!Element} element
   * @return {boolean}
   */
  function propagatesOverflow(element) {
    if (element !== document.body) return false;
    const root = styleOf(document.documentElement);
    return root.overflowX === 'visible' && root.overflowY === 'visible';
  }

  /**
   * @param {!Element} element
   * @return {boolean} Whether the element scrolls its content vertically.
   */
  function isScrollable(element) {
    if (propagatesOverflow(element)) return false;
    const overflow = styleOf(element).overflowY;
    return (overflow === 'auto' || overflow === 'scroll') &&
        element.scrollHeight > element.clientHeight + 1;
  }

  /**
   * Scrollable ancestors of an element, innermost first, without the page.
   * @param {!Element} element
   * @return {!Array<!Element>}
   */
  function scrollContainersOf(element) {
    const containers = [];
    for (let node = element.parentElement;
      node && node !== document.documentElement &&
          node !== document.scrollingElement;
      node = node.parentElement) {
      if (isScrollable(node)) containers.push(node);
    }
    return containers;
  }

  /**
   * Visible part of a scroll container in viewport coordinates. A container
   * outside the viewport yields its whole box: an outer container brings it
   * into view.
   * @param {?Element} scroller null for the page.
   * @return {!Band}
   */
  function viewOf(scroller) {
    if (!scroller) {
      const viewport = window.visualViewport;
      const top = viewport ? viewport.offsetTop : 0;
      const height = viewport ?
          viewport.height :
          document.documentElement.clientHeight;
      return {top, bottom: top + height};
    }
    const rect = scroller.getBoundingClientRect();
    const top = rect.top + scroller.clientTop;
    const bottom = top + scroller.clientHeight;
    const visibleTop = Math.max(top, 0);
    const visibleBottom = Math.min(bottom, window.innerHeight);
    return visibleBottom > visibleTop ?
        {top: visibleTop, bottom: visibleBottom} :
        {top, bottom};
  }

  /**
   * Whether a sticky element is stuck to (or rests at) an edge of the view,
   * where it covers the content scrolling past.
   * @param {!DOMRect} rect
   * @param {!CSSStyleDeclaration} style
   * @param {!Band} view
   * @return {boolean}
   */
  function isStuck(rect, style, view) {
    const top = parseFloat(style.top);
    const bottom = parseFloat(style.bottom);
    return (!Number.isNaN(top) && rect.top <= view.top + top + 1) ||
        (!Number.isNaN(bottom) && rect.bottom >= view.bottom - bottom - 1);
  }

  /**
   * Finds the fixed or stuck sticky element that covers a point: the
   * topmost element there or its nearest such ancestor. An element covered
   * by another one hides nothing.
   * @param {number} x
   * @param {number} y
   * @param {!Band} view
   * @return {?Box}
   */
  function pinnedBoxAt(x, y, view) {
    const host = state.ui ? state.ui.host : null;
    let element = document.elementFromPoint(x, y);
    if (host && element === host) {
      // The touch controls are on top: look below them.
      element = document.elementsFromPoint(x, y)
          .find((candidate) => candidate !== host) || null;
    }
    for (; element && element !== document.documentElement;
      element = element.parentElement) {
      const style = styleOf(element);
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;
      const rect = element.getBoundingClientRect();
      if (style.position === 'fixed' || isStuck(rect, style, view)) {
        return rect;
      }
    }
    return null;
  }

  /**
   * Finds fixed and stuck sticky elements near the top and bottom of a view
   * by probing points along the text column.
   * @param {!Band} view
   * @param {!Span} column
   * @return {!Array<!Box>}
   */
  function findObstructions(view, column) {
    const maxX = document.documentElement.clientWidth - 2;
    const xs = [column.left + 8, (column.left + column.right) / 2,
      column.right - 8].map((x) => clamp(x, 1, maxX));
    return probeEdges(view, xs, (x, y) => pinnedBoxAt(x, y, view));
  }

  /**
   * Part of a scroll container's view not covered by fixed or sticky
   * headers and footers.
   * @param {?Element} scroller null for the page.
   * @param {!Span} column
   * @return {!Band}
   */
  function visibleBand(scroller, column) {
    const view = viewOf(scroller);
    return uncoveredBand(findObstructions(view, column), view, column);
  }

  /**
   * Scrolls so that a line is centered in the part of the view that is not
   * covered by fixed or sticky headers and footers. Nested scroll containers
   * are scrolled from the innermost to the page, so that each one brings
   * the inner ones into view. Smooth scrolling has not moved anything when
   * the next container is computed, so the line's position is tracked.
   * @param {!LineRef} ref
   */
  function centerLine(ref) {
    const line = ref.layout.lines[ref.index];
    const column = columnOf(ref);
    const page = document.scrollingElement || document.documentElement;
    const behavior =
        matchMedia(CONFIG.reducedMotionQuery).matches ? 'instant' : 'smooth';
    let shift = 0;
    for (const scroller of [...scrollContainersOf(ref.segment.block), null]) {
      const band = visibleBand(scroller, column);
      const target = scroller || page;
      const top = computeScrollTarget({
        lineTop: line.top - shift,
        lineBottom: line.bottom - shift,
        bandTop: band.top,
        bandBottom: band.bottom,
        scrollTop: target.scrollTop,
        maxScrollTop: target.scrollHeight - target.clientHeight,
      });
      const delta = top - target.scrollTop;
      if (Math.abs(delta) < 1) continue;
      if (scroller) {
        scroller.scrollTo({top, behavior});
      } else {
        window.scrollTo({top, left: window.scrollX, behavior});
      }
      shift += delta;
    }
  }

  // ===========================================================================
  // Selection
  // ===========================================================================

  /**
   * Selects a line and keeps it highlighted.
   * @param {!LineRef} ref
   * @param {boolean} animate
   */
  function selectLine(ref, animate) {
    state.anchor = anchorOf(ref);
    render(ref, animate);
    startTracking(ref.segment.block);
  }

  /** Removes the selection. */
  function clearSelection() {
    state.anchor = null;
    hideUi();
    stopTracking();
  }

  /**
   * @param {number} x
   * @param {number} y
   * @return {?Text} Text node at a point.
   */
  function textAtPoint(x, y) {
    const position = document.caretPositionFromPoint(x, y);
    const node = position && position.offsetNode;
    return node && node.nodeType === Node.TEXT_NODE ?
        /** @type {!Text} */ (node) :
        null;
  }

  /**
   * Finds the selectable line of a text node at a point.
   * @param {!Text} text
   * @param {!Element} root
   * @param {number} x
   * @param {number} y
   * @return {?LineRef} null if the point is beside the text column.
   */
  function lineOfText(text, root, x, y) {
    const segment = segmentAround(text, root);
    if (!segment) return null;
    const layout = measureSegment(segment);
    const point = {top: y, bottom: y, left: x, right: x};
    const index = lineIndexAt(layout.lines, y, columnAt(layout, point));
    if (index < 0) return null;
    const ref = {segment, layout, index};
    const column = columnOf(ref);
    if (x < column.left - CONFIG.padding.x ||
        x > column.right + CONFIG.padding.x) {
      return null;
    }
    return ref;
  }

  /**
   * Finds the selectable line at a click position.
   * @param {number} x
   * @param {number} y
   * @param {!Element} target Element under the pointer.
   * @return {?LineRef}
   */
  function lineAtPoint(x, y, target) {
    if (MEDIA_TAGS.has(target.localName)) return null;
    const text = textAtPoint(x, y);
    const parent = text && text.parentElement;
    if (!text || !parent ||
        !(target.contains(text) || parent.contains(target))) {
      return null;
    }
    let root = contentRoot(false);
    if (!root || !root.contains(text)) {
      // The content may have changed since the root was detected.
      root = contentRoot(true);
    }
    return root ? lineOfText(text, root, x, y) : null;
  }

  /**
   * If the selected line was scrolled out of view, finds the line to
   * continue with instead: the first line fully in view when moving down,
   * the last one when moving up.
   * @param {!LineRef} current
   * @param {!Element} root
   * @param {number} direction 1 (down) or -1 (up).
   * @return {?LineRef} null if the selected line is in view or no line is.
   */
  function lineInViewInstead(current, root, direction) {
    const scroller = scrollContainersOf(current.segment.block)[0] || null;
    // A line still in the view is moved from as usual, even if a fixed
    // header covers it. Only probing for a visible line needs the headers.
    const line = current.layout.lines[current.index];
    if (!isOutsideBand(line, viewOf(scroller))) return null;
    const column = columnOf(current);
    const band = visibleBand(scroller, column);
    const x = clamp((column.left + column.right) / 2, 1,
        document.documentElement.clientWidth - 2);
    for (const y of probeHeights(band, CONFIG.visibleLineProbe, direction)) {
      const text = textAtPoint(x, y);
      const ref = text && lineOfText(text, root, x, y);
      if (ref && isInsideBand(ref.layout.lines[ref.index], band)) return ref;
    }
    return null;
  }

  /**
   * Moves the selection to the next or previous line in reading order,
   * across paragraphs, lists and headings, and centers it. If the selected
   * line was scrolled out of view, a visible line is selected instead.
   * @param {number} direction 1 (down) or -1 (up).
   */
  function move(direction) {
    const anchor = state.anchor;
    if (!anchor) return;
    beginOperation();
    const current = resolveAnchor(anchor);
    const root = contentRoot(false);
    if (!current || !root) {
      clearSelection();
      return;
    }
    const visible = lineInViewInstead(current, root, direction);
    if (visible) {
      // The reader scrolled on: continue there without moving the page.
      selectLine(visible, false);
      return;
    }
    /** @type {?LineRef} */
    let target = null;
    const index = current.index + direction;
    if (index >= 0 && index < current.layout.lines.length) {
      target = {...current, index};
    } else {
      const line = current.layout.lines[current.index];
      let segment = current.segment;
      for (let scanned = 0; scanned < CONFIG.maxSegmentScan; scanned++) {
        const next = adjacentSegment(segment, direction, root);
        if (!next) break;
        segment = next;
        const layout = measureSegment(segment);
        const entry = pickEntryLine(layout.lines, line, direction,
            segment.block === current.segment.block);
        if (entry >= 0) {
          target = {segment, layout, index: entry};
          break;
        }
      }
    }
    if (target) {
      selectLine(target, true);
      centerLine(target);
    } else {
      // Start or end of the content: keep the line and bring it into view.
      render(current, false);
      centerLine(current);
    }
  }

  /**
   * Updates the highlight after a reflow (resize, zoom, fonts, content).
   * Skips measuring while the selected block and anchor have not moved.
   */
  function refresh() {
    const anchor = state.anchor;
    if (!anchor) return;
    const saved = state.signature;
    if (saved && saved.value && saved.value === layoutSignature(saved.block)) {
      return;
    }
    beginOperation();
    const ref = resolveAnchor(anchor);
    if (ref) {
      render(ref, false);
      observeSelection(ref.segment.block);
    } else {
      clearSelection();
    }
  }

  // ===========================================================================
  // Tracking reflows while a line is selected
  // ===========================================================================

  /** Refreshes the highlight in the next animation frame. */
  function scheduleRefresh() {
    if (state.refreshPending) return;
    state.refreshPending = true;
    requestAnimationFrame(() => {
      state.refreshPending = false;
      refresh();
    });
  }

  /**
   * Inner scroll containers move the text without moving the highlight.
   * @param {!Event} event
   */
  function onScroll(event) {
    if (event.target !== document) scheduleRefresh();
  }

  /**
   * Observes the content root for mutations and the selected block for
   * resizes. Mutations elsewhere (ads, tickers) do not cause refreshes;
   * if they move the content, the page's size changes.
   * @param {!Element} block
   */
  function observeSelection(block) {
    const {resizeObserver, mutationObserver} = state;
    if (!resizeObserver || !mutationObserver) return;
    const root = contentRoot(false) || document.body;
    if (root !== state.observedRoot) {
      mutationObserver.disconnect();
      mutationObserver.observe(root,
          {childList: true, subtree: true, characterData: true});
      state.observedRoot = root;
    }
    if (block === state.observedBlock) return;
    const observed = state.observedBlock;
    // The root element and body are observed all the time.
    if (observed && observed !== document.documentElement &&
        observed !== document.body) {
      resizeObserver.unobserve(observed);
    }
    resizeObserver.observe(block);
    state.observedBlock = block;
  }

  /**
   * Starts listening for everything that can move the selected line.
   * @param {!Element} block
   */
  function startTracking(block) {
    if (!state.resizeObserver) {
      state.resizeObserver = new ResizeObserver(scheduleRefresh);
      state.resizeObserver.observe(document.documentElement);
      state.resizeObserver.observe(
          /** @type {!HTMLElement} */ (document.body));
      state.mutationObserver = new MutationObserver(scheduleRefresh);
      window.addEventListener('resize', scheduleRefresh);
      document.addEventListener('scroll', onScroll, {capture: true,
        passive: true});
      // Images and details elements change the layout without a mutation.
      document.addEventListener('load', scheduleRefresh, true);
      document.addEventListener('toggle', scheduleRefresh, true);
      document.fonts?.addEventListener('loadingdone', scheduleRefresh);
    }
    observeSelection(block);
  }

  /** Stops listening for reflows. */
  function stopTracking() {
    if (!state.resizeObserver) return;
    state.resizeObserver.disconnect();
    state.mutationObserver?.disconnect();
    state.resizeObserver = null;
    state.mutationObserver = null;
    state.observedBlock = null;
    state.observedRoot = null;
    window.removeEventListener('resize', scheduleRefresh);
    document.removeEventListener('scroll', onScroll, true);
    document.removeEventListener('load', scheduleRefresh, true);
    document.removeEventListener('toggle', scheduleRefresh, true);
    document.fonts?.removeEventListener('loadingdone', scheduleRefresh);
  }

  // ===========================================================================
  // Input
  // ===========================================================================

  /** @param {!PointerEvent} event */
  function onPointerDown(event) {
    state.pointerDown =
        {x: event.clientX, y: event.clientY, type: event.pointerType};
  }

  /**
   * @param {!MouseEvent} event
   * @return {boolean} Whether the pointer moved between press and click,
   *     i.e. the user dragged to select text.
   */
  function wasDragged(event) {
    const down = state.pointerDown;
    if (!down) return false;
    const limit = down.type === 'mouse' ?
        CONFIG.dragDistance.mouse :
        CONFIG.dragDistance.touch;
    return Math.hypot(event.clientX - down.x, event.clientY - down.y) > limit;
  }

  /** @return {boolean} Whether text is selected on the page. */
  function hasTextSelection() {
    const selection = window.getSelection();
    return !!selection && !selection.isCollapsed &&
        selection.toString().trim() !== '';
  }

  /**
   * Selects the line under a click or tap, or clears the selection when the
   * click hits no body text. Clicks dispatched by the page's scripts are
   * ignored.
   * @param {!MouseEvent} event
   */
  function onClick(event) {
    if (!event.isTrusted || event.button !== 0 || event.detail > 1 ||
        event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) {
      return;
    }
    if (state.ui && event.composedPath().includes(state.ui.host)) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest(INTERACTIVE_SELECTOR)) {
      return;
    }
    if (wasDragged(event) || hasTextSelection()) return;
    beginOperation();
    const ref = lineAtPoint(event.clientX, event.clientY, target);
    if (ref) {
      selectLine(ref, false);
    } else if (state.anchor) {
      clearSelection();
    }
  }

  /**
   * @param {!Element} element
   * @return {?Element} The element or its nearest ancestor that scrolls
   *     vertically; the arrow keys scroll it while the element has focus.
   */
  function scrollRegionOf(element) {
    if (isScrollable(element)) return element;
    return scrollContainersOf(element)[0] || null;
  }

  /**
   * Whether the keys belong to the focused element: an editable field, a
   * widget that uses the arrow keys itself, or a dialog or scroll region
   * the reader moved the focus to, away from the selected line (a modal
   * dialog in front of the text, a code block to scroll).
   * @param {!KeyboardEvent} event
   * @return {boolean}
   */
  function isFocusInControl(event) {
    let active = document.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    const origin = event.composedPath()[0];
    const selected = state.anchor ? state.anchor.node : null;
    for (const node of [active, origin]) {
      if (!(node instanceof Element)) continue;
      if (['input', 'textarea', 'select'].includes(node.localName) ||
          (node instanceof HTMLElement && node.isContentEditable) ||
          node.closest(ARROW_WIDGET_SELECTOR)) {
        return true;
      }
      for (const region of [node.closest(DIALOG_SELECTOR),
        scrollRegionOf(node)]) {
        if (region && !(selected && region.contains(selected))) return true;
      }
    }
    return false;
  }

  /**
   * Arrow keys move the selection, Escape clears it (and still reaches the
   * page). Both are left to the page while the focus is in a control (see
   * isFocusInControl).
   * @param {!KeyboardEvent} event
   */
  function onKeyDown(event) {
    if (!state.anchor || event.isComposing || event.ctrlKey ||
        event.altKey || event.metaKey || event.shiftKey) {
      return;
    }
    const key = event.key;
    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Escape') return;
    // Styles may have changed since the last operation.
    beginOperation();
    if (isFocusInControl(event)) return;
    if (key === 'Escape') {
      clearSelection();
      return;
    }
    // While a line is selected the arrow keys belong to the ruler: the
    // page's own handlers (galleries, slide shows) must not react as well.
    // This listener captures on window, so it runs before the page's.
    event.preventDefault();
    event.stopPropagation();
    move(key === 'ArrowDown' ? 1 : -1);
  }

  // ===========================================================================
  // Per-site switch and startup
  // ===========================================================================

  // @match *://*/* covers http and https pages, which always have a host.
  const SITE = location.hostname;

  /**
   * Attaches or detaches the input listeners.
   * @param {boolean} value
   */
  function setEnabled(value) {
    if (value === state.enabled) return;
    state.enabled = value;
    if (value) {
      window.addEventListener('pointerdown', onPointerDown, true);
      window.addEventListener('click', onClick, true);
      window.addEventListener('keydown', onKeyDown, true);
    } else {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKeyDown, true);
      clearSelection();
    }
  }

  /** Shows the menu command for the current state. */
  function registerMenu() {
    const caption = state.enabled ?
        `Reading Ruler: Disable on ${SITE}` :
        `Reading Ruler: Enable on ${SITE}`;
    // The same id replaces the command, so the caption follows the state.
    GM_registerMenuCommand(caption, onMenuCommand,
        {id: 'toggle-site', autoClose: true});
  }

  /**
   * Applies a stored list of disabled sites to this tab.
   * @param {*} value Stored value.
   */
  function applySites(value) {
    setEnabled(!sanitizeSites(value).includes(SITE));
    registerMenu();
  }

  /**
   * Does what the menu command's caption says: disables the script for the
   * current site if it is enabled in this tab, enables it otherwise. Other
   * tabs follow through the value change listener.
   */
  function onMenuCommand() {
    const sites = withSite(
        sanitizeSites(GM_getValue(CONFIG.storageDisabledSites, [])), SITE,
        state.enabled);
    GM_setValue(CONFIG.storageDisabledSites, sites);
    applySites(sites);
  }

  /** Starts the script. */
  function init() {
    applySites(GM_getValue(CONFIG.storageDisabledSites, []));
    // Changes from other tabs (remote) keep the menu and state in sync.
    GM_addValueChangeListener(CONFIG.storageDisabledSites,
        (name, oldValue, newValue, remote) => {
          if (remote) applySites(newValue);
        });
  }

  init();
})();
