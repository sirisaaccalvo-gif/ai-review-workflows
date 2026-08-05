// scripts/digest-sanitize.mjs
// Neutralize model output before it is posted into a GitHub issue.
//
// This lives in its own module so CI can import and test THE REAL CODE. It used
// to sit inline in the digest script, where nothing could reach it, and a
// regression that reopened a confirmed exfiltration path landed silently as a
// result. A security control with no test is a comment.
//
// THE THREAT. The digest sends repository content to a model and posts what
// comes back verbatim into an issue, so anything that can land text in a
// reviewed repo can influence that text. GitHub fetches images server-side
// through its camo proxy, with no click, and again when the issue goes out as a
// notification email. A model induced to emit an image URL with reviewed source
// encoded in the query string exfiltrates that source to whoever owns the host.
//
// Verified against GitHub's own renderer, every one of these became a
// camo.githubusercontent.com fetch before it was handled here:
//   ![a](url)                     inline
//   ![a][ref] + [ref]: url        full reference
//   ![ref]                        collapsed reference
//   <img src=...>                 HTML, including split across lines
//   <picture><source srcset=...>  responsive images
//
// Node stdlib only. No dependencies, same rule as the rest of scripts/.

/** Fence opener: at most 3 leading spaces, matching GFM. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/

/**
 * Strip everything GitHub fetches or renders on its own initiative.
 *
 * Operates on a whole BLOCK, never line by line: an HTML tag can span lines,
 * and `[^>]` matches a newline, so a per-line pass silently missed
 * `<img\n  src="...">`. That exact regression is what motivated the module.
 *
 * Link reference definitions (`[r]: https://...`) are deliberately left alone.
 * With every image construct gone they define an ordinary link, and following a
 * link is a human decision rather than an automatic fetch.
 */
export function scrubBlock(s) {
  return String(s)
    .replace(/!\[([^\]]*)\]\s*\([^)]*\)/g, '`[image omitted: $1]`')
    .replace(/!\[([^\]]*)\]\s*\[[^\]]*\]/g, '`[image omitted: $1]`')
    .replace(/!\[([^\]]*)\]/g, '`[image omitted: $1]`')
    .replace(/<\/?(?:img|picture|source|image|embed|object|iframe|svg|use)\b[^>]*>/gi, '`[image omitted]`')
    .replace(/<!--/g, '&lt;!--')
}

/**
 * Scrub the unfenced parts of model output, leaving fenced code untouched.
 *
 * Fenced code is left alone because nothing in it is fetched or parsed, and
 * scrubbing it corrupted real findings: a finding quoting `<!--[if lt IE 9]>`
 * rendered as literal &lt;!--, and a finding about a broken badge had its own
 * example image replaced.
 *
 * The fence opener allows at most 3 leading spaces. Accepting any indent meant a
 * 4-space-indented fence looked like a fence here while GitHub treated it as an
 * indented code block, so scrubbing stopped while rendering carried on and every
 * following image went live.
 */
export function neutralize(text) {
  const out = []
  let buf = []
  let fence = null
  const flush = () => { if (buf.length) { out.push(scrubBlock(buf.join('\n'))); buf = [] } }
  for (const line of String(text ?? '').split('\n')) {
    const m = FENCE_RE.exec(line)
    if (m) {
      if (fence === null) { flush(); fence = m[1][0] } else if (m[1][0] === fence) fence = null
      out.push(line)
      continue
    }
    if (fence === null) buf.push(line)
    else out.push(line)
  }
  flush()
  // Close a fence the model left open. Everything this script appends after the
  // model's output (carried findings, the cost footer, the state trailer) would
  // otherwise be swallowed into that code block and render as code. The cursor
  // parser reads raw text so state still resolves, but the digest becomes
  // unreadable and the footer misleading. Balancing is also what lets the
  // caller reason about the output at all: after this, any construct still
  // inside a fence is genuinely inert.
  if (fence !== null) out.push(fence.repeat(3))
  return out.join('\n')
}
