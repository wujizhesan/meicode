export type SkillSource = 'builtin' | 'user' | 'project'

export interface SkillDef {
  name: string
  description: string
  tools?: string[]
  mode: 'shared' | 'isolated'
  history?: number
  model?: string
  content: string
  source: SkillSource
}

export interface ActiveSkill {
  def: SkillDef
  params: Record<string, string>
}

export interface SkillDirs {
  builtin: string
  user: string
  project: string
}
