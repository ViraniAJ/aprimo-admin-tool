// Record ids from a spreadsheet or pasted text, for tools that otherwise start from a collection.
// Accepts .csv / .tsv / .txt and .xlsx. Finds the id column by its header (Record ID, record_id, Id…);
// without a recognisable header it uses the column holding the most GUIDs. Ids may be written with or
// without hyphens (the DAM UI shows them without) and come back hyphenated and lower-case.

export interface IdImport {
  /** Unique record ids in file order. */
  ids: string[]
  /** Where they came from, e.g. `column "Record ID" on sheet "Sheet1"`. */
  source: string
  duplicates: number
  /** Non-blank cells in the id column that are not record ids (first few kept for display). */
  invalid: string[]
  invalidCount: number
}

const GUID = /^\{?([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})\}?$/i
const GUID_ANYWHERE = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi
const HEADER_PRIORITY = ["recordid", "contentitemid", "itemid", "assetid", "id"]
const MAX_INVALID_SHOWN = 20

export function normalizeId(raw: unknown): string | null {
  const m = String(raw ?? "").trim().match(GUID)
  return m ? `${m[1]}-${m[2]}-${m[3]}-${m[4]}-${m[5]}`.toLowerCase() : null
}

const headerKey = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "")

/** Picks the id column from rows of cells and collects the ids under it. */
export function idsFromRows(rows: string[][], where = ""): IdImport {
  const data = rows.filter((r) => r.some((c) => c.trim()) && !r[0]?.trim().startsWith("#"))
  let col = -1
  let start = 0
  let label = ""
  const head = data[0] ?? []
  for (const want of HEADER_PRIORITY) {
    const i = head.findIndex((c) => headerKey(c) === want)
    if (i >= 0) { col = i; start = 1; label = head[i].trim(); break }
  }
  if (col < 0) {
    const width = Math.max(0, ...data.map((r) => r.length))
    let best = 0
    for (let i = 0; i < width; i++) {
      const n = data.reduce((a, r) => a + (normalizeId(r[i]) ? 1 : 0), 0)
      if (n > best) { best = n; col = i }
    }
    if (col < 0) return { ids: [], source: where || "no id column found", duplicates: 0, invalid: [], invalidCount: 0 }
    // A first row that is not an id but whose column is otherwise ids is a header we did not recognise.
    if (data[0] && !normalizeId(data[0][col])) { start = 1; label = data[0][col]?.trim() ?? "" }
  }
  const seen = new Set<string>()
  const ids: string[] = []
  const invalid: string[] = []
  let invalidCount = 0
  let duplicates = 0
  for (const r of data.slice(start)) {
    const cell = (r[col] ?? "").trim()
    if (!cell) continue
    const id = normalizeId(cell)
    if (!id) { invalidCount++; if (invalid.length < MAX_INVALID_SHOWN) invalid.push(cell); continue }
    if (seen.has(id)) { duplicates++; continue }
    seen.add(id)
    ids.push(id)
  }
  const colName = label ? `column "${label}"` : `column ${columnLetter(col)}`
  return { ids, source: where ? `${colName} ${where}` : colName, duplicates, invalid, invalidCount }
}

function columnLetter(i: number): string {
  let s = ""
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

/** RFC 4180-ish CSV, guessing the delimiter (comma, semicolon or tab) from the first line. */
export function parseDelimited(text: string): string[][] {
  const t = text.replace(/^﻿/, "")
  const first = t.slice(0, t.search(/\r?\n|$/))
  const counts = [",", ";", "\t"].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])
  const delim = counts[0][1] > 1 ? counts[0][0] : ","
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (quoted) {
      if (ch === '"') {
        if (t[i + 1] === '"') { cell += '"'; i++ } else quoted = false
      } else cell += ch
    } else if (ch === '"' && !cell) quoted = true
    else if (ch === delim) { row.push(cell); cell = "" }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && t[i + 1] === "\n") i++
      row.push(cell); rows.push(row); row = []; cell = ""
    } else cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}

/** Pasted text: every record id anywhere in it, in order. */
export function idsFromText(text: string): IdImport {
  const found = text.match(GUID_ANYWHERE) ?? []
  const seen = new Set<string>()
  const ids: string[] = []
  let duplicates = 0
  for (const f of found) {
    const id = normalizeId(f)!
    if (seen.has(id)) duplicates++
    else { seen.add(id); ids.push(id) }
  }
  return { ids, source: "pasted list", duplicates, invalid: [], invalidCount: 0 }
}

export async function idsFromFile(file: File): Promise<IdImport> {
  const ext = file.name.toLowerCase().split(".").pop() ?? ""
  if (ext === "xls") throw new Error("Old .xls files can't be read. Save it as .xlsx or .csv and try again.")
  if (ext === "xlsx" || ext === "xlsm") {
    const ExcelJS = (await import("exceljs")).default
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await file.arrayBuffer())
    let best: IdImport | null = null
    for (const ws of wb.worksheets) {
      const rows: string[][] = []
      ws.eachRow({ includeEmpty: false }, (r) => {
        const cells: string[] = []
        r.eachCell({ includeEmpty: true }, (c, n) => { cells[n - 1] = c.text ?? "" })
        rows.push(Array.from(cells, (c) => c ?? ""))
      })
      const got = idsFromRows(rows, `on sheet "${ws.name}"`)
      if (!best || got.ids.length > best.ids.length) best = got
    }
    if (!best) throw new Error("The workbook has no sheets.")
    return best
  }
  if (["csv", "tsv", "txt"].includes(ext) || file.type.startsWith("text/")) return idsFromRows(parseDelimited(await file.text()))
  throw new Error("Use a .csv or .xlsx file.")
}
