/**
 * @fileoverview Loads userscripts and their libraries for the unit tests.
 * A script runs as Violentmonkey runs it: the files of its @require lines
 * first, in the same scope, then the script itself. Required files must come
 * from this repository; they are read from the working tree.
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const REPOSITORY_URL =
    'https://raw.githubusercontent.com/JulWit/userscripts/main/';

/**
 * @param {string} source A userscript.
 * @return {!Array<{url: string, file: string}>} Its @require URLs and the
 *     files in this repository they point to.
 */
function requiredFiles(source) {
  const metadata = /\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/
      .exec(source);
  assert.ok(metadata, 'no metadata block');
  return [...metadata[1].matchAll(/^\/\/ @require\s+(\S+)$/gm)]
      .map(([, url]) => {
        assert.ok(url.startsWith(REPOSITORY_URL),
            `@require from outside the repository: ${url}`);
        const file = new URL(url).pathname
            .slice(new URL(REPOSITORY_URL).pathname.length);
        return {url, file: path.join(ROOT, file)};
      });
}

/**
 * Runs a userscript with its test hook and returns what the hook received:
 * its pure functions. The script stops before touching the DOM or storage.
 * @param {string} name File name in scripts/.
 * @param {string} hook Name of the global test hook the script calls.
 * @return {!Object}
 */
function loadScript(name, hook) {
  const file = path.join(ROOT, 'scripts', name);
  const source = fs.readFileSync(file, 'utf8');
  const parts = requiredFiles(source)
      .map((required) => fs.readFileSync(required.file, 'utf8'));
  let core = null;
  globalThis[hook] = (api) => {
    core = api;
  };
  try {
    const code = [...parts, source].join('\n');
    vm.runInThisContext(`(function() {\n${code}\n})();`, {filename: file});
  } finally {
    delete globalThis[hook];
  }
  assert.ok(core, 'test hook was not called');
  return core;
}

/**
 * Runs a library file and returns the global it defines.
 * @param {string} name File name in lib/.
 * @param {string} global Name of the global.
 * @return {*}
 */
function loadLibrary(name, global) {
  const file = path.join(ROOT, 'lib', name);
  const code = fs.readFileSync(file, 'utf8');
  return vm.runInThisContext(
      `(function() {\n${code}\nreturn ${global};\n})();`, {filename: file});
}

module.exports = {ROOT, loadLibrary, loadScript, requiredFiles};
