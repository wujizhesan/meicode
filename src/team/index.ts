import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import type { Provider } from '../provider/types.ts'
import type { Tool, ToolContext, ToolRegistry, ToolResult } from '../tools/index.ts'
import type { WorktreeManager } from '../worktree/index.ts'
import { loadAgentRoles, agentDirs } from '../subagent/loader.ts'
import { TeamGroupStore } from './group.ts'
import { TeamMail } from './mail.ts'
import { MemberHost } from './member.ts'
import type { MailMessage, TeamGroup, TeamMember, TeamTask } from './types.ts'
import { log } from '../log.ts'

function git(args: string[], cwd?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, shell: false })
    let out = ''
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()))
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
    child.on('error', () => resolve({ code: -1, out }))
  })
}

export class TeamManager {
  private store: TeamGroupStore
  private mail: TeamMail
  private members = new Map<string, MemberHost>()
  private repoRoot: string
  private cfgCoordinator: boolean
  private worktrees: WorktreeManager | null

  private opts: { provider: Provider; registry: ToolRegistry; ctx: ToolContext }

  constructor(
    root: string,
    repoRoot: string,
    opts: { provider: Provider; registry: ToolRegistry; ctx: ToolContext },
    worktrees?: WorktreeManager | null,
  ) {
    this.opts = opts
    this.store = new TeamGroupStore(root)
    this.mail = new TeamMail(join(root, '_shared', 'mail'))
    this.repoRoot = repoRoot
    this.cfgCoordinator = readCoordinatorConfig(root)
    this.worktrees = worktrees ?? null
  }

  // coordinator：配置开关 + 环境变量双锁
  isCoordinator(): boolean {
    return this.cfgCoordinator && process.env.MEWCOORDINATOR === '1'
  }

  createGroup(name: string, lead: string): TeamGroup {
    return this.store.createGroup(name, lead)
  }

  loadGroup(name: string): TeamGroup | null {
    return this.store.loadGroup(name)
  }

  listGroups(): string[] {
    return this.store.listGroups()
  }

  // 派生成员（协程驻留）：worktree 隔离 + 加入花名册 + 注册邮箱
  async spawnMember(
    group: TeamGroup,
    name: string,
    role: string,
    opts: { needsApproval?: boolean; workdir?: string } = {},
  ): Promise<MemberHost> {
    // 幂等：同名成员已驻留直接返回（不覆盖 host，避免双写同一 historyFile/worktree）
    const existing = this.members.get(name)
    if (existing) return existing
    // 成员独立 worktree（分支 wt-member-<name>），写文件不污染主仓库
    // 恢复场景(opts.workdir):复用已记录的 workdir,不重新 create
    let workdir = opts.workdir ?? process.cwd()
    if (!opts.workdir && this.worktrees) {
      try {
        const wt = await this.worktrees.create(`member-${name}`)
        workdir = wt.path
      } catch (e) {
        console.warn(`[团队] 成员 ${name} worktree 创建失败，降级为主目录: ${(e as Error).message}`)
      }
    }
    const member: TeamMember = {
      name,
      role,
      workdir,
      backend: 'coroutine',
      needsApproval: opts.needsApproval ?? false,
      status: 'idle',
    }
    this.store.addMember(group, member)
    this.mail.register(name)
    // 专家角色（对齐 Qoder 专家团）：按 role 名从角色文件加载 SOP 正文与工具限制
    let rolePrompt = ''
    let roleToolsDeny: string[] = []
    let roleToolsAllow: string[] = []
    let roleWritePaths: string[] = []
    let roleMaxRounds: number | undefined
    try {
      const found = loadAgentRoles(agentDirs(process.cwd())).find((r) => r.name === role)
      if (found) {
        rolePrompt = found.content
        roleToolsDeny = found.toolsDeny ?? []
        roleToolsAllow = found.toolsAllow ?? []
        roleWritePaths = found.writePaths ?? []
        roleMaxRounds = found.maxRounds
      }
    } catch {
      // 角色加载失败降级为基础成员
    }
    // 全局共享产物区：成员中间产物互通（实战: 抓的页面他人读不到）
    const sharedArtifacts = join(this.repoRoot, '.mewcode', 'artifacts')
    mkdirSync(sharedArtifacts, { recursive: true })
    const host = new MemberHost(
      member,
      group.name,
      {
        provider: this.opts.provider,
        registry: this.opts.registry,
        // rootLock：成员文件工具只能写 worktree 内（隔离主仓库）；rootLockExtra：契约报告目录 + 共享产物区
        ctx: {
          ...this.opts.ctx,
          cwd: workdir,
          rootLock: workdir,
          rootLockExtra: [...(roleWritePaths.length ? roleWritePaths : []), sharedArtifacts],
        },
        historyFile: join(this.store.groupDir(group.name), 'members', `${name}.history.jsonl`),
        store: this.store,
        mail: this.mail,
        rolePrompt,
        roleToolsDeny,
        roleToolsAllow,
        roleMaxRounds,
      },
    )
    this.members.set(name, host)
    return host
  }

