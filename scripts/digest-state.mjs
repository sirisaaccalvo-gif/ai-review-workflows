// scripts/digest-state.mjs
// The cursor rule, in its own module for one reason: CI must be able to import
// and test THIS code. An earlier version of the test re-implemented the regex
// and the loop inline in the workflow, which meant the single assertion
// guarding the highest-severity fix in this repo could not observe a regression
// in the fix. Reverting the script to the vulnerable global scan left CI green.
// A test that cannot fail is worse than no test, because it is credited.
//
// Node stdlib only, same rule as the rest of scripts/.

/** The account whose comments are trusted as state. Exact, never a substring. */
export const BOT_LOGIN = 'github-actions[bot]'

/**
 * The state trailer. Anchored at both ends and matched against a single line.
 *
 * Anchoring is the whole security property. A digest body contains model
 * output, so a marker found anywhere else in the text is attacker-influenced
 * data, not state. A full-mode digest carries no delta trailer of its own, so
 * under an unanchored global scan a model that emitted a delta-shaped marker
 * (on its own, or because a file in the reviewed repo instructed it to) would
 * become the cursor and skip every commit up to whatever SHA it named.
 */
export const TRAILER_RE = /^<!-- ai-digest mode=delta base=([0-9a-f]{7,40}) head=([0-9a-f]{7,40}) -->$/

/**
 * Resolve the delta cursor from bot-authored bodies, oldest to newest.
 *
 * Last writer wins, so the newest valid trailer is the cursor. Only the final
 * non-blank line of each body is considered. CR is stripped so a CRLF body does
 * not leave a stray carriage return inside the anchored match.
 *
 * @param {string[]} bodies issue body and comments, oldest first
 * @returns {string|null} the head SHA to resume from, or null for a first run
 */
export function readCursor(bodies) {
  let cursor = null
  for (const body of bodies) {
    const lines = String(body ?? '').replace(/\r/g, '').trimEnd().split('\n')
    const m = TRAILER_RE.exec((lines[lines.length - 1] || '').trim())
    if (m) cursor = m[2]
  }
  return cursor
}

/**
 * Carried-forward findings: the unchecked task items of the NEWEST digest only.
 * Scanning older bodies too would resurrect findings already checked off.
 * Heartbeats never contain the header, so they never clobber the list.
 */
export function readCarried(bodies, header = '## 🤖 AI digest') {
  let carried = []
  for (const body of bodies) {
    const text = String(body ?? '')
    if (text.includes(header)) carried = text.split('\n').filter((l) => l.startsWith('- [ ] '))
  }
  return carried
}
