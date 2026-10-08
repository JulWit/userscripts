/**
 * @fileoverview Checks that the `@icon` data URI of every userscript matches
 * its SVG source in icons/. Run with `node --test` (Node.js 18+).
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {describe, it} = require('node:test');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = ['reading-ruler', 'speed-reader', 'steam-dealscore'];
const PREFIX = 'data:image/svg+xml;base64,';

describe('@icon', () => {
  for (const name of SCRIPTS) {
    it(`matches icons/${name}.svg`, () => {
      const script = fs.readFileSync(
          path.join(ROOT, 'scripts', `${name}.user.js`), 'utf8');
      const match = /^\/\/ @icon\s+(\S+)$/m.exec(script);
      assert.ok(match, 'no @icon line');
      const uri = match[1];
      assert.ok(uri.startsWith(PREFIX), 'not a base64 SVG data URI');
      // Line endings may differ after a checkout with core.autocrlf.
      const svg = fs.readFileSync(
          path.join(ROOT, 'icons', `${name}.svg`), 'utf8')
          .replace(/\r\n/g, '\n');
      assert.equal(Buffer.from(uri.slice(PREFIX.length), 'base64')
          .toString('utf8'), svg);
    });
  }
});
