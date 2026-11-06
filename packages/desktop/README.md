# OpenCRVS Desktop (proof of concept)

This package runs the OpenCRVS v2 client (`packages/client`) as a Tauri v2
desktop app for macOS and Windows. A local backend answers every request of
the client. Records and files stay on the device. Only the configuration comes
from a country config server (by default `https://countryconfig.qa.opencrvs.dev`).

There is one local operator and no login screen. On the first start, the
client asks the operator to create a PIN.

## How it works

```
┌──────────────── Tauri app ────────────────┐
│  WebView  ── opencrvs://localhost/* ──┐   │      (Windows: http://opencrvs.localhost/*)
│  (client build, unchanged)            │   │
│                                       ▼   │
│  Rust shell (src-tauri/src/main.rs)       │
│    forwards each request, adds a secret   │
└───────────────────────┬───────────────────┘
                        │ http://127.0.0.1:<random port>
┌───────────────────────▼───────────────────┐
│  Backend (Node 22 sidecar, backend/src)   │
│   /                → client build (SPA)   │
│   /api/events/*    → tRPC router          │
│   /api/config, /api/auth/*, /api/upload   │
│   /api/countryconfig/*, /manifest.json,   │──── GET only ───▶ country config
│   /images/*        → cache + proxy        │
│   SQLite (node:sqlite) + <appdata>/files  │
└───────────────────────────────────────────┘
```

- **Rust shell.** It starts the backend with `--port 0` and a new secret for
  each launch, and waits for the line `OPENCRVS_DESKTOP_READY <port>`. The
  window loads `opencrvs://localhost/`. The protocol handler forwards every
  request to the backend and adds the secret header. The backend refuses
  requests without it, and it listens on 127.0.0.1 only.
- **Bootstrap script.** `/__desktop/bootstrap.js` comes from the backend. The
  shell uses it as the initialization script of the window, and the backend
  also adds it as the first script of `index.html`. It:
  - writes the fake token to localStorage (`opencrvs`, `opencrvs-refresh`),
  - sends `/login` back to `/`,
  - replaces `navigator.serviceWorker` with a stub, because the client renders
    only after `navigator.serviceWorker.ready`,
  - adds an in-memory CacheStorage if the webview has none,
  - sends `console.error` and uncaught errors to the backend log.
- **Backend.** One Node HTTP handler (`backend/src/server.ts`), bundled with
  esbuild into `backend/dist/index.cjs`. It reuses `@opencrvs/commons` for
  schemas, event state, scopes and available actions.
  - tRPC: real `@trpc/server` 11.8.0 with superjson 1.9.0-0, mounted at
    `/api/events` with the procedure names of the events service.
  - Storage: `node:sqlite` in `<appdata>/opencrvs.sqlite`. It holds events
    (the full `EventDocument`), drafts, locations and the country config cache.
    Uploaded files go to `<appdata>/files/`.
  - Search and workqueues: the backend evaluates `QueryType` in memory over
    the current state of each record (`backend/src/search.ts`).
  - Country config: GET requests only, without credentials. Responses are
    cached in SQLite and used when the server is not reachable.
  - Logs: `<appdata>/logs/backend.log`.

`<appdata>` is `~/Library/Application Support/org.opencrvs.desktop` on macOS
and `%APPDATA%\org.opencrvs.desktop` on Windows.

## Run it

All commands start in the repository root unless they say otherwise. Use Node
22.13 or later in the 22 line (`node:sqlite` without a flag).

```bash
pnpm install
npx nx run @opencrvs/client:build
```

### In a browser (fastest for development)

The backend serves the client build itself, so you can use Chrome or
Playwright:

```bash
cd packages/desktop && pnpm start
```

Then open http://127.0.0.1:7300. Data goes to `packages/desktop/.data`.

### As a desktop app on macOS

You need Rust (stable, 1.80 or later) and the Xcode command line tools.

```bash
cd packages/desktop && pnpm dev
```

`pnpm dev` bundles the backend, copies the Node binary that runs the script to
`src-tauri/binaries/node-<target triple>`, and runs `tauri dev`. To build an
app bundle:

```bash
cd packages/desktop && pnpm bundle
```

The bundle is about 140 MB. Most of it is the Node binary (110 MB) and the
client build (25 MB, source maps included).

### As a desktop app on Windows

The root `package.json` allows only `darwin` and `linux`, so `pnpm install`
does not run on Windows. Build the JavaScript on macOS or Linux, and build the
app on Windows:

1. On macOS or Linux: run `pnpm install`,
   `npx nx run @opencrvs/client:build` and
   `npx nx run @opencrvs/desktop:build`. Then copy the repository, including
   `packages/client/build` and `packages/desktop/backend/dist`, to Windows.
2. On Windows: install Rust with the MSVC toolchain, and Node 22.13 or later.
   WebView2 is already part of Windows 10 and 11.
3. On Windows, in `packages/desktop`:

```bash
node scripts/prepare-sidecar.mjs
```

