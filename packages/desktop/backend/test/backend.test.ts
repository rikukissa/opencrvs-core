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
/**
 * Starts the backend against a fake country config on localhost and walks a
 * record through the client's API: create, upload, declare, register, search.
 */
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import superjson from 'superjson'
import {
  ActionType,
  getCurrentEventState,
  getUUID,
  tennisClubMembershipEvent,
  toVersionedEventConfig
} from '@opencrvs/commons/client'
import { RunningBackend, startBackend } from '../src/app'
import type { DesktopRouter } from '../src/trpc/router'

const COUNTRY_CONFIG: Record<string, unknown> = {
  '/config/events': [toVersionedEventConfig(tennisClubMembershipEvent)],
  '/config/workqueues': [],
  '/config/roles': [
    {
      id: 'FIELD_AGENT',
      scopes: ['type=record.create', 'type=record.notify', 'type=record.read']
    },
    {
      id: 'NATIONAL_REGISTRAR',
      scopes: [
        'type=record.create&placeOfEvent=location',
        'type=record.declare',
        'type=record.register',
        'type=record.read',
        'type=record.search',
        'type=record.print-certified-copies',
        'type=workqueue&ids=assigned-to-you,recent',
        'type=workqueue&ids=ready-to-print',
        'type=record.custom-action&event[]=birth&customActionTypes=VALIDATE_DECLARATION'
      ]
    }
  ],
  '/config/locations': {
    administrativeAreas: [{ id: 'central', name: 'Central', partOf: 'Location/0' }],
    locations: [
      { id: 'hq', name: 'HQ Office', partOf: 'Location/0', locationType: 'CRVS_OFFICE' },
      { id: 'office', name: 'Central Office', partOf: 'Location/central', locationType: 'CRVS_OFFICE' }
    ]
  },
  '/config/application': { APPLICATION_NAME: 'Testland' },
  '/client-config.js': 'window.config = {"COUNTRY":"TST"}',
  '/content/client': { languages: [] },
  '/static/manifest.json': { name: 'Testland' }
}

const SECRET = 'test-secret'
let fakeCountryConfig: http.Server
let backend: RunningBackend
let dataDir: string
let baseUrl: string
const countryConfigRequests: string[] = []

const trpc = () =>
  createTRPCClient<DesktopRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl}/api/events`,
        transformer: superjson,
        methodOverride: 'POST',
        headers: { 'x-opencrvs-desktop-secret': SECRET }
      })
    ]
  })

async function start() {
  backend = await startBackend({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    clientDir: undefined,
    countryConfigUrl: `http://127.0.0.1:${(fakeCountryConfig.address() as AddressInfo).port}`,
    secret: SECRET,
    role: undefined,
    exitOnStdinClose: false,
    strictCsp: true
  })
  baseUrl = `http://127.0.0.1:${backend.port}`
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencrvs-desktop-test-'))
  fakeCountryConfig = http.createServer((req, res) => {
    countryConfigRequests.push(`${req.method} ${req.url}`)
    const body = COUNTRY_CONFIG[req.url ?? '']
    if (body === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  })
  await new Promise<void>((resolve) =>
    fakeCountryConfig.listen(0, '127.0.0.1', resolve)
  )
  await start()
})

