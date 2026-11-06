/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * OpenCRVS is also distributed under the terms of the Civil Registration
 * & Healthcare Disclaimer located at http://opencrvs.org/license.
 *
 * Copyright (C) The OpenCRVS Authors located at https://github.com/opencrvs/opencrvs-core/blob/master/AUTHORS.
 */
import fs from 'node:fs'
import type { ServerResponse } from 'node:http'
import path from 'node:path'
import { mimeTypeOf } from './files'

/**
 * Blocks requests from the page to any other host. The client then cannot
 * send record data off the device, for example from a form field that calls
 * an external URL. Google Fonts is blocked too, so the app uses fallback fonts.
 */
export const STRICT_CSP = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "frame-src 'self' blob: data:",
  "media-src 'self' blob: data:",
  "object-src 'self' blob: data:"
].join('; ')

/**
 * Runs before every other script of the page. The Tauri shell also uses it
 * as the initialization script of the window. It:
 *
 * 1. writes the token to localStorage, so the client never asks to log in,
 * 2. leaves `/login` for `/`,
 * 3. replaces `navigator.serviceWorker` with a stub. The client renders only
 *    after `navigator.serviceWorker.ready`, but custom URL schemes and
 *    WKWebView have no service workers. The stub is used in a browser too,
 *    so the app works the same way in both,
 * 4. adds an in-memory CacheStorage if the webview has none, and opens the
 *    `workbox-runtime` cache that the client puts uploaded files in.
 */
export const BOOTSTRAP_PATH = '/__desktop/bootstrap.js'

const SHIM = String.raw`
  if (window.__opencrvsDesktop) {
    return;
  }
  window.__opencrvsDesktop = true;

  try {
    window.localStorage.setItem('opencrvs', TOKEN);
    window.localStorage.setItem('opencrvs-refresh', TOKEN);
  } catch (e) {
    console.error('OpenCRVS desktop: could not store the token', e);
  }

  if (window.location.pathname.indexOf('/login') === 0) {
    window.location.replace('/');
    return;
  }

  // A desktop window has no visible console: send errors to the backend log.
  var reported = 0;
  function report(level, args) {
    if (reported++ > 200) { return; }
    try {
      var text = Array.prototype.map.call(args, function (a) {
        if (a instanceof Error) { return a.stack || a.message; }
        if (a && typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
        return String(a);
      }).join(' ').slice(0, 4000);
      fetch(LOG_PATH, {
        method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level: level, text: text, path: window.location.pathname })
      }).catch(function () {});
    } catch (e) {}
  }
  ['error'].forEach(function (level) {
    var original = console[level];
    console[level] = function () { report(level, arguments); return original.apply(console, arguments); };
  });
  window.addEventListener('error', function (e) {
    report('error', [e.message + ' (' + e.filename + ':' + e.lineno + ')']);
  });
  window.addEventListener('unhandledrejection', function (e) {
    report('error', ['Unhandled rejection:', e.reason]);
  });

  var real = navigator.serviceWorker;
  if (real && typeof real.getRegistrations === 'function') {
    real.getRegistrations().then(function (registrations) {
      registrations.forEach(function (r) { r.unregister(); });
    }).catch(function () {});
  }
  function noop() {}
  var registration = {
    active: null, installing: null, waiting: null,
    scope: window.location.origin + '/',
    update: function () { return Promise.resolve(); },
    unregister: function () { return Promise.resolve(true); },
    addEventListener: noop, removeEventListener: noop
  };
  var serviceWorker = {
    controller: null,
    ready: Promise.resolve(registration),
    register: function () { return Promise.resolve(registration); },
    getRegistration: function () { return Promise.resolve(undefined); },
    getRegistrations: function () { return Promise.resolve([]); },
    startMessages: noop, addEventListener: noop, removeEventListener: noop
  };
  Object.defineProperty(navigator, 'serviceWorker', { value: serviceWorker, configurable: true });

  if (typeof window.caches === 'undefined') {
    var keyOf = function (request) {
      return new URL(typeof request === 'string' ? request : request.url, window.location.href).href;
    };
    var MemoryCache = function () { this.entries = new Map(); };
    MemoryCache.prototype.put = function (request, response) {
      var entries = this.entries;
      return response.blob().then(function (blob) {
        entries.set(keyOf(request), { blob: blob, headers: Array.from(response.headers.entries()), status: response.status });
      });
    };
    MemoryCache.prototype.match = function (request) {
      var entry = this.entries.get(keyOf(request));
      return Promise.resolve(entry ? new Response(entry.blob, { status: entry.status, headers: entry.headers }) : undefined);
    };
    MemoryCache.prototype.delete = function (request) {
      return Promise.resolve(this.entries.delete(keyOf(request)));
    };
    MemoryCache.prototype.keys = function () {
      return Promise.resolve(Array.from(this.entries.keys()).map(function (url) { return new Request(url); }));
    };
    var stores = new Map();
    var cacheStorage = {
      open: function (name) {
        if (!stores.has(name)) { stores.set(name, new MemoryCache()); }
        return Promise.resolve(stores.get(name));
      },
      has: function (name) { return Promise.resolve(stores.has(name)); },
      delete: function (name) { return Promise.resolve(stores.delete(name)); },
      keys: function () { return Promise.resolve(Array.from(stores.keys())); },
      match: function (request) {
        return Promise.all(Array.from(stores.values()).map(function (c) { return c.match(request); }))
          .then(function (results) { return results.find(Boolean); });
      }
    };
    Object.defineProperty(window, 'caches', { value: cacheStorage, configurable: true });
  }
  window.caches.open('workbox-runtime').catch(function () {});
`

