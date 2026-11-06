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
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { createHTTPHandler } from '@trpc/server/adapters/standalone'
import {
  CountryConfig,
  CountryConfigUnavailableError
} from './countryconfig'
import { DesktopEnv, ORIGIN_HEADER, SECRET_HEADER } from './env'
import { FileStore, mimeTypeOf } from './files'
import { log } from './log'
import {
  BOOTSTRAP_PATH,
  bootstrapScript,
  CLIENT_LOG_PATH,
  LOGIN_PAGE,
  StaticFiles
} from './static'
import { appRouter, Services } from './trpc/router'

/** The fields of `/config/application` that the gateway gives to users who are not logged in. */
const PUBLIC_CONFIG_FIELDS = [
  'APPLICATION_NAME',
  'COUNTRY_LOGO',
  'PHONE_NUMBER_PATTERN',
  'USER_NOTIFICATION_DELIVERY_METHOD',
  'INFORMANT_NOTIFICATION_DELIVERY_METHOD'
]

/** Integration routes of the gateway that the desktop app does not have. */
const UNSUPPORTED_API_ROUTES = [
  '/api/nid',
  '/api/brn',
  '/api/user-info',
  '/api/membership/check',
  '/api/digital-identity/certificate',
  '/api/causes-of-death'
]

/** A file that the client shows by its document path, because it has no service worker. */
const DOCUMENT_URL = /^\/(?:events|users)\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,8}$/

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(JSON.stringify(body))
}

function sendText(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(body)
}

function originOf(req: IncomingMessage) {
  const origin = req.headers[ORIGIN_HEADER]
  if (typeof origin === 'string' && origin) {
    return origin.replace(/\/$/, '')
  }
  return `http://${req.headers.host ?? 'localhost'}`
}

function toWebRequest(req: IncomingMessage): Request {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      value.forEach((v) => headers.append(key, v))
    } else if (value !== undefined) {
      headers.set(key, value)
    }
  }
  return new Request(`http://localhost${req.url ?? '/'}`, {
    method: req.method,
    headers,
    body: Readable.toWeb(req) as ReadableStream,
    duplex: 'half'
  } as RequestInit)
}

