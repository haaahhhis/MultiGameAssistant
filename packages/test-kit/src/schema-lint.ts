/**
 * Strict tool schemas: every parameter has a concrete type, every object
 * lists its properties, every array its items. A loose schema (a value of
 * "any JSON", a free-form object) lets constrained decoding wander, and some
 * models then emit whitespace until the provider aborts the call
 * ("tool arguments stopped making progress").
 */
export function schemaProblems(schema: unknown, path = 'parameters'): string[] {
  if (typeof schema !== 'object' || schema === null) return [`${path}: not a schema`]
  const s = schema as { type?: unknown; enum?: unknown; properties?: unknown; items?: unknown; anyOf?: unknown; oneOf?: unknown }
  const problems: string[] = []
  if (s.anyOf !== undefined || s.oneOf !== undefined) problems.push(`${path}: anyOf / oneOf`)
  if (typeof s.type !== 'string' && s.enum === undefined) problems.push(`${path}: no type`)
  if (s.type === 'object') {
    if (typeof s.properties !== 'object' || s.properties === null) problems.push(`${path}: object without properties`)
    else for (const [key, value] of Object.entries(s.properties)) problems.push(...schemaProblems(value, `${path}.${key}`))
  }
  if (s.type === 'array') {
    if (s.items === undefined) problems.push(`${path}: array without items`)
    else problems.push(...schemaProblems(s.items, `${path}[]`))
  }
  return problems
}
