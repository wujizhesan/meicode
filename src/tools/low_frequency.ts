import type { Tool } from './types.ts'

export const browserTool: Tool = {
  name: 'browser',
  description:
    '浏览器自动化(系统 Edge): launch=启动浏览器; navigate url=<地址> 打开页面; eval expr=<JS表达式> 执行并返回结果; shot path=<输出png> 截图(配合 shot_diff 对比); click sel=<CSS选择器> 点击; close=关闭。采集/验证/复刻通用。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'launch / navigate / eval / shot / click / close' },
      url: { type: 'string', description: 'navigate 用:目标地址' },
      expr: { type: 'string', description: 'eval 用:JS 表达式(如 document.title / document.querySelector(...).innerText)' },
      path: { type: 'string', description: 'shot 用:输出 PNG 路径' },
      sel: { type: 'string', description: 'click 用:CSS 选择器' },
      headless: { type: 'boolean', description: 'launch 用:无头模式(默认 true)' },
    },
    required: ['action'],
  },
  async execute(args, ctx) {
    const { browserTool } = await import('./browser.ts')
    return browserTool.execute(args, ctx)
  },
}

export const shotDiffTool: Tool = {
  name: 'shot_diff',
  description:
    '对比两张 PNG 截图（复刻验证用）。base=基准图(原版) target=对比图(复刻) out=diff图输出路径(默认 <target>.diff.png)。输出 diff 百分比、差异区域包围盒与差异像素数。对比前确保关动画、同视口同数据。',
  parameters: {
    type: 'object',
    properties: {
      base: { type: 'string', description: '基准图路径（原版截图）' },
      target: { type: 'string', description: '对比图路径（复刻截图）' },
      out: { type: 'string', description: 'diff 图输出路径（默认 <target>.diff.png）' },
      threshold: { type: 'number', description: '像素差异阈值 0-1（默认 0.1）' },
    },
    required: ['base', 'target'],
  },
  async execute(args, ctx) {
    const { shotDiffTool } = await import('./shot_diff.ts')
    return shotDiffTool.execute(args, ctx)
  },
}

export const snapshotTool: Tool = {
  name: 'snapshot',
  description:
    '把当前工作区状态存为快照(git commit + tag snap-<ts>)。label=备注(可选)。快照后可用 rollback 回滚到该状态。关键修改前调用,改错能回头。',
  parameters: {
    type: 'object',
    properties: { label: { type: 'string', description: '快照备注(可选)' } },
  },
  async execute(args, ctx) {
    const { snapshotTool } = await import('./snapshot.ts')
    return snapshotTool.execute(args, ctx)
  },
}

export const rollbackTool: Tool = {
  name: 'rollback',
  description:
    '回滚到快照(三阶段): stage=恢复文件到快照状态(当前未提交修改存 .mewcode/rollback.patch 可找回); clear=取消回滚(恢复 stage 前状态); commit=确认回滚。tag=快照名(如 snap-xxx)。',
  parameters: {
    type: 'object',
    properties: {
      tag: { type: 'string', description: '快照名(如 snap-xxx)' },
      action: { type: 'string', description: 'stage / clear / commit' },
    },
    required: ['tag', 'action'],
  },
  async execute(args, ctx) {
    const { rollbackTool } = await import('./snapshot.ts')
    return rollbackTool.execute(args, ctx)
  },
}
