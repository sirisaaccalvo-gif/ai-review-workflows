// scripts/ai-weekly-digest.mjs
// The AI code digest: a second model family re-reads everything that merged to
// the calling repo's default branch, on a schedule, and posts to one rolling
// GitHub issue.
//
// This file is the shared implementation behind
// .github/workflows/ai-digest.yml (a `workflow_call` reusable workflow). It
// runs against a CALLER repository that the workflow checks out separately:
// every git read and every file read is explicitly scoped to DIGEST_CALLER_DIR,
// because this script no longer lives in the repo it reviews.
//
// Modes (DIGEST_MODE):
//   delta: the cron. Reviews the combined diff of every commit merged since the
//          last successfully posted delta digest. Posts to the rolling issue.
//   full:  manual dispatch. Reviews the whole tracked code corpus. Never
//          advances the delta cursor.
// Which model runs in which mode is entirely the caller's choice; this script
// receives one already-resolved model config per run (DIGEST_MODEL_* below).
//
// State: the rolling issue IS the database. Every posted delta digest embeds
//   <!-- ai-digest mode=delta base=<sha> head=<sha> -->
// and the next run resumes from the newest such marker. The cursor advances
// only when a delta digest actually posts (the comment is the checkpoint, so a
// failed run re-reviews the same range next cycle instead of losing it; a
// wall-clock window would silently drop commits on any failed, late, or skipped
// run). Fallbacks are loud: an unreachable cursor (force-push) or a first run
// falls back to a bounded window and says so in the digest; an unresolvable
// base is a hard failure, never a quiet week. Quiet periods post a one-line
// heartbeat WITHOUT a marker and without an API call: a missing scheduled post
// is indistinguishable from a broken cron unless every scheduled run posts.
//
// Output contract: model and plumbing failures exit 1 (the scheduled-run
// failure email is the alert) and post NOTHING, because a hollow digest would
// advance the cursor over an unreviewed range. finish_reason=length posts WITH
// a loud truncation banner (disclosed partial coverage beats silence). Findings
// nobody has checked off are carried forward mechanically from the
// previous digest comment; they are never fed back into the model prompt
// (prompt-fed dedup both suppresses still-real findings and adds an injection
// surface).
//
// Run locally against a checkout:
//   DIGEST_CALLER_DIR=/path/to/repo DIGEST_POST=false \
//   DIGEST_STUB=/path/to/canned-response.md node scripts/ai-weekly-digest.mjs
// DIGEST_POST=false writes the digest to stdout (and $GITHUB_STEP_SUMMARY when
// set) without touching the issue. DIGEST_STUB additionally replaces the model
// call with a canned response, for offline tests of the git and state plumbing.
//
// No em dashes anywhere in this file, so its output can be quoted into
// repositories whose style rules ban them (some enforce that in CI over tracked
// text, where a single stray character fails the build).
//
// Dependencies: none. Node stdlib (child_process, fs, path, os, url) plus
// native fetch. Keep it that way: a reusable workflow that installs packages
// would need a lockfile, a cache, and a supply-chain story, for a script whose
// entire job is two subprocesses and one HTTP call.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPrompt, render } from './digest-prompt.mjs'
import { BOT_LOGIN, readCursor, readCarried } from './digest-state.mjs'
import { neutralize } from './digest-sanitize.mjs'

const execFileAsync = promisify(execFile)
const startedAt = Date.now()
const here = path.dirname(fileURLToPath(import.meta.url))

// ── env ─────────────────────────────────────────────────────────────────────
function fail(msg) {
  console.error(`::error::${msg}`)
  process.exit(1)
}

/** Read a required-with-default string input. Empty string counts as unset. */
function str(name, dflt) {
  const v = process.env[name]
  return v === undefined || v === '' ? dflt : v
}

/** Read a positive-integer input, failing loudly rather than coercing to NaN. */
function int(name, dflt) {
  const v = process.env[name]
  if (v === undefined || v === '') return dflt
  const n = Number(v)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    fail(`${name} must be a positive integer, got ${JSON.stringify(v)}`)
  }
  return n
}

const MODE = str('DIGEST_MODE', 'delta').toLowerCase()
const POST = (process.env.DIGEST_POST ?? 'true') !== 'false'
const INCLUDE_DOCS = process.env.DIGEST_INCLUDE_DOCS === 'true'
const STUB = str('DIGEST_STUB', '')
const REPO = str('GITHUB_REPOSITORY', '')
const OWNER = str('GITHUB_REPOSITORY_OWNER', REPO.split('/')[0] || '')

if (!['delta', 'full'].includes(MODE)) fail(`unknown DIGEST_MODE: ${MODE}`)

// The caller checkout. This script lives in the central repo and reviews a
// DIFFERENT working tree, so nothing may rely on process.cwd(): every git
// invocation gets this as an explicit cwd, and every file read is joined onto
// it. Defaults to cwd only so a local run inside a repo still works.
const CALLER_DIR = path.resolve(str('DIGEST_CALLER_DIR', process.cwd()))
if (!fs.existsSync(path.join(CALLER_DIR, '.git'))) {
  fail(`DIGEST_CALLER_DIR is not a git checkout: ${CALLER_DIR}`)
}
// Resolved once: every full-mode file read is checked for containment under it.
const CALLER_REAL = fs.realpathSync(CALLER_DIR)

