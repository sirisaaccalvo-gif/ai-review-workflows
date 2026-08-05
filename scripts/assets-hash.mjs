#!/usr/bin/env node
// scripts/assets-hash.mjs
// Content hash of everything the reusable workflow fetches into _central.
//
// WHY THIS EXISTS. A called reusable workflow cannot discover which repo or
// commit it came from: github.job_workflow_ref and github.job_workflow_sha are
// both EMPTY in a real cross-repo call (measured, not assumed), and
// github.workflow_ref points at the CALLER's entry workflow. So the workflow
// cannot check its own repo out "at the same ref it was invoked at", which was
// the original plan for version coherency.
//
// Hashing the assets is strictly better than the ref-based scheme would have
// been. The caller pins the workflow file to a full commit SHA; that file
// contains the expected asset hash as a literal; the job refuses to run if the
// assets it fetched do not hash to that value. Integrity therefore does not
// depend on any ref being immutable. A moved tag, a force-pushed branch, or a
// compromised default branch all fail closed, which is not true of a scheme
// that trusts a ref name.
//
//   node scripts/assets-hash.mjs            print the hash
//   node scripts/assets-hash.mjs --check    compare against the workflow literal
//
// Node stdlib only.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Everything the workflow runs or reads out of _central, INCLUDING this file.
// Excluding the verifier from the set it verifies is the classic hole: the
// workflow executes this script out of the untrusted checkout to compute the
// hash, so an unhashed verifier could simply print the expected value and wave
// tampered assets through. The workflow therefore also computes the hash with
// its own inline copy of this algorithm rather than trusting this file; CI
// asserts the two agree. The workflow FILE stays excluded because it carries
// the hash, which would be circular.
export const ASSET_FILES = [
  'prompts/digest-prompt.sha256',
  'prompts/digest-prompt.txt',
  'scripts/ai-weekly-digest.mjs',
  'scripts/assets-hash.mjs',
  'scripts/digest-prompt.mjs',
  'scripts/digest-sanitize.mjs',
  'scripts/digest-state.mjs',
  'scripts/prompt-hash.mjs',
]

export function assetsHash(base = root) {
  const h = crypto.createHash('sha256')
  // Sorted, with the path and byte length folded in, so a rename or a
  // truncation cannot collide with the original.
  for (const rel of [...ASSET_FILES].sort()) {
    const buf = fs.readFileSync(path.join(base, rel))
    h.update(rel, 'utf8').update('\0').update(String(buf.length)).update('\0').update(buf).update('\0')
  }
  return h.digest('hex')
}

const LITERAL_RE = /EXPECTED_ASSETS_SHA256:\s*'([0-9a-f]{64})'/

if (process.argv[2] === '--check') {
  const wf = path.join(root, '.github', 'workflows', 'ai-digest.yml')
  const m = LITERAL_RE.exec(fs.readFileSync(wf, 'utf8'))
  const actual = assetsHash()
  if (!m) {
    console.error("::error::could not find EXPECTED_ASSETS_SHA256: '<64 hex>' in .github/workflows/ai-digest.yml")
    process.exit(1)
  }
  if (m[1] !== actual) {
    console.error(`::error::asset hash mismatch: files hash to ${actual} but ai-digest.yml expects ${m[1]}.`)
    console.error("::error::Any change under scripts/ or prompts/ must update that literal in the same commit, or every caller's job will refuse to run. Set it to the value above.")
    process.exit(1)
  }
  console.log(`assets hash ok: ${actual}`)
} else if (process.argv[1] && process.argv[1].endsWith('assets-hash.mjs')) {
  console.log(assetsHash())
}
