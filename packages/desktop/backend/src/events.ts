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
import { randomInt } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import {
  ActionDocument,
  ActionInputWithType,
  ActionStatus,
  ActionType,
  AssignActionInput,
  DraftInput,
  EventConfig,
  EventDocument,
  EventIndex,
  EventInput,
  EventStatus,
  FieldType,
  findLastAssignmentAction,
  getAvailableActionsForEvent,
  getCurrentEventState,
  getDeclarationFields,
  getStatusFromActions,
  getUUID,
  isFileFieldValue,
  isWriteAction,
  RemoteDraft,
  UnassignActionInput,
  UUID
} from '@opencrvs/commons/client'
import { CountryConfig } from './countryconfig'
import { Store } from './db'
import { FileStore } from './files'
import { Identity } from './identity'
import { log } from './log'

/**
 * Actions that the events service sends to the country config for
 * confirmation. The service stores a Requested action first and an Accepted
 * action after the confirmation. The desktop backend never calls the country
 * config, so it stores both actions at once. The documents look the same as
 * the documents that the events service makes.
 */
const CONFIRMABLE_ACTIONS = new Set<ActionType>([
  ActionType.NOTIFY,
  ActionType.DECLARE,
  ActionType.EDIT,
  ActionType.REGISTER,
  ActionType.REJECT,
  ActionType.ARCHIVE,
  ActionType.UNARCHIVE,
  ActionType.REVOKE_REGISTRATION,
  ActionType.REINSTATE_REGISTRATION,
  ActionType.PRINT_CERTIFICATE,
  ActionType.REQUEST_CORRECTION,
  ActionType.APPROVE_CORRECTION,
  ActionType.REJECT_CORRECTION,
  ActionType.CUSTOM
])

const TRACKING_ID_LENGTH = 6
const TRACKING_ID_CHARACTERS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** The same generator as the events service. */
function generateTrackingId(): string {
  let result = ''
  for (let i = 0; i < TRACKING_ID_LENGTH; i++) {
    const randomIndex = Math.floor(Math.random() * TRACKING_ID_CHARACTERS.length)
    result += TRACKING_ID_CHARACTERS[randomIndex]
  }
  return result
}

const REGISTRATION_NUMBER_LENGTH = 12
const REGISTRATION_NUMBER_CHARACTERS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** The country config makes registration numbers on a server. The desktop backend makes them locally. */
function generateRegistrationNumber(): string {
  let result = ''
  for (let i = 0; i < REGISTRATION_NUMBER_LENGTH; i++) {
    result +=
      REGISTRATION_NUMBER_CHARACTERS[
        randomInt(REGISTRATION_NUMBER_CHARACTERS.length)
      ]
  }
  return result
}

let lastTimestamp = 0
/** Timestamps that always increase, so actions keep their order when they are sorted by `createdAt`. */
function nextTimestamp() {
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1)
  return new Date(lastTimestamp).toISOString()
}

/** Like `jsonb_strip_nulls` in the events service: drops keys with null or undefined values. */
function dropNullish<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== null && v !== undefined)
  ) as T
}

export function notFound(eventId: string) {
  return new TRPCError({
    code: 'NOT_FOUND',
    message: `Event not found with ID: ${eventId}`
  })
}

type ActionInputWithOverrides = ActionInputWithType & {
  registrationNumber?: string
  requestId?: string
  customActionType?: string
  content?: unknown
}

export class EventService {
  constructor(
    private readonly store: Store,
    private readonly countryConfig: CountryConfig,
    private readonly identity: Identity,
    private readonly files: FileStore
  ) {}

  getEvent(eventId: string): EventDocument {
    const event = this.store.getEvent(eventId)
    if (!event) {
      throw notFound(eventId)
    }
    return event
  }

  config(eventType: string): Promise<EventConfig> {
    return this.countryConfig.eventConfig(eventType)
  }

  /** The EventIndex that search uses, or null while the record is only CREATED. */
  private searchIndexOf(
    event: EventDocument,
    config: EventConfig
  ): EventIndex | null {
    if (getStatusFromActions(event.actions) === EventStatus.enum.CREATED) {
      return null
    }
    return getCurrentEventState(event, config)
  }

  private indexCache: EventIndex[] | undefined

  private save(event: EventDocument, config: EventConfig) {
    this.store.updateEvent(event, this.searchIndexOf(event, config))
    this.indexCache = undefined
  }

  /** The current state of every record that is not only CREATED. Search and workqueues read these. */
  searchIndexes(): EventIndex[] {
    if (!this.indexCache) {
      this.indexCache = this.store.listSearchIndexes()
    }
    return this.indexCache
  }

  /** Builds the search index of every record again, for example after the event config changes. */
  async reindexAll() {
    const configs = await this.countryConfig.eventConfigs()
    let count = 0
    for (const event of this.store.listEventDocuments()) {
      const config = configs.find((c) => c.id === event.type)
      if (!config) {
        log.warn(`No event config for ${event.type}, record ${event.id} is not indexed`)
        continue
      }
      try {
        this.save(event, config)
        count++
      } catch (error) {
        log.error(`Could not index record ${event.id}: ${String(error)}`)
      }
    }
    log.info(`Indexed ${count} records`)
  }

