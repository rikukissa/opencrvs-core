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
import {
  AddressType,
  EventConfig,
  EventIndex,
  FieldConfig,
  FieldType,
  getAllUniqueFields,
  QueryExpression,
  QueryType,
  SearchQuery,
  timePeriodToDateRange
} from '@opencrvs/commons/client'
import { log } from './log'

/**
 * Evaluates `QueryType` over EventIndex documents in memory. It follows the
 * Elasticsearch query that `packages/events/src/service/indexing/query.ts`
 * builds:
 *
 * - Location fields match if the location or any of its parent areas is the
 *   search term. Elasticsearch stores the whole hierarchy, so `exact` and
 *   `within` behave the same.
 * - NAME fields and text fields use `match` semantics: the value matches if
 *   any search word matches any word of the value. `fuzzy` allows the edit
 *   distance of `fuzziness: AUTO`.
 * - Keyword fields need the whole value to match.
 * - A date without time covers the whole day.
 *
 * A match returns a score (higher is better) and no match returns null.
 */

export interface SearchContext {
  configs: EventConfig[]
  /** Administrative areas from the top down, then the id itself. */
  hierarchy: (id: string) => string[]
}

type Score = number | null

const TEXT_FIELD_TYPES = new Set<string>([
  FieldType.TEXTAREA,
  FieldType.PARAGRAPH,
  FieldType.HEADING,
  FieldType.BULLET_LIST,
  FieldType.PAGE_HEADER,
  FieldType.TIME,
  FieldType.DATE_RANGE,
  FieldType.ALPHA_HIDDEN
])

const LOCATION_FIELD_TYPES = new Set<string>([
  FieldType.LOCATION,
  FieldType.ADMINISTRATIVE_AREA,
  FieldType.FACILITY,
  FieldType.OFFICE
])

const fieldsByConfigs = new WeakMap<EventConfig[], Map<string, FieldConfig>>()

function fieldMap(configs: EventConfig[]) {
  let map = fieldsByConfigs.get(configs)
  if (!map) {
    map = new Map()
    for (const config of configs) {
      for (const field of getAllUniqueFields(config)) {
        if (!map.has(field.id)) {
          map.set(field.id, field)
        }
      }
    }
    fieldsByConfigs.set(configs, map)
  }
  return map
}

function getPath(value: unknown, path: string): unknown {
  let current = value
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** Like the `classic` analyzer: lower case words, split on anything that is not a letter or digit. */
export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) {
    return max + 1
  }
  let beforePrevious: number[] = []
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let distance = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      )
      // A swap of two letters counts as one edit, as in Elasticsearch.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        distance = Math.min(distance, beforePrevious[j - 2] + 1)
      }
      current[j] = distance
      rowMin = Math.min(rowMin, distance)
    }
    if (rowMin > max) {
      return max + 1
    }
    beforePrevious = previous
    previous = current
  }
  return previous[b.length]
}

/** `fuzziness: AUTO`: 0 edits for 1-2 characters, 1 edit for 3-5, 2 edits for more. */
function autoFuzziness(term: string) {
  if (term.length <= 2) {
    return 0
  }
  return term.length <= 5 ? 1 : 2
}

function tokenMatches(queryToken: string, valueToken: string, fuzzy: boolean) {
  if (queryToken === valueToken) {
    return true
  }
  if (!fuzzy) {
    return false
  }
  const max = autoFuzziness(queryToken)
  return max > 0 && editDistance(queryToken, valueToken, max) <= max
}

/** `match` query: the score is the number of search words that match a word of the value. */
function matchWords(valueText: string, term: string, fuzzy: boolean): Score {
  const valueTokens = tokenize(valueText)
  const score = tokenize(term).filter((q) =>
    valueTokens.some((v) => tokenMatches(q, v, fuzzy))
  ).length
  return score > 0 ? score : null
}