// Model config for THIS run, already resolved per mode by the workflow. One
// resolved model rather than a two-branch table here is what lets a caller flip
// families per mode from its stub without this file knowing any repo's roster.
const MODEL = {
  label: str('DIGEST_MODEL_LABEL', ''),
  base: str('DIGEST_API_BASE', ''),
  keyEnv: str('DIGEST_KEY_ENV', ''),
  model: str('DIGEST_MODEL', ''),
  effort: str('DIGEST_EFFORT', '') || null,
}
for (const k of ['label', 'base', 'keyEnv', 'model']) {
  if (!MODEL[k]) fail(`missing model configuration: DIGEST_${({ label: 'MODEL_LABEL', base: 'API_BASE', keyEnv: 'KEY_ENV', model: 'MODEL' })[k]} is required`)
}
if (!/^https:\/\//.test(MODEL.base)) fail(`DIGEST_API_BASE must be an https URL, got ${JSON.stringify(MODEL.base)}`)

const MAX_COMPLETION_TOKENS = int('DIGEST_MAX_COMPLETION_TOKENS', MODE === 'full' ? 131072 : 32768)
// Mutable: when chunking splits the work, the per-attempt budget is rescaled
// below so the whole run fits inside the job timeout. See the wedge note there.
let CLIENT_TIMEOUT_MS = int('DIGEST_CLIENT_TIMEOUT_MS', 1800_000)
// The job's own wall-clock ceiling, passed down by the workflow. 0 = unknown
// (a local run), in which case nothing is rescaled.
const JOB_BUDGET_MS = int('DIGEST_JOB_BUDGET_MS', 0) || 0
const WARN_INPUT_TOKENS = int('DIGEST_WARN_INPUT_TOKENS', 250_000)
const CHUNK_INPUT_TOKENS = int('DIGEST_CHUNK_INPUT_TOKENS', 700_000)
const BOOTSTRAP_DAYS = int('DIGEST_BOOTSTRAP_WINDOW_DAYS', 31)
const FINDINGS_CAP = int('DIGEST_FINDINGS_CAP', 12)
const WORD_CAP = int('DIGEST_WORD_CAP', 2500)
const ISSUE_TITLE = str('DIGEST_ISSUE_TITLE', '🤖 AI weekly code digest (automated)')
// Assignee makes GitHub notify a human of every digest; a rolling issue nobody
// sees would be write-only automation. Assignment is best effort (see deliver).
const ASSIGNEE = str('DIGEST_ASSIGNEE', OWNER)
// Path prefixes treated as prose and gated behind include_docs. Comma separated
// because repos disagree about which directories hold prose, and not every repo
// has all of them.
const DOCS_PATHS = str('DIGEST_DOCS_PATHS', 'docs/,.planning/').split(',').map((s) => s.trim()).filter(Boolean)
// Regex alternation body, not a plain list: the defaults need `jpe?g` and
// `woff2?`. Callers extend it: a repo whose svg files are exported vector art
// rather than hand-written markup will want to add `svg`, since a single
// exported asset can be most of a corpus and none of it is reviewable code.
const LOCKFILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'bun.lockb', 'go.sum', 'Cargo.lock', 'poetry.lock', 'composer.lock'])
const BINARY_ALTERNATION = str('DIGEST_BINARY_EXTENSIONS', 'png|jpe?g|webp|avif|gif|ico|woff2?|ttf|otf|pdf|zip|m4a|mp3|wav|aac|ogg|flac|mp4|m4v|mov|webm|avi')
let BINARY
try {
  BINARY = new RegExp(`\\.(${BINARY_ALTERNATION})$`, 'i')
} catch (err) {
  fail(`DIGEST_BINARY_EXTENSIONS is not a valid regex alternation: ${String(err.message ?? err)}`)
}

// GitHub rejects an issue or comment body over 65536 characters. That ceiling
// is a state-machine hazard, not a cosmetic one: a rejected post leaves the
// cursor unmoved, so the next run reviews an even LARGER range, produces an
// even larger body, and fails again. Left unbounded it wedges permanently.
// The caps in the prompt are instructions a model can simply exceed, and in
// chunked mode each call gets the full allowance independently, so the only
// real defense is trimming the composed body before posting.
const GITHUB_BODY_LIMIT = 65536
const MAX_BODY_CHARS = int('DIGEST_MAX_BODY_CHARS', 60000)
if (MAX_BODY_CHARS > GITHUB_BODY_LIMIT) fail(`DIGEST_MAX_BODY_CHARS must be at most ${GITHUB_BODY_LIMIT}`)

// Pricing for the cost footer, as JSON keyed by model id. Estimates, not
// invoices: they ignore cached-input discounts and any negotiated rate, which
// is why the footer says "est." Check them against a real invoice
// periodically rather than trusting them.
const PRICING = (() => {
  const raw = str('DIGEST_PRICING', '{}')
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object')
    return parsed
  } catch (err) {
    fail(`DIGEST_PRICING is not a JSON object keyed by model id: ${String(err.message ?? err)}`)
  }
})()

const PROMPT_FILE = str('DIGEST_PROMPT_FILE', path.join(here, '..', 'prompts', 'digest-prompt.txt'))
let PROMPT
try {
  PROMPT = loadPrompt(PROMPT_FILE)
} catch (err) {
  fail(`cannot load the prompt file at ${PROMPT_FILE}: ${String(err.message ?? err)}`)
}
// Provenance of the central checkout, surfaced in the footer so a digest names
// the exact harness that produced it.
const CENTRAL_REF = str('DIGEST_CENTRAL_REF', '')

async function git(...args) {
  const { stdout } = await execFileAsync('git', args, { cwd: CALLER_DIR, maxBuffer: 256 * 1024 * 1024 })
  return stdout
}

async function gh(args, { input } = {}) {
  const { stdout } = await execFileAsync('gh', args, {
    cwd: CALLER_DIR,
    maxBuffer: 64 * 1024 * 1024,
    ...(input !== undefined ? { input } : {}),
  })
  return stdout
}

const estTokens = (s) => Math.ceil(s.length / 4)
const short = (sha) => sha.slice(0, 7)
const num = (n) => n.toLocaleString('en-US')

