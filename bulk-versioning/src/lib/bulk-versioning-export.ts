"use client"

import { zip, type Zippable } from "fflate"

// Packs the local files that could not be matched to a record into one zip,
// with a manifest explaining each one, so they can be uploaded to the DAM by
// hand. Files are stored uncompressed: most are images or PDFs that would not
// shrink, and storing keeps the export fast for large folders.

export interface ExportEntry {
  file: File
  /** Path inside the dropped folder, or the bare name. */
  relativePath: string
  /** Why it is in the export. */
  reason: string
  /** Closest record the matcher found, if any. */
  nearest?: { fileName: string; title: string; score: number; recordId: string } | null
}

/** Zip timestamps only cover 1980 to 2099; files with odd or missing dates get "now". */
function zipDate(ms: number): Date {
  const d = new Date(ms)
  const y = d.getFullYear()
  return Number.isFinite(ms) && y >= 1980 && y <= 2099 ? d : new Date()
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function buildManifest(entries: ExportEntry[], context: { environment: string; classifications: string[]; exportedAt: Date }): string {
  const header = ["file", "path_in_zip", "size_bytes", "last_modified", "reason", "nearest_record_file", "nearest_record_title", "nearest_score", "nearest_record_id"]
  const rows = entries.map((e) => [
    e.file.name,
    e.relativePath,
    e.file.size,
    new Date(e.file.lastModified).toISOString(),
    e.reason,
    e.nearest?.fileName ?? "",
    e.nearest?.title ?? "",
    e.nearest ? `${e.nearest.score}%` : "",
    e.nearest?.recordId ?? "",
  ])
  const meta = [
    `# Unmatched files from Bulk Versioning`,
    `# environment: ${context.environment}`,
    `# classifications searched: ${context.classifications.length}`,
    `# exported: ${context.exportedAt.toISOString()}`,
    `# files: ${entries.length}`,
  ]
  return [...meta, header.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\r\n") + "\r\n"
}

/** Zips the entries (folder paths preserved) plus unmatched.csv, and reports progress as bytes read. */
export async function buildUnmatchedZip(
  entries: ExportEntry[],
  context: { environment: string; classifications: string[] },
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  const total = entries.reduce((a, e) => a + e.file.size, 0)
  let done = 0
  const files: Zippable = {}
  const used = new Set<string>()
  for (const e of entries) {
    // Keep folder structure; make sure two loose files with one name cannot collide.
    let path = e.relativePath.replace(/^\/+/, "")
    if (used.has(path)) {
      const i = path.lastIndexOf(".")
      path = i > 0 ? `${path.slice(0, i)} (${used.size})${path.slice(i)}` : `${path} (${used.size})`
    }
    used.add(path)
    const data = new Uint8Array(await e.file.arrayBuffer())
    files[path] = [data, { level: 0, mtime: zipDate(e.file.lastModified) }]
    done += e.file.size
    onProgress?.(done, total)
  }
  files["unmatched.csv"] = [new TextEncoder().encode(buildManifest(entries, { ...context, exportedAt: new Date() })), { level: 6 }]
  const bytes = await new Promise<Uint8Array>((resolve, reject) => zip(files, (err, out) => (err ? reject(err) : resolve(out))))
  return new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: "application/zip" })
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function exportFileName(environment: string): string {
  const d = new Date()
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`
  return `unmatched-${environment}-${stamp}.zip`
}
