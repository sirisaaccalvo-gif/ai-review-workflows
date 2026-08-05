#!/usr/bin/env node
// scripts/check-disclosure.mjs
// Fail if a private name appears in this repo's files OR its commit messages.
//
// WHY THIS EXISTS. This public repo has been rebuilt from scratch three times,
// each time because private repository names had leaked into it. Twice the
// files were scrubbed and the names then came straight back in the commit
// messages of the very commits doing the scrubbing. A one-time cleanup does not
// hold; only a check that runs on every change does.
//
// WHY HASHES. A denylist of literal names would itself be the disclosure: the
// guard would publish exactly what it exists to protect. So the list holds
// SHA-256 hashes of the lowercased names. The check hashes every token it finds
// and looks for a match, which means it can detect a name it cannot reveal.
// Adding a name is `node scripts/check-disclosure.mjs --hash <name>`; the name
// itself never enters the repo.
//
// This is deliberately not clever. It cannot catch a paraphrase, an
// abbreviation, or a name split across lines. It catches the exact failure that
// has actually happened three times, which is worth more than a general
// solution that does not exist.
//
// Node stdlib only.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const denyFile = path.join(root, '.github', 'disclosure-denylist.txt')

const h = (s) => crypto.createHash('sha256').update(s.toLowerCase(), 'utf8').digest('hex')

// Emit a hash for a name so it can be added without ever writing the name here.
if (process.argv[2] === '--hash') {
  const name = process.argv[3]
  if (!name) { console.error('usage: check-disclosure.mjs --hash <name>'); process.exit(1) }
  console.log(`${h(name)}  # ${name.length} chars, added ${new Date().toISOString().slice(0, 10)}`)
  process.exit(0)
}

const deny = new Set(
  fs.existsSync(denyFile)
    ? fs.readFileSync(denyFile, 'utf8').split('\n')
        .map((l) => l.replace(/#.*$/, '').trim().toLowerCase())
        .filter((l) => /^[0-9a-f]{64}$/.test(l))
    : [],
)
if (!deny.size) {
  console.error('::error::no hashes in .github/disclosure-denylist.txt; the guard would pass vacuously')
  process.exit(1)
}

// Tokens keep dots and hyphens, because the names being guarded contain them.
const tokenize = (s) => String(s).toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? []

function scan(label, text) {
  const hits = []
  for (const tok of new Set(tokenize(text))) {
    if (deny.has(h(tok))) hits.push(tok)
    // Also try the token with a trailing dot-segment stripped, so that a name
    // ending in a TLD is still caught when punctuation glues something on.
    const trimmed = tok.replace(/[._-]+$/, '')
    if (trimmed !== tok && deny.has(h(trimmed))) hits.push(trimmed)
  }
  return hits.length ? { label, count: hits.length } : null
}

const findings = []

// Every tracked file.
const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
for (const f of files) {
  if (f === 'scripts/check-disclosure.mjs' || f.endsWith('disclosure-denylist.txt')) continue
  let text
  try { text = fs.readFileSync(path.join(root, f), 'utf8') } catch { continue }
  const r = scan(`file ${f}`, text)
  if (r) findings.push(r)
}

// Every commit message in the history. This is the half that kept regressing.
const messages = execFileSync('git', ['log', '--format=%H%x00%B%x00%x00'], { cwd: root, encoding: 'utf8' })
for (const entry of messages.split('\0\0').filter((e) => e.trim())) {
  const [sha, body = ''] = entry.split('\0')
  const r = scan(`commit ${sha.trim().slice(0, 8)}`, body)
  if (r) findings.push(r)
}

if (findings.length) {
  console.error('::error::private names found in this public repository.')
  for (const f of findings) console.error(`::error::  ${f.label}: ${f.count} occurrence(s)`)
  console.error('::error::The names are intentionally not printed. Search your own commit messages and files for the repositories this project consumes.')
  console.error('::error::If it is in a commit message that is already pushed, amending means a force-push; decide before adding more on top.')
  process.exit(1)
}
console.log(`no private names in ${files.length} files or ${messages.split('\0\0').filter((e) => e.trim()).length} commit messages (${deny.size} guarded)`)
