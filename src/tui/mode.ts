import type { PermissionMode } from '../permission/types.ts'
import type { AgentMode, UserMode } from './useStream.ts'

export interface ModeConfig {
  agentMode: AgentMode
  permMode: PermissionMode
  autoEdits: boolean
}

export function resolveMode(m: UserMode): ModeConfig {
  switch (m) {
    case 'default':
      return { agentMode: 'full', permMode: 'default', autoEdits: false }
    case 'edits':
      return { agentMode: 'full', permMode: 'default', autoEdits: true }
    case 'plan':
      return { agentMode: 'plan', permMode: 'default', autoEdits: false }
    case 'yolo':
      return { agentMode: 'full', permMode: 'permissive', autoEdits: false }
  }
}

export const MODE_LABEL: Record<UserMode, string> = {
  default: 'Default',
  edits: 'Edits',
  plan: 'Plan',
  yolo: 'YOLO',
}
