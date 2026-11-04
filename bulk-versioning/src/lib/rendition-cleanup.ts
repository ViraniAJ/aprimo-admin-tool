"use client"

import { Expander } from "aprimo-js"
import type { Record as AprimoSDKRecord, FileVersion, Collection } from "aprimo-js/model"
import type { createClient } from "aprimo-js"

// Rendition Cleanup: list the additional files (renditions, crops, trims…) on
// the master file's latest version of every record in a collection, and
// remove the chosen ones with one record update per record.

type AprimoClient = ReturnType<typeof createClient>

export interface CollectionInfo {
  id: string
  name: string
  type: "Static" | "Dynamic"
  description: string
}

export interface ExtraFile {
  id: string
  recordId: string
  recordTitle: string
  masterFileName: string
  fileId: string
  versionId: string
  thumbnailUrl: string | null
  label: string
  fileName: string
  extension: string
  fileSize: number
  type: string
  purposes: string[]
  isManual: boolean
  tag: string
  /** Public links pointing at this additional file; deleting it would break them. */
  publicLinks: number
}

export interface RecordScan {
  recordId: string
  title: string
  masterFileName: string
  fileId: string | null
  versionId: string | null
  thumbnailUrl: string | null
  files: ExtraFile[]
  error?: string
}

export async function listCollections(client: AprimoClient): Promise<CollectionInfo[]> {
  const out: CollectionInfo[] = []
  for await (const page of client.collections.getPaged({ pageSize: 500 })) {
    if (!page.ok) throw new Error(page.error?.message ?? "Could not list collections")
    for (const c of (page.data?.items ?? []) as unknown as Array<{ id: string; name: string; type: "Static" | "Dynamic"; description?: string }>) {
      out.push({ id: c.id, name: c.name, type: c.type, description: c.description ?? "" })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Record ids in a collection: the embedded list for static ones, the saved search for dynamic ones. */
export async function collectionRecordIds(client: AprimoClient, collectionId: string, limit = 5000): Promise<{ ids: string[]; capped: boolean }> {
  const expander = Expander.create().for<Collection>("Collection").expand("records")
  const r = await client.collections.getById(collectionId, expander)
  if (!r.ok) throw new Error(r.error?.message ?? "Could not read the collection")
  const col = r.data as unknown as { type?: string; searchExpression?: unknown; _embedded?: { records?: { items?: Array<{ id: string }> } } }
  const embedded = col._embedded?.records?.items ?? []
  const uniq = (xs: string[]) => Array.from(new Set(xs))
  if (embedded.length) {
    const ids = uniq(embedded.map((x) => x.id))
    return { ids: ids.slice(0, limit), capped: ids.length > limit }
  }
  if (col.type === "Dynamic" && col.searchExpression) {
    const ids: string[] = []
    for (let page = 1; ids.length < limit; page++) {
      const s = await client.search.records({ searchExpression: col.searchExpression as never, page, pageSize: 200 })
      if (!s.ok) throw new Error(s.error?.message ?? "Collection search failed")
      const items = ((s.data as unknown as { items?: Array<{ id: string }> })?.items ?? [])
      ids.push(...items.map((x) => x.id))
      if (items.length < 200) break
    }
    // Search pages are not guaranteed stable between calls; drop any id seen twice.
    const u = uniq(ids)
    return { ids: u.slice(0, limit), capped: u.length > limit }
  }
  return { ids: [], capped: false }
}

interface RawAdditional {
  id: string
  label?: string
  fileName?: string
  extension?: string
  fileSize?: number
  type?: string
  purposes?: string[]
  isManual?: boolean
  tag?: string
}
interface RawRecord {
  id: string
  title?: string | null
  _embedded?: {
    masterfile?: { id?: string }
    masterfilelatestversion?: {
      id?: string
      fileName?: string
      _embedded?: {
        thumbnail?: { uri?: string }
        additionalfiles?: { items?: RawAdditional[] }
        publiclinks?: { items?: Array<{ additionalFileId?: string | null }> }
      }
    }
  }
}

export class ScanError extends Error {
  constructor(message: string, public status: number) {
    super(message)
  }
}

/** Rate limits and transient server errors are worth retrying; 403/404 are not. */
export function isRetryable(e: unknown): boolean {
  const status = e instanceof ScanError ? e.status : 0
  const msg = e instanceof Error ? e.message : String(e)
  return status === 429 || status === 0 || status >= 500 || /429|rate|too many|timeout|network|fetch/i.test(msg)
}

/** One record's master version with its additional files and which of them carry public links. */
export async function scanRecord(client: AprimoClient, recordId: string): Promise<RecordScan> {
  const expander = Expander.create()
    .for<AprimoSDKRecord>("Record").expand("masterfile", "masterfilelatestversion")
    .for<FileVersion>("FileVersion").expand("additionalfiles", "publiclinks", "thumbnail")
  const r = await client.records.getById(recordId, expander)
  if (!r.ok) throw new ScanError(r.error?.message ?? "Could not read record", r.status)
  const rec = r.data as unknown as RawRecord
  const v = rec._embedded?.masterfilelatestversion
  const fileId = rec._embedded?.masterfile?.id ?? null
  const versionId = v?.id ?? null
  const linkCounts = new Map<string, number>()
  for (const pl of v?._embedded?.publiclinks?.items ?? []) if (pl.additionalFileId) linkCounts.set(pl.additionalFileId, (linkCounts.get(pl.additionalFileId) ?? 0) + 1)
  const base = { recordId, title: rec.title ?? "", masterFileName: v?.fileName ?? "", fileId, versionId, thumbnailUrl: v?._embedded?.thumbnail?.uri ?? null }
  const files: ExtraFile[] = (v?._embedded?.additionalfiles?.items ?? []).map((a) => ({
    id: a.id,
    recordId,
    recordTitle: base.title || base.masterFileName,
    masterFileName: base.masterFileName,
    fileId: fileId ?? "",
    versionId: versionId ?? "",
    thumbnailUrl: base.thumbnailUrl,
    label: a.label ?? "",
    fileName: a.fileName ?? "",
    extension: (a.extension ?? "").toLowerCase(),
    fileSize: a.fileSize ?? 0,
    type: a.type ?? "AdditionalFile",
    purposes: a.purposes ?? [],
    isManual: !!a.isManual,
    tag: a.tag ?? "",
    publicLinks: linkCounts.get(a.id) ?? 0,
  }))
  return { ...base, files }
}

/**
 * Runs tasks with a concurrency cap. Retryable failures (rate limits, 5xx,
 * network) back off and retry up to `retries` times, with every worker
 * pausing together after a 429 so the burst subsides. A task that still
 * fails is passed to `onError`, whose return value stands in for the result,
 * so one bad record never aborts the whole run.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onEach?: (done: number) => void,
  onError?: (item: T, error: unknown) => R,
  retries = 6,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  let done = 0
  let pauseUntil = 0
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  async function worker() {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      let attempt = 0
      for (;;) {
        const wait = pauseUntil - Date.now()
        if (wait > 0) await sleep(wait)
        try {
          out[i] = await fn(items[i], i)
          break
        } catch (e) {
          if (attempt < retries && isRetryable(e)) {
            attempt++
            const backoff = Math.min(15_000, 1000 * 2 ** (attempt - 1)) + Math.random() * 400
            if (e instanceof ScanError && e.status === 429) pauseUntil = Math.max(pauseUntil, Date.now() + backoff)
            await sleep(backoff)
            continue
          }
          if (!onError) throw e
          out[i] = onError(items[i], e)
          break
        }
      }
      done++
      onEach?.(done)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export function failedScan(recordId: string, e: unknown): RecordScan {
  return { recordId, title: "", masterFileName: "", fileId: null, versionId: null, thumbnailUrl: null, files: [], error: e instanceof Error ? e.message : String(e) }
}

/** Removes the given additional files from one record's master file version in a single update. */
export async function removeAdditionalFiles(client: AprimoClient, recordId: string, fileId: string, versionId: string, additionalFileIds: string[]): Promise<void> {
  const r = await client.records.update(recordId, {
    files: { addOrUpdate: [{ id: fileId, versions: { addOrUpdate: [{ id: versionId, additionalFiles: { remove: additionalFileIds.map((id) => ({ id })) } }] } }] },
  })
  if (!r.ok) throw new Error(r.error?.message ?? "Record update failed")
}

export function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function filesToCsv(files: ExtraFile[], environment: string, collectionName: string, outcome?: Map<string, string>): string {
  const header = ["record_id", "record_title", "master_file", "additional_file_id", "label", "file_name", "extension", "size_bytes", "type", "purposes", "manual", "tag", "public_links", ...(outcome ? ["outcome"] : [])]
  const rows = files.map((f) => [f.recordId, f.recordTitle, f.masterFileName, f.id, f.label, f.fileName, f.extension, f.fileSize, f.type, f.purposes.join("|"), f.isManual ? "yes" : "no", f.tag, f.publicLinks, ...(outcome ? [outcome.get(f.id) ?? ""] : [])])
  return [`# Rendition Cleanup · ${environment} · collection: ${collectionName} · ${new Date().toISOString()}`, header.join(","), ...rows.map((r) => r.map(csvEscape).join(","))].join("\r\n") + "\r\n"
}

export function downloadText(text: string, filename: string, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
