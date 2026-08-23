import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSkillFile } from '../src/skill/loader.ts'
import { parseAgentFile } from '../src/subagent/loader.ts'

const root = join(import.meta.dirname, 'fixtures_frontmatter_crlf')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

const content = '---\r\nname: crlf\r\ndescription: crlf\r\n---\r\n正文\r\n'
const skillFile = join(root, 'skill.md')
const agentFile = join(root, 'agent.md')
writeFileSync(skillFile, content, 'utf8')
writeFileSync(agentFile, content, 'utf8')

const skill = parseSkillFile(skillFile, 'builtin')
const agent = parseAgentFile(agentFile, 'builtin')
if (!skill || skill.name !== 'crlf' || skill.content !== '正文') throw new Error('Skill CRLF frontmatter 解析失败')
if (!agent || agent.name !== 'crlf' || agent.content !== '正文') throw new Error('Agent CRLF frontmatter 解析失败')

rmSync(root, { recursive: true, force: true })
console.log('CRLF frontmatter passed')
