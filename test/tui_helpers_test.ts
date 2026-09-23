import { createAppCommandRegistry } from '../src/tui/command-registry.ts'
import { cancelWorkflowExecutions, createTeamAction, createWorkflowAction } from '../src/tui/command-actions.ts'
import { appendStreamChunk, formatRoundTools, formatSessionList, stopReasonError } from '../src/tui/stream-presentation.ts'
import { moveCompletionIndex, selectedCompletion } from '../src/tui/completion.ts'
import type { UiController } from '../src/commands/index.ts'
import type { SkillManager } from '../src/skill/index.ts'
import type { SubAgentManager } from '../src/subagent/index.ts'
import type { TeamManager } from '../src/team/index.ts'
import type { ToolRegistry } from '../src/tools/index.ts'
import type { Provider } from '../src/provider/types.ts'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listRuns, saveRun } from '../src/workflow/store.ts'
import type { WorkflowRunRecord } from '../src/workflow/types.ts'

const calls: string[] = []
const skills = {
  list: () => [
    { name: 'focused-review', description: 'Review changes', mode: 'shared', content: '', source: 'project' },
    { name: 'help', description: 'Conflicts with builtin', mode: 'shared', content: '', source: 'project' },
  ],
} as unknown as SkillManager
const registry = createAppCommandRegistry(skills)
if (!registry.find('help')) throw new Error('builtin commands were not registered')
const skillCommand = registry.find('focused-review')
if (!skillCommand) throw new Error('skill command was not registered')
await skillCommand.handler(['src'], {
  skillActivate: (name: string) => {
    calls.push(`activate:${name}`)
    return name
  },
  sendUserMessage: (text: string) => calls.push(`send:${text}`),
} as unknown as UiController)
if (calls[0] !== 'activate:focused-review' || !calls[1]?.includes('执行 Skill focused-review：src')) {
  throw new Error(`skill command dispatch mismatch: ${calls.join(', ')}`)
}

if (formatSessionList([]) !== '暂无会话记录') throw new Error('empty session list formatting changed')
const sessions = formatSessionList([{ id: 'session-1', count: 3, mtime: 0 }])
if (!sessions.includes('session-1') || !sessions.includes('3 条')) throw new Error('session list details missing')

const tools = formatRoundTools([
  { id: '1', name: 'read_file', status: 'ok' },
  { id: '2', name: 'run_command', status: 'fail' },
])
if (tools !== '🔧 [2] read_file ✓ · run_command ✗') throw new Error(`tool summary mismatch: ${tools}`)

const messages = [{ role: 'assistant' as const, text: 'a', thinking: 'x' }]
const appended = appendStreamChunk(messages, 'b', 'y')
if (appended === messages || appended[0].text !== 'ab' || appended[0].thinking !== 'xy') {
  throw new Error('stream chunk append mismatch')
}
if (appendStreamChunk([], 'orphan', '')[0]) throw new Error('orphan stream chunk created a message')

if (stopReasonError('complete', 1) !== null) throw new Error('complete should not create an error')
if (stopReasonError('max_iterations', 15) !== '达到迭代上限（15 轮）') throw new Error('round limit error mismatch')
if (stopReasonError('tool_failures', 2, 'custom') !== 'custom') throw new Error('provider error was not preserved')

const completionCandidates = ['/memory', '/mode']
if (moveCompletionIndex(0, completionCandidates.length, -1) !== 1) throw new Error('补全菜单向上未循环')
if (moveCompletionIndex(1, completionCandidates.length, 1) !== 0) throw new Error('补全菜单向下未循环')
if (selectedCompletion(completionCandidates, 1)?.value !== '/mode ') throw new Error('补全选中项未生成回填请求')
if (selectedCompletion([], 0) !== null) throw new Error('空补全列表不应生成回填请求')

