// 模型目录测试：端点拼接的边界（该函数此前无任何测试）
// 背景：CHANGELOG 0.1.2 修过一次同类问题——"完整 endpoint 被重复追加路径导致 DeepSeek 404"。
//       本文件补的就是这一类拼接边界。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadModelCatalog, resolveCatalogEndpoint } from '../src/config/model-catalog.ts'
import type { ModelCatalog } from '../src/config/model-catalog.ts'

const fixture = mkdtempSync(join(tmpdir(), 'meicode-model-catalog-'))

function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`)
    process.exitCode = 1
  }
}

const catalog: ModelCatalog = {
  schemaVersion: 'test.v1',
  providers: [
    { id: 'plain', name: 'plain', baseURL: 'https://api.example.com', paths: { openai: '/v1/chat', anthropic: '/anthropic/v1/messages' }, defaultKind: 'openai', models: [] },
    { id: 'trailing', name: 'trailing', baseURL: 'https://api.example.com//', paths: { openai: '/v1/chat' }, defaultKind: 'openai', models: [] },
    // 用户手写 model-providers.json 时漏掉开头斜杠——最常见的笔误
    { id: 'no-slash', name: 'no-slash', baseURL: 'https://api.example.com', paths: { openai: 'v1/chat' }, defaultKind: 'openai', models: [] },
    { id: 'both-bad', name: 'both-bad', baseURL: 'https://api.example.com/', paths: { openai: 'v1/chat' }, defaultKind: 'openai', models: [] },
    { id: 'anthropic-only', name: 'anthropic-only', baseURL: 'https://api.example.com', paths: { anthropic: '/v1/messages' }, defaultKind: 'anthropic', models: [] },
  ],
}

try {
  check('端点拼接: 常规（base 无尾斜杠 + path 有开头斜杠）', () => {
    const got = resolveCatalogEndpoint(catalog, 'plain', 'openai')
    if (got !== 'https://api.example.com/v1/chat') throw new Error(`got=${got}`)
  })

  check('端点拼接: base 有尾斜杠不产生双斜杠', () => {
    const got = resolveCatalogEndpoint(catalog, 'trailing', 'openai')
    if (got !== 'https://api.example.com/v1/chat') throw new Error(`got=${got}`)
  })

  check('端点拼接: path 缺开头斜杠不把域名和路径粘死（回归）', () => {
    const got = resolveCatalogEndpoint(catalog, 'no-slash', 'openai')
    if (got !== 'https://api.example.com/v1/chat') throw new Error(`got=${got}`)
  })

  check('端点拼接: base 尾斜杠 + path 缺开头斜杠', () => {
    const got = resolveCatalogEndpoint(catalog, 'both-bad', 'openai')
    if (got !== 'https://api.example.com/v1/chat') throw new Error(`got=${got}`)
  })

  check('端点拼接: 结果始终是合法 URL 主机边界（不能出现 .comv1）', () => {
    for (const p of catalog.providers) {
      for (const kind of ['openai', 'anthropic'] as const) {
        const got = resolveCatalogEndpoint(catalog, p.id, kind)
        if (got === null) continue
        if (!/^https?:\/\/[^/]+\//.test(got)) throw new Error(`${p.id}/${kind} 不是合法 URL: ${got}`)
      }
    }
  })

  check('端点拼接: 未知 provider 返回 null', () => {
    if (resolveCatalogEndpoint(catalog, 'nope', 'openai') !== null) throw new Error('未返回 null')
  })

  check('端点拼接: provider 不支持该协议时返回 null', () => {
    if (resolveCatalogEndpoint(catalog, 'anthropic-only', 'openai') !== null) throw new Error('未返回 null')
  })

  check('内置目录: 无用户文件时返回内置目录', () => {
    const builtin = loadModelCatalog(join(fixture, 'does-not-exist.json'))
    if (!/^meicode\.model-providers\./.test(builtin.schemaVersion)) throw new Error(`schemaVersion=${builtin.schemaVersion}`)
    const deepseek = builtin.providers.find((p) => p.id === 'deepseek')
    if (!deepseek) throw new Error('内置目录缺少 deepseek')
    const anyBudget = deepseek.models.some((m) => (m.contextWindow ?? 0) > 0 && (m.maxOutputTokens ?? 0) > 0)
    if (!anyBudget) throw new Error('内置 deepseek 模型缺少上下文/输出预算')
    // 每个内置 provider 的默认协议都必须能解析出端点
    for (const p of builtin.providers) {
      if (!resolveCatalogEndpoint(builtin, p.id, p.defaultKind)) throw new Error(`内置 ${p.id} 端点解析失败`)
    }
  })

  check('用户目录: 按 id 合并覆盖并新增', () => {
    const file = join(fixture, 'model-providers.json')
    writeFileSync(file, JSON.stringify({
      schemaVersion: 'user.v1',
      providers: [
        { id: 'deepseek', name: 'deepseek', baseURL: 'https://proxy.internal/', paths: { anthropic: '/anthropic/v1/messages', openai: '/chat/completions' }, defaultKind: 'anthropic', models: [] },
        { id: 'local', name: 'local', baseURL: 'http://127.0.0.1:8080', paths: { openai: 'v1/chat/completions' }, defaultKind: 'openai', models: [] },
      ],
    }))
    const merged = loadModelCatalog(file)
    const ds = merged.providers.find((p) => p.id === 'deepseek')
    if (ds?.baseURL !== 'https://proxy.internal/') throw new Error(`覆盖未生效: ${ds?.baseURL}`)
    const local = merged.providers.find((p) => p.id === 'local')
    if (!local) throw new Error('新增 provider 未合并')
    // 新增的 provider 用了缺开头斜杠的 path，也必须拼出合法端点
    const ep = resolveCatalogEndpoint(merged, 'local', 'openai')
    if (ep !== 'http://127.0.0.1:8080/v1/chat/completions') throw new Error(`got=${ep}`)
    if (merged.providers.length <= 1) throw new Error('内置 provider 被丢弃')
  })

  check('用户目录: JSON 损坏时回退内置而非抛错', () => {
    const file = join(fixture, 'broken.json')
    writeFileSync(file, '{ this is not json')
    const got = loadModelCatalog(file)
    if (!got.providers.some((p) => p.id === 'deepseek')) throw new Error('未回退到内置目录')
  })

  check('用户目录: providers 不是数组时回退内置', () => {
    const file = join(fixture, 'wrong-shape.json')
    writeFileSync(file, JSON.stringify({ schemaVersion: 'x', providers: 'nope' }))
    const got = loadModelCatalog(file)
    if (!got.providers.some((p) => p.id === 'deepseek')) throw new Error('未回退到内置目录')
  })

  if (process.exitCode) throw new Error('存在失败用例')
  console.log('model_catalog_test passed')
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
