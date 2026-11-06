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
import { initTRPC, TRPCError } from '@trpc/server'
import superjson from 'superjson'
import * as z from 'zod/v4'
import {
  ActionInput,
  AdministrativeArea,
  ApproveCorrectionActionInput,
  ArchiveActionInput,
  AssignActionInput,
  CustomActionInput,
  DeclareActionInput,
  DeleteActionInput,
  DocumentPath,
  DraftInput,
  EditActionInput,
  EventDocument,
  EventDocumentOnlyLastAction,
  EventIndex,
  EventInput,
  extractPotentialDuplicatesFromActions,
  Location,
  MarkAsDuplicateActionInput,
  MarkNotDuplicateActionInput,
  NotifyActionInput,
  PrintCertificateActionInput,
  RegisterActionInput,
  ReinstateRegistrationActionInput,
  RejectCorrectionActionInput,
  RejectDeclarationActionInput,
  RemoteDraft,
  RequestCorrectionActionInput,
  RevokeRegistrationActionInput,
  SearchQuery,
  UnarchiveActionInput,
  UnassignActionInput,
  User,
  UserOrSystem,
  UUID,
  VersionedEventConfig,
  WorkqueueConfig,
  WorkqueueCountInput,
  WorkqueueCountOutput
} from '@opencrvs/commons/client'
import { CountryConfig } from '../countryconfig'
import { EventService } from '../events'
import { FileStore } from '../files'
import { Identity } from '../identity'
import { Locations } from '../locations'
import { count, search } from '../search'

export interface Services {
  countryConfig: CountryConfig
  events: EventService
  files: FileStore
  identity: Identity
  locations: Locations
}

export interface Context {
  services: Services
  /** The origin that the page sees, used for absolute file URLs. */
  origin: string
}

const t = initTRPC.context<Context>().create({ transformer: superjson })
const router = t.router
const procedure = t.procedure

/** Same as `EventIdParam` in the events service. */
const EventIdParam = z.object({
  eventId: UUID,
  customActionType: z.string().optional()
})

function notSupported(feature: string): never {
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: `${feature} is not available in the desktop app`
  })
}

const notSupportedMutation = (feature: string) =>
  procedure.input(z.any()).mutation((): never => notSupported(feature))

/**
 * Only the `request` step: the desktop app has no asynchronous confirmation.
 * The input is validated with the schema of the action. The type is the
 * `ActionInput` union, the same as `getDefaultActionProcedures` in the
 * events service.
 */
function actionRouter(inputSchema: z.ZodType) {
  return router({
    request: procedure
      .input(inputSchema as unknown as typeof ActionInput)
      .output(EventDocument)
      .mutation(({ ctx, input }) =>
        ctx.services.events.requestAction(
          input as Parameters<EventService['requestAction']>[0]
        )
      )
  })
}

function operatorSummary(user: User) {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    primaryOfficeId: user.primaryOfficeId,
    administrativeAreaId: user.administrativeAreaId,
    type: user.type,
    avatar: user.avatar
  }
}

function searchContext(services: Services, configs: Awaited<ReturnType<CountryConfig['eventConfigs']>>) {
  return {
    configs,
    hierarchy: (id: string) => services.locations.hierarchy(id)
  }
}

