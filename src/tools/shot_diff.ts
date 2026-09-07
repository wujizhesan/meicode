import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { guardPath } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

// 复刻验证工具：两张 PNG 像素对比（原版 vs 复刻），输出 diff 百分比 + 差异区域 + diff 图
// 用法：shot_diff base=<原版截图> target=<复刻截图> [out=<diff图路径,默认 target.diff.png>]
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

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const [{ PNG }, { default: pixelmatch }] = await Promise.all([import('pngjs'), import('pixelmatch')])
    const basePath = resolve(ctx.cwd, String(args.base ?? ''))
    const targetPath = resolve(ctx.cwd, String(args.target ?? ''))
    const blocked = guardPath(ctx, basePath, false) ?? guardPath(ctx, targetPath, false) // 纯读截图
    if (blocked) return { success: false, output: '', error: blocked }
    const threshold = typeof args.threshold === 'number' ? Math.max(0, Math.min(1, args.threshold)) : 0.1

    let base: InstanceType<typeof PNG>
    let target: InstanceType<typeof PNG>
    try {
      base = PNG.sync.read(readFileSync(basePath))
      target = PNG.sync.read(readFileSync(targetPath))
    } catch (e) {
      return { success: false, output: '', error: `读取图片失败(需 PNG): ${(e as Error).message}` }
    }

    if (base.width !== target.width || base.height !== target.height) {
      return {
        success: false,
        output: '',
        error: `尺寸不一致: 原版 ${base.width}x${base.height} vs 复刻 ${target.width}x${target.height}(需同视口同分辨率)`,
      }
    }

    const diff = new PNG({ width: base.width, height: base.height })
    const diffPixels = pixelmatch(base.data, target.data, diff.data, base.width, base.height, {
      threshold,
      includeAA: false,
    })

    const total = base.width * base.height
    const pct = (diffPixels / total) * 100

    // 差异区域包围盒
    let minX = base.width, minY = base.height, maxX = -1, maxY = -1
    for (let y = 0; y < base.height; y++) {
      for (let x = 0; x < base.width; x++) {
        const idx = (y * base.width + x) * 4
        // pixelmatch diff 图中差异像素标红(255,0,0)
        if (diff.data[idx] > 200 && diff.data[idx + 1] < 100 && diff.data[idx + 2] < 100) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }

    const outPath = args.out ? resolve(ctx.cwd, String(args.out)) : `${targetPath}.diff.png`
    try {
      writeFileSync(outPath, PNG.sync.write(diff))
    } catch (e) {
      return { success: false, output: '', error: `写 diff 图失败: ${(e as Error).message}` }
    }

    const hasDiff = maxX >= 0
    const box = hasDiff ? `${minX},${minY} → ${maxX},${maxY}(${maxX - minX + 1}x${maxY - minY + 1}px)` : '无'
    const verdict = pct < 5 ? '✅ 通过(<5%)' : '❌ 未通过(≥5%,需修复)'
    return {
      success: true,
      output: `diff: ${pct.toFixed(2)}% (${diffPixels}/${total}px) ${verdict}\n差异区域: ${box}\ndiff 图: ${outPath}`,
    }
  },
}