/** The page sends its console errors here. */
export const CLIENT_LOG_PATH = '/__desktop/log'

export function bootstrapScript(token: string) {
  return `;(function () {\n  var TOKEN = ${JSON.stringify(token)};\n  var LOG_PATH = ${JSON.stringify(CLIENT_LOG_PATH)};\n${SHIM}\n})();\n`
}

export const LOGIN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>OpenCRVS</title><script src="${BOOTSTRAP_PATH}"></script></head><body></body></html>`

export class StaticFiles {
  private indexHtml: string | undefined

  constructor(
    private readonly root: string,
    private readonly strictCsp: boolean
  ) {}

  private resolve(urlPath: string): string | undefined {
    let decoded: string
    try {
      decoded = decodeURIComponent(urlPath)
    } catch {
      return undefined
    }
    const absolute = path.join(this.root, path.normalize(decoded))
    if (absolute !== this.root && !absolute.startsWith(this.root + path.sep)) {
      return undefined
    }
    return absolute
  }

  private getIndexHtml() {
    if (!this.indexHtml) {
      const html = fs.readFileSync(path.join(this.root, 'index.html'), 'utf8')
      // The bootstrap script must run before client-config.js and the app.
      this.indexHtml = html.replace(
        /<head>/i,
        `<head>\n    <script src="${BOOTSTRAP_PATH}"></script>`
      )
    }
    return this.indexHtml
  }

  sendIndex(res: ServerResponse) {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      ...(this.strictCsp ? { 'content-security-policy': STRICT_CSP } : {})
    })
    res.end(this.getIndexHtml())
  }

  /** Serves a file of the client build. Paths without a file extension get index.html. */
  serve(urlPath: string, res: ServerResponse) {
    if (urlPath === '/' || urlPath === '/index.html') {
      this.sendIndex(res)
      return
    }
    const absolute = this.resolve(urlPath)
    if (absolute && fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
      res.writeHead(200, {
        'content-type': mimeTypeOf(absolute),
        'cache-control': urlPath.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache'
      })
      fs.createReadStream(absolute).pipe(res)
      return
    }
    if (path.extname(urlPath)) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('Not found')
      return
    }
    this.sendIndex(res)
  }
}
