/**
 * @fileoverview Unit tests for the pure functions of
 * scripts/steam-dealscore.user.js. Run with `node --test` (Node.js 18+).
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {describe, it} = require('node:test');
const vm = require('node:vm');

/**
 * Runs the userscript with the test hook and returns its pure functions. The
 * script stops before touching the DOM, storage or network.
 * @return {!Object}
 */
function loadCore() {
  const file =
      path.join(__dirname, '..', 'scripts', 'steam-dealscore.user.js');
  let core = null;
  globalThis.dealScoreTestHook = (api) => {
    core = api;
  };
  try {
    vm.runInThisContext(fs.readFileSync(file, 'utf8'), {filename: file});
  } finally {
    delete globalThis.dealScoreTestHook;
  }
  assert.ok(core, 'test hook was not called');
  return core;
}

const core = loadCore();
const settings = core.defaultSettings();

/**
 * @param {number} upTotal
 * @param {number} downTotal
 * @param {number=} up30
 * @param {number=} down30
 * @return {!Object} Histogram.
 */
function hist(upTotal, downTotal, up30 = 0, down30 = 0) {
  return {up30, down30, upTotal, downTotal};
}

/**
 * @param {number} discount
 * @param {number} final
 * @return {!Object} Price.
 */
function price(discount, final) {
  const original = discount ? final / (1 - discount / 100) : final;
  return {discount, original, final, free: final === 0};
}

describe('parseMoney', () => {
  const cases = [
    ['25,59€', 25.59],
    ['25,59 €', 25.59],
    ['€12.99', 12.99],
    ['1.234,56€', 1234.56],
    ['1,234.56', 1234.56],
    ['1.234€', 1234],
    ['25,--€', 25],
    ['1 234,50 €', 1234.5],
    ['1 234,50 €', 1234.5],
    ['5', 5],
  ];
  for (const [input, expected] of cases) {
    it(`parses ${JSON.stringify(input)}`, () => {
      assert.equal(core.parseMoney(input), expected);
    });
  }

  it('treats a regular space as the end of the number', () => {
    // Only non-breaking spaces are thousands separators; otherwise adjacent
    // prices such as "31,99 25,59" would merge.
    assert.equal(core.parseMoney('31,99 25,59'), 31.99);
  });

  it('returns null without a number', () => {
    assert.equal(core.parseMoney('Free'), null);
    assert.equal(core.parseMoney(null), null);
  });
});

describe('currency patterns', () => {
  const patterns = core.text.currencyPatterns;

  it('recognizes zł directly after the number', () => {
    assert.ok(patterns.PLN.test('12,99zł'));
    assert.ok(patterns.PLN.test('12,99 zł'));
  });

  it('only accepts the store currency', () => {
    const store = patterns[core.text.currencyCode];
    assert.ok(store.test('25,59€'));
    assert.ok(!store.test('$12.99'));
  });
});

describe('parsePriceLabel', () => {
  it('reads discount, original and final price', () => {
    assert.deepEqual(
        core.parsePriceLabel('20% off. Regular price €31.99, now €25.59.'),
        {discount: 20, original: 31.99, final: 25.59, free: false});
  });

  it('reads German labels', () => {
    assert.deepEqual(
        core.parsePriceLabel('-75 % Rabatt. Normalpreis 39,99€, jetzt 9,99€'),
        {discount: 75, original: 39.99, final: 9.99, free: false});
  });

  it('ignores labels without the store currency or discount', () => {
    assert.equal(core.parsePriceLabel('20% off. Was $31.99, now $25.59.'),
        null);
    assert.equal(core.parsePriceLabel('Regular price €31.99'), null);
    assert.equal(core.parsePriceLabel(null), null);
  });
});

