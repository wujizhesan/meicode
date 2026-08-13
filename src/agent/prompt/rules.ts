// 关键规则单一来源：系统提示模块与工具 description 双重强化
export const KEY_RULES = {
  preferTools: '优先使用专用工具：能调用工具完成的任务必须调用工具，不要声称做不到',
  readBeforeEdit: '编辑文件前必须先读取该文件，确认原文上下文',
  retryOnFailure: '工具执行失败时，根据错误信息调整参数重试，或如实报告失败原因',
} as const
