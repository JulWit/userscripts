// ==UserScript==
// @name         Steam Wishlist – Deal Score
// @namespace    https://store.steampowered.com/wishlist/dealscore
// @version      1.10.1
// @description  Deal score (1–100) for the wishlist, cart and store pages
// @author       Julian
// @homepageURL  https://github.com/JulWit/userscripts
// @supportURL   https://github.com/JulWit/userscripts/issues
// @updateURL    https://raw.githubusercontent.com/JulWit/userscripts/main/scripts/steam-dealscore.user.js
// @downloadURL  https://raw.githubusercontent.com/JulWit/userscripts/main/scripts/steam-dealscore.user.js
// @match        https://store.steampowered.com/wishlist/*
// @match        https://store.steampowered.com/cart*
// @match        https://store.steampowered.com/app/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      store.steampowered.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

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
   *     free: boolean}}
   */
  let Price;

  /**
   * Totals from /appreviewhistogram: last 30 days and all time.
   * @typedef {{up30: number, down30: number, upTotal: number,
   *     downTotal: number}}
   */
  let Histogram;

  /**
   * @typedef {{overall: number, recent: number, discount: number,
   *     price: number, popularity: number}}
   */
  let Weights;

  /**
   * @typedef {{weights: !Weights, referencePrice: number,
   *     fetchExtra: boolean, qualityPenalty: boolean}}
   */
  let Settings;

  /**
   * State of the extra data for one or more games.
   * state: 'ok' | 'pending' | 'failed' | 'disabled' | 'unused'
   * @typedef {{state: string, hist: ?Histogram, t: (number|string),
   *     missing: (number|undefined)}}
   */
  let Extra;

  /**
   * In-memory cache entry. status: 'ok' | 'pending' | 'failed'
   * @typedef {{status: string, t: (number|undefined),
   *     hist: (?Histogram|undefined)}}
   */
  let HistEntry;

  /**
   * Entry read by a page adapter. anchorEl is the node the badge is inserted
   * before (the game title).
   * @typedef {{
   *   key: string,
   *   kind: string,
   *   id: string,
   *   appids: !Array<string>,
   *   title: string,
   *   anchorEl: !Node,
   *   price: ?Price,
   *   bundleSize: (number|undefined),
   *   notes: (!Array<string>|undefined)
   * }}
   */
  let ItemData;

  /**
   * Result of the score calculation. status: 'ok' | 'noPrice' | 'noWeights'
   * @typedef {{
   *   status: string,
   *   score: (number|undefined),
   *   penalty: (number|undefined),
   *   parts: (!Object<string, !Object>|undefined),
   *   hasReviews: (boolean|undefined)
   * }}
   */
  let ScoreResult;

  /**
   * Purchase option on the store page.
   * @typedef {{block: !Element, heading: !Element, price: !Price}}
   */
  let Offer;

  // ===========================================================================
  // Configuration – all defaults in one place
  // ===========================================================================

  /**
   * Freezes an object including nested objects and arrays.
   * @param {T} value
   * @return {T}
   * @template T
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
    // At this final price (€) the price component is 0.5.
    referencePrice: 20,
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
    histogramQuery: '?l=english&review_score_preference=0',
    // Hover delay of the score tooltip (the native title tooltip waits
    // ~500 ms and does not work on touch devices).
    tooltipDelayMs: 100,
  });

  // Locale-dependent patterns and formats – collected in one place. The
  // patterns match Steam's page text, which depends on the store language.
  const TEXT = deepFreeze({
    locale: 'en-US',
    currencyCode: 'EUR',
    currency: /[€$£¥₩₽₹]|\b(?:EUR|USD|GBP|CHF|PLN|zł|kr)\b/,
    discountText: /^[-−–]\s*(\d{1,3})\s*%$/,
    free: /^(?:free(?: to play)?|gratis|kostenlos(?: spielbar| spielen)?)$/i,
  });

  const PREFIX = 'sws';
  const STORAGE_SETTINGS = 'settings';
  const STORAGE_CACHE_PREFIX = 'hist:';
  const OWN_SELECTOR =
      `.${PREFIX}-badge, .${PREFIX}-dialog, .${PREFIX}-tooltip`;

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
   * Localized label such as "20% off. Regular price €31.99, now €25.59."
   * @param {?string} label
   * @return {?Price}
   */
  function parsePriceLabel(label) {
    if (!label || !TEXT.currency.test(label)) return null;
    const discountMatch = label.match(/(\d{1,3})\s*%/);
    if (!discountMatch) return null;
    const rest = label.slice(0, discountMatch.index) + ' ' +
        label.slice(discountMatch.index + discountMatch[0].length);
    const amounts =
        findNumbers(rest).map(parseMoney).filter((value) => value != null);
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
   * @return {?Price}
   */
  function parsePriceTexts(texts) {
    let discount = null;
    let free = false;
    const amounts = [];
    for (const raw of texts) {
      const text = String(raw).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const discountMatch = text.match(TEXT.discountText);
      if (discountMatch) {
        discount = Number(discountMatch[1]);
      } else if (TEXT.free.test(text)) {
        free = true;
      } else if (text.length <= 24 && /\d/.test(text) &&
          TEXT.currency.test(text)) {
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
    const weights = settings.weights;
    const histTotal = hist ? hist.upTotal + hist.downTotal : 0;
    const hasReviews = histTotal > 0;

    const parts = {};
    if (hasReviews) {
      const pAll = hist.upTotal / histTotal;
      const ratingG = shrinkRating(pAll, histTotal);
      parts.overall = {
        available: true,
        value: easeOut((ratingG - 0.5) / 0.5, CONFIG.reviewCurve),
        weight: weights.overall,
        pct: pAll,
        n: histTotal,
      };
      const n30 = hist.up30 + hist.down30;
      const p30 = (hist.up30 + CONFIG.recentPrior * ratingG) /
          (n30 + CONFIG.recentPrior);
      parts.recent = {
        available: true,
        value: easeOut((p30 - 0.5) / 0.5, CONFIG.reviewCurve),
        weight: weights.recent,
        pct: n30 ? hist.up30 / n30 : null,
        n: n30,
      };
    } else {
      parts.overall = {available: false, weight: weights.overall};
      parts.recent = {available: false, weight: weights.recent};
    }

    parts.discount = {
      available: true,
      value: easeOut(row.price.discount / 100, CONFIG.discountCurve),
      weight: weights.discount,
      pct: row.price.discount,
    };
    parts.price = {
      available: true,
      value: priceValue(
          row.price.final, settings.referencePrice, CONFIG.priceExponent),
      weight: weights.price,
      amount: row.price.final,
      free: row.price.free,
    };
    if (hist) {
      parts.popularity = {
        available: true,
        value: clamp01(Math.log10(histTotal + 1) / CONFIG.popularityLogScale),
        weight: weights.popularity,
        n: histTotal,
      };
    } else {
      parts.popularity = {available: false, weight: weights.popularity};
    }

    let weightSum = 0;
    let weightedSum = 0;
    for (const part of Object.values(parts)) {
      if (part.available && part.weight > 0) {
        weightSum += part.weight;
        weightedSum += part.weight * part.value;
      }
    }
    if (weightSum <= 0) return {status: 'noWeights', parts};

    let total = weightedSum / weightSum;
    let penalty = 1;
    const reviewWeight = weights.overall + weights.recent;
    if (settings.qualityPenalty && hasReviews && reviewWeight > 0) {
      const quality = (weights.overall * parts.overall.value +
          weights.recent * parts.recent.value) / reviewWeight;
      penalty = Math.min(1, 0.5 + quality);
      total *= penalty;
    }
    const score = Math.min(100, Math.max(1, Math.round(1 + 99 * total)));
    return {status: 'ok', score, penalty, parts, hasReviews};
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
  const MONEY_FORMAT = new Intl.NumberFormat(
      TEXT.locale, {style: 'currency', currency: TEXT.currencyCode});
  /** @type {!Map<number, !Intl.NumberFormat>} Keyed by decimal places. */
  const decimalFormats = new Map();

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
   * @return {string} e.g. "€7.49".
   */
  function formatMoney(value) {
    return MONEY_FORMAT.format(value);
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
   * Builds the multi-line tooltip with the breakdown.
   * @param {!ScoreResult} result
   * @param {string} extraState 'ok' | 'pending' | 'failed' | 'disabled' |
   *     'unused'
   * @param {{bundleSize: (number|undefined), bundleMissing: (number|undefined),
   *     notes: (!Array<string>|undefined)}=} meta Bundle details and
   *     additional lines.
   * @return {string}
   */
  function buildTooltip(result, extraState, meta = {}) {
    if (result.status === 'noPrice') {
      return 'Deal score: –\n' +
          'No price available (unreleased or not purchasable).';
    }
    if (extraState === 'pending') {
      return 'Deal score: loading extra data …';
    }
    if (result.status === 'noWeights') {
      return 'Deal score: –\nAll weights of the available components are 0.';
    }
    const parts = result.parts;
    const points = (part) => Math.round(part.value * 100);
    const weight = (part) => ` · weight ${formatInteger(part.weight)}`;
    const rated = (part) => `→ ${points(part)}${weight(part)}`;
    const lines = [`Deal score ${result.score}/100`];

    const overall = parts.overall;
    if (overall.available) {
      lines.push(`Overall rating: ${formatPercent(overall.pct)} ` +
          `(${formatInteger(overall.n)}, all languages) ${rated(overall)}`);
    } else {
      lines.push('Overall rating: no data (not counted)');
    }

    const recent = parts.recent;
    if (!recent.available) {
      lines.push('Last 30 days: no data (not counted)');
    } else if (!recent.n) {
      lines.push(`Last 30 days: no new reviews ${rated(recent)}`);
    } else {
      lines.push(`Last 30 days: ${formatPercent(recent.pct)} ` +
          `(${formatInteger(recent.n)}) ${rated(recent)}`);
    }

    const discount = parts.discount;
    lines.push(discount.pct > 0 ?
        `Discount: −${discount.pct}% ${rated(discount)}` :
        `Discount: none → 0${weight(discount)}`);

    const price = parts.price;
    const priceText = price.free ? 'free' : formatMoney(price.amount);
    lines.push(`Price: ${priceText} ${rated(price)}`);

    const popularity = parts.popularity;
    lines.push(popularity.available ?
        `Popularity: ${formatInteger(popularity.n)} reviews ` +
            rated(popularity) :
        'Popularity: no data (not counted)');

    if (result.penalty < 1) {
      lines.push(`Quality penalty: × ${formatDecimal(result.penalty, 2)}`);
    }
    lines.push(...(meta.notes || []));
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
    return lines.join('\n');
  }

  // ===========================================================================
  // Script manager, settings & cache (GM storage)
  // ===========================================================================

  // Script managers provide GM_* as local identifiers, not necessarily as
  // window properties.
  /* global GM_getValue, GM_setValue, GM_deleteValue, GM_listValues,
     GM_registerMenuCommand, GM_xmlhttpRequest */
  const GM_API = Object.freeze({
    getValue: typeof GM_getValue === 'function' ? GM_getValue : null,
    setValue: typeof GM_setValue === 'function' ? GM_setValue : null,
    deleteValue: typeof GM_deleteValue === 'function' ? GM_deleteValue : null,
    listValues: typeof GM_listValues === 'function' ? GM_listValues : null,
    registerMenuCommand: typeof GM_registerMenuCommand === 'function' ?
        GM_registerMenuCommand :
        null,
    xmlhttpRequest:
        typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : null,
  });

  /**
   * @param {string} key
   * @param {*} fallback
   * @return {*}
   */
  function gmGet(key, fallback) {
    try {
      return GM_API.getValue ? GM_API.getValue(key, fallback) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  /**
   * @param {string} key
   * @param {*} value
   */
  function gmSet(key, value) {
    try {
      if (GM_API.setValue) GM_API.setValue(key, value);
    } catch (e) {
      log('GM_setValue failed', e);
    }
  }

  const DEBUG = CONFIG.debug || gmGet('debug', false) === true;

  /**
   * Debug output, only when DEBUG is set.
   * @param {...*} args
   */
  function log(...args) {
    if (DEBUG) console.log('[Deal Score]', ...args);
  }

  /** @return {!Settings} */
  function defaultSettings() {
    return {
      weights: {...CONFIG.weights},
      referencePrice: CONFIG.referencePrice,
      fetchExtra: CONFIG.fetchExtra,
      qualityPenalty: CONFIG.qualityPenalty,
    };
  }

  /**
   * Validates stored or entered values; invalid ones are replaced.
   * @param {?Object} raw
   * @return {!Settings}
   */
  function sanitizeSettings(raw) {
    const input = raw || {};
    const defaults = defaultSettings();
    const toNumber = (value, fallback, min) =>
        value !== '' && value !== null && Number.isFinite(Number(value)) ?
        Math.max(min, Number(value)) :
        fallback;
    const weights = {};
    for (const key of Object.keys(defaults.weights)) {
      weights[key] = toNumber(input.weights?.[key], defaults.weights[key], 0);
    }
    return {
      weights,
      referencePrice:
          toNumber(input.referencePrice, defaults.referencePrice, 0.01),
      fetchExtra: typeof input.fetchExtra === 'boolean' ?
          input.fetchExtra :
          defaults.fetchExtra,
      qualityPenalty: typeof input.qualityPenalty === 'boolean' ?
          input.qualityPenalty :
          defaults.qualityPenalty,
    };
  }

  /** @type {!Settings} */
  let settings = sanitizeSettings(gmGet(STORAGE_SETTINGS, null));
  let settingsVersion = 0;

  /**
   * @param {string} appid
   * @return {?Histogram} Cached totals, if still valid.
   */
  function cacheRead(appid) {
    const entry = gmGet(STORAGE_CACHE_PREFIX + appid, null);
    const fresh = entry && typeof entry.t === 'number' &&
        Date.now() - entry.t < CONFIG.cacheTtlMs;
    return fresh ? entry : null;
  }

  /**
   * @param {string} appid
   * @param {!Histogram} hist
   */
  function cacheWrite(appid, hist) {
    gmSet(STORAGE_CACHE_PREFIX + appid, {...hist, t: Date.now()});
  }

  /**
   * Deletes expired or all cache entries.
   * @param {boolean} all true: delete all entries.
   * @return {number} Number of deleted entries.
   */
  function cachePrune(all) {
    if (!GM_API.listValues || !GM_API.deleteValue) return 0;
    let removed = 0;
    try {
      for (const key of GM_API.listValues()) {
        if (!key.startsWith(STORAGE_CACHE_PREFIX)) continue;
        const entry = gmGet(key, null);
        const expired = !entry || typeof entry.t !== 'number' ||
            Date.now() - entry.t >= CONFIG.cacheTtlMs;
        if (all || expired) {
          GM_API.deleteValue(key);
          removed++;
        }
      }
    } catch (e) {
      log('Cache pruning failed', e);
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
   * GET via the script manager (fallback in case fetch fails in the sandbox).
   * @param {string} url
   * @return {!Promise<{status: number, text: function(): string}>}
   */
  function gmRequest(url) {
    return new Promise((resolve, reject) => {
      GM_API.xmlhttpRequest({
        method: 'GET',
        url,
        headers: {Accept: 'application/json'},
        onload: (response) => resolve({
          status: response.status,
          text: () => response.responseText,
        }),
        onerror: () => reject(new Error('GM_xmlhttpRequest failed')),
        ontimeout: () => reject(new Error('GM_xmlhttpRequest timeout')),
        timeout: 20000,
      });
    });
  }

  /**
   * @param {string} url
   * @return {!Promise<{status: number,
   *     text: function(): (string|!Promise<string>)}>}
   */
  async function httpGet(url) {
    try {
      const response = await fetch(url, {
        credentials: 'same-origin',
        headers: {Accept: 'application/json'},
      });
      return {status: response.status, text: () => response.text()};
    } catch (e) {
      // Network/sandbox error from fetch → fall back to the script manager.
      if (GM_API.xmlhttpRequest) return gmRequest(url);
      throw e;
    }
  }

  /**
   * Loads the review histogram, with backoff on 429 and 5xx.
   * @param {string} appid
   * @return {!Promise<!Histogram>}
   */
  async function fetchHistogram(appid) {
    const path = `/appreviewhistogram/${appid}${CONFIG.histogramQuery}`;
    const url = new URL(path, location.href).href;
    for (let attempt = 0;; attempt++) {
      const response = await httpGet(url);
      const status = response.status;
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
      return summarizeHistogram(JSON.parse(await response.text()));
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
      const appid = queue.shift();
      // Only request games that are (still) rendered.
      if (!isRendered(appid)) {
        dropFromQueue(appid);
        continue;
      }
      activeRequests++;
      fetchHistogram(appid)
          .then((hist) => {
            cacheWrite(appid, hist);
            histMem.set(appid, {status: 'ok', t: Date.now(), hist});
            log('Histogram', appid, hist);
          })
          .catch((e) => {
            histMem.set(appid, {status: 'failed', t: Date.now()});
            log('Histogram failed', appid, e);
          })
          .finally(() => {
            activeRequests--;
            queued.delete(appid);
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
      entry = null;
    }
    if (entry?.status === 'failed' &&
        now - entry.t >= CONFIG.failedRetryAfterMs) {
      entry = null;
    }
    if (!entry) {
      const cached = cacheRead(appid);
      if (cached) {
        entry = {status: 'ok', t: cached.t, hist: cached};
        histMem.set(appid, entry);
      } else {
        entry = {status: 'pending'};
        histMem.set(appid, entry);
        enqueue(appid);
      }
    }
    return {
      state: entry.status,
      hist: entry.status === 'ok' ? entry.hist : null,
      t: entry.t || 0,
    };
  }

  /**
   * Like getExtra, for multiple app IDs (bundles): histograms are combined.
   * @param {!Array<string>} appids
   * @return {!Extra}
   */
  function getExtraFor(appids) {
    if (!settings.fetchExtra) return {state: 'disabled', hist: null, t: 0};
    if (!appids.length) return {state: 'failed', hist: null, t: 0};
    const parts = appids.map(getExtra);
    if (parts.length === 1) return parts[0];
    if (parts.some((part) => part.state === 'pending')) {
      return {state: 'pending', hist: null, t: 0};
    }
    const loaded = parts.filter((part) => part.state === 'ok');
    if (!loaded.length) return {state: 'failed', hist: null, t: 0};
    return {
      state: 'ok',
      hist: combineHistograms(loaded.map((part) => part.hist)),
      t: loaded.map((part) => part.t).join(','),
      missing: parts.length - loaded.length,
    };
  }

  // ===========================================================================
  // DOM helpers
  // ===========================================================================

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
      texts.push(element.textContent);
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
      const price = parsePriceLabel(element.getAttribute('aria-label'));
      if (price) return price;
    }
    const linkTexts = priceLinks.flatMap((link) => leafTexts(link));
    return parsePriceTexts(linkTexts) ||
        parsePriceTexts(leafTexts(item, exclude));
  }

  /**
   * @param {!Array<!Element>} nodes
   * @return {!Element} Lowest common ancestor.
   */
  function commonAncestor(nodes) {
    let ancestor = nodes[0].parentElement;
    while (ancestor && !nodes.every((node) => ancestor.contains(node))) {
      ancestor = ancestor.parentElement;
    }
    return ancestor || document.body;
  }

  // ===========================================================================
  // Page adapters: findItems, listRootOf, readItem
  // ===========================================================================

  /**
   * Common interface of the page adapters.
   * @interface
   */
  class PageAdapter {
    constructor() {
      /**
       * Whether an entry's data comes only from its own subtree. Then a change
       * inside one entry only requires re-reading that entry.
       * @const {boolean}
       */
      this.independentItems;
    }

    /**
     * @param {!Element|!Document} root
     * @return {!Array<!Element>} All entries below root.
     */
    findItems(root) {}

    /**
     * @param {!Array<!Element>} items
     * @return {!Element} Element that contains all entries.
     */
    listRootOf(items) {}

    /**
     * @param {!Element} item
     * @return {?ItemData}
     */
    readItem(item) {}
  }

  /**
   * Wishlist: virtualized React list, one div[data-index] per row.
   * @implements {PageAdapter}
   */
  class WishlistPage {
    constructor() {
      /** @const {boolean} */
      this.independentItems = true;
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
     * @param {!Array<!Element>} items
     * @return {!Element}
     */
    listRootOf(items) {
      return items[0].parentElement?.parentElement || items[0].parentElement;
    }

    /**
     * @param {!Element} row
     * @return {?ItemData}
     */
    readItem(row) {
      const links = [...row.querySelectorAll('a[href*="/app/"]')].filter(
          (link) => !isOwn(link));
      const titleAnchor = links.find(
          (link) => !link.querySelector('img, [aria-label]') &&
              link.textContent.trim() && !TEXT.currency.test(link.textContent));
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
        title: titleAnchor.textContent.trim(),
        anchorEl: titleAnchor,
        price: readPrice(
            row, links.filter((link) => link !== titleAnchor), titleAnchor),
      };
    }
  }

  /** Head link of a cart item: app, bundle or package. */
  const CART_HEAD_SELECTOR =
      'a[href*="/app/"], a[href*="/bundle/"], a[href*="/sub/"]';

  /**
   * Cart: head link with an image, title as a separate element.
   * @implements {PageAdapter}
   */
  class CartPage {
    constructor() {
      /** @const {boolean} */
      this.independentItems = true;
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
      for (let depth = 0; depth < 8 && element.parentElement &&
          this.heads(element.parentElement).length === 1;
          depth++) {
        element = element.parentElement;
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
              !isOwn(element) && element.textContent.trim() === name) {
            return element;
          }
        }
      }
      // Fallback: add/remove buttons reference the title via
      // aria-labelledby.
      for (const button of item.querySelectorAll('[aria-labelledby]')) {
        const ids = button.getAttribute('aria-labelledby').trim().split(/\s+/);
        const element = document.getElementById(ids[ids.length - 1]);
        if (element && element !== button && item.contains(element) &&
            element.textContent.trim()) {
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
        appids = [...new Set(links.map(appIdOf).filter(Boolean))];
      }
      return {
        key: `${kind}/${id}`,
        kind,
        id,
        appids,
        title: titleEl.textContent.trim(),
        anchorEl: titleEl,
        price: readPrice(item, [], titleEl),
        bundleSize: kind === 'app' ? 0 : appids.length,
      };
    }
  }

  /** Desktop title and responsive title (#appHubAppName_responsive). */
  const STORE_TITLE_SELECTOR = '.apphub_AppName';

  /**
   * Store page of a game: classic server-rendered HTML with stable classes and
   * data attributes.
   * @implements {PageAdapter}
   */
  class StorePage {
    constructor() {
      // The title badge uses the price of the first purchase box.
      /** @const {boolean} */
      this.independentItems = false;
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
      const offers = [];
      for (const block of scope.querySelectorAll('.game_area_purchase_game')) {
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
      const element = id && document.getElementById(id);
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
      const offers = this.offers(root);
      // Separate badges in the purchase boxes only with multiple editions.
      if (offers.length > 1) items.push(...offers.map((offer) => offer.block));
      return items;
    }

    /**
     * @param {!Array<!Element>} items
     * @return {!Element}
     */
    listRootOf(items) {
      const blocks = document.querySelectorAll('.game_area_purchase_game');
      return commonAncestor([...items, ...blocks]);
    }

    /**
     * @param {!Element} item
     * @return {?ItemData}
     */
    readItem(item) {
      const appid = this.appid();
      if (!appid) return null;
      const offers = this.offers(document);

      if (item.matches(STORE_TITLE_SELECTOR)) {
        const anchorEl = this.firstChild(item);
        if (!anchorEl) return null;
        const main = offers[0];
        return {
          key: `app/${appid}`,
          kind: 'app',
          id: appid,
          appids: [appid],
          title: this.ownText(item),
          anchorEl,
          price: main ? main.price : null,
          bundleSize: 0,
          notes: offers.length > 1 ?
              [`Offer: ${this.ownText(main.heading)}`] :
              [],
        };
      }

      const offer = offers.find((candidate) => candidate.block === item);
      const anchorEl = offer && this.firstChild(offer.heading);
      if (!anchorEl) return null;
      const subid = item.querySelector('input[name="subid"]')?.value ||
          String(offers.indexOf(offer));
      return {
        key: `sub/${subid}`,
        kind: 'sub',
        id: appid,
        appids: [appid],
        title: this.ownText(offer.heading),
        anchorEl,
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
  // Badges (React nodes are never modified, only our own elements inserted)
  // ===========================================================================

  /** @return {!Element} */
  function createBadge() {
    const badge = document.createElement('span');
    badge.className = `${PREFIX}-badge`;
    badge.setAttribute('role', 'img');
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
    tooltipTexts.set(badge, () => buildTooltip(result, extra.state, {
      bundleSize: data.bundleSize,
      bundleMissing: extra.missing || 0,
      notes: data.notes,
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
      data = page.readItem(item);
      if (!data) {
        itemCache.delete(item);
        return;
      }
      itemCache.set(item, data);
    }
    const anchor = data.anchorEl;

    const badges = item.querySelectorAll(`.${PREFIX}-badge`);
    // Remove duplicate badges (our own elements only).
    for (let i = 1; i < badges.length; i++) {
      badges[i].remove();
    }
    const badge = /** @type {!HTMLElement} */ (badges[0] || createBadge());
    if (badge.nextSibling !== anchor) {
      anchor.parentNode.insertBefore(badge, anchor);
    }
    if (badge.dataset.key !== data.key) {
      badge.dataset.key = data.key;
      delete badge.dataset.sig;
    }
    setData(badge, 'appid', data.kind === 'app' ? data.id : null);
    // Set before getExtraFor: the queue checks for it.
    setData(badge, 'appids', data.appids.join(' '));

    // Without a price there is no score, so the histogram is not requested.
    const extra = data.price ?
        getExtraFor(data.appids) :
        {state: 'unused', hist: null, t: 0};
    const sig = [
      data.key,
      data.appids.join(','),
      JSON.stringify(data.price),
      extra.state,
      extra.t,
      settingsVersion,
    ].join('|');
    if (badge.dataset.sig === sig) return;

    const result = renderBadge(badge, data, extra);
    badge.dataset.sig = sig;
    if (report) {
      const hist = extra.hist;
      const reviews = hist ? hist.upTotal + hist.downTotal : null;
      report.push({
        item: data.key,
        title: data.title,
        reviews,
        positive: reviews ? hist.upTotal / reviews : null,
        recent30: hist ? hist.up30 + hist.down30 : null,
        discount: data.price?.discount ?? null,
        original: data.price?.original ?? null,
        final: data.price?.final ?? null,
        extra: extra.state,
        score: result.score ?? null,
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
  /** @type {?Node} */
  let observed = null;
  let frameRequested = false;
  /** @type {!WeakMap<!Element, !ItemData>} Parsed data per entry. */
  let itemCache = new WeakMap();
  /** @type {!Set<!Element>} Entries found by the last full scan. */
  let knownItems = new Set();
  /** @type {!Set<!Element>} Entries changed since the last tick. */
  const dirtyItems = new Set();
  /** Whether entries may have been added or removed since the last tick. */
  let fullScanNeeded = true;

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

  /** @param {!Node} target */
  function observe(target) {
    if (observed === target) return;
    observer.disconnect();
    observer.observe(target, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['href', 'title', 'aria-label'],
    });
    observed = target;
    log('Observing', target === document.body ? 'body' : 'list');
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
   * Finds the list, observes it and updates all entries. Only new or changed
   * entries are read again; the others just re-check their extra data.
   */
  function tick() {
    if (!listRoot || !listRoot.isConnected) {
      const items = page.findItems(document);
      listRoot = items.length ? page.listRootOf(items) : null;
      fullScanNeeded = true;
    }
    observe(listRoot || document.body);
    if (listRoot) {
      if (fullScanNeeded) {
        if (!page.independentItems) itemCache = new WeakMap();
        knownItems = new Set(page.findItems(listRoot));
        fullScanNeeded = false;
      }
      for (const item of dirtyItems) itemCache.delete(item);
      dirtyItems.clear();
      processItems(knownItems);
    }
    if (tooltipBadge && !tooltipBadge.isConnected) hideTooltip();
  }

  // ===========================================================================
  // Tooltip (one shared element instead of native title tooltips)
  // ===========================================================================

  /** @type {!WeakMap<!Element, function(): string>} Text builder per badge. */
  const tooltipTexts = new WeakMap();
  /** @type {?HTMLElement} */
  let tooltipEl = null;
  /** @type {?Element} Badge the tooltip is shown or about to be shown for. */
  let tooltipBadge = null;
  /** @type {?number} */
  let tooltipTimer = null;
  let lastPointerType = 'mouse';

  /**
   * @param {?EventTarget} target
   * @return {?Element} Badge that contains the event target.
   */
  function badgeOf(target) {
    const node = /** @type {?Node} */ (target);
    return node && node.nodeType === Node.ELEMENT_NODE ?
        /** @type {!Element} */ (node).closest(`.${PREFIX}-badge`) :
        null;
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

  /**
   * @param {!Element} badge
   * @param {boolean} immediate Skip the hover delay.
   */
  function showTooltip(badge, immediate) {
    clearTimeout(tooltipTimer);
    tooltipTimer = null;
    if (tooltipBadge && tooltipBadge !== badge) {
      tooltipBadge.removeAttribute('aria-describedby');
    }
    tooltipBadge = badge;
    if (immediate) {
      renderTooltip();
    } else {
      tooltipTimer = setTimeout(renderTooltip, CONFIG.tooltipDelayMs);
    }
  }

  /** Fills and positions the tooltip for the current badge. */
  function renderTooltip() {
    tooltipTimer = null;
    const badge = tooltipBadge;
    const buildText = badge && badge.isConnected && tooltipTexts.get(badge);
    if (!buildText) {
      hideTooltip();
      return;
    }
    const tooltip = tooltipElement();
    tooltip.textContent = buildText();
    tooltip.hidden = false;
    badge.setAttribute('aria-describedby', tooltip.id);
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
    if (!tooltipBadge && !tooltipTimer) return;
    clearTimeout(tooltipTimer);
    tooltipTimer = null;
    tooltipBadge?.removeAttribute('aria-describedby');
    tooltipBadge = null;
    if (tooltipEl) tooltipEl.hidden = true;
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
        showTooltip(badge, isTooltipVisible());
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
        showTooltip(badge, true);
      }
    }, true);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') hideTooltip();
    }, passive);
    window.addEventListener('scroll', hideTooltip, {capture: true, ...passive});
    window.addEventListener('resize', hideTooltip, passive);
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
        white-space: pre-line;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
        pointer-events: none;
      }
      .${PREFIX}-tooltip::first-line { font-weight: 700; color: #fff; }
      .${PREFIX}-tooltip[hidden] { display: none; }

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
      .${PREFIX}-dialog input[type="number"] {
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

  /** Weights in the dialog: [key, label]. */
  const WEIGHT_FIELDS = deepFreeze([
    ['overall', 'Overall rating'],
    ['recent', 'Last 30 days'],
    ['discount', 'Discount'],
    ['price', 'Price'],
    ['popularity', 'Popularity'],
  ]);

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
   * @param {string} id
   * @param {string} label
   * @param {string} hint
   * @param {!Element} input
   * @return {!HTMLElement} Row with an input field.
   */
  function buildNumberRow(id, label, hint, input) {
    return buildElement('div', {class: `${PREFIX}-row`}, [
      buildElement('label', {for: id}, [
        label,
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
    for (const [key, label] of WEIGHT_FIELDS) {
      const id = `${PREFIX}-w-${key}`;
      weights.append(buildElement('div', {class: `${PREFIX}-row`}, [
        buildElement('label', {for: id, text: label}),
        buildElement('input', {
          id,
          name: `w.${key}`,
          type: 'number',
          min: '0',
          max: '1000',
          step: '1',
          required: '',
        }),
        buildElement('span', {'class': `${PREFIX}-share`, 'data-share': key}),
      ]));
    }

    const other = buildElement('fieldset', {}, [
      buildElement('legend', {text: 'Other settings'}),
      buildNumberRow(
          `${PREFIX}-ref`, 'Reference price (€)',
          'At this final price the price component is 50.',
          buildElement('input', {
            id: `${PREFIX}-ref`,
            name: 'referencePrice',
            type: 'number',
            min: '0.5',
            step: '0.5',
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

    form.addEventListener('input', () => updateShares(form));
    cancelButton.addEventListener('click', () => dialog.close());
    defaultsButton.addEventListener('click', () => {
      writeForm(form, defaultSettings());
      status.textContent = 'Defaults filled in – click "Save" to apply.';
    });
    cacheButton.addEventListener('click', () => {
      const removed = cachePrune(true);
      histMem.clear();
      settingsVersion++;
      schedule();
      status.textContent = `Cache cleared (${removed} entries).`;
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      settings = sanitizeSettings(readForm(form));
      gmSet(STORAGE_SETTINGS, settings);
      settingsVersion++;
      pump();
      schedule();
      dialog.close();
    });
    return dialog;
  }

  /**
   * @param {!HTMLFormElement} form
   * @param {!Settings} values
   */
  function writeForm(form, values) {
    for (const [key] of WEIGHT_FIELDS) {
      form.elements[`w.${key}`].value = values.weights[key];
    }
    form.elements['referencePrice'].value = values.referencePrice;
    form.elements['fetchExtra'].checked = values.fetchExtra;
    form.elements['qualityPenalty'].checked = values.qualityPenalty;
    updateShares(form);
  }

  /**
   * @param {!HTMLFormElement} form
   * @return {!Object} Raw values, not yet validated.
   */
  function readForm(form) {
    const weights = {};
    for (const [key] of WEIGHT_FIELDS) {
      weights[key] = form.elements[`w.${key}`].value;
    }
    return {
      weights,
      referencePrice: form.elements['referencePrice'].value,
      fetchExtra: form.elements['fetchExtra'].checked,
      qualityPenalty: form.elements['qualityPenalty'].checked,
    };
  }

  /**
   * Shows each weight's share of the total.
   * @param {!HTMLFormElement} form
   */
  function updateShares(form) {
    const values = WEIGHT_FIELDS.map(
        ([key]) => Math.max(0, Number(form.elements[`w.${key}`].value) || 0));
    const total = values.reduce((sum, value) => sum + value, 0);
    WEIGHT_FIELDS.forEach(([key], index) => {
      const share = form.querySelector(`[data-share="${key}"]`);
      share.textContent =
          total ? `${Math.round((values[index] / total) * 100)}%` : '–';
    });
  }

  /** Opens the settings dialog. */
  function openSettings() {
    let dialog = /** @type {?HTMLDialogElement} */ (
        document.getElementById(`${PREFIX}-settings`));
    if (!dialog) {
      dialog = buildSettingsDialog();
      document.body.appendChild(dialog);
    }
    const form = /** @type {!HTMLFormElement} */ (dialog.querySelector('form'));
    writeForm(form, settings);
    form.querySelector(`.${PREFIX}-status`).textContent = '';
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
    if (pruned) log(`Removed ${pruned} expired cache entries`);
    if (GM_API.registerMenuCommand) {
      GM_API.registerMenuCommand('Deal Score: Settings …', openSettings);
    }
    observe(document.body);
    schedule();
    // If the list is replaced entirely (e.g. when changing filters), the list
    // observer does not notice.
    setInterval(() => {
      if (listRoot && !listRoot.isConnected) schedule();
    }, 1000);
    if (DEBUG) {
      window.DealScore = {
        core: {
          parseMoney,
          parsePriceLabel,
          parsePriceTexts,
          summarizeHistogram,
          combineHistograms,
          shrinkRating,
          easeOut,
          priceValue,
          computeScore,
          scoreColor,
          buildTooltip,
        },
        config: CONFIG,
        getSettings: () => settings,
        openSettings,
      };
    }
  }

  init();
})();
