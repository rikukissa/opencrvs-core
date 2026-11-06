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
 * Copies a Node binary to `src-tauri/binaries/node-<target triple>`, where
 * Tauri expects the `externalBin` sidecar. By default it copies the Node that
 * runs this script. Use `--node <path>` for another binary, for example a
 * Windows `node.exe` when you cross-build.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const dir = path.dirname(fileURLToPath(import.meta.url))
const { values } = parseArgs({
  options: { node: { type: 'string' }, target: { type: 'string' } }
})

function hostTriple() {
  try {
    const output = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
    const host = /^host: (.+)$/m.exec(output)?.[1]
    if (host) {
      return host.trim()
    }
  } catch {
    // rustc is not on the PATH. Use the Node platform instead.
  }
  const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch]
  const platform = {
    darwin: 'apple-darwin',
    win32: 'pc-windows-msvc',
    linux: 'unknown-linux-gnu'
  }[process.platform]
  if (!arch || !platform) {
    throw new Error(`Unsupported platform ${process.platform} ${process.arch}`)
  }
  return `${arch}-${platform}`
}

const source = values.node ?? process.execPath
const target = values.target ?? hostTriple()
const extension = target.includes('windows') ? '.exe' : ''
const destination = path.join(dir, '../src-tauri/binaries', `node-${target}${extension}`)

if (!values.node) {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major !== 22 || minor < 13) {
    throw new Error(
      `The backend needs Node 22.13 or later in the 22 line, for node:sqlite without a flag. This is ${process.version}.`
    )
  }
}

fs.mkdirSync(path.dirname(destination), { recursive: true })
const sourceStat = fs.statSync(source)
const existing = fs.existsSync(destination) ? fs.statSync(destination) : undefined
if (existing?.size === sourceStat.size && existing.mtimeMs >= sourceStat.mtimeMs) {
  console.log(`Sidecar is up to date: ${destination}`)
} else {
  fs.copyFileSync(source, destination)
  fs.chmodSync(destination, 0o755)
  console.log(`Copied ${source} to ${destination}`)
}
