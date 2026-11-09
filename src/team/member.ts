import { existsSync, readFileSync, appendFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { ChatMessage, Provider } from '../provider/types.ts'
import type { ToolContext } from '../tools/index.ts'
import { ToolRegistry } from '../tools/registry.ts'
import { History } from '../session/history.ts'
import { runAgent } from '../agent/loop.ts'
import type { AgentHandle } from '../agent/events.ts'
import { ContextManager } from '../context/manager.ts'
import { spillBatch } from '../context/spill.ts'
import type { TeamGroupStore } from './group.ts'
import type { TeamMail } from './mail.ts'
import type { TeamMember, TeamTaskOutcome, TeamTaskReport } from './types.ts'
import { createRuntimeId } from '../runtime/index.ts'
import { atomicWriteFile } from './atomic.ts'
import { withFileLock } from '../runtime/file-lock.ts'
import { isChatMessage } from '../provider/message.ts'
import { closeBrowserScope } from '../tools/browser.ts'
import { resolveOnAbort } from '../tools/abort.ts'
import { matchesTaskSettlement } from './task-graph.ts'

// 成员上下文压缩阈值:历史估算超限时,摘要早期对话(对齐主会话 compact)
// 大任务几十轮后成员历史无限累积——不压缩会上下文爆炸
const MEMBER_COMPACT_TOKENS = 20000

const MEMBER_SYSTEM = `你是团队成员。使用团队协作工具（team_task 查看任务/汇报状态，team_send 与 Lead 和其他成员通信）。
任务执行完成后发送 IDLE 消息给 Lead（team_send to=Lead body=IDLE 完成摘要）。
需要审批时：先发 PLAN 计划给 Lead，等 APPROVE 后再执行。
文件操作规范：写文件一律用 write_file/edit_file 工具（只能在当前工作目录内，这是隔离预期）；
禁止用 run_command 写文件或修改工作目录外的路径（run_command 仅用于构建/测试/查询等非写文件命令）。
中间产物共享：抓取的页面/提取的片段等中间文件写 .meicode/artifacts/（团队共享区，其他成员可读可写）；最终报告写契约目录（.meicode/artifacts）。`

// 团队成员可用的基础工具（不含 load_skill——绑定主会话 SkillManager 会污染主会话状态）
const MEMBER_BASE_TOOLS = ['read_file', 'find_files', 'grep_code', 'run_command', 'write_file', 'edit_file', 'team_task', 'team_send']

const MIN_REPLAY_LINES = 8
const MEMBER_SAVE_RETRY_MS = 100
const MEMBER_BINDING_CHECK_MS = 500

class MemberHistoryConflictError extends Error {}

export class MemberPersistenceError extends Error {
  readonly outcome: TeamTaskOutcome

  constructor(cause: unknown, outcome: TeamTaskOutcome) {
    super(`成员历史待保存: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.outcome = outcome
  }
}

function replayedPrefixLength(lines: string[]): number {
  const matches = new Array<number>(lines.length).fill(0)
  let left = 0
  let right = 0
  for (let index = 1; index < lines.length; index++) {
    if (index <= right) matches[index] = Math.min(right - index + 1, matches[index - left])
    while (index + matches[index] < lines.length && lines[matches[index]] === lines[index + matches[index]]) matches[index]++
    if (index + matches[index] - 1 > right) {
      left = index
      right = index + matches[index] - 1
    }
  }
  for (let size = Math.floor(lines.length / 2); size >= MIN_REPLAY_LINES; size--) {
    if (matches[size] >= size) return size
  }
  return 0
}

function removeReplayedPrefixes(lines: string[]): { lines: string[]; changed: boolean } {
  let current = lines
  let changed = false
  while (current.length >= MIN_REPLAY_LINES * 2) {
    const size = replayedPrefixLength(current)
    if (size === 0) break
    current = [...current.slice(0, size), ...current.slice(size * 2)]
    changed = true
  }
  return { lines: current, changed }
}

interface MemberApprovalRequest {
  taskId: string
  correlationId: string
  lead: string
  leaseId?: string
}

export class MemberHost {
  private historyValue = new History()
  private historyLoaded = false
  private member: TeamMember
  private provider: Provider
  private registry: ToolRegistry
  private ctx: ToolContext
  private contextManager: ContextManager
  private historyFile: string
  private persistedLength = 0
  private persistedStructureVersion = 0
  private historyNeedsRewrite = false
  private historySnapshot: { size: number; mtimeMs: number; ctimeMs: number } | null = null
  private historySnapshotKnown = false

  private groupName: string
  private store: TeamGroupStore
  private mail: TeamMail
  private activeAgent: AgentHandle | null = null
  private activeTaskId: string | null = null
  private taskController: AbortController | null = null
  private taskSignal: AbortSignal | undefined
  private pendingApproval?: MemberApprovalRequest & { signal: AbortSignal; sent: boolean; received: boolean }
  private closeController = new AbortController()
  private closed = false
  private pendingSessionId: string | undefined
  private idleWaiters = new Set<() => void>()
  private historyPendingSave = false
  private historySaveConflict = false
  private conflictCopyFile: string | undefined
  private conflictCopyVersion = -1
  private historySaveTimer: ReturnType<typeof setInterval> | undefined

  private rolePrompt: string // 专家角色 SOP 正文（对齐 Qoder 专家团：角色=领域+专属指令）
  private roleToolsDeny: string[] // 角色禁用的工具（tools_deny frontmatter）
  private roleToolsAllow: string[] // 角色追加的工具（tools_allow frontmatter）
  private roleMaxRounds: number | undefined // 角色 max_rounds（复杂角色 30 轮 vs 默认 15——复杂编排收尾需要）
  private parentAgentId: string | undefined

  constructor(
    member: TeamMember,
    groupName: string,
    opts: {
      provider: Provider
      registry: ToolRegistry
      ctx: ToolContext
      historyFile: string
      store: TeamGroupStore
      mail: TeamMail
      rolePrompt?: string
      roleToolsDeny?: string[]
      roleToolsAllow?: string[]
      roleMaxRounds?: number
      parentAgentId?: string
      contextWindow?: number
    },
  ) {
    this.member = member
    this.groupName = groupName
    this.store = opts.store
    this.mail = opts.mail
    this.provider = opts.provider
    this.registry = opts.registry
    this.ctx = { ...opts.ctx, agentId: member.agentId ?? member.name }
    this.historyFile = opts.historyFile
    this.rolePrompt = opts.rolePrompt ?? ''
    this.roleToolsDeny = opts.roleToolsDeny ?? []
    this.roleToolsAllow = opts.roleToolsAllow ?? []
    this.roleMaxRounds = opts.roleMaxRounds
    this.parentAgentId = opts.parentAgentId
    const window = opts.contextWindow ?? opts.ctx.contextBudget?.().window ?? 131072
    this.contextManager = new ContextManager({
      provider: this.provider,
      history: this.historyValue,
      cwd: this.ctx.cwd,
      window,
      autoMargin: Math.max(window - MEMBER_COMPACT_TOKENS, Math.min(13000, Math.floor(window * 0.1))),
      hooks: this.ctx.hooks,
      sessionId: this.ctx.sessionId,
      agentId: this.ctx.agentId,
    })
    this.ctx.contextBudget = () => this.contextManager.snapshot()
    this.ctx.setRequestOverhead = (tokens) => this.contextManager.setRequestOverhead(tokens)
    this.ctx.beforeRequest = (mode, signal, options) => this.contextManager.beforeRequest(mode, signal, options)
    this.ctx.afterRequest = (usage, count, overhead) => this.contextManager.afterRequest(usage, count, overhead)
    this.ctx.spill = (results) => spillBatch(results, this.ctx.cwd)
  }

  get history(): History {
    this.resume()
    return this.historyValue
  }

  // 从磁盘恢复上下文
  resume(): void {
    if (this.historyLoaded) return
    withFileLock(`${this.historyFile}.lock`, () => this.loadHistory())
  }

  private loadHistory(): void {
    const messages: ChatMessage[] = []
    let invalid = false
    let changed = false
    let snapshot: typeof this.historySnapshot = null
    if (existsSync(this.historyFile)) {
      const recovered = removeReplayedPrefixes(readFileSync(this.historyFile, 'utf8').split('\n').filter(Boolean))
      changed = recovered.changed
      for (const line of recovered.lines) {
        if (!line.trim()) continue
        try {
          const message: unknown = JSON.parse(line)
          if (isChatMessage(message)) messages.push(message)
          else invalid = true
        } catch {
          invalid = true
        }
      }
      const stats = statSync(this.historyFile)
      snapshot = { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs }
    }
    this.historyValue.clear()
    for (const message of messages) this.historyValue.push(message)
    this.historySnapshot = snapshot
    this.historySnapshotKnown = true
    this.persistedLength = this.historyValue.length
    this.persistedStructureVersion = this.historyValue.structureVersion
    this.historyNeedsRewrite = changed || invalid
    this.historyLoaded = true
  }

  private saveHistoryConflictCopy(): string {
    if (this.conflictCopyFile && this.conflictCopyVersion === this.historyValue.version) return this.conflictCopyFile
    const file = `${this.historyFile}.conflict.${randomUUID()}.jsonl`
    const messages = this.historyValue.view()
    atomicWriteFile(file, messages.length ? `${messages.map((message) => JSON.stringify(message)).join('\n')}\n` : '')
    this.conflictCopyFile = file
    this.conflictCopyVersion = this.historyValue.version
    return file
  }

  private reloadAfterConflict(): string | undefined {
    let copy: string | undefined
    withFileLock(`${this.historyFile}.lock`, () => {
      if (this.historyPendingSave || this.historyValue.length !== this.persistedLength || this.historyValue.structureVersion !== this.persistedStructureVersion) copy = this.saveHistoryConflictCopy()
      this.loadHistory()
    })
    this.historyPendingSave = false
    this.historySaveConflict = false
    this.conflictCopyFile = undefined
    this.conflictCopyVersion = -1
    clearInterval(this.historySaveTimer)
    this.historySaveTimer = undefined
    this.contextManager.reset()
    return copy
  }

  reloadHistory(): string | undefined {
    if (this.isBusy() || this.closed) throw new Error('成员运行或关闭期间不能重载历史')
    return this.reloadAfterConflict()
  }

  private async recoverHistoryConflict(signal: AbortSignal): Promise<void> {
    let attempt = 0
    while (!signal.aborted && !this.closed) {
      try { this.reloadAfterConflict(); return }
      catch (error) {
        if (attempt++ === 0) console.warn(`[团队] 成员 ${this.member.name} 历史冲突恢复失败，将重试: ${(error as Error).message}`)
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await resolveOnAbort(() => new Promise<void>((done) => { timer = setTimeout(done, Math.min(1000, MEMBER_SAVE_RETRY_MS * attempt)) }), signal, undefined)
        } finally { clearTimeout(timer) }
      }
    }
  }

  private persist(): void {
    const msgs = this.history.view()
    const rewrite = this.historyNeedsRewrite || this.history.structureVersion !== this.persistedStructureVersion || msgs.length < this.persistedLength
    withFileLock(`${this.historyFile}.lock`, () => {
      let current: { size: number; mtimeMs: number; ctimeMs: number } | null = null
      if (existsSync(this.historyFile)) {
        const stats = statSync(this.historyFile)
        current = { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs }
      }
      const unchanged = !this.historySnapshotKnown
        || (current === null && this.historySnapshot === null)
        || (current !== null && this.historySnapshot !== null
          && current.size === this.historySnapshot.size
          && current.mtimeMs === this.historySnapshot.mtimeMs
          && current.ctimeMs === this.historySnapshot.ctimeMs)
      if (!unchanged) throw new MemberHistoryConflictError(`成员 ${this.member.name} 的历史已被其他进程更新，请重新加载`)
      if (rewrite) {
        atomicWriteFile(this.historyFile, msgs.length > 0 ? `${msgs.map((message) => JSON.stringify(message)).join('\n')}\n` : '')
      } else if (msgs.length > this.persistedLength) {
        const pending = msgs.slice(this.persistedLength)
        let separator = ''
        if (current && current.size > 0) {
          const fd = openSync(this.historyFile, 'r')
          try {
            const tail = Buffer.allocUnsafe(1)
            if (readSync(fd, tail, 0, 1, current.size - 1) !== 1) throw new Error('读取成员历史尾行失败')
            if (tail[0] !== 10) separator = '\n'
          } finally { closeSync(fd) }
        }
        appendFileSync(this.historyFile, separator + `${pending.map((message) => JSON.stringify(message)).join('\n')}\n`, 'utf8')
      }
      if (existsSync(this.historyFile)) {
        const stats = statSync(this.historyFile)
        this.historySnapshot = { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs }
      } else {
        this.historySnapshot = null
      }
      this.historySnapshotKnown = true
      this.persistedLength = msgs.length
      this.persistedStructureVersion = this.history.structureVersion
      this.historyNeedsRewrite = false
    })
    this.historyPendingSave = false
    this.historySaveConflict = false
    this.conflictCopyFile = undefined
    this.conflictCopyVersion = -1
    clearInterval(this.historySaveTimer)
    this.historySaveTimer = undefined
  }

  private async persistCompleted(signal: AbortSignal): Promise<void> {
    let attempt = 0
    while (true) {
      try { this.persist(); return }
      catch (error) {
        this.historyPendingSave = true
        this.historySaveConflict = error instanceof MemberHistoryConflictError
        if (this.historySaveConflict) {
          const copy = this.saveHistoryConflictCopy()
          throw new MemberHistoryConflictError(`${(error as Error).message}（冲突副本: ${copy}）`)
        }
        if (signal.aborted || this.closed) throw error
        if (attempt++ === 0) console.warn(`[团队] 成员 ${this.member.name} 历史保存失败，将重试: ${(error as Error).message}`)
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await resolveOnAbort(() => new Promise<void>((done) => {
            timer = setTimeout(done, Math.min(1000, MEMBER_SAVE_RETRY_MS * attempt))
          }), signal, undefined)
        } finally { clearTimeout(timer) }
      }
    }
  }

  private retryPendingHistory(): void {
    if (!this.historyPendingSave || this.historySaveConflict || this.closed || this.historySaveTimer) return
    this.historySaveTimer = setInterval(() => {
      if (this.isBusy()) return
      try { this.persist() }
      catch {
      }
    }, 500)
    this.historySaveTimer.unref()
  }

  isBusy(): boolean {
    return this.member.status === 'busy'
  }

  getApprovalRequest(): Readonly<MemberApprovalRequest> | null {
    const request = this.pendingApproval
    if (!request || this.closed || request.signal.aborted || request.sent || request.received || this.activeTaskId !== request.taskId) return null
    return { taskId: request.taskId, correlationId: request.correlationId, lead: request.lead, leaseId: request.leaseId }
  }

  sendApprovalDecision(request: Readonly<MemberApprovalRequest>, approve: boolean, note?: string): boolean {
    const current = this.getApprovalRequest()
    if (!current || current.taskId !== request.taskId || current.correlationId !== request.correlationId
      || current.lead !== request.lead || current.leaseId !== request.leaseId) return false
    const pending = this.pendingApproval!
    pending.sent = true
    try {
      this.mail.send(request.lead, this.member.name, `${approve ? 'APPROVE' : 'DENY'} ${note ?? ''}`.trim(), {
        groupId: this.groupName, kind: 'approval_decision', taskId: request.taskId, correlationId: request.correlationId,
      })
    } catch (error) { pending.sent = false; throw error }
    return true
  }

  getWorkdir(): string {
    return this.member.workdir
  }

  matchesMember(member: Readonly<TeamMember>): boolean {
    return !this.closed
      && member.status !== 'offline'
      && this.member.name === member.name
      && this.member.agentId === member.agentId
      && this.member.role === member.role
      && this.member.workdir === member.workdir
      && this.member.backend === member.backend
      && this.member.needsApproval === member.needsApproval
  }

  setSessionId(sessionId: string): void {
    if (this.isBusy()) {
      this.pendingSessionId = sessionId
      return
    }
    if (this.ctx.sessionId !== sessionId) {
      this.closeBrowser()
      this.contextManager.reset()
    }
    this.ctx.sessionId = sessionId
    this.contextManager.setSessionId(sessionId)
  }

  private closeBrowser(): void {
    void closeBrowserScope(this.ctx).catch((error: unknown) => {
      console.warn(`[团队] 成员 ${this.member.name} 浏览器关闭失败: ${(error as Error).message}`)
    })
  }

  whenIdle(): Promise<void> {
    if (!this.isBusy()) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.add(resolve))
  }

  persistPendingHistory(): boolean {
    if (!this.historyPendingSave) return true
    try {
      if (this.historySaveConflict) this.saveHistoryConflictCopy()
      else this.persist()
      return true
    } catch { return false }
  }

  close(): void {
    if (this.closed) {
      if (this.historyPendingSave) {
        try { if (this.historySaveConflict) this.saveHistoryConflictCopy(); else this.persist() }
        catch {
        }
      }
      return
    }
    this.closed = true
    clearInterval(this.historySaveTimer)
    this.historySaveTimer = undefined
    this.closeController.abort()
    this.taskController?.abort()
    this.activeAgent?.cancel()
    this.contextManager.reset()
    this.closeBrowser()
    if (this.historyPendingSave) {
      try { if (this.historySaveConflict) this.saveHistoryConflictCopy(); else this.persist() }
      catch (error) { console.warn(`[团队] 成员 ${this.member.name} 关闭时历史保存失败: ${(error as Error).message}`) }
    }
    if (!this.isBusy()) this.ctx.hooks?.clearAgent?.(this.ctx.sessionId, this.member.agentId ?? this.member.name)
  }

  cancel(taskId: string, signal?: AbortSignal): boolean {
    if (this.activeTaskId !== taskId || (signal !== undefined && this.taskSignal !== signal)) return false
    this.taskController?.abort()
    this.activeAgent?.cancel()
    return true
  }

  // 审批等待：needsApproval 成员先发 PLAN 给 Lead，轮询邮箱等 APPROVE/DENY（60s 超时）
  private async waitApproval(taskTitle: string, taskId: string, signal: AbortSignal, leaseId?: string): Promise<string | null> {
    const group = this.store.loadGroup(this.groupName)
    const lead = group?.lead ?? 'lead'
    // 只认本 PLAN 发出之后的审批消息——历史 APPROVE 残留会被后续任务误复用
    const planTs = Date.now()
    const correlationId = createRuntimeId('request')
    const request = { taskId, correlationId, lead, leaseId, signal, sent: false, received: false }
    this.pendingApproval = request
    try {
      this.mail.send(this.member.name, lead, `PLAN 任务 ${taskId}: ${taskTitle}\n计划: 按任务要求直接执行，等待 Lead 审批`, {
        groupId: this.groupName,
        kind: 'approval_plan',
        taskId,
        correlationId,
      })
      const decision = await this.mail.waitForMessage(
        this.member.name,
        (message) => {
          const matches = message.from === lead
            && message.to === this.member.name
            && message.groupId === this.groupName
            && message.ts >= planTs
            && message.kind === 'approval_decision'
            && message.taskId === taskId
            && message.correlationId === correlationId
            && /^(APPROVE|DENY)(?:\s|$)/.test(message.body)
          if (matches) request.received = true
          return matches
        },
        Math.max(0, planTs + 60000 - Date.now()),
        signal,
      )
      if (this.closed) return '成员正在关闭，已放弃执行'
      if (signal.aborted) return '任务已取消'
      if (decision) {
        if (leaseId !== undefined) {
          while (!signal.aborted) {
            try {
              const task = this.store.listTasks(this.groupName).find((task) => task.id === taskId)
              if (!task || task.status !== 'in_progress' || task.assignee !== this.member.name
                || task.leaseId !== leaseId || task.activeAgentId !== this.member.agentId
                || (task.leaseExpiresAt !== undefined && task.leaseExpiresAt <= Date.now())) return '审批请求已过期，任务租约已变更'
              break
            } catch {
              let timer: ReturnType<typeof setTimeout> | undefined
              try { await resolveOnAbort(() => new Promise<void>((done) => { timer = setTimeout(done, MEMBER_SAVE_RETRY_MS) }), signal, undefined) }
              finally { clearTimeout(timer) }
            }
          }
          if (signal.aborted) return '任务已取消'
        }
        if (decision.body.startsWith('DENY')) return `任务被 Lead 拒绝: ${decision.body.slice(4).trim() || '未说明原因'}`
        return null
      }
      return '等待 Lead 审批超时（60s），已放弃执行'
    } finally { if (this.pendingApproval === request) this.pendingApproval = undefined }
  }

  // 执行任务（协程驻留：runAgent 跑到底）
  // 返回结构化结果：status 供任务状态落库（拒绝/超时 → failed）
  async execute(taskTitle: string, taskId: string, signal?: AbortSignal, leaseId?: string): Promise<TeamTaskOutcome> {
    if (this.closed) {
      const reportId = createRuntimeId('report')
      return { status: 'failed', text: '成员正在关闭，无法执行新任务', interrupted: true, report: { reportId, status: 'failed', summary: '成员正在关闭，无法执行新任务' } }
    }
    if (this.isBusy()) {
      const reportId = createRuntimeId('report')
      return { status: 'failed', text: '成员正在执行其他任务', report: { reportId, status: 'failed', summary: '成员正在执行其他任务' } }
    }
    this.member.status = 'busy'
    this.activeTaskId = taskId
    const taskController = new AbortController()
    const taskSessionId = this.ctx.sessionId
    this.taskController = taskController
    this.taskSignal = signal
    const abortTask = () => taskController.abort()
    const bindingState = (): boolean | undefined => {
      try {
        const group = this.store.loadGroup(this.groupName, { strict: true })
        const member = group?.members.find((item) => item.name === this.member.name)
        if (!member || !this.matchesMember(member) || (this.pendingApproval && group?.lead !== this.pendingApproval.lead)
          || !this.store.isMemberIdentityUnique(this.groupName, member)) return false
        if (leaseId !== undefined) {
          const task = this.store.listTasks(this.groupName, { required: true }).find((task) => task.id === taskId)
          if (!task || task.status !== 'in_progress' || task.assignee !== member.name
            || task.leaseId !== leaseId || task.activeAgentId !== member.agentId
            || (task.leaseExpiresAt !== undefined && task.leaseExpiresAt <= Date.now())) return false
          if (this.store.loadTaskSettlements(this.groupName).some((entry) => entry.kind === 'cancel' && matchesTaskSettlement(entry, task))) return false
        }
        return true
      } catch { return undefined }
    }
    const ensureBinding = async (signal = taskController.signal): Promise<boolean> => {
      while (!signal.aborted) {
        const current = bindingState()
        if (current !== undefined) {
          if (!current) abortTask()
          return current && !signal.aborted
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        try { await resolveOnAbort(() => new Promise<void>((done) => { timer = setTimeout(done, MEMBER_SAVE_RETRY_MS) }), signal, undefined) }
        finally { clearTimeout(timer) }
      }
      return false
    }
    const bindingTimer = setInterval(() => {
      if (!taskController.signal.aborted && bindingState() === false) abortTask()
    }, MEMBER_BINDING_CHECK_MS)
    bindingTimer.unref()
    this.closeController.signal.addEventListener('abort', abortTask, { once: true })
    signal?.addEventListener('abort', abortTask, { once: true })
    if (signal?.aborted) abortTask()
    try {
    const startedAt = Date.now()
    this.resume()
    if (this.historySaveConflict) await this.recoverHistoryConflict(taskController.signal)
    if (!taskController.signal.aborted && this.historyPendingSave) await resolveOnAbort(() => this.persistCompleted(taskController.signal), taskController.signal, undefined)
    await ensureBinding()
    if (taskController.signal.aborted) {
      const reportId = createRuntimeId('report')
      return { status: 'failed', text: '任务已取消', interrupted: true, report: { reportId, status: 'failed', summary: '任务已取消', error: '任务已取消' } }
    }
    // subagent_start hook：成员任务开始（与子 agent 同一事件,role 区分）
    await resolveOnAbort(async () => this.ctx.hooks?.fire('subagent_start', {
      cwd: this.ctx.cwd,
      sessionId: this.ctx.sessionId,
      agentId: this.member.agentId ?? this.member.name,
      role: `member:${this.member.role}`,
    }, taskController.signal), taskController.signal, undefined)
    await ensureBinding()
    if (taskController.signal.aborted) {
      const reportId = createRuntimeId('report')
      return { status: 'failed', text: '任务已取消', interrupted: true, report: { reportId, status: 'failed', summary: '任务已取消', error: '任务已取消' } }
    }
    if (this.member.needsApproval) {
      const denied = await this.waitApproval(taskTitle, taskId, taskController.signal, leaseId)
      if (denied !== null) {
        const reportId = createRuntimeId('report')
        return { status: 'failed', text: denied, ...(taskController.signal.aborted ? { interrupted: true } : {}), report: { reportId, status: 'failed', summary: denied, error: denied } }
      }
    }
    await ensureBinding()
    if (taskController.signal.aborted) {
      const reportId = createRuntimeId('report')
      return { status: 'failed', text: '任务已取消', interrupted: true, report: { reportId, status: 'failed', summary: '任务已取消', error: '任务已取消' } }
    }
    this.history.push({ role: 'user', content: taskTitle })

    // 成员工具集 = 基础工具子集 + 角色追加工具(tools_allow)（按角色 tools_deny 过滤）
    const allowed = new Set([...MEMBER_BASE_TOOLS, ...this.roleToolsAllow])
    const toolsOverride = this.registry
      .toOpenAITools()
      .filter((t) => allowed.has(t.function.name) && !this.roleToolsDeny.includes(t.function.name)) as never

    const registry = new ToolRegistry()
    for (const tool of this.registry.list()) registry.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: async (args, ctx) => await ensureBinding(ctx.signal)
        ? tool.execute(args, ctx)
        : { success: false, output: '', error: '成员绑定已失效，工具执行已取消' },
    })
    const taskCtx: ToolContext = {
      ...this.ctx,
      beforeRequest: async (mode, signal, options) => {
        if (!await ensureBinding(signal)) return { status: 'cancelled' }
        const result = await this.ctx.beforeRequest?.(mode, signal, options)
        return await ensureBinding(signal) ? result : { status: 'cancelled' }
      },
    }
    const sourceProvider = this.provider
    const provider: Provider = {
      protocol: sourceProvider.protocol,
      async *streamChat(messages, options) {
        yield* sourceProvider.streamChat(messages, options)
        if (bindingState() === false) abortTask()
      },
    }
    const agent = runAgent({
      provider,
      history: this.history,
      registry,
      ctx: taskCtx,
      signal: taskController.signal,
      maxIterations: this.roleMaxRounds ?? 15,
      mode: 'full',
      systemPrompt: this.rolePrompt ? `${MEMBER_SYSTEM}\n\n## 你的专家角色\n${this.rolePrompt}` : MEMBER_SYSTEM,
      unknownToolLimit: 2,
      toolsOverride: toolsOverride as never,
    })
    this.activeAgent = agent
    if (taskController.signal.aborted) agent.cancel()

    const outputParts: string[] = []
    for await (const ev of agent.events) {
      if (ev.type === 'text') outputParts.push(ev.text)
    }
    const output = outputParts.join('')
    const result = await agent.done
    clearInterval(bindingTimer)
    // 异常终止(含 tool_repeat/max_iterations 等)都算 failed——中断产物不完整,报 done 会误导 Lead(实战实锤)
    const ABORT_REASONS = new Set(['error', 'tool_failures', 'tool_repeat', 'max_iterations', 'cancelled', 'unknown_tool'])
    const outcome: Omit<TeamTaskOutcome, 'report'> = ABORT_REASONS.has(result.reason)
      ? { status: 'failed', text: `执行失败（${result.reason}）: ${result.errorMessage ?? '未知原因'}` }
      : { status: 'done', text: output }
    if (result.reason === 'cancelled') outcome.interrupted = true
    const report: TeamTaskReport = {
      reportId: createRuntimeId('report'),
      status: outcome.status,
      summary: outcome.text.slice(0, 4000),
      tokens: result.totalTokens,
      durationMs: Date.now() - startedAt,
      evidence: result.evidence,
      ...(result.errorMessage ? { error: result.errorMessage } : {}),
    }
    try { await this.persistCompleted(taskController.signal) }
    catch (error) { throw new MemberPersistenceError(error, { ...outcome, report }) }
    // subagent_stop hook：成员任务结束
    await resolveOnAbort(async () => this.ctx.hooks?.fire('subagent_stop', {
      cwd: this.ctx.cwd,
      sessionId: this.ctx.sessionId,
      agentId: this.member.agentId ?? this.member.name,
      targetAgentId: this.parentAgentId,
      role: `member:${this.member.role}`,
      stats: `status=${outcome.status} tokens=${result.totalTokens} duration=${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    }, taskController.signal), taskController.signal, undefined)
    // teammate_idle hook(对齐 Claude Code):成员空闲——外部可自动派下一个任务
    await resolveOnAbort(async () => this.ctx.hooks?.fire('teammate_idle', {
      cwd: this.ctx.cwd,
      sessionId: this.ctx.sessionId,
      agentId: this.member.agentId ?? this.member.name,
      targetAgentId: this.parentAgentId,
      role: `member:${this.member.role}`,
      stats: `status=${outcome.status}`,
    }, taskController.signal), taskController.signal, undefined)
    if (taskController.signal.aborted) {
      if (this.closed && !outcome.interrupted) return { ...outcome, report }
      return { status: 'failed', text: '任务已取消', interrupted: true, report: { ...report, status: 'failed', summary: '任务已取消', error: '任务已取消' } }
    }
    return { ...outcome, report }
    } finally {
      clearInterval(bindingTimer)
      this.closeController.signal.removeEventListener('abort', abortTask)
      signal?.removeEventListener('abort', abortTask)
      if (this.taskController === taskController) {
        this.activeAgent = null
        this.activeTaskId = null
        this.taskController = null
        this.taskSignal = undefined
        this.ctx.hooks?.clearAgent?.(taskSessionId, this.member.agentId ?? this.member.name)
        this.member.status = 'idle'
        if (this.pendingSessionId !== undefined) {
          const sessionId = this.pendingSessionId
          this.pendingSessionId = undefined
          this.setSessionId(sessionId)
        }
        for (const resolve of this.idleWaiters) resolve()
        this.idleWaiters.clear()
        this.retryPendingHistory()
      }
    }
  }
}
