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
import { DatabaseSync } from 'node:sqlite'
import type {
  AdministrativeArea,
  EventDocument,
  EventIndex,
  Location,
  RemoteDraft
} from '@opencrvs/commons/client'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row for each record. The document column holds the full EventDocument.
-- The search_index column holds the EventIndex (current state). It is NULL
-- while the record is only CREATED, because the events service does not index
-- such records either.
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  tracking_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  document TEXT NOT NULL,
  search_index TEXT,
  UNIQUE (transaction_id, type)
);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  action_type TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  draft TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS drafts_event_id ON drafts (event_id);

CREATE TABLE IF NOT EXISTS country_config_cache (
  path TEXT PRIMARY KEY,
  status INTEGER NOT NULL,
  content_type TEXT,
  etag TEXT,
  last_modified TEXT,
  -- NULL for an empty body: node:sqlite stores an empty buffer as NULL.
  body BLOB,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('location', 'administrativeArea')),
  external_id TEXT,
  document TEXT NOT NULL
);
`

export interface CachedResponse {
  path: string
  status: number
  contentType: string | null
  etag: string | null
  lastModified: string | null
  body: Buffer
  fetchedAt: number
}

export class Store {
  readonly db: DatabaseSync

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true })
    this.db = new DatabaseSync(path.join(dataDir, 'opencrvs.sqlite'))
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(SCHEMA)
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getKv(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key)
    return row ? String(row.value) : undefined
  }

  setKv(key: string, value: string) {
    this.db
      .prepare(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value)
  }

  getEvent(id: string): EventDocument | undefined {
    const row = this.db
      .prepare('SELECT document FROM events WHERE id = ?')
      .get(id)
    return row ? (JSON.parse(String(row.document)) as EventDocument) : undefined
  }

  findEventByTransaction(
    transactionId: string,
    type: string
  ): EventDocument | undefined {
    const row = this.db
      .prepare(
        'SELECT document FROM events WHERE transaction_id = ? AND type = ?'
      )
      .get(transactionId, type)
    return row ? (JSON.parse(String(row.document)) as EventDocument) : undefined
  }

  trackingIdExists(trackingId: string) {
    return !!this.db
      .prepare('SELECT 1 FROM events WHERE tracking_id = ?')
      .get(trackingId)
  }

  insertEvent(event: EventDocument, transactionId: string) {
    this.db
      .prepare(
        'INSERT INTO events (id, type, transaction_id, tracking_id, created_at, document, search_index) VALUES (?, ?, ?, ?, ?, ?, NULL)'
      )
      .run(
        event.id,
        event.type,
        transactionId,
        event.trackingId,
        event.createdAt,
        JSON.stringify(event)
      )
  }

  updateEvent(event: EventDocument, searchIndex: EventIndex | null) {
    this.db
      .prepare(
        'UPDATE events SET document = ?, search_index = ? WHERE id = ?'
      )
      .run(
        JSON.stringify(event),
        searchIndex ? JSON.stringify(searchIndex) : null,
        event.id
      )
  }

  deleteEvent(id: string) {
    this.db.prepare('DELETE FROM drafts WHERE event_id = ?').run(id)
    this.db.prepare('DELETE FROM events WHERE id = ?').run(id)
  }

  listEventDocuments(): EventDocument[] {
    return this.db
      .prepare('SELECT document FROM events')
      .all()
      .map((row) => JSON.parse(String(row.document)) as EventDocument)
  }

  listSearchIndexes(): EventIndex[] {
    return this.db
      .prepare('SELECT search_index FROM events WHERE search_index IS NOT NULL')
      .all()
      .map((row) => JSON.parse(String(row.search_index)) as EventIndex)
  }

  listDraftsByUser(userId: string): RemoteDraft[] {
    return this.db
      .prepare(
        'SELECT draft FROM drafts WHERE created_by = ? ORDER BY created_at ASC'
      )
      .all(userId)
      .map((row) => JSON.parse(String(row.draft)) as RemoteDraft)
  }

  findLatestDraft(
    eventId: string,
    userId: string,
    actionType: string
  ): RemoteDraft | undefined {
    const row = this.db
      .prepare(
        'SELECT draft FROM drafts WHERE event_id = ? AND created_by = ? AND action_type = ? ORDER BY created_at DESC LIMIT 1'
      )
      .get(eventId, userId, actionType)
    return row ? (JSON.parse(String(row.draft)) as RemoteDraft) : undefined
  }

  /** Like the events service, keeps one draft for each event and user. A draft of another action replaces it. */
  replaceDraft(draft: RemoteDraft, userId: string) {
    this.transaction(() => {
      this.db
        .prepare('DELETE FROM drafts WHERE event_id = ? AND created_by = ?')
        .run(draft.eventId, userId)
      this.db
        .prepare(
          'INSERT INTO drafts (id, event_id, created_by, action_type, transaction_id, created_at, draft) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          draft.id,
          draft.eventId,
          userId,
          draft.action.type,
          draft.transactionId,
          draft.createdAt,
          JSON.stringify(draft)
        )
    })
  }

  deleteDraftsByEventId(eventId: string) {
    this.db.prepare('DELETE FROM drafts WHERE event_id = ?').run(eventId)
  }

  getCachedResponse(cachePath: string): CachedResponse | undefined {
    const row = this.db
      .prepare('SELECT * FROM country_config_cache WHERE path = ?')
      .get(cachePath)
    if (!row) {
      return undefined
    }
    return {
      path: String(row.path),
      status: Number(row.status),
      contentType: row.content_type === null ? null : String(row.content_type),
      etag: row.etag === null ? null : String(row.etag),
      lastModified:
        row.last_modified === null ? null : String(row.last_modified),
      body: row.body ? Buffer.from(row.body as Uint8Array) : Buffer.alloc(0),
      fetchedAt: Number(row.fetched_at)
    }
  }

  putCachedResponse(response: CachedResponse) {
    this.db
      .prepare(
        `INSERT INTO country_config_cache (path, status, content_type, etag, last_modified, body, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (path) DO UPDATE SET status = excluded.status, content_type = excluded.content_type,
           etag = excluded.etag, last_modified = excluded.last_modified, body = excluded.body, fetched_at = excluded.fetched_at`
      )
      .run(
        response.path,
        response.status,
        response.contentType,
        response.etag,
        response.lastModified,
        response.body.length > 0 ? response.body : null,
        response.fetchedAt
      )
  }

  touchCachedResponse(cachePath: string, fetchedAt: number) {
    this.db
      .prepare('UPDATE country_config_cache SET fetched_at = ? WHERE path = ?')
      .run(fetchedAt, cachePath)
  }

  replaceLocations(
    administrativeAreas: AdministrativeArea[],
    locations: Location[]
  ) {
    this.transaction(() => {
      this.db.exec('DELETE FROM locations')
      const insert = this.db.prepare(
        'INSERT INTO locations (id, kind, external_id, document) VALUES (?, ?, ?, ?)'
      )
      for (const area of administrativeAreas) {
        insert.run(
          area.id,
          'administrativeArea',
          area.externalId ?? null,
          JSON.stringify(area)
        )
      }
      for (const location of locations) {
        insert.run(
          location.id,
          'location',
          location.externalId ?? null,
          JSON.stringify(location)
        )
      }
    })
  }

  listLocationDocuments(kind: 'location'): Location[]
  listLocationDocuments(kind: 'administrativeArea'): AdministrativeArea[]
  listLocationDocuments(kind: 'location' | 'administrativeArea') {
    return this.db
      .prepare('SELECT document FROM locations WHERE kind = ? ORDER BY rowid')
      .all(kind)
      .map((row) => JSON.parse(String(row.document)))
  }
}