  getMember(name: string): MemberHost | undefined {
    return this.members.get(name)
  }

  // 跨重启恢复:从 group.yaml 重建所有成员(workdir/history 复用,不重新 create worktree)
  async restore(): Promise<string[]> {
    const restored: string[] = []
    for (const groupName of this.store.listGroups()) {
      const group = this.store.loadGroup(groupName)
      if (!group) continue
      for (const m of group.members) {
        if (this.members.has(m.name)) continue
        try {
          await this.spawnMember(group, m.name, m.role, {
            needsApproval: m.needsApproval,
            workdir: m.workdir,
          })
          restored.push(`${groupName}/${m.name}`)
        } catch (e) {
          console.warn(`[团队] 恢复成员 ${m.name} 失败: ${(e as Error).message}`)
        }
      }
    }
    return restored
  }

  // Lead 读邮箱（成员发来的 IDLE/PLAN/汇报；markRead=true 时标记已读）
  readLeadMail(markRead = false): MailMessage[] {
    return this.mail.read('lead', markRead)
  }

  // Lead 审批响应：向成员发 APPROVE/DENY（成员 needsApproval 时执行前等待此消息）
  respondApproval(groupName: string, memberName: string, approve: boolean, note?: string): string {
    const group = this.store.loadGroup(groupName)
    if (!group) return `小组不存在: ${groupName}`
    if (!this.members.has(memberName)) return `成员不存在: ${memberName}`
    const body = `${approve ? 'APPROVE' : 'DENY'} ${note ?? ''}`.trim()
    this.mail.send(group.lead, memberName, body)
    return `已${approve ? '批准' : '拒绝'} ${memberName} 的审批请求${note ? `（${note}）` : ''}`
  }

  // 按工作目录反查成员身份（成员协作工具用，支持多组多成员全局注册）
  resolveMemberByCwd(cwd: string): { group: TeamGroup; member: TeamMember } | null {
    const target = resolve(cwd).toLowerCase()
    for (const groupName of this.store.listGroups()) {
      const g = this.store.loadGroup(groupName)
      if (!g) continue
      for (const m of g.members) {
        if (resolve(m.workdir).toLowerCase() === target) return { group: g, member: m }
      }
    }
    return null
  }

