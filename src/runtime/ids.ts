import { randomUUID } from 'node:crypto'

export type RuntimeIdPrefix = 'session' | 'agent' | 'task' | 'message' | 'call' | 'report' | 'lease' | 'event' | 'request'

export function createRuntimeId<T extends RuntimeIdPrefix>(prefix: T): `${T}_${string}` {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 16)}`
}