  private buildAction(
    input: ActionInputWithOverrides,
    status: ActionStatus
  ): ActionDocument {
    const user = this.identity.user
    const common = {
      id: getUUID(),
      eventId: input.eventId,
      transactionId: input.transactionId,
      type: input.type,
      status,
      declaration: input.declaration ?? {},
      annotation: input.annotation,
      content: 'content' in input ? input.content : undefined,
      createdAt: nextTimestamp(),
      createdBy: user.id,
      createdByRole: user.role,
      createdByUserType: 'user' as const,
      createdBySignature: user.signature,
      createdAtLocation: user.primaryOfficeId,
      originalActionId: input.originalActionId
    }

    switch (input.type) {
      case ActionType.REGISTER:
        return dropNullish({
          ...common,
          registrationNumber: input.registrationNumber
        }) as ActionDocument
      case ActionType.ASSIGN:
        return dropNullish({
          ...common,
          status: ActionStatus.Accepted,
          assignedTo: user.id
        }) as ActionDocument
      case ActionType.UNASSIGN:
        return dropNullish({
          ...common,
          status: ActionStatus.Accepted
        }) as ActionDocument
      case ActionType.APPROVE_CORRECTION:
      case ActionType.REJECT_CORRECTION:
        return dropNullish({
          ...common,
          requestId: input.requestId
        }) as ActionDocument
      case ActionType.CUSTOM:
        return dropNullish({
          ...common,
          customActionType: input.customActionType
        }) as ActionDocument
      default:
        return dropNullish(common) as ActionDocument
    }
  }

  async create(input: EventInput): Promise<EventDocument> {
    const existing = this.store.findEventByTransaction(
      input.transactionId,
      input.type
    )
    if (existing) {
      return existing
    }
    const config = await this.config(input.type)

    let trackingId = generateTrackingId()
    while (this.store.trackingIdExists(trackingId)) {
      trackingId = generateTrackingId()
    }

    const now = nextTimestamp()
    const eventId = getUUID()
    const base = { eventId, transactionId: input.transactionId, declaration: {} }
    const event: EventDocument = {
      id: eventId,
      type: input.type,
      createdAt: now,
      updatedAt: now,
      trackingId,
      actions: [
        this.buildAction(
          { ...base, type: ActionType.CREATE } as ActionInputWithOverrides,
          ActionStatus.Accepted
        ),
        this.buildAction(
          {
            ...base,
            type: ActionType.ASSIGN,
            assignedTo: this.identity.operatorId,
            waitFor: true
          } as ActionInputWithOverrides,
          ActionStatus.Accepted
        )
      ]
    }
    this.store.transaction(() => {
      this.store.insertEvent(event, input.transactionId)
      this.save(event, config)
    })
    log.info(`Created ${input.type} record ${eventId} (${trackingId})`)
    return event
  }

  /** `event.get` adds a READ action, like the events service. */
  async read(eventId: string): Promise<EventDocument> {
    const event = this.getEvent(eventId)
    const config = await this.config(event.type)
    event.actions.push(
      this.buildAction(
        {
          type: ActionType.READ,
          eventId: eventId as UUID,
          transactionId: getUUID(),
          declaration: {},
          waitFor: true
        } as ActionInputWithOverrides,
        ActionStatus.Accepted
      )
    )
    this.save(event, config)
    return event
  }

