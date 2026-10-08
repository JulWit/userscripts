/**
 * @fileoverview Loaded by the fixture pages before a userscript: stands in
 * for Violentmonkey's GM_* functions and opens closed shadow roots, so that
 * tests can inspect the script's UI.
 */

'use strict';

/**
 * Stored values. Tests can preset them by defining window.harnessPreset (an
 * object) in an init script, before the page loads.
 * @type {!Map<string, *>}
 */
const harnessValues = new Map(Object.entries(window.harnessPreset || {}));

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

/** @param {string} key */
function GM_deleteValue(key) {
  harnessValues.delete(key);
}

/** @return {!Array<string>} */
function GM_listValues() {
  return [...harnessValues.keys()];
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

/**
 * Registered menu commands by ID; a command registered again with the same
 * ID replaces the old one, as in Violentmonkey.
 * @type {!Map<string, {caption: string, callback: !Function}>}
 */
const harnessMenuCommands = new Map();

/**
 * @param {string} caption
 * @param {!Function} callback
 * @param {{id: (string|undefined)}=} options
 * @return {string}
 */
function GM_registerMenuCommand(caption, callback, options) {
  const id = (options && options.id) || caption;
  harnessMenuCommands.set(id, {caption, callback});
  return id;
}

/**
 * Runs a menu command as if it was picked from the script manager's menu:
 * without a user action in the page.
 * @param {string} caption
 */
function harnessRunMenuCommand(caption) {
  for (const command of harnessMenuCommands.values()) {
    if (command.caption === caption) {
      command.callback(new MouseEvent('click'));
      return;
    }
  }
  throw new Error(`No menu command "${caption}"`);
}

// With ?touch in the URL, the page reports a coarse primary pointer, as on a
// phone, so that the ruler shows its touch controls in any browser.
if (new URLSearchParams(location.search).has('touch')) {
  const harnessMatchMedia = window.matchMedia.bind(window);
  window.matchMedia = (query) => query.includes('pointer: coarse') ?
      /** @type {!MediaQueryList} */ ({matches: true, media: query}) :
      harnessMatchMedia(query);
}

const harnessAttachShadow = Element.prototype.attachShadow;
Element.prototype.attachShadow = function(init) {
  return harnessAttachShadow.call(this, {...init, mode: 'open'});
};

/**
 * @param {string} selector
 * @param {string} word
 * @return {!Range} The first occurrence of the word in the element.
 */
function wordRange(selector, word) {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`No element ${selector}`);
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const index = node.data.indexOf(word);
    if (index < 0) continue;
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + word.length);
    return range;
  }
  throw new Error(`No word "${word}" in ${selector}`);
}

/**
 * Finds a word in an element.
 * @param {string} selector
 * @param {string} word
 * @return {{x: number, y: number, top: number, bottom: number}} Center of
 *     the word in viewport coordinates, its top and bottom in document
 *     coordinates.
 */
function wordPoint(selector, word) {
  const rect = wordRange(selector, word).getClientRects()[0];
  return {
    x: rect.left + rect.width / 2,
    y: (rect.top + rect.bottom) / 2,
    top: rect.top + window.scrollY,
    bottom: rect.bottom + window.scrollY,
  };
}

/**
 * Scrolls the page so that a word is in view, if it is not, and finds it.
 * Words already in view stay where they are, so a test's starting layout is
 * kept.
 * @param {string} selector
 * @param {string} word
 * @return {{x: number, y: number, top: number, bottom: number,
 *     hit: boolean}} As wordPoint; hit tells whether the element at the
 *     word's center is the word's parent element or inside it, i.e.
 *     whether a click there reaches the word.
 */
function revealWord(selector, word) {
  const range = wordRange(selector, word);
  const rect = range.getClientRects()[0];
  if (rect.top < 0 || rect.bottom > window.innerHeight) {
    window.scrollTo({
      top: window.scrollY + rect.top - window.innerHeight / 2,
      behavior: 'instant',
    });
  }
  const point = wordPoint(selector, word);
  const target = document.elementFromPoint(point.x, point.y);
  const parent = range.startContainer.parentElement;
  return {...point, hit: !!target && !!parent && parent.contains(target)};
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
