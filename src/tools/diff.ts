/**
 * 极简 unified diff：只解决「让前端把改了什么画成红绿」这一件事。
 * 不追求与 git diff 字节级一致（不做 \\ No newline 标记、不做二进制判断）。
 */

export interface DiffOptions {
  /** 上下文行数，默认 3 */
  context?: number
  /** 输出总行数上限（含 hunk 头），超出截断，默认 400 */
  maxLines?: number
}

/** 超过这个规模的 LCS 会吃掉太多内存，退化成「整段删除 + 整段新增」 */
const LCS_CELL_LIMIT = 250_000

interface Op {
  type: ' ' | '-' | '+'
  text: string
}

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  const ops: Op[] = []
  if (n * m > LCS_CELL_LIMIT) {
    for (const line of a) ops.push({ type: '-', text: line })
    for (const line of b) ops.push({ type: '+', text: line })
    return ops
  }
  const width = m + 1
  const dp = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: ' ', text: a[i] })
      i++
      j++
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ type: '-', text: a[i] })
      i++
    } else {
      ops.push({ type: '+', text: b[j] })
      j++
    }
  }
  while (i < n) ops.push({ type: '-', text: a[i++] })
  while (j < m) ops.push({ type: '+', text: b[j++] })
  return ops
}

/**
 * 返回 unified diff 文本；两侧完全一致时返回空串。
 * 行号按 before/after 各自计算，与 git diff 的 @@ 头语义一致。
 */
export function unifiedDiff(before: string, after: string, options: DiffOptions = {}): string {
  const context = options.context ?? 3
  const maxLines = options.maxLines ?? 400
  if (before === after) return ''

  // 末尾换行会 split 出一个空串，直接参与比较会占掉一格上下文，先统一去掉
  const stripTrailing = (lines: string[]): string[] => {
    const copy = lines.slice()
    if (copy.length > 0 && copy[copy.length - 1] === '') copy.pop()
    return copy
  }
  const a = stripTrailing(before.split('\n'))
  const b = stripTrailing(after.split('\n'))

  // 掐掉公共前后缀，能把「改一行」的规模从整个文件降到几行；
  // 但要留出上下文行，否则 hunk 里只剩变更本身，看不出改在哪。
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= prefix && endB >= prefix && a[endA] === b[endB]) {
    endA--
    endB--
  }

  const suffixA = a.length - 1 - endA
  const suffixB = b.length - 1 - endB
  const keepSuffix = Math.min(context, suffixA, suffixB)

  const start = Math.max(0, prefix - context)
  const ops = lcsOps(
    a.slice(start, a.length - (suffixA - keepSuffix)),
    b.slice(start, b.length - (suffixB - keepSuffix)),
  )
  const changed = ops.some((op) => op.type !== ' ')
  if (!changed) return ''

  // 每行在两侧的起始行号
  const aLineAt: number[] = []
  const bLineAt: number[] = []
  let aLine = start + 1
  let bLine = start + 1
  for (const op of ops) {
    aLineAt.push(aLine)
    bLineAt.push(bLine)
    if (op.type !== '+') aLine++
    if (op.type !== '-') bLine++
  }

  // 把变更点按上下文窗口聚成 hunk
  const hunkRanges: Array<{ from: number; to: number }> = []
  for (let index = 0; index < ops.length; index++) {
    if (ops[index].type === ' ') continue
    const from = Math.max(0, index - context)
    const to = Math.min(ops.length - 1, index + context)
    const last = hunkRanges[hunkRanges.length - 1]
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to)
    else hunkRanges.push({ from, to })
  }

  const output: string[] = []
  let emitted = 0
  for (const range of hunkRanges) {
    if (emitted >= maxLines) {
      output.push('…（diff 已截断）')
      break
    }
    let aCount = 0
    let bCount = 0
    const body: string[] = []
    for (let index = range.from; index <= range.to; index++) {
      const op = ops[index]
      body.push(`${op.type}${op.text}`)
      if (op.type !== '+') aCount++
      if (op.type !== '-') bCount++
    }
    output.push(`@@ -${aLineAt[range.from]},${aCount} +${bLineAt[range.from]},${bCount} @@`)
    emitted++
    for (const line of body) {
      if (emitted >= maxLines) {
        output.push('…（diff 已截断）')
        break
      }
      output.push(line)
      emitted++
    }
  }
  return output.join('\n')
}
