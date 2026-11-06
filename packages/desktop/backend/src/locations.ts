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
import type {
  AdministrativeArea,
  Location,
  LocationVersion,
  UUID
} from '@opencrvs/commons/client'
import { CountryConfig, RawLocations } from './countryconfig'
import { Store } from './db'
import { log } from './log'

/** Namespace for the UUIDv5 ids of locations. Do not change it: ids must stay stable across devices. */
const LOCATION_NAMESPACE = '6f1e4f5e-2d0a-5c8b-9f3e-0b8a4c1d2e70'

/** The beginning-of-time sentinel that the data seeder also uses. */
const BEGINNING_OF_TIME = '0001-01-01'

export function uuidv5(name: string, namespace = LOCATION_NAMESPACE): UUID {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const hash = createHash('sha1')
    .update(Buffer.concat([ns, Buffer.from(name, 'utf8')]))
    .digest()
  hash[6] = (hash[6] & 0x0f) | 0x50
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join('-') as UUID
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

function buildVersions(
  id: UUID,
  raw: RawLocations['locations'][number]
): LocationVersion[] {
  const rawVersions = raw.versions ?? [
    { name: raw.name, externalId: raw.id, status: 'active' as const }
  ]
  return rawVersions.map((version, index) => ({
    versionId: uuidv5(`${id}:version:${index}`),
    effectiveFrom: version.effectiveFrom || BEGINNING_OF_TIME,
    name: version.name,
    externalId: version.externalId ?? raw.id,
    status: version.status
  }))
}

/** The version in effect today, or the first version if none is in effect yet. */
function currentVersion(versions: LocationVersion[]) {
  const date = today()
  const inEffect = versions
    .filter((v) => v.effectiveFrom <= date)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
  return inEffect[inEffect.length - 1] ?? versions[0]
}

/**
 * Converts the country config's `/config/locations` to the shapes of the
 * events service. Ids are UUIDv5 values of (country, country config id), so
 * every device gets the same ids.
 */
export function buildLocations(country: string, raw: RawLocations) {
  const idOf = (externalId: string) => uuidv5(`${country}:${externalId}`)
  const areaIds = new Set(raw.administrativeAreas.map((a) => a.id))
  const parentOf = (partOf: string) => {
    const parent = partOf.split('/')[1]
    return parent && areaIds.has(parent) ? idOf(parent) : null
  }

  const administrativeAreas: AdministrativeArea[] = raw.administrativeAreas.map(
    (area) => {
      const id = idOf(area.id)
      const versions = buildVersions(id, area)
      const current = currentVersion(versions)
      return {
        id,
        name: current.name,
        externalId: area.id,
        parentId: parentOf(area.partOf),
        status: current.status,
        versions
      }
    }
  )

  const locations: Location[] = raw.locations.map((location) => {
    const id = idOf(location.id)
    const versions = buildVersions(id, location)
    const current = currentVersion(versions)
    return {
      id,
      name: current.name,
      externalId: location.id,
      administrativeAreaId: parentOf(location.partOf),
      locationType: location.locationType ?? null,
      status: current.status,
      versions
    }
  })

  return { administrativeAreas, locations }
}

export class Locations {
  private administrativeAreas: AdministrativeArea[] = []
  private locations: Location[] = []
  private areaById = new Map<string, AdministrativeArea>()
  private locationById = new Map<string, Location>()
  private hierarchyCache = new Map<string, UUID[]>()

  constructor(private readonly store: Store) {
    this.load()
  }

  private load() {
    this.administrativeAreas = this.store.listLocationDocuments(
      'administrativeArea'
    )
    this.locations = this.store.listLocationDocuments('location')
    this.areaById = new Map(this.administrativeAreas.map((a) => [a.id, a]))
    this.locationById = new Map(this.locations.map((l) => [l.id, l]))
    this.hierarchyCache.clear()
  }

  /** Reads the locations from the country config. Keeps the stored ones if the country config is not reachable. */
  async refresh(countryConfig: CountryConfig) {
    try {
      const [raw, country] = await Promise.all([
        countryConfig.rawLocations(),
        countryConfig.countryCode()
      ])
      const built = buildLocations(country, raw)
      this.store.replaceLocations(built.administrativeAreas, built.locations)
      this.load()
      log.info(
        `Loaded ${built.locations.length} locations and ${built.administrativeAreas.length} administrative areas`
      )
    } catch (error) {
      if (this.locations.length === 0) {
        throw error
      }
      log.warn(`Using stored locations: ${String(error)}`)
    }
  }

  listLocations(filter?: {
    isActive?: boolean
    locationIds?: string[]
    locationType?: string
    externalId?: string
  }): Location[] {
    return this.locations.filter(
      (l) =>
        (filter?.isActive === undefined ||
          (l.status === 'active') === filter.isActive) &&
        (!filter?.locationIds || filter.locationIds.includes(l.id)) &&
        (!filter?.locationType || l.locationType === filter.locationType) &&
        (!filter?.externalId || l.externalId === filter.externalId)
    )
  }

  listAdministrativeAreas(filter?: {
    isActive?: boolean
    ids?: string[]
  }): AdministrativeArea[] {
    return this.administrativeAreas.filter(
      (a) =>
        (filter?.isActive === undefined ||
          (a.status === 'active') === filter.isActive) &&
        (!filter?.ids || filter.ids.includes(a.id))
    )
  }

  getLocation(id: string): Location | undefined {
    return this.locationById.get(id)
  }

  getAdministrativeArea(id: string): AdministrativeArea | undefined {
    return this.areaById.get(id)
  }

  /**
   * Same result as the events service: the administrative areas from the top
   * down, then the id itself. Works for locations and administrative areas.
   */
  hierarchy(id: string): UUID[] {
    const cached = this.hierarchyCache.get(id)
    if (cached) {
      return cached
    }
    const chain: UUID[] = []
    let parent: string | null | undefined
    const location = this.locationById.get(id)
    if (location) {
      chain.push(location.id)
      parent = location.administrativeAreaId
    } else {
      const area = this.areaById.get(id)
      if (!area) {
        return []
      }
      chain.push(area.id)
      parent = area.parentId
    }
    const seen = new Set<string>(chain)
    while (parent && !seen.has(parent)) {
      const area = this.areaById.get(parent)
      if (!area) {
        break
      }
      chain.unshift(area.id)
      seen.add(area.id)
      parent = area.parentId
    }
    this.hierarchyCache.set(id, chain)
    return chain
  }

  /** The first active CRVS office that belongs to an administrative area. */
  defaultOffice(): Location | undefined {
    const offices = this.locations.filter(
      (l) => l.locationType === 'CRVS_OFFICE' && l.status === 'active'
    )
    return offices.find((l) => l.administrativeAreaId) ?? offices[0]
  }
}
