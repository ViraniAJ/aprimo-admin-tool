// Bulk Versioning: match local files to existing records by file name so the
// local file can be added as a new version of the record's master file.

export interface VersionTarget {
  recordId: string
  title: string
  fileName: string
  fileId: string | null
  fileSize: number | null
  versionNumber: number | null
  modifiedOn: string | null
  thumbnailUrl: string | null
  /** Larger rendition for the hover preview, when Aprimo has one. */
  previewUrl: string | null
}

export interface Candidate {
  target: VersionTarget
  score: number
  reason: string
}

export function stripExtension(name: string): string {
  const i = name.lastIndexOf(".")
  return i > 0 ? name.slice(0, i) : name
}

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".")
  return i > 0 ? name.slice(i + 1).toLowerCase() : ""
}

/** Splits a stem into comparable tokens: lower-case, separators and letter/digit boundaries become spaces. Size tokens (10x10) stay whole. */
function tokens(stem: string): string[] {
  return stem
    .toLowerCase()
    .replace(/(\d+)x(\d+)/g, "$1×$2")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/[\s_\-.,+]+/g, " ")
    .replace(/\(\s*(\d+)\s*\)/g, " ($1) ")
    .replace(/×/g, "x")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

// Trailing revision markers on the space-joined name: v2, ver 3, rev1, final, draft, copy, (1), 2026-09-30…
const TRAILING_REVISION = /\s*(\(\d+\)|v\s*\d+[a-z]?|ver(sion)?\s*\d+|rev\s*\d+|r\s*\d+|final|draft|copy|new|old|latest|updated|edit(ed)?|\d{4}\s\d{2}\s\d{2}|\d{8})$/
// Tokens that never distinguish one asset from another: sizes, counters, "original"-type words.
const NEUTRAL = /^(\d{1,5}x\d{1,5}|\(\d+\)|og|orig|original|master|source|src|export|exported|out|output|hires|hi|res|rgb|srgb|cmyk|final|draft|copy|new|old|latest|updated|edit|edited|headshot|photo|photograph|image|img|pic|picture|shot|scan|file|asset)$/
// Tokens that name a particular rendition or crop; two files with different ones may be different records.
const VARIANT = /^(web|print|thumb|thumbnail|preview|crop|cropped|sq|square|wide|tall|portrait|landscape|small|medium|large|xs|s|m|l|xl|xxl|lores|lo|social|email|mobile|desktop)$/

/**
 * Normalises a file name for comparison: lower-case, no extension, separators
 * collapsed, and trailing revision markers removed (v2, _final, (1), copy…).
 */
export function normalizeName(name: string): string {
  let s = tokens(stripExtension(name)).join(" ")
  let prev = ""
  while (prev !== s && s.includes(" ")) {
    prev = s
    s = s.replace(TRAILING_REVISION, "").trim()
  }
  return s
}

/**
 * Stronger normalisation for "same asset, different rendition": drops neutral
 * tokens (sizes, counters, "original") and variant words anywhere, and reports
 * which variant words were removed so the caller can tell portrait from
 * landscape. Plain numbers are kept, so IMG_1234 and IMG_5678 stay distinct.
 */
export function baseName(name: string): { base: string; variants: string[] } {
  const variants: string[] = []
  const kept: string[] = []
  for (const t of tokens(normalizeName(name))) {
    if (NEUTRAL.test(t)) continue
    if (VARIANT.test(t)) {
      variants.push(t)
      continue
    }
    kept.push(t)
  }
  return { base: kept.join(" "), variants: variants.sort() }
}

/** Longest common leading token sequence of two base names. */
function sharedPrefix(a: string, b: string): string[] {
  const A = a.split(" ")
  const B = b.split(" ")
  const out: string[] = []
  for (let i = 0; i < Math.min(A.length, B.length) && A[i] === B[i]; i++) out.push(A[i])
  return out
}