/** `match` on a keyword field: the whole value must match. */
function matchKeyword(value: unknown, term: string, fuzzy: boolean): Score {
  const values = Array.isArray(value) ? value : [value]
  return values.some((v) => {
    if (v === null || v === undefined || typeof v === 'object') {
      return false
    }
    const text = String(v).toLowerCase()
    const query = term.toLowerCase()
    if (text === query) {
      return true
    }
    if (!fuzzy) {
      return false
    }
    const max = autoFuzziness(query)
    return max > 0 && editDistance(query, text, max) <= max
  })
    ? 1
    : null
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/** Start and end (in ms) of the time that a date or date-time covers. A date covers the whole local day. */
function dateBounds(value: string): [number, number] | undefined {
  if (DATE_ONLY.test(value)) {
    const [y, m, d] = value.split('-').map(Number)
    const start = new Date(y, m - 1, d).getTime()
    return [start, new Date(y, m - 1, d + 1).getTime() - 1]
  }
  const time = Date.parse(value)
  return Number.isNaN(time) ? undefined : [time, time]
}

function inRange(
  value: unknown,
  gte: string | undefined,
  lte: string | undefined
): boolean {
  if (typeof value === 'number') {
    return (
      (gte === undefined || value >= Number(gte)) &&
      (lte === undefined || value <= Number(lte))
    )
  }
  if (typeof value !== 'string') {
    return false
  }
  const valueBounds = dateBounds(value)
  if (!valueBounds) {
    return (
      (gte === undefined || value >= gte) && (lte === undefined || value <= lte)
    )
  }
  const lower = gte === undefined ? undefined : dateBounds(gte)?.[0]
  const upper = lte === undefined ? undefined : dateBounds(lte)?.[1]
  return (
    (lower === undefined || valueBounds[0] >= lower) &&
    (upper === undefined || valueBounds[0] <= upper)
  )
}

type DateCondition = NonNullable<QueryExpression['createdAt']>

function matchDate(value: unknown, condition: DateCondition): Score {
  if (typeof value !== 'string') {
    return null
  }
  if (condition.type === 'exact') {
    return inRange(value, condition.term, condition.term) ? 1 : null
  }
  if (condition.type === 'range') {
    return inRange(value, condition.gte, condition.lte) ? 1 : null
  }
  const { startDate, endDate } = timePeriodToDateRange(condition.term)
  return inRange(value, startDate, endDate) ? 1 : null
}

function withinLocation(
  value: unknown,
  locationId: string,
  ctx: SearchContext
): Score {
  if (typeof value !== 'string') {
    return null
  }
  return ctx.hierarchy(value).includes(locationId) ? 1 : null
}

type BaseInput =
  | { type: 'fuzzy'; term: string }
  | { type: 'exact'; term: string }
  | { type: 'range'; gte: string; lte: string }
  | { type: 'within'; location: string }
  | { type: 'anyOf'; terms: string[] }

function isBaseInput(value: unknown): value is BaseInput {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'string'
  )
}

function nameText(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  return Object.values(value)
    .filter((v) => typeof v === 'string')
    .join(' ')
}

function matchAddress(
  value: unknown,
  search: BaseInput,
  ctx: SearchContext
): Score {
  if (search.type !== 'exact' && search.type !== 'fuzzy') {
    return 1
  }
  let term: Record<string, unknown>
  try {
    term = JSON.parse(search.term)
  } catch {
    return 1
  }
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const address = value as Record<string, unknown>
  let score = 0
  if (term.country) {
    if (address.country !== term.country) {
      return null
    }
    score++
  }
  if (term.addressType === AddressType.DOMESTIC && term.administrativeArea) {
    if (
      !withinLocation(address.administrativeArea, String(term.administrativeArea), ctx)
    ) {
      return null
    }
    score++
  }
  const details = term.streetLevelDetails
  if (details && typeof details === 'object') {
    for (const [key, detail] of Object.entries(details)) {
      if (detail === undefined || detail === null || detail === '') {
        continue
      }
      const stored = getPath(address, `streetLevelDetails.${key}`)
      if (typeof stored !== 'string') {
        return null
      }
      const s = matchWords(stored, String(detail), false)
      if (s === null) {
        return null
      }
      score += s
    }
  }
  return score
}

