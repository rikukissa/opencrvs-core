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
import { readFileSync } from 'fs'
import * as jwt from 'jsonwebtoken'
import { createServer } from '@user-mgnt/server'

describe('Route authorization', () => {
  it('tests the health check', async () => {
    const server = await createServer()
    const res = await server.server.inject({
      method: 'GET',
      url: '/ping'
    })
    expect(res.result).toEqual({ success: true })
  })
  it('blocks requests without a token', async () => {
    const server = await createServer()
    const res = await server.server.inject({
      method: 'GET',
      url: '/check-token'
    })
    expect(res.statusCode).toBe(401)
  })

  it('blocks requests with an invalid token', async () => {
    const server = await createServer()
    const res = await server.server.inject({
      method: 'GET',
      url: '/check-token',
      headers: {
        Authorization: 'Bearer abc'
      }
    })
    expect(res.statusCode).toBe(401)
  })

  it('accepts requests with a valid token', async () => {
    const server = await createServer()
    const token = jwt.sign({}, readFileSync('./test/cert.key'), {
      algorithm: 'RS256',
      issuer: 'opencrvs:auth-service',
      audience: 'opencrvs:user-mgnt-user'
    })
    const res = await server.server.inject({
      method: 'GET',
      url: '/check-token',
      headers: {
        Authorization: `Bearer ${token}`
      }
    })
    expect(res.statusCode).toBe(200)
  })

  it('blocks requests with a token with invalid signature', async () => {
    const server = await createServer()
    const token = jwt.sign({}, readFileSync('./test/cert-invalid.key'), {
      algorithm: 'RS256',
      issuer: 'opencrvs:auth-service',
      audience: 'opencrvs:user-mgnt-user'
    })
    const res = await server.server.inject({
      method: 'GET',
      url: '/check-token',
      headers: {
        Authorization: `Bearer ${token}`
      }
    })
    expect(res.statusCode).toBe(401)
  })

  it('blocks requests with expired token', async () => {
    const server = await createServer()
    const token = jwt.sign({}, readFileSync('./test/cert.key'), {
      algorithm: 'RS256',
      issuer: 'opencrvs:auth-service',
      audience: 'opencrvs:user-mgnt-user',
      expiresIn: '1ms'
    })

    await new Promise((resolve) => {
      setTimeout(resolve, 5)
    })

    const res = await server.server.inject({
      method: 'GET',
      url: '/check-token',
      headers: {
        Authorization: `Bearer ${token}`
      }
    })
    expect(res.statusCode).toBe(401)
  })

  it('blocks requests signed with wrong algorithm (RS384)', async () => {
    const server = await createServer()
    const token = jwt.sign({}, readFileSync('./test/cert.key'), {
      algorithm: 'RS384',
      issuer: 'opencrvs:auth-service',
      audience: 'opencrvs:user-mgnt-user'
    })
    const res = await server.server.inject({
      method: 'GET',
      url: '/check-token',
      headers: {
        Authorization: `Bearer ${token}`
      }
    })

    expect(res.statusCode).toBe(401)
  })

  it('blocks requests signed with wrong audience', async () => {
    const server = await createServer()
    const token = jwt.sign({}, readFileSync('./test/cert.key'), {
      algorithm: 'RS256',
      issuer: 'opencrvs:auth-service',
      audience: 'opencrvs:NOT_VALID'
    })
    const res = await server.server.inject({
      method: 'GET',
      url: '/check-token',
      headers: {
        Authorization: `Bearer ${token}`
      }
    })

    expect(res.statusCode).toBe(401)
  })

  it('blocks requests signed with wrong issuer', async () => {
    const server = await createServer()
    const token = jwt.sign({}, readFileSync('./test/cert.key'), {
      algorithm: 'RS256',
      issuer: 'opencrvs:NOT_VALID',
      audience: 'opencrvs:user-mgnt-user'
    })
    const res = await server.server.inject({
      method: 'GET',
      url: '/check-token',
      headers: {
        Authorization: `Bearer ${token}`
      }
    })

    expect(res.statusCode).toBe(401)
  })
})