function bigrams(s: string): Set<string> {
  const t = s.replace(/\s+/g, "")
  const out = new Set<string>()
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  return out
}

/** Sørensen–Dice similarity of two strings, 0..1. */
export function dice(a: string, b: string): number {
  const A = bigrams(a)
  const B = bigrams(b)
  if (!A.size || !B.size) return a === b ? 1 : 0
  let hits = 0
  for (const g of A) if (B.has(g)) hits++
  return (2 * hits) / (A.size + B.size)
}

/** Scores how likely a record's master file is the earlier version of a local file. 0..100. */
export function scoreMatch(localName: string, target: VersionTarget): { score: number; reason: string } {
  const remote = target.fileName || ""
  if (!remote) return { score: 0, reason: "no file" }
  if (remote.toLowerCase() === localName.toLowerCase()) return { score: 100, reason: "same file name" }
  const lStem = stripExtension(localName).toLowerCase()
  const rStem = stripExtension(remote).toLowerCase()
  const sameExt = extensionOf(localName) === extensionOf(remote)
  if (lStem === rStem) return { score: sameExt ? 96 : 90, reason: sameExt ? "same name" : "same name, different type" }
  const lNorm = normalizeName(localName)
  const rNorm = normalizeName(remote)
  if (lNorm && lNorm === rNorm) return { score: sameExt ? 88 : 80, reason: "same name ignoring revision markers" }
  const l = baseName(localName)
  const r = baseName(remote)
  if (l.base && l.base.length >= 3 && l.base === r.base) {
    const sameVariants = l.variants.join(",") === r.variants.join(",")
    if (sameVariants) return { score: sameExt ? 84 : 78, reason: "same name ignoring size and revision markers" }
    if (!l.variants.length || !r.variants.length) return { score: sameExt ? 80 : 74, reason: `same name, ${(l.variants.length ? l.variants : r.variants).join(" ")} variant` }
    return { score: 76, reason: `same name, ${l.variants.join(" ")} vs ${r.variants.join(" ")}` }
  }
  if (lNorm && rNorm && lNorm.length >= 4 && rNorm.length >= 4 && (lNorm.includes(rNorm) || rNorm.includes(lNorm))) {
    return { score: sameExt ? 70 : 62, reason: "one name contains the other" }
  }
  const shared = sharedPrefix(l.base, r.base)
  const sharedChars = shared.join("").length
  if (shared.length >= 2 && sharedChars >= 6 && sharedChars * 2 >= Math.min(l.base.replace(/ /g, "").length, r.base.replace(/ /g, "").length)) {
    return { score: sameExt ? 72 : 66, reason: `shared name "${shared.join(" ")}"` }
  }
  const d = dice(lNorm, rNorm)
  if (d >= 0.6) return { score: Math.round(30 + d * 40), reason: `${Math.round(d * 100)}% similar` }
  // Any shared word of four or more letters (not a number) is worth surfacing for review.
  const words = (b: string) => new Set(b.split(" ").filter((w) => w.length >= 4 && /[a-z]/.test(w)))
  const shared2 = [...words(l.base)].filter((w) => words(r.base).has(w))
  if (shared2.length) return { score: Math.min(60, 36 + (shared2.length - 1) * 12), reason: `shares "${shared2.join(" ")}"` }
  return { score: 0, reason: "" }
}

/** Ranked candidates for a local file; only meaningful scores are kept. */
export function candidatesFor(localName: string, targets: VersionTarget[], limit = 6): Candidate[] {
  const out: Candidate[] = []
  for (const target of targets) {
    const { score, reason } = scoreMatch(localName, target)
    if (score > 0) out.push({ target, score, reason })
  }
  return out.sort((a, b) => b.score - a.score || a.target.fileName.localeCompare(b.target.fileName)).slice(0, limit)
}

/** Above this score a match is selected automatically; below it the user must confirm. */
export const AUTO_MATCH_SCORE = 80

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "–"
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
