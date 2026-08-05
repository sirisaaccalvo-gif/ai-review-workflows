// scripts/digest-prompt.mjs
// Parser + hasher for prompts/digest-prompt.txt. Shared by the digest script
// and by scripts/prompt-hash.mjs so the hash the CI checks and the hash a
// posted digest embeds can never come from two different implementations.
//
// Node stdlib only, same rule as the digest script itself.
import crypto from 'node:crypto'
import fs from 'node:fs'

const SECTION_RE = /^=== ([a-z][a-z0-9.]*) ===$/

// Required sections. A prompt file missing any of these is a hard error, not a
// silently empty instruction block: an empty system or format section would
// still produce a plausible-looking model call and a hollow digest.
export const REQUIRED_SECTIONS = ['system', 'instructions.delta', 'instructions.full', 'format']

/**
 * Parse the sectioned prompt file.
 * Top-level `#` lines before the first section header are comments. Inside a
 * section every line is literal, including `#`, so prompt text can use it.
 */
export function parsePrompt(text) {
  const sections = new Map()
  let current = null
  let buf = []
  const flush = () => {
    if (current) sections.set(current, buf.join('\n').trim())
    buf = []
  }
  for (const line of text.split('\n')) {
    const m = SECTION_RE.exec(line)
    if (m) {
      flush()
      if (sections.has(m[1])) throw new Error(`duplicate prompt section: ${m[1]}`)
      current = m[1]
      continue
    }
    if (current === null) continue // top-level comments and blank lines
    buf.push(line)
  }
  flush()

  const missing = REQUIRED_SECTIONS.filter((s) => !sections.get(s))
  if (missing.length) throw new Error(`prompt file is missing or has empty section(s): ${missing.join(', ')}`)
  const unknown = [...sections.keys()].filter((s) => !REQUIRED_SECTIONS.includes(s))
  if (unknown.length) throw new Error(`prompt file has unknown section(s): ${unknown.join(', ')}`)
  return Object.fromEntries(sections)
}

/**
 * Hash the PARSED sections, not the raw bytes: the file's leading comment block
 * documents the format and is expected to change without changing the prompt.
 * Sorted keys so section order in the file is not part of the identity.
 */
export function hashSections(sections) {
  const canonical = JSON.stringify(Object.keys(sections).sort().map((k) => [k, sections[k]]))
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12)
}

export function loadPrompt(file) {
  const sections = parsePrompt(fs.readFileSync(file, 'utf8'))
  return { sections, hash: hashSections(sections) }
}

/** Substitute {{placeholders}}. Unknown placeholders are a hard error. */
export function render(template, vars) {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (_, name) => {
    if (!(name in vars)) throw new Error(`prompt uses unknown placeholder {{${name}}}`)
    return String(vars[name] ?? '')
  })
}
