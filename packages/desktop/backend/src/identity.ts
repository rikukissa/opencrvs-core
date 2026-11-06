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
import crypto from 'node:crypto'
import {
  decodeScope,
  encodeScope,
  EncodedScope,
  getUUID,
  Role,
  Scope,
  User,
  UUID
} from '@opencrvs/commons/client'
import { Store } from './db'
import { Locations } from './locations'
import { log } from './log'

/**
 * Scope types that the operator does not get, because the desktop backend
 * does not support the feature (printing, dashboards, user management,
 * system administration) or because only system clients use them.
 */
const EXCLUDED_SCOPE_TYPES = new Set<string>([
  // The client does not support roles that can both notify and declare. With
  // `record.notify`, it sends every new record to the notify flow.
  'record.notify',
  'bypassratelimit',
  'record.reindex',
  'record.import',
  'record.action.accept',
  'record.action.reject',
  'record.print-certified-copies',
  'config.update-all',
  'integration.create',
  'integration.audit.read',
  'location.edit',
  'attachment.upload',
  'user.data-seeding',
  'user.create',
  'user.edit',
  'profile.electronic-signature',
  'performance.read',
  'performance.read-dashboards',
  'performance.vital-statistics-export',
  'dashboard.view'
])

const TEN_YEARS_IN_SECONDS = 10 * 365 * 24 * 60 * 60

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

/**
 * Builds the most permissive version of every scope that any role has.
 *
 * A scope without options has no restrictions (jurisdiction defaults to
 * `all`), so options are dropped. Two scope types need options to work:
 * `workqueue` needs the workqueue ids and `record.custom-action` needs the
 * custom action types. For those, the values of all roles are combined.
 */
export function buildOperatorScopes(roles: Role[]): EncodedScope[] {
  const byType = new Map<string, Scope[]>()
  for (const role of roles) {
    for (const encoded of role.scopes) {
      const scope = decodeScope(encoded as EncodedScope)
      if (!scope) {
        log.warn(`Ignoring scope that does not parse: ${encoded}`)
        continue
      }
      byType.set(scope.type, [...(byType.get(scope.type) ?? []), scope])
    }
  }

  const result: EncodedScope[] = []
  for (const [type, scopes] of byType) {
    if (EXCLUDED_SCOPE_TYPES.has(type)) {
      continue
    }
    if (type === 'workqueue') {
      const ids = unique(
        scopes.flatMap((s) =>
          'options' in s && s.options && 'ids' in s.options
            ? (s.options.ids ?? [])
            : []
        )
      )
      result.push(encodeScope({ type: 'workqueue', options: { ids } }))
      continue
    }
    if (type === 'record.custom-action') {
      const customActionTypes = unique(
        scopes.flatMap((s) =>
          'options' in s && s.options && 'customActionTypes' in s.options
            ? (s.options.customActionTypes ?? [])
            : []
        )
      )
      result.push(
        encodeScope({
          type: 'record.custom-action',
          options: { customActionTypes }
        })
      )
      continue
    }
    result.push(encodeScope({ type } as Scope))
  }
  return result
}

/**
 * Picks the role for the operator: the configured one, else NATIONAL_REGISTRAR,
 * else the role that can register with the most scopes.
 */
export function pickOperatorRole(roles: Role[], configured?: string): string {
  if (configured) {
    return configured
  }
  if (roles.some((r) => r.id === 'NATIONAL_REGISTRAR')) {
    return 'NATIONAL_REGISTRAR'
  }
  const canRegister = roles.filter((r) =>
    r.scopes.some((s) => decodeScope(s as EncodedScope)?.type === 'record.register')
  )
  const candidates = canRegister.length > 0 ? canRegister : roles
  const [best] = [...candidates].sort((a, b) => b.scopes.length - a.scopes.length)
  if (!best) {
    throw new Error('The country config has no roles')
  }
  return best.id
}

function base64url(value: string | Buffer) {
  return Buffer.from(value).toString('base64url')
}

export class Identity {
  readonly operatorId: UUID
  private privateKey: crypto.KeyObject
  private _token = ''
  private _role = ''
  private _scopes: EncodedScope[] = []
  private office: { id: UUID; administrativeAreaId: UUID | null } | undefined

  constructor(private readonly store: Store) {
    let operatorId = store.getKv('operator.id')
    if (!operatorId) {
      operatorId = getUUID()
      store.setKv('operator.id', operatorId)
    }
    this.operatorId = operatorId as UUID

    let pem = store.getKv('jwt.privateKey')
    if (!pem) {
      const { privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048
      })
      pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
      store.setKv('jwt.privateKey', pem)
    }
    this.privateKey = crypto.createPrivateKey(pem)
  }

  /** Builds the operator's role, scopes, office and token from the roles of the country config. */
  configure(roles: Role[], locations: Locations, configuredRole?: string) {
    this._role = pickOperatorRole(roles, configuredRole)
    this._scopes = buildOperatorScopes(roles)

    const storedOffice = this.store.getKv('operator.primaryOfficeId')
    const office =
      (storedOffice && locations.getLocation(storedOffice)) ||
      locations.defaultOffice()
    if (!office) {
      throw new Error('The country config has no CRVS offices')
    }
    this.store.setKv('operator.primaryOfficeId', office.id)
    this.office = {
      id: office.id,
      administrativeAreaId: office.administrativeAreaId
    }
    this._token = this.sign()
    log.info(
      `Operator ${this.operatorId} has role ${this._role}, office ${office.name} and ${this._scopes.length} scopes`
    )
  }

  private sign() {
    const now = Math.floor(Date.now() / 1000)
    const header = { alg: 'RS256', typ: 'JWT' }
    const payload = {
      scope: this._scopes,
      role: this._role,
      userType: 'user',
      sub: this.operatorId,
      iat: now,
      exp: now + TEN_YEARS_IN_SECONDS,
      iss: 'opencrvs:auth-service',
      aud: ['opencrvs:gateway-user', 'opencrvs:events-user'],
      algorithm: 'RS256'
    }
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
    const signature = crypto.sign(
      'RSA-SHA256',
      Buffer.from(signingInput),
      this.privateKey
    )
    return `${signingInput}.${base64url(signature)}`
  }

  get token() {
    return this._token
  }

  get role() {
    return this._role
  }

  get scopes() {
    return this._scopes
  }

  get user(): User {
    if (!this.office) {
      throw new Error('Identity is not configured yet')
    }
    return {
      id: this.operatorId,
      name: { firstname: 'Desktop', surname: 'Operator' },
      role: this._role,
      primaryOfficeId: this.office.id,
      administrativeAreaId: this.office.administrativeAreaId,
      type: 'user',
      status: 'active',
      signature: null
    }
  }
}