export function createRequestHandler(
  env: DesktopEnv,
  services: Services & { countryConfig: CountryConfig; files: FileStore }
) {
  const { countryConfig, files, identity } = services
  const staticFiles = env.clientDir
    ? new StaticFiles(env.clientDir, env.strictCsp)
    : undefined

  const trpcHandler = createHTTPHandler({
    router: appRouter,
    basePath: '/api/events/',
    allowBatching: true,
    allowMethodOverride: true,
    createContext: ({ req }) => ({ services, origin: originOf(req) }),
    onError: ({ error, path }) => {
      if (error.code === 'INTERNAL_SERVER_ERROR') {
        log.error(`tRPC ${path}: ${error.message}\n${error.cause?.stack ?? ''}`)
      } else {
        log.warn(`tRPC ${path}: ${error.code} ${error.message}`)
      }
    }
  })

  async function proxyCountryConfig(
    res: ServerResponse,
    pathAndQuery: string
  ) {
    const response = await countryConfig.get(pathAndQuery)
    res.writeHead(response.status, {
      'content-type': response.contentType ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-opencrvs-desktop-cache': response.source
    })
    res.end(response.body)
  }

  async function handleUpload(req: IncomingMessage, res: ServerResponse) {
    const form = await toWebRequest(req).formData()
    const file = form.get('file')
    const transactionId = String(form.get('transactionId') ?? '')
    const attachmentPath = String(form.get('path') ?? '')

    if (!(file instanceof File) || !/^[A-Za-z0-9-]+$/.test(transactionId)) {
      sendText(res, 400, 'Invalid payload')
      return
    }
    if (attachmentPath && !/^(events|users)\/[A-Za-z0-9-]+\/?$/.test(attachmentPath)) {
      sendText(res, 400, `Invalid path: ${attachmentPath}`)
      return
    }
    const extension = file.name.includes('.') ? file.name.split('.').pop() : ''
    if (!extension || !/^[A-Za-z0-9]{1,8}$/.test(extension)) {
      sendText(res, 400, 'Invalid file extension')
      return
    }
    const filename = `${transactionId}.${extension}`
    const documentPath = attachmentPath
      ? `${attachmentPath.replace(/\/$/, '')}/${filename}`
      : filename

    files.save(documentPath, new Uint8Array(await file.arrayBuffer()))
    log.info(`Saved file ${documentPath} (${file.size} bytes)`)
    sendText(res, 200, documentPath)
  }

  /**
   * The client shows an uploaded file by its path while the upload is still
   * running. Without a service worker that request reaches the backend, so
   * wait a short time for the upload to finish.
   */
  async function serveFile(res: ServerResponse, documentPath: string) {
    const absolute = files.resolve(documentPath)
    if (!absolute) {
      sendText(res, 404, 'Not found')
      return
    }
    for (let i = 0; i < 30 && !fs.existsSync(absolute); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!fs.existsSync(absolute)) {
      sendText(res, 404, 'Not found')
      return
    }
    res.writeHead(200, {
      'content-type': mimeTypeOf(absolute),
      'cache-control': 'private, max-age=3600'
    })
    fs.createReadStream(absolute).pipe(res)
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    const method = req.method ?? 'GET'

    if (env.secret && req.headers[SECRET_HEADER] !== env.secret) {
      sendText(res, 403, 'Forbidden')
      return
    }

    if (pathname === BOOTSTRAP_PATH) {
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store'
      })
      res.end(bootstrapScript(identity.token))
      return
    }

    if (pathname === '/__desktop/token') {
      sendJson(res, 200, { token: identity.token, refreshToken: identity.token })
      return
    }

    if (pathname === CLIENT_LOG_PATH && method === 'POST') {
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        chunks.push(chunk as Buffer)
      }
      try {
        const entry = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          level?: string
          text?: string
          path?: string
        }
        log.warn(`[client ${entry.level}] ${entry.path}: ${entry.text}`)
      } catch {
        // Ignore entries that do not parse.
      }
      res.writeHead(204)
      res.end()
      return
    }

    if (pathname === '/api/ping' || pathname === '/ping' || pathname === '/health/ready') {
      // No X-version header: the client would show the version mismatch modal.
      sendJson(res, 200, { status: 'ok' })
      return
    }

    if (pathname.startsWith('/api/events/')) {
      trpcHandler(req, res)
      return
    }

    if (pathname === '/api/config') {
      sendJson(res, 200, {
        config: await countryConfig.rawApplicationConfig(),
        certificates: []
      })
      return
    }

    if (pathname === '/api/publicConfig') {
      const config = await countryConfig.rawApplicationConfig()
      sendJson(res, 200, {
        config: Object.fromEntries(
          PUBLIC_CONFIG_FIELDS.filter((key) => key in config).map((key) => [
            key,
            config[key]
          ])
        )
      })
      return
    }

    if (pathname === '/api/auth/refreshToken') {
      sendJson(res, 200, { token: identity.token, refreshToken: identity.token })
      return
    }

    if (pathname === '/api/auth/invalidateToken') {
      res.writeHead(200)
      res.end()
      return
    }

    if (pathname === '/api/upload' && method === 'POST') {
      await handleUpload(req, res)
      return
    }

    if (pathname.startsWith('/api/presigned-url/')) {
      const documentPath = decodeURIComponent(
        pathname.slice('/api/presigned-url/'.length)
      )
      sendJson(res, 200, {
        presignedURL: `${originOf(req)}/files/${documentPath}`
      })
      return
    }

    if (pathname.startsWith('/api/countryconfig/')) {
      if (method !== 'GET' && method !== 'HEAD') {
        // Only GET requests go to the country config, so no record data leaves the device.
        sendText(res, 405, 'Only GET requests are sent to the country config')
        return
      }
      const ccPath = pathname.slice('/api/countryconfig'.length)
      if (ccPath === '/certificates') {
        sendJson(res, 200, [])
        return
      }
      if (ccPath.startsWith('/certificates/')) {
        sendText(res, 404, 'Certificates are not available in the desktop app')
        return
      }
      if (ccPath === '/config/users') {
        sendJson(res, 200, [])
        return
      }
      await proxyCountryConfig(res, ccPath + url.search)
      return
    }

    if (UNSUPPORTED_API_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`))) {
      sendJson(res, 404, { message: 'Not available in the desktop app' })
      return
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { message: `Unknown route: ${pathname}` })
      return
    }

    if (pathname === '/manifest.json') {
      await proxyCountryConfig(res, '/static/manifest.json')
      return
    }

    if (pathname.startsWith('/images/')) {
      await proxyCountryConfig(res, `/static${pathname}`)
      return
    }

    if (pathname.startsWith('/files/')) {
      await serveFile(res, decodeURIComponent(pathname.slice("/files/".length)))
      return
    }

    if (DOCUMENT_URL.test(pathname)) {
      await serveFile(res, pathname.slice(1))
      return
    }

    if (pathname === '/login' || pathname.startsWith('/login/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(LOGIN_PAGE)
      return
    }

    if (staticFiles) {
      staticFiles.serve(pathname, res)
      return
    }

    sendText(res, 404, 'Not found')
  }

  return (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now()
    res.on('finish', () =>
      log.debug(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`)
    )
    route(req, res).catch((error: unknown) => {
      if (error instanceof CountryConfigUnavailableError) {
        log.warn(error.message)
        if (!res.headersSent) {
          sendJson(res, 502, { message: error.message })
        }
        return
      }
      log.error(`${req.method} ${req.url} failed`, error)
      if (!res.headersSent) {
        sendJson(res, 500, { message: 'Internal server error' })
      } else {
        res.end()
      }
    })
  }
}
