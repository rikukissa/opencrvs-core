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
 * A type-level test, checked by `tsc` (`pnpm test:compilation`).
 *
 * For every procedure that the client calls, the desktop router must:
 * - accept every input that the events service accepts, and
 * - return an output that the events service could return.
 *
 * If this file does not compile, `Failures` names the procedures that differ.
 */
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@opencrvs/events/src/router'
import type { DesktopRouter } from '../src/trpc/router'

type RealInputs = inferRouterInputs<AppRouter>
type RealOutputs = inferRouterOutputs<AppRouter>
type DesktopInputs = inferRouterInputs<DesktopRouter>
type DesktopOutputs = inferRouterOutputs<DesktopRouter>

type At<T, P extends string> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? At<T[Head], Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never

/**
 * The procedures that the client calls for the flows that the desktop app
 * supports. Find them with:
 * grep -rhoE "[a-zA-Z]*[tT]rpc[a-zA-Z]*\.(event|user|locations|workqueue|administrativeAreas|integrations)(\.[a-zA-Z]+)+" packages/client/src
 * User management, integrations and announcements are left out on purpose:
 * the desktop router only rejects them.
 */
type ClientProcedures =
  | 'event.config.get'
  | 'event.create'
  | 'event.get'
  | 'event.getDuplicates'
  | 'event.delete'
  | 'event.search'
  | 'event.draft.list'
  | 'event.draft.create'
  | 'event.file.getPresignedUrl'
  | 'event.actions.notify.request'
  | 'event.actions.declare.request'
  | 'event.actions.edit.request'
  | 'event.actions.reject.request'
  | 'event.actions.archive.request'
  | 'event.actions.unarchive.request'
  | 'event.actions.register.request'
  | 'event.actions.printCertificate.request'
  | 'event.actions.custom.request'
  | 'event.actions.assignment.assign'
  | 'event.actions.assignment.unassign'
  | 'event.actions.correction.request.request'
  | 'event.actions.correction.approve.request'
  | 'event.actions.correction.reject.request'
  | 'event.actions.revocation.revoke.request'
  | 'event.actions.revocation.reinstate.request'
  | 'event.actions.duplicate.markAsDuplicate'
  | 'event.actions.duplicate.markNotDuplicate'
  | 'user.get'
  | 'user.list'
  | 'user.search'
  | 'user.roles.list'
  | 'user.audit.list'
  | 'locations.list'
  | 'locations.get'
  | 'locations.getLocationHierarchy'
  | 'administrativeAreas.list'
  | 'workqueue.config.list'
  | 'workqueue.count'
  | 'integrations.list'

type Check<P extends ClientProcedures> = [At<DesktopInputs, P>] extends [never]
  ? `missing: ${P}`
  : [At<RealInputs, P>] extends [At<DesktopInputs, P>]
    ? [At<DesktopOutputs, P>] extends [At<RealOutputs, P>]
      ? true
      : `output differs: ${P}`
    : `input differs: ${P}`

type Failures = {
  [P in ClientProcedures]: Check<P> extends true ? never : Check<P>
}[ClientProcedures]

export const desktopRouterMatchesClient: [Failures] extends [never]
  ? true
  : Failures = true