afterAll(async () => {
  await backend?.close()
  fakeCountryConfig?.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('desktop backend', () => {
  it('refuses requests without the secret', async () => {
    const res = await fetch(`${baseUrl}/api/ping`)
    expect(res.status).toBe(403)
  })

  it('gives the operator the most permissive scopes, without notify', async () => {
    const res = await fetch(`${baseUrl}/__desktop/token`, {
      headers: { 'x-opencrvs-desktop-secret': SECRET }
    })
    const { token } = (await res.json()) as { token: string }
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString()
    )
    expect(payload.role).toBe('NATIONAL_REGISTRAR')
    expect(payload.scope).toContain('type=record.create')
    expect(payload.scope).toContain('type=record.register')
    expect(payload.scope).toContain(
      'type=workqueue&ids=assigned-to-you,recent,ready-to-print'
    )
    // A list with one item is encoded with `[]`, so it decodes as a list again.
    expect(payload.scope).toContain(
      'type=record.custom-action&customActionTypes[]=VALIDATE_DECLARATION'
    )
    expect(payload.scope).not.toContain('type=record.notify')
    expect(payload.scope.join(' ')).not.toContain('print-certified-copies')
  })

  it('serves fakes for country config routes that need a token, and sends only GET requests', async () => {
    const headers = { 'x-opencrvs-desktop-secret': SECRET }
    const certificates = await fetch(`${baseUrl}/api/countryconfig/certificates`, { headers })
    expect(await certificates.json()).toEqual([])
    const post = await fetch(`${baseUrl}/api/countryconfig/trigger/events/x`, {
      method: 'POST',
      headers,
      body: '{}'
    })
    expect(post.status).toBe(405)
    expect(countryConfigRequests.every((r) => r.startsWith('GET '))).toBe(true)
  })

  it('stores a record and its files, and finds it after a restart', async () => {
    const client = trpc()
    const [user] = await client.user.list.query([
      (await client.user.search.query({}))[0].id
    ])
    const office = await client.locations.get.query({
      id: user.primaryOfficeId!
    })
    // The office must belong to an administrative area, so HQ Office is not picked.
    expect(office.name).toBe('Central Office')

    const created = await client.event.create.mutate({
      type: tennisClubMembershipEvent.id,
      transactionId: getUUID()
    })
    expect(created.actions.map((a) => a.type)).toEqual([
      ActionType.CREATE,
      ActionType.ASSIGN
    ])

    const form = new FormData()
    form.append('file', new Blob([Buffer.from('fake png')], { type: 'image/png' }), 'proof.png')
    form.append('transactionId', 'f0f0f0f0-0000-4000-8000-000000000001')
    form.append('path', `events/${created.id}/`)
    const upload = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: { 'x-opencrvs-desktop-secret': SECRET },
      body: form
    })
    const filePath = await upload.text()
    expect(filePath).toBe(`events/${created.id}/f0f0f0f0-0000-4000-8000-000000000001.png`)
    const file = await fetch(`${baseUrl}/${filePath}`, {
      headers: { 'x-opencrvs-desktop-secret': SECRET }
    })
    expect(await file.text()).toBe('fake png')

    await client.event.actions.declare.request.mutate({
      type: ActionType.DECLARE,
      eventId: created.id,
      transactionId: getUUID(),
      declaration: {
        'applicant.name': { firstname: 'Amara', surname: 'Banda' }
      }
    })
    await client.event.actions.assignment.assign.mutate({
      type: ActionType.ASSIGN,
      eventId: created.id,
      transactionId: getUUID(),
      assignedTo: user.id
    })
    const registered = await client.event.actions.register.request.mutate({
      type: ActionType.REGISTER,
      eventId: created.id,
      transactionId: getUUID()
    })

    const state = getCurrentEventState(registered, tennisClubMembershipEvent)
    expect(state.status).toBe('REGISTERED')
    expect(state.legalStatuses.REGISTERED?.registrationNumber).toMatch(
      /^[0-9A-Z]{12}$/
    )
    // Like the events service: a Requested action, then the Accepted action that points to it.
    const register = registered.actions.filter((a) => a.type === ActionType.REGISTER)
    expect(register.map((a) => a.status)).toEqual(['Requested', 'Accepted'])
    expect(register[1].originalActionId).toBe(register[0].id)

    await backend.close()
    await start()

    const found = await trpc().event.search.query({
      query: {
        type: 'or',
        clauses: [
          { data: { 'applicant.name': { type: 'fuzzy', term: 'Amra' } } },
          { trackingId: { type: 'exact', term: 'Amra' } }
        ]
      },
      limit: 10,
      offset: 0
    })
    expect(found.results.map((r) => r.id)).toEqual([created.id])
  })
})
