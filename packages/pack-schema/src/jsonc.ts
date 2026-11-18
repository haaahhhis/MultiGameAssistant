/**
 * JSON with comments and trailing commas (MaaFramework's interface.json and
 * many script configs are written this way).
 */

/** Remove `//` and `/* *\/` comments outside strings, and trailing commas. */
export function stripJsonc(source: string): string {
  let out = ''
  let i = 0
  let inString = false
  while (i < source.length) {
    const c = source[i]!
    const next = source[i + 1]
    if (inString) {
      out += c
      if (c === '\\' && next !== undefined) {
        out += next
        i += 2
        continue
      }
      if (c === '"') inString = false
      i += 1
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      i += 1
      continue
    }
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end < 0 ? source.length : end + 2
      continue
    }
    out += c
    i += 1
  }
  return removeTrailingCommas(out)
}

function removeTrailingCommas(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inString) {
      out += c
      if (c === '\\') out += text[++i] ?? ''
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    if (c === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j++
      if (text[j] === '}' || text[j] === ']') continue
    }
    out += c
  }
  return out
}

export function parseJsonc(source: string): unknown {
  return JSON.parse(stripJsonc(source.replace(/^﻿/, '')))
}
