// ==UserScript==
// @name         Steam-Wunschliste – Deal-Score
// @namespace    https://store.steampowered.com/wishlist/dealscore
// @version      1.8.0
// @description  Deal-Score (1–100) für Wunschliste, Warenkorb und Store-Seite
// @author       Julian
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
 * @fileoverview Zeigt auf der Steam-Wunschliste, im Einkaufswagen und auf der
 * Store-Seite eines Spiels vor jedem Titel einen Deal-Score von 1 bis 100.
 * Der Score ergibt sich aus Rezensionen, Rabatt, Preis und Beliebtheit.
 * Code-Stil: Google JavaScript Style Guide.
 */

(function() {
  'use strict';

  // ===========================================================================
  // Typen
  // ===========================================================================

  /**
   * Rabatt in Prozent, Original- und Endpreis.
   * @typedef {{discount: number, original: number, final: number,
   *     free: boolean}}
   */
  let Price;

  /**
   * Summen aus /appreviewhistogram: letzte 30 Tage und gesamt.
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
   * Zustand der Zusatzdaten für ein oder mehrere Spiele.
   * state: 'ok' | 'pending' | 'failed' | 'disabled'
   * @typedef {{state: string, hist: ?Histogram, t: (number|string),
   *     missing: (number|undefined)}}
   */
  let Extra;

  /**
   * Eintrag im Arbeitsspeicher-Cache. status: 'ok' | 'pending' | 'failed'
   * @typedef {{status: string, t: (number|undefined),
   *     hist: (?Histogram|undefined)}}
   */
  let HistEntry;

  /**
   * Von einem Seiten-Adapter gelesener Eintrag. anchorEl ist der Knoten, vor
   * dem das Badge eingefügt wird (Spieltitel).
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
   * Ergebnis der Score-Berechnung. status: 'ok' | 'noPrice' | 'noWeights'
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
   * Kaufoption auf der Store-Seite.
   * @typedef {{block: !Element, heading: !Element, price: !Price}}
   */
  let Offer;

  // ===========================================================================
  // Konfiguration – alle Standardwerte an einer Stelle
  // ===========================================================================

  /**
   * Friert ein Objekt samt verschachtelter Objekte und Arrays ein.
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
    // Alternativ den GM-Wert "debug" auf true setzen.
    debug: false,

    // Standardgewichte (im Einstellungsdialog änderbar).
    weights: {overall: 25, recent: 15, discount: 30, price: 20, popularity: 10},
    // Bei diesem Endpreis (€) ergibt die Preis-Komponente 0,5.
    referencePrice: 20,
    // Histogramm laden – einzige Quelle für alle Rezensionswerte.
    fetchExtra: true,
    // S · min(1, 0,5 + R)
    qualityPenalty: true,

    // K: zieht die 30-Tage-Quote bei wenigen Rezensionen zur Gesamtbewertung.
    recentPrior: 50,
    // B = log10(n + 1) / 5 → 100.000 Rezensionen = 1
    popularityLogScale: 5,

    // Skalen der Komponenten (k = 1 entspricht einer strengen, linearen Skala).
    // Rezensionen und Rabatt: 1 − (1 − x)^k. Rezensionen bleiben linear, damit
    // sich gute Spiele unterscheiden und der Qualitäts-Malus wirkt; beim
    // Rabatt ergeben 70 % mit k = 2 schon 0,91.
    reviewCurve: 1,
    discountCurve: 2,
    // Preis: 1 / (1 + (Endpreis / Referenzpreis)^k), mit k = 2 ergeben 5 €
    // schon 0,94 und 10 € 0,80; der Referenzpreis ergibt weiterhin 0,5.
    priceExponent: 2,

    // Farbverlauf des Badges (stufenlos zwischen den Stopps).
    colorStops: [
      {score: 30, color: '#d9443b'},  // rot
      {score: 55, color: '#e8a530'},  // gelb/orange
      {score: 80, color: '#4fae3f'},  // grün
    ],
    // Badge ohne Score („…“, „–“).
    neutralColor: '#3d4450',

    cacheTtlMs: 24 * 60 * 60 * 1000,
    failedRetryAfterMs: 5 * 60 * 1000,
    maxParallelRequests: 3,
    // Bei 429 / 5xx; Wartezeit 2 s, 4 s, 8 s, 16 s.
    maxRetries: 4,
    retryBaseDelayMs: 2000,
    histogramQuery: '?l=german&review_score_preference=0',
  });

  // Sprachabhängige Muster und Formate – gesammelt an einer Stelle.
  const TEXT = deepFreeze({
    locale: 'de-DE',
    currencyCode: 'EUR',
    currency: /[€$£¥₩₽₹]|\b(?:EUR|USD|GBP|CHF|PLN|zł|kr)\b/,
    discountText: /^[-−–]\s*(\d{1,3})\s*%$/,
    free: /^(?:kostenlos(?: spielbar| spielen)?|free(?: to play)?|gratis)$/i,
  });

  const PREFIX = 'sws';
  const STORAGE_SETTINGS = 'settings';
  const STORAGE_CACHE_PREFIX = 'hist:';
  const OWN_SELECTOR = `.${PREFIX}-badge, .${PREFIX}-dialog`;

  // ===========================================================================
  // Reine Funktionen: Parsing, Score, Farbe, Tooltip (ohne DOM und Netzwerk)
  // ===========================================================================

  /**
   * Zahlen mit Tausender-/Dezimaltrennern, auch mit geschützten Leerzeichen.
   * Kein Flag g: wird nur über matchAll bzw. match verwendet.
   */
  const NUMBER_PATTERN = /\d[\d.,\u00a0\u202f']*/;

  /**
   * @param {number} x
   * @return {number} x, begrenzt auf 0…1.
   */
  function clamp01(x) {
    return Math.min(1, Math.max(0, x));
  }

  /**
   * @param {string} text
   * @return {!Array<string>} Alle Zahlen im Text, in Reihenfolge.
   */
  function findNumbers(text) {
    const pattern = new RegExp(NUMBER_PATTERN.source, 'g');
    return [...text.matchAll(pattern)].map((match) => match[0]);
  }

  /**
   * „1.234,56€“, „25,59 €“, „€12.99“, „25,--€“ → Zahl.
   * @param {*} text
   * @return {?number}
   */
  function parseMoney(text) {
    const match = String(text ?? '').match(NUMBER_PATTERN);
    if (!match) return null;
    const digits =
        match[0].replace(/[\u00a0\u202f']/g, '').replace(/[.,]+$/, '');
    const sep = Math.max(digits.lastIndexOf(','), digits.lastIndexOf('.'));
    if (sep >= 0 && digits.length - sep - 1 === 2) {
      const whole = digits.slice(0, sep).replace(/[.,]/g, '');
      return parseFloat(`${whole}.${digits.slice(sep + 1)}`);
    }
    return parseFloat(digits.replace(/[.,]/g, ''));
  }

  /**
   * „20 % Rabatt. Regulärer Preis 31,99€ reduziert auf 25,59€.“
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
   * Sichtbare Texte des Preisbereichs: „-20%“, „31,99€“, „25,59€“ bzw.
   * „19,50€“ oder „Kostenlos“.
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
   * Fasst die Antwort von /appreviewhistogram zu Summen zusammen.
   * @param {*} json
   * @return {!Histogram}
   */
  function summarizeHistogram(json) {
    if (!json || json.success !== 1 || !json.results) {
      throw new Error('Histogramm: unerwartete Antwort');
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
   * Bundles: Rezensionen aller enthaltenen Spiele zusammenzählen, sodass
   * Spiele mit vielen Rezensionen stärker zählen.
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
   * SteamDB-Formel: Bei wenigen Rezensionen geht die Bewertung Richtung 50 %.
   * @param {number} pct Anteil positiv (0–1).
   * @param {number} count Anzahl der Rezensionen.
   * @return {number}
   */
  function shrinkRating(pct, count) {
    return pct - (pct - 0.5) * Math.pow(2, -Math.log10(count + 1));
  }

  /**
   * Gewölbte Skala 1 − (1 − x)^k: hohe Werte zählen fast voll, die Abstufung
   * bleibt erhalten. k = 1 ist linear.
   * @param {number} x Linearer Wert (0–1).
   * @param {number} k Wölbung (≥ 1).
   * @return {number}
   */
  function easeOut(x, k) {
    return 1 - Math.pow(1 - clamp01(x), Math.max(1, k));
  }

  /**
   * Preis-Skala: 1 / (1 + (Endpreis / Referenzpreis)^k). Der Referenzpreis
   * ergibt 0,5; kostenlos ergibt 1.
   * @param {number} price Endpreis.
   * @param {number} referencePrice
   * @param {number} k Steilheit (1 = bisherige, flache Kurve).
   * @return {number}
   */
  function priceValue(price, referencePrice, k) {
    const ratio = Math.max(0, price) / Math.max(referencePrice, 0.01);
    return 1 / (1 + Math.pow(ratio, Math.max(1, k)));
  }

  /**
   * Berechnet den Deal-Score eines Eintrags. Auf allen Seiten gilt dieselbe
   * Regel: Preis und Rabatt kommen von der Seite, alle Rezensionswerte
   * ausschließlich aus dem Histogramm (alle Sprachen).
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
   * @param {string} hex Farbe als „#rgb“ oder „#rrggbb“.
   * @return {!Array<number>} [r, g, b]
   */
  function hexToRgb(hex) {
    const digits = hex.replace('#', '');
    const value = parseInt(
        digits.length === 3 ? digits.replace(/./g, '$&$&') : digits, 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  }

  /**
   * Stufenloser Farbverlauf über die Farbstopps.
   * @param {number} score
   * @param {!Array<{score: number, color: string}>=} stops
   * @return {string} CSS-Farbe.
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

  /**
   * @param {number} value
   * @return {string} Ganzzahl mit Tausendertrennzeichen.
   */
  function formatInteger(value) {
    return Math.round(value).toLocaleString(TEXT.locale);
  }

  /**
   * @param {number} ratio Anteil (0–1).
   * @return {string} z. B. „93 %“.
   */
  function formatPercent(ratio) {
    return `${Math.round(ratio * 100)} %`;
  }

  /**
   * @param {number} value
   * @return {string} z. B. „7,49 €“.
   */
  function formatMoney(value) {
    return value.toLocaleString(
        TEXT.locale, {style: 'currency', currency: TEXT.currencyCode});
  }

  /**
   * @param {number} value
   * @param {number} digits Nachkommastellen.
   * @return {string}
   */
  function formatDecimal(value, digits) {
    return value.toLocaleString(TEXT.locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  /**
   * Baut den mehrzeiligen Tooltip mit der Aufschlüsselung.
   * @param {!ScoreResult} result
   * @param {string} extraState 'ok' | 'pending' | 'failed' | 'disabled'
   * @param {{bundleSize: (number|undefined), bundleMissing: (number|undefined),
   *     notes: (!Array<string>|undefined)}=} meta Bundle-Angaben und
   *     zusätzliche Zeilen.
   * @return {string}
   */
  function buildTooltip(result, extraState, meta = {}) {
    if (result.status === 'noPrice') {
      return 'Deal-Score: –\n' +
          'Kein Preis verfügbar (unveröffentlicht oder nicht kaufbar).';
    }
    if (extraState === 'pending') {
      return 'Deal-Score: Zusatzdaten werden geladen …';
    }
    if (result.status === 'noWeights') {
      return 'Deal-Score: –\nAlle Gewichte der verfügbaren Komponenten sind 0.';
    }
    const parts = result.parts;
    const points = (part) => Math.round(part.value * 100);
    const weight = (part) => ` · Gewicht ${formatInteger(part.weight)}`;
    const rated = (part) => `→ ${points(part)}${weight(part)}`;
    const lines = [`Deal-Score ${result.score}/100`];

    const overall = parts.overall;
    if (overall.available) {
      lines.push(`Gesamtbewertung: ${formatPercent(overall.pct)} ` +
          `(${formatInteger(overall.n)}, alle Sprachen) ${rated(overall)}`);
    } else {
      lines.push('Gesamtbewertung: keine Daten (nicht gewertet)');
    }

    const recent = parts.recent;
    if (!recent.available) {
      lines.push('Letzte 30 Tage: keine Daten (nicht gewertet)');
    } else if (!recent.n) {
      lines.push(`Letzte 30 Tage: keine neuen Rezensionen ${rated(recent)}`);
    } else {
      lines.push(`Letzte 30 Tage: ${formatPercent(recent.pct)} ` +
          `(${formatInteger(recent.n)}) ${rated(recent)}`);
    }

    const discount = parts.discount;
    lines.push(discount.pct > 0 ?
        `Rabatt: −${discount.pct} % ${rated(discount)}` :
        `Rabatt: keiner → 0${weight(discount)}`);

    const price = parts.price;
    const priceText = price.free ? 'kostenlos' : formatMoney(price.amount);
    lines.push(`Preis: ${priceText} ${rated(price)}`);

    const popularity = parts.popularity;
    lines.push(popularity.available ?
        `Beliebtheit: ${formatInteger(popularity.n)} Rezensionen ` +
            rated(popularity) :
        'Beliebtheit: keine Daten (nicht gewertet)');

    if (result.penalty < 1) {
      lines.push(`Qualitäts-Malus: × ${formatDecimal(result.penalty, 2)}`);
    }
    lines.push(...(meta.notes || []));
    if (meta.bundleSize) {
      const noun = meta.bundleSize === 1 ? 'Titel' : 'Titeln';
      lines.push(`Bundle: Rezensionen von ${meta.bundleSize} enthaltenen ` +
          `${noun} zusammengefasst.`);
      if (meta.bundleMissing) {
        lines.push(`Hinweis: Für ${meta.bundleMissing} enthaltene Titel ` +
            'fehlen Zusatzdaten.');
      }
    }
    if (extraState === 'failed') {
      lines.push('Hinweis: Rezensionsdaten nicht abrufbar – ' +
          'Score nur aus Rabatt und Preis.');
    } else if (extraState === 'disabled') {
      lines.push('Hinweis: Zusatzdaten deaktiviert – ' +
          'Score nur aus Rabatt und Preis.');
    } else if (!result.hasReviews) {
      lines.push(
          'Hinweis: Noch keine Rezensionen – Bewertung fließt nicht ein.');
    }
    return lines.join('\n');
  }

  // ===========================================================================
  // Skript-Manager, Einstellungen & Cache (GM-Storage)
  // ===========================================================================

  // Die Manager stellen GM_* als lokale Bezeichner bereit, nicht zwingend als
  // window-Eigenschaften.
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
      log('GM_setValue fehlgeschlagen', e);
    }
  }

  const DEBUG = CONFIG.debug || gmGet('debug', false) === true;

  /**
   * Debug-Ausgabe, nur wenn DEBUG gesetzt ist.
   * @param {...*} args
   */
  function log(...args) {
    if (DEBUG) console.log('[Deal-Score]', ...args);
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
   * Prüft gespeicherte bzw. eingegebene Werte; Ungültiges wird ersetzt.
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
   * @return {?Histogram} Gecachte Summen, wenn noch gültig.
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
   * Löscht abgelaufene bzw. alle Cache-Einträge.
   * @param {boolean} all true: alle Einträge löschen.
   * @return {number} Anzahl gelöschter Einträge.
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
      log('Cache aufräumen fehlgeschlagen', e);
    }
    return removed;
  }

  // ===========================================================================
  // Netzwerk: Warteschlange mit max. 3 parallelen Anfragen, Backoff bei 429/5xx
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
   * GET über den Skript-Manager (Fallback, falls fetch in der Sandbox
   * scheitert).
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
        onerror: () => reject(new Error('GM_xmlhttpRequest fehlgeschlagen')),
        ontimeout: () => reject(new Error('GM_xmlhttpRequest Timeout')),
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
      // Netzwerk-/Sandbox-Fehler von fetch → Fallback über den Skript-Manager.
      if (GM_API.xmlhttpRequest) return gmRequest(url);
      throw e;
    }
  }

  /**
   * Lädt das Rezensions-Histogramm, mit Backoff bei 429 und 5xx.
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
        log(`HTTP ${status} für ${appid}, ` +
            `neuer Versuch in ${Math.round(delay)} ms`);
        await sleep(delay);
        continue;
      }
      if (status !== 200) throw new Error(`HTTP ${status}`);
      return summarizeHistogram(JSON.parse(await response.text()));
    }
  }

  /**
   * @param {string} appid
   * @return {boolean} Ob ein Badge für dieses Spiel gerendert ist.
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

  /** Startet Anfragen, solange Plätze frei sind. */
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
      // Nur Spiele abfragen, die (noch) gerendert sind.
      if (!isRendered(appid)) {
        dropFromQueue(appid);
        continue;
      }
      activeRequests++;
      fetchHistogram(appid)
          .then((hist) => {
            cacheWrite(appid, hist);
            histMem.set(appid, {status: 'ok', t: Date.now(), hist});
            log('Histogramm', appid, hist);
          })
          .catch((e) => {
            histMem.set(appid, {status: 'failed', t: Date.now()});
            log('Histogramm fehlgeschlagen', appid, e);
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
   * Liefert den Zustand der Zusatzdaten und stößt bei Bedarf den Abruf an.
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
   * Wie getExtra, für mehrere AppIDs (Bundles): Histogramme werden
   * zusammengefasst.
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
  // DOM-Helfer
  // ===========================================================================

  /**
   * @param {!Element} anchor
   * @return {?string} AppID aus dem Link.
   */
  function appIdOf(anchor) {
    const href = anchor.getAttribute('href') || '';
    return href.match(/\/app\/(\d+)/)?.[1] || null;
  }

  /**
   * @param {!Element} element
   * @return {boolean} Ob das Element zu unseren Badges oder dem Dialog gehört.
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
   * Texte aller Blattelemente, ohne Schaltflächen und eigene Elemente.
   * @param {!Element} scope
   * @param {?Element=} exclude Dieses Element (samt Inhalt) auslassen.
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
   * Liest den Preis: zuerst ein aria-label mit Rabatt, sonst sichtbare Texte.
   * @param {!Element} item
   * @param {!Array<!Element>} priceLinks Bevorzugt durchsuchte Preis-Links.
   * @param {?Element} exclude Element, das keinen Preis enthält (Titel).
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
   * @return {!Element} Kleinster gemeinsamer Vorfahre.
   */
  function commonAncestor(nodes) {
    let ancestor = nodes[0].parentElement;
    while (ancestor && !nodes.every((node) => ancestor.contains(node))) {
      ancestor = ancestor.parentElement;
    }
    return ancestor || document.body;
  }

  // ===========================================================================
  // Seiten-Adapter: findItems, listRootOf, readItem
  // ===========================================================================

  /**
   * Gemeinsame Schnittstelle der Seiten-Adapter.
   * @interface
   */
  class PageAdapter {
    /**
     * @param {!Element|!Document} root
     * @return {!Array<!Element>} Alle Einträge unterhalb von root.
     */
    findItems(root) {}

    /**
     * @param {!Array<!Element>} items
     * @return {!Element} Element, das alle Einträge enthält.
     */
    listRootOf(items) {}

    /**
     * @param {!Element} item
     * @return {?ItemData}
     */
    readItem(item) {}
  }

  /**
   * Wunschliste: virtualisierte React-Liste, je Zeile ein div[data-index].
   * @implements {PageAdapter}
   */
  class WishlistPage {
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

  /** Kopf-Link einer Warenkorb-Position: App, Bundle oder Paket. */
  const CART_HEAD_SELECTOR =
      'a[href*="/app/"], a[href*="/bundle/"], a[href*="/sub/"]';

  /**
   * Einkaufswagen: Kopf-Link mit Bild, Titel als eigenes Element.
   * @implements {PageAdapter}
   */
  class CartPage {
    /**
     * @param {!Element|!Document} scope
     * @return {!Array<!Element>} Kopf-Links mit Bild.
     */
    heads(scope) {
      return [...scope.querySelectorAll(CART_HEAD_SELECTOR)].filter(
          (link) => link.querySelector('img') && !isOwn(link));
    }

    /**
     * @param {!Element} head
     * @return {!Element} Größter Vorfahre, der nur diese Position enthält.
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
      // Nur echte Positionen: Sie haben Add/Remove-Schaltflächen mit
      // aria-labelledby (Empfehlungen o. Ä. nicht).
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
     * @param {string|undefined} name Erwarteter Titel (alt-Text des Bildes).
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
      // Fallback: Add/Remove-Schaltflächen verweisen per aria-labelledby auf
      // den Titel.
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

  /** Desktop-Titel und responsiver Titel (#appHubAppName_responsive). */
  const STORE_TITLE_SELECTOR = '.apphub_AppName';

  /**
   * Store-Seite eines Spiels: klassisches Server-HTML mit stabilen Klassen und
   * Datenattributen.
   * @implements {PageAdapter}
   */
  class StorePage {
    /** @return {?string} AppID aus der URL. */
    appid() {
      return location.pathname.match(/^\/app\/(\d+)/)?.[1] || null;
    }

    /**
     * Kaufoptionen dieses Spiels mit Preis (Editionen/Pakete); Bundles mit
     * fremden Spielen zählen nicht.
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
     * @return {?Element} Überschrift der Kaufbox.
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
     * @return {?Node} Erster Kindknoten, der nicht unser Badge ist.
     */
    firstChild(element) {
      return [...element.childNodes].find((node) => !isOwnNode(node)) || null;
    }

    /**
     * @param {!Element} element
     * @return {string} Text ohne unser Badge.
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
      // Eigene Badges in den Kaufboxen nur bei mehreren Editionen.
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
              [`Angebot: ${this.ownText(main.heading)}`] :
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

  /** @return {!PageAdapter} Adapter für diese Seite. */
  function createPageAdapter() {
    if (/^\/cart(?:\/|$)/.test(location.pathname)) return new CartPage();
    if (/^\/app\/\d+/.test(location.pathname)) return new StorePage();
    return new WishlistPage();
  }

  const page = createPageAdapter();

  // ===========================================================================
  // Badges (React-Knoten werden nie verändert, nur eigene Elemente eingefügt)
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
      label = 'Deal-Score nicht verfügbar';
    } else if (extra.state === 'pending') {
      text = '…';
      label = 'Deal-Score wird berechnet';
    } else if (result.status !== 'ok') {
      text = '–';
      label = 'Deal-Score nicht verfügbar';
    } else {
      text = String(result.score);
      label = `Deal-Score ${result.score} von 100`;
      color = scoreColor(result.score);
    }
    pill.textContent = text;
    pill.style.background = color || CONFIG.neutralColor;
    pill.classList.toggle(`${PREFIX}-neutral`, !color);
    pill.classList.toggle(
        `${PREFIX}-noreviews`, result.status === 'ok' && !result.hasReviews);
    badge.title = buildTooltip(result, extra.state, {
      bundleSize: data.bundleSize,
      bundleMissing: extra.missing || 0,
      notes: data.notes,
    });
    badge.setAttribute('aria-label', label);
    return result;
  }

  /**
   * Setzt bzw. entfernt ein data-Attribut, nur wenn es sich ändert.
   * @param {!HTMLElement} element
   * @param {string} name
   * @param {?string} value null entfernt das Attribut.
   */
  function setData(element, name, value) {
    if (value == null) {
      if (name in element.dataset) delete element.dataset[name];
    } else if (element.dataset[name] !== value) {
      element.dataset[name] = value;
    }
  }

  /**
   * Fügt das Badge eines Eintrags ein bzw. aktualisiert es (idempotent).
   * @param {!Element} item
   * @param {?Array<!Object>} report Sammelt Debug-Zeilen, sonst null.
   */
  function processItem(item, report) {
    const data = page.readItem(item);
    if (!data) return;
    const anchor = data.anchorEl;

    const badges = item.querySelectorAll(`.${PREFIX}-badge`);
    // Doppelte Badges entfernen (nur eigene Elemente).
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
    // Vor getExtraFor setzen: Die Warteschlange prüft darauf.
    setData(badge, 'appids', data.appids.join(' '));

    const extra = getExtraFor(data.appids);
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

  /** @param {!Element} root */
  function processItems(root) {
    const report = DEBUG ? [] : null;
    for (const item of page.findItems(root)) {
      try {
        processItem(item, report);
      } catch (e) {
        console.error('[Deal-Score] Fehler in Zeile', item, e);
      }
    }
    if (report && report.length) console.table(report);
  }

  // ===========================================================================
  // Beobachtung der Liste
  // ===========================================================================

  /** @type {?Element} */
  let listRoot = null;
  /** @type {?Node} */
  let observed = null;
  let frameRequested = false;

  /**
   * @param {!MutationRecord} record
   * @return {boolean} Ob die Änderung nur unsere eigenen Elemente betrifft.
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
    if (records.some((record) => !isOwnMutation(record))) schedule();
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
    log('Beobachte', target === document.body ? 'body' : 'Liste');
  }

  /** Bündelt die Verarbeitung per requestAnimationFrame. */
  function schedule() {
    if (frameRequested) return;
    frameRequested = true;
    requestAnimationFrame(() => {
      frameRequested = false;
      tick();
    });
  }

  /** Sucht die Liste, beobachtet sie und verarbeitet alle Einträge. */
  function tick() {
    if (!listRoot || !listRoot.isConnected) {
      const items = page.findItems(document);
      listRoot = items.length ? page.listRootOf(items) : null;
    }
    observe(listRoot || document.body);
    if (listRoot) processItems(listRoot);
  }

  // ===========================================================================
  // Styles & Einstellungsdialog
  // ===========================================================================

  /** Fügt die Styles einmalig ein. */
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

  /** Gewichte im Dialog: [Schlüssel, Beschriftung]. */
  const WEIGHT_FIELDS = deepFreeze([
    ['overall', 'Gesamtbewertung'],
    ['recent', 'Letzte 30 Tage'],
    ['discount', 'Rabatt'],
    ['price', 'Preis'],
    ['popularity', 'Beliebtheit'],
  ]);

  /**
   * Erzeugt ein Element mit Attributen und Kindern.
   * @param {string} tag
   * @param {!Object<string, string>=} props Attribute; „class“ und „text“
   *     setzen className bzw. textContent.
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
   * @return {!HTMLElement} Zeile mit Eingabefeld.
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
   * @return {!HTMLElement} Zeile mit Checkbox.
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
      buildElement('legend', {text: 'Gewichte (werden automatisch normiert)'}),
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
      buildElement('legend', {text: 'Weitere Einstellungen'}),
      buildNumberRow(
          `${PREFIX}-ref`, 'Referenzpreis (€)',
          'Bei diesem Endpreis ergibt die Preis-Komponente 50.',
          buildElement('input', {
            id: `${PREFIX}-ref`,
            name: 'referencePrice',
            type: 'number',
            min: '0.5',
            step: '0.5',
            required: '',
          })),
      buildCheckRow(
          `${PREFIX}-extra`, 'fetchExtra', 'Zusatzdaten laden',
          'Quelle aller Rezensionswerte. Aus = keine Netzwerkanfragen, ' +
              'Score nur aus Rabatt und Preis.'),
      buildCheckRow(
          `${PREFIX}-penalty`, 'qualityPenalty', 'Qualitäts-Malus',
          'Ein hoher Rabatt macht ein schlecht bewertetes Spiel nicht grün.'),
    ]);

    const saveButton = buildElement(
        'button',
        {type: 'submit', class: `${PREFIX}-primary`, text: 'Speichern'});
    const cancelButton =
        buildElement('button', {type: 'button', text: 'Abbrechen'});
    const defaultsButton = buildElement(
        'button', {type: 'button', text: 'Standard wiederherstellen'});
    const cacheButton =
        buildElement('button', {type: 'button', text: 'Cache leeren'});
    const status =
        buildElement('div', {class: `${PREFIX}-status`, role: 'status'});

    form.append(
        buildElement(
            'h2', {id: `${PREFIX}-title`, text: 'Deal-Score – Einstellungen'}),
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
      status.textContent =
          'Standardwerte eingetragen – zum Übernehmen „Speichern“ klicken.';
    });
    cacheButton.addEventListener('click', () => {
      const removed = cachePrune(true);
      histMem.clear();
      settingsVersion++;
      schedule();
      status.textContent = `Cache geleert (${removed} Einträge).`;
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
   * @return {!Object} Rohwerte, noch ungeprüft.
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
   * Zeigt den Anteil jedes Gewichts an der Summe.
   * @param {!HTMLFormElement} form
   */
  function updateShares(form) {
    const values = WEIGHT_FIELDS.map(
        ([key]) => Math.max(0, Number(form.elements[`w.${key}`].value) || 0));
    const total = values.reduce((sum, value) => sum + value, 0);
    WEIGHT_FIELDS.forEach(([key], index) => {
      const share = form.querySelector(`[data-share="${key}"]`);
      share.textContent =
          total ? `${Math.round((values[index] / total) * 100)} %` : '–';
    });
  }

  /** Öffnet den Einstellungsdialog. */
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
  // Start
  // ===========================================================================

  /** Startet das Skript. */
  function init() {
    injectStyles();
    const pruned = cachePrune(false);
    if (pruned) log(`${pruned} abgelaufene Cache-Einträge entfernt`);
    if (GM_API.registerMenuCommand) {
      GM_API.registerMenuCommand('Deal-Score: Einstellungen …', openSettings);
    }
    observe(document.body);
    schedule();
    // Wird die Liste komplett ersetzt (z. B. Filterwechsel), sieht der
    // Listen-Observer das nicht.
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
