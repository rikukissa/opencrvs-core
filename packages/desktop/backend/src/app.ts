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
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { CountryConfig } from './countryconfig'
import { Store } from './db'
import { DesktopEnv } from './env'
import { EventService } from './events'
import { FileStore } from './files'
import { Identity } from './identity'
import { Locations } from './locations'
import { initLogFile, log } from './log'
import { createRequestHandler } from './server'

export interface RunningBackend {
  port: number
  close: () => Promise<void>
}

export async function startBackend(env: DesktopEnv): Promise<RunningBackend> {
  initLogFile(env.dataDir)
  log.info(
    `Starting. Data in ${env.dataDir}. Country config ${env.countryConfigUrl}. Client ${env.clientDir ?? '(not served)'}`
  )

  const store = new Store(env.dataDir)
  const countryConfig = new CountryConfig(store, env.countryConfigUrl)
  const locations = new Locations(store)
  await locations.refresh(countryConfig)

  const identity = new Identity(store)
  identity.configure(await countryConfig.roles(), locations, env.role)

  const files = new FileStore(env.dataDir)
  const events = new EventService(store, countryConfig, identity, files)

  // Fill the cache, so the app also starts when it is offline later.
  await Promise.all([
    countryConfig.versionedEventConfigs(),
    countryConfig.workqueues(),
    countryConfig.applicationConfig(),
    countryConfig.get('/client-config.js'),
    countryConfig.get('/content/client'),
    countryConfig.get('/static/manifest.json')
  ]).catch((error) => log.warn(`Could not fill the cache: ${String(error)}`))
  await events.reindexAll()

  const server = http.createServer(
    createRequestHandler(env, {
      countryConfig,
      events,
      files,
      identity,
      locations
    })
  )
  await new Promise<void>((resolve) =>
    server.listen(env.port, env.host, resolve)
  )
  const { port } = server.address() as AddressInfo
  log.info(`Listening on http://${env.host}:${port}`)

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => {
          store.db.close()
          resolve()
        })
      })
  }
}
