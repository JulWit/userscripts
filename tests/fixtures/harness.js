/**
 * @fileoverview Loaded by the fixture pages before a userscript: stands in
 * for Violentmonkey's GM_* functions and opens closed shadow roots, so that
 * tests can inspect the script's UI.
 */

'use strict';

/** @type {!Map<string, *>} */
const harnessValues = new Map();

/**
 * @param {string} key
 * @param {*=} fallback
 * @return {*}
 */
function GM_getValue(key, fallback) {
  return harnessValues.has(key) ? harnessValues.get(key) : fallback;
}

/**
 * @param {string} key
 * @param {*} value
 */
function GM_setValue(key, value) {
  harnessValues.set(key, value);
}

/** @type {!Array<{key: string, callback: !Function}>} */
const harnessListeners = [];

/**
 * @param {string} key
 * @param {!Function} callback
 * @return {string}
 */
function GM_addValueChangeListener(key, callback) {
  harnessListeners.push({key, callback});
  return String(harnessListeners.length);
}

/**
 * Stores a value as another tab would, and notifies the listeners.
 * @param {string} key
 * @param {*} value
 */
function harnessSetRemoteValue(key, value) {
  const oldValue = harnessValues.get(key);
  harnessValues.set(key, value);
  for (const listener of harnessListeners) {
    if (listener.key === key) listener.callback(key, oldValue, value, true);
  }
}

/** @return {string} */
function GM_registerMenuCommand() {
  return 'harness';
}

const harnessAttachShadow = Element.prototype.attachShadow;
Element.prototype.attachShadow = function(init) {
  return harnessAttachShadow.call(this, {...init, mode: 'open'});
};

/**
 * Finds a word in an element.
 * @param {string} selector
 * @param {string} word
 * @return {{x: number, y: number, top: number, bottom: number}} Center of
 *     the word in viewport coordinates, its top and bottom in document
 *     coordinates.
 */
function wordPoint(selector, word) {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`No element ${selector}`);
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const index = node.data.indexOf(word);
    if (index < 0) continue;
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + word.length);
    const rect = range.getClientRects()[0];
    return {
      x: rect.left + rect.width / 2,
      y: (rect.top + rect.bottom) / 2,
      top: rect.top + window.scrollY,
      bottom: rect.bottom + window.scrollY,
    };
  }
  throw new Error(`No word "${word}" in ${selector}`);
}

/**
 * @return {?{top: number, bottom: number, left: number, right: number}} Box
 *     of the Reading Ruler highlight in document coordinates, null if it is
 *     hidden. Read from the inline styles, so a running slide animation does
 *     not matter.
 */
function rulerBox() {
  const host = document.querySelector('reading-ruler');
  const ruler = host && host.shadowRoot &&
      host.shadowRoot.querySelector('.rr-ruler');
  if (!host || !ruler || ruler.hidden) return null;
  const origin = host.getBoundingClientRect();
  const top = origin.top + window.scrollY + parseFloat(ruler.style.top);
  const left = origin.left + window.scrollX + parseFloat(ruler.style.left);
  return {
    top,
    bottom: top + parseFloat(ruler.style.height),
    left,
    right: left + parseFloat(ruler.style.width),
  };
}
