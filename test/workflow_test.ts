// Workflow 系统测试：DSL 加载/校验/运行记录（对齐 Zcode .workflow.js DSL）
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadWorkflow, ensureWorkflowDirs, listWorkflows, workflowPath, WORKFLOW_TEMPLATE } from '../src/workflow/loader.ts'
import { validateWorkflowMeta } from '../src/workflow/validate.ts'
import { cancelRun, claimRun, saveRun, loadRun, listActiveRuns, listRuns, runsDir } from '../src/workflow/store.ts'
import { runWorkflow, artifactsDir } from '../src/workflow/runner.ts'
import { reconcileReadyWorkflowRuns } from '../src/workflow/coordinator.ts'
import { SubAgentManager } from '../src/subagent/manager.ts'
import { SubAgentStore } from '../src/subagent/store.ts'
import type { WorkflowMeta, WorkflowRunRecord } from '../src/workflow/types.ts'
import type { Provider, StreamEvent } from '../src/provider/types.ts'
import type { ToolContext } from '../src/tools/types.ts'

let passed = 0
let failed = 0
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`)
  }
}
const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg)
}

const TMP = join(import.meta.dirname, 'fixtures_wf')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
const { project } = ensureWorkflowDirs(TMP)

async function main() {
  // ---------- validate ----------
  await check('validate: 合法 meta 通过', () => {
    const issues = validateWorkflowMeta({ name: 'demo', description: 'd', phases: [{ title: 'p1', prompt: '任务' }] })
    assert(issues.length === 0, JSON.stringify(issues))
  })
  await check('validate: 缺 name/phases/title/prompt 拦截', () => {
    const issues = validateWorkflowMeta({ name: '', phases: [{ title: '', prompt: '' }] } as WorkflowMeta)
    assert(issues.some((i) => i.path === 'name'), '缺 name 未拦')
    assert(issues.some((i) => i.path === 'phases[0].title'), '缺 title 未拦')
    assert(issues.some((i) => i.path === 'phases[0].prompt'), '缺 prompt 未拦')
  })
  await check('validate: title 重复拦截 + agents 越界', () => {
    const issues = validateWorkflowMeta({
      name: 'x',
      phases: [
        { title: 'same', prompt: 'a' },
        { title: 'same', prompt: 'b' },
        { title: 'c', prompt: 'x', agents: 99 },
      ],
    })
    assert(issues.some((i) => i.message.includes('重复')), '重复未拦')
    assert(issues.some((i) => i.path === 'phases[2].agents'), 'agents 越界未拦')
  })

  // ---------- loader ----------
  await check('loader: 模板写入 + 加载 + 解析', async () => {
    const file = join(project, 'demo.workflow.js')
    writeFileSync(file, WORKFLOW_TEMPLATE.replace('NAME', 'demo').replace('DESC', '演示'), 'utf8')
    assert(workflowPath(TMP, 'demo') === file, '路径解析错')
    const meta = await loadWorkflow(TMP, 'demo')
    assert(meta.name === 'demo', `name=${meta.name}`)
    assert(meta.phases.length === 1 && meta.phases[0].title === 'phase1', 'phases 解析错')
    const list = listWorkflows(TMP)
    assert(list.includes('demo'), `list 缺 demo: ${list.join(',')}`)
    meta.phases[0].title = 'caller-mutation'
    assert((await loadWorkflow(TMP, 'demo')).phases[0].title === 'phase1', '模块导出被调用方污染')
    writeFileSync(file, "export const meta = { name: 'demo', description: 'hot', phases: [{ title: 'phase2', prompt: 'updated' }] }", 'utf8')
    assert((await loadWorkflow(TMP, 'demo')).phases[0].title === 'phase2', 'workflow 编辑后仍命中旧模块缓存')
  })
  await check('loader: 不存在/缺 meta 报错', async () => {
    let threw = false
    try {
      await loadWorkflow(TMP, 'missing')
    } catch {
      threw = true
    }
    assert(threw, '不存在应抛错')
    writeFileSync(join(project, 'bad.workflow.js'), 'export const notMeta = 1', 'utf8')
    threw = false
    try {
      await loadWorkflow(TMP, 'bad')
    } catch (e) {
      threw = (e as Error).message.includes('meta')
    }
    assert(threw, '缺 meta 应报错')
  })

  // ---------- store ----------
  await check('store: 保存/加载/列表', () => {
    const rec = {
      runId: 'wf-test1',
      workflow: 'demo',
      status: 'completed' as const,
      phases: [{ title: 'p1', status: 'completed' as const, artifactPath: 'x.md', agentIds: ['agent_one'] }],
      createdAt: Date.now(),
    }
    saveRun(TMP, rec)
    assert(loadRun(TMP, 'wf-test1')?.status === 'completed', '加载失败')
    assert(listRuns(TMP).some((r) => r.runId === 'wf-test1'), '列表缺失')
    const listed = listRuns(TMP)
    listed[0].phases[0].title = 'cache-poison'
    listed[0].phases[0].agentIds?.push('cache-poison')
    assert(listRuns(TMP)[0].phases[0].title !== 'cache-poison', '运行记录缓存被调用方污染')
    assert(listRuns(TMP)[0].phases[0].agentIds?.length === 1, '运行记录嵌套数组缓存被调用方污染')
    const file = join(runsDir(TMP), 'wf-test1.json')
    writeFileSync(file, readFileSync(file, 'utf8').replace('"workflow": "demo"', '"workflow": "next"'), 'utf8')
    assert(listRuns(TMP)[0].workflow === 'next', '同尺寸运行记录修改未使缓存失效')
    assert(loadRun(TMP, 'nope') === null, '不存在应 null')
    assert(loadRun(TMP, '../wf-test1') === null, '非法 runId 未拒绝')
    assert(runsDir(TMP).includes('runs'), 'runsDir 路径错')
  })
  await check('store: 错误结构隔离且非法 runId 拒绝写入', () => {
    mkdirSync(runsDir(TMP), { recursive: true })
    writeFileSync(join(runsDir(TMP), 'broken.json'), '{}', 'utf8')
    assert(!listRuns(TMP).some((run) => run.runId === 'broken'), '错误运行记录被接受')
    assert(readdirSync(runsDir(TMP)).some((file) => file.startsWith('broken.json.corrupt.')), '错误运行记录未隔离')
    let rejected = false
    try {
      saveRun(TMP, { runId: '../escape', workflow: 'bad', status: 'running', phases: [], createdAt: Date.now() })
    } catch {
      rejected = true
    }
    assert(rejected, '非法 runId 被写入')
  })
  await check('store: 运行目录删除后自动重建', () => {
    rmSync(runsDir(TMP), { recursive: true, force: true })
    saveRun(TMP, {
      runId: 'wf-recreated',
      workflow: 'demo',
      status: 'running',
      phases: [],
      createdAt: Date.now(),
    })
    assert(loadRun(TMP, 'wf-recreated')?.status === 'running', '运行目录未重建')
  })
  await check('store: 租约阻止重复接管且 revision 拒绝旧快照', () => {
    const record = loadRun(TMP, 'wf-recreated')!
    const stale = structuredClone(record)
    const claimed = claimRun(TMP, record, 'lease-a', 60000)
    let leaseRejected = false
    try {
      claimRun(TMP, claimed, 'lease-b', 60000)
    } catch (error) {
      leaseRejected = (error as Error).message.includes('其他执行者持有')
    }
    const cancelled = cancelRun(TMP, claimed.runId)
    let staleRejected = false
    try {
      stale.status = 'failed'
      saveRun(TMP, stale)
    } catch (error) {
      staleRejected = (error as Error).message.includes('其他执行者更新')
    }
    assert(leaseRejected && staleRejected && cancelled?.status === 'cancelled', '租约/CAS/取消状态不完整')
  })

  // ---------- runner e2e ----------
  class FakeWfProvider implements Provider {
    readonly protocol = 'openai' as const
    async *streamChat(): AsyncGenerator<StreamEvent> {
      yield { type: 'text', text: 'phase 执行输出' }
      yield { type: 'done' }
    }
  }
  await check('runner: 多 phase 执行 + artifacts 落盘 + 状态机', async () => {
    const subagents = new SubAgentManager({ builtin: join(TMP, 'no-roles'), user: join(TMP, 'no-roles'), project: join(TMP, 'no-roles') })
    const progress: string[] = []
    const record = await runWorkflow(
      {
        name: 'e2e',
        phases: [
          { title: 'step-one', prompt: '第一个 phase' },
          { title: 'step-two', prompt: '第二个 phase', agents: 2 },
        ],
      },
      {
        provider: new FakeWfProvider(),
        registry: { toOpenAITools: () => [] } as never,
        ctx: { cwd: TMP },
        subagents,
        onProgress: (m) => progress.push(m),
      },
    )
    assert(record.status === 'completed', `status=${record.status}`)
    assert(record.phases.length === 2, `phases=${record.phases.length}`)
    assert(record.phases.every((p) => p.status === 'completed'), `phase 未全完成: ${JSON.stringify(record.phases)}`)
    assert(record.phases.every((p) => p.agentId?.startsWith('agent_')), '未记录真实子 Agent ID')
    assert(record.phases[1].agentIds?.length === 2, '并行 phase 未记录全部 Agent ID')
    const a1 = join(artifactsDir(TMP), record.runId, 'step-one.md')
    const a2 = join(artifactsDir(TMP), record.runId, 'step-two.md')
    assert(existsSync(a1), `产物缺失: ${a1}`)
    assert(existsSync(a2), `产物缺失: ${a2}`)
    assert(progress.some((m) => m.includes('completed')), '进度未报告')
    assert(loadRun(TMP, record.runId)?.status === 'completed', 'runner 未自动持久化检查点')
  })
  await check('runner: 完整 ToolContext 与 sessionId 传入子 Agent 并持久化', async () => {
    let captured: ToolContext | undefined
    const permission = { mode: 'unattended' as const, engine: {} as never, autoAcceptEdits: true }
    const hooks = {} as ToolContext['hooks']
    const contextBudget = () => ({ used: 1, limit: 2, remaining: 1, ratio: 0.5 }) as never
    const ctx: ToolContext = {
      cwd: TMP,
      sessionId: 'session-workflow-context',
      timeoutMs: 4321,
      permission,
      hooks,
      contextBudget,
    }
    const subagents = {
      listRecords: () => [],
      getRecord: () => undefined,
      spawn: async (_request: unknown, options: { ctx: ToolContext }) => {
        captured = options.ctx
        return { id: 'agent_context', async: false, syncResult: 'done' }
      },
      cancel: () => true,
    }
    const record = await runWorkflow(
      { name: 'context-owner', phases: [{ title: 'context', prompt: 'context' }] },
      {
        provider: new FakeWfProvider(),
        registry: { toOpenAITools: () => [] } as never,
        ctx,
        subagents: subagents as never,
      },
    )
    assert(record.sessionId === ctx.sessionId && loadRun(TMP, record.runId)?.sessionId === ctx.sessionId, 'workflow 未持久化所属会话')
    assert(captured?.sessionId === ctx.sessionId && captured?.permission === permission && captured?.hooks === hooks
      && captured?.timeoutMs === 4321 && captured?.contextBudget === contextBudget, '子 Agent 未收到完整 ToolContext')
  })
  await check('runner: 中文 phase 产物不碰撞且不同运行相互隔离', async () => {
    const meta = { name: 'unicode', phases: [{ title: '阶段一', prompt: 'one' }, { title: '阶段二', prompt: 'two' }] }
    const opts = {
      provider: new FakeWfProvider(),
      registry: { toOpenAITools: () => [] } as never,
      ctx: { cwd: TMP },
      subagents: new SubAgentManager({ builtin: join(TMP, 'no-roles'), user: join(TMP, 'no-roles'), project: join(TMP, 'no-roles') }),
    }
    const first = await runWorkflow(meta, opts)
    const second = await runWorkflow(meta, opts)
    const firstPaths = first.phases.map((phase) => phase.artifactPath)
    assert(new Set(firstPaths).size === 2 && firstPaths.every((file) => file && existsSync(file)), `中文 phase 产物发生碰撞: ${JSON.stringify(first.phases)}`)
    assert(first.phases[0].artifactPath !== second.phases[0].artifactPath, '不同运行覆盖了同一产物')
  })
  await check('runner: 进度与检查点回调异常不污染状态机', async () => {
    const record = await runWorkflow(
      { name: 'callback-isolation', phases: [{ title: 'callback', prompt: 'callback' }] },
      {
        provider: new FakeWfProvider(),
        registry: { toOpenAITools: () => [] } as never,
        ctx: { cwd: TMP },
        subagents: new SubAgentManager({ builtin: join(TMP, 'no-roles'), user: join(TMP, 'no-roles'), project: join(TMP, 'no-roles') }),
        onProgress: () => Promise.reject(new Error('progress failed')),
        onCheckpoint: () => {
          throw new Error('checkpoint failed')
        },
      },
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert(record.status === 'completed', `回调异常污染状态: ${record.status}`)
  })
  await check('runner: 团队后端——phase 派 coroutine 成员执行', async () => {
    const { TeamManager } = await import('../src/team/index.ts')
    const { mkdirSync } = await import('node:fs')
    const teamRoot = join(TMP, 'team-root')
    mkdirSync(teamRoot, { recursive: true })
    const manager = new TeamManager(teamRoot, TMP, {
      provider: new FakeWfProvider(),
      registry: { toOpenAITools: () => [] } as never,
      ctx: { cwd: TMP },
    })
    const subagents = new SubAgentManager({ builtin: join(TMP, 'no-roles'), user: join(TMP, 'no-roles'), project: join(TMP, 'no-roles') })
    const record = await runWorkflow(
      { name: 'team-e2e', phases: [{ title: 'team-phase', prompt: '团队执行' }] },
      {
        provider: new FakeWfProvider(),
        registry: { toOpenAITools: () => [] } as never,
        ctx: { cwd: TMP },
        subagents,
        team: { manager },
        onProgress: () => {},
      },
    )
    assert(record.status === 'completed', `status=${record.status}`)
    assert(record.phases[0].status === 'completed', `phase 未完成: ${JSON.stringify(record.phases[0])}`)
    assert(record.phases[0].agentId?.startsWith('agent_'), `agentId=${record.phases[0].agentId}`)
    // 成员已生成
    const g = manager.loadGroup('wf-' + TMP.split(/[\\/]/).pop())
    assert(g !== null, '团队组未创建')
    assert(record.phases[0].agentId === g?.members[0]?.agentId, 'workflow 未记录真实团队 Agent ID')
  })
  await check('runner: 后台团队任务暂停 workflow 而非误报完成', async () => {
    const group = {
      name: 'wf-paused',
      lead: 'lead',
      members: [{ name: 'wf-slow', agentId: 'agent_real_slow', role: 'general-purpose', workdir: TMP, backend: 'coroutine', needsApproval: false, status: 'busy' }],
    }
    const tasks: Array<{ id: string; title: string; assignee: string; status: 'todo' | 'in_progress' | 'done' | 'failed'; result?: string }> = []
    const manager = {
      loadGroup: () => group,
      createGroup: () => group,
      getMember: () => ({}),
      spawnMember: async () => ({}),
      addTask: (_group: string, title: string, assignee: string) => {
        const task = { id: `task_${tasks.length + 1}`, title, assignee, status: 'todo' as const }
        tasks.push(task)
        return task
      },
      runTask: async (_group: unknown, task: (typeof tasks)[number]) => {
        if (task.title === 'slow') {
          task.status = 'in_progress'
          return '任务仍在执行中'
        }
        task.status = 'done'
        task.result = 'later done'
        return task.result
      },
      listTasks: () => tasks,
    }
    const subagents = new SubAgentManager({ builtin: join(TMP, 'no-roles'), user: join(TMP, 'no-roles'), project: join(TMP, 'no-roles') })
    const record = await runWorkflow(
      { name: 'paused', phases: [{ title: 'slow', prompt: 'slow' }, { title: 'later', prompt: 'later' }] },
      {
        provider: new FakeWfProvider(),
        registry: { toOpenAITools: () => [] } as never,
        ctx: { cwd: TMP },
        subagents,
        team: { manager: manager as never },
      },
    )
    assert(record.status === 'paused', `status=${record.status}`)
    assert(record.phases[0].status === 'paused' && record.phases[1].status === 'pending', `后台任务状态机错误: ${JSON.stringify(record.phases)}`)
    assert(record.phases[0].agentId === 'agent_real_slow', `agentId=${record.phases[0].agentId}`)
    assert(loadRun(TMP, record.runId)?.status === 'paused', 'paused 检查点未持久化')
    tasks[0].status = 'done'
    tasks[0].result = 'slow done'
    const resumed = await runWorkflow(
      { name: 'paused', phases: [{ title: 'slow', prompt: 'slow' }, { title: 'later', prompt: 'later' }] },
      {
        provider: new FakeWfProvider(),
        registry: { toOpenAITools: () => [] } as never,
        ctx: { cwd: TMP },
        subagents,
        team: { manager: manager as never },
      },
      record,
    )
    assert(resumed.status === 'completed' && resumed.phases.every((phase) => phase.status === 'completed'), 'paused workflow 未继续完成')
    assert(readFileSync(resumed.phases[0].artifactPath!, 'utf8').includes('slow done'), '恢复后未回填真实任务结果')
    let changedRejected = false
    try {
      await runWorkflow(
        { name: 'paused', phases: [{ title: 'slow', prompt: 'changed' }, { title: 'later', prompt: 'later' }] },
        {
          provider: new FakeWfProvider(),
          registry: { toOpenAITools: () => [] } as never,
          ctx: { cwd: TMP },
          subagents,
          team: { manager: manager as never },
        },
        record,
      )
    } catch (error) {
      changedRejected = (error as Error).message.includes('定义已修改')
    }
    assert(changedRejected, '定义改变后仍恢复旧 workflow')
  })

  await check('runner: 并行任务首错后取消并排空其他执行者', async () => {
    let spawned = 0
    const cancelled = new Set<string>()
    const waiters = new Map<string, (value: unknown) => void>()
    const subagents = {
      spawn: async () => ({ id: `agent_parallel_${++spawned}`, async: true }),
      waitFor: async (id: string) => {
        if (id.endsWith('_1')) {
          await new Promise<void>((resolve) => setImmediate(resolve))
          throw new Error('first failed')
        }
        if (cancelled.has(id)) return { record: { id, status: 'cancelled', error: 'cancelled' }, timedOut: false }
        return new Promise((resolve) => waiters.set(id, resolve))
      },
      cancel: (id: string) => {
        cancelled.add(id)
        waiters.get(id)?.({ record: { id, status: 'cancelled', error: 'cancelled' }, timedOut: false })
        return true
      },
      getRecord: () => undefined,
    }
    const record = await runWorkflow(
      { name: 'parallel-failure', phases: [{ title: 'parallel', prompt: 'parallel', agents: 2 }] },
      {
        provider: new FakeWfProvider(),
        registry: { toOpenAITools: () => [] } as never,
        ctx: { cwd: TMP },
        subagents: subagents as never,
      },
    )
    assert(record.status === 'failed' && record.phases[0].error === 'first failed', `record=${JSON.stringify(record)}`)
    assert(spawned === 2 && cancelled.has('agent_parallel_2'), '兄弟执行者未被取消或未等待收尾')
  })

  await check('runner: 派发槽位可找回已启动但尚未登记的子 Agent', async () => {
    const dispatchId = 'dispatch-existing'
    const interrupted: WorkflowRunRecord = {
      runId: 'wf-dispatch-existing',
      workflow: 'dispatch-existing',
      status: 'running',
      phases: [{
        title: 'dispatch',
        status: 'running',
        backend: 'subagent',
        dispatchSlots: [{ slot: 0, dispatchId, status: 'dispatching', backend: 'subagent' }],
      }],
      createdAt: Date.now(),
    }
    saveRun(TMP, interrupted)
    let spawned = 0
    const existingRecord = { id: 'agent_dispatch_existing', role: 'fork', type: 'fork' as const, status: 'done' as const, taskId: dispatchId, startedAt: 1, result: 'existing result' }
    const subagents = {
      listRecords: () => [existingRecord],
      getRecord: (id: string) => id === existingRecord.id ? existingRecord : undefined,
      spawn: async () => {
        spawned++
        return { id: 'agent_duplicate', async: false, syncResult: 'duplicate' }
      },
      cancel: () => true,
    }
    const resumed = await runWorkflow(
      { name: 'dispatch-existing', phases: [{ title: 'dispatch', prompt: 'dispatch' }] },
      {
        provider: new FakeWfProvider(),
        registry: { toOpenAITools: () => [] } as never,
        ctx: { cwd: TMP },
        subagents: subagents as never,
      },
      interrupted,
    )
    assert(resumed.status === 'completed' && spawned === 0, '恢复时重复派发了已存在的子 Agent')
    assert(resumed.phases[0].agentId === existingRecord.id && resumed.phases[0].dispatchSlots?.[0]?.status === 'settled', '派发槽位未回填执行 ID')
  })

  await check('runner: 新任务启动前先持久化派发意图', async () => {
    let intentPersisted = false
    const subagents = {
      listRecords: () => [],
      getRecord: () => undefined,
      spawn: async (request: { taskId?: string }) => {
        const run = listRuns(TMP, 100).find((item) => item.workflow === 'dispatch-intent')
        const slot = run?.phases[0]?.dispatchSlots?.[0]
        intentPersisted = Boolean(slot && slot.status === 'dispatching' && slot.dispatchId === request.taskId)
        return { id: 'agent_dispatch_intent', async: false, syncResult: 'intent result' }
      },
      cancel: () => true,
    }
    const record = await runWorkflow(
      { name: 'dispatch-intent', phases: [{ title: 'dispatch', prompt: 'dispatch' }] },
      {
        provider: new FakeWfProvider(),
        registry: { toOpenAITools: () => [] } as never,
        ctx: { cwd: TMP },
        subagents: subagents as never,
      },
    )
    assert(record.status === 'completed' && intentPersisted, '子任务启动前未写入可恢复派发意图')
  })

  await check('runner: 派发前中断的空槽位沿用原 dispatchId', async () => {
    const dispatchId = 'dispatch-empty'
    const interrupted: WorkflowRunRecord = {
      runId: 'wf-dispatch-empty',
      workflow: 'dispatch-empty',
      status: 'running',
      phases: [{
        title: 'dispatch',
        status: 'running',
        backend: 'subagent',
        dispatchSlots: [{ slot: 0, dispatchId, status: 'dispatching', backend: 'subagent' }],
      }],
      createdAt: Date.now(),
    }
    saveRun(TMP, interrupted)
    const dispatched: string[] = []
    const subagents = {
      listRecords: () => [],
      getRecord: () => undefined,
      spawn: async (request: { taskId?: string }) => {
        dispatched.push(request.taskId ?? '')
        return { id: 'agent_dispatch_new', async: false, syncResult: 'new result' }
      },
      cancel: () => true,
    }
    const resumed = await runWorkflow(
      { name: 'dispatch-empty', phases: [{ title: 'dispatch', prompt: 'dispatch' }] },
      {
        provider: new FakeWfProvider(),
        registry: { toOpenAITools: () => [] } as never,
        ctx: { cwd: TMP },
        subagents: subagents as never,
      },
      interrupted,
    )
    assert(resumed.status === 'completed' && dispatched.length === 1 && dispatched[0] === dispatchId, '空槽位恢复时未沿用持久化 dispatchId')
  })

  await check('runner: 持久化取消立即终止活动子任务', async () => {
    let agentId = ''
    let runId = ''
    let resolveWait: ((value: unknown) => void) | undefined
    const subagents = {
      spawn: async () => {
        agentId = 'agent_cancel_active'
        return { id: agentId, async: true }
      },
      waitFor: async () => new Promise((resolve) => (resolveWait = resolve)),
      cancel: (id: string) => {
        if (id !== agentId) return false
        resolveWait?.({ record: { id, status: 'cancelled', error: 'cancelled' }, timedOut: false })
        return true
      },
      getRecord: () => undefined,
    }
    const execution = runWorkflow(
      { name: 'cancel-active', phases: [{ title: 'cancel', prompt: 'cancel' }] },
      {
        provider: new FakeWfProvider(),
        registry: { toOpenAITools: () => [] } as never,
        ctx: { cwd: TMP },
        subagents: subagents as never,
        onCheckpoint: (record) => (runId = record.runId),
      },
    )
    while (!resolveWait) await new Promise<void>((resolve) => setImmediate(resolve))
    const cancelled = cancelRun(TMP, runId)
    subagents.cancel(agentId)
    const record = await execution
    assert(cancelled?.status === 'cancelled' && record.status === 'cancelled', '活动 workflow 未保持取消终态')
  })

  await check('coordinator: 子任务完成后自动续跑 paused workflow', async () => {
    writeFileSync(join(project, 'auto.workflow.js'), "export const meta = { name: 'auto', phases: [{ title: 'auto-phase', prompt: 'auto' }] }", 'utf8')
    const paused = {
      runId: 'wf-auto-resume',
      workflow: 'auto',
      status: 'paused' as const,
      phases: [{ title: 'auto-phase', status: 'paused' as const, backend: 'subagent' as const, agentId: 'agent_auto', agentIds: ['agent_auto'] }],
      createdAt: Date.now(),
      finishedAt: Date.now(),
    }
    saveRun(TMP, paused)
    const subagents = {
      getRecord: () => ({ id: 'agent_auto', role: 'fork', type: 'fork', status: 'done', startedAt: 1, result: 'auto done' }),
    }
    const records = await reconcileReadyWorkflowRuns({
      cwd: TMP,
      provider: new FakeWfProvider(),
      registry: { toOpenAITools: () => [] } as never,
      ctx: { cwd: TMP },
      subagents: subagents as never,
    })
    assert(records.some((record) => record.runId === paused.runId && record.status === 'completed'), '自动协调器未完成 paused workflow')
  })

  await check('coordinator: 切换会话后仍按 workflow 原会话恢复子任务', async () => {
    const ownedRoot = join(TMP, 'session-owned-recovery')
    const { project: ownedProject } = ensureWorkflowDirs(ownedRoot)
    writeFileSync(join(ownedProject, 'owned.workflow.js'), "export const meta = { name: 'owned', phases: [{ title: 'owned-phase', prompt: 'owned' }] }", 'utf8')
    const storeRoot = join(ownedRoot, '.meicode', 'subagents')
    const oldStore = new SubAgentStore(storeRoot, 'session-old')
    oldStore.save({
      id: 'agent-owned-old',
      role: 'fork',
      type: 'fork',
      status: 'done',
      sessionId: 'session-old',
      startedAt: 1,
      finishedAt: 2,
      result: 'old session done',
    })
    const subagents = new SubAgentManager({ builtin: join(TMP, 'none'), user: join(TMP, 'none'), project: join(TMP, 'none') }, null, oldStore)
    subagents.setSession('session-new')
    saveRun(ownedRoot, {
      runId: 'wf-session-owned',
      workflow: 'owned',
      sessionId: 'session-old',
      backend: 'subagent',
      status: 'paused',
      phases: [{ title: 'owned-phase', status: 'paused', backend: 'subagent', agentId: 'agent-owned-old', agentIds: ['agent-owned-old'] }],
      createdAt: Date.now(),
    })
    const records = await reconcileReadyWorkflowRuns({
      cwd: ownedRoot,
      provider: new FakeWfProvider(),
      registry: { toOpenAITools: () => [] } as never,
      ctx: { cwd: ownedRoot, sessionId: 'session-new' },
      subagents,
    })
    assert(records[0]?.status === 'completed' && records[0]?.sessionId === 'session-old', 'workflow 未按原会话恢复')
    assert(!subagents.getRecord('agent-owned-old') && subagents.getRecord('agent-owned-old', 'session-old')?.status === 'done', '当前会话隔离或原会话查询失效')
    await subagents.close()
  })

  await check('coordinator: 子任务记录丢失时进入显式失败而非静默卡住', async () => {
    const missingRoot = join(TMP, 'missing-child-record')
    let settledStatus = ''
    saveRun(missingRoot, {
      runId: 'wf-missing-child',
      workflow: 'missing-child',
      backend: 'subagent',
      status: 'paused',
      phases: [{ title: 'phase', status: 'paused', backend: 'subagent', agentId: 'agent-gone', agentIds: ['agent-gone'] }],
      createdAt: Date.now(),
    })
    const records = await reconcileReadyWorkflowRuns({
      cwd: missingRoot,
      provider: new FakeWfProvider(),
      registry: { toOpenAITools: () => [] } as never,
      ctx: { cwd: missingRoot },
      subagents: { getRecord: () => undefined } as never,
      onSettled: (record) => { settledStatus = record.status },
    }, {
      load: async () => ({ name: 'missing-child', phases: [{ title: 'phase', prompt: 'phase' }] }),
    })
    const failed = loadRun(missingRoot, 'wf-missing-child')
    assert(records[0]?.status === 'failed' && failed?.status === 'failed' && settledStatus === 'failed' && failed.phases[0].error?.includes('找不到原子 Agent 记录'), '丢失子任务记录未转为可见失败')
  })

  await check('coordinator: 就绪探测异常进入退避而非击穿整轮协调', async () => {
    const readinessRoot = join(TMP, 'readiness-failure')
    saveRun(readinessRoot, {
      runId: 'wf-readiness-failure',
      workflow: 'readiness-failure',
      backend: 'subagent',
      status: 'paused',
      phases: [{ title: 'phase', status: 'paused', backend: 'subagent', agentId: 'agent-read', agentIds: ['agent-read'] }],
      createdAt: Date.now(),
    })
    let surfaced = ''
    await reconcileReadyWorkflowRuns({
      cwd: readinessRoot,
      provider: new FakeWfProvider(),
      registry: { toOpenAITools: () => [] } as never,
      ctx: { cwd: readinessRoot },
      subagents: { getRecord: () => { throw new Error('readiness injected') } } as never,
      onError: (_record, error) => { surfaced = error.message },
    })
    const record = loadRun(readinessRoot, 'wf-readiness-failure')
    assert(record?.reconcileAttempts === 1 && surfaced === 'readiness injected', '就绪探测异常未被隔离并记录退避')
  })

  await check('runner: 续租失败暂停等待恢复而不误报用户取消', async () => {
    let resolveWait: ((value: unknown) => void) | undefined
    const subagents = {
      spawn: async () => ({ id: 'agent-lease-failure', async: true }),
      waitFor: async () => new Promise((resolve) => { resolveWait = resolve }),
      cancel: () => {
        resolveWait?.({ record: { id: 'agent-lease-failure', status: 'cancelled', error: 'cancelled' }, timedOut: false })
        return true
      },
      getRecord: () => ({ id: 'agent-lease-failure', status: 'running' }),
      listRecords: () => [],
    }
    let runId = ''
    let rejected = ''
    try {
      await runWorkflow(
        { name: 'lease-failure', phases: [{ title: 'phase', prompt: 'phase' }] },
        {
          provider: new FakeWfProvider(),
          registry: { toOpenAITools: () => [] } as never,
          ctx: { cwd: TMP },
          subagents: subagents as never,
          onCheckpoint: (record) => { runId = record.runId },
        },
        undefined,
        { renewLease: () => false, heartbeatMs: 5 },
      )
    } catch (error) {
      rejected = (error as Error).message
    }
    const record = loadRun(TMP, runId)
    assert(rejected.includes('执行租约已失效') && record?.status === 'paused' && record.phases[0].status === 'paused', '续租失败被误记为取消或未保留可恢复状态')
  })

  await check('store: 非终态索引不受最近 100 条限制', () => {
    const indexRoot = join(TMP, 'active-index')
    for (let index = 0; index < 105; index++) {
      saveRun(indexRoot, {
        runId: `wf-active-${index}`,
        workflow: `missing-${index}`,
        status: 'paused',
        phases: [{ title: 'pending', status: 'pending' }],
        createdAt: index + 1,
      })
    }
    assert(listActiveRuns(indexRoot).length === 105, '活动索引遗漏了第 101 条之后的 workflow')
    cancelRun(indexRoot, 'wf-active-0')
    assert(listActiveRuns(indexRoot).length === 104, '终态 workflow 未从活动索引移除')
  })

  await check('coordinator: 恢复失败指数退避并在阈值后等待人工处理', async () => {
    const backoffRoot = join(TMP, 'reconcile-backoff')
    saveRun(backoffRoot, {
      runId: 'wf-backoff',
      workflow: 'missing-workflow',
      status: 'paused',
      phases: [{ title: 'pending', status: 'pending' }],
      createdAt: Date.now(),
    })
    let surfaced = 0
    for (let attempt = 1; attempt <= 5; attempt++) {
      await reconcileReadyWorkflowRuns({
        cwd: backoffRoot,
        provider: new FakeWfProvider(),
        registry: { toOpenAITools: () => [] } as never,
        ctx: { cwd: backoffRoot },
        subagents: { getRecord: () => undefined } as never,
        onError: () => { surfaced++ },
      })
      const current = loadRun(backoffRoot, 'wf-backoff')!
      assert(current.reconcileAttempts === attempt, `恢复失败计数错误: ${current.reconcileAttempts}`)
      if (attempt < 5) {
        current.nextReconcileAt = 0
        saveRun(backoffRoot, current)
      }
    }
    const blocked = loadRun(backoffRoot, 'wf-backoff')!
    assert(blocked.reconcileBlocked && blocked.nextReconcileAt === undefined && surfaced === 5, '恢复失败未进入人工处理状态')
    await reconcileReadyWorkflowRuns({
      cwd: backoffRoot,
      provider: new FakeWfProvider(),
      registry: { toOpenAITools: () => [] } as never,
      ctx: { cwd: backoffRoot },
      subagents: { getRecord: () => undefined } as never,
      onError: () => { surfaced++ },
    })
    assert(surfaced === 5, '人工处理状态仍被自动重试')
  })

  await check('coordinator: 单轮自动恢复并发不超过 2', async () => {
    const concurrencyRoot = join(TMP, 'reconcile-concurrency')
    for (let index = 0; index < 3; index++) {
      saveRun(concurrencyRoot, {
        runId: `wf-concurrency-${index}`,
        workflow: `missing-concurrency-${index}`,
        status: 'paused',
        phases: [{ title: 'pending', status: 'pending' }],
        createdAt: index + 1,
      })
    }
    await reconcileReadyWorkflowRuns({
      cwd: concurrencyRoot,
      provider: new FakeWfProvider(),
      registry: { toOpenAITools: () => [] } as never,
      ctx: { cwd: concurrencyRoot },
      subagents: { getRecord: () => undefined } as never,
    })
    const attempts = listActiveRuns(concurrencyRoot).map((record) => record.reconcileAttempts ?? 0)
    assert(attempts.filter((value) => value === 1).length === 2 && attempts.filter((value) => value === 0).length === 1, `并发上限失效: ${attempts.join(',')}`)
  })

  await check('coordinator: 团队后端缺失时进入退避而非永久静默', async () => {
    const missingTeamRoot = join(TMP, 'missing-team-backend')
    saveRun(missingTeamRoot, {
      runId: 'wf-missing-team',
      workflow: 'team-only',
      backend: 'team',
      status: 'paused',
      phases: [{ title: 'team-phase', status: 'pending' }],
      createdAt: Date.now(),
    })
    let surfaced = ''
    await reconcileReadyWorkflowRuns({
      cwd: missingTeamRoot,
      provider: new FakeWfProvider(),
      registry: { toOpenAITools: () => [] } as never,
      ctx: { cwd: missingTeamRoot },
      subagents: { getRecord: () => undefined } as never,
      onError: (_record, error) => { surfaced = error.message },
    })
    const failed = loadRun(missingTeamRoot, 'wf-missing-team')
    assert(failed?.reconcileAttempts === 1 && Boolean(failed.nextReconcileAt) && surfaced.includes('团队系统未启用'), '缺少团队后端未进入可见退避状态')
  })

  await check('coordinator: 活动索引故障由顶层回调隔离', async () => {
    let surfaced = ''
    const records = await reconcileReadyWorkflowRuns({
      cwd: TMP,
      provider: new FakeWfProvider(),
      registry: { toOpenAITools: () => [] } as never,
      ctx: { cwd: TMP },
      subagents: { getRecord: () => undefined } as never,
      onCoordinatorError: (error) => { surfaced = error.message },
    }, {
      listActive: () => { throw new Error('injected index failure') },
    })
    assert(records.length === 0 && surfaced === 'injected index failure', '协调器顶层故障未被隔离')
  })

  rmSync(TMP, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('workflow 测试异常:', e)
  process.exit(1)
})
