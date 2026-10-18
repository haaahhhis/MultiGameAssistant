/**
 * Script Pack SKILL.md files as agent skills. Each pack's SKILL.md becomes a
 * runtime skill, so the agent discovers "MAA" or "三月七" from the user's
 * words and loads how to drive it; the analysis guide ships the same way.
 */
import { parse as parseYaml } from 'yaml'

export interface SkillSpec {
  readonly name: string
  readonly description: string
  readonly content: string
  readonly path?: string
  readonly dir?: string
}

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Split frontmatter from the body.
 * @returns undefined when there is no usable `name` / `description`.
 */
export function parseSkill(text: string, fallbackName: string): { name: string; description: string; content: string } | undefined {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (match === null) return undefined
  let meta: Record<string, unknown>
  try {
    meta = (parseYaml(match[1]!) ?? {}) as Record<string, unknown>
  } catch {
    return undefined
  }
  const description = typeof meta['description'] === 'string' ? meta['description'].trim() : ''
  if (description === '') return undefined
  const raw = typeof meta['name'] === 'string' ? meta['name'] : fallbackName
  const name = toSkillName(raw) ?? toSkillName(fallbackName)
  if (name === undefined) return undefined
  return { name, description, content: match[2]!.trim() }
}

function toSkillName(value: string): string | undefined {
  const name = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return SKILL_NAME.test(name) ? name : undefined
}
