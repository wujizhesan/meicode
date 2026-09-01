import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

export function readCoordinatorConfig(root: string): boolean {
  const file = join(root, 'team.yaml')
  if (!existsSync(file)) return false
  try {
    const config = parse(readFileSync(file, 'utf8')) as { coordinator_enabled?: boolean }
    return config.coordinator_enabled === true
  } catch {
    return false
  }
}
