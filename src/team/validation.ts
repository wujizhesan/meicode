const TEAM_ACTOR_RE = /^[A-Za-z0-9_-]{1,64}$/

export function isTeamActorName(name: string): boolean {
  return TEAM_ACTOR_RE.test(name)
}

export function teamActorKey(name: string): string {
  return name.toLowerCase()
}

export function assertTeamActorName(name: string, label = '成员名'): void {
  if (!isTeamActorName(name)) throw new Error(`${label}只能包含字母、数字、下划线和连字符，长度为 1-64`)
}