const eventRouter = router({
  config: router({
    get: procedure
      .input(z.void())
      .output(z.array(VersionedEventConfig))
      .query(({ ctx }) => ctx.services.countryConfig.versionedEventConfigs())
  }),
  create: procedure
    .input(EventInput)
    .output(EventDocument)
    .mutation(({ ctx, input }) => ctx.services.events.create(input)),
  get: procedure
    .input(EventIdParam)
    .output(EventDocument)
    .query(({ ctx, input }) => ctx.services.events.read(input.eventId)),
  getDuplicates: procedure
    .input(EventIdParam)
    .query(({ ctx, input }): EventDocument[] => {
      const event = ctx.services.events.getEvent(input.eventId)
      return extractPotentialDuplicatesFromActions(event.actions).flatMap(
        ({ id }) => {
          try {
            return [ctx.services.events.getEvent(id)]
          } catch {
            return []
          }
        }
      )
    }),
  delete: procedure
    .input(DeleteActionInput)
    .mutation(({ ctx, input }) => ctx.services.events.delete(input.eventId)),
  draft: router({
    list: procedure
      .output(z.array(RemoteDraft))
      .query(({ ctx }) => ctx.services.events.listDrafts()),
    create: procedure
      .input(DraftInput)
      .output(RemoteDraft)
      .mutation(({ ctx, input }) => ctx.services.events.createDraft(input))
  }),
  file: router({
    getPresignedUrl: procedure
      .input(z.object({ filePath: DocumentPath }))
      .output(z.object({ presignedURL: z.string() }))
      .query(({ ctx, input }) => {
        const filePath = input.filePath.replace(/^\/+/, '')
        if (!ctx.services.files.resolve(filePath)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Unrecognized file path: ${input.filePath}`
          })
        }
        return { presignedURL: `${ctx.origin}/files/${filePath}` }
      })
  }),
  actions: router({
    notify: actionRouter(NotifyActionInput),
    declare: actionRouter(DeclareActionInput),
    edit: actionRouter(EditActionInput),
    reject: actionRouter(RejectDeclarationActionInput),
    archive: actionRouter(ArchiveActionInput),
    unarchive: actionRouter(UnarchiveActionInput),
    register: actionRouter(RegisterActionInput),
    printCertificate: actionRouter(PrintCertificateActionInput),
    custom: actionRouter(CustomActionInput),
    assignment: router({
      assign: procedure
        .input(AssignActionInput)
        .output(EventDocumentOnlyLastAction)
        .mutation(({ ctx, input }) => ctx.services.events.assign(input)),
      unassign: procedure
        .input(UnassignActionInput)
        .output(EventDocumentOnlyLastAction)
        .mutation(({ ctx, input }) => ctx.services.events.unassign(input))
    }),
    correction: router({
      request: actionRouter(RequestCorrectionActionInput),
      approve: actionRouter(ApproveCorrectionActionInput),
      reject: actionRouter(RejectCorrectionActionInput)
    }),
    revocation: router({
      revoke: actionRouter(RevokeRegistrationActionInput),
      reinstate: actionRouter(ReinstateRegistrationActionInput)
    }),
    duplicate: router({
      markAsDuplicate: procedure
        .input(MarkAsDuplicateActionInput)
        .output(EventDocument)
        .mutation(({ ctx, input }) =>
          ctx.services.events.requestAction(
            input as Parameters<EventService['requestAction']>[0]
          )
        ),
      markNotDuplicate: procedure
        .input(MarkNotDuplicateActionInput)
        .output(EventDocument)
        .mutation(({ ctx, input }) =>
          ctx.services.events.requestAction(
            input as Parameters<EventService['requestAction']>[0]
          )
        )
    })
  }),
  search: procedure
    .input(SearchQuery)
    .output(z.object({ results: z.array(EventIndex), total: z.number() }))
    .query(async ({ ctx, input }) => {
      const configs = await ctx.services.countryConfig.eventConfigs()
      return search(
        ctx.services.events.searchIndexes(),
        input,
        searchContext(ctx.services, configs)
      )
    })
})

const userRouter = router({
  get: procedure
    .input(UUID)
    .output(UserOrSystem)
    .query(({ ctx, input }) => {
      const user = ctx.services.identity.user
      if (input !== user.id) {
        throw new TRPCError({ code: 'NOT_FOUND' })
      }
      return user
    }),
  list: procedure
    .input(z.array(z.string()).max(100))
    .query(({ ctx, input }) => {
      const user = ctx.services.identity.user
      return input.includes(user.id) ? [operatorSummary(user)] : []
    }),
  search: procedure.input(z.any()).query(({ ctx }) => {
    const user = ctx.services.identity.user
    return [{ ...operatorSummary(user), status: user.status }]
  }),
  roles: router({
    list: procedure.query(({ ctx }) => ctx.services.countryConfig.roles())
  }),
  update: procedure
    .input(z.any())
    .output(User)
    .mutation((): never => notSupported('User management')),
  create: procedure
    .input(z.any())
    .output(User)
    .mutation((): never => notSupported('User management')),
  activate: notSupportedMutation('User management'),
  resendInvite: notSupportedMutation('User management'),
  sendUsernameReminder: notSupportedMutation('User management'),
  sendResetPasswordInvite: notSupportedMutation('User management'),
  changePassword: notSupportedMutation('Changing the password'),
  requestEmailChange: notSupportedMutation('Changing the email'),
  requestPhoneChange: notSupportedMutation('Changing the phone number'),
  changePhone: notSupportedMutation('Changing the phone number'),
  changeEmail: notSupportedMutation('Changing the email'),
  changeAvatar: notSupportedMutation('Changing the avatar'),
  verifyLoggedInUserPassword: notSupportedMutation('Password verification'),
  audit: router({
    list: procedure
      .input(z.any())
      .query(() => ({ results: [] as never[], total: 0 }))
  })
})

const locationRouter = router({
  list: procedure
    .input(
      z
        .object({
          isActive: z.boolean().optional(),
          locationIds: z.array(UUID).optional(),
          locationType: z.string().optional(),
          externalId: z.string().optional()
        })
        .optional()
    )
    .query(({ ctx, input }): Location[] =>
      ctx.services.locations.listLocations(input)
    ),
  get: procedure
    .input(z.object({ id: UUID }))
    .output(Location)
    .query(({ ctx, input }) => {
      const location = ctx.services.locations.getLocation(input.id)
      if (!location) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Location with id ${input.id} not found`
        })
      }
      return location
    }),
  getLocationHierarchy: procedure
    .input(z.object({ locationId: UUID }))
    .output(z.array(UUID))
    .query(({ ctx, input }) =>
      ctx.services.locations.hierarchy(input.locationId)
    )
})

