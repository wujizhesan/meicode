// 会话级开关指令的轮次注入策略：首轮与每 3 轮全量，其余精简
const FULL_PLAN = `当前处于计划模式：只允许使用读类工具（read_file / find_files / grep_code），输出步骤化计划，禁止修改、写入或执行命令。调查完成后提示用户用 /mode default（或 edits/yolo）切换回执行模式继续。`

const SLIM_PLAN = '计划模式：仅读类工具，禁止修改。'

const FULL_EXEC = '当前处于执行模式：全部工具可用，按用户需求执行任务。'

const SLIM_EXEC = '执行模式：全工具可用。'

export function sessionDirective(mode: 'plan' | 'full', round: number): string | null {
  const full = mode === 'plan' ? FULL_PLAN : FULL_EXEC
  const slim = mode === 'plan' ? SLIM_PLAN : SLIM_EXEC
  if (round === 1 || round % 3 === 1) return full
  return slim
}
