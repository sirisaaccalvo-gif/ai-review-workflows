# ai-review-workflows

A reusable GitHub Actions workflow that gives a repository a scheduled
cross-family AI code review, posted to one rolling issue that acts as its own
database.

Two modes:

- **delta** (the cron): reviews the combined diff of everything merged to the
  default branch since the last digest posted. Default model GPT-5.6 Terra.
- **full** (manual dispatch): reviews the whole tracked code corpus. Default
  model Kimi K3 at max reasoning effort. Never advances the delta cursor.

The consuming repo keeps a ~30 line stub. The script, the prompt, the state
machine, and the model plumbing live here.

## Why you might want this

**A different model family reads your code than the one that helped write it.**
If you code with an AI assistant in your terminal, whatever wrote the change is
a poor choice to also judge it: models from one family share blind spots, so
agreement between them is weaker evidence than it looks. Pointing a second
family at what actually merged is the cheapest way to break that correlation.
You choose the families; the workflow only needs an OpenAI-compatible endpoint.

**It runs on API tokens, not another subscription.** A monthly digest over a
normal month of commits costs cents. A full-repo deep read on a mid-sized
codebase runs to a dollar or two. There is no seat, no plan, and no per-repo
pricing: you pay for the tokens you actually use, and every digest prints its
own cost so you can see what it was. Nothing is metered by this workflow.

**It is scheduled, so it does not depend on anyone remembering.** Review that
happens when you think to ask for it is review that stops happening in a busy
week. This runs on a cron, resumes from exactly where the last one stopped, and
posts a heartbeat even when nothing merged, so silence means a broken cron
rather than a quiet month.

**It fits an AI-assisted workflow instead of replacing it.** The digest reads
what merged, so it is a net under your process rather than a gate in it. It
composes well with a review step before merge and badly with being the only
thing you rely on.

## Who this is for

Anyone who wants a scheduled AI review on their own repositories without
maintaining the machinery for it. Bring your own API key; runs bill to your
repo, and this workflow stores nothing.

**One repository is a perfectly good reason to use it.** You get the scheduled
review, the rolling issue, the resume-from-where-it-stopped cursor, and the cost
footer, for a stub you can read in one screen.

It also holds up across several repositories, which is the harder case it was
built for. Everything that tends to differ between repos is an input rather than
a code change: which model runs in which mode, which provider, which paths count
as prose, what to weight the review toward. So repo-specific choices do not
become repo-specific copies of the script that drift apart and then have to be
reconciled by hand.

---

## Quick start

**You do not fork or clone this.** You add one workflow file to your own repo
that references this one with `uses:`, and GitHub fetches it at the commit you
pin. Cloning is only for running your own private copy.

1. Copy [`examples/caller-stub.yml`](examples/caller-stub.yml) to
   `.github/workflows/ai-digest.yml` in the consuming repo.
2. Replace **both** `REPLACE_WITH_FULL_COMMIT_SHA` placeholders with the same
   full 40 character commit SHA of this repo: once on the `uses:` line, once as
   the `central_ref` input. The workflow and the script it runs are versioned
   together, so both have to point at the same commit.
3. Add the API key secrets you need to that repo.
4. Dispatch it once with `post: false` to see the digest in the job summary
   without touching anything.

### The permissions block, verbatim

The caller **must** declare this at workflow level. A called workflow can only
narrow the caller's `GITHUB_TOKEN`, never widen it, so the block below is the
real grant and the one in this repo's workflow is only a ceiling.

```yaml
permissions:
  contents: read
  issues: write
```

Omit it and the run fails at post time with a 403, after paying for the model
call.

### Secrets

Map explicitly. Never `secrets: inherit`, which would hand a workflow defined in
another repository every secret the calling repo holds.

```yaml
secrets:
  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
  MOONSHOT_API_KEY: ${{ secrets.MOONSHOT_API_KEY }}
```

Map only what your modes use. A repo running both modes on Moonshot does not
need `OPENAI_API_KEY` at all.

