import type { A2aTaskMetadata } from './store.ts'
import type { TaskState } from './types.ts'

const MAX_CACHED_CONTEXTS = 64

export class A2aFilterIndex {
  private readonly contexts = new Map<string, string | Set<string>>()
  private readonly states = new Map<TaskState, Set<string>>()
  private readonly orderedContexts = new Map<string, string[]>()
  private readonly orderedStates = new Map<TaskState, string[]>()

  upsert(metadata: A2aTaskMetadata, previous?: A2aTaskMetadata): void {
    if (previous?.contextId !== metadata.contextId) {
      if (previous) this.removeContext(previous.contextId, metadata.id)
      this.addContext(metadata.contextId, metadata.id)
    }
    if (previous?.state !== metadata.state) {
      if (previous) this.removeState(previous.state, metadata.id)
      this.addState(metadata.state, metadata.id)
    }
  }

  delete(metadata: A2aTaskMetadata): void {
    this.removeContext(metadata.contextId, metadata.id)
    this.removeState(metadata.state, metadata.id)
  }

  ids(contextId?: string, state?: TaskState): string[] {
    if (contextId && state) {
      const context = this.contexts.get(contextId)
      const status = this.states.get(state)
      if (!context || !status) return []
      if (typeof context === 'string') return status.has(context) ? [context] : []
      if (context.size <= status.size) return this.sortedContext(contextId, context).filter((id) => status.has(id))
      return this.sortedState(state, status).filter((id) => context.has(id))
    }
    if (contextId) {
      const context = this.contexts.get(contextId)
      if (!context) return []
      return typeof context === 'string' ? [context] : this.sortedContext(contextId, context)
    }
    if (state) {
      const status = this.states.get(state)
      return status ? this.sortedState(state, status) : []
    }
    return []
  }

  private addContext(contextId: string, id: string): void {
    const current = this.contexts.get(contextId)
    if (current === undefined) this.contexts.set(contextId, id)
    else if (typeof current === 'string') {
      if (current !== id) this.contexts.set(contextId, new Set([current, id]))
    } else current.add(id)
    this.orderedContexts.delete(contextId)
  }

  private removeContext(contextId: string, id: string): void {
    const current = this.contexts.get(contextId)
    if (typeof current === 'string') {
      if (current === id) this.contexts.delete(contextId)
    } else if (current) {
      current.delete(id)
      if (current.size === 1) this.contexts.set(contextId, current.values().next().value!)
      else if (current.size === 0) this.contexts.delete(contextId)
    }
    this.orderedContexts.delete(contextId)
  }

  private addState(state: TaskState, id: string): void {
    let current = this.states.get(state)
    if (!current) {
      current = new Set()
      this.states.set(state, current)
    }
    current.add(id)
    this.orderedStates.delete(state)
  }

  private removeState(state: TaskState, id: string): void {
    const current = this.states.get(state)
    if (!current) return
    current.delete(id)
    if (current.size === 0) this.states.delete(state)
    this.orderedStates.delete(state)
  }

  private sortedContext(contextId: string, ids: Set<string>): string[] {
    const cached = this.orderedContexts.get(contextId)
    if (cached) {
      this.orderedContexts.delete(contextId)
      this.orderedContexts.set(contextId, cached)
      return cached
    }
    const ordered = [...ids].sort()
    if (this.orderedContexts.size >= MAX_CACHED_CONTEXTS) this.orderedContexts.delete(this.orderedContexts.keys().next().value!)
    this.orderedContexts.set(contextId, ordered)
    return ordered
  }

  private sortedState(state: TaskState, ids: Set<string>): string[] {
    let ordered = this.orderedStates.get(state)
    if (!ordered) {
      ordered = [...ids].sort()
      this.orderedStates.set(state, ordered)
    }
    return ordered
  }
}
