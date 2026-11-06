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
import { describe, expect, it } from 'vitest'
import {
  EventIndex,
  QueryType,
  tennisClubMembershipEvent
} from '@opencrvs/commons/client'
import { count, search, SearchContext, tokenize } from '../src/search'

const PROVINCE = '0b8c2a5e-0000-4000-8000-000000000001'
const DISTRICT = '0b8c2a5e-0000-4000-8000-000000000002'
const OFFICE = '0b8c2a5e-0000-4000-8000-000000000003'
const OTHER_OFFICE = '0b8c2a5e-0000-4000-8000-000000000004'

const HIERARCHY: Record<string, string[]> = {
  [OFFICE]: [PROVINCE, DISTRICT, OFFICE],
  [DISTRICT]: [PROVINCE, DISTRICT],
  [OTHER_OFFICE]: [OTHER_OFFICE]
}

const ctx: SearchContext = {
  configs: [tennisClubMembershipEvent],
  hierarchy: (id) => HIERARCHY[id] ?? [id]
}

const EVENT_TYPE = tennisClubMembershipEvent.id

function record(id: string, overrides: Record<string, unknown> = {}): EventIndex {
  return {
    id,
    type: EVENT_TYPE,
    status: 'DECLARED',
    legalStatuses: {},
    createdAt: '2026-10-01T10:00:00.000Z',
    createdBy: 'user-1',
    createdAtLocation: OFFICE,
    updatedAt: '2026-10-02T10:00:00.000Z',
    trackingId: `T${id}`,
    flags: [],
    potentialDuplicates: [],
    declaration: {
      'applicant.name': { firstname: 'Amara', surname: 'Banda' },
      'applicant.email': 'amara@example.com'
    },
    ...overrides
  } as unknown as EventIndex
}

function query(...clauses: QueryType['clauses']): QueryType {
  return { type: 'and', clauses } as QueryType
}

const amara = record('1')
const john = record('2', {
  status: 'REGISTERED',
  createdAtLocation: OTHER_OFFICE,
  updatedAt: '2026-10-05T10:00:00.000Z',
  flags: ['validated'],
  declaration: {
    'applicant.name': { firstname: 'John', surname: 'Phiri' },
    'applicant.email': 'john@example.com'
  }
})
const indexes = [amara, john]

function ids(q: QueryType) {
  return search(indexes, { query: q, limit: 100, offset: 0 }, ctx).results.map(
    (r) => r.id
  )
}

describe('tokenize', () => {
  it('splits and lower-cases like the classic analyzer', () => {
    expect(tokenize('Amara-Grace  BANDA')).toEqual(['amara', 'grace', 'banda'])
  })
})

describe('search', () => {
  it('matches a name with a typo when the search is fuzzy', () => {
    expect(
      ids(
        query({
          eventType: EVENT_TYPE,
          data: { 'applicant.name': { type: 'fuzzy', term: 'Amra' } }
        })
      )
    ).toEqual(['1'])
  })

  it('does not accept a typo when the search is exact', () => {
    expect(
      ids(query({ data: { 'applicant.name': { type: 'exact', term: 'Amra' } } }))
    ).toEqual([])
  })

  it('matches a tracking ID without regard to case', () => {
    expect(ids(query({ trackingId: { type: 'exact', term: 't2' } }))).toEqual([
      '2'
    ])
  })

  it('filters by status', () => {
    expect(
      ids(query({ status: { type: 'anyOf', terms: ['REGISTERED'] } }))
    ).toEqual(['2'])
    expect(
      ids(query({ status: { type: 'noneOf', terms: ['REGISTERED'] } }))
    ).toEqual(['1'])
  })

  it('matches locations that are within an administrative area', () => {
    expect(
      ids(query({ createdAtLocation: { type: 'within', location: PROVINCE } }))
    ).toEqual(['1'])
  })

  it('treats a date without time as the whole day', () => {
    expect(
      ids(
        query({
          updatedAt: { type: 'range', gte: '2026-10-05', lte: '2026-10-05' }
        })
      )
    ).toEqual(['2'])
  })

  it('filters by flags', () => {
    expect(ids(query({ flags: { anyOf: ['validated'] } }))).toEqual(['2'])
    expect(ids(query({ flags: { noneOf: ['validated'] } }))).toEqual(['1'])
  })

  it('needs one clause of an "or" query to match', () => {
    const quickSearch = {
      type: 'or',
      clauses: [
        { data: { 'applicant.name': { type: 'fuzzy', term: 'phiri' } } },
        { trackingId: { type: 'exact', term: 'phiri' } }
      ]
    } as QueryType
    expect(ids(quickSearch)).toEqual(['2'])
  })

  it('sorts by the latest update when the scores are equal, and pages the results', () => {
    const q = query({ eventType: EVENT_TYPE })
    expect(ids(q)).toEqual(['2', '1'])
    const page = search(indexes, { query: q, limit: 1, offset: 1 }, ctx)
    expect(page.results.map((r) => r.id)).toEqual(['1'])
    expect(page.total).toBe(2)
  })

  it('counts the records of a workqueue', () => {
    expect(
      count(indexes, query({ status: { type: 'exact', term: 'DECLARED' } }), ctx)
    ).toBe(1)
  })
})
