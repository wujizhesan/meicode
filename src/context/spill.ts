import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { projectStatePath } from '../state-paths.ts'

// 对齐 Claude Code(>50KB 写盘留引用)：4KB 太激进——4-8KB 的普通结果
// 被替换成 [已存盘] 预览,模型看不到完整内容还得再读文件
export const SPILL_THRESHOLD = 51200 // 单条 >50KB 存盘
export const BATCH_THRESHOLD = 51200 // 同批合计 >50KB 挑大存盘
export const PREVIEW_LEN = 200

// 写存盘文件，返回相对 cwd 路径（对话内展示用）
export async function spillContent(content: string, cwd: string, seq: number): Promise<string> {
  const dir = projectStatePath(cwd, 'artifacts')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `spill_${Date.now()}_${seq}.txt`)
  await writeFile(file, content, 'utf8')
  return relative(cwd, file)
}

export function needsSpill(content: string): boolean {
  return Buffer.byteLength(content, 'utf8') > SPILL_THRESHOLD
}

// 批次处理：合计超阈值时按大小降序存盘，直到剩余合计 ≤ 阈值
export async function spillBatch(
  results: { content: string }[],
  cwd: string,
): Promise<{ content: string }[]> {
  const total = results.reduce((sum, r) => sum + Buffer.byteLength(r.content, 'utf8'), 0)
  // 单条超阈值（即使合计未超）也要存盘——否则 needsSpill 判定的条永远落不了盘
  if (total <= BATCH_THRESHOLD) {
    const out = [...results]
    for (let i = 0; i < out.length; i++) {
      if (Buffer.byteLength(out[i].content, 'utf8') > SPILL_THRESHOLD) {
        const path = await spillContent(out[i].content, cwd, i)
        out[i] = { content: `[已存盘] ${out[i].content.slice(0, PREVIEW_LEN)}…\n完整内容: ${path}` }
      }
    }
    return out
  }

  const order = results
    .map((r, i) => ({ i, size: Buffer.byteLength(r.content, 'utf8') }))
    .sort((a, b) => b.size - a.size)

  let remaining = total
  let seq = 0
  const spilled = new Set<number>()
  for (const { i } of order) {
    if (remaining <= BATCH_THRESHOLD) break
    remaining -= Buffer.byteLength(results[i].content, 'utf8')
    spilled.add(i)
  }

  const out = [...results]
  for (const i of spilled) {
    const path = await spillContent(out[i].content, cwd, seq++)
    const preview = out[i].content.slice(0, PREVIEW_LEN)
    out[i] = { content: `[已存盘] ${preview}…\n完整内容: ${path}` }
  }
  return out
}
