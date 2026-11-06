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
 * Bundles the backend into one CommonJS file that a plain Node 22 binary can
 * run. `node:sqlite` and other built-in modules stay external.
 */
import { build, context } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')

const options = {
  entryPoints: [path.join(dir, 'src/index.ts')],
  outfile: path.join(dir, 'dist/index.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  // jsdom and other optional dependencies of commons are not needed on this path.
  external: ['jsdom', 'canvas']
}

if (watch) {
  const ctx = await context(options)
  await ctx.watch()
} else {
  await build(options)
}
