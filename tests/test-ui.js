'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../root/www/luci-static/resources/view/xray-simple/core-v3.js'), 'utf8');
let link, color = 'rgb(34, 34, 34)', theme, timeout;
const context = {
    document: {
        body: {},
        documentElement: { setAttribute: (_, value) => { theme = value; } },
        getElementById: () => link,
        head: { appendChild: node => { link = node; } }
    },
    window: {
        getComputedStyle: () => ({ color }),
        matchMedia: () => ({ addEventListener() {} }),
        setTimeout: fn => { timeout = fn; return 1; },
        clearTimeout: () => { timeout = null; }
    },
    MutationObserver: class { observe() {} },
    E: (_, attrs) => ({ ...attrs, getAttribute: name => attrs[name], remove() { if (link === this) link = null; } }),
    L: { resource: p => '/luci-static/resources/' + p },
    _: text => text,
    view: { extend: obj => obj }
};
vm.createContext(context);
vm.runInContext(source.replace('return view.extend({', 'globalThis.testView = view.extend({'), context);
(async () => {
    assert.equal(theme, 'light', 'explicit light theme must beat OS preference');
    color = 'rgb(204, 204, 204)';
    context.syncTheme();
    assert.equal(theme, 'dark', 'Argon dark CSS has no theme attribute');
    const first = context.loadStyles();
    let resolved = false;
    first.then(() => { resolved = true; });
    await Promise.resolve();
    assert.equal(resolved, false, 'render must wait for CSS');
    link.sheet = {};
    link.onload();
    await first;
    assert.equal(timeout, null);
    const loaded = link;
    await context.loadStyles();
    assert.equal(link, loaded, 'reuse the already loaded stylesheet');
    link = { getAttribute: () => 'old-release.css', remove() { link = null; } };
    const failed = context.loadStyles();
    assert.notEqual(link, loaded);
    link.onerror();
    await assert.rejects(failed, /Unable to load/);
    assert.equal(link, null, 'failed stylesheet must be retryable');
    const retry = context.loadStyles();
    timeout();
    await assert.rejects(retry, /Unable to load/);
    assert.equal(link, null, 'timeout must be retryable');
    console.log('UI loading and theme regression tests: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
