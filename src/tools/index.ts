import type { Tool, ToolContext } from './types.ts'
import { readFileTool } from './read_file.ts'
import { writeFileTool } from './write_file.ts'
import { editFileTool } from './edit_file.ts'
import { runCommandTool } from './run_command.ts'
import { findFilesTool } from './find_files.ts'
import { grepCodeTool } from './grep_code.ts'
import { extractStringsTool } from './extract_strings.ts'
import { deobfuscateTool } from './deobfuscate.ts'
import { shotDiffTool } from './shot_diff.ts'
import { ddExtractTool } from './dd_extract.ts'
import { mitmCaptureTool } from './mitm_capture.ts'
import { snapshotTool, rollbackTool } from './snapshot.ts'
import { codeIntelTool } from './code_intel.ts'
import { browserTool } from './browser.ts'
import { elicitTool } from './elicit.ts'

export function createTools(_ctx: ToolContext): Tool[] {
  return [readFileTool, writeFileTool, editFileTool, runCommandTool, findFilesTool, grepCodeTool, extractStringsTool, deobfuscateTool, shotDiffTool, ddExtractTool, mitmCaptureTool, snapshotTool, rollbackTool, codeIntelTool, browserTool, elicitTool]
}

export type { Tool, ToolResult, ToolContext, JsonSchema } from './types.ts'
export { ToolRegistry, type OpenAITool } from './registry.ts'
