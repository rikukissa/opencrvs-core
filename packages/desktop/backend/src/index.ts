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
import { startBackend } from './app'
import { readEnv } from './env'
import { log } from './log'

/** The Tauri shell reads these lines from stdout. */
const READY_PREFIX = 'OPENCRVS_DESKTOP_READY'
const ERROR_PREFIX = 'OPENCRVS_DESKTOP_ERROR'

async function main() {
  const env = readEnv()
  const backend = await startBackend(env)
  process.stdout.write(`${READY_PREFIX} ${backend.port}\n`)

  const shutdown = () => {
    log.info('Stopping')
    void backend.close().finally(() => process.exit(0))
    // Do not wait for open connections for long.
    setTimeout(() => process.exit(0), 2000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  if (env.exitOnStdinClose) {
    process.stdin.on('end', shutdown)
    process.stdin.on('close', shutdown)
    process.stdin.resume()
  }
}

main().catch((error: unknown) => {
  log.error('Could not start', error)
  process.stdout.write(
    `${ERROR_PREFIX} ${error instanceof Error ? error.message : String(error)}\n`
  )
  process.exit(1)
})
