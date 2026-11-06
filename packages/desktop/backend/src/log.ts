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
import fs from 'node:fs'
import path from 'node:path'
import { format } from 'node:util'

let stream: fs.WriteStream | undefined

/** Writes logs to `<dataDir>/logs/backend.log` and to stderr. */
export function initLogFile(dataDir: string) {
  const dir = path.join(dataDir, 'logs')
  fs.mkdirSync(dir, { recursive: true })
  stream = fs.createWriteStream(path.join(dir, 'backend.log'), { flags: 'a' })
}

function write(level: string, args: unknown[]) {
  const line = `${new Date().toISOString()} ${level} ${format(...args)}\n`
  stream?.write(line)
  process.stderr.write(line)
}

export const log = {
  info: (...args: unknown[]) => write('INFO', args),
  warn: (...args: unknown[]) => write('WARN', args),
  error: (...args: unknown[]) => write('ERROR', args),
  debug: (...args: unknown[]) => {
    if (process.env.OPENCRVS_DESKTOP_DEBUG) {
      write('DEBUG', args)
    }
  }
}