const administrativeAreaRouter = router({
  list: procedure
    .input(
      z
        .object({
          isActive: z.boolean().optional(),
          ids: z.array(UUID).optional()
        })
        .optional()
    )
    .output(z.array(AdministrativeArea))
    .query(({ ctx, input }) =>
      ctx.services.locations.listAdministrativeAreas(input)
    )
})

const workqueueRouter = router({
  config: router({
    list: procedure
      .input(z.void())
      .output(z.array(WorkqueueConfig))
      .query(({ ctx }) => ctx.services.countryConfig.workqueues())
  }),
  count: procedure
    .input(WorkqueueCountInput)
    .output(WorkqueueCountOutput)
    .query(async ({ ctx, input }) => {
      const configs = await ctx.services.countryConfig.eventConfigs()
      const indexes = ctx.services.events.searchIndexes()
      const searchCtx = searchContext(ctx.services, configs)
      return Object.fromEntries(
        input.map(({ slug, query }) => [slug, count(indexes, query, searchCtx)])
      )
    })
})

const integrationsRouter = router({
  list: procedure.input(z.any()).query(() => [] as never[]),
  get: procedure.input(z.any()).query((): never => notSupported('Integrations')),
  create: notSupportedMutation('Integrations'),
  delete: notSupportedMutation('Integrations'),
  activate: notSupportedMutation('Integrations'),
  deactivate: notSupportedMutation('Integrations'),
  refreshSecret: notSupportedMutation('Integrations')
})

const announcementRouter = router({
  broadcast: notSupportedMutation('Announcements')
})

export const appRouter = router({
  event: eventRouter,
  user: userRouter,
  locations: locationRouter,
  workqueue: workqueueRouter,
  administrativeAreas: administrativeAreaRouter,
  integrations: integrationsRouter,
  announcement: announcementRouter
})

export type DesktopRouter = typeof appRouter

