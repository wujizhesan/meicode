import type { JsonSchema, Tool } from './types.ts'

export interface OpenAITool {
  type: 'function'
  function: { name: string; description: string; parameters: JsonSchema }
}

export class ToolRegistry {
  private tools = new Map<string, Tool>()

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) throw new Error(`工具重名: ${tool.name}`)
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  list(): Tool[] {
    return [...this.tools.values()]
  }

  toOpenAITools(): OpenAITool[] {
    return this.list().map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }
}