function matchField(
  field: FieldConfig | undefined,
  value: unknown,
  search: BaseInput,
  ctx: SearchContext
): Score {
  if (value === undefined || value === null) {
    return null
  }

  if (field?.type === FieldType.ADDRESS) {
    return matchAddress(value, search, ctx)
  }

  if (field?.type === FieldType.NAME) {
    const text = nameText(value)
    if (!text || (search.type !== 'exact' && search.type !== 'fuzzy')) {
      return null
    }
    return matchWords(text, search.term, search.type === 'fuzzy')
  }

  if (field && LOCATION_FIELD_TYPES.has(field.type)) {
    if (search.type === 'exact') {
      return withinLocation(value, search.term, ctx)
    }
    if (search.type === 'within') {
      return withinLocation(value, search.location, ctx)
    }
  }

  switch (search.type) {
    case 'exact':
    case 'fuzzy': {
      const fuzzy = search.type === 'fuzzy'
      if (field && TEXT_FIELD_TYPES.has(field.type) && typeof value === 'string') {
        return matchWords(value, search.term, fuzzy)
      }
      if (typeof value === 'object' && !Array.isArray(value)) {
        // Objects such as AUTOCOMPLETE values: match any of their properties.
        return Object.values(value).some(
          (v) => matchKeyword(v, search.term, fuzzy) !== null
        )
          ? 1
          : null
      }
      return matchKeyword(value, search.term, fuzzy)
    }
    case 'anyOf': {
      const values = Array.isArray(value) ? value : [value]
      return values.some((v) => search.terms.includes(String(v))) ? 1 : null
    }
    case 'range':
      return inRange(value, search.gte, search.lte) ? 1 : null
    case 'within':
      return withinLocation(value, search.location, ctx)
  }
  return null
}

function matchData(
  index: EventIndex,
  data: Record<string, unknown>,
  ctx: SearchContext,
  prefix = ''
): Score {
  const fields = fieldMap(ctx.configs)
  let score = 0
  for (const [key, search] of Object.entries(data)) {
    const fieldId = prefix ? `${prefix}.${key}` : key
    let s: Score
    if (isBaseInput(search)) {
      const field = fields.get(fieldId)
      if (!field) {
        log.warn(`Search field ${fieldId} is not in any event configuration`)
        return null
      }
      s = matchField(field, index.declaration[fieldId], search, ctx)
    } else if (typeof search === 'object' && search !== null) {
      s = matchData(index, search as Record<string, unknown>, ctx, fieldId)
    } else {
      s = null
    }
    if (s === null) {
      return null
    }
    score += s
  }
  return score
}