describe('parsePriceTexts', () => {
  it('reads a discounted price', () => {
    assert.deepEqual(core.parsePriceTexts(['-20%', '31,99€', '25,59€']),
        {discount: 20, original: 31.99, final: 25.59, free: false});
  });

  it('reads a regular price', () => {
    assert.deepEqual(core.parsePriceTexts(['19,50€']),
        {discount: 0, original: 19.5, final: 19.5, free: false});
  });

  it('derives the discount when it is not shown', () => {
    assert.equal(core.parsePriceTexts(['20,00€', '15,00€']).discount, 25);
  });

  it('recognizes free games', () => {
    assert.deepEqual(core.parsePriceTexts(['Free to Play']),
        {discount: 0, original: 0, final: 0, free: true});
    assert.equal(core.parsePriceTexts(['Kostenlos spielbar']).free, true);
  });

  it('ignores other currencies and unrelated texts', () => {
    assert.equal(core.parsePriceTexts(['$12.99']), null);
    assert.equal(core.parsePriceTexts(['Add to cart', '']), null);
  });
});

describe('summarizeHistogram', () => {
  it('sums recent days and rollups', () => {
    const json = {
      success: 1,
      results: {
        recent: [
          {recommendations_up: 3, recommendations_down: 1},
          {recommendations_up: '2', recommendations_down: 0},
        ],
        rollups: [
          {recommendations_up: 100, recommendations_down: 10},
          {recommendations_up: 50, recommendations_down: 5},
        ],
      },
    };
    assert.deepEqual(core.summarizeHistogram(json), hist(150, 15, 5, 1));
  });

  it('throws on unexpected responses', () => {
    assert.throws(() => core.summarizeHistogram({success: 2}));
    assert.throws(() => core.summarizeHistogram(null));
  });
});

describe('combineHistograms', () => {
  it('adds all counts', () => {
    assert.deepEqual(
        core.combineHistograms([hist(10, 2, 1, 0), hist(5, 3, 0, 2)]),
        hist(15, 5, 1, 2));
    assert.deepEqual(core.combineHistograms([]), hist(0, 0));
  });
});

describe('scales', () => {
  it('shrinkRating pulls small samples towards 50 %', () => {
    assert.equal(core.shrinkRating(1, 0), 1 - 0.5);
    assert.ok(core.shrinkRating(1, 10) < core.shrinkRating(1, 10000));
    assert.equal(core.shrinkRating(0.5, 1234), 0.5);
  });

  it('easeOut is linear for k = 1 and clamps its input', () => {
    assert.ok(Math.abs(core.easeOut(0.3, 1) - 0.3) < 1e-12);
    assert.equal(core.easeOut(0.5, 2), 0.75);
    assert.equal(core.easeOut(-1, 2), 0);
    assert.equal(core.easeOut(2, 2), 1);
  });

  it('priceValue is 0.5 at the reference price and 1 when free', () => {
    assert.equal(core.priceValue(20, 20, 2), 0.5);
    assert.equal(core.priceValue(0, 20, 2), 1);
    assert.ok(core.priceValue(5, 20, 2) > core.priceValue(10, 20, 2));
  });
});

