// ==UserScript==
// @name         Steam Wishlist – Deal Score
// @namespace    https://store.steampowered.com/wishlist/dealscore
// @version      1.13.0
// @description  Deal score (1–100) for the wishlist, cart and store pages, with a top-deals panel on the wishlist
// @author       Julian
// @homepageURL  https://github.com/JulWit/userscripts
// @supportURL   https://github.com/JulWit/userscripts/issues
// @icon         data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTQiIGZpbGw9IiMxYjI4MzgiLz48cGF0aCBkPSJNMTIgNDJhMjAgMjAgMCAwIDEgOC40LTE2LjMiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2Q5NDQzYiIgc3Ryb2tlLXdpZHRoPSI3Ii8+PHBhdGggZD0iTTIzLjYgMjMuOGEyMCAyMCAwIDAgMSAxNi44IDAiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2U4YTUzMCIgc3Ryb2tlLXdpZHRoPSI3Ii8+PHBhdGggZD0iTTQzLjYgMjUuN0EyMCAyMCAwIDAgMSA1MiA0MiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjNGZhZTNmIiBzdHJva2Utd2lkdGg9IjciLz48cGF0aCBkPSJNMzIgNDIgNDYgMjkiIHN0cm9rZT0iI2YyZjZmOSIgc3Ryb2tlLXdpZHRoPSI0IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48Y2lyY2xlIGN4PSIzMiIgY3k9IjQyIiByPSI1IiBmaWxsPSIjNjZjMGY0Ii8+PHJlY3QgeD0iMTgiIHk9IjUwIiB3aWR0aD0iMjgiIGhlaWdodD0iNSIgcng9IjIuNSIgZmlsbD0iIzY2YzBmNCIgb3BhY2l0eT0iLjUiLz48L3N2Zz4K
// @updateURL    https://raw.githubusercontent.com/JulWit/userscripts/main/scripts/steam-dealscore.user.js
// @downloadURL  https://raw.githubusercontent.com/JulWit/userscripts/main/scripts/steam-dealscore.user.js
// @match        https://store.steampowered.com/wishlist/*
// @match        https://store.steampowered.com/cart*
// @match        https://store.steampowered.com/app/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// ==/UserScript==
// @ts-check

/**
 * @fileoverview Shows a deal score from 1 to 100 in front of every title on the
 * Steam wishlist, in the cart and on a game's store page. The score is derived
 * from reviews, discount, price and popularity.
 * Code style: Google JavaScript Style Guide.
 */