```bash
npx @tauri-apps/cli@2 build
```

Use `npx @tauri-apps/cli@2 dev` instead of `build` for a development run.

### Settings

The backend reads these flags and environment variables:

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--data-dir` | `OPENCRVS_DESKTOP_DATA_DIR` | `.data` |
| `--client-dir` | `OPENCRVS_DESKTOP_CLIENT_DIR` | not served |
| `--port` | `OPENCRVS_DESKTOP_PORT` | random |
| `--country-config-url` | `OPENCRVS_DESKTOP_COUNTRY_CONFIG_URL` | `https://countryconfig.qa.opencrvs.dev` |
| `--role` | `OPENCRVS_DESKTOP_ROLE` | `NATIONAL_REGISTRAR` if it exists |
| `--no-strict-csp` | | strict CSP on |
| | `OPENCRVS_DESKTOP_SECRET` | no check |
| | `OPENCRVS_DESKTOP_DEBUG=1` | logs every request |

The shell reads `OPENCRVS_DESKTOP_BACKEND_URL` (use a backend that already
runs, for example `pnpm start`), `OPENCRVS_DESKTOP_BACKEND_BUNDLE`,
`OPENCRVS_DESKTOP_CLIENT_DIR` and `OPENCRVS_DESKTOP_NODE`.

## Tests

```bash
npx nx run @opencrvs/desktop:test
```

```bash
npx nx run @opencrvs/desktop:test:compilation
```

- `backend/test/backend.test.ts` starts the backend against a fake country
  config and walks a record through create, upload, declare, register, restart
  and search.
- `backend/test/search.test.ts` tests the query evaluator.
- `backend/test/router-types.ts` is a type-level test. For each procedure that
  the client calls, the desktop router must accept every input of the events
  `AppRouter` and return an output that the events `AppRouter` could return.

## What was checked

On macOS (Apple silicon), with the QA country config of 2026-11-06:

| Criterion | Result |
| --- | --- |
| 1. Window with QA's workqueues, no login | Done in the Tauri window (WKWebView) and in Chromium. |
| 2. Create, upload, declare, validate, register | Done in Chromium against the same backend. The record got a registration number and moved to "Pending certification". In the Tauri window, a record was created and a draft was saved. The full flow was not repeated there. |
| 3. Quick search and advanced search | Done in Chromium: name, tracking ID (any case), and advanced search with a typo in the name. |
| 4. Data survives a restart | Done: the backend restarts in the end-to-end test and in Chromium, and the Tauri app was quit and started again. WKWebView keeps IndexedDB, LocalStorage and CacheStorage on disk for `opencrvs://localhost`. |
| 5. Only GET requests to the country config | The backend sends only GET, without credentials (tested). The page gets a Content-Security-Policy that allows only its own origin, so it cannot call other hosts. |
| 6. Offline start | Done: the backend started with an unreachable country config URL and served everything from the cache. |

The custom scheme on WKWebView works: module scripts, `import()` of
`/api/countryconfig/handlebars.js`, `fetch` with POST bodies, and persistent
storage. So the fallback to `http://127.0.0.1` was not needed.

**Not checked:** Windows. There was no Windows machine. The shell uses
`http://opencrvs.localhost` there, which is how WebView2 serves custom schemes
in Tauri v2.

## Differences from the events service

- Actions are accepted at once. Like the events service with a synchronous
  confirmation, each action is stored as a Requested action and an Accepted
  action that points to it. The backend never calls `/trigger/...` or
  `/reindex`. REGISTER gets a random 12-character registration number.
- The backend checks that the action is available in the current status and
  flags, and that uploaded files exist. It does not check action conditionals,
  form validation, assignment or jurisdiction. The client already checks them.
- Duplicate detection is off.
- Search runs in memory. A date without time covers the whole day in the
  device time zone. The events service uses `Asia/Dhaka`.
- The operator gets one scope of each type that any role has, without options
  (so without jurisdiction limits). `workqueue` and `record.custom-action` keep
  the combined ids and action types. The backend leaves out `record.notify`
  (the client does not support roles that can notify and declare), printing,
  dashboards, performance, user management and system scopes.
- The operator's office is the first active CRVS office that belongs to an
  administrative area. On QA that is "Central Province Office". "HQ Office" has
  no area, so address fields would have no default.
- Location ids are UUIDv5 of `<country>:<country config id>`, where the
  country comes from `client-config.js`. They are the same on every device.
- Printing and certificates are not supported: `/certificates` returns `[]`.
- The strict CSP blocks Google Fonts, so the app uses the fallback font. It
  also blocks absolute URLs in the event config, such as an autocomplete that
  calls the country config directly.

## Known gaps

- No signed installers and no auto-update.
- The Node sidecar is a full Node binary (110 MB). A Node single executable or
  a smaller runtime could make the app smaller.
- `@opencrvs/commons/client` runs its test fixtures when it loads, so the
  backend log starts with deprecation warnings about test events.