  // 成员协作工具（全局注册一份）：执行时按 ctx.cwd 解析成员身份
  memberTools(): Tool[] {
    return [
      {
        name: 'team_task',
        description:
          '团队共享任务操作。action=list 查看任务清单；create 创建（title/assignee）；update 更新状态（id/status: todo|in_progress|done|failed）；result 记录结果。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'list / create / update' },
            id: { type: 'string', description: '任务 id（update 用）' },
            title: { type: 'string', description: '任务标题（create 用）' },
            assignee: { type: 'string', description: '负责人（create 用）' },
            status: { type: 'string', description: '任务状态' },
            result: { type: 'string', description: '任务结果摘要（update 用）' },
          },
          required: ['action'],
        },
        execute: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
          const hit = this.resolveMemberByCwd(ctx.cwd)
          if (!hit) return { success: false, output: '', error: '无法识别成员身份（ctx.cwd 不在任何成员 workdir）' }
          const groupName = hit.group.name
          const memberName = hit.member.name
          const action = String(args.action ?? '')
          if (action === 'list') {
            const tasks = this.store.listTasks(groupName)
            return { success: true, output: tasks.length ? JSON.stringify(tasks, null, 2) : '（无任务）' }
          }
          if (action === 'create') {
            const tasks = this.store.listTasks(groupName)
            const task = {
              id: `t${Date.now().toString(36)}`,
              title: String(args.title ?? '未命名'),
              assignee: typeof args.assignee === 'string' ? args.assignee : memberName,
              status: 'todo' as const,
            }
            tasks.push(task)
            this.store.saveTasks(groupName, tasks)
            return { success: true, output: `已创建任务 ${task.id}: ${task.title}` }
          }
          if (action === 'update') {
            const id = String(args.id ?? '')
            const patch: Record<string, unknown> = {}
            if (typeof args.status === 'string') patch.status = args.status
            if (typeof args.result === 'string') patch.result = args.result
            const updated = this.store.updateTask(groupName, id, patch)
            if (!updated) return { success: false, output: '', error: `任务不存在: ${id}` }
            return { success: true, output: `任务 ${id} 已更新: ${updated.status}` }
          }
          return { success: false, output: '', error: `未知 action: ${action}` }
        },
      },
      {
        name: 'team_send',
        description:
          '团队消息。to=成员名或 *（广播）或 Lead。协议消息首行：PLAN（计划待审批）、APPROVE/DENY（审批回复）、IDLE（任务完成通知）。',
        parameters: {
          type: 'object',
          properties: {
            to: { type: 'string', description: '收件人（成员名 / Lead / * 广播）' },
            body: { type: 'string', description: '消息正文（可含协议首行）' },
          },
          required: ['to', 'body'],
        },
        execute: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
          const hit = this.resolveMemberByCwd(ctx.cwd)
          // 身份:成员用自己,Lead(主会话,不在任何 workdir)用 lead——Lead 要能发消息给成员
          const from = hit ? hit.member.name : 'lead'
          const to = String(args.to ?? '')
          const body = String(args.body ?? '')
          if (!to || !body) return { success: false, output: '', error: '缺少 to/body' }
          this.mail.send(from, to, body)
          return { success: true, output: `已发送消息给 ${to}` }
        },
      },
    ]
  }

  // Lead 指派：更新任务状态 + 触发成员执行（异步协程）
  async assignTask(group: TeamGroup, task: TeamTask, memberName: string): Promise<string> {
    const host = this.members.get(memberName)
    if (!host) return `成员不存在: ${memberName}`
    // busy 检查：并发指派同一成员会让两个 runAgent 交错写同一 History
    if (host.isBusy()) return `成员 ${memberName} 正在执行其他任务，等它空闲再派`
    this.store.updateTask(group.name, task.id, { status: 'in_progress', assignee: memberName })
    // needsApproval 成员：execute 内部发 PLAN 等 Lead 审批后再执行（审批在成员层等待）
    void host
      .execute(task.title)
      .then((result) => {
        this.store.updateTask(group.name, task.id, { status: result.status, result: result.text.slice(0, 4000) })
        const head = result.text.split('\n')[0].slice(0, 200)
        this.mail.send(memberName, group.lead, `${result.status === 'done' ? 'IDLE' : 'ERR'} 完成任务 ${task.id}: ${head}`)
      })
      .catch((e) => {
        this.store.updateTask(group.name, task.id, { status: 'failed', result: `执行异常: ${(e as Error).message}` })
        // 协程死亡静默 = Lead 空等(实战实锤)——异常必须通知 Lead
        this.mail.send(memberName, group.lead, `ERR 任务 ${task.id} 执行异常(协程死亡): ${(e as Error).message.slice(0, 200)}`)
      })
    const member = group.members.find((m) => m.name === memberName)
    return member?.needsApproval
      ? `已派发任务 ${task.id} 给 ${memberName}（需审批，成员已发 PLAN 等待 Lead 决定）`
      : `已指派成员 ${memberName} 执行任务 ${task.id}`
  }

  // Lead 工具用：同步等待成员执行完成，返回执行结果（供 team_assign 工具回灌）
  // 120s 超时转后台——成员最长 15 轮×60s，不设限会挂死主对话；
  // 超时后成员完成仍会写 done（完成逻辑在 execPromise 内）
  async runTask(group: TeamGroup, task: TeamTask, memberName: string): Promise<string> {
    const host = this.members.get(memberName)
    if (!host) return `成员不存在: ${memberName}`
    this.store.updateTask(group.name, task.id, { status: 'in_progress', assignee: memberName })
    if (host.isBusy()) return `成员 ${memberName} 正在执行其他任务，等它空闲再派`
    const execPromise = host
      .execute(task.title)
      .then((result) => {
        this.store.updateTask(group.name, task.id, { status: result.status, result: result.text.slice(0, 4000) })
        this.mail.send(memberName, group.lead, `${result.status === 'done' ? 'IDLE' : 'ERR'} 完成任务 ${task.id}: ${result.text.split('\n')[0].slice(0, 200)}`)
        // task_completed hook:外部感知任务完成(主会话自动汇报/流水线下一步)
        void this.opts.ctx.hooks?.fire('task_completed', {
          cwd: this.opts.ctx.cwd,
          stats: `task=${task.id} "${task.title.slice(0, 40)}" member=${memberName} status=${result.status}`,
        })
        return result.text
      })
      .catch((e) => {
        this.store.updateTask(group.name, task.id, { status: 'failed', result: `执行异常: ${(e as Error).message}` })
        this.mail.send(memberName, group.lead, `ERR 任务 ${task.id} 执行异常(协程死亡): ${(e as Error).message.slice(0, 200)}`)
        return `任务执行异常: ${(e as Error).message}`
      })
    const settled = await Promise.race([
      execPromise,
      new Promise<string>((r) => setTimeout(() => r('__TIMEOUT__'), 120000)),
    ])
    return settled === '__TIMEOUT__'
      ? `任务 ${task.id} 仍在执行中（成员 ${memberName}），稍后用 team_tasks 或 team_mail 查看结果`
      : settled
  }

  listTasks(groupName: string): TeamTask[] {
    return this.store.listTasks(groupName)
  }

  addTask(groupName: string, title: string, assignee?: string): TeamTask {
    const tasks = this.store.listTasks(groupName)
    const task: TeamTask = { id: `t${Date.now().toString(36)}`, title, status: 'todo', ...(assignee ? { assignee } : {}) }
    tasks.push(task)
    this.store.saveTasks(groupName, tasks)
    // task_created hook:外部感知任务创建(主会话可自动跟踪/汇报)
    void this.opts.ctx.hooks?.fire('task_created', {
      cwd: this.opts.ctx.cwd,
      stats: `task=${task.id} "${title.slice(0, 60)}"${assignee ? ` assignee=${assignee}` : ''}`,
    })
    return task
  }

  // 成员空闲标记（成员自己完成后调用）
  markMemberIdle(group: TeamGroup, name: string): void {
    const member = group.members.find((m) => m.name === name)
    if (member) member.status = 'idle'
    this.store.saveGroup(group)
  }

  // 全部完成后合并各成员 worktree：成员改动先 commit，再合并回主仓库
  async mergeAll(group: TeamGroup): Promise<string> {
    const results: string[] = []
    for (const member of group.members) {
      if (!this.worktrees) {
        results.push(`成员 ${member.name} 无 worktree 支持，跳过`)
        continue
      }
      const wtName = `member-${member.name}`
      try {
        const info = await this.worktrees.exit(wtName)
        if (!info.dirty) {
          results.push(`成员 ${member.name} 无变更，跳过`)
          continue
        }
        // 先提交成员 worktree 内的改动（merge 只能合 commit）
        const add = await git(['-C', info.path, 'add', '-A'])
        const commit = await git(['-C', info.path, 'commit', '-m', `team: ${member.name} changes`])
        if (add.code !== 0 || commit.code !== 0) {
          results.push(`✗ 成员 ${member.name} commit 失败: ${add.out || commit.out}`.slice(0, 150))
          continue
        }
        const res = await git(['merge', `wt-${wtName}`], this.repoRoot)
        if (res.code === 0) {
          results.push(`✓ 合并 ${member.name} 成功`)
        } else {
          // 冲突：先取冲突文件列表（abort 后 diff 看不到），再回滚（worktree 保留待人工处理）
          const conflicts = await git(['diff', '--name-only', '--diff-filter=U'], this.repoRoot)
          await git(['merge', '--abort'], this.repoRoot)
          const files = conflicts.out.trim()
          results.push(
            `✗ 合并 ${member.name} 冲突，已回滚（worktree ${wtName} 保留待处理）\n  冲突文件: ${files || '(未检测到)'}`,
          )
        }
      } catch (e) {
        results.push(`✗ 成员 ${member.name} 合并失败: ${(e as Error).message}`)
      }
    }
    return results.join('\n')
  }

  // coordinator 开启时 Lead 工具集：移除 write/edit（保留读 + run_command + spawn）
  createLeadTools(): ReturnType<ToolRegistry['toOpenAITools']> | null {
    if (!this.isCoordinator()) return null
    return this.opts.registry
      .toOpenAITools()
      .filter((t) => t.function.name !== 'write_file' && t.function.name !== 'edit_file')
  }
}

function readCoordinatorConfig(root: string): boolean {
  const file = join(root, 'team.yaml')
  if (!existsSync(file)) return false
  try {
    const cfg = parse(readFileSync(file, 'utf8')) as { coordinator_enabled?: boolean }
    return cfg.coordinator_enabled === true
  } catch {
    return false
  }
}

export { TeamGroupStore } from './group.ts'
export { TeamMail } from './mail.ts'
export { MemberHost } from './member.ts'
export type { TeamGroup, TeamMember, TeamTask, MailMessage } from './types.ts'