(function() {
  'use strict';

  // ===========================================================================
  // Types
  // ===========================================================================

  /**
   * Discount in percent, original and final price.
   * @typedef {{discount: number, original: number, final: number,
   *     free: boolean}} Price
   */

  /**
   * Totals from /appreviewhistogram: last 30 days and all time.
   * @typedef {{up30: number, down30: number, upTotal: number,
   *     downTotal: number}} Histogram
   */

  /**
   * @typedef {{overall: number, recent: number, discount: number,
   *     price: number, popularity: number}} Weights
   */

  /**
   * currency is 'auto' (detected from the page) or an ISO 4217 code from
   * TEXT.currencyPatterns.
   * @typedef {{weights: !Weights, referencePrice: number,
   *     fetchExtra: boolean, qualityPenalty: boolean,
   *     currency: string}} Settings
   */

  /**
   * State of the extra data for one or more games.
   * @typedef {Object} Extra
   * @property {string} state 'ok' | 'pending' | 'failed' | 'disabled' |
   *     'unused' (no price, so no score that would need it)
   * @property {?Histogram} hist
   * @property {number|string} t Load time(s), part of the badge signature.
   * @property {number} [missing] Bundles: included games without data.
   */

  /**
   * In-memory cache entry.
   * @typedef {{status: 'ok', t: number, hist: !Histogram}|
   *     {status: 'pending'}|{status: 'failed', t: number}} HistEntry
   */

  /**
   * Entry read by a page adapter.
   * @typedef {Object} ItemData
   * @property {string} key
   * @property {string} kind
   * @property {string} id
   * @property {!Array<string>} appids
   * @property {string} title
   * @property {!Node} anchorEl Node the badge is inserted before (the title).
   * @property {?Element} focusEl Focusable element of the entry (the title
   *     link) whose keyboard focus opens the tooltip; null makes the badge
   *     itself focusable.
   * @property {?Price} price
   * @property {number} [bundleSize]
   * @property {!Array<string>} [notes]
   */

  /**
   * One component of the score. value (0–1) and points are 0 when the
   * component is not available.
   * @typedef {{available: boolean, weight: number, value: number,
   *     points: number}} ScorePart
   */

  /**
   * @typedef {{overall: !ScorePart, recent: !ScorePart, discount: !ScorePart,
   *     price: !ScorePart, popularity: !ScorePart}} ScoreParts
   */

  /**
   * Inputs of the score, as shown in the tooltip. recentPositive is null
   * without reviews in the last 30 days.
   * @typedef {{reviews: number, positive: number, recentReviews: number,
   *     recentPositive: ?number, discount: number, finalPrice: number,
   *     free: boolean}} ScoreInputs
   */

  /**
   * Result of the score calculation.
   * @typedef {{status: 'ok', score: number, penalty: number,
   *     penaltyPoints: number, parts: !ScoreParts, inputs: !ScoreInputs,
   *     hasReviews: boolean}} ScoreOk
   */

  /**
   * @typedef {{status: 'noPrice'}|{status: 'noWeights'}|!ScoreOk}
   *     ScoreResult
   */

  /**
   * One row of the tooltip breakdown table.
   * @typedef {{label: string, value: string, points: string,
   *     weight: string}} TooltipRow
   */

  /**
   * Content of the score tooltip. rows is empty when there is no breakdown.
   * @typedef {{title: string, rows: !Array<!TooltipRow>, total: string,
   *     notes: !Array<string>}} TooltipContent
   */

  /**
   * Purchase option on the store page.
   * @typedef {{block: !Element, heading: !Element, price: !Price}} Offer
   */

  /**
   * Scored wishlist entry remembered for the top list. version is the
   * settingsVersion the score was computed with, position the row's index in
   * the list (data-index) when it was last rendered.
   * @typedef {{key: string, appid: string, title: string, price: !Price,
   *     hist: ?Histogram, score: number, version: number,
   *     position: ?number}} TopEntry
   */

  /**
   * Preferences of the top list panel.
   * @typedef {{size: number, collapsed: boolean}} PanelPrefs
   */

  // ===========================================================================
  // Configuration – all defaults in one place
  // ===========================================================================

  /**
   * Freezes an object including nested objects and arrays.
   * @param {T} value
   * @return {T}
   * @template {object} T
   */
  function deepFreeze(value) {
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object' && !(child instanceof RegExp)) {
        deepFreeze(child);
      }
    }
    return Object.freeze(value);
  }

  const CONFIG = deepFreeze({
    // Alternatively set the GM value "debug" to true.
    debug: false,

    // Default weights (adjustable in the settings dialog).
    weights: {overall: 25, recent: 15, discount: 30, price: 20, popularity: 10},
    // At this final price (in the store currency) the price component is 0.5.
    referencePrice: 20,
    // Store currency: 'auto' detects it from the page, otherwise an ISO 4217
    // code from TEXT.currencyPatterns (adjustable in the settings dialog).
    currency: 'auto',
    // Used until a currency was detected for the first time.
    fallbackCurrency: 'EUR',
    // Load the histogram – the only source for all review values.
    fetchExtra: true,
    // S · min(1, 0.5 + R)
    qualityPenalty: true,

    // K: pulls the 30-day ratio towards the overall rating when there are few
    // reviews.
    recentPrior: 50,
    // B = log10(n + 1) / 5 → 100,000 reviews = 1
    popularityLogScale: 5,

    // Component scales (k = 1 is a strict, linear scale).
    // Reviews and discount: 1 − (1 − x)^k. Reviews stay linear so that good
    // games remain distinguishable and the quality penalty takes effect; for
    // the discount, 70 % with k = 2 already yields 0.91.
    reviewCurve: 1,
    discountCurve: 2,
    // Price: 1 / (1 + (final price / reference price)^k); with k = 2, €5
    // already yields 0.94 and €10 yields 0.80; the reference price still
    // yields 0.5.
    priceExponent: 2,

    // Badge color gradient (continuous between the stops).
    colorStops: [
      {score: 30, color: '#d9443b'},  // red
      {score: 55, color: '#e8a530'},  // yellow/orange
      {score: 80, color: '#4fae3f'},  // green
    ],
    // Badge without a score ("…", "–").
    neutralColor: '#3d4450',

    cacheTtlMs: 24 * 60 * 60 * 1000,
    failedRetryAfterMs: 5 * 60 * 1000,
    maxParallelRequests: 3,
    // On 429 / 5xx; delays of 2 s, 4 s, 8 s, 16 s.
    maxRetries: 4,
    retryBaseDelayMs: 2000,
    // A request that takes longer is aborted and frees its slot.
    requestTimeoutMs: 15 * 1000,
    // While no list is found, the page is searched at most this often.
    searchIntervalMs: 250,
    histogramQuery: '?l=english&review_score_preference=0',
    // Hover delay of the score tooltip (the native title tooltip waits
    // ~500 ms and does not work on touch devices).
    tooltipDelayMs: 100,

    // Top list panel on the wishlist: selectable sizes and the default.
    topListSizes: [10, 15, 20, 25, 50],
    topListDefaultSize: 10,
    // Without a saved preference the panel starts collapsed on small screens.
    topListCollapsedQuery: '(max-width: 600px)',

    // Input limits, shared by the settings dialog and the validation.
    limits: {
      weight: {min: 0, max: 1000, step: 1},
      referencePrice: {min: 0.5, max: 1000, step: 0.5},
    },
  });

  // Locale-dependent patterns and formats – collected in one place. The
  // patterns match Steam's page text, which depends on the store language.
  // Prices are only recognized in the store currency (see CONFIG.currency):
  // the reference price and all formatting assume that currency.
  const TEXT = deepFreeze({
    locale: 'en-US',
    // How Steam prints the currency, by ISO 4217 code; these are the
    // supported store currencies. No \b next to symbols: "ł" is not a word
    // character and Steam writes "12,99zł" without a space. A "$" directly
    // after a letter belongs to another dollar currency ("CDN$", "A$", "R$")
    // or to a title ("Ca$h").
    currencyPatterns: {
      EUR: /€|\bEUR\b/,
      USD: /(?<![A-Za-z])\$|\bUSD\b/,
      GBP: /£|\bGBP\b/,
      CHF: /\bCHF\b/,
      PLN: /zł|\bPLN\b/,
    },
    discountText: /^[-−–]\s*(\d{1,3})\s*%$/,
    free: /^(?:free(?: to play)?|gratis|kostenlos(?: spielbar| spielen)?)$/i,
  });

  const PREFIX = 'sws';
  const STORAGE_SETTINGS = 'settings';
  /** Common prefix of all cache keys, including those of older versions. */
  const STORAGE_CACHE_ROOT = 'hist:';
  /** Prefix of the current cache format; bump when the entry shape changes. */
  const STORAGE_CACHE_PREFIX = `${STORAGE_CACHE_ROOT}v1:`;
  const STORAGE_PANEL = 'panel';
  /** Last currency detected from a page, used until the next detection. */
  const STORAGE_CURRENCY = 'detectedCurrency';
  const OWN_SELECTOR = `.${PREFIX}-badge, .${PREFIX}-dialog, ` +
      `.${PREFIX}-tooltip, .${PREFIX}-panel`;

  // ===========================================================================
  // Pure functions: parsing, score, color, tooltip (no DOM, no network)
  // ===========================================================================

  /**
   * Numbers with thousands/decimal separators, including non-breaking spaces.
   * No g flag: only used via matchAll or match.
   */
  const NUMBER_PATTERN = /\d[\d.,  ']*/;

  /**
   * @param {number} x
   * @return {number} x, clamped to 0…1.
   */
  function clamp01(x) {
    return Math.min(1, Math.max(0, x));
  }

  /**
   * @param {string} text
   * @return {!Array<string>} All numbers in the text, in order.
   */
  function findNumbers(text) {
    const pattern = new RegExp(NUMBER_PATTERN.source, 'g');
    return [...text.matchAll(pattern)].map((match) => match[0]);
  }

  /**
   * "1.234,56€", "25,59 €", "€12.99", "25,--€" → number.
   * @param {*} text
   * @return {?number}
   */
  function parseMoney(text) {
    const match = String(text ?? '').match(NUMBER_PATTERN);
    if (!match) return null;
    const digits =
        match[0].replace(/[  ']/g, '').replace(/[.,]+$/, '');
    const sep = Math.max(digits.lastIndexOf(','), digits.lastIndexOf('.'));
    if (sep >= 0 && digits.length - sep - 1 === 2) {
      const whole = digits.slice(0, sep).replace(/[.,]/g, '');
      return parseFloat(`${whole}.${digits.slice(sep + 1)}`);
    }
    return parseFloat(digits.replace(/[.,]/g, ''));
  }

  /**
   * @param {string} code ISO 4217 code.
   * @return {boolean} Whether the currency is supported.
   */
  function isSupportedCurrency(code) {
    return Object.hasOwn(TEXT.currencyPatterns, code);
  }

  /**
   * @param {string} code Supported ISO 4217 code.
   * @return {!RegExp} Matches a price in that currency.
   */
  function currencyPattern(code) {
    const patterns = /** @type {!Object<string, !RegExp>} */ (
      TEXT.currencyPatterns);
    if (!isSupportedCurrency(code)) {
      throw new Error(`Unsupported currency ${code}`);
    }
    return patterns[code];
  }

  /**
   * Detects the store currency from price texts: the supported currency that
   * most texts with a number show. Texts that match several currencies are
   * ambiguous and do not count.
   * @param {!Iterable<string>} texts
   * @return {?string} ISO 4217 code, null if no text shows a price.
   */
  function detectCurrency(texts) {
    /** @type {!Map<string, number>} */
    const counts = new Map();
    for (const text of texts) {
      if (!/\d/.test(text)) continue;
      const codes = Object.keys(TEXT.currencyPatterns).filter(
          (code) => currencyPattern(code).test(text));
      if (codes.length === 1) {
        counts.set(codes[0], (counts.get(codes[0]) || 0) + 1);
      }
    }
    let best = null;
    let bestCount = 0;
    for (const [code, count] of counts) {
      if (count > bestCount) {
        best = code;
        bestCount = count;
      }
    }
    return best;
  }

  /**
   * Localized label such as "20% off. Regular price €31.99, now €25.59."
   * @param {?string} label
   * @param {string} currency Store currency (ISO 4217 code).
   * @return {?Price}
   */
  function parsePriceLabel(label, currency) {
    if (!label || !currencyPattern(currency).test(label)) return null;
    const discountMatch = label.match(/(\d{1,3})\s*%/);
    if (!discountMatch) return null;
    const start = discountMatch.index ?? 0;
    const rest = label.slice(0, start) + ' ' +
        label.slice(start + discountMatch[0].length);
    const amounts = findNumbers(rest).flatMap((text) => {
      const value = parseMoney(text);
      return value == null ? [] : [value];
    });
    if (amounts.length < 2) return null;
    const final = amounts[amounts.length - 1];
    return {
      discount: Number(discountMatch[1]),
      original: amounts[0],
      final,
      free: final === 0,
    };
  }

  /**
   * Visible texts of the price area: "-20%", "31,99€", "25,59€" or
   * "19,50€" or "Free".
   * @param {!Array<string>} texts
   * @param {string} currency Store currency (ISO 4217 code).
   * @return {?Price}
   */
  function parsePriceTexts(texts, currency) {
    const pattern = currencyPattern(currency);
    /** @type {?number} */
    let discount = null;
    let free = false;
    /** @type {!Array<number>} */
    const amounts = [];
    for (const raw of texts) {
      const text = String(raw).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const discountMatch = text.match(TEXT.discountText);
      if (discountMatch) {
        discount = Number(discountMatch[1]);
      } else if (TEXT.free.test(text)) {
        free = true;
      } else if (text.length <= 24 && /\d/.test(text) && pattern.test(text)) {
        const value = parseMoney(text);
        if (value != null) amounts.push(value);
      }
    }
    if (amounts.length) {
      const final = amounts[amounts.length - 1];
      const original = amounts.length > 1 ? amounts[0] : final;
      if (discount == null) {
        discount =
            original > final ? Math.round((1 - final / original) * 100) : 0;
      }
      return {discount, original, final, free: final === 0};
    }
    return free ? {discount: 0, original: 0, final: 0, free: true} : null;
  }

  /**
   * Sums up the /appreviewhistogram response.
   * @param {*} json
   * @return {!Histogram}
   */
  function summarizeHistogram(json) {
    if (!json || json.success !== 1 || !json.results) {
      throw new Error('Histogram: unexpected response');
    }
    /**
     * @param {*} list
     * @return {!Array<number>} [up, down]
     */
    const sum = (list) => (Array.isArray(list) ? list : []).reduce(
        (acc, day) => [
          acc[0] + (Number(day.recommendations_up) || 0),
          acc[1] + (Number(day.recommendations_down) || 0),
        ],
        [0, 0]);
    const [up30, down30] = sum(json.results.recent);
    const [upTotal, downTotal] = sum(json.results.rollups);
    return {up30, down30, upTotal, downTotal};
  }

  /**
   * Bundles: add up the reviews of all included games, so games with many
   * reviews count more.
   * @param {!Array<!Histogram>} list
   * @return {!Histogram}
   */
  function combineHistograms(list) {
    return list.reduce(
        (acc, hist) => ({
          up30: acc.up30 + hist.up30,
          down30: acc.down30 + hist.down30,
          upTotal: acc.upTotal + hist.upTotal,
          downTotal: acc.downTotal + hist.downTotal,
        }),
        {up30: 0, down30: 0, upTotal: 0, downTotal: 0});
  }

  /**
   * Validates a stored cache entry: a histogram with its load time.
   * @param {*} entry Value read from storage.
   * @param {number} now
   * @param {number} ttlMs
   * @return {?{hist: !Histogram, t: number}} null if the entry is missing,
   *     malformed or expired.
   */
  function readCacheEntry(entry, now, ttlMs) {
    if (!entry || typeof entry !== 'object') return null;
    const t = entry.t;
    if (!Number.isFinite(t) || t > now || now - t >= ttlMs) return null;
    /**
     * @param {*} value
     * @return {number} The value if it is a valid count, otherwise NaN.
     */
    const count = (value) =>
        Number.isFinite(value) && value >= 0 ? value : NaN;
    const hist = {
      up30: count(entry.up30),
      down30: count(entry.down30),
      upTotal: count(entry.upTotal),
      downTotal: count(entry.downTotal),
    };
    return Object.values(hist).some(Number.isNaN) ? null : {hist, t};
  }

  /**
   * Combines the extra data of a bundle's games: the histograms of all
   * loaded games are added up.
   * @param {!Array<!Extra>} parts One entry per game.
   * @return {!Extra}
   */
  function combineExtras(parts) {
    if (!parts.length) return {state: 'failed', hist: null, t: 0};
    if (parts.length === 1) return parts[0];
    if (parts.some((part) => part.state === 'pending')) {
      return {state: 'pending', hist: null, t: 0};
    }
    const loaded = parts.filter((part) => part.state === 'ok' && part.hist);
    if (!loaded.length) return {state: 'failed', hist: null, t: 0};
    return {
      state: 'ok',
      hist: combineHistograms(loaded.map(
          (part) => /** @type {!Histogram} */ (part.hist))),
      t: loaded.map((part) => part.t).join(','),
      missing: parts.length - loaded.length,
    };
  }

  /**
   * SteamDB formula: with few reviews the rating tends towards 50 %.
   * @param {number} pct Share of positive reviews (0–1).
   * @param {number} count Number of reviews.
   * @return {number}
   */
  function shrinkRating(pct, count) {
    return pct - (pct - 0.5) * Math.pow(2, -Math.log10(count + 1));
  }

  /**
   * Curved scale 1 − (1 − x)^k: high values count almost fully, while the
   * gradation is preserved. k = 1 is linear.
   * @param {number} x Linear value (0–1).
   * @param {number} k Curvature (≥ 1).
   * @return {number}
   */
  function easeOut(x, k) {
    return 1 - Math.pow(1 - clamp01(x), Math.max(1, k));
  }

  /**
   * Price scale: 1 / (1 + (final price / reference price)^k). The reference
   * price yields 0.5; free yields 1.
   * @param {number} price Final price.
   * @param {number} referencePrice
   * @param {number} k Steepness (1 = the previous, flat curve).
   * @return {number}
   */
  function priceValue(price, referencePrice, k) {
    const ratio = Math.max(0, price) / Math.max(referencePrice, 0.01);
    return 1 / (1 + Math.pow(ratio, Math.max(1, k)));
  }

  /**
   * Computes the deal score of an entry. The same rule applies on every page:
   * price and discount come from the page, all review values exclusively from
   * the histogram (all languages).
   * @param {{price: ?Price}} row
   * @param {?Histogram} hist
   * @param {!Settings} settings
   * @return {!ScoreResult}
   */
  function computeScore(row, hist, settings) {
    if (!row.price) return {status: 'noPrice'};
    const price = row.price;
    const weights = settings.weights;
    const histTotal = hist ? hist.upTotal + hist.downTotal : 0;
    const hasReviews = Boolean(hist) && histTotal > 0;
    /**
     * @param {number} weight
     * @param {?number} value null: component not available.
     * @return {!ScorePart} Points are filled in below.
     */
    const part = (weight, value) => value == null ?
        {available: false, weight, value: 0, points: 0} :
        {available: true, weight, value, points: 0};

    /** @type {!ScoreInputs} */
    const inputs = {
      reviews: histTotal,
      positive: 0,
      recentReviews: 0,
      recentPositive: null,
      discount: price.discount,
      finalPrice: price.final,
      free: price.free,
    };
    let overallValue = null;
    let recentValue = null;
    if (hist && hasReviews) {
      const pAll = hist.upTotal / histTotal;
      const ratingG = shrinkRating(pAll, histTotal);
      overallValue = easeOut((ratingG - 0.5) / 0.5, CONFIG.reviewCurve);
      const n30 = hist.up30 + hist.down30;
      const p30 = (hist.up30 + CONFIG.recentPrior * ratingG) /
          (n30 + CONFIG.recentPrior);
      recentValue = easeOut((p30 - 0.5) / 0.5, CONFIG.reviewCurve);
      inputs.positive = pAll;
      inputs.recentReviews = n30;
      inputs.recentPositive = n30 ? hist.up30 / n30 : null;
    }

    /** @type {!ScoreParts} */
    const parts = {
      overall: part(weights.overall, overallValue),
      recent: part(weights.recent, recentValue),
      discount: part(weights.discount,
          easeOut(price.discount / 100, CONFIG.discountCurve)),
      price: part(weights.price, priceValue(
          price.final, settings.referencePrice, CONFIG.priceExponent)),
      popularity: part(weights.popularity, hist ?
          clamp01(Math.log10(histTotal + 1) / CONFIG.popularityLogScale) :
          null),
    };

    let weightSum = 0;
    let weightedSum = 0;
    for (const component of Object.values(parts)) {
      if (component.available && component.weight > 0) {
        weightSum += component.weight;
        weightedSum += component.weight * component.value;
      }
    }
    if (weightSum <= 0) return {status: 'noWeights'};

    // Points each component adds to the score (before the quality penalty).
    for (const component of Object.values(parts)) {
      component.points = component.available && component.weight > 0 ?
          99 * component.weight * component.value / weightSum :
          0;
    }

    let total = weightedSum / weightSum;
    let penalty = 1;
    let penaltyPoints = 0;
    const reviewWeight = weights.overall + weights.recent;
    if (settings.qualityPenalty && hasReviews && reviewWeight > 0) {
      const quality = (weights.overall * parts.overall.value +
          weights.recent * parts.recent.value) / reviewWeight;
      penalty = Math.min(1, 0.5 + quality);
      penaltyPoints = 99 * total * (1 - penalty);
      total *= penalty;
    }
    const score = Math.min(100, Math.max(1, Math.round(1 + 99 * total)));
    return {
      status: 'ok',
      score,
      penalty,
      penaltyPoints,
      parts,
      inputs,
      hasReviews,
    };
  }

  /**
   * @param {string} hex Color as "#rgb" or "#rrggbb".
   * @return {!Array<number>} [r, g, b]
   */
  function hexToRgb(hex) {
    const digits = hex.replace('#', '');
    const value = parseInt(
        digits.length === 3 ? digits.replace(/./g, '$&$&') : digits, 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  }

  /**
   * Continuous color gradient across the color stops.
   * @param {number} score
   * @param {!Array<{score: number, color: string}>=} stops
   * @return {string} CSS color.
   */
  function scoreColor(score, stops = CONFIG.colorStops) {
    const sorted = [...stops].sort((a, b) => a.score - b.score);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    let rgb;
    if (score <= first.score) {
      rgb = hexToRgb(first.color);
    } else if (score >= last.score) {
      rgb = hexToRgb(last.color);
    } else {
      const index = sorted.findIndex((stop) => stop.score >= score);
      const from = sorted[index - 1];
      const to = sorted[index];
      const ratio = (score - from.score) / (to.score - from.score);
      const fromRgb = hexToRgb(from.color);
      const toRgb = hexToRgb(to.color);
      rgb = fromRgb.map((v, k) => Math.round(v + (toRgb[k] - v) * ratio));
    }
    return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  }

  // Number formats are created once: toLocaleString with options builds a new
  // formatter on every call.
  const INTEGER_FORMAT = new Intl.NumberFormat(TEXT.locale);
  /** @type {!Map<number, !Intl.NumberFormat>} Keyed by decimal places. */
  const decimalFormats = new Map();
  /** @type {!Map<string, !Intl.NumberFormat>} Keyed by currency code. */
  const moneyFormats = new Map();

  /**
   * @param {string} currency ISO 4217 code.
   * @return {!Intl.NumberFormat}
   */
  function moneyFormat(currency) {
    let format = moneyFormats.get(currency);
    if (!format) {
      format = new Intl.NumberFormat(
          TEXT.locale, {style: 'currency', currency});
      moneyFormats.set(currency, format);
    }
    return format;
  }

  /**
   * @param {string} currency ISO 4217 code.
   * @return {string} Currency symbol for labels, e.g. "€".
   */
  function currencySymbol(currency) {
    return moneyFormat(currency).formatToParts(0)
        .find((part) => part.type === 'currency')?.value || currency;
  }

  /**
   * @param {number} value
   * @return {string} Integer with thousands separators.
   */
  function formatInteger(value) {
    return INTEGER_FORMAT.format(Math.round(value));
  }

  /**
   * @param {number} ratio Share (0–1).
   * @return {string} e.g. "93%".
   */
  function formatPercent(ratio) {
    return `${Math.round(ratio * 100)}%`;
  }

  /**
   * @param {number} value
   * @param {string} currency ISO 4217 code.
   * @return {string} e.g. "€7.49".
   */
  function formatMoney(value, currency) {
    return moneyFormat(currency).format(value);
  }

  /**
   * @param {number} value
   * @param {number} digits Decimal places.
   * @return {string}
   */
  function formatDecimal(value, digits) {
    let format = decimalFormats.get(digits);
    if (!format) {
      format = new Intl.NumberFormat(TEXT.locale, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
      decimalFormats.set(digits, format);
    }
    return format.format(value);
  }

  /**
   * Builds the tooltip content: a table with the points each component adds
   * to the score, followed by notes.
   * @param {!ScoreResult} result
   * @param {string} extraState 'ok' | 'pending' | 'failed' | 'disabled' |
   *     'unused'
   * @param {{bundleSize?: number, bundleMissing?: number,
   *     notes?: !Array<string>, currency?: string}=} meta Bundle details,
   *     additional lines and the store currency (default
   *     CONFIG.fallbackCurrency).
   * @return {!TooltipContent}
   */
  function buildTooltip(result, extraState, meta = {}) {
    const currency = meta.currency || CONFIG.fallbackCurrency;
    /**
     * @param {string} title
     * @param {string} note
     * @return {!TooltipContent}
     */
    const message = (title, note) =>
      ({title, rows: [], total: '', notes: note ? [note] : []});
    if (result.status === 'noPrice') {
      return message('Deal score: –',
          'No price available (unreleased, not purchasable or not in ' +
              `${currency}).`);
    }
    if (extraState === 'pending') {
      return message('Deal score: loading extra data …', '');
    }
    if (result.status === 'noWeights') {
      return message('Deal score: –',
          'All weights of the available components are 0.');
    }
    const {parts, inputs} = result;
    /**
     * @param {string} label
     * @param {string} value
     * @param {!ScorePart} part
     * @return {!TooltipRow}
     */
    const row = (label, value, part) => part.available ?
        {
          label,
          value,
          points: `+${formatDecimal(part.points, 1)}`,
          weight: formatInteger(part.weight),
        } :
        {label, value: 'no data (not counted)', points: '–', weight: '–'};
    const rows = [{
      label: 'Base',
      value: '',
      points: `+${formatDecimal(1, 1)}`,
      weight: '',
    }];

    rows.push(row('Overall rating',
        `${formatPercent(inputs.positive)} ` +
            `(${formatInteger(inputs.reviews)}, all languages)`,
        parts.overall));

    const recentText = inputs.recentPositive == null ?
        'no new reviews' :
        `${formatPercent(inputs.recentPositive)} ` +
            `(${formatInteger(inputs.recentReviews)})`;
    rows.push(row('Last 30 days', recentText, parts.recent));

    rows.push(row('Discount',
        inputs.discount > 0 ? `−${inputs.discount}%` : 'none',
        parts.discount));

    rows.push(row('Price',
        inputs.free ? 'free' : formatMoney(inputs.finalPrice, currency),
        parts.price));

    rows.push(row('Popularity', `${formatInteger(inputs.reviews)} reviews`,
        parts.popularity));

    if (result.penalty < 1) {
      rows.push({
        label: 'Quality penalty',
        value: `× ${formatDecimal(result.penalty, 2)}`,
        points: `−${formatDecimal(result.penaltyPoints, 1)}`,
        weight: '',
      });
    }
    const lines = [...(meta.notes || [])];
    if (meta.bundleSize) {
      const noun = meta.bundleSize === 1 ? 'title' : 'titles';
      lines.push(`Bundle: reviews of ${meta.bundleSize} included ` +
          `${noun} combined.`);
      if (meta.bundleMissing) {
        lines.push(`Note: extra data is missing for ${meta.bundleMissing} ` +
            'included titles.');
      }
    }
    if (extraState === 'failed') {
      lines.push('Note: review data unavailable – ' +
          'score based on discount and price only.');
    } else if (extraState === 'disabled') {
      lines.push('Note: extra data disabled – ' +
          'score based on discount and price only.');
    } else if (!result.hasReviews) {
      lines.push('Note: no reviews yet – rating is not counted.');
    }
    return {
      title: `Deal score ${result.score}`,
      rows,
      total: String(result.score),
      notes: lines,
    };
  }

  /** @return {!Settings} */
  function defaultSettings() {
    return {
      weights: {...CONFIG.weights},
      referencePrice: CONFIG.referencePrice,
      fetchExtra: CONFIG.fetchExtra,
      qualityPenalty: CONFIG.qualityPenalty,
      currency: CONFIG.currency,
    };
  }

  /**
   * Validates stored or entered values: invalid ones are replaced by the
   * defaults, numbers are clamped to CONFIG.limits.
   * @param {*} raw
   * @return {!Settings}
   */
  function sanitizeSettings(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const defaults = defaultSettings();
    /**
     * @param {*} value Number or numeric string (form input).
     * @param {number} fallback
     * @param {{min: number, max: number}} limit
     * @return {number}
     */
    const toNumber = (value, fallback, limit) => {
      const numeric = typeof value === 'number' ||
          (typeof value === 'string' && value.trim() !== '');
      return numeric && Number.isFinite(Number(value)) ?
          Math.min(limit.max, Math.max(limit.min, Number(value))) :
          fallback;
    };
    const weights = {...defaults.weights};
    const keys = /** @type {!Array<keyof Weights>} */ (Object.keys(weights));
    for (const key of keys) {
      weights[key] = toNumber(
          input.weights?.[key], weights[key], CONFIG.limits.weight);
    }
    const currency = input.currency;
    return {
      weights,
      referencePrice: toNumber(input.referencePrice, defaults.referencePrice,
          CONFIG.limits.referencePrice),
      fetchExtra: typeof input.fetchExtra === 'boolean' ?
          input.fetchExtra :
          defaults.fetchExtra,
      qualityPenalty: typeof input.qualityPenalty === 'boolean' ?
          input.qualityPenalty :
          defaults.qualityPenalty,
      currency: currency === 'auto' ||
          (typeof currency === 'string' && isSupportedCurrency(currency)) ?
          currency :
          defaults.currency,
    };
  }

  /**
   * Scored wishlist entries for the top list panel. The wishlist is
   * virtualized: only the rows near the viewport exist, so the list collects
   * every scored row seen while scrolling. An entry is dropped again when
   * another game takes over its list position (removed from the wishlist,
   * list re-sorted).
   */
  class TopList {
    constructor() {
      /** @const {!Map<string, !TopEntry>} Entries by key. */
      this.entries = new Map();
      /** @const {!Map<number, string>} Key last seen at each position. */
      this.keyAtPosition = new Map();
    }

    /** @return {number} Number of entries. */
    get size() {
      return this.entries.size;
    }

    /** Forgets all entries, e.g. when the list was replaced. */
    clear() {
      this.entries.clear();
      this.keyAtPosition.clear();
    }

    /**
     * Records which entry is shown at a list position. An entry whose
     * position is taken over by another one was removed or has moved; it is
     * dropped until its row is rendered again.
     * @param {string} key
     * @param {number} position
     * @return {boolean} Whether an entry was dropped.
     */
    notePosition(key, position) {
      const previous = this.keyAtPosition.get(position);
      if (previous === key) return false;
      this.keyAtPosition.set(position, key);
      const displaced = previous ? this.entries.get(previous) : undefined;
      if (!displaced || displaced.position !== position) return false;
      this.entries.delete(displaced.key);
      return true;
    }

    /** @param {!TopEntry} entry */
    set(entry) {
      this.entries.set(entry.key, entry);
    }

    /** @param {string} key */
    delete(key) {
      this.entries.delete(key);
    }

    /**
     * Recomputes the scores of entries that were computed with another
     * settings version, and drops entries that no longer get a score.
     * @param {!Settings} settings
     * @param {number} version
     */
    rescore(settings, version) {
      for (const entry of this.entries.values()) {
        if (entry.version === version) continue;
        const hist = settings.fetchExtra ? entry.hist : null;
        const result = computeScore(entry, hist, settings);
        if (result.status === 'ok') {
          entry.score = result.score;
          entry.version = version;
        } else {
          this.entries.delete(entry.key);
        }
      }
    }

    /**
     * @param {number} size
     * @return {!Array<!TopEntry>} The best entries, best first; equal scores
     *     sorted by title.
     */
    ranked(size) {
      return [...this.entries.values()]
          .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
          .slice(0, size);
    }
  }

  /** The pure functions, for unit tests and the debug console. */
  const CORE = Object.freeze({
    config: CONFIG,
    text: TEXT,
    parseMoney,
    isSupportedCurrency,
    currencyPattern,
    detectCurrency,
    parsePriceLabel,
    parsePriceTexts,
    summarizeHistogram,
    combineHistograms,
    readCacheEntry,
    combineExtras,
    shrinkRating,
    easeOut,
    priceValue,
    computeScore,
    scoreColor,
    buildTooltip,
    defaultSettings,
    sanitizeSettings,
    TopList,
  });

  // Unit tests (tests/*.test.js) load this file with a hook instead of running
  // it on a page. Everything above is free of DOM, storage and network access,
  // so the script stops here.
  if (typeof globalThis.dealScoreTestHook === 'function') {
    globalThis.dealScoreTestHook(CORE);
    return;
  }

  // ===========================================================================
  // Settings & cache (GM storage)
  // ===========================================================================

  // Script managers provide GM_* as local identifiers, not necessarily as
  // window properties.
  /* global GM_getValue, GM_setValue, GM_deleteValue, GM_listValues,
     GM_addValueChangeListener, GM_registerMenuCommand */

  const DEBUG = CONFIG.debug || GM_getValue('debug', false) === true;

  /**
   * Debug output, only when DEBUG is set.
   * @param {...*} args
   */
  function log(...args) {
    if (DEBUG) console.log('[Deal Score]', ...args);
  }

  /** @type {!Settings} */
  let settings = sanitizeSettings(GM_getValue(STORAGE_SETTINGS, null));
  let settingsVersion = 0;
  /**
   * Incremented when the cache is cleared: requests started before that
   * discard their result.
   */
  let cacheEpoch = 0;

  /**
   * @return {string} Currency last detected on a page, or the fallback.
   */
  function storedCurrency() {
    const code = GM_getValue(STORAGE_CURRENCY, null);
    return typeof code === 'string' && isSupportedCurrency(code) ?
        code :
        CONFIG.fallbackCurrency;
  }

  /** Store currency used to read and format prices (ISO 4217 code). */
  let currency =
      settings.currency === 'auto' ? storedCurrency() : settings.currency;
  /**
   * Whether the currency is settled for this page: chosen in the settings or
   * detected from the page. Until then the stored currency is a guess.
   */
  let currencySettled = settings.currency !== 'auto';

  /**
   * @param {string} appid
   * @return {?{hist: !Histogram, t: number}} Cached totals with their load
   *     time, if still valid.
   */
  function cacheRead(appid) {
    return readCacheEntry(GM_getValue(STORAGE_CACHE_PREFIX + appid, null),
        Date.now(), CONFIG.cacheTtlMs);
  }

  /**
   * @param {string} appid
   * @param {!Histogram} hist
   */
  function cacheWrite(appid, hist) {
    GM_setValue(STORAGE_CACHE_PREFIX + appid, {...hist, t: Date.now()});
  }

  /**
   * Deletes invalid, expired or all cache entries, including entries in the
   * format of older versions.
   * @param {boolean} all true: delete all entries.
   * @return {number} Number of deleted entries.
   */
  function cachePrune(all) {
    let removed = 0;
    const now = Date.now();
    for (const key of GM_listValues()) {
      if (!key.startsWith(STORAGE_CACHE_ROOT)) continue;
      const valid = key.startsWith(STORAGE_CACHE_PREFIX) &&
          readCacheEntry(GM_getValue(key, null), now, CONFIG.cacheTtlMs);
      if (all || !valid) {
        GM_deleteValue(key);
        removed++;
      }
    }
    return removed;
  }

  // ===========================================================================
  // Network: queue with max. 3 parallel requests, backoff on 429/5xx
  // ===========================================================================

  /** @type {!Map<string, !HistEntry>} */
  const histMem = new Map();
  /** @type {!Array<string>} */
  const queue = [];
  /** @type {!Set<string>} */
  const queued = new Set();
  let activeRequests = 0;
  let pausedUntil = 0;
  /** @type {?number} */
  let pumpTimer = null;

  /**
   * @param {number} ms
   * @return {!Promise<void>}
   */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * One request, aborted after CONFIG.requestTimeoutMs including the
   * response body, so that a hanging request does not keep its slot.
   * @param {string} url
   * @return {!Promise<{status: number, json: *}>} json is only read for
   *     status 200.
   */
  async function requestJson(url) {
    const controller = new AbortController();
    // A timer instead of AbortSignal.timeout(), so that the end-to-end tests
    // can fast-forward it with a fake clock.
    const timer =
        setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
    try {
      const response = await fetch(url, {
        credentials: 'same-origin',
        headers: {Accept: 'application/json'},
        signal: controller.signal,
      });
      const json = response.status === 200 ? await response.json() : null;
      return {status: response.status, json};
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Loads the review histogram, with backoff on 429 and 5xx. The endpoint is
   * public and same-origin, so a plain fetch suffices.
   * @param {string} appid
   * @return {!Promise<!Histogram>}
   */
  async function fetchHistogram(appid) {
    const path = `/appreviewhistogram/${appid}${CONFIG.histogramQuery}`;
    const url = new URL(path, location.href).href;
    for (let attempt = 0;; attempt++) {
      const {status, json} = await requestJson(url);
      if (status === 429 || status >= 500) {
        if (attempt >= CONFIG.maxRetries) throw new Error(`HTTP ${status}`);
        const delay =
            CONFIG.retryBaseDelayMs * Math.pow(2, attempt) +
            Math.random() * 500;
        if (status === 429) {
          pausedUntil = Math.max(pausedUntil, Date.now() + delay);
        }
        log(`HTTP ${status} for ${appid}, ` +
            `retrying in ${Math.round(delay)} ms`);
        await sleep(delay);
        continue;
      }
      if (status !== 200) throw new Error(`HTTP ${status}`);
      return summarizeHistogram(json);
    }
  }

  /**
   * @param {string} appid
   * @return {boolean} Whether a badge is rendered for this game.
   */
  function isRendered(appid) {
    const selector = `.${PREFIX}-badge[data-appids~="${appid}"]`;
    return Boolean(document.querySelector(selector));
  }

  /** @param {string} appid */
  function enqueue(appid) {
    if (queued.has(appid)) return;
    queued.add(appid);
    queue.push(appid);
    pump();
  }

  /** @param {string} appid */
  function dropFromQueue(appid) {
    queued.delete(appid);
    if (histMem.get(appid)?.status === 'pending') histMem.delete(appid);
  }

  /** Starts requests while slots are free. */
  function pump() {
    if (!settings.fetchExtra) {
      queue.splice(0).forEach(dropFromQueue);
      return;
    }
    const wait = pausedUntil - Date.now();
    if (wait > 0) {
      if (!pumpTimer) {
        pumpTimer = setTimeout(() => {
          pumpTimer = null;
          pump();
        }, wait);
      }
      return;
    }
    while (activeRequests < CONFIG.maxParallelRequests && queue.length) {
      const appid = /** @type {string} */ (queue.shift());
      // Only request games that are (still) rendered.
      if (!isRendered(appid)) {
        dropFromQueue(appid);
        continue;
      }
      activeRequests++;
      const epoch = cacheEpoch;
      fetchHistogram(appid)
          .then((hist) => {
            if (epoch !== cacheEpoch) return;
            cacheWrite(appid, hist);
            histMem.set(appid, {status: 'ok', t: Date.now(), hist});
            log('Histogram', appid, hist);
          })
          .catch((e) => {
            if (epoch !== cacheEpoch) return;
            histMem.set(appid, {status: 'failed', t: Date.now()});
            log('Histogram failed', appid, e);
          })
          .finally(() => {
            activeRequests--;
            queued.delete(appid);
            // The result was discarded because the cache was cleared in the
            // meantime: request again if the game is still waiting for it.
            if (histMem.get(appid)?.status === 'pending') enqueue(appid);
            schedule();
            pump();
          });
    }
  }

  /**
   * Returns the state of the extra data and triggers the fetch if needed.
   * @param {string} appid
   * @return {!Extra}
   */
  function getExtra(appid) {
    if (!settings.fetchExtra) return {state: 'disabled', hist: null, t: 0};
    const now = Date.now();
    let entry = histMem.get(appid);
    if (entry?.status === 'ok' && now - entry.t >= CONFIG.cacheTtlMs) {
      entry = undefined;
    }
    if (entry?.status === 'failed' &&
        now - entry.t >= CONFIG.failedRetryAfterMs) {
      entry = undefined;
    }
    if (!entry) {
      const cached = cacheRead(appid);
      entry = cached ?
          {status: 'ok', t: cached.t, hist: cached.hist} :
          {status: 'pending'};
      // Set before enqueue: the queue drops pending entries it skips.
      histMem.set(appid, entry);
      if (entry.status === 'pending') enqueue(appid);
    }
    switch (entry.status) {
      case 'ok':
        return {state: 'ok', hist: entry.hist, t: entry.t};
      case 'failed':
        return {state: 'failed', hist: null, t: entry.t};
      default:
        return {state: 'pending', hist: null, t: 0};
    }
  }

  /**
   * Like getExtra, for multiple app IDs (bundles): histograms are combined.
   * @param {!Array<string>} appids
   * @return {!Extra}
   */
  function getExtraFor(appids) {
    if (!settings.fetchExtra) return {state: 'disabled', hist: null, t: 0};
    return combineExtras(appids.map(getExtra));
  }

  // ===========================================================================
  // DOM helpers
  // ===========================================================================

  /**
   * Creates an element with attributes and children.
   * @param {string} tag
   * @param {!Object<string, string>=} props Attributes; "class" and "text"
   *     set className and textContent respectively.
   * @param {!Array<!Node|string>=} children
   * @return {!HTMLElement}
   */
  function buildElement(tag, props = {}, children = []) {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(props)) {
      if (name === 'class') {
        element.className = value;
      } else if (name === 'text') {
        element.textContent = value;
      } else {
        element.setAttribute(name, value);
      }
    }
    element.append(...children);
    return element;
  }

  /**
   * @param {!Element} anchor
   * @return {?string} App ID from the link.
   */
  function appIdOf(anchor) {
    const href = anchor.getAttribute('href') || '';
    return href.match(/\/app\/(\d+)/)?.[1] || null;
  }

  /**
   * @param {!Element} element
   * @return {boolean} Whether the element belongs to our badges or the dialog.
   */
  function isOwn(element) {
    return Boolean(element.closest(OWN_SELECTOR));
  }

  /**
   * @param {!Node} node
   * @return {boolean}
   */
  function isOwnNode(node) {
    return node.nodeType === Node.ELEMENT_NODE &&
        isOwn(/** @type {!Element} */ (node));
  }

  /**
   * Texts of all leaf elements, excluding buttons and our own elements.
   * @param {!Element} scope
   * @param {?Element=} exclude Skip this element (including its content).
   * @return {!Array<string>}
   */
  function leafTexts(scope, exclude = null) {
    const texts = [];
    for (const element of scope.querySelectorAll('*')) {
      if (element.childElementCount || isOwn(element)) continue;
      if (element.closest('button')) continue;
      if (exclude && exclude.contains(element)) continue;
      texts.push(element.textContent || '');
    }
    return texts;
  }

  /**
   * Reads the price: first an aria-label with a discount, otherwise visible
   * texts.
   * @param {!Element} item
   * @param {!Array<!Element>} priceLinks Price links searched first.
   * @param {?Element} exclude Element that contains no price (the title).
   * @return {?Price}
   */
  function readPrice(item, priceLinks, exclude) {
    for (const element of item.querySelectorAll('[aria-label]')) {
      if (isOwn(element)) continue;
      const price =
          parsePriceLabel(element.getAttribute('aria-label'), currency);
      if (price) return price;
    }
    const linkTexts = priceLinks.flatMap((link) => leafTexts(link));
    return parsePriceTexts(linkTexts, currency) ||
        parsePriceTexts(leafTexts(item, exclude), currency);
  }

  /**
   * Store currency stated by the page: the store page declares it in its
   * structured data; otherwise it is detected from the prices in the list.
   * @param {!Element} listRoot
   * @return {?string} Supported ISO 4217 code, null if the page shows none.
   */
  function pageCurrency(listRoot) {
    const meta = document.querySelector('meta[itemprop="priceCurrency"]');
    const declared = meta?.getAttribute('content')?.trim().toUpperCase();
    if (declared && isSupportedCurrency(declared)) return declared;
    /** @type {!Array<string>} */
    const texts = [];
    const walker = document.createTreeWalker(listRoot, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent || '').trim();
      const parent = node.parentElement;
      if (text.length > 24 || !parent || isOwn(parent)) continue;
      if (parent.closest('script, style, button')) continue;
      texts.push(text);
    }
    for (const element of listRoot.querySelectorAll('[aria-label]')) {
      if (!isOwn(element)) texts.push(element.getAttribute('aria-label') || '');
    }
    return detectCurrency(texts);
  }

  /**
   * @param {!Array<!Element>} nodes
   * @return {!Element} Lowest common ancestor.
   */
  function commonAncestor(nodes) {
    let ancestor = nodes[0].parentElement;
    while (ancestor) {
      const candidate = ancestor;
      if (nodes.every((node) => candidate.contains(node))) return candidate;
      ancestor = ancestor.parentElement;
    }
    return document.body;
  }

  // ===========================================================================
  // Page adapters: findItems, listRootOf, readItem
  // ===========================================================================

  /**
   * Base class of the page adapters. Subclasses implement findItems,
   * listRootOf and readItem and may override the other methods.
   * @abstract
   */
  class PageAdapter {
    /**
     * @param {boolean} independentItems Whether an entry's data comes only
     *     from its own subtree. Then a change inside one entry only requires
     *     re-reading that entry.
     */
    constructor(independentItems) {
      /** @const {boolean} */
      this.independentItems = independentItems;
    }

    /**
     * @abstract
     * @param {!Element|!Document} root
     * @return {!Array<!Element>} All entries below root.
     */
    findItems(root) {
      throw new Error('Not implemented');
    }

    /**
     * @abstract
     * @param {!Array<!Element>} items
     * @return {!Element} Element that contains all entries.
     */
    listRootOf(items) {
      throw new Error('Not implemented');
    }

    /**
     * @abstract
     * @param {!Element} item
     * @return {?ItemData}
     */
    readItem(item) {
      throw new Error('Not implemented');
    }

    /**
     * @param {!Element} listRoot
     * @return {!Array<!Element>} Elements to observe for changes; together
     *     they contain everything readItem depends on.
     */
    watchTargets(listRoot) {
      return [listRoot];
    }

    /**
     * @param {!Element} item
     * @return {?number} Position of the entry in the whole list, if the page
     *     exposes one.
     */
    positionOf(item) {
      return null;
    }
  }

  /** Wishlist: virtualized React list, one div[data-index] per row. */
  class WishlistPage extends PageAdapter {
    constructor() {
      super(true);
    }

    /**
     * @param {!Element|!Document} root
     * @return {!Array<!Element>}
     */
    findItems(root) {
      return [...root.querySelectorAll('div[data-index]')].filter(
          (row) => row.querySelector('a[href*="/app/"]') &&
              !row.parentElement?.closest('div[data-index]'));
    }

    /**
     * Read on every pass, not cached: the virtualized list may move a row
     * element to another index.
     * @param {!Element} row
     * @return {?number}
     */
    positionOf(row) {
      const value = row.getAttribute('data-index');
      const index = value ? Number(value) : NaN;
      return Number.isInteger(index) && index >= 0 ? index : null;
    }

    /**
     * @param {!Array<!Element>} items
     * @return {!Element}
     */
    listRootOf(items) {
      const parent = items[0].parentElement || document.body;
      return parent.parentElement || parent;
    }

    /**
     * @param {!Element} row
     * @return {?ItemData}
     */
    readItem(row) {
      const links = [...row.querySelectorAll('a[href*="/app/"]')].filter(
          (link) => !isOwn(link));
      const pattern = currencyPattern(currency);
      const titleAnchor = links.find((link) => {
        const text = link.textContent || '';
        return !link.querySelector('img, [aria-label]') && text.trim() &&
            !pattern.test(text);
      });
      if (!titleAnchor) return null;
      let appid = appIdOf(titleAnchor);
      if (!appid) {
        const drag =
            row.querySelector('[data-rfd-draggable-id^="WishlistItem-"]');
        const dragId = drag?.getAttribute('data-rfd-draggable-id') || '';
        appid = dragId.match(/WishlistItem-(\d+)-/)?.[1] || null;
      }
      if (!appid) return null;
      return {
        key: `app/${appid}`,
        kind: 'app',
        id: appid,
        appids: [appid],
        title: (titleAnchor.textContent || '').trim(),
        anchorEl: titleAnchor,
        focusEl: titleAnchor,
        price: readPrice(
            row, links.filter((link) => link !== titleAnchor), titleAnchor),
      };
    }
  }

  /** Head link of a cart item: app, bundle or package. */
  const CART_HEAD_SELECTOR =
      'a[href*="/app/"], a[href*="/bundle/"], a[href*="/sub/"]';

  /** Cart: head link with an image, title as a separate element. */
  class CartPage extends PageAdapter {
    constructor() {
      super(true);
    }

    /**
     * @param {!Element|!Document} scope
     * @return {!Array<!Element>} Head links with an image.
     */
    heads(scope) {
      return [...scope.querySelectorAll(CART_HEAD_SELECTOR)].filter(
          (link) => link.querySelector('img') && !isOwn(link));
    }

    /**
     * @param {!Element} head
     * @return {!Element} Largest ancestor that contains only this item.
     */
    itemRoot(head) {
      const button = head.closest('[role="button"]');
      if (button && this.heads(button).length === 1) return button;
      let element = head;
      for (let depth = 0; depth < 8; depth++) {
        const parent = element.parentElement;
        if (!parent || this.heads(parent).length !== 1) break;
        element = parent;
      }
      return element;
    }

    /**
     * @param {!Element|!Document} root
     * @return {!Array<!Element>}
     */
    findItems(root) {
      // Only real cart items: they have add/remove buttons with
      // aria-labelledby (recommendations and the like do not).
      const roots =
          new Set(this.heads(root).map((head) => this.itemRoot(head)));
      return [...roots].filter(
          (item) => item.querySelector('[aria-labelledby]'));
    }

    /**
     * @param {!Array<!Element>} items
     * @return {!Element}
     */
    listRootOf(items) {
      return commonAncestor(items);
    }

    /**
     * @param {!Element} item
     * @param {string|undefined} name Expected title (alt text of the image).
     * @return {?Element}
     */
    findTitle(item, name) {
      if (name) {
        for (const element of item.querySelectorAll('*')) {
          if (!element.childElementCount && !element.closest('a') &&
              !isOwn(element) && (element.textContent || '').trim() === name) {
            return element;
          }
        }
      }
      // Fallback: add/remove buttons reference the title via
      // aria-labelledby.
      for (const button of item.querySelectorAll('[aria-labelledby]')) {
        const ids =
            (button.getAttribute('aria-labelledby') || '').trim().split(/\s+/);
        const element = document.getElementById(ids[ids.length - 1]);
        if (element && element !== button && item.contains(element) &&
            (element.textContent || '').trim()) {
          return element;
        }
      }
      return null;
    }

    /**
     * @param {!Element} item
     * @return {?ItemData}
     */
    readItem(item) {
      const head = this.heads(item)[0];
      if (!head) return null;
      const href = head.getAttribute('href') || '';
      const match = href.match(/\/(app|bundle|sub)\/(\d+)/);
      if (!match) return null;
      const [, kind, id] = match;
      const name = head.querySelector('img')?.alt?.trim();
      const titleEl = this.findTitle(item, name);
      if (!titleEl) return null;
      let appids = [id];
      if (kind !== 'app') {
        const links = [...item.querySelectorAll('a[href*="/app/"]')].filter(
            (link) => link !== head && !isOwn(link));
        appids = [...new Set(links.flatMap((link) => {
          const appid = appIdOf(link);
          return appid ? [appid] : [];
        }))];
      }
      return {
        key: `${kind}/${id}`,
        kind,
        id,
        appids,
        title: (titleEl.textContent || '').trim(),
        anchorEl: titleEl,
        // The title is plain text; the head link leads to the same item.
        focusEl: head,
        price: readPrice(item, [], titleEl),
        bundleSize: kind === 'app' ? 0 : appids.length,
      };
    }
  }

  /** Desktop title and responsive title (#appHubAppName_responsive). */
  const STORE_TITLE_SELECTOR = '.apphub_AppName';
  /** Purchase box of an edition, package or bundle. */
  const STORE_OFFER_SELECTOR = '.game_area_purchase_game';

  /**
   * Store page of a game: classic server-rendered HTML with stable classes and
   * data attributes.
   */
  class StorePage extends PageAdapter {
    constructor() {
      // The title badge uses the price of the first purchase box.
      super(false);
      /**
       * Offers found by the last findItems call. Entries are not independent,
       * so every change triggers findItems before readItem runs again.
       * @type {?Array<!Offer>}
       */
      this.offerCache = null;
    }

    /** @return {?string} App ID from the URL. */
    appid() {
      return location.pathname.match(/^\/app\/(\d+)/)?.[1] || null;
    }

    /**
     * Purchase options of this game with a price (editions/packages); bundles
     * with other games do not count.
     * @param {!Element|!Document} scope
     * @return {!Array<!Offer>}
     */
    offers(scope) {
      /** @type {!Array<!Offer>} */
      const offers = [];
      for (const block of scope.querySelectorAll(STORE_OFFER_SELECTOR)) {
        if (block.querySelector('input[name="bundleid"]')) continue;
        const heading = this.heading(block);
        const price = readPrice(block, [], heading);
        if (heading && price) offers.push({block, heading, price});
      }
      return offers;
    }

    /**
     * @param {!Element} block
     * @return {?Element} Heading of the purchase box.
     */
    heading(block) {
      const id = block.getAttribute('aria-labelledby');
      const element = id ? document.getElementById(id) : null;
      return element && block.contains(element) ?
          element :
          block.querySelector('h1, h2');
    }

    /**
     * @param {!Element} element
     * @return {?Node} First child node that is not our badge.
     */
    firstChild(element) {
      return [...element.childNodes].find((node) => !isOwnNode(node)) || null;
    }

    /**
     * @param {!Element} element
     * @return {string} Text without our badge.
     */
    ownText(element) {
      return [...element.childNodes]
          .filter((node) => !isOwnNode(node))
          .map((node) => node.textContent)
          .join('')
          .trim();
    }

    /**
     * @param {!Element|!Document} root
     * @return {!Array<!Element>}
     */
    findItems(root) {
      const items = [...root.querySelectorAll(STORE_TITLE_SELECTOR)];
      this.offerCache = this.offers(root);
      // Separate badges in the purchase boxes only with multiple editions.
      if (this.offerCache.length > 1) {
        items.push(...this.offerCache.map((offer) => offer.block));
      }
      return items;
    }

    /**
     * @param {!Array<!Element>} items
     * @return {!Element}
     */
    listRootOf(items) {
      const blocks = document.querySelectorAll(STORE_OFFER_SELECTOR);
      return commonAncestor([...items, ...blocks]);
    }

    /**
     * The list root spans most of the page (including the media carousel);
     * only the titles and the purchase area matter.
     * @param {!Element} listRoot
     * @return {!Array<!Element>}
     */
    watchTargets(listRoot) {
      const targets = new Set(listRoot.querySelectorAll(STORE_TITLE_SELECTOR));
      for (const block of listRoot.querySelectorAll(STORE_OFFER_SELECTOR)) {
        targets.add(block.closest('#game_area_purchase') || block);
      }
      return [...targets];
    }

    /**
     * @param {!Element} item
     * @return {?ItemData}
     */
    readItem(item) {
      const appid = this.appid();
      if (!appid) return null;
      const offers = this.offerCache || this.offers(document);

      if (item.matches(STORE_TITLE_SELECTOR)) {
        const anchorEl = this.firstChild(item);
        if (!anchorEl) return null;
        const main = offers.length ? offers[0] : null;
        return {
          key: `app/${appid}`,
          kind: 'app',
          id: appid,
          appids: [appid],
          title: this.ownText(item),
          anchorEl,
          // The title is not focusable, so the badge itself is.
          focusEl: null,
          price: main ? main.price : null,
          bundleSize: 0,
          notes: main && offers.length > 1 ?
              [`Offer: ${this.ownText(main.heading)}`] :
              [],
        };
      }

      const offer = offers.find((candidate) => candidate.block === item);
      if (!offer) return null;
      const anchorEl = this.firstChild(offer.heading);
      if (!anchorEl) return null;
      const subidInput = /** @type {?HTMLInputElement} */ (
          item.querySelector('input[name="subid"]'));
      const subid = subidInput?.value ||
          String(offers.indexOf(offer));
      return {
        key: `sub/${subid}`,
        kind: 'sub',
        id: appid,
        appids: [appid],
        title: this.ownText(offer.heading),
        anchorEl,
        focusEl: null,
        price: offer.price,
        bundleSize: 0,
      };
    }
  }

  /** @return {!PageAdapter} Adapter for this page. */
  function createPageAdapter() {
    if (/^\/cart(?:\/|$)/.test(location.pathname)) return new CartPage();
    if (/^\/app\/\d+/.test(location.pathname)) return new StorePage();
    return new WishlistPage();
  }

  const page = createPageAdapter();

  // ===========================================================================
  // Tooltip (one shared element instead of native title tooltips)
  // ===========================================================================

  // Mouse: hovering a badge shows its tooltip. Touch: tapping a badge toggles
  // it. Keyboard: badges are no tab stops, so that a long list does not get
  // an extra stop per row; instead the tooltip opens while the entry's title
  // link has keyboard focus. Where the title is no link (store page), the
  // badge itself is a focusable button.

  /**
   * @type {!WeakMap<!Element, () => !TooltipContent>} Builds the tooltip
   *     content of each badge on demand.
   */
  const tooltipBuilders = new WeakMap();
  /**
   * @type {!WeakMap<!Element, !Element>} Badge of each focusable title link.
   */
  const focusBadges = new WeakMap();
  /** @type {?HTMLElement} */
  let tooltipEl = null;
  /** @type {?Element} Badge the tooltip is shown or about to be shown for. */
  let tooltipBadge = null;
  /**
   * @type {?Element} Element described by the tooltip: the hovered or tapped
   *     badge, or the focused element that opened it.
   */
  let tooltipOwner = null;
  /** @type {number|undefined} */
  let tooltipTimer = undefined;
  let lastPointerType = 'mouse';

  /**
   * @param {?EventTarget} target
   * @return {?Element} The target, if it is an element.
   */
  function elementOf(target) {
    const node = /** @type {?Node} */ (target);
    return node && node.nodeType === Node.ELEMENT_NODE ?
        /** @type {!Element} */ (node) :
        null;
  }

  /**
   * @param {?EventTarget} target
   * @return {?Element} Badge that contains the event target.
   */
  function badgeOf(target) {
    return elementOf(target)?.closest(`.${PREFIX}-badge`) || null;
  }

  /**
   * @param {!Element} badge
   * @return {boolean} Whether the badge is a focusable button.
   */
  function isButtonBadge(badge) {
    return badge.getAttribute('role') === 'button';
  }

  /** @return {boolean} */
  function isTooltipVisible() {
    return Boolean(tooltipEl && !tooltipEl.hidden);
  }

  /** @return {!HTMLElement} The tooltip element, created on first use. */
  function tooltipElement() {
    if (!tooltipEl || !tooltipEl.isConnected) {
      tooltipEl = buildElement('div', {
        class: `${PREFIX}-tooltip`,
        id: `${PREFIX}-tooltip`,
        role: 'tooltip',
      });
      tooltipEl.hidden = true;
      document.body.appendChild(tooltipEl);
    }
    return tooltipEl;
  }

  /** Removes the tooltip references from the current badge and owner. */
  function releaseTooltipTarget() {
    tooltipOwner?.removeAttribute('aria-describedby');
    if (tooltipBadge && isButtonBadge(tooltipBadge)) {
      tooltipBadge.setAttribute('aria-expanded', 'false');
    }
  }

  /**
   * @param {!Element} badge
   * @param {boolean} immediate Skip the hover delay.
   * @param {!Element} owner Element the tooltip describes (see tooltipOwner).
   */
  function showTooltip(badge, immediate, owner) {
    clearTimeout(tooltipTimer);
    tooltipTimer = undefined;
    if (tooltipBadge !== badge || tooltipOwner !== owner) {
      releaseTooltipTarget();
    }
    tooltipBadge = badge;
    tooltipOwner = owner;
    if (immediate) {
      renderTooltip();
    } else {
      tooltipTimer = setTimeout(renderTooltip, CONFIG.tooltipDelayMs);
    }
  }

  /**
   * @param {!TooltipContent} content
   * @return {!Array<!HTMLElement>} Title, breakdown table and notes.
   */
  function buildTooltipNodes(content) {
    const nodes = [buildElement(
        'div', {class: `${PREFIX}-tooltip-title`, text: content.title})];
    if (content.rows.length) {
      /**
       * @param {string} tag
       * @param {string} text
       * @param {string=} cls
       * @return {!HTMLElement}
       */
      const cell = (tag, text, cls = '') =>
        buildElement(tag, cls ? {class: cls, text} : {text});
      const num = `${PREFIX}-num`;
      nodes.push(buildElement('table', {class: `${PREFIX}-tooltip-table`}, [
        buildElement('thead', {}, [buildElement('tr', {}, [
          cell('th', 'Component'),
          cell('th', 'Value'),
          cell('th', 'Points', num),
          cell('th', 'Weight', num),
        ])]),
        buildElement('tbody', {}, content.rows.map((row) =>
          buildElement('tr', {}, [
            cell('th', row.label),
            cell('td', row.value),
            cell('td', row.points, num),
            cell('td', row.weight, num),
          ]))),
        buildElement('tfoot', {}, [buildElement('tr', {}, [
          cell('th', 'Score'),
          cell('td', ''),
          cell('td', content.total, num),
          cell('td', ''),
        ])]),
      ]));
    }
    for (const note of content.notes) {
      nodes.push(
          buildElement('p', {class: `${PREFIX}-tooltip-note`, text: note}));
    }
    return nodes;
  }

  /** Fills and positions the tooltip for the current badge. */
  function renderTooltip() {
    tooltipTimer = undefined;
    const badge = tooltipBadge;
    const buildContent =
        badge && badge.isConnected ? tooltipBuilders.get(badge) : undefined;
    if (!badge || !buildContent) {
      hideTooltip();
      return;
    }
    const tooltip = tooltipElement();
    tooltip.replaceChildren(...buildTooltipNodes(buildContent()));
    tooltip.hidden = false;
    tooltipOwner?.setAttribute('aria-describedby', tooltip.id);
    if (isButtonBadge(badge)) badge.setAttribute('aria-expanded', 'true');
    positionTooltip(tooltip, badge);
  }

  /**
   * Places the tooltip below the badge, or above it if there is no room, and
   * keeps it inside the viewport.
   * @param {!HTMLElement} tooltip
   * @param {!Element} badge
   */
  function positionTooltip(tooltip, badge) {
    const margin = 8;
    const gap = 6;
    const anchor = (badge.firstElementChild || badge).getBoundingClientRect();
    const box = tooltip.getBoundingClientRect();
    const viewport = document.documentElement;
    const left = Math.max(margin,
        Math.min(anchor.left, viewport.clientWidth - margin - box.width));
    let top = anchor.bottom + gap;
    if (top + box.height > viewport.clientHeight - margin &&
        anchor.top - gap - box.height >= margin) {
      top = anchor.top - gap - box.height;
    }
    tooltip.style.transform =
        `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  /** Hides the tooltip and cancels a pending show. */
  function hideTooltip() {
    if (!tooltipBadge && tooltipTimer === undefined) return;
    clearTimeout(tooltipTimer);
    tooltipTimer = undefined;
    releaseTooltipTarget();
    tooltipBadge = null;
    tooltipOwner = null;
    if (tooltipEl) tooltipEl.hidden = true;
  }

  /**
   * @param {!Element} element Element that received focus.
   * @return {?Element} Badge whose tooltip the focus opens: the element
   *     itself if it is a badge, or the badge of a title link.
   */
  function focusedBadge(element) {
    const badge = badgeOf(element) || focusBadges.get(element);
    return badge && badge.isConnected ? badge : null;
  }

  /** Registers the delegated event listeners (once for the whole page). */
  function initTooltip() {
    const passive = {passive: true};
    document.addEventListener('pointerover', (event) => {
      // Touch is handled via click: pointerout follows right after the tap.
      if (event.pointerType === 'touch') return;
      const badge = badgeOf(event.target);
      if (badge === tooltipBadge) return;
      if (badge) {
        showTooltip(badge, isTooltipVisible(), badge);
      } else {
        hideTooltip();
      }
    }, passive);
    document.addEventListener('pointerout', (event) => {
      // Pointer left the window.
      if (event.pointerType !== 'touch' && !event.relatedTarget) hideTooltip();
    }, passive);
    document.addEventListener('pointerdown', (event) => {
      lastPointerType = event.pointerType;
      if (!badgeOf(event.target)) hideTooltip();
    }, {capture: true, passive: true});
    document.addEventListener('click', (event) => {
      // Tapping a badge toggles its tooltip instead of activating the row.
      if (lastPointerType !== 'touch') return;
      const badge = badgeOf(event.target);
      if (!badge) return;
      event.preventDefault();
      event.stopPropagation();
      if (badge === tooltipBadge) {
        hideTooltip();
      } else {
        showTooltip(badge, true, badge);
      }
    }, true);
    document.addEventListener('focusin', (event) => {
      // Only keyboard focus: clicks and taps focus links and badges as well,
      // but are handled by the pointer listeners.
      const element = elementOf(event.target);
      const badge = element && focusedBadge(element);
      if (element && badge && element.matches(':focus-visible')) {
        showTooltip(badge, true, element);
      }
    });
    document.addEventListener('focusout', (event) => {
      if (event.target === tooltipOwner) hideTooltip();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        hideTooltip();
        return;
      }
      // A focused badge button toggles its tooltip.
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const badge = elementOf(event.target);
      if (!badge || !badge.matches(`.${PREFIX}-badge`) ||
          !isButtonBadge(badge)) {
        return;
      }
      event.preventDefault();
      if (badge === tooltipBadge && isTooltipVisible()) {
        hideTooltip();
      } else {
        showTooltip(badge, true, badge);
      }
    });
    window.addEventListener('scroll', () => {
      // Focusing an element scrolls it into view: keep its tooltip in place.
      if (tooltipBadge && tooltipOwner &&
          tooltipOwner === document.activeElement && isTooltipVisible()) {
        positionTooltip(tooltipElement(), tooltipBadge);
      } else {
        hideTooltip();
      }
    }, {capture: true, ...passive});
    window.addEventListener('resize', hideTooltip, passive);
  }

  // ===========================================================================
  // Top list panel (wishlist only)
  // ===========================================================================

  // The entries are kept in a TopList (see there); all of them are dropped
  // when the list is replaced or the URL changes (filters, another
  // wishlist).

  const topList = new TopList();
  const topListEnabled = page instanceof WishlistPage;
  let topListDirty = false;
  let topListVersion = 0;
  /**
   * Incremented when the top list is reset, so that rendered badges report
   * their entries again.
   */
  let topListEpoch = 0;
  /** @type {?HTMLElement} */
  let panelEl = null;
  let panelSig = '';

  /**
   * @param {*} raw
   * @return {!PanelPrefs}
   */
  function sanitizePanelPrefs(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    return {
      size: CONFIG.topListSizes.includes(input.size) ?
          input.size :
          CONFIG.topListDefaultSize,
      collapsed: typeof input.collapsed === 'boolean' ?
          input.collapsed :
          window.matchMedia(CONFIG.topListCollapsedQuery).matches,
    };
  }

  /** @type {!PanelPrefs} */
  const panelPrefs = sanitizePanelPrefs(GM_getValue(STORAGE_PANEL, null));

  /** Forgets all entries, e.g. when the list was replaced. */
  function resetTopList() {
    if (!topListEnabled) return;
    topList.clear();
    topListEpoch++;
    topListDirty = true;
  }

  /**
   * Records which entry is shown at a list position.
   * @param {string} key
   * @param {?number} position
   */
  function notePosition(key, position) {
    if (!topListEnabled || position == null) return;
    if (topList.notePosition(key, position)) topListDirty = true;
  }

  /**
   * Remembers or forgets an entry after its badge was rendered.
   * @param {!ItemData} data
   * @param {?number} position
   * @param {!Extra} extra
   * @param {!ScoreResult} result
   */
  function rememberTopEntry(data, position, extra, result) {
    if (!topListEnabled) return;
    if (result.status === 'ok' && data.price && extra.state !== 'pending') {
      topList.set({
        key: data.key,
        appid: data.id,
        title: data.title,
        price: data.price,
        hist: extra.hist,
        score: result.score,
        version: settingsVersion,
        position,
      });
    } else {
      topList.delete(data.key);
    }
    topListDirty = true;
  }

  /** Updates the panel if entries, settings or preferences changed. */
  function updateTopList() {
    if (!topListEnabled) return;
    if (!topListDirty && topListVersion === settingsVersion) return;
    topListDirty = false;
    if (topListVersion !== settingsVersion) {
      topList.rescore(settings, settingsVersion);
      topListVersion = settingsVersion;
    }
    const ranked = topList.ranked(panelPrefs.size);
    const sig = [
      topList.size,
      panelPrefs.size,
      panelPrefs.collapsed,
      currency,
      ...ranked.map((entry) => `${entry.key}:${entry.score}`),
    ].join('|');
    if (sig === panelSig && panelEl?.isConnected) return;
    panelSig = sig;
    renderPanel(ranked);
  }

  /** Saves the preferences and redraws the panel. */
  function applyPanelPrefs() {
    GM_setValue(STORAGE_PANEL, panelPrefs);
    topListDirty = true;
    updateTopList();
  }

  /**
   * Takes over preferences saved in another tab.
   * @param {*} value
   */
  function applyRemotePanelPrefs(value) {
    Object.assign(panelPrefs, sanitizePanelPrefs(value));
    topListDirty = true;
    updateTopList();
  }

  /**
   * @param {!Element} scope
   * @param {string} selector
   * @return {!HTMLElement} The element, which our own markup always has.
   */
  function ownElement(scope, selector) {
    const element = scope.querySelector(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    return /** @type {!HTMLElement} */ (element);
  }

  /** @return {!HTMLElement} The panel element, created on first use. */
  function panelElement() {
    if (panelEl && panelEl.isConnected) return panelEl;
    const bodyId = `${PREFIX}-panel-body`;
    const toggle = buildElement('button', {
      'type': 'button',
      'class': `${PREFIX}-panel-toggle`,
      'aria-controls': bodyId,
    });
    const select = /** @type {!HTMLSelectElement} */ (buildElement('select', {
      'class': `${PREFIX}-panel-size`,
      'aria-label': 'Number of titles',
    }));
    for (const size of CONFIG.topListSizes) {
      select.append(
          buildElement('option', {value: String(size), text: `Top ${size}`}));
    }
    panelEl = buildElement('aside', {
      'class': `${PREFIX}-panel`,
      'aria-label': 'Best deals on this wishlist',
    }, [
      buildElement('div', {class: `${PREFIX}-panel-head`}, [toggle, select]),
      buildElement('div', {class: `${PREFIX}-panel-body`, id: bodyId}, [
        buildElement('ol', {class: `${PREFIX}-panel-list`}),
        buildElement('p', {class: `${PREFIX}-panel-foot`}),
      ]),
    ]);
    toggle.addEventListener('click', () => {
      panelPrefs.collapsed = !panelPrefs.collapsed;
      applyPanelPrefs();
    });
    select.addEventListener('change', () => {
      panelPrefs.size = Number(select.value);
      applyPanelPrefs();
    });
    document.body.appendChild(panelEl);
    return panelEl;
  }

  /**
   * @param {!Price} price
   * @return {string} e.g. "€7.49 · −70%".
   */
  function formatPanelPrice(price) {
    if (price.free) return 'Free';
    const amount = formatMoney(price.final, currency);
    return price.discount > 0 ? `${amount} · −${price.discount}%` : amount;
  }

  /**
   * Draws the panel.
   * @param {!Array<!TopEntry>} ranked Best entries, in order.
   */
  function renderPanel(ranked) {
    const panel = panelElement();
    panel.hidden = topList.size === 0;
    const toggle = ownElement(panel, `.${PREFIX}-panel-toggle`);
    toggle.textContent = `${panelPrefs.collapsed ? '▸' : '▾'} Top deals`;
    toggle.setAttribute('aria-expanded', String(!panelPrefs.collapsed));
    const sizeSelect = /** @type {!HTMLSelectElement} */ (
      ownElement(panel, `.${PREFIX}-panel-size`));
    sizeSelect.value = String(panelPrefs.size);
    const body = ownElement(panel, `.${PREFIX}-panel-body`);
    body.hidden = panelPrefs.collapsed;
    if (panelPrefs.collapsed) return;

    ownElement(panel, `.${PREFIX}-panel-list`).replaceChildren(
        ...ranked.map((entry) => {
          const pill = buildElement(
              'span', {class: `${PREFIX}-pill`, text: String(entry.score)});
          pill.style.background = scoreColor(entry.score);
          return buildElement('li', {}, [
            buildElement('a', {
              href: `/app/${entry.appid}/`,
              target: '_blank',
              rel: 'noopener',
              title: entry.title,
            }, [
              pill,
              buildElement(
                  'span', {class: `${PREFIX}-panel-title`, text: entry.title}),
              buildElement('span', {
                class: `${PREFIX}-panel-price`,
                text: formatPanelPrice(entry.price),
              }),
            ]),
          ]);
        }));
    const noun = topList.size === 1 ? 'title' : 'titles';
    ownElement(panel, `.${PREFIX}-panel-foot`).textContent =
        `${formatInteger(topList.size)} ${noun} scored so far – ` +
        'scroll through the wishlist to include more.';
  }

  // ===========================================================================
  // Badges (only our own elements are inserted; the page's nodes are left as
  // they are, except for aria-describedby on a title link while its tooltip
  // is open)
  // ===========================================================================

  /** @type {!WeakMap<!Element, !ItemData>} Parsed data per entry. */
  let itemCache = new WeakMap();

  /** Extra data of an entry without a price: it gets no score anyway. */
  const UNUSED_EXTRA = Object.freeze({state: 'unused', hist: null, t: 0});

  /**
   * @param {boolean} focusable Whether the badge is a focusable button (when
   *     the entry has no focusable title link).
   * @return {!HTMLElement}
   */
  function createBadge(focusable) {
    const badge = document.createElement('span');
    badge.className = `${PREFIX}-badge`;
    if (focusable) {
      badge.setAttribute('role', 'button');
      badge.setAttribute('aria-expanded', 'false');
      badge.tabIndex = 0;
    } else {
      badge.setAttribute('role', 'img');
    }
    const pill = document.createElement('span');
    pill.className = `${PREFIX}-pill`;
    badge.appendChild(pill);
    return badge;
  }

  /**
   * @param {!Element} badge
   * @param {!ItemData} data
   * @param {!Extra} extra
   * @return {!ScoreResult}
   */
  function renderBadge(badge, data, extra) {
    const result = computeScore(data, extra.hist, settings);
    const pill = /** @type {!HTMLElement} */ (badge.firstElementChild);
    let text;
    let label;
    let color = null;
    if (result.status === 'noPrice') {
      text = '–';
      label = 'Deal score unavailable';
    } else if (extra.state === 'pending') {
      text = '…';
      label = 'Calculating deal score';
    } else if (result.status !== 'ok') {
      text = '–';
      label = 'Deal score unavailable';
    } else {
      text = String(result.score);
      label = `Deal score ${result.score} out of 100`;
      color = scoreColor(result.score);
    }
    pill.textContent = text;
    pill.style.background = color || CONFIG.neutralColor;
    pill.classList.toggle(`${PREFIX}-neutral`, !color);
    pill.classList.toggle(
        `${PREFIX}-noreviews`, result.status === 'ok' && !result.hasReviews);
    // The breakdown is only built when the tooltip is actually shown.
    const storeCurrency = currency;
    tooltipBuilders.set(badge, () => buildTooltip(result, extra.state, {
      bundleSize: data.bundleSize,
      bundleMissing: extra.missing || 0,
      notes: data.notes,
      currency: storeCurrency,
    }));
    badge.setAttribute('aria-label', label);
    if (badge === tooltipBadge && isTooltipVisible()) renderTooltip();
    return result;
  }

  /**
   * Sets or removes a data attribute, only if it changes.
   * @param {!HTMLElement} element
   * @param {string} name
   * @param {?string} value null removes the attribute.
   */
  function setData(element, name, value) {
    if (value == null) {
      if (name in element.dataset) delete element.dataset[name];
    } else if (element.dataset[name] !== value) {
      element.dataset[name] = value;
    }
  }

  /**
   * Inserts or updates the badge of an entry (idempotent).
   * @param {!Element} item
   * @param {?Array<!Object>} report Collects debug rows, otherwise null.
   */
  function processItem(item, report) {
    // Reading an entry is the expensive part; reuse the parsed data until a
    // mutation inside the entry invalidates it.
    let data = itemCache.get(item);
    if (!data || !item.contains(data.anchorEl)) {
      data = page.readItem(item) || undefined;
      if (!data) {
        itemCache.delete(item);
        return;
      }
      itemCache.set(item, data);
    }
    const anchor = data.anchorEl;
    const parent = anchor.parentNode;
    if (!parent) return;
    const position = page.positionOf(item);
    notePosition(data.key, position);

    const badges = item.querySelectorAll(`.${PREFIX}-badge`);
    // Remove duplicate badges (our own elements only).
    for (let i = 1; i < badges.length; i++) {
      badges[i].remove();
    }
    const badge = /** @type {!HTMLElement} */ (
      badges[0] || createBadge(!data.focusEl));
    if (badge.nextSibling !== anchor) {
      parent.insertBefore(badge, anchor);
    }
    if (data.focusEl) focusBadges.set(data.focusEl, badge);
    if (badge.dataset.key !== data.key) {
      badge.dataset.key = data.key;
      delete badge.dataset.sig;
    }
    setData(badge, 'appid', data.kind === 'app' ? data.id : null);
    // Set before getExtraFor: the queue checks for it.
    setData(badge, 'appids', data.appids.join(' '));

    // Without a price there is no score, so the histogram is not requested.
    const extra = data.price ? getExtraFor(data.appids) : UNUSED_EXTRA;
    const sig = [
      data.key,
      data.appids.join(','),
      JSON.stringify(data.price),
      extra.state,
      extra.t,
      settingsVersion,
      position,
      topListEpoch,
    ].join('|');
    if (badge.dataset.sig === sig) return;

    const result = renderBadge(badge, data, extra);
    badge.dataset.sig = sig;
    rememberTopEntry(data, position, extra, result);
    if (report) {
      const hist = extra.hist;
      const reviews = hist ? hist.upTotal + hist.downTotal : 0;
      report.push({
        item: data.key,
        title: data.title,
        reviews: hist ? reviews : null,
        positive: hist && reviews ? hist.upTotal / reviews : null,
        recent30: hist ? hist.up30 + hist.down30 : null,
        discount: data.price?.discount ?? null,
        original: data.price?.original ?? null,
        final: data.price?.final ?? null,
        extra: extra.state,
        score: result.status === 'ok' ? result.score : null,
      });
    }
  }

  /** @param {!Iterable<!Element>} items */
  function processItems(items) {
    const report = DEBUG ? [] : null;
    for (const item of items) {
      try {
        processItem(item, report);
      } catch (e) {
        console.error('[Deal Score] Error in row', item, e);
      }
    }
    if (report && report.length) console.table(report);
  }

  // ===========================================================================
  // Observing the list
  // ===========================================================================

  /** @type {?Element} */
  let listRoot = null;
  /** @type {?Node} List root (or body) whose targets are observed. */
  let observedRoot = null;
  let frameRequested = false;
  /** @type {!Set<!Element>} Entries found by the last full scan. */
  let knownItems = new Set();
  /** @type {!Set<!Element>} Entries changed since the last tick. */
  const dirtyItems = new Set();
  /** Whether entries may have been added or removed since the last tick. */
  let fullScanNeeded = true;
  /** Page URL without hash, to notice navigation within the app. */
  let lastUrl = location.pathname + location.search;
  /** Time of the last search for the list (see CONFIG.searchIntervalMs). */
  let lastSearchAt = -Infinity;
  /** Time of the last attempt to detect the currency. */
  let lastDetectAt = -Infinity;
  /** @type {number|undefined} Pending tick after a throttled search. */
  let searchTimer = undefined;

  /**
   * @param {!Node} node
   * @return {?Element} Known entry that contains the node.
   */
  function knownItemOf(node) {
    let element = node.nodeType === Node.ELEMENT_NODE ?
        /** @type {!Element} */ (node) :
        node.parentElement;
    for (; element && element !== listRoot; element = element.parentElement) {
      if (knownItems.has(element)) return element;
    }
    return null;
  }

  /**
   * @param {!MutationRecord} record
   * @return {boolean} Whether the change only affects our own elements.
   */
  function isOwnMutation(record) {
    const target = record.target.nodeType === Node.ELEMENT_NODE ?
        /** @type {!Element} */ (record.target) :
        record.target.parentElement;
    if (target && isOwn(target)) return true;
    if (record.type !== 'childList') return false;
    const nodes = [...record.addedNodes, ...record.removedNodes];
    return nodes.length > 0 &&
        nodes.every((node) => node.nodeType === Node.ELEMENT_NODE &&
            /** @type {!Element} */ (node).matches(OWN_SELECTOR));
  }

  const OBSERVER_OPTIONS = Object.freeze({
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['href', 'title', 'aria-label'],
  });

  const observer = new MutationObserver((records) => {
    let changed = false;
    for (const record of records) {
      if (isOwnMutation(record)) continue;
      changed = true;
      const item = page.independentItems ? knownItemOf(record.target) : null;
      if (item) {
        dirtyItems.add(item);
      } else {
        fullScanNeeded = true;
        if (!page.independentItems) break;
      }
    }
    if (changed) schedule();
  });

  // Watches the ancestors of the list root (children only, no subtree): if
  // the list is replaced entirely (e.g. when changing filters), the list
  // observer does not notice.
  const detachObserver = new MutationObserver(() => {
    if (listRoot && !listRoot.isConnected) schedule();
  });

  /** @param {!Element} root List root, or document.body while searching. */
  function observe(root) {
    if (observedRoot === root) return;
    observer.disconnect();
    detachObserver.disconnect();
    const searching = root === document.body;
    for (const target of searching ? [root] : page.watchTargets(root)) {
      observer.observe(target, OBSERVER_OPTIONS);
    }
    if (!searching) {
      for (let node = root.parentNode; node; node = node.parentNode) {
        detachObserver.observe(node, {childList: true});
      }
    }
    observedRoot = root;
    log('Observing', searching ? 'body' : 'list');
  }

  /** Batches processing via requestAnimationFrame. */
  function schedule() {
    if (frameRequested) return;
    frameRequested = true;
    requestAnimationFrame(() => {
      frameRequested = false;
      tick();
    });
  }

  /**
   * Runs a tick after a delay, unless one is already pending.
   * @param {number} ms
   */
  function scheduleAfter(ms) {
    if (searchTimer !== undefined) return;
    searchTimer = setTimeout(() => {
      searchTimer = undefined;
      schedule();
    }, ms);
  }

  /**
   * Switches the store currency: prices read so far are read again, and the
   * badges and the top list are redrawn.
   * @param {string} code Supported ISO 4217 code.
   */
  function setCurrency(code) {
    if (code === currency) return;
    log('Currency', code);
    currency = code;
    itemCache = new WeakMap();
    fullScanNeeded = true;
    settingsVersion++;
    resetTopList();
  }

  /**
   * Detects the store currency from the page once, if the settings leave it
   * to the page. Until then the last detected currency is used.
   * @param {!Element} root List root.
   */
  function refreshCurrency(root) {
    if (currencySettled) return;
    const now = Date.now();
    if (now - lastDetectAt < CONFIG.searchIntervalMs) return;
    lastDetectAt = now;
    const code = pageCurrency(root);
    if (!code) return;
    currencySettled = true;
    GM_setValue(STORAGE_CURRENCY, code);
    setCurrency(code);
  }

  /**
   * Finds the list, observes it and updates all entries. Only new or changed
   * entries are read again; the others just re-check their extra data.
   */
  function tick() {
    const url = location.pathname + location.search;
    const replaced = Boolean(listRoot && !listRoot.isConnected);
    if (replaced || url !== lastUrl) {
      lastUrl = url;
      resetTopList();
    }
    if (replaced) listRoot = null;
    if (!listRoot) {
      // Searching the whole page is expensive and a page without a list
      // (e.g. an empty wishlist) keeps changing: search at most every
      // CONFIG.searchIntervalMs.
      const wait = lastSearchAt + CONFIG.searchIntervalMs - Date.now();
      if (wait > 0) {
        scheduleAfter(wait);
      } else {
        lastSearchAt = Date.now();
        const items = page.findItems(document);
        listRoot = items.length ? page.listRootOf(items) : null;
        fullScanNeeded = true;
      }
    }
    observe(listRoot || document.body);
    if (listRoot) {
      refreshCurrency(listRoot);
      if (fullScanNeeded) {
        if (!page.independentItems) itemCache = new WeakMap();
        knownItems = new Set(page.findItems(listRoot));
        fullScanNeeded = false;
      }
      for (const item of dirtyItems) itemCache.delete(item);
      dirtyItems.clear();
      processItems(knownItems);
    }
    updateTopList();
    if (tooltipBadge && !tooltipBadge.isConnected) hideTooltip();
  }

  // ===========================================================================
  // Styles & settings dialog
  // ===========================================================================

  /** Injects the styles once. */
  function injectStyles() {
    if (document.getElementById(`${PREFIX}-style`)) return;
    const style = document.createElement('style');
    style.id = `${PREFIX}-style`;
    style.textContent = `
      .${PREFIX}-badge {
        float: left;
        display: flex;
        align-items: center;
        flex: none;
        height: 1.2em;
        height: 1lh;
        margin-right: 0.5em;
      }
      .${PREFIX}-pill {
        box-sizing: border-box;
        display: inline-block;
        min-width: 2.4em;
        padding: 0 6px;
        border: 1px solid rgba(0, 0, 0, 0.35);
        border-radius: 9px;
        font: 700 12px/16px "Motiva Sans", Arial, Helvetica, sans-serif;
        font-variant-numeric: tabular-nums;
        letter-spacing: 0;
        text-align: center;
        text-decoration: none;
        text-transform: none;
        white-space: nowrap;
        color: #0e1116;
        cursor: help;
      }
      .${PREFIX}-pill.${PREFIX}-neutral { color: #c7d5e0; }
      .${PREFIX}-pill.${PREFIX}-noreviews { border: 1px dashed #f2f6f9; }
      .${PREFIX}-badge:focus { outline: none; }
      .${PREFIX}-badge:focus-visible .${PREFIX}-pill {
        outline: 2px solid #66c0f4;
        outline-offset: 1px;
      }

      .${PREFIX}-tooltip {
        position: fixed;
        top: 0;
        left: 0;
        z-index: 99999;
        box-sizing: border-box;
        max-width: min(440px, calc(100vw - 16px));
        padding: 7px 10px;
        border: 1px solid #3d4450;
        border-radius: 4px;
        background: #171d25;
        color: #c7d5e0;
        font: 12px/1.5 "Motiva Sans", Arial, Helvetica, sans-serif;
        text-align: left;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
        pointer-events: none;
      }
      .${PREFIX}-tooltip[hidden] { display: none; }
      .${PREFIX}-tooltip-title {
        color: #fff;
        font-weight: 700;
      }
      .${PREFIX}-tooltip-table {
        margin-top: 4px;
        border-collapse: collapse;
      }
      .${PREFIX}-tooltip-table th,
      .${PREFIX}-tooltip-table td {
        padding: 1px 6px;
        font-weight: 400;
        text-align: left;
        vertical-align: top;
      }
      .${PREFIX}-tooltip-table th:first-child { padding-left: 0; }
      .${PREFIX}-tooltip-table :is(th, td):last-child { padding-right: 0; }
      .${PREFIX}-tooltip-table thead th {
        border-bottom: 1px solid #3d4450;
        color: #8f98a0;
      }
      .${PREFIX}-tooltip-table tfoot :is(th, td) {
        border-top: 1px solid #3d4450;
        color: #fff;
        font-weight: 700;
      }
      .${PREFIX}-tooltip-table .${PREFIX}-num {
        text-align: right;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .${PREFIX}-tooltip-note {
        margin: 4px 0 0;
        color: #8f98a0;
      }

      .${PREFIX}-panel {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 9999;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        width: min(340px, calc(100vw - 32px));
        max-height: min(70vh, 600px);
        border: 1px solid #3d4450;
        border-radius: 6px;
        background: #171d25;
        color: #c7d5e0;
        font: 13px/1.4 "Motiva Sans", Arial, Helvetica, sans-serif;
        color-scheme: dark;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.6);
      }
      .${PREFIX}-panel[hidden],
      .${PREFIX}-panel-body[hidden] {
        display: none;
      }
      .${PREFIX}-panel-head {
        display: flex;
        flex: none;
        gap: 8px;
        align-items: center;
        padding: 6px 8px;
      }
      .${PREFIX}-panel-toggle {
        flex: 1;
        padding: 2px 4px;
        border: 0;
        background: none;
        color: #fff;
        font: 600 14px/1.4 "Motiva Sans", Arial, Helvetica, sans-serif;
        text-align: left;
        cursor: pointer;
      }
      .${PREFIX}-panel-size {
        padding: 2px 4px;
        border: 1px solid #3d4450;
        border-radius: 3px;
        background: #101822;
        color: #fff;
        font: inherit;
      }
      .${PREFIX}-panel-body {
        min-height: 0;
        overflow-y: auto;
        border-top: 1px solid #3d4450;
      }
      .${PREFIX}-panel-list {
        margin: 0;
        padding: 4px 0;
        list-style: none;
        counter-reset: ${PREFIX}-rank;
      }
      .${PREFIX}-panel-list a {
        display: grid;
        grid-template-columns: 2em auto 1fr;
        grid-template-areas:
          "rank pill title"
          "rank pill price";
        column-gap: 8px;
        align-items: center;
        padding: 4px 10px;
        color: inherit;
        text-decoration: none;
      }
      .${PREFIX}-panel-list a:hover,
      .${PREFIX}-panel-list a:focus-visible {
        background: #2a3646;
      }
      .${PREFIX}-panel-list a::before {
        counter-increment: ${PREFIX}-rank;
        content: counter(${PREFIX}-rank) ".";
        grid-area: rank;
        color: #8f98a0;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .${PREFIX}-panel .${PREFIX}-pill {
        grid-area: pill;
        cursor: inherit;
      }
      .${PREFIX}-panel-title {
        grid-area: title;
        overflow: hidden;
        color: #fff;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .${PREFIX}-panel-price {
        grid-area: price;
        color: #8f98a0;
        font-size: 12px;
      }
      .${PREFIX}-panel-foot {
        margin: 0;
        padding: 6px 10px 8px;
        color: #8f98a0;
        font-size: 12px;
      }

      .${PREFIX}-dialog {
        box-sizing: border-box;
        width: min(440px, calc(100vw - 32px));
        padding: 18px 20px;
        border: 1px solid #3d4450;
        border-radius: 6px;
        background: #1b2838;
        color: #c7d5e0;
        font: 14px/1.4 "Motiva Sans", Arial, Helvetica, sans-serif;
        color-scheme: dark;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6);
      }
      .${PREFIX}-dialog::backdrop { background: rgba(0, 0, 0, 0.6); }
      .${PREFIX}-dialog h2 {
        margin: 0 0 12px;
        font-size: 18px;
        font-weight: 600;
        color: #fff;
      }
      .${PREFIX}-dialog fieldset {
        margin: 0 0 12px;
        padding: 8px 12px 10px;
        border: 1px solid #3d4450;
        border-radius: 4px;
      }
      .${PREFIX}-dialog legend { padding: 0 4px; color: #8f98a0; }
      .${PREFIX}-row {
        display: grid;
        grid-template-columns: 1fr 84px 48px;
        gap: 8px;
        align-items: center;
        margin: 4px 0;
      }
      .${PREFIX}-row.${PREFIX}-check { grid-template-columns: auto 1fr; }
      .${PREFIX}-share {
        color: #8f98a0;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .${PREFIX}-hint { display: block; color: #8f98a0; font-size: 12px; }
      .${PREFIX}-dialog input[type="number"],
      .${PREFIX}-dialog select {
        box-sizing: border-box;
        width: 100%;
        padding: 3px 6px;
        border: 1px solid #3d4450;
        border-radius: 3px;
        background: #101822;
        color: #fff;
        font: inherit;
      }
      .${PREFIX}-buttons {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 14px;
      }
      .${PREFIX}-buttons .${PREFIX}-spacer { flex: 1; }
      .${PREFIX}-dialog button {
        padding: 5px 12px;
        border: 0;
        border-radius: 3px;
        background: #3d4450;
        color: #fff;
        font: inherit;
        cursor: pointer;
      }
      .${PREFIX}-dialog button:hover { background: #4b5563; }
      .${PREFIX}-dialog button.${PREFIX}-primary { background: #4c8b2b; }
      .${PREFIX}-dialog button.${PREFIX}-primary:hover {
        background: #5ba332;
      }
      .${PREFIX}-status {
        min-height: 1.4em;
        margin-top: 8px;
        color: #a4d007;
        font-size: 12px;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  /** Weights in the dialog. */
  const WEIGHT_FIELDS =
      /** @type {!ReadonlyArray<{key: keyof Weights, label: string}>} */ (
        deepFreeze([
          {key: 'overall', label: 'Overall rating'},
          {key: 'recent', label: 'Last 30 days'},
          {key: 'discount', label: 'Discount'},
          {key: 'price', label: 'Price'},
          {key: 'popularity', label: 'Popularity'},
        ]));

  /**
   * @param {string} id
   * @param {!Array<!Node|string>} label
   * @param {string} hint
   * @param {!Element} input
   * @return {!HTMLElement} Row with an input field or select.
   */
  function buildInputRow(id, label, hint, input) {
    return buildElement('div', {class: `${PREFIX}-row`}, [
      buildElement('label', {for: id}, [
        ...label,
        buildElement('span', {class: `${PREFIX}-hint`, text: hint}),
      ]),
      input,
      buildElement('span'),
    ]);
  }

  /**
   * @param {string} id
   * @param {string} name
   * @param {string} label
   * @param {string} hint
   * @return {!HTMLElement} Row with a checkbox.
   */
  function buildCheckRow(id, name, label, hint) {
    return buildElement('div', {class: `${PREFIX}-row ${PREFIX}-check`}, [
      buildElement('input', {id, name, type: 'checkbox'}),
      buildElement('label', {for: id}, [
        label,
        buildElement('span', {class: `${PREFIX}-hint`, text: hint}),
      ]),
    ]);
  }

  /**
   * @param {{min: number, max: number, step: number}} limit
   * @return {!Object<string, string>} min, max and step attributes.
   */
  function limitAttributes(limit) {
    return {
      min: String(limit.min),
      max: String(limit.max),
      step: String(limit.step),
    };
  }

  /**
   * @param {!HTMLFormElement} form
   * @param {string} name
   * @return {!HTMLInputElement} The form's input with that name.
   */
  function inputOf(form, name) {
    return /** @type {!HTMLInputElement} */ (form.elements.namedItem(name));
  }

  /**
   * @param {!HTMLFormElement} form
   * @return {!HTMLSelectElement} The currency select.
   */
  function currencySelectOf(form) {
    return /** @type {!HTMLSelectElement} */ (
      form.elements.namedItem('currency'));
  }

  /**
   * Applies new settings: redraws all badges and adopts the currency.
   * @param {!Settings} next
   */
  function applySettings(next) {
    const wasAuto = settings.currency === 'auto';
    settings = next;
    if (next.currency !== 'auto') {
      currencySettled = true;
      setCurrency(next.currency);
    } else if (!wasAuto) {
      // Detect again; until then use the last detected currency.
      currencySettled = false;
      lastDetectAt = -Infinity;
      setCurrency(storedCurrency());
    }
    settingsVersion++;
    pump();
    schedule();
  }

  /** @return {!HTMLDialogElement} */
  function buildSettingsDialog() {
    const dialog = /** @type {!HTMLDialogElement} */ (buildElement('dialog', {
      'class': `${PREFIX}-dialog`,
      'id': `${PREFIX}-settings`,
      'aria-labelledby': `${PREFIX}-title`,
    }));
    const form = /** @type {!HTMLFormElement} */ (
      buildElement('form', {method: 'dialog'}));

    const weights = buildElement('fieldset', {}, [
      buildElement('legend', {text: 'Weights (normalized automatically)'}),
    ]);
    for (const {key, label} of WEIGHT_FIELDS) {
      const id = `${PREFIX}-w-${key}`;
      weights.append(buildElement('div', {class: `${PREFIX}-row`}, [
        buildElement('label', {for: id, text: label}),
        buildElement('input', {
          id,
          name: `w.${key}`,
          type: 'number',
          ...limitAttributes(CONFIG.limits.weight),
          required: '',
        }),
        buildElement('span', {'class': `${PREFIX}-share`, 'data-share': key}),
      ]));
    }

    const currencySelect = buildElement(
        'select', {id: `${PREFIX}-currency`, name: 'currency'}, [
          buildElement('option', {'value': 'auto', 'data-auto': ''}),
          ...Object.keys(TEXT.currencyPatterns).map(
              (code) => buildElement('option', {value: code, text: code})),
        ]);
    const other = buildElement('fieldset', {}, [
      buildElement('legend', {text: 'Other settings'}),
      buildInputRow(
          `${PREFIX}-currency`, ['Store currency'],
          'Prices in other currencies get no score.', currencySelect),
      buildInputRow(
          `${PREFIX}-ref`, [
            'Reference price (',
            buildElement('span', {'data-ref-symbol': ''}),
            ')',
          ],
          'At this final price the price component is 50.',
          buildElement('input', {
            id: `${PREFIX}-ref`,
            name: 'referencePrice',
            type: 'number',
            ...limitAttributes(CONFIG.limits.referencePrice),
            required: '',
          })),
      buildCheckRow(
          `${PREFIX}-extra`, 'fetchExtra', 'Load extra data',
          'Source of all review values. Off = no network requests, ' +
              'score based on discount and price only.'),
      buildCheckRow(
          `${PREFIX}-penalty`, 'qualityPenalty', 'Quality penalty',
          'A big discount does not turn a poorly rated game green.'),
    ]);

    const saveButton = buildElement(
        'button',
        {type: 'submit', class: `${PREFIX}-primary`, text: 'Save'});
    const cancelButton =
        buildElement('button', {type: 'button', text: 'Cancel'});
    const defaultsButton = buildElement(
        'button', {type: 'button', text: 'Restore defaults'});
    const cacheButton =
        buildElement('button', {type: 'button', text: 'Clear cache'});
    const status =
        buildElement('div', {class: `${PREFIX}-status`, role: 'status'});

    form.append(
        buildElement(
            'h2', {id: `${PREFIX}-title`, text: 'Deal Score – Settings'}),
        weights,
        other,
        buildElement('div', {class: `${PREFIX}-buttons`}, [
          defaultsButton,
          cacheButton,
          buildElement('span', {class: `${PREFIX}-spacer`}),
          cancelButton,
          saveButton,
        ]),
        status);
    dialog.append(form);

    form.addEventListener('input', () => updateForm(form));
    cancelButton.addEventListener('click', () => dialog.close());
    defaultsButton.addEventListener('click', () => {
      writeForm(form, defaultSettings());
      status.textContent = 'Defaults filled in – click "Save" to apply.';
    });
    cacheButton.addEventListener('click', () => {
      const removed = cachePrune(true);
      // Running requests discard their results; the badges switch to
      // "pending" and request their data again on the next tick.
      cacheEpoch++;
      histMem.clear();
      schedule();
      status.textContent = `Cache cleared (${removed} entries).`;
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const next = sanitizeSettings(readForm(form));
      GM_setValue(STORAGE_SETTINGS, next);
      applySettings(next);
      dialog.close();
    });
    return dialog;
  }

  /**
   * @param {!HTMLFormElement} form
   * @param {!Settings} values
   */
  function writeForm(form, values) {
    for (const {key} of WEIGHT_FIELDS) {
      inputOf(form, `w.${key}`).value = String(values.weights[key]);
    }
    currencySelectOf(form).value = values.currency;
    inputOf(form, 'referencePrice').value = String(values.referencePrice);
    inputOf(form, 'fetchExtra').checked = values.fetchExtra;
    inputOf(form, 'qualityPenalty').checked = values.qualityPenalty;
    updateForm(form);
  }

  /**
   * @param {!HTMLFormElement} form
   * @return {!Object} Raw values, not yet validated.
   */
  function readForm(form) {
    /** @type {!Object<string, string>} */
    const weights = {};
    for (const {key} of WEIGHT_FIELDS) {
      weights[key] = inputOf(form, `w.${key}`).value;
    }
    return {
      weights,
      referencePrice: inputOf(form, 'referencePrice').value,
      fetchExtra: inputOf(form, 'fetchExtra').checked,
      qualityPenalty: inputOf(form, 'qualityPenalty').checked,
      currency: currencySelectOf(form).value,
    };
  }

  /**
   * Shows each weight's share of the total, the currently used currency of
   * the automatic choice and the symbol of the selected currency.
   * @param {!HTMLFormElement} form
   */
  function updateForm(form) {
    const values = WEIGHT_FIELDS.map(({key}) =>
      Math.max(0, Number(inputOf(form, `w.${key}`).value) || 0));
    const total = values.reduce((sum, value) => sum + value, 0);
    WEIGHT_FIELDS.forEach(({key}, index) => {
      ownElement(form, `[data-share="${key}"]`).textContent =
          total ? `${Math.round((values[index] / total) * 100)}%` : '–';
    });
    const autoCurrency = settings.currency === 'auto' ?
        currency :
        storedCurrency();
    ownElement(form, '[data-auto]').textContent =
        `Automatic (${autoCurrency})`;
    const selected = currencySelectOf(form).value;
    ownElement(form, '[data-ref-symbol]').textContent = currencySymbol(
        selected === 'auto' ? autoCurrency : selected);
  }

  /** Opens the settings dialog. */
  function openSettings() {
    let dialog = /** @type {?HTMLDialogElement} */ (
      document.getElementById(`${PREFIX}-settings`));
    if (!dialog) {
      dialog = buildSettingsDialog();
      document.body.appendChild(dialog);
    }
    const form = /** @type {!HTMLFormElement} */ (
      ownElement(dialog, 'form'));
    writeForm(form, settings);
    ownElement(form, `.${PREFIX}-status`).textContent = '';
    dialog.showModal();
  }

  // ===========================================================================
  // Startup
  // ===========================================================================

  /** Starts the script. */
  function init() {
    injectStyles();
    initTooltip();
    const pruned = cachePrune(false);
    if (pruned) log(`Removed ${pruned} expired or outdated cache entries`);
    GM_registerMenuCommand('Deal Score: Settings …', openSettings);
    // Changes saved in another tab.
    GM_addValueChangeListener(STORAGE_SETTINGS, (name, oldValue, newValue,
        remote) => {
      if (remote) applySettings(sanitizeSettings(newValue));
    });
    GM_addValueChangeListener(STORAGE_PANEL, (name, oldValue, newValue,
        remote) => {
      if (remote && topListEnabled) applyRemotePanelPrefs(newValue);
    });
    observe(document.body);
    schedule();
    if (DEBUG) {
      window.DealScore = {
        core: CORE,
        getSettings: () => settings,
        openSettings,
      };
    }
  }

  init();
})();
