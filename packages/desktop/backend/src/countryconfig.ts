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
import { createHash } from 'node:crypto'
import * as z from 'zod/v4'
import {
  ApplicationConfig,
  EventConfig,
  resolveEventConfig,
  Role,
  VersionedEventConfig,
  WorkqueueConfig
} from '@opencrvs/commons/client'
import { CachedResponse, Store } from './db'
import { log } from './log'

const REQUEST_TIMEOUT_MS = 10_000
/** The backend's own reads of the config reuse a cached copy for this long. */
const CONFIG_MAX_AGE_MS = 5 * 60_000

export type CountryConfigResponse = CachedResponse & {
  source: 'network' | 'cache' | 'offline'
}

export class CountryConfigUnavailableError extends Error {}

/**
 * Reads the country config with GET requests only.
 *
 * - The request never carries credentials or record data.
 * - Successful responses are stored in SQLite. The cache uses ETag and
 *   Last-Modified when the server sends them.
 * - If the network is not available, the cached response is used.
 */
export class CountryConfig {
  private inFlight = new Map<string, Promise<CountryConfigResponse>>()
  private parsed = new Map<string, { hash: string; value: unknown }>()

  constructor(
    private readonly store: Store,
    readonly baseUrl: string
  ) {}

  get(pathAndQuery: string, maxAgeMs = 0): Promise<CountryConfigResponse> {
    const key = `${pathAndQuery}|${maxAgeMs}`
    const existing = this.inFlight.get(key)
    if (existing) {
      return existing
    }
    const promise = this.fetchWithCache(pathAndQuery, maxAgeMs).finally(() =>
      this.inFlight.delete(key)
    )
    this.inFlight.set(key, promise)
    return promise
  }

  private async fetchWithCache(
    pathAndQuery: string,
    maxAgeMs: number
  ): Promise<CountryConfigResponse> {
    const cached = this.store.getCachedResponse(pathAndQuery)
    const now = Date.now()

    if (cached && maxAgeMs > 0) {
      if (now - cached.fetchedAt >= maxAgeMs) {
        // Use the cached copy now and refresh it in the background, so a slow
        // or missing network does not delay the backend.
        void this.get(pathAndQuery, 0).catch((error) =>
          log.warn(`Could not refresh ${pathAndQuery}: ${String(error)}`)
        )
      }
      return { ...cached, source: 'cache' }
    }

    const headers: Record<string, string> = { accept: '*/*' }
    if (cached?.etag) {
      headers['if-none-match'] = cached.etag
    }
    if (cached?.lastModified) {
      headers['if-modified-since'] = cached.lastModified
    }

    let res: Response
    try {
      res = await fetch(this.baseUrl + pathAndQuery, {
        method: 'GET',
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch (error) {
      if (cached) {
        log.warn(
          `Country config not reachable, using cached ${pathAndQuery}: ${String(error)}`
        )
        return { ...cached, source: 'offline' }
      }
      throw new CountryConfigUnavailableError(
        `Country config not reachable and ${pathAndQuery} is not cached: ${String(error)}`
      )
    }

    if (res.status === 304 && cached) {
      this.store.touchCachedResponse(pathAndQuery, now)
      return { ...cached, fetchedAt: now, source: 'cache' }
    }

    if (res.status >= 500 && cached) {
      log.warn(
        `Country config returned ${res.status} for ${pathAndQuery}, using cached copy`
      )
      return { ...cached, source: 'offline' }
    }

    const response: CachedResponse = {
      path: pathAndQuery,
      status: res.status,
      contentType: res.headers.get('content-type'),
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
      body: Buffer.from(await res.arrayBuffer()),
      fetchedAt: now
    }

    if (res.status >= 200 && res.status < 300 && res.status !== 206) {
      this.store.putCachedResponse(response)
    }

    return { ...response, source: 'network' }
  }

  /** Reads and parses a JSON config. Parsing is done again only when the body changes. */
  private async getParsed<T>(
    pathAndQuery: string,
    parse: (json: unknown) => T
  ): Promise<T> {
    const response = await this.get(pathAndQuery, CONFIG_MAX_AGE_MS)
    if (response.status !== 200) {
      throw new CountryConfigUnavailableError(
        `Country config returned ${response.status} for ${pathAndQuery}`
      )
    }
    const hash = createHash('sha1').update(response.body).digest('hex')
    const memo = this.parsed.get(pathAndQuery)
    if (memo?.hash === hash) {
      return memo.value as T
    }
    const value = parse(JSON.parse(response.body.toString('utf8')))
    this.parsed.set(pathAndQuery, { hash, value })
    return value
  }

  versionedEventConfigs(): Promise<VersionedEventConfig[]> {
    return this.getParsed('/config/events', (json) =>
      z.array(VersionedEventConfig).parse(json)
    )
  }

  async eventConfigs(): Promise<EventConfig[]> {
    const versioned = await this.versionedEventConfigs()
    const memo = this.resolvedConfigs.get(versioned)
    if (memo) {
      return memo
    }
    const resolved = versioned.map(resolveEventConfig)
    this.resolvedConfigs.set(versioned, resolved)
    return resolved
  }

  private resolvedConfigs = new WeakMap<VersionedEventConfig[], EventConfig[]>()

  async eventConfig(eventType: string): Promise<EventConfig> {
    const config = (await this.eventConfigs()).find((c) => c.id === eventType)
    if (!config) {
      throw new Error(`No configuration found for event type: ${eventType}`)
    }
    return config
  }

  workqueues(): Promise<WorkqueueConfig[]> {
    return this.getParsed('/config/workqueues', (json) =>
      z.array(WorkqueueConfig).parse(json)
    )
  }

  roles(): Promise<Role[]> {
    return this.getParsed('/config/roles', (json) => z.array(Role).parse(json))
  }

  applicationConfig(): Promise<ApplicationConfig> {
    return this.getParsed('/config/application', (json) =>
      ApplicationConfig.parse(json)
    )
  }

  /** The raw application config, with the fields that the gateway passes on to the client. */
  rawApplicationConfig(): Promise<Record<string, unknown>> {
    return this.getParsed(
      '/config/application',
      (json) => json as Record<string, unknown>
    )
  }

  rawLocations(): Promise<RawLocations> {
    return this.getParsed('/config/locations', (json) =>
      RawLocations.parse(json)
    )
  }

  /** The country code from `client-config.js`, e.g. `FAR`. */
  async countryCode(): Promise<string> {
    try {
      const response = await this.get('/client-config.js', CONFIG_MAX_AGE_MS)
      const match = /"COUNTRY"\s*:\s*"([^"]+)"/.exec(
        response.body.toString('utf8')
      )
      if (match) {
        return match[1]
      }
    } catch (error) {
      log.warn(`Could not read the country code: ${String(error)}`)
    }
    return new URL(this.baseUrl).hostname
  }
}

const RawLocationVersion = z.object({
  effectiveFrom: z.string().optional(),
  name: z.string(),
  externalId: z.string().optional(),
  status: z.enum(['active', 'inactive'])
})

const RawLocation = z.object({
  id: z.string(),
  name: z.string(),
  partOf: z.string(),
  locationType: z.string().optional(),
  versions: z.array(RawLocationVersion).optional()
})

export const RawLocations = z.object({
  administrativeAreas: z.array(RawLocation),
  locations: z.array(RawLocation)
})
export type RawLocations = z.infer<typeof RawLocations>
