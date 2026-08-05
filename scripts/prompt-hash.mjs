#!/usr/bin/env node
// scripts/prompt-hash.mjs
// Prints, writes, or verifies the prompt hash.
//
//   node scripts/prompt-hash.mjs            print the current hash
//   node scripts/prompt-hash.mjs --write    write prompts/digest-prompt.sha256
//   node scripts/prompt-hash.mjs --check    exit 1 if the recorded hash is stale
//
// The recorded file is the forcing function the plan asks for: editing the
// prompt without bumping it fails CI, so a prompt change cannot land as an
// invisible diff. Every posted digest embeds this same hash, which is what
// makes two digests comparable (or knowably not).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPrompt } from './digest-prompt.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const promptFile = path.join(root, 'prompts', 'digest-prompt.txt')
const hashFile = path.join(root, 'prompts', 'digest-prompt.sha256')

const { hash } = loadPrompt(promptFile)
const mode = process.argv[2] ?? ''

if (mode === '--write') {
  fs.writeFileSync(hashFile, `${hash}\n`)
  console.log(`wrote ${path.relative(root, hashFile)}: ${hash}`)
} else if (mode === '--check') {
  const recorded = fs.existsSync(hashFile) ? fs.readFileSync(hashFile, 'utf8').trim() : '(missing)'
  if (recorded !== hash) {
    console.error(`::error::prompt hash mismatch: prompts/digest-prompt.txt hashes to ${hash} but prompts/digest-prompt.sha256 records ${recorded}.`)
    console.error('::error::The prompt changed. Run `node scripts/prompt-hash.mjs --write`, commit the new hash, and note the change in the release notes: digests carrying different prompt hashes are not comparable.')
    process.exit(1)
  }
  console.log(`prompt hash ok: ${hash}`)
} else {
  console.log(hash)
}