---

## Inputs

Every input is optional. Defaults live in exactly one place, the `Resolve
configuration` step of [`ai-digest.yml`](.github/workflows/ai-digest.yml).

| Input | Default | Notes |
|---|---|---|
| `central_repo` | this repo | only change it if you run your own copy; integrity does not rest on it |
| `central_ref` | **required** | the same SHA as your `uses:` line; no default, on purpose |
| `mode` | `delta` | `delta` or `full` |
| `post` | `true` | `false` = dry run to the job summary |
| `include_docs` | `false` | full mode only |
| `delta_model_label` | `GPT-5.6 Terra` | shown in the digest header |
| `delta_provider` | `openai` | `openai` or `moonshot`; picks endpoint **and** secret |
| `delta_model` | `gpt-5.6-terra` | |
| `delta_effort` | `high` | empty omits `reasoning_effort` |
| `delta_max_completion_tokens` | `32768` | |
| `full_model_label` | `Kimi K3 (max reasoning)` | |
| `full_provider` | `moonshot` | |
| `full_model` | `kimi-k3` | |
| `full_effort` | *(empty)* | K3's API default already is max effort |
| `full_max_completion_tokens` | `131072` | |
| `issue_title` | `🤖 AI weekly code digest (automated)` | **see the warning below** |
| `assignee` | repository owner | best effort; a failed assignment warns, never fails the digest |
| `docs_paths` | `docs/,.planning/` | prose prefixes gated behind `include_docs` |
| `binary_extensions` | images, fonts, archives, audio, video | regex alternation |
| `prompt_extra` | *(empty)* | one or two sentences of repo-specific risk weighting |
| `pricing` | Terra + K3 | JSON keyed by model id, for the cost footer |
| `warn_input_tokens` | `250000` | |
| `chunk_input_tokens` | `700000` | file-boundary chunking above this |
| `client_timeout_ms` | `1800000` | per attempt |
| `bootstrap_window_days` | `31` | first run and unreachable-cursor fallback |
| `findings_cap` / `word_cap` | `12` / `2500` | rendered into the prompt |
| `node_version` | `24` | |

> **`issue_title` is load bearing.** The rolling issue is found by exact title
> match. Changing it on a live repo orphans that repo's cursor and its carried
> findings, and the next run bootstraps a duplicate issue. The default still says
> "weekly" while the example cron is monthly: that is deliberate, because the
> title is an identifier rather than a description and renaming it costs more
> than the inaccuracy does. New adopters can pick any title they like.

There is deliberately **no base-URL input**. `*_provider` is a closed enum that
selects a hardcoded endpoint together with the matching secret. A free-form URL
would let anyone who can edit a caller stub redirect a live API key to a host of
their choosing, and the digest output would look entirely normal while doing it.

---

## How the state machine works

The rolling issue **is** the database.

Every posted delta digest ends with a marker:

```html
<!-- ai-digest mode=delta base=<sha> head=<sha> -->
```

The next run scans the issue body and every comment authored by
`github-actions[bot]`, takes the newest such trailer, and resumes from its
`head`. The cursor advances only when a
delta digest actually posts, so a failed run re-reviews the same range next
cycle instead of losing it. A wall-clock window would silently drop commits on
any failed, late, or skipped run.

Loud fallbacks, never quiet ones:

- No cursor (first run) or a cursor that is no longer an ancestor of the default
  branch (force push): fall back to a `bootstrap_window_days` window and say so
  in the digest header.
- No resolvable base at all: hard failure. Never a silently quiet period.
- Nothing merged since the cursor: a one-line heartbeat posts with **no** marker
  and **no** API call. A missing scheduled post has to be readable as a broken
  cron, so every scheduled run posts something.
- Model or plumbing failure: exit 1, post nothing. A hollow digest would advance
  the cursor over an unreviewed range.
- `finish_reason=length`: posts **with** a truncation banner. Disclosed partial
  coverage beats silence.

