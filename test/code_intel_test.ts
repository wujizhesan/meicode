import { mkdirSync, mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codeIntelTool } from '../src/tools/code_intel_lazy.ts'

const root = mkdtempSync(join(tmpdir(), 'meicode-code-intel-'))
try {
  const noConfigFile = join(root, 'plain.ts')
  const noConfigEmpty = join(root, 'no-config-empty')
  const noConfigAdded = join(root, 'no-config-added')
  writeFileSync(noConfigFile, 'export const result: number = sharedValue\n', 'utf8')
  const cancelledBefore = new AbortController()
  cancelledBefore.abort()
  const before = await codeIntelTool.execute(
    { action: 'diagnostics', file: noConfigFile },
    { cwd: root, signal: cancelledBefore.signal },
  )
  if (before.success || !before.error?.includes('取消')) throw new Error(`pre-aborted code_intel returned success: ${JSON.stringify(before)}`)

  const cancelledDuring = new AbortController()
  const pending = codeIntelTool.execute(
    { action: 'diagnostics', file: noConfigFile },
    { cwd: root, signal: cancelledDuring.signal },
  )
  cancelledDuring.abort()
  const during = await pending
  if (during.success || !during.error?.includes('取消')) throw new Error(`interrupted code_intel returned success: ${JSON.stringify(during)}`)

  const { codeIntelTool: directTool } = await import('../src/tools/code_intel.ts')
  const direct = await directTool.execute(
    { action: 'diagnostics', file: noConfigFile },
    { cwd: root, signal: cancelledBefore.signal },
  )
  if (direct.success || !direct.error?.includes('取消')) throw new Error(`direct code_intel ignored cancellation: ${JSON.stringify(direct)}`)

  mkdirSync(noConfigEmpty)
  const missingGlobal = await codeIntelTool.execute({ action: 'diagnostics', file: noConfigFile }, { cwd: root })
  if (!missingGlobal.success || !missingGlobal.output.includes('Cannot find name')) throw new Error(`unconfigured project missed initial error: ${JSON.stringify(missingGlobal)}`)
  const emptyDirFile = join(noConfigEmpty, 'global.ts')
  writeFileSync(emptyDirFile, 'declare const sharedValue: number\n', 'utf8')
  const addedGlobal = await codeIntelTool.execute({ action: 'diagnostics', file: noConfigFile }, { cwd: root })
  if (!addedGlobal.success || !addedGlobal.output.includes('无诊断错误')) throw new Error(`unconfigured project missed added file: ${JSON.stringify(addedGlobal)}`)
  rmSync(emptyDirFile)
  const removedGlobal = await codeIntelTool.execute({ action: 'diagnostics', file: noConfigFile }, { cwd: root })
  if (!removedGlobal.success || !removedGlobal.output.includes('Cannot find name')) throw new Error(`unconfigured project missed deleted file: ${JSON.stringify(removedGlobal)}`)
  mkdirSync(noConfigAdded)
  const noConfigNewDirFile = join(noConfigAdded, 'global.ts')
  writeFileSync(noConfigNewDirFile, 'declare const sharedValue: number\n', 'utf8')
  const addedDirectory = await codeIntelTool.execute({ action: 'diagnostics', file: noConfigFile }, { cwd: root })
  if (!addedDirectory.success || !addedDirectory.output.includes('无诊断错误')) throw new Error(`unconfigured project missed new directory: ${JSON.stringify(addedDirectory)}`)
  rmSync(noConfigNewDirFile)
  rmdirSync(noConfigAdded)
  rmdirSync(noConfigEmpty)
  rmSync(noConfigFile)

  const substringRoot = join(root, 'node_modules_project')
  const similarDir = join(substringRoot, 'node_modules_tools')
  const ignoredDir = join(substringRoot, 'node_modules')
  mkdirSync(similarDir, { recursive: true })
  mkdirSync(ignoredDir)
  const namedFile = join(substringRoot, 'node_modules_helper.ts')
  const nestedFileWithSimilarName = join(similarDir, 'nested.ts')
  const ignoredFile = join(ignoredDir, 'ignored.ts')
  writeFileSync(namedFile, 'export const namedValue = 1\nvoid namedValue\n')
  writeFileSync(nestedFileWithSimilarName, 'export const nestedValue = 1\nvoid nestedValue\n')
  writeFileSync(ignoredFile, 'export const ignoredValue = 1\nvoid ignoredValue\n')
  for (const [file, sym, location] of [
    [namedFile, 'namedValue', 'node_modules_helper.ts:1'],
    [nestedFileWithSimilarName, 'nestedValue', 'node_modules_tools/nested.ts:1'],
  ]) {
    const result = await codeIntelTool.execute({ action: 'defs', file, sym }, { cwd: substringRoot })
    if (!result.success || !result.output.includes(location)) {
      throw new Error(`unconfigured path with similar name was excluded: ${JSON.stringify(result)}`)
    }
  }
  const ignoredDependency = await codeIntelTool.execute({ action: 'defs', file: ignoredFile, sym: 'ignoredValue' }, { cwd: substringRoot })
  if (ignoredDependency.success) throw new Error(`actual node_modules directory was included: ${JSON.stringify(ignoredDependency)}`)
  rmSync(namedFile)
  rmSync(nestedFileWithSimilarName)
  rmSync(ignoredFile)
  rmdirSync(similarDir)
  rmdirSync(ignoredDir)
  rmdirSync(substringRoot)

  const file = join(root, 'sample.ts')
  writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true},"include":["**/*.ts"]}\n', 'utf8')
  mkdirSync(join(root, 'empty'))
  writeFileSync(file, "export const value: string = 'ok'\n", 'utf8')
  const valid = await codeIntelTool.execute({ action: 'diagnostics', file }, { cwd: root })
  if (!valid.success || !valid.output.includes('无诊断错误')) throw new Error(`initial diagnostics failed: ${JSON.stringify(valid)}`)

  writeFileSync(file, 'export const value: string = 1\n', 'utf8')
  const changed = await codeIntelTool.execute({ action: 'diagnostics', file }, { cwd: root })
  if (!changed.success || changed.truncated || !changed.output.includes('[error]')) throw new Error(`cached service missed file change: ${JSON.stringify(changed)}`)

  const manyErrorsFile = join(root, 'many-errors.ts')
  writeFileSync(manyErrorsFile, Array.from({ length: 60 }, (_, i) => `missing_${i};`).join('\n') + '\n', 'utf8')
  const manyErrors = await codeIntelTool.execute({ action: 'diagnostics', file: manyErrorsFile }, { cwd: root })
  if (!manyErrors.success || !manyErrors.truncated || !manyErrors.output.startsWith('60 个诊断:')
    || !manyErrors.output.includes('省略 10 条诊断')) {
    throw new Error(`diagnostic truncation missing: ${JSON.stringify(manyErrors)}`)
  }
  const longErrorsFile = join(root, 'long-errors.ts')
  writeFileSync(longErrorsFile, Array.from({ length: 50 }, (_, i) => `missing_${'x'.repeat(110)}_${i};`).join('\n') + '\n', 'utf8')
  const longErrors = await codeIntelTool.execute({ action: 'diagnostics', file: longErrorsFile }, { cwd: root })
  if (!longErrors.success || !longErrors.truncated || !longErrors.output.includes('省略 ')
    || Buffer.byteLength(longErrors.output, 'utf8') > 7100) {
    throw new Error(`diagnostic byte limit missing: ${JSON.stringify(longErrors)}`)
  }

  const addedFile = join(root, 'added.ts')
  writeFileSync(addedFile, "import { value } from './sample'\nexport const result: number = value\n", 'utf8')
  const added = await codeIntelTool.execute({ action: 'diagnostics', file: addedFile }, { cwd: root })
  if (!added.success || added.output.includes('Cannot find module')) throw new Error(`cached service missed added file: ${JSON.stringify(added)}`)
  const definition = await codeIntelTool.execute({ action: 'defs', file: addedFile, sym: 'value' }, { cwd: root })
  if (!definition.success || !definition.output.includes('sample.ts:1')) throw new Error(`definition line changed: ${JSON.stringify(definition)}`)
  mkdirSync(join(root, 'left'))
  mkdirSync(join(root, 'right'))
  writeFileSync(join(root, 'left', 'index.ts'), 'export const chosen = 1\n', 'utf8')
  writeFileSync(join(root, 'right', 'index.ts'), 'export const chosen = 2\n', 'utf8')
  const consumerFile = join(root, 'consumer.ts')
  writeFileSync(consumerFile, "import { chosen } from './left'\nvoid chosen\n", 'utf8')
  const nestedDefinition = await codeIntelTool.execute({ action: 'defs', file: consumerFile, sym: 'chosen' }, { cwd: root })
  if (!nestedDefinition.success || nestedDefinition.truncated || !nestedDefinition.output.includes('left/index.ts:1:14')) {
    throw new Error(`definition path or column missing: ${JSON.stringify(nestedDefinition)}`)
  }
  for (let i = 0; i < 25; i++) writeFileSync(join(root, `merged-${i}.ts`), `interface Merged { field${i}: number }\n`, 'utf8')
  const mergedConsumer = join(root, 'merged-consumer.ts')
  writeFileSync(mergedConsumer, 'let merged!: Merged\n', 'utf8')
  const mergedDefinitions = await codeIntelTool.execute({ action: 'defs', file: mergedConsumer, sym: 'Merged' }, { cwd: root })
  if (!mergedDefinitions.success || !mergedDefinitions.truncated || !mergedDefinitions.output.includes('定义(25 处)')
    || !mergedDefinitions.output.includes('省略 5 处')) {
    throw new Error(`definition truncation missing: ${JSON.stringify(mergedDefinitions)}`)
  }
  const references = await codeIntelTool.execute({ action: 'refs', file: addedFile, sym: 'value' }, { cwd: root })
  if (!references.success || !references.output.includes('引用(')) throw new Error(`reference lookup changed: ${JSON.stringify(references)}`)
  const referenceFile = join(root, 'reference-many.ts')
  const referenceContent = (count: number) => `const marker = 1\n${'void marker\n'.repeat(count)}`
  writeFileSync(referenceFile, referenceContent(12), 'utf8')
  const locatedReferences = await codeIntelTool.execute({ action: 'refs', file: referenceFile, sym: 'marker' }, { cwd: root })
  if (!locatedReferences.success || locatedReferences.truncated || !locatedReferences.output.includes('引用(13 处，1 组)')
    || !locatedReferences.output.includes('reference-many.ts:13:6') || !locatedReferences.output.includes('[定义]')) {
    throw new Error(`reference locations missing: ${JSON.stringify(locatedReferences)}`)
  }
  writeFileSync(referenceFile, referenceContent(120), 'utf8')
  const manyReferences = await codeIntelTool.execute({ action: 'refs', file: referenceFile, sym: 'marker' }, { cwd: root })
  if (!manyReferences.success || !manyReferences.truncated || !manyReferences.output.includes('引用(121 处，1 组)')
    || !manyReferences.output.includes('省略 21 处')) {
    throw new Error(`reference truncation missing: ${JSON.stringify(manyReferences)}`)
  }

  const lineSource = join(root, 'line-source.ts')
  const lineUsage = join(root, 'line-usage.ts')
  writeFileSync(lineSource, 'const first = "中"\r\nconst second = first\r\nexport const anchored = second\r\n', 'utf8')
  writeFileSync(lineUsage, "import { anchored } from './line-source'\nconsole.log(anchored)\n", 'utf8')
  const lineDefinition = await codeIntelTool.execute({ action: 'defs', file: lineUsage, sym: 'anchored' }, { cwd: root })
  if (!lineDefinition.success || !lineDefinition.output.includes('line-source.ts:3')) throw new Error(`definition line incorrect: ${JSON.stringify(lineDefinition)}`)
  const exactLineDefinition = await codeIntelTool.execute({ action: 'defs', file: lineSource, line: 3, sym: 'second' }, { cwd: root })
  if (!exactLineDefinition.success || !exactLineDefinition.output.includes('line-source.ts:2')) {
    throw new Error(`line and symbol definition incorrect: ${JSON.stringify(exactLineDefinition)}`)
  }
  const lineOnlyDefinition = await codeIntelTool.execute({ action: 'defs', file: lineSource, line: 3 }, { cwd: root })
  if (!lineOnlyDefinition.success || !lineOnlyDefinition.output.includes('line-source.ts:3')) {
    throw new Error(`line-only definition incorrect: ${JSON.stringify(lineOnlyDefinition)}`)
  }
  const exactLineReferences = await codeIntelTool.execute({ action: 'refs', file: lineSource, line: 3, sym: 'second' }, { cwd: root })
  if (!exactLineReferences.success || !exactLineReferences.output.includes('line-source.ts')) {
    throw new Error(`line and symbol references incorrect: ${JSON.stringify(exactLineReferences)}`)
  }
  const missingLineSymbol = await codeIntelTool.execute({ action: 'defs', file: lineSource, line: 3, sym: 'first' }, { cwd: root })
  if (missingLineSymbol.success || !missingLineSymbol.error?.includes('未在第 3 行找到')) {
    throw new Error(`missing line symbol was accepted: ${JSON.stringify(missingLineSymbol)}`)
  }
  const outOfRangeLine = await codeIntelTool.execute({ action: 'defs', file: lineSource, line: 8, sym: 'second' }, { cwd: root })
  if (outOfRangeLine.success || !outOfRangeLine.error?.includes('行号超出范围')) {
    throw new Error(`out of range line was accepted: ${JSON.stringify(outOfRangeLine)}`)
  }
  const exactSymbolFile = join(root, 'exact-symbol.ts')
  writeFileSync(exactSymbolFile, 'const foobar = 1\nexport const foo = 2\nexport const chosen = foo\n', 'utf8')
  const exactSymbol = await codeIntelTool.execute({ action: 'defs', file: exactSymbolFile, sym: 'foo' }, { cwd: root })
  if (!exactSymbol.success || !exactSymbol.output.includes('exact-symbol.ts:2')) {
    throw new Error(`substring matched instead of identifier: ${JSON.stringify(exactSymbol)}`)
  }
  writeFileSync(exactSymbolFile, '// foo\nconst foobar = 1\nexport const foo = 2\nexport const chosen = foo\n', 'utf8')
  const refreshedSymbol = await codeIntelTool.execute({ action: 'defs', file: exactSymbolFile, sym: 'foo' }, { cwd: root })
  if (!refreshedSymbol.success || !refreshedSymbol.output.includes('exact-symbol.ts:3')) {
    throw new Error(`identifier AST did not refresh: ${JSON.stringify(refreshedSymbol)}`)
  }
  const commentSymbolFile = join(root, 'comment-symbol.ts')
  writeFileSync(commentSymbolFile, '// ghost target\nconst text = "target"\nconst template = `target`\nexport const target = 1\n', 'utf8')
  const commentSymbol = await codeIntelTool.execute({ action: 'defs', file: commentSymbolFile, sym: 'target' }, { cwd: root })
  if (!commentSymbol.success || !commentSymbol.output.includes('comment-symbol.ts:4')) {
    throw new Error(`comment or string matched instead of identifier: ${JSON.stringify(commentSymbol)}`)
  }
  const commentOnly = await codeIntelTool.execute({ action: 'defs', file: commentSymbolFile, sym: 'template' }, { cwd: root })
  if (!commentOnly.success || !commentOnly.output.includes('comment-symbol.ts:3')) {
    throw new Error(`identifier after comment was not found: ${JSON.stringify(commentOnly)}`)
  }
  const ghostSymbol = await codeIntelTool.execute({ action: 'defs', file: commentSymbolFile, sym: 'ghost' }, { cwd: root })
  if (ghostSymbol.success || !ghostSymbol.error?.includes('未在文件中找到')) {
    throw new Error(`comment-only symbol was accepted: ${JSON.stringify(ghostSymbol)}`)
  }

  const nestedFile = join(root, 'empty', 'nested.ts')
  writeFileSync(nestedFile, "import { value } from '../sample'\nexport const nested: number = value\n", 'utf8')
  const nested = await codeIntelTool.execute({ action: 'diagnostics', file: nestedFile }, { cwd: root })
  if (!nested.success || !nested.output.includes('[error]')) throw new Error(`cached service missed file in existing empty directory: ${JSON.stringify(nested)}`)

  const newDir = join(root, 'new-dir')
  mkdirSync(newDir)
  const newDirFile = join(newDir, 'consumer.ts')
  writeFileSync(newDirFile, "import { nested } from '../empty/nested'\nexport const consumed: number = nested\n", 'utf8')
  const newDirResult = await codeIntelTool.execute({ action: 'diagnostics', file: newDirFile }, { cwd: root })
  if (!newDirResult.success || !newDirResult.output.includes('无诊断错误')) throw new Error(`cached service missed file in new directory: ${JSON.stringify(newDirResult)}`)

  rmSync(nestedFile)
  const deleted = await codeIntelTool.execute({ action: 'diagnostics', file: newDirFile }, { cwd: root })
  if (!deleted.success || !deleted.output.includes('Cannot find module')) throw new Error(`cached service missed deleted file: ${JSON.stringify(deleted)}`)

  const inheritedRoot = join(root, 'inherited')
  mkdirSync(inheritedRoot)
  const baseConfig = join(inheritedRoot, 'base.json')
  const firstFile = join(inheritedRoot, 'first.ts')
  const secondFile = join(inheritedRoot, 'second.ts')
  writeFileSync(baseConfig, '{"include":["first.ts"]}', 'utf8')
  writeFileSync(join(inheritedRoot, 'tsconfig.json'), '{"extends":"./base.json"}', 'utf8')
  writeFileSync(firstFile, 'export const first: number = 1\n', 'utf8')
  writeFileSync(secondFile, 'export const second: number = 2\n', 'utf8')
  const inherited = await codeIntelTool.execute({ action: 'diagnostics', file: firstFile }, { cwd: inheritedRoot })
  if (!inherited.success) throw new Error(`inherited config initial diagnostics failed: ${JSON.stringify(inherited)}`)
  writeFileSync(baseConfig, '{"include":["second.ts"]}', 'utf8')
  const changedConfig = await codeIntelTool.execute({ action: 'diagnostics', file: secondFile }, { cwd: inheritedRoot })
  if (!changedConfig.success || !changedConfig.output.includes('无诊断错误')) throw new Error(`cached service missed extended config change: ${JSON.stringify(changedConfig)}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('code_intel_test passed')
