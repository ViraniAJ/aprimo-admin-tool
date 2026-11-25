"use client"

import type { createClient } from "aprimo-js"

// Metadata Export: pages through records and turns each into one CSV row of record properties and field values.
//
// The approach follows Aprimo's DAM Metadata Extract Utility (github.com/Aprimo-Connect/dam-metadata-extract-utility,
// BSD-3-Clause), rewritten for this app:
//   - Large sets are read by keyset paging: sort by CreatedOn and ask for "CreatedOn >= last seen" each time, skipping the
//     records already written at that instant. Page numbers stop working deep into a search; this does not.
//   - Pages of up to 1,000 records, asking only for the chosen fields (select-record-fields), which keeps responses small.
//   - Requests are paced, and 429 / 5xx / network failures back off and retry, honouring Retry-After.
//   - CSV per RFC 4180 with a BOM, CRLF, and values that would run as spreadsheet formulas prefixed with an apostrophe.

type AprimoClient = ReturnType<typeof createClient>

export const NEUTRAL_LANGUAGE = "00000000000000000000000000000000"
export const MAX_PAGE = 1000
const ID_BATCH = 100
const EPOCH = "1900-01-01T00:00:00.000Z"

// ── Definitions ─────────────────────────────────────────────────────────────

export interface Label { value: string; languageId: string }
export interface OptionItem { id: string; name: string; label: string; labels: Label[] }
export interface FieldDef {
  id: string
  name: string
  label: string
  labels: Label[]
  dataType: string
  items?: Map<string, OptionItem>
}
export interface LanguageInfo { id: string; name: string; culture: string }

const nid = (id: unknown) => String(id ?? "").replace(/[-{}]/g, "").toLowerCase()

export async function loadFieldDefs(client: AprimoClient): Promise<FieldDef[]> {
  const out: FieldDef[] = []
  for await (const page of client.fieldDefinitions.getPaged({ pageSize: 500 })) {
    if (!page.ok) throw new Error(page.error?.message ?? "Could not read field definitions")
    for (const raw of (page.data?.items ?? []) as unknown as Array<Record<string, unknown>>) {
      const items = Array.isArray(raw.items)
        ? new Map((raw.items as OptionItem[]).map((i) => [nid(i.id), { id: nid(i.id), name: i.name, label: i.label, labels: i.labels ?? [] }]))
        : undefined
      out.push({ id: nid(raw.id), name: String(raw.name ?? ""), label: String(raw.label ?? raw.name ?? ""), labels: (raw.labels as Label[]) ?? [], dataType: String(raw.dataType ?? ""), items })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export async function loadLanguages(client: AprimoClient): Promise<LanguageInfo[]> {
  const out: LanguageInfo[] = []
  for await (const page of client.languages.getPaged()) {
    if (!page.ok) break
    for (const l of (page.data?.items ?? []) as unknown as Array<{ id: string; name: string; culture: string; isEnabledForFields: boolean }>) {
      if (l.isEnabledForFields) out.push({ id: nid(l.id), name: l.name, culture: l.culture })
    }
  }
  return out
}

// ── HTTP ────────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message) }
}

export interface Api {
  environment: string
  token: () => Promise<string>
  /** Requests per second; 0 = unpaced. */
  rate: number
}

let nextSlot = 0
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Stopped", "AbortError"))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Stopped", "AbortError")) }, { once: true })
  })