Full mode writes `<!-- ai-digest mode=full head=<sha> -->`, which deliberately
does not match the cursor pattern, so a deep read never advances the delta
cursor.

**State is read from the trailer only**: the last line of the body, matched
whole. A digest body contains model output, so a marker found anywhere else is
ignored. Without that rule a full-mode digest, which has no delta trailer of its
own, could adopt a delta marker the model emitted and skip every commit up to
whatever SHA it named.

Bodies and comments are matched against the login `github-actions[bot]`
**exactly**. A substring test on `github-actions` also accepts ordinary user
accounts (`github-actions-repo` and similar exist on github.com today), any of
which could post a handcrafted trailer. When several issues share the title, the
**lowest-numbered** one wins, so nobody can relocate the state store by opening a
newer issue with the same name.

**Digests are trimmed to fit GitHub's 65536-character comment limit.** The word
and findings caps live in the prompt, and a model can exceed them; in chunked
mode each call gets the full allowance independently. An over-limit post is
rejected, which leaves the cursor unmoved, which makes the next run larger, which
fails again: unbounded, that wedges permanently. Carried findings are trimmed
first, then new findings, the truncation is stated in the digest, and the
untrimmed text goes to the run log.

**Full mode reads regular files only.** Tracked symlinks and submodules are
skipped and the skip is disclosed. Reading through a symlink would let a repo
that tracks a link to `/proc/self/environ` put the workflow's API key and token
into the prompt.

Unchecked `- [ ]` findings carry forward mechanically from the newest digest.
Check an item off to retire it. Carried findings are **never** fed back into the
model prompt: prompt-fed dedup both suppresses still-real findings and adds an
injection surface.

## Versioning

Callers pin to a **full commit SHA**, and `central_ref` is validated to be one:
a branch or tag name is rejected outright. Content at a SHA is immutable, and
that is what makes the pin mean anything. There are currently no tags or
releases on this repo.

**Integrity comes from content, not from a ref.** A called reusable workflow
cannot discover its own origin: `github.job_workflow_ref` and
`github.job_workflow_sha` are both empty in a real cross-repo call (measured,
not assumed), and `github.workflow_ref` points at the *caller's* entry workflow.
So "check this repo out at the ref I was invoked at" is not expressible.

Instead the caller passes the same SHA twice, once to pin the workflow and once
as `central_ref` to fetch the assets, and the job hashes what it fetched and
refuses to run unless it matches `EXPECTED_ASSETS_SHA256`, a literal baked into
the workflow file. The hash is computed by an inline implementation in the
workflow, never by running code out of the checkout being verified, and it
covers the hashing script itself.

**The immutability of the SHA is the primary control; the hash is the second
line.** The two together mean a drift between the workflow and its script fails
the job rather than running a mismatched pair. Since you pin the workflow file to a full commit
SHA, your pin fixes that literal, and the literal fixes the code that runs with
your API keys. A moved tag, a force-pushed branch, or a compromised default
branch all fail the job rather than executing. That is a stronger guarantee than
any ref-based scheme, which can only ever be as immutable as the ref.

Each posted digest embeds the prompt hash:

```html
<!-- ai-digest-meta prompt=<hash> central=<ref> -->
```

CI fails if `prompts/digest-prompt.txt` no longer matches
`prompts/digest-prompt.sha256`, so a prompt change cannot land invisibly. Treat
prompt changes as breaking and note them in release notes: digests carrying
different prompt hashes are not comparable.

## The cost footer

Each digest ends with one line: model, tokens in and out, estimated cost,
wall-clock, prompt hash.

The cost is an **estimate**, priced per call from the `pricing` input. It
ignores cached-input discounts and any negotiated rate, and a tiered model's
long-context rate is applied per call rather than on summed totals, because two
200k calls are not billed like one 400k call. An unpriced model reports "cost
not estimated" rather than guessing.

---

## Disclosures

Read these before adopting.

