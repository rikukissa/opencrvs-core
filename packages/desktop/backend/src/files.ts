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
import path from 'node:path'

export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm'
}

export function mimeTypeOf(filePath: string) {
  return (
    MIME_TYPES[path.extname(filePath).toLowerCase()] ??
    'application/octet-stream'
  )
}

/**
 * Document paths as the documents service uses them:
 * `events/{eventId}/{file}`, `users/{userId}/{file}` or a bare `{uuid}.{ext}`.
 */
const DOCUMENT_PATH = /^(?:(?:events|users)\/[A-Za-z0-9-]+\/)?[A-Za-z0-9._-]+$/

export class FileStore {
  readonly root: string

  constructor(dataDir: string) {
    this.root = path.join(dataDir, 'files')
    fs.mkdirSync(this.root, { recursive: true })
  }

  /** Returns the absolute path on disk, or `undefined` if the document path is not valid. */
  resolve(documentPath: string): string | undefined {
    const relative = documentPath.replace(/^\/+/, '')
    if (!DOCUMENT_PATH.test(relative) || relative.split('/').includes('..')) {
      return undefined
    }
    const absolute = path.join(this.root, ...relative.split('/'))
    if (!absolute.startsWith(this.root + path.sep)) {
      return undefined
    }
    return absolute
  }

  exists(documentPath: string) {
    const absolute = this.resolve(documentPath)
    return !!absolute && fs.existsSync(absolute)
  }

  save(documentPath: string, data: Uint8Array) {
    const absolute = this.resolve(documentPath)
    if (!absolute) {
      throw new Error(`Invalid document path: ${documentPath}`)
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, data)
  }

  /** Deletes every file of a record, like `deleteFilesByPrefix` in the events service. */
  deleteEventFiles(eventId: string) {
    if (!/^[A-Za-z0-9-]+$/.test(eventId)) {
      return
    }
    fs.rmSync(path.join(this.root, 'events', eventId), {
      recursive: true,
      force: true
    })
  }
}