  private throwConflictIfActionNotAllowed(
    event: EventDocument,
    config: EventConfig,
    actionType: ActionType
  ) {
    const index = getCurrentEventState(event, config)
    const allowed = getAvailableActionsForEvent(index)
    if (!allowed.includes(actionType)) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: `Action '${actionType}' cannot be performed on an event in '${index.status}' state with [${index.flags.join(', ')}] flags. Available actions: ${allowed.join(', ')}.`
      })
    }
  }

  private throwIfFilesAreMissing(
    config: EventConfig,
    declaration: Record<string, unknown>
  ) {
    const fileFields = new Set(
      getDeclarationFields(config)
        .filter((f) => f.type === FieldType.FILE)
        .map((f) => f.id)
    )
    for (const [fieldId, value] of Object.entries(declaration)) {
      if (
        fileFields.has(fieldId) &&
        isFileFieldValue(value) &&
        !this.files.exists(value.path)
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `File not found: ${value.path}`
        })
      }
    }
  }

  /**
   * Does what `defaultRequestHandler` and `processAction` do in the events
   * service, without the confirmation call to the country config.
   */
  async requestAction(input: ActionInputWithOverrides): Promise<EventDocument> {
    const event = this.getEvent(input.eventId)
    const existingAction = event.actions.find(
      (a) => a.transactionId === input.transactionId && a.type === input.type
    )
    if (existingAction) {
      return event
    }

    const config = await this.config(event.type)
    this.throwConflictIfActionNotAllowed(event, config, input.type)
    this.throwIfFilesAreMissing(config, input.declaration ?? {})

    if (input.type === ActionType.CUSTOM) {
      const custom = config.actions.find(
        (a) =>
          a.type === ActionType.CUSTOM &&
          a.customActionType === input.customActionType
      )
      if (!custom) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Custom action configuration not found with name: ${input.customActionType}`
        })
      }
    }

    if (!CONFIRMABLE_ACTIONS.has(input.type)) {
      this.appendAction(event, input, ActionStatus.Accepted)
      this.save(event, config)
      return event
    }

    const requested = this.appendAction(event, input, ActionStatus.Requested)

    // Remove what the country config would not echo back, like the events service does.
    const { declaration, annotation, ...stripped } = input
    void declaration
    void annotation
    this.appendAction(
      event,
      {
        ...stripped,
        declaration: {},
        originalActionId: requested.id,
        ...(input.type === ActionType.REGISTER
          ? {
              registrationNumber:
                input.registrationNumber ?? generateRegistrationNumber()
            }
          : {})
      } as ActionInputWithOverrides,
      ActionStatus.Accepted
    )
    this.save(event, config)
    log.info(`${input.type} on record ${event.id}`)
    return event
  }

  /** Like `addAction` in the events service. Returns the new action. */
  private appendAction(
    event: EventDocument,
    input: ActionInputWithOverrides,
    status: ActionStatus
  ): ActionDocument {
    const action = this.buildAction(input, status)
    event.actions.push(action)

    const keepAssignment =
      status === ActionStatus.Accepted
        ? (input.keepAssignmentIfAccepted ?? input.keepAssignment ?? false)
        : (input.keepAssignmentIfRejected ?? input.keepAssignment ?? false)

    if (
      status !== ActionStatus.Requested &&
      isWriteAction(input.type) &&
      !keepAssignment
    ) {
      event.actions.push(
        this.buildAction(
          {
            eventId: event.id as UUID,
            transactionId: input.transactionId,
            type: ActionType.UNASSIGN,
            declaration: {}
          } as ActionInputWithOverrides,
          ActionStatus.Accepted
        )
      )
    }

    if (input.type !== ActionType.READ && input.type !== ActionType.ASSIGN) {
      this.store.deleteDraftsByEventId(event.id)
    }
    return action
  }

  async assign(input: AssignActionInput) {
    const event = this.getEvent(input.eventId)
    const last = findLastAssignmentAction(event.actions)
    if (last?.type === ActionType.ASSIGN) {
      if (last.assignedTo === input.assignedTo) {
        return { ...event, actions: [] }
      }
      throw new TRPCError({ code: 'CONFLICT' })
    }
    const config = await this.config(event.type)
    const action = this.appendAction(
      event,
      input as ActionInputWithOverrides,
      ActionStatus.Accepted
    )
    this.save(event, config)
    return { ...event, actions: [action] }
  }

  async unassign(input: UnassignActionInput) {
    const event = this.getEvent(input.eventId)
    const last = findLastAssignmentAction(event.actions)
    if (last?.type !== ActionType.ASSIGN) {
      return { ...event, actions: [] }
    }
    const config = await this.config(event.type)
    const action = this.appendAction(
      event,
      input as ActionInputWithOverrides,
      ActionStatus.Accepted
    )
    this.save(event, config)
    return { ...event, actions: [action] }
  }

  delete(eventId: string) {
    const event = this.getEvent(eventId)
    if (getStatusFromActions(event.actions) !== EventStatus.enum.CREATED) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'A declared or notified event can not be deleted'
      })
    }
    this.files.deleteEventFiles(event.id)
    this.store.deleteEvent(event.id)
    this.indexCache = undefined
    return { id: event.id }
  }

  listDrafts(): RemoteDraft[] {
    return this.store.listDraftsByUser(this.identity.operatorId)
  }

  async createDraft(input: DraftInput): Promise<RemoteDraft> {
    const event = this.getEvent(input.eventId)
    const config = await this.config(event.type)
    this.throwConflictIfActionNotAllowed(event, config, input.type)

    const status = getStatusFromActions(event.actions)
    if (status !== EventStatus.enum.CREATED) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: `Drafts can only be saved on a record that has not been notified or declared yet. The record is ${status}.`
      })
    }

    const user = this.identity.user
    const previous = this.store.findLatestDraft(event.id, user.id, input.type)
    if (previous?.transactionId === input.transactionId) {
      return previous
    }

    const createdAt = nextTimestamp()
    const draft: RemoteDraft = {
      id: previous?.id ?? getUUID(),
      transactionId: input.transactionId,
      createdAt,
      eventId: event.id,
      action: dropNullish({
        transactionId: input.transactionId,
        createdAt,
        createdBy: user.id,
        createdByRole: user.role,
        createdByUserType: 'user' as const,
        declaration: input.declaration,
        annotation: input.annotation,
        type: input.type,
        status: ActionStatus.Accepted
      })
    }
    this.store.replaceDraft(draft, user.id)
    return draft
  }
}