describe('computeScore', () => {
  it('needs a price', () => {
    assert.equal(core.computeScore({price: null}, null, settings).status,
        'noPrice');
  });

  it('reports when all available weights are 0', () => {
    const zero = {...settings, weights: {...settings.weights, discount: 0,
      price: 0}};
    assert.equal(core.computeScore({price: price(50, 10)}, null, zero).status,
        'noWeights');
  });

  it('stays within 1–100', () => {
    const best = core.computeScore(
        {price: price(90, 0)}, hist(1e6, 0, 1000, 0), settings);
    const worst = core.computeScore(
        {price: price(0, 500)}, hist(0, 1e6, 0, 1000), settings);
    assert.ok(best.score <= 100 && best.score >= 90, `best ${best.score}`);
    assert.ok(worst.score >= 1 && worst.score <= 10, `worst ${worst.score}`);
  });

  it('adds up the points of all components', () => {
    const result = core.computeScore(
        {price: price(60, 8)}, hist(9000, 1000, 80, 20), settings);
    const points = Object.values(result.parts)
        .reduce((sum, part) => sum + part.points, 0);
    assert.ok(
        Math.abs(1 + points - result.penaltyPoints - result.score) <= 0.5,
        `points ${points}, score ${result.score}`);
  });

  it('applies the quality penalty to poorly rated games', () => {
    const row = {price: price(80, 4)};
    const poor = hist(400, 600);
    const withPenalty = core.computeScore(row, poor, settings);
    const without = core.computeScore(
        row, poor, {...settings, qualityPenalty: false});
    assert.ok(withPenalty.penalty < 1);
    assert.ok(withPenalty.score < without.score);
  });

  it('ignores missing review data instead of counting it as 0', () => {
    const result = core.computeScore({price: price(50, 10)}, null, settings);
    assert.equal(result.status, 'ok');
    assert.equal(result.hasReviews, false);
    assert.equal(result.parts.overall.available, false);
    assert.equal(result.parts.popularity.available, false);
  });
});

describe('scoreColor', () => {
  const stops = core.config.colorStops;

  it('uses the end colors outside the stops', () => {
    assert.equal(core.scoreColor(1), 'rgb(217, 68, 59)');
    assert.equal(core.scoreColor(100), 'rgb(79, 174, 63)');
  });

  it('interpolates between stops', () => {
    assert.equal(core.scoreColor(stops[1].score), 'rgb(232, 165, 48)');
    assert.notEqual(core.scoreColor(40), core.scoreColor(45));
  });
});

describe('buildTooltip', () => {
  it('shows a message while loading', () => {
    const result = core.computeScore({price: price(10, 9)}, null, settings);
    const content = core.buildTooltip(result, 'pending');
    assert.equal(content.rows.length, 0);
    assert.match(content.title, /loading/);
  });

  it('lists the components and the total', () => {
    const result = core.computeScore(
        {price: price(50, 10)}, hist(900, 100, 9, 1), settings);
    const content = core.buildTooltip(result, 'ok', {bundleSize: 2});
    assert.deepEqual(content.rows.map((row) => row.label), [
      'Base', 'Overall rating', 'Last 30 days', 'Discount', 'Price',
      'Popularity',
    ]);
    assert.equal(content.total, String(result.score));
    assert.ok(content.notes.some((note) => note.includes('2 included')));
  });

  it('explains a missing price', () => {
    const content = core.buildTooltip({status: 'noPrice'}, 'ok');
    assert.match(content.notes[0], /not in EUR/);
  });
});

describe('sanitizeSettings', () => {
  const {weight, referencePrice} = core.config.limits;

  it('returns the defaults for missing input', () => {
    assert.deepEqual(core.sanitizeSettings(null), core.defaultSettings());
  });

  it('clamps numbers to the dialog limits', () => {
    const result = core.sanitizeSettings({
      weights: {overall: -5, recent: 1e9},
      referencePrice: 0.01,
    });
    assert.equal(result.weights.overall, weight.min);
    assert.equal(result.weights.recent, weight.max);
    assert.equal(result.referencePrice, referencePrice.min);
    assert.equal(
        core.sanitizeSettings({referencePrice: 1e6}).referencePrice,
        referencePrice.max);
  });

  it('replaces invalid values and accepts form strings', () => {
    const result = core.sanitizeSettings({
      weights: {overall: '', discount: '42', price: 'abc'},
      fetchExtra: 'yes',
      qualityPenalty: false,
    });
    const defaults = core.defaultSettings();
    assert.equal(result.weights.overall, defaults.weights.overall);
    assert.equal(result.weights.discount, 42);
    assert.equal(result.weights.price, defaults.weights.price);
    assert.equal(result.fetchExtra, defaults.fetchExtra);
    assert.equal(result.qualityPenalty, false);
  });
});
