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
import path from 'node:path'
import { parseArgs } from 'node:util'

export interface DesktopEnv {
  host: string
  port: number
  dataDir: string
  /** Directory of the client's Vite build. If not set, static files are not served. */
  clientDir: string | undefined
  countryConfigUrl: string
  /** Shared secret that the Tauri shell sends in every request. If not set, no check is made. */
  secret: string | undefined
  /** Role id for the local operator. If not set, the backend picks one. */
  role: string | undefined
  /** Exit when stdin closes. The Tauri shell uses this so the backend stops with the app. */
  exitOnStdinClose: boolean
  /** Add a Content-Security-Policy that blocks requests from the page to other hosts. */
  strictCsp: boolean
}

export const SECRET_HEADER = 'x-opencrvs-desktop-secret'
/** The origin that the page sees, e.g. `opencrvs://localhost`. Set by the Tauri shell. */
export const ORIGIN_HEADER = 'x-opencrvs-desktop-origin'

export function readEnv(argv = process.argv.slice(2)): DesktopEnv {
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      'data-dir': { type: 'string' },
      'client-dir': { type: 'string' },
      'country-config-url': { type: 'string' },
      role: { type: 'string' },
      'exit-on-stdin-close': { type: 'boolean' },
      'no-strict-csp': { type: 'boolean' }
    },
    strict: true
  })

  const dataDir = path.resolve(
    values['data-dir'] ?? process.env.OPENCRVS_DESKTOP_DATA_DIR ?? '.data'
  )
  const clientDir =
    values['client-dir'] ?? process.env.OPENCRVS_DESKTOP_CLIENT_DIR

  return {
    host: values.host ?? '127.0.0.1',
    port: Number(values.port ?? process.env.OPENCRVS_DESKTOP_PORT ?? 0),
    dataDir,
    clientDir: clientDir ? path.resolve(clientDir) : undefined,
    countryConfigUrl: (
      values['country-config-url'] ??
      process.env.OPENCRVS_DESKTOP_COUNTRY_CONFIG_URL ??
      'https://countryconfig.qa.opencrvs.dev'
    ).replace(/\/$/, ''),
    // The secret is read from the environment only, so it does not show in the process list.
    secret: process.env.OPENCRVS_DESKTOP_SECRET || undefined,
    role: values.role ?? process.env.OPENCRVS_DESKTOP_ROLE,
    exitOnStdinClose: values['exit-on-stdin-close'] ?? false,
    strictCsp: !(values['no-strict-csp'] ?? false)
  }
}