1. **Your code leaves your infrastructure.** Delta mode sends merged diffs and
   full mode sends your entire tracked source to OpenAI and/or Moonshot, under
   whatever terms your account has with them. If any consuming repo contains
   code you cannot send to a third-party model, do not adopt this for that repo.
2. **This workflow receives real credentials.** It gets your API keys and a
   `GITHUB_TOKEN` scoped to the calling repo with `issues: write`. Pinning to a
   SHA is what bounds that trust; read the diff before moving a pin.
3. **A public hub does not make private-caller minutes free.** Reusable
   workflows bill against the **calling** repository. A private caller spends
   its own Actions minutes regardless of this repo's visibility.
4. **The checkpoint marker trusts anyone who can comment on the issue.** The
   cursor is parsed out of the trailer of issue comments authored by
   `github-actions[bot]`. Any workflow in your repo with `issues: write` posts
   under that same identity, so any such workflow could move the cursor and
   cause a range to be skipped. On a private repo that is the collaborator
   set. This is a deliberate trade: the alternative state stores were all worse,
   and a skipped range is loud in the next digest header.
5. **This repo is public, which is what makes adoption simple.** Any repo can
   call the workflow, and the job fetches the assets at a pinned SHA with no
   extra token. If you
   instead run your own **private** copy, note that two separate permissions are
   involved: being allowed to *call* a private reusable workflow (Settings,
   Actions, General, Access) is not the same as being able to *clone* that repo,
   which the version-coherency checkout also needs. See the next point.
6. **A private fork of this repo needs a token its callers do not have.**
   A caller's `GITHUB_TOKEN` is scoped to the caller, so it cannot clone a
   different private repo. If you run a private copy, give each caller a
   read-only fine-grained PAT as `CENTRAL_REPO_TOKEN`. The workflow probes for
   this and fails with the remediation spelled out rather than with a bare 404.
   Callers of this public repo need nothing extra.
7. **Scheduled workflows are disabled after 60 days of repository inactivity,**
   silently. The heartbeat makes a missing post readable as a broken cron, but
   nothing re-enables the schedule for you.
8. **This repo holds zero secrets, ever.** Every credential lives in the calling
   repo and arrives through an explicit `secrets:` mapping.
9. **Model output is posted into an issue.** Images are stripped and HTML
   comments are escaped before posting, because GitHub fetches images
   server-side through its camo proxy and in notification emails, which would
   let content in a reviewed repo induce the model into exfiltrating source via
   an image URL. Links are left intact: following one is a decision. Treat
   findings as untrusted text regardless, especially if you merge outside
   contributions into a reviewed repo.
10. **Unchecked findings carry forward verbatim** from the newest digest, so
    injected text can persist across digests until a human checks it off.

## Local development

No install step. Node 24, stdlib only.

```bash
node scripts/prompt-hash.mjs --check
DIGEST_CALLER_DIR=/path/to/some/repo \
DIGEST_DEFAULT_BRANCH=main \
DIGEST_POST=false \
DIGEST_STUB=/path/to/canned-response.md \
DIGEST_MODE=delta \
DIGEST_MODEL_LABEL='local' DIGEST_API_BASE='https://api.openai.com/v1' \
DIGEST_KEY_ENV=OPENAI_API_KEY DIGEST_MODEL=gpt-5.6-terra DIGEST_EFFORT=high \
node scripts/ai-weekly-digest.mjs
```

`DIGEST_POST=false` prints the digest instead of posting. `DIGEST_STUB` replaces
the model call with a canned response, so the git and state plumbing can be
tested offline for free. Drop `DIGEST_STUB` and set the real key env to make an
actual call.

## A note on what this does and does not replace

A scheduled digest is a mechanical net, not a review process. It reads what
already merged, so by definition it finds things after the fact. It pairs well
with a review step that happens before merge, and badly with being the only
thing you rely on.

It is also worth deciding deliberately whether the model reviewing your code is
from the same family as any model that helped write it. Two models from one
family reading the same diff tend to make correlated mistakes, so agreement
between them is weaker evidence than it feels like.