/** One API call with pacing and retries. Stops on abort without retrying. */
export async function apiCall(api: Api, method: "GET" | "POST", path: string, opts: { query?: Record<string, string | number>; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<any> {
  const url = new URL(`https://${api.environment}.dam.aprimo.com/api/core/${path}`)
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v))
  let lastErr: unknown
  for (let attempt = 0; attempt < 7; attempt++) {
    if (api.rate > 0) {
      const now = Date.now()
      const at = Math.max(now, nextSlot)
      nextSlot = at + 1000 / api.rate
      if (at > now) await sleep(at - now, opts.signal)
    }
    let res: Response
    try {
      res = await fetch(url, {
        method,
        signal: opts.signal,
        headers: {
          Authorization: `Bearer ${await api.token()}`,
          "API-VERSION": "1",
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...opts.headers,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      })
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e
      lastErr = e
      await sleep(backoff(attempt), opts.signal)
      continue
    }
    if (res.ok) return res.status === 204 ? null : res.json()
    const text = await res.text().catch(() => "")
    const msg = errorMessage(text) || `${res.status} ${res.statusText}`
    // A server exception (a JSON body naming one) is usually the same every time: retry it once, not for minutes.
    const serverException = res.status === 500 && /"exceptionType"/.test(text)
    if (serverException && attempt >= 1) throw new ApiError(msg, res.status)
    if (res.status === 429 || res.status >= 500 || res.status === 401) {
      lastErr = new ApiError(msg, res.status)
      const ra = Number(res.headers.get("Retry-After"))
      await sleep(ra > 0 ? Math.min(ra * 1000, 120_000) : backoff(attempt), opts.signal)
      continue
    }
    throw new ApiError(msg, res.status)
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

const backoff = (attempt: number) => Math.min(60_000, 1000 * 2 ** attempt) + Math.random() * 500

function errorMessage(text: string): string {
  try {
    const j = JSON.parse(text)
    return j?.exceptionMessage ?? j?.message ?? j?.Message ?? j?.error?.message ?? j?.title ?? text.slice(0, 300)
  } catch {
    return text.slice(0, 300)
  }
}

// ── Records ─────────────────────────────────────────────────────────────────

export interface RawField { id?: string; fieldName?: string; dataType?: string; localizedValues?: Array<{ value?: unknown; values?: unknown[]; languageId?: string }> }
export interface RawRecord {
  id: string
  title?: string
  status?: string
  contentType?: string
  createdOn?: string
  modifiedOn?: string
  fields?: { items?: RawField[] } | RawField[] | null
  masterFileLatestVersion?: { fileName?: string; fileExtension?: string; fileSize?: number } | null
  _embedded?: { fields?: { items?: RawField[] }; masterfilelatestversion?: { fileName?: string; fileExtension?: string; fileSize?: number } }
}

export type Source =
  | { kind: "all" }
  | { kind: "expression"; expression: string; parameters?: unknown; namedParameters?: unknown }
  | { kind: "ids"; ids: string[] }

/** Where a run has got to: enough to carry on after a stop, a crash or a restart. */
export type Cursor =
  | { kind: "keyset"; watermark: string | null; seen: string[] }
  | { kind: "ids"; next: number }

export interface ReadOptions {
  /** Field names for select-record-fields; empty = all fields. */
  fieldNames: string[]
  /** Every field name, so a field Aprimo fails on can be left out even when "all fields" was chosen. */
  allFieldNames?: string[]
  /** Fields to leave out because Aprimo errors when returning them. */
  excluded?: string[]
  /** Ask for record properties only (id, dates, title…), no fields: used to learn which records a failing page holds. */
  skeleton?: boolean
  masterFile: boolean
  pageSize: number
}

export interface Page { records: RawRecord[]; cursor: Cursor; total: number | null; missing: string[]; done: boolean }

/** A page read as completely as Aprimo allows: fields it fails on are left out, records it fails on are listed. */
export interface SafePage extends Page {
  excluded: string[]
  /** Aprimo's message for each field excluded on this page. */
  excludedWhy: Record<string, string>
  failed: Array<{ id: string; error: string }>
}

export const startCursor = (source: Source): Cursor => (source.kind === "ids" ? { kind: "ids", next: 0 } : { kind: "keyset", watermark: null, seen: [] })

function selectHeaders(opts: ReadOptions): Record<string, string> {
  if (opts.skeleton) return {}
  const excluded = new Set((opts.excluded ?? []).map((f) => f.toLowerCase()))
  const names = excluded.size
    ? (opts.fieldNames.length ? opts.fieldNames : opts.allFieldNames ?? []).filter((f) => !excluded.has(f.toLowerCase()))
    : opts.fieldNames
  return {
    "select-record": opts.masterFile ? "fields,masterfilelatestversion" : "fields",
    ...(names.length ? { "select-record-fields": names.join(",") } : {}),
    languages: "*",
  }
}

/** The field named in an Aprimo error such as "The default value calculation for field X didn't return a valid field value". */
export function fieldInError(e: unknown): string | null {
  const msg = e instanceof Error ? e.message : String(e)
  const m = msg.match(/\bfield\s+['"]?([A-Za-z0-9_.\-]+)['"]?\s+(?:didn't|did not|could not|couldn't|failed|is|has)/i) ?? msg.match(/\bfor field\s+['"]?([A-Za-z0-9_.\-]+)/i)
  return m ? m[1] : null
}

/**
 * readPage that gets past records and fields Aprimo cannot return.
 *  1. If the error names a field, read the page again without it (up to 8 fields per run).
 *  2. If the page still fails, read it without fields to learn its records, then fetch those in groups of 100,
 *     halving any group that fails until the record that breaks it is found. That record is reported, not fatal.
 * The cursor is the same as the plain read, so paging carries on normally.
 */
export async function readPageSafe(api: Api, source: Source, cursor: Cursor, opts: ReadOptions, signal?: AbortSignal): Promise<SafePage> {
  const excluded = [...(opts.excluded ?? [])]
  const excludedWhy: Record<string, string> = {}
  let lastErr: unknown
  for (let i = 0; i < 9; i++) {
    try {
      const p = await readPage(api, source, cursor, { ...opts, excluded }, signal)
      return { ...p, excluded, excludedWhy, failed: [] }
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e
      lastErr = e
      const f = fieldInError(e)
      if (f && excluded.length < 8 && !excluded.some((x) => x.toLowerCase() === f.toLowerCase())) { excluded.push(f); excludedWhy[f] = e instanceof Error ? e.message : String(e); continue }
      break
    }
  }
  let skel: Page
  try {
    skel = await readPage(api, source, cursor, { ...opts, excluded, skeleton: true }, signal)
  } catch {
    throw lastErr
  }
  const detailed = new Map<string, RawRecord>()
  const failed: Array<{ id: string; error: string }> = []
  const ids = skel.records.map((r) => nid(r.id))
  const fetchIds = async (batch: string[]): Promise<void> => {
    try {
      const expression = batch.map((id) => `Id = '${id}'`).join(" OR ")
      const res = await apiCall(api, "POST", "search/records", { query: { skip: 0, take: batch.length }, body: { searchExpression: { expression } }, headers: selectHeaders({ ...opts, excluded }), signal })
      for (const r of (res?.items ?? []) as RawRecord[]) detailed.set(nid(r.id), r)
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e
      if (batch.length === 1) { failed.push({ id: batch[0], error: e instanceof Error ? e.message : String(e) }); return }
      const half = Math.ceil(batch.length / 2)
      await fetchIds(batch.slice(0, half))
      await fetchIds(batch.slice(half))
    }
  }
  for (let i = 0; i < ids.length; i += 100) {
    await fetchIds(ids.slice(i, i + 100))
    // Every record failing means the problem is not a few bad records; stop rather than read them one by one.
    if (failed.length >= 25 && detailed.size === 0) throw lastErr
  }
  return { ...skel, records: skel.records.map((r) => detailed.get(nid(r.id)) ?? r), excluded, excludedWhy, failed }
}

const and = (left: string, right: string) => (left.trim() ? `(${left}) AND ${right}` : right)
const toMs = (s: string | undefined) => {
  const d = new Date(s ?? "")
  return isNaN(d.getTime()) ? null : d.toISOString()
}

/** Reads the next page from the cursor. Pure apart from the API call, so a page can be retried with the same cursor. */
export async function readPage(api: Api, source: Source, cursor: Cursor, opts: ReadOptions, signal?: AbortSignal): Promise<Page> {
  if (source.kind === "ids" && cursor.kind === "ids") {
    const batch = source.ids.slice(cursor.next, cursor.next + ID_BATCH)
    if (!batch.length) return { records: [], cursor, total: source.ids.length, missing: [], done: true }
    const expression = batch.map((id) => `Id = '${id}'`).join(" OR ")
    const res = await apiCall(api, "POST", "search/records", { query: { skip: 0, take: batch.length }, body: { searchExpression: { expression } }, headers: selectHeaders(opts), signal })
    const records = (res?.items ?? []) as RawRecord[]
    const got = new Set(records.map((r) => nid(r.id)))
    const next = cursor.next + batch.length
    return { records, cursor: { kind: "ids", next }, total: source.ids.length, missing: batch.filter((id) => !got.has(nid(id))), done: next >= source.ids.length }
  }
  if (cursor.kind !== "keyset") throw new Error("Cursor does not match the source")
  const base = source.kind === "expression" ? source.expression : ""
  const expression = and(base, `CreatedOn >= ${cursor.watermark ?? EPOCH}`)
  const searchExpression: Record<string, unknown> = { expression }
  if (source.kind === "expression") {
    if (source.parameters) searchExpression.parameters = source.parameters
    if (source.namedParameters) searchExpression.namedParameters = source.namedParameters
  }
  const take = Math.min(MAX_PAGE, Math.max(1, opts.pageSize))
  const res = await apiCall(api, "POST", "search/records", { query: { skip: 0, take, sort: "CreatedOn" }, body: { searchExpression }, headers: selectHeaders(opts), signal })
  const items = (res?.items ?? []) as RawRecord[]
  const total = typeof res?.totalCount === "number" ? res.totalCount : null
  if (!items.length) return { records: [], cursor, total, missing: [], done: true }
  const seen = new Set(cursor.seen)
  const fresh = items.filter((r) => !seen.has(nid(r.id)))
  const last = toMs(items[items.length - 1].createdOn)
  if (!last) throw new Error("Records came back without CreatedOn, which paging needs.")
  if (!fresh.length) {
    if (items.length < take) return { records: [], cursor, total, missing: [], done: true }
    throw new Error(`More than ${take} records were created at ${last}, so paging cannot move past it. Raise the page size and resume.`)
  }
  // Records at the new watermark come back next time (>=); remember them so they are not written twice.
  const atLast = items.filter((r) => toMs(r.createdOn) === last).map((r) => nid(r.id))
  const nextSeen = last === cursor.watermark ? Array.from(new Set([...cursor.seen, ...atLast])) : atLast
  return { records: fresh, cursor: { kind: "keyset", watermark: last, seen: nextSeen }, total, missing: [], done: items.length < take }
}

/** A dynamic collection's saved search, or a static collection's record ids. */
export async function resolveCollection(api: Api, collectionId: string, signal?: AbortSignal, onProgress?: (n: number) => void): Promise<Source> {
  const col = await apiCall(api, "GET", `collection/${collectionId}`, { signal })
  const se = col?.searchExpression
  if (col?.type === "Dynamic" && se) {
    const expression = typeof se === "string" ? se : se.expression
    if (expression) return { kind: "expression", expression, parameters: se.parameters, namedParameters: se.namedParameters }
  }
  // This endpoint is not paged (Aprimo's OpenAPI: "a non-paged collection of records"): one call returns the whole
  // collection, and page/pageSize are ignored. Paging it re-read the same records forever (a 4,205-record collection
  // counted up to 382,655), so read it once and drop any repeated ids.
  const res = await apiCall(api, "GET", `collection/${collectionId}/records`, { signal })
  const seen = new Set<string>()
  for (const r of (res?.items ?? []) as Array<{ id: string }>) if (r?.id) seen.add(nid(r.id))
  onProgress?.(seen.size)
  return { kind: "ids", ids: Array.from(seen) }
}

// ── Rows ────────────────────────────────────────────────────────────────────

export interface RowOptions {
  fields: FieldDef[]
  masterFile: boolean
  /** A language id, or "*" for every language in one cell. */
  language: string
  languages: LanguageInfo[]
  /** Write option and classification names (true) or their ids (false). */
  names: boolean
  multiSeparator: string
}

export const BASE_COLUMNS = ["record_id", "title", "status", "content_type", "created_on", "modified_on"]
export const FILE_COLUMNS = ["master_file_name", "master_file_extension", "master_file_size"]

export function header(o: RowOptions): string[] {
  return [...BASE_COLUMNS, ...(o.masterFile ? FILE_COLUMNS : []), ...o.fields.map((f) => f.name)]
}

/** Classification ids referenced by a page, so their names can be looked up before the rows are written. */
export function classificationIds(records: RawRecord[], o: RowOptions): string[] {
  const want = new Set(o.fields.filter((f) => f.dataType === "ClassificationList").map((f) => f.name.toLowerCase()))
  if (!want.size || !o.names) return []
  const out = new Set<string>()
  for (const r of records) for (const f of fieldsOf(r)) {
    if (!want.has(String(f.fieldName ?? "").toLowerCase())) continue
    for (const lv of f.localizedValues ?? []) for (const v of valuesOf(lv)) out.add(nid(v))
  }
  return Array.from(out)
}

function fieldsOf(r: RawRecord): RawField[] {
  const f = r.fields ?? r._embedded?.fields
  if (Array.isArray(f)) return f
  return f?.items ?? []
}

function valuesOf(lv: { value?: unknown; values?: unknown[] }): string[] {
  const text = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v))
  if (Array.isArray(lv.values) && lv.values.length) return lv.values.map(text).filter(Boolean)
  if (Array.isArray(lv.value)) return lv.value.map(text).filter(Boolean)
  const t = text(lv.value)
  return t ? [t] : []
}

const labelFor = (labels: Label[] | undefined, lang: string, fallback: string) =>
  (lang !== "*" && labels?.find((l) => nid(l.languageId) === lang)?.value) || fallback

export function toRow(r: RawRecord, o: RowOptions, classNames: Map<string, string>): string[] {
  const byName = new Map(fieldsOf(r).map((f) => [String(f.fieldName ?? "").toLowerCase(), f]))
  const mf = r.masterFileLatestVersion ?? r._embedded?.masterfilelatestversion
  const culture = new Map(o.languages.map((l) => [l.id, l.culture]))
  const cells = [nid(r.id), r.title ?? "", r.status ?? "", r.contentType ?? "", r.createdOn ?? "", r.modifiedOn ?? ""]
  if (o.masterFile) cells.push(mf?.fileName ?? "", mf?.fileExtension ?? "", mf?.fileSize != null ? String(mf.fileSize) : "")
  for (const def of o.fields) {
    const f = byName.get(def.name.toLowerCase())
    // Group values by language. A list field can arrive as one entry with `values`, or as several entries with one
    // `value` each under the same language; either way every value is kept, in order.
    const byLang = new Map<string, string[]>()
    for (const lv of f?.localizedValues ?? []) {
      const vals = valuesOf(lv)
      if (!vals.length) continue
      const id = nid(lv.languageId) || NEUTRAL_LANGUAGE
      byLang.set(id, [...(byLang.get(id) ?? []), ...vals])
    }
    const render = (vals: string[], lang: string) =>
      vals.map((v) => {
        if (!o.names) return v
        if (def.items) { const it = def.items.get(nid(v)); return it ? labelFor(it.labels, lang, it.label || it.name) : v }
        if (def.dataType === "ClassificationList") return classNames.get(nid(v)) ?? v
        return v
      }).join(o.multiSeparator)
    let cell = ""
    if (o.language === "*") {
      const groups = Array.from(byLang.entries())
      cell = groups.length <= 1
        ? (groups[0] ? render(groups[0][1], groups[0][0]) : "")
        : groups.map(([id, vals]) => `[${id === NEUTRAL_LANGUAGE ? "neutral" : culture.get(id) ?? id}] ${render(vals, id)}`).join(" || ")
    } else {
      const vals = byLang.get(o.language) ?? byLang.get(NEUTRAL_LANGUAGE)
      cell = vals ? render(vals, o.language) : ""
    }
    cells.push(cell)
  }
  return cells
}

/** Fields that were asked for but missing from every record on the page: a sign the API is not returning them. */
export function missingFields(records: RawRecord[], o: RowOptions): string[] {
  if (!records.length) return []
  const present = new Set<string>()
  for (const r of records) for (const f of fieldsOf(r)) present.add(String(f.fieldName ?? "").toLowerCase())
  return present.size ? [] : o.fields.map((f) => f.name)
}

// ── CSV ─────────────────────────────────────────────────────────────────────

export function csvCell(v: string, sanitize = true): string {
  let s = v
  // A cell starting with = + - @ runs as a formula in Excel; keep plain negative numbers as they are.
  if (sanitize && /^[=+\-@\t\r]/.test(s) && !/^-\d+(\.\d+)?$/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const csvLine = (cells: string[]) => cells.map((c) => csvCell(c)).join(",") + "\r\n"
