// The page, the script and the service worker must carry the same build id, or an update can mix old and new files.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const html = fs.readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../frontend/js/app.js', import.meta.url), 'utf8');
const sw = fs.readFileSync(new URL('../frontend/sw.js', import.meta.url), 'utf8');
const a = html.match(/<meta name="build" content="([^"]+)"/)[1];
const b = app.match(/const BUILD = '([^']+)'/)[1];
const c = sw.match(/const VERSION = '([^']+)'/)[1];
assert.equal(a, b, 'index.html meta build vs app.js BUILD');
assert.equal(a, c, 'index.html meta build vs sw.js VERSION');
console.log('build ids match:', a);