if (createTeamAction(null, () => {})('list', []) !== '团队系统未启用') throw new Error('disabled team message changed')
const team = { listGroups: () => ['core'] } as unknown as TeamManager
if (createTeamAction(team, () => {})('list', []) !== '小组: core') throw new Error('team list action mismatch')
let teamFailure = ''
const failingTeam = {
  loadGroup: () => ({}),
  spawnMember: async () => { throw new Error('offline') },
} as unknown as TeamManager
createTeamAction(failingTeam, (message) => { teamFailure = message })('spawn', ['core', 'worker', 'qa'])
await new Promise<void>((resolve) => setImmediate(resolve))
if (teamFailure !== '派生成员失败: offline') throw new Error('async team failure was not surfaced')

const root = mkdtempSync(join(tmpdir(), 'meicode-workflow-action-'))
try {
  const getContext = () => ({ cwd: root, sessionId: 'session-action' })
  const workflowAction = createWorkflowAction({
    cwd: root,
    provider: {} as Provider,
    registry: {} as ToolRegistry,
    subAgentManager: {} as SubAgentManager,
    getContext,
    notify: () => {},
  })
  if (!workflowAction('create', ['../escape']).includes('仅允许')) throw new Error('unsafe workflow name was accepted')
  const created = workflowAction('create', ['release-check'])
  if (!created.startsWith('已创建:') || !existsSync(join(root, '.meicode', 'workflows', 'release-check.workflow.js'))) {
    throw new Error(`workflow definition was not created safely: ${created}`)
  }
  if (!workflowAction('run', ['release-check', '--team']).includes('团队系统未启用')) {
    throw new Error('缺少团队系统时接受了 --team')
  }

  const teamRunMessages: string[] = []
  const teamTasks: Array<{ id: string; dispatchId?: string; status: 'todo' | 'done'; result?: string }> = []
  const workflowTeam = {
    loadGroup: () => null,
    createGroup: (name: string, lead: string) => ({ name, lead, members: [] as Array<{ name: string; agentId: string }> }),
    getMember: () => undefined,
    spawnMember: async (group: { members: Array<{ name: string; agentId: string }> }, name: string) => {
      group.members.push({ name, agentId: `agent-${name}` })
    },
    addTask: (_group: string, _prompt: string, _member: string, _dependencies: string[], _attempts: number, dispatchId: string) => {
      const task = { id: `task-${teamTasks.length + 1}`, dispatchId, status: 'todo' as const }
      teamTasks.push(task)
      return task
    },
    runTask: async (_group: unknown, task: { id: string }) => {
      const current = teamTasks.find((item) => item.id === task.id)!
      current.status = 'done'
      current.result = 'team done'
      return current.result
    },
    listTasks: () => teamTasks,
    cancelTask: () => true,
  } as unknown as TeamManager
  const teamWorkflowAction = createWorkflowAction({
    cwd: root,
    provider: {} as Provider,
    registry: {} as ToolRegistry,
    subAgentManager: {} as SubAgentManager,
    teamManager: workflowTeam,
    getContext,
    notify: (message) => teamRunMessages.push(message),
  })
  const teamStart = teamWorkflowAction('run', ['release-check', '--team'])
  if (!teamStart.includes('团队后端')) throw new Error(`--team 启动提示错误: ${teamStart}`)
  for (let i = 0; i < 20 && !teamRunMessages.some((message) => message.includes('completed')); i++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  const teamRun = listRuns(root).find((run) => run.workflow === 'release-check')
  if (!teamRunMessages.some((message) => message.includes('completed')) || teamRun?.backend !== 'team' || teamRun.sessionId !== 'session-action') {
    throw new Error(`--team 未使用并持久化团队后端: ${teamRunMessages.join(' | ')}`)
  }

  writeFileSync(
    join(root, '.meicode', 'workflows', 'snapshot-race.workflow.js'),
    "export const meta = { name: 'snapshot-race', phases: [{ title: 'snapshot', prompt: 'snapshot' }] }",
    'utf8',
  )
  const sharedContext = { cwd: root, sessionId: 'session-before-load' }
  const snapshotMessages: string[] = []
  const snapshotAction = createWorkflowAction({
    cwd: root,
    provider: {} as Provider,
    registry: {} as ToolRegistry,
    subAgentManager: {} as SubAgentManager,
    teamManager: workflowTeam,
    getContext: () => sharedContext,
    notify: (message) => snapshotMessages.push(message),
  })
  snapshotAction('run', ['snapshot-race', '--team'])
  sharedContext.sessionId = 'session-after-load'
  for (let i = 0; i < 20 && !snapshotMessages.some((message) => message.includes('completed')); i++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  const snapshotRun = listRuns(root).find((run) => run.workflow === 'snapshot-race')
  if (snapshotRun?.sessionId !== 'session-before-load') {
    throw new Error(`workflow 启动上下文未同步快照: ${snapshotRun?.sessionId}`)
  }

  writeFileSync(join(root, '.meicode', 'workflows', 'team-resume.workflow.js'), "export const meta = { name: 'team-resume', phases: [{ title: 'team-phase', prompt: 'resume' }] }", 'utf8')
  const pausedTeamRun: WorkflowRunRecord = {
    runId: 'wf-team-resume',
    workflow: 'team-resume',
    status: 'paused',
    phases: [{
      title: 'team-phase',
      status: 'paused',
      backend: 'team',
      teamGroup: 'wf-test',
      taskIds: ['task-existing'],
      dispatchSlots: [{ slot: 0, dispatchId: 'dispatch-existing', status: 'running', backend: 'team', taskId: 'task-existing', teamGroup: 'wf-test' }],
    }],
    createdAt: Date.now(),
  }
  saveRun(root, pausedTeamRun)
  const disabledResume = createWorkflowAction({
    cwd: root,
    provider: {} as Provider,
    registry: {} as ToolRegistry,
    subAgentManager: { getRecord: () => undefined } as unknown as SubAgentManager,
    getContext,
    notify: () => {},
  })('resume', [pausedTeamRun.runId])
  if (!disabledResume.includes('团队系统未启用')) throw new Error('团队 workflow 在缺少团队后端时仍尝试恢复')

  let resumedMessage = ''
  const resumableTeam = {
    listTasks: () => [{ id: 'task-existing', dispatchId: 'dispatch-existing', status: 'done', result: 'done' }],
  } as unknown as TeamManager
  const resumeAction = createWorkflowAction({
    cwd: root,
    provider: {} as Provider,
    registry: {} as ToolRegistry,
    subAgentManager: { getRecord: () => undefined } as unknown as SubAgentManager,
    teamManager: resumableTeam,
    getContext,
    notify: (message) => { resumedMessage = message },
  })
  resumeAction('resume', [pausedTeamRun.runId])
  for (let i = 0; i < 10 && !resumedMessage.includes('completed'); i++) await new Promise<void>((resolve) => setImmediate(resolve))
  if (!resumedMessage.includes('completed')) throw new Error(`团队 workflow 手动恢复未接入团队后端: ${resumedMessage}`)

  const cancelledAgents: string[] = []
  const cancelledSessions: Array<string | undefined> = []
  const cancelledTasks: string[] = []
  cancelWorkflowExecutions({
    runId: 'wf-token-cancel',
    workflow: 'token-cancel',
    status: 'cancelled',
    sessionId: 'session-cancel',
    createdAt: Date.now(),
    phases: [{
      title: 'token',
      status: 'cancelled',
      dispatchSlots: [
        { slot: 0, dispatchId: 'dispatch-agent', status: 'dispatching', backend: 'subagent' },
        { slot: 1, dispatchId: 'dispatch-team', status: 'dispatching', backend: 'team', teamGroup: 'token-group' },
      ],
    }],
  }, {
    listRecords: () => [{ id: 'agent-by-token', taskId: 'dispatch-agent' }],
    cancel: (id: string, sessionId?: string) => { cancelledAgents.push(id); cancelledSessions.push(sessionId); return true },
  } as unknown as SubAgentManager, {
    listTasks: () => [{ id: 'task-by-token', dispatchId: 'dispatch-team' }],
    cancelTask: (_group: string, id: string) => { cancelledTasks.push(id); return true },
  } as unknown as TeamManager)
  if (cancelledAgents[0] !== 'agent-by-token' || cancelledSessions[0] !== 'session-cancel' || cancelledTasks[0] !== 'task-by-token') {
    throw new Error('workflow 取消未按 dispatch token 找回执行实体')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('tui_helpers_test passed')