function matchClause(
  index: EventIndex,
  clause: QueryExpression,
  ctx: SearchContext
): Score {
  let score = 0
  for (const [key, condition] of Object.entries(clause)) {
    if (!condition) {
      continue
    }
    let s: Score = null
    switch (key) {
      case 'id':
        s = index.id === condition ? 1 : null
        break
      case 'eventType':
        s = index.type === condition ? 1 : null
        break
      case 'status': {
        const c = condition as NonNullable<QueryExpression['status']>
        if (c.type === 'anyOf') {
          s = c.terms.includes(index.status) ? 1 : null
        } else if (c.type === 'noneOf') {
          s = c.terms.includes(index.status) ? null : 1
        } else {
          s = index.status === c.term ? 1 : null
        }
        break
      }
      case 'trackingId':
      case 'legalStatuses.REGISTERED.registrationNumber': {
        // Users type these by hand, so the case does not matter.
        const value = getPath(index, key)
        const term = (condition as { term: string }).term
        s =
          typeof value === 'string' &&
          value.toLowerCase() === term.trim().toLowerCase()
            ? 1
            : null
        break
      }
      case 'assignedTo':
      case 'createdBy':
      case 'updatedBy':
      case 'updatedByUserRole':
      case 'createdByUserType':
        s = getPath(index, key) === (condition as { term: string }).term ? 1 : null
        break
      case 'createdAt':
      case 'updatedAt':
      case 'legalStatuses.REGISTERED.acceptedAt':
        s = matchDate(getPath(index, key), condition as DateCondition)
        break
      case 'createdAtLocation':
      case 'updatedAtLocation':
      case 'legalStatuses.DECLARED.createdAtLocation':
      case 'legalStatuses.REGISTERED.createdAtLocation':
      case 'legalStatuses.REVOKED.createdAtLocation': {
        const c = condition as { type: string; term?: string; location?: string }
        s = withinLocation(
          getPath(index, key),
          (c.type === 'exact' ? c.term : c.location) ?? '',
          ctx
        )
        break
      }
      case 'legalStatuses.DECLARED.createdByRole':
      case 'legalStatuses.REGISTERED.createdByRole': {
        const value = getPath(index, key)
        s = (condition as { terms: string[] }).terms.includes(String(value))
          ? 1
          : null
        break
      }
      case 'flags': {
        const c = condition as NonNullable<QueryExpression['flags']>
        const flags: string[] = index.flags ?? []
        const ok =
          (!c.anyOf || c.anyOf.some((f) => flags.includes(f))) &&
          (!c.noneOf || !c.noneOf.some((f) => flags.includes(f))) &&
          (!c.allOf || c.allOf.every((f) => flags.includes(f)))
        s = ok ? 1 : null
        break
      }
      case 'data':
        s = matchData(index, condition as Record<string, unknown>, ctx)
        break
      default:
        throw new Error(`Unsupported query field: ${key}`)
    }
    if (s === null) {
      return null
    }
    score += s
  }
  return score
}

export function matchQuery(
  index: EventIndex,
  query: QueryType,
  ctx: SearchContext
): Score {
  const scores = query.clauses.map((clause) =>
    'clauses' in clause
      ? matchQuery(index, clause as QueryType, ctx)
      : matchClause(index, clause as QueryExpression, ctx)
  )
  if (query.type === 'and') {
    return scores.some((s) => s === null)
      ? null
      : scores.reduce<number>((sum, s) => sum + (s ?? 0), 0)
  }
  const matched = scores.filter((s): s is number => s !== null)
  return matched.length > 0 ? matched.reduce((sum, s) => sum + s, 0) : null
}

function compareValues(a: unknown, b: unknown) {
  if (a === b) {
    return 0
  }
  if (a === undefined || a === null) {
    return 1
  }
  if (b === undefined || b === null) {
    return -1
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b
  }
  return String(a).localeCompare(String(b))
}

export function search(
  indexes: EventIndex[],
  input: SearchQuery,
  ctx: SearchContext
): { results: EventIndex[]; total: number } {
  const matches: { index: EventIndex; score: number }[] = []
  for (const index of indexes) {
    const score = matchQuery(index, input.query, ctx)
    if (score !== null) {
      matches.push({ index, score })
    }
  }

  if (input.sort && input.sort.length > 0) {
    const sort = input.sort
    matches.sort((a, b) => {
      for (const { field, direction } of sort) {
        const result = compareValues(getPath(a.index, field), getPath(b.index, field))
        if (result !== 0) {
          return direction === 'desc' ? -result : result
        }
      }
      return 0
    })
  } else {
    matches.sort(
      (a, b) =>
        b.score - a.score || b.index.updatedAt.localeCompare(a.index.updatedAt)
    )
  }

  const offset = input.offset ?? 0
  const limit = input.limit ?? 100
  return {
    results: matches.slice(offset, offset + limit).map((m) => m.index),
    total: matches.length
  }
}

export function count(
  indexes: EventIndex[],
  query: QueryType,
  ctx: SearchContext
): number {
  return indexes.filter((index) => matchQuery(index, query, ctx) !== null).length
}
