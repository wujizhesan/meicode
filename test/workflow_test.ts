// Workflow 系统测试：DSL 加载/校验/运行记录（对齐 Zcode .workflow.js DSL）
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadWorkflow, ensureWorkflowDirs, listWorkflows, workflowPath, WORKFLOW_TEMPLATE } from '../src/workflow/loader.ts'
import { validateWorkflowMeta } from '../src/workflow/validate.ts'
import { saveRun, loadRun, listRuns, runsDir } from '../src/workflow/store.ts'
import { runWorkflow, artifactsDir } from '../src/workflow/runner.ts'
import { SubAgentManager } from '../src/subagent/manager.ts'
import type { WorkflowMeta } from '../src/workflow/types.ts'
import type { Provider, StreamEvent } from '../src/provider/types.ts'

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
      phases: [{ title: 'p1', status: 'completed' as const, artifactPath: 'x.md' }],
      createdAt: Date.now(),
    }
    saveRun(TMP, rec)
    assert(loadRun(TMP, 'wf-test1')?.status === 'completed', '加载失败')
    assert(listRuns(TMP).some((r) => r.runId === 'wf-test1'), '列表缺失')
    assert(loadRun(TMP, 'nope') === null, '不存在应 null')
    assert(runsDir(TMP).includes('runs'), 'runsDir 路径错')
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
    assert(record.phases.every((p) => p.status === 'completed'), 'phase 未全完成')
    const a1 = join(artifactsDir(TMP), 'step-one.md')
    const a2 = join(artifactsDir(TMP), 'step-two.md')
    assert(existsSync(a1), `产物缺失: ${a1}`)
    assert(existsSync(a2), `产物缺失: ${a2}`)
    assert(progress.some((m) => m.includes('completed')), '进度未报告')
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
    assert(record.phases[0].status === 'completed', 'phase 未完成')
    assert(record.phases[0].agentId?.startsWith('wf-team-phase'), `agentId=${record.phases[0].agentId}`)
    // 成员已生成
    const g = manager.loadGroup('wf-' + TMP.split(/[\\/]/).pop())
    assert(g !== null, '团队组未创建')
  })

  rmSync(TMP, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('workflow 测试异常:', e)
  process.exit(1)
})