// ── repo facts ──────────────────────────────────────────────────────────────
// DIGEST_DEFAULT_BRANCH is the workflow-pinned repository default branch: the
// first live digest itself flagged that GITHUB_REF_NAME follows whatever ref a
// manual dispatch selects, so a dispatch from an unmerged branch would have
// recorded that branch's SHA as the rolling cursor. GITHUB_REF_NAME and
// origin/HEAD remain fallbacks for local runs only.
let defaultBranch = str('DIGEST_DEFAULT_BRANCH', '')
if (!defaultBranch && process.env.GITHUB_ACTIONS === 'true') {
  fail('DIGEST_DEFAULT_BRANCH is empty in a GitHub Actions run. Refusing to fall back to GITHUB_REF_NAME, which follows whatever ref a manual dispatch selected and would record an unmerged branch tip as the rolling cursor.')
}
if (!defaultBranch) defaultBranch = str('GITHUB_REF_NAME', '')
if (!defaultBranch) {
  try {
    defaultBranch = (await git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD')).trim().replace(/^origin\//, '')
  } catch {
    fail('cannot resolve the default branch (no DIGEST_DEFAULT_BRANCH, no GITHUB_REF_NAME, no origin/HEAD)')
  }
}
let head
try {
  head = (await git('rev-parse', `origin/${defaultBranch}`)).trim()
} catch {
  // A reusable workflow makes this failure mode newly reachable: if the caller
  // checkout step ever loses fetch-depth: 0 or its remote refs, origin/<branch>
  // does not exist and every downstream range is nonsense. Name the cause.
  fail(`cannot resolve origin/${defaultBranch} in ${CALLER_DIR}: the caller checkout needs fetch-depth: 0 and its remote refs`)
}
// full mode reads the WORKING TREE (git ls-files plus readFileSync), which is
// whatever ref the dispatch checked out, not origin/<default>. Labelling that
// scan with `head` published branch-only findings as a scan of the default
// branch. Delta mode is unaffected: it diffs refs, never the working tree.
const worktreeHead = (await git('rev-parse', 'HEAD')).trim()
const today = new Date().toISOString().slice(0, 10)

// ── rolling issue (find; created only at post time) ─────────────────────────
// Exact-title match over ALL states via the core list API, the proven
// dependency-digest pattern (search indexes lag), widened per review: a closed
// rolling issue must still be found, or the cursor silently resets.
let issueNumber = null
let previousComments = []
const canGh = Boolean(REPO && (process.env.GH_TOKEN || process.env.GITHUB_TOKEN))
if (!canGh && POST) fail('posting requires GITHUB_REPOSITORY and GH_TOKEN (or GITHUB_TOKEN)')
if (canGh) {
  try {
    // --limit 1000, not the ~200 default posture: the list is newest-first, so
    // once the repo accumulates more newer issues than the limit, this
    // exact-title lookup would miss the rolling issue and create a duplicate,
    // silently restarting the cursor.
    // sort_by(.number) ascending: the OLDEST matching issue is the real one.
    // Taking the newest would let anyone able to open an issue with this title
    // move the state store to an issue they control.
    const raw = await gh(['issue', 'list', '--repo', REPO, '--state', 'all', '--limit', '1000',
      '--json', 'number,title', '--jq',
      `map(select(.title == ${JSON.stringify(ISSUE_TITLE)})) | sort_by(.number) | .[0].number // empty`])
    issueNumber = raw.trim() ? Number(raw.trim()) : null
    if (issueNumber) {
      // REST's per-issue comments endpoint (unlike the repo-wide one) takes no
      // sort/direction params and always returns oldest to newest by ID. An
      // earlier version passed sort=created&direction=desc here, which the
      // endpoint silently ignores, plus a `| reverse` that flipped the
      // already-correct order and made the cursor loop below resolve to the
      // OLDEST marker instead of the newest one.
      // --paginate: a single page (100 comments) would silently drop the newest
      // marker once the rolling issue outgrows it. --slurp, with the filtering
      // moved to JS, because gh applies --jq per RESPONSE PAGE rather than to
      // the merged result: past page 1 a `--jq '[...]'` emits one JSON array
      // per page and JSON.parse aborts the digest on the second array. cli/cli
      // evaluates the filter per page in processResponse, and --slurp exists
      // precisely to make paginated output parseable as one document. --slurp
      // cannot carry --jq at all ("the --slurp option is not supported with
      // --jq"), so dropping --jq is the fix, not a workaround.
      // .flat() normalises both slurp shapes (an array of pages vs one already
      // flat array), so this does not rest on which gh emits. The login match is
      // EXACT: a substring test on "github-actions" also accepts real user
      // accounts (github-actions-repo and friends exist on github.com today),
      // and any of those could post a comment carrying a forged state trailer.
      const pages = JSON.parse(await gh(['api', '--paginate', '--slurp',
        `repos/${REPO}/issues/${issueNumber}/comments?per_page=100`]))
      previousComments = pages.flat()
        .filter((c) => c?.user?.login === BOT_LOGIN)
        .map((c) => String(c.body ?? ''))
      // The FIRST digest becomes the issue BODY (create path), not a comment.
      // A comments-only scan cannot see the body's marker, and a run that
      // cannot see it re-bootstraps and posts a duplicate. The body joins the
      // scan as the oldest entry.
      //
      // The author check matters more here than on the comments: anyone who can
      // open an issue could otherwise create one with this exact title and a
      // handcrafted trailer, and the next run would adopt it as cursor state and
      // skip whatever range it named. Comments are already filtered the same
      // way. Neither is authentication (any workflow with issues:write posts as
      // github-actions[bot]), but it closes the trivial path.
      const issue = JSON.parse(await gh(['api', `repos/${REPO}/issues/${issueNumber}`]))
      const issueBody = String(issue?.body ?? '')
      if (issueBody.trim()) {
        if (issue?.user?.login === BOT_LOGIN) previousComments.unshift(issueBody)
        else console.log(`::warning::rolling issue #${issueNumber} was opened by ${issue?.user?.login ?? 'an unknown account'}, not github-actions; ignoring its body for cursor state`)
      }
    }
  } catch (err) {
    // Posting runs must not guess at state; a dry run degrades to bootstrap.
    const msg = String(err.message ?? err).slice(0, 300)
    if (POST) fail(`gh read failed (cannot establish cursor state): ${msg}`)
    console.log(`::warning::gh unavailable in dry run (${msg}); treating as first run`)
  }
}

// Newest delta marker across bot comments (oldest to newest order) = the cursor.
//
// Only the TRAILER counts: the last non-blank line of the body, matched whole.
// A global scan would accept a marker anywhere in the text, and the digest body
// contains model output. A full-mode digest has no authoritative delta trailer
// of its own, so under a global scan a model that emitted a delta-shaped marker
// (spontaneously, or because a file in the reviewed repo told it to) would
// become the cursor and skip every commit up to whatever SHA it named. Reading
// only the trailer makes the marker a property of the digest's structure rather
// than of its contents, and a full digest's own `mode=full` trailer then
// actively shields any injected marker above it.
const cursor = readCursor(previousComments)

// Carry-forward reads ONLY the newest digest comment: its unchecked "- [ ]"
// items (new findings and previously carried ones alike) roll forward; items
// checked off retire. Both this and the cursor live in
// digest-state.mjs so CI exercises the real implementations.
const carried = readCarried(previousComments)

// ── build the review input ──────────────────────────────────────────────────
const notes = [] // disclosure lines that go in the digest header
let inputText = ''
let rangeLabel = ''
let base = null

if (MODE === 'delta') {
  if (cursor) {
    try {
      // --is-ancestor, not cat-file -e: after a history rewrite a commit can
      // still exist while no longer being on the branch, and a diff against it
      // would cover a range that never merged. Only an ancestor check proves
      // the base is real.
      await git('merge-base', '--is-ancestor', cursor, head)
      base = cursor
    } catch {
      notes.push(`⚠️ recorded cursor \`${short(cursor)}\` is not an ancestor of \`${defaultBranch}\` (history rewritten?); fell back to a ${BOOTSTRAP_DAYS}-day window`)
    }
  } else {
    notes.push(`ℹ️ first run: no cursor found, bootstrapping from a ${BOOTSTRAP_DAYS}-day window`)
  }
  if (!base) {
    base = (await git('rev-list', '-1', `--before=${BOOTSTRAP_DAYS} days ago`, `origin/${defaultBranch}`)).trim()
    if (!base) {
      // A repository younger than the bootstrap window has no commit old enough
      // to be a base. That is not the ambiguous case the hard failure exists
      // for: the whole history is right there and reviewable. Failing instead
      // would wedge every run until the repo simply aged past the window.
      base = (await git('rev-list', '--max-parents=0', `origin/${defaultBranch}`)).trim().split('\n').pop()
      if (!base) fail(`delta base unresolvable: no cursor, no commit older than ${BOOTSTRAP_DAYS} days, and no root commit; refusing to guess (this is a hard failure by design, not a quiet period)`)
      notes.push(`ℹ️ repository is younger than the ${BOOTSTRAP_DAYS}-day bootstrap window; reviewed from the first commit \`${short(base)}\` (that commit's own contents are not in a diff against itself, so run full mode once for a complete baseline)`)
    }
  }
  if (base === head) {
    // Notes ride along. A heartbeat that silently swallowed the force-push
    // warning would report a calm quiet period at the exact moment the cursor
    // had just been discovered unreachable.
    const heartbeat = [
      `🫀 Quiet period: 0 commits on \`${defaultBranch}\` since \`${short(base)}\` (checked ${today}). Cursor unchanged.`,
      ...(notes.length ? ['', notes.map((n) => `> ${n}`).join('\n')] : []),
    ].join('\n')
    await deliver(heartbeat, { heartbeat: true })
    process.exit(0)
  }
  const log = (await git('log', '--oneline', '--no-decorate', `${base}..${head}`)).trim()
  const commitCount = log ? log.split('\n').length : 0
  const diff = await git('diff', `${base}..${head}`, '--', '.',
    ':(exclude)*package-lock.json', ':(exclude)*.lock', ':(exclude)*pnpm-lock.yaml', ':(exclude)*bun.lockb', ':(exclude)*go.sum')
  rangeLabel = `\`${short(base)}..${short(head)}\`, ${commitCount} commits`
  inputText = `## Commits in range\n${log}\n\n## Combined diff (lockfiles excluded)\n${diff}`
} else {
  // full: the tracked code corpus at HEAD. Code-only by default; the docs paths
  // are opt-in because they are prose and can dwarf the code.
  // Audio and video are skipped by default: one large tracked media file is
  // enough to abort a full run on a section that cannot be packed.
  // `ls-files -s -z`, not a bare `ls-files`, for two independent reasons.
  //
  // 1. SECURITY. The bare version emits paths that get read with readFileSync,
  //    which FOLLOWS SYMLINKS. A repo that tracks a symlink to
  //    /proc/self/environ would make this script read the step environment and
  //    send it to the model provider, and that environment holds the API key
  //    and GH_TOKEN. The staged form reports each path's mode, so only regular
  //    blobs (100644) and executables (100755) are read; symlinks (120000) and
  //    submodule gitlinks (160000) are skipped by construction. An lstat guard
  //    below backstops it in case the working tree diverges from the index.
  // 2. CORRECTNESS. -z is NUL delimited, so paths containing newlines (legal in
  //    git) do not silently split into two bogus entries.
  const READABLE_MODES = new Set(['100644', '100755'])
  const skipped = { symlink: 0, submodule: 0 }
  const files = []
  for (const entry of (await git('ls-files', '-s', '-z')).split('\0')) {
    if (!entry) continue
    // "<mode> <sha> <stage>\t<path>"
    const tab = entry.indexOf('\t')
    if (tab === -1) continue
    const mode = entry.slice(0, entry.indexOf(' '))
    const f = entry.slice(tab + 1)
    if (!READABLE_MODES.has(mode)) {
      if (mode === '120000') skipped.symlink++
      else if (mode === '160000') skipped.submodule++
      continue
    }
    if (BINARY.test(f) || LOCKFILES.has(path.basename(f)) || f.endsWith('.lock')) continue
    if (DOCS_PATHS.some((p) => f.startsWith(p))) { if (INCLUDE_DOCS) files.push(f); continue }
    files.push(f)
  }
  if (skipped.symlink) notes.push(`ℹ️ skipped ${skipped.symlink} tracked symlink(s); the corpus only includes regular files`)
  if (skipped.submodule) notes.push(`ℹ️ skipped ${skipped.submodule} submodule(s); this digest reviews one repository`)
  const parts = []
  let dropped = 0
  let escaped = 0
  for (const f of files) {
    // Scoped to the caller checkout, never process.cwd(): this script runs from
    // the central checkout, one directory over.
    const full = path.join(CALLER_DIR, f)
    // lstat alone is not enough: it refuses to follow the FINAL component, but
    // a symlinked ANCESTOR directory ("sub" -> /outside, with sub/file.js in the
    // index) still escapes and was reproduced doing so. realpath resolves the
    // whole chain, and the containment test is what actually holds.
    let real
    try {
      if (!fs.lstatSync(full).isFile()) { dropped++; continue }
      real = fs.realpathSync(full)
    } catch { dropped++; continue }
    if (real !== CALLER_REAL && !real.startsWith(CALLER_REAL + path.sep)) {
      escaped++
      continue
    }
    parts.push(`### File: ${f}\n\`\`\`\n${fs.readFileSync(real, 'utf8')}\n\`\`\``)
  }
  inputText = parts.join('\n')
  if (escaped) notes.push(`⚠️ ${escaped} tracked path(s) resolved outside the repository and were excluded; nothing outside \`${CALLER_DIR}\` is ever sent to the model`)
  if (dropped) notes.push(`ℹ️ skipped ${dropped} tracked path(s) that are not regular files in the working tree`)
  // parts.length, not files.length: the guards above can drop entries the index
  // still lists, and the header must state what was actually reviewed.
  rangeLabel = `whole repo at \`${short(worktreeHead)}\`, ${parts.length} files${INCLUDE_DOCS ? ' (docs included)' : ' (code only)'}`
  // Scanning a branch on purpose is a legitimate use of a manual dispatch, so
  // this discloses rather than blocks; what must never happen is the digest
  // reading as a clean scan of the default branch when it was not one.
  if (worktreeHead !== head) {
    notes.push(`⚠️ scanned the checked-out ref \`${short(worktreeHead)}\`, NOT \`origin/${defaultBranch}\` (\`${short(head)}\`); findings below may describe branch-only code`)
  }
}

const inputTokens = estTokens(inputText)
if (inputTokens > WARN_INPUT_TOKENS) {
  // Context quality is the reason this line exists now that the long-context
  // surcharge has shrunk: a single call this large degrades attention across
  // the middle of the input long before it becomes expensive. The billing
  // effect is secondary and model dependent.
  console.log(`::warning::input ~${num(inputTokens)} tokens exceeds the ${num(WARN_INPUT_TOKENS)}-token review line; recall degrades across an input this size, and on tiered models it may also bill at a long-context rate`)
}

// Chunking is the fallback, not the default: one call preserves the cross-file
// reasoning this layer exists for. Chunks split on file boundaries and each is
// disclosed in the digest header.
const chunks = []
if (inputTokens <= CHUNK_INPUT_TOKENS) {
  chunks.push(inputText)
} else {
  // Split points must exist in the input being split: full mode has
  // "### File:" headers, but delta input is a raw combined diff whose only file
  // boundaries are "diff --git" lines. Splitting delta on the full-mode pattern
  // would yield one oversized chunk sent anyway; and since a failed run never
  // advances the cursor, an over-ceiling period would then fail every cycle
  // until rescued.
  const sections = MODE === 'full'
    ? inputText.split(/(?=^### File: )/m)
    : inputText.split(/(?=^diff --git )/m)
  // A single section larger than the ceiling cannot be packed and would ship as
  // an unbounded request that fails every run without moving the cursor. Fail
  // loudly with the culprits named; the fix is a pathspec exclusion or a
  // deliberate ceiling bump.
  const oversized = sections.filter((s) => estTokens(s) > CHUNK_INPUT_TOKENS)
  if (oversized.length) {
    const names = oversized.map((s) => s.split('\n', 1)[0].slice(0, 120))
    fail(`${oversized.length} single file section(s) exceed the ${num(CHUNK_INPUT_TOKENS)}-token chunk ceiling and cannot be packed: ${names.join(' | ')}`)
  }
  let current = ''
  for (const s of sections) {
    if (current && estTokens(current) + estTokens(s) > CHUNK_INPUT_TOKENS) { chunks.push(current); current = '' }
    current += s
  }
  if (current) chunks.push(current)
  notes.push(`⚠️ input ~${num(inputTokens)} tokens exceeded the ${num(CHUNK_INPUT_TOKENS)} single-call ceiling; reviewed in ${chunks.length} file-boundary chunks (cross-chunk interactions not visible to the model)`)
}

// Chunked runs must fit the job's wall clock. client_timeout_ms is PER ATTEMPT,
// each chunk gets two attempts, and chunks run sequentially, so worst case is
// chunks * 2 * timeout. Against a flat 70-minute job that means two chunks
// (121 min worst case) get killed mid-run. A killed job posts nothing, so the
// cursor does not move, so the next range is larger, so it chunks harder and is
// killed again: the same permanent wedge as an oversized body, but this one also
// bills for every chunk that completed before the kill. Rescale to fit.
if (JOB_BUDGET_MS && chunks.length) {
  const ATTEMPTS = 2
  const RESERVE_MS = 5 * 60_000 // checkout, node setup, and the post itself
  const FLOOR_MS = 300_000 // below this a reasoning call cannot realistically finish
  const perAttempt = Math.floor(Math.max(0, JOB_BUDGET_MS - RESERVE_MS) / (chunks.length * ATTEMPTS))
  if (perAttempt < CLIENT_TIMEOUT_MS) {
    if (perAttempt < FLOOR_MS) {
      fail(`this run needs ${chunks.length} model call(s) and the job allows ${Math.round(JOB_BUDGET_MS / 60000)} minutes, which leaves ${Math.round(perAttempt / 1000)}s per attempt: below the ${FLOOR_MS / 1000}s floor. Raise job_timeout_minutes to at least ${Math.ceil((chunks.length * ATTEMPTS * FLOOR_MS + RESERVE_MS) / 60000)}, or lower chunk_input_tokens so fewer calls are needed. Refusing to start a run that cannot finish.`)
    }
    console.log(`::warning::${chunks.length} chunks share a ${Math.round(JOB_BUDGET_MS / 60000)}-minute job budget; per-attempt timeout reduced from ${CLIENT_TIMEOUT_MS / 1000}s to ${Math.round(perAttempt / 1000)}s so the run fits`)
    CLIENT_TIMEOUT_MS = perAttempt
  }
}

// ── the prompt ──────────────────────────────────────────────────────────────
// Loaded from prompts/digest-prompt.txt and hashed, so a posted digest names
// the prompt that produced it and two digests are knowably comparable.
const PROMPT_EXTRA = str('DIGEST_PROMPT_EXTRA', '')
const promptVars = {
  default_branch: defaultBranch,
  prompt_extra: PROMPT_EXTRA ? ` ${PROMPT_EXTRA.trim()}` : '',
  findings_cap: FINDINGS_CAP,
  word_cap: WORD_CAP,
}
let SYSTEM, INSTRUCTIONS, FORMAT
try {
  SYSTEM = render(PROMPT.sections.system, promptVars)
  INSTRUCTIONS = render(PROMPT.sections[`instructions.${MODE}`], promptVars)
  FORMAT = render(PROMPT.sections.format, promptVars)
} catch (err) {
  fail(`cannot render the prompt: ${String(err.message ?? err)}`)
}

// ── the model call ──────────────────────────────────────────────────────────
async function callModel(user, attempt = 1) {
  if (STUB) {
    const content = fs.readFileSync(STUB, 'utf8')
    // Derived rather than fixed so a stub run exercises the whole cost-footer
    // path with plausible numbers instead of skipping it.
    return { content, finish: 'stop', usage: { prompt_tokens: estTokens(user), completion_tokens: estTokens(content), stub: true } }
  }
  // The workflow hands over only the key the selected provider needs, under a
  // neutral name, so this process never holds the other family's credential.
  // DIGEST_KEY_ENV is kept purely to name the missing secret in the error.
  const key = str('DIGEST_API_KEY', '') || process.env[MODEL.keyEnv]
  if (!key) fail(`no API key available: the workflow must map ${MODEL.keyEnv} as an explicit secret for this provider`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS)
  try {
    const res = await fetch(`${MODEL.base}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL.model,
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        ...(MODEL.effort ? { reasoning_effort: MODEL.effort } : {}),
        // Streaming is a transport decision, not a product one. A full-mode
        // max-effort call reasons silently for 5+ minutes before its first
        // token, and the non-streaming version of this request died at ~300s
        // with undici's "fetch failed", twice, identically, waiting for
        // response headers that only arrive after reasoning completes (undici's
        // default headersTimeout is 300s, so the client itself was the killer).
        // With stream: true the 200 and first SSE bytes arrive within seconds
        // and the socket stays warm through the thinking phase. include_usage
        // is what makes the cost footer and the usage log line possible: the
        // stream's final chunk carries the token counts.
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
      }),
    })
    if ((res.status === 429 || res.status >= 500) && attempt === 1) {
      console.log(`::warning::model API returned ${res.status}; retrying once in 30s`)
      await new Promise((r) => setTimeout(r, 30_000))
      return callModel(user, 2)
    }
    if (!res.ok) fail(`model API error ${res.status}: ${(await res.text()).slice(0, 300)}`)
    // Minimal SSE accumulator, dependency-free like the rest of this script:
    // "data: {json}" lines terminated by "data: [DONE]". Visible text arrives in
    // choices[0].delta.content (reasoning deltas keep the connection warm but
    // are not part of the digest); finish_reason rides the last content chunk;
    // usage rides a final chunk with empty choices. A partial line at a read
    // boundary is carried over, and a malformed data line throws so the outer
    // catch gets the same one-retry the old whole-body JSON parse path had.
    let content = ''
    let finish = null
    let usage = null
    let buf = ''
    const decoder = new TextDecoder()
    const consume = (line) => {
      // 'data:' with the space optional: the SSE spec allows both, and a
      // compliant proxy emitting 'data:{...}' would otherwise have every chunk
      // silently ignored (fail-closed via the hollow-digest guard, but
      // misleading to debug).
      if (!line.startsWith('data:')) return
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') return
      let chunk
      try { chunk = JSON.parse(payload) } catch { throw new Error(`unparseable stream chunk: ${payload.slice(0, 200)}`) }
      const choice = chunk.choices?.[0]
      if (choice?.delta?.content) content += choice.delta.content
      if (choice?.finish_reason) finish = choice.finish_reason
      if (chunk.usage) usage = chunk.usage
    }
    for await (const bytes of res.body) {
      buf += decoder.decode(bytes, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) consume(line)
    }
    // Flush: a stream that ends without a trailing newline leaves its last line
    // in buf (and possibly bytes in the decoder). Both endpoints do terminate
    // with a newline after [DONE], but a proxy that does not would otherwise
    // silently cost the run its finish_reason and usage chunk and turn a clean
    // completion into a spurious fail-closed. consume() is reused so the flush
    // path shares the loop's parse-error handling.
    buf += decoder.decode()
    if (buf) consume(buf)
    // Token accounting also goes to the log, not only the footer: it is the
    // evidence that the effort setting is honored (reasoning tokens move with
    // it), and the log survives a run that fails before it can post.
    console.log(`model usage: ${JSON.stringify(usage ?? {})}`)
    if (!content.trim()) fail('model returned an empty review; refusing to post a hollow digest (and refusing to advance the cursor)')
    // Fail closed on any termination that is not clean completion or the
    // disclosed-truncation case: a content_filter or unknown finish would
    // otherwise be cursored past as if the range had been reviewed.
    if (!['stop', 'length'].includes(finish)) {
      fail(`model terminated with finish_reason=${finish}; not posting (cursor unchanged)`)
    }
    return { content: content.trim(), finish, usage }
  } catch (err) {
    if (err.name === 'AbortError') {
      if (attempt === 1) {
        console.log(`::warning::model call timed out after ${CLIENT_TIMEOUT_MS / 1000}s; retrying once`)
        return callModel(user, 2)
      }
      fail(`model call timed out twice at ${CLIENT_TIMEOUT_MS / 1000}s`)
    }
    // undici wraps the real transport error (e.g. UND_ERR_HEADERS_TIMEOUT) in
    // err.cause; err.message alone is a bare "fetch failed". Log the cause or
    // the next transport failure costs the diagnosis all over again.
    const detail = err.cause ? ` (cause: ${String(err.cause).slice(0, 200)})` : ''
    if (attempt === 1) {
      console.log(`::warning::model call failed (${String(err.message ?? err).slice(0, 200)}${detail}); retrying once in 30s`)
      await new Promise((r) => setTimeout(r, 30_000))
      return callModel(user, 2)
    }
    fail(`model call failed twice: ${String(err.message ?? err).slice(0, 300)}${detail}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Estimated dollar cost of one call. Priced per call, not on the summed totals,
 * because a tiered model's long-context rate is decided by that call's own
 * input size: two 200k calls are not billed like one 400k call.
 * Returns null when the model is unpriced or the endpoint reported no usage,
 * which the footer then discloses rather than guessing at.
 */
function costFor(usage) {
  const p = PRICING[MODEL.model]
  if (!p || !usage) return null
  const inTok = Number(usage.prompt_tokens)
  const outTok = Number(usage.completion_tokens)
  if (!Number.isFinite(inTok) || !Number.isFinite(outTok)) return null
  const long = Number.isFinite(Number(p.long_threshold)) && inTok > Number(p.long_threshold)
  const rateIn = long && p.long_in != null ? Number(p.long_in) : Number(p.in)
  const rateOut = long && p.long_out != null ? Number(p.long_out) : Number(p.out)
  if (!Number.isFinite(rateIn) || !Number.isFinite(rateOut)) return null
  return (inTok / 1e6) * rateIn + (outTok / 1e6) * rateOut
}

/**
 * Neutralize model output before it is posted.
 *
 * The digest sends repository content to a model and posts what comes back
 * verbatim into an issue, so anything that can land text in a reviewed repo can
 * influence that text. Two constructs do something when GitHub renders them:
 *
 *  - Images. GitHub fetches `![](https://host/path)` server-side through its
 *    camo proxy, and issue notification emails load them too. A model induced
 *    to emit an image URL with reviewed source encoded in the query string
 *    exfiltrates that source to whoever owns the host, with no click required.
 *  - HTML comments. This script's own state trailer is an HTML comment, so
 *    model-emitted comments are the raw material for a forged one. The trailer
 *    rule already refuses anything that is not the final line, but leaving the
 *    syntax intact means one parser change away from a live forgery.
 *
 * Links are left alone: they need a click, and a reviewer following one is a
 * decision rather than an automatic fetch.
 */
// Model output is scrubbed in scripts/digest-sanitize.mjs, which CI tests
// directly. See that file for the threat and what each rule blocks.

const sections = []
let truncated = false
let tokensIn = 0
let tokensOut = 0
let cost = 0
let costKnown = true
let usageKnown = true
// Test hook: the composed prompt is the only place reviewed file contents ever
// appear, so an assertion that the corpus excludes something has to inspect
// THIS, not the digest output. Writes plaintext repo source; CI-only.
const DUMP_PROMPT = str('DIGEST_DEBUG_DUMP_PROMPT', '')
if (DUMP_PROMPT) fs.writeFileSync(DUMP_PROMPT, '')
for (const [i, chunk] of chunks.entries()) {
  const chunkNote = chunks.length > 1 ? `\n(You are seeing chunk ${i + 1} of ${chunks.length}; other chunks are reviewed separately.)` : ''
  const userMessage = `${INSTRUCTIONS}${chunkNote}\n\n${FORMAT}\n\n---\n\n${chunk}`
  if (DUMP_PROMPT) fs.appendFileSync(DUMP_PROMPT, userMessage)
  const { content, finish, usage } = await callModel(userMessage)
  if (finish === 'length') truncated = true
  if (usage && Number.isFinite(Number(usage.prompt_tokens))) {
    tokensIn += Number(usage.prompt_tokens)
    tokensOut += Number(usage.completion_tokens) || 0
  } else {
    usageKnown = false
  }
  const c = costFor(usage)
  if (c === null) costKnown = false
  else cost += c
  const safe = neutralize(content)
  sections.push(chunks.length > 1 ? `#### Chunk ${i + 1}/${chunks.length}\n${safe}` : safe)
}
if (truncated) notes.unshift('⚠️ the model hit the output-token ceiling (finish_reason=length); findings below may be incomplete')

// ── compose and deliver ─────────────────────────────────────────────────────
function wallClock(ms) {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

// The cost footer. Self-collecting telemetry: without it, "what does this cost"
// is a question answered by digging through Actions logs and two invoices.
const footerBits = [
  `\`${MODEL.model}\``,
  usageKnown ? `in ${num(tokensIn)} / out ${num(tokensOut)} tokens` : 'token usage not reported by the endpoint',
  costKnown && usageKnown
    ? `est. $${cost.toFixed(cost < 1 ? 3 : 2)}`
    : (usageKnown ? 'cost not estimated (model not in the pricing table)' : 'cost not estimated (no usage reported)'),
  wallClock(Date.now() - startedAt),
  `prompt \`${PROMPT.hash}\``,
  ...(chunks.length > 1 ? [`${chunks.length} calls`] : []),
  ...(STUB ? ['**STUB RUN, no model was called**'] : []),
]

const headerBits = [
  `**${MODE}** · ${MODEL.label}${MODEL.effort ? ` · effort ${MODEL.effort}` : ''}`,
  rangeLabel,
  `input ~${num(inputTokens)} tokens`,
]

// The state trailer must be the LAST line, always: the next run reads only the
// trailer, so anything appended after it would orphan the cursor.
const build = (findingsText, carriedText) => [
  `## 🤖 AI digest: ${today}`,
  headerBits.join(' · '),
  ...(notes.length ? ['', notes.map((n) => `> ${n}`).join('\n')] : []),
  '',
  '### New findings',
  findingsText,
  '',
  '### Still open from previous digests',
  carriedText,
  '',
  '---',
  `<sub>${footerBits.join(' · ')}</sub>`,
  '',
  // Deliberately not trailer-shaped: this is provenance, not state.
  `<!-- ai-digest-meta prompt=${PROMPT.hash}${CENTRAL_REF ? ` central=${CENTRAL_REF}` : ''} -->`,
  ...(MODE === 'delta' ? [`<!-- ai-digest mode=delta base=${base} head=${head} -->`] : [`<!-- ai-digest mode=full head=${worktreeHead} -->`]),
].join('\n')

/** Cut at a line boundary where possible and say how much was dropped. */
function clip(text, budget, label) {
  if (text.length <= budget) return text
  const room = Math.max(0, budget - 160)
  const head = text.slice(0, room)
  const nl = head.lastIndexOf('\n')
  const kept = nl > room / 2 ? head.slice(0, nl) : head
  return `${kept}\n\n_[${label} truncated: ${num(text.length - kept.length)} more characters did not fit GitHub's comment limit. Full text is in the Actions run log.]_`
}

let findingsText = sections.join('\n\n')
let carriedText = carried.length ? carried.join('\n') : '_none: check items off above to retire them; unchecked ones carry forward_'

if (build(findingsText, carriedText).length > MAX_BODY_CHARS) {
  // Log the untrimmed digest before trimming: the run log is the archive, and
  // a truncated post must never be the only copy of a finding.
  console.log('::group::untrimmed digest')
  console.log(build(findingsText, carriedText))
  console.log('::endgroup::')
  notes.unshift(`⚠️ this digest exceeded GitHub's ${num(GITHUB_BODY_LIMIT)}-character comment limit and was trimmed to fit; the untrimmed text is in this run's log`)
  const overhead = build('', '').length
  const avail = Math.max(0, MAX_BODY_CHARS - overhead)
  // Carried findings yield first: they are a repeat of text already posted,
  // while the new findings are the reason the run happened at all.
  carriedText = clip(carriedText, Math.floor(avail * 0.3), 'carry-forward list')
  findingsText = clip(findingsText, Math.max(0, avail - carriedText.length), 'findings')
}

let body = build(findingsText, carriedText)
if (body.length > GITHUB_BODY_LIMIT) {
  // Belt and braces. If the trimming math is ever wrong, posting a hard-cut
  // body still beats a 422 that wedges the cursor forever.
  const trailerAt = body.lastIndexOf('\n<!-- ai-digest mode=')
  const trailer = body.slice(trailerAt)
  body = `${body.slice(0, GITHUB_BODY_LIMIT - trailer.length - 64)}\n\n_[hard truncated]_${trailer}`
}

await deliver(body, { heartbeat: false })

async function deliver(text, { heartbeat }) {
  if (!POST) {
    console.log('\n===== DIGEST (dry run, not posted) =====\n')
    console.log(text)
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
    return
  }
  // RUNNER_TEMP, not the working directory: with two checkouts in play, writing
  // a scratch file into the caller's tree would make it visible to that tree's
  // own git commands and to a full-mode ls-files on a later run.
  const bodyFile = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'ai-digest-comment.md')
  fs.writeFileSync(bodyFile, text)
  if (!issueNumber) {
    // Create first, assign second. `gh issue create --assignee` fails the whole
    // create when the login cannot be assigned (not a collaborator, or a
    // renamed account), which would turn a cosmetic problem into a lost digest.
    const url = (await gh(['issue', 'create', '--repo', REPO, '--title', ISSUE_TITLE, '--body-file', bodyFile])).trim()
    console.log(`created rolling issue: ${url}`)
    const created = url.match(/\/issues\/(\d+)\s*$/)
    if (ASSIGNEE && created) {
      try {
        await gh(['issue', 'edit', created[1], '--repo', REPO, '--add-assignee', ASSIGNEE])
      } catch (err) {
        console.log(`::warning::could not assign the rolling issue to ${ASSIGNEE} (${String(err.message ?? err).slice(0, 200)}); the digest posted fine, but nobody is subscribed to it. Assign it by hand or set the assignee input.`)
      }
    }
  } else {
    await gh(['issue', 'comment', String(issueNumber), '--repo', REPO, '--body-file', bodyFile])
    console.log(`commented on issue #${issueNumber}${heartbeat ? ' (heartbeat)' : ''}`)
  }
}
