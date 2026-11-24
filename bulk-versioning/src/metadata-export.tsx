import { useEffect, useMemo, useRef, useState } from "react"
import { Loader2, Search, Download, FolderOpen, FileSpreadsheet, Play, Pause, Eye, AlertCircle, CheckCircle2, RotateCcw, X } from "lucide-react"
import { useAprimo } from "@/aprimo"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Progress } from "@/components/ui/progress"
import { DropZone } from "@/components/ui/drop-zone"
import { toast } from "sonner"
import { formatBytes } from "@/lib/bulk-versioning"
import { type CollectionInfo, listCollections, downloadText } from "@/lib/rendition-cleanup"
import { type IdImport, idsFromFile, idsFromText } from "@/lib/record-ids"
import {
  type Api, type Cursor, type FieldDef, type LanguageInfo, type RawRecord, type RowOptions, type Source,
  NEUTRAL_LANGUAGE, apiCall, classificationIds, csvLine, header, loadFieldDefs, loadLanguages, missingFields, readPage, resolveCollection, startCursor, toRow,
} from "@/lib/metadata-export"
import { StepMarker, stepCardClass, type StepState } from "@/rendition-cleanup"

// Metadata Export: choose records (everything, a search, a collection, or a list of ids), choose fields, preview five
// records, then stream every record to a CSV on disk. Progress is checkpointed after each page, so a stopped or
// crashed export resumes where it left off, even after restarting the app.

declare global {
  interface Window {
    exportFiles: {
      choose: (defaultName: string) => Promise<string | null>
      open: (path: string, resumeAt?: number) => Promise<{ id: number; bytes: number }>
      write: (id: number, text: string) => Promise<number>
      close: (id: number) => Promise<boolean>
      reveal: (path: string) => Promise<boolean>
    }
  }
}

type SourceMode = "all" | "expression" | "collection" | "file"
const RATES = [[1, "Gentle · 1 request/s"], [3, "Normal · 3 requests/s"], [6, "Fast · 6 requests/s"]] as const
/** Rows per CSV file before starting the next part; Excel opens up to 1,048,576. */
const ROWS_PER_FILE = 1_000_000
const CHECKPOINT_KEY = "metadataExport.checkpoint"

interface Config { fieldIds: string[]; masterFile: boolean; language: string; names: boolean; pageSize: number; rate: number }
interface Checkpoint {
  environment: string
  sourceLabel: string
  source: Source
  cursor: Cursor
  config: Config
  path: string
  part: number
  partPath: string
  bytes: number
  rowsInPart: number
  written: number
  total: number | null
  missing: string[]
  startedAt: number
  finishedAt?: number
}

const loadCheckpoint = (): Checkpoint | null => {
  try { return JSON.parse(localStorage.getItem(CHECKPOINT_KEY) ?? "null") } catch { return null }
}
const saveCheckpoint = (c: Checkpoint | null) => {
  try { if (c) localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(c)); else localStorage.removeItem(CHECKPOINT_KEY) } catch { /* storage full or blocked: resume just won't be offered */ }
}
const partPathOf = (path: string, part: number) => (part === 1 ? path : path.replace(/\.csv$/i, `-part${part}.csv`))
const fmtDuration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

export function MetadataExportPage() {
  const { client, isConnected, connection } = useAprimo()
  const environment = connection?.environment ?? ""
  const api: Api = useMemo(() => ({ environment, token: () => window.aprimoAuth.getAccessToken(), rate: 3 }), [environment])

  // Definitions
  const [defs, setDefs] = useState<FieldDef[] | null>(null)
  const [languages, setLanguages] = useState<LanguageInfo[]>([])
  const [collections, setCollections] = useState<CollectionInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Step 1: records
  const [mode, setMode] = useState<SourceMode>("all")
  const [expression, setExpression] = useState("")
  const [colQuery, setColQuery] = useState("")
  const [collection, setCollection] = useState<CollectionInfo | null>(null)
  const [idList, setIdList] = useState<(IdImport & { name: string }) | null>(null)
  const [idError, setIdError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [pasted, setPasted] = useState("")
  const fileInput = useRef<HTMLInputElement>(null)
  const resolved = useRef<{ key: string; source: Source } | null>(null)

  // Step 2: columns
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [fieldQuery, setFieldQuery] = useState("")
  const [masterFile, setMasterFile] = useState(true)
  const [language, setLanguage] = useState("*")
  const [names, setNames] = useState(true)
  const [rate, setRate] = useState(3)

  // Step 3: preview and run
  const [preview, setPreview] = useState<{ head: string[]; rows: string[][]; total: number | null; warning?: string } | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [resolving, setResolving] = useState<string | null>(null)
  const [cp, setCp] = useState<Checkpoint | null>(() => loadCheckpoint())
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [rateNow, setRateNow] = useState(0)
  const abort = useRef<AbortController | null>(null)
  const classNames = useRef(new Map<string, string>())

  useEffect(() => {
    if (!isConnected || !client) return
    let cancelled = false
    Promise.all([loadFieldDefs(client), loadLanguages(client)])
      .then(([d, l]) => {
        if (cancelled) return
        setDefs(d)
        setLanguages(l)
        setSelected(new Set(d.map((f) => f.id)))
        const en = l.find((x) => /^en(-us)?$/i.test(x.culture)) ?? l.find((x) => /^en/i.test(x.culture))
        if (en) setLanguage(en.id)
      })
      .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : String(e)))
    listCollections(client).then((c) => !cancelled && setCollections(c)).catch(() => {})
    return () => { cancelled = true }
  }, [isConnected, client])

  const busy = running || previewing || !!resolving
  const cpHere = cp && cp.environment === environment ? cp : null
  const unfinished = cpHere && !cpHere.finishedAt ? cpHere : null

  // ── Source ────────────────────────────────────────────────────────────────
  const sourceReady =
    mode === "all" ? true : mode === "expression" ? !!expression.trim() : mode === "collection" ? !!collection : !!idList
  const sourceLabel =
    mode === "all" ? "All records" : mode === "expression" ? `Search: ${expression.trim()}` : mode === "collection" ? `Collection: ${collection?.name ?? ""}` : `Record ids: ${idList?.name ?? ""}`

  async function getSource(signal?: AbortSignal): Promise<Source> {
    if (mode === "all") return { kind: "all" }
    if (mode === "expression") return { kind: "expression", expression: expression.trim() }
    if (mode === "file") return { kind: "ids", ids: idList?.ids ?? [] }
    const key = `collection:${collection!.id}`
    if (resolved.current?.key === key) return resolved.current.source
    setResolving("Reading the collection…")
    try {
      const source = await resolveCollection(api, collection!.id, signal, (n) => setResolving(`Reading the collection… ${n.toLocaleString()} records`))
      resolved.current = { key, source }
      return source
    } finally {
      setResolving(null)
    }
  }

  function resetPreview() { setPreview(null) }

  async function loadIdFile(file: File | undefined) {
    if (!file) return
    setIdError(null)
    try {
      const got = await idsFromFile(file)
      if (!got.ids.length) setIdError(`No record ids found in ${file.name}. Put them in a column headed "Record ID" (or "Id").`)
      else { setIdList({ ...got, name: file.name }); resetPreview() }
    } catch (e) {
      setIdError(e instanceof Error ? e.message : String(e))
    }
  }

  // ── Columns ───────────────────────────────────────────────────────────────
  const shownDefs = useMemo(() => {
    const q = fieldQuery.trim().toLowerCase()
    return (defs ?? []).filter((f) => !q || `${f.name} ${f.label} ${f.dataType}`.toLowerCase().includes(q))
  }, [defs, fieldQuery])
  const chosenDefs = useMemo(() => (defs ?? []).filter((f) => selected.has(f.id)), [defs, selected])
  const allSelected = !!defs && selected.size === defs.length

  function config(): Config {
    return { fieldIds: chosenDefs.map((f) => f.id), masterFile, language, names, pageSize: 1000, rate }
  }
  function rowOptions(c: Config): RowOptions {
    const ids = new Set(c.fieldIds)
    return { fields: (defs ?? []).filter((f) => ids.has(f.id)), masterFile: c.masterFile, language: c.language, languages, names: c.names, multiSeparator: "|" }
  }
  function readOptions(c: Config) {
    const o = rowOptions(c)
    // All fields: leave select-record-fields off rather than send a header listing hundreds of names.
    return { fieldNames: defs && o.fields.length === defs.length ? [] : o.fields.map((f) => f.name), masterFile: c.masterFile, pageSize: c.pageSize }
  }

  async function lookupClassifications(records: RawRecord[], o: RowOptions, signal?: AbortSignal) {
    const todo = classificationIds(records, o).filter((id) => !classNames.current.has(id))
    let i = 0
    await Promise.all(Array.from({ length: Math.min(4, todo.length) }, async () => {
      while (i < todo.length) {
        const id = todo[i++]
        try {
          const c = await apiCall({ ...api, rate: 0 }, "GET", `classification/${id}`, { signal })
          const label = o.language !== "*" ? c?.labels?.find((l: { languageId: string; value: string }) => l.languageId?.replace(/-/g, "").toLowerCase() === o.language)?.value : undefined
          classNames.current.set(id, c?.namePath || label || c?.name || id)
        } catch (e) {
          if ((e as Error)?.name === "AbortError") throw e
          classNames.current.set(id, id)
        }
      }
    }))
  }

  // ── Preview ───────────────────────────────────────────────────────────────
  async function runPreview() {
    setPreviewing(true)
    setPreview(null)
    try {
      const c = config()
      let source = await getSource()
      if (source.kind === "ids") source = { kind: "ids", ids: source.ids.slice(0, 5) }
      const page = await readPage({ ...api, rate: 0 }, source, startCursor(source), { ...readOptions(c), pageSize: 5 })
      const o = rowOptions(c)
      await lookupClassifications(page.records, o)
      const total = mode === "file" ? idList?.ids.length ?? null : resolved.current?.source.kind === "ids" && mode === "collection" ? (resolved.current.source as { ids: string[] }).ids.length : page.total
      const missing = missingFields(page.records, o)
      setPreview({
        head: header(o),
        rows: page.records.slice(0, 5).map((r) => toRow(r, o, classNames.current)),
        total,
        warning: !page.records.length ? "No records matched." : missing.length ? "These records came back without any field values. The API may not be returning fields for this search; check the field selection and try again." : undefined,
      })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setPreviewing(false)
    }
  }

  // ── Run ───────────────────────────────────────────────────────────────────
  async function startExport() {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")
    const path = await window.exportFiles.choose(`aprimo-metadata-${environment}-${stamp}.csv`)
    if (!path) return
    const source = await getSource()
    const c = config()
    const fresh: Checkpoint = {
      environment, sourceLabel, source, cursor: startCursor(source), config: c, path, part: 1, partPath: path, bytes: 0, rowsInPart: 0, written: 0,
      total: source.kind === "ids" ? source.ids.length : preview?.total ?? null, missing: [], startedAt: Date.now(),
    }
    await run(fresh, false)
  }

  async function run(start: Checkpoint, resume: boolean) {
    if (!defs) return
    setRunError(null)
    setRunning(true)
    const ctl = new AbortController()
    abort.current = ctl
    let state = start
    const o = rowOptions(state.config)
    const ro = readOptions(state.config)
    const pacing: Api = { ...api, rate: state.config.rate }
    const head = csvLine(header(o))
    let file = await window.exportFiles.open(state.partPath, resume ? state.bytes : undefined)
    const window5: Array<[number, number]> = []
    try {
      if (!resume || state.bytes === 0) state = { ...state, bytes: await window.exportFiles.write(file.id, "﻿" + head), rowsInPart: 0 }
      setCp(state)
      saveCheckpoint(state)
      for (;;) {
        const page = await readPage(pacing, state.source, state.cursor, ro, ctl.signal)
        await lookupClassifications(page.records, o, ctl.signal)
        if (page.records.length && state.rowsInPart >= ROWS_PER_FILE) {
          await window.exportFiles.close(file.id)
          const part = state.part + 1
          const partPath = partPathOf(state.path, part)
          file = await window.exportFiles.open(partPath)
          state = { ...state, part, partPath, rowsInPart: 0, bytes: await window.exportFiles.write(file.id, "﻿" + head) }
        }
        const text = page.records.map((r) => csvLine(toRow(r, o, classNames.current))).join("")
        const bytes = text ? await window.exportFiles.write(file.id, text) : state.bytes
        state = {
          ...state,
          cursor: page.cursor,
          bytes,
          written: state.written + page.records.length,
          rowsInPart: state.rowsInPart + page.records.length,
          total: state.source.kind === "ids" ? state.source.ids.length : state.total ?? page.total,
          missing: page.missing.length ? [...state.missing, ...page.missing] : state.missing,
          finishedAt: page.done ? Date.now() : undefined,
        }
        saveCheckpoint(state)
        setCp(state)
        const now = Date.now()
        window5.push([now, state.written])
        while (window5.length > 1 && now - window5[0][0] > 30_000) window5.shift()
        if (window5.length > 1) setRateNow(((state.written - window5[0][1]) / (now - window5[0][0])) * 1000)
        if (page.done) break
      }
      toast.success(`Exported ${state.written.toLocaleString()} records`)
    } catch (e) {
      if ((e as Error)?.name !== "AbortError") setRunError(e instanceof Error ? e.message : String(e))
    } finally {
      await window.exportFiles.close(file.id).catch(() => {})
      setRunning(false)
      abort.current = null
    }
  }

  function discard() {
    saveCheckpoint(null)
    setCp(null)
    setRunError(null)
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const step1: StepState = running || unfinished ? "done" : sourceReady ? "done" : "active"
  const step2: StepState = !defs ? "locked" : chosenDefs.length || masterFile ? "done" : "active"
  const step3: StepState = !defs || !sourceReady ? "locked" : "active"
  const filteredCollections = (collections ?? []).filter((c) => !colQuery.trim() || c.name.toLowerCase().includes(colQuery.trim().toLowerCase())).slice(0, 50)
  const progress = cpHere?.total ? Math.min(100, (cpHere.written / cpHere.total) * 100) : null
  const eta = cpHere && running && rateNow > 0 && cpHere.total ? (cpHere.total - cpHere.written) / rateNow * 1000 : null

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <main className="flex-1 w-full px-6 py-6">
        <p className="text-muted-foreground mb-6 max-w-3xl">
          Export record metadata to CSV: every record, a search, a collection, or a list of record ids. Pick the fields, check a five-record preview, then export. The file is written as it goes, and an interrupted export picks up where it stopped. Nothing in Aprimo is changed.
        </p>

        {loadError && <p className="mb-4 text-sm text-destructive">Could not load field definitions: {loadError}</p>}

        {unfinished && !running && (
          <div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm">
            <AlertCircle className="h-4 w-4 text-amber-600 shrink-0" />
            <span className="flex-1 min-w-0">
              An export stopped at <strong>{unfinished.written.toLocaleString()}</strong>{unfinished.total ? ` of about ${unfinished.total.toLocaleString()}` : ""} records ({unfinished.sourceLabel}) → <span className="font-mono text-xs">{unfinished.partPath}</span>
              {runError && <span className="block text-destructive text-xs mt-1">{runError}</span>}
            </span>
            <Button size="sm" onClick={() => run(unfinished, true)} disabled={!defs}><RotateCcw className="w-4 h-4" /> Resume</Button>
            <Button size="sm" variant="ghost" onClick={discard}><X className="w-4 h-4" /> Discard</Button>
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-2 mb-6">
          {/* Step 1: records */}
          <Card className={`flex flex-col ${stepCardClass(running ? "locked" : step1)}`}>
            <CardHeader><CardTitle className="text-lg flex items-center gap-2"><StepMarker n={1} state={step1} /> Records</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="inline-flex flex-wrap self-start rounded-md border border-border p-0.5 text-xs" role="tablist">
                {([["all", "All records"], ["expression", "Search"], ["collection", "Collection"], ["file", "File or list"]] as const).map(([k, l]) => (
                  <button key={k} role="tab" aria-selected={mode === k} onClick={() => { setMode(k); resetPreview() }} disabled={busy} className={`rounded px-3 py-1 transition-colors ${mode === k ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>{l}</button>
                ))}
              </div>

              {mode === "all" && <p className="text-sm text-muted-foreground">Every record you can see in <span className="font-mono">{environment}</span>, read oldest first by created date.</p>}

              {mode === "expression" && (
                <>
                  <textarea value={expression} onChange={(e) => { setExpression(e.target.value); resetPreview() }} disabled={busy} rows={3} placeholder={`e.g. ContentType = 'Asset' AND Status = 'Released'\nor FieldName('Brand') = 'Acme'`} className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs font-mono resize-y focus:outline-none focus:ring-2 focus:ring-ring" />
                  <p className="text-[11px] text-muted-foreground">Aprimo search syntax: = &lt;&gt; &gt; &gt;= &lt; &lt;= CONTAINS, combined with AND / OR / NOT. Use Preview to check it.</p>
                </>
              )}

              {mode === "collection" && (collection ? (
                <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{collection.name}</div>
                    <div className="text-xs text-muted-foreground truncate">{collection.type}{collection.description ? ` · ${collection.description}` : ""}</div>
                  </div>
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setCollection(null); resetPreview() }} disabled={busy}>Change</Button>
                </div>
              ) : (
                <>
                  <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input className="pl-8" placeholder={collections ? `Search ${collections.length} collections…` : "Loading collections…"} value={colQuery} onChange={(e) => setColQuery(e.target.value)} disabled={!collections || busy} />
                  </div>
                  <div className="max-h-56 overflow-y-auto divide-y divide-border rounded-md border border-border">
                    {filteredCollections.map((c) => (
                      <button key={c.id} onClick={() => { setCollection(c); resetPreview() }} className="w-full text-left px-3 py-2 hover:bg-muted/60 flex items-center gap-2">
                        <span className="min-w-0 flex-1 text-sm truncate">{c.name}</span>
                        <Badge variant="outline" className="text-[10px] shrink-0">{c.type}</Badge>
                      </button>
                    ))}
                    {collections && !filteredCollections.length && <div className="text-xs text-muted-foreground px-3 py-4">No collection matches.</div>}
                  </div>
                </>
              ))}

              {mode === "file" && (
                <>
                  <input ref={fileInput} type="file" accept=".csv,.tsv,.txt,.xlsx,.xlsm" className="hidden" onChange={(e) => { loadIdFile(e.target.files?.[0]); e.target.value = "" }} />
                  {idList ? (
                    <div className="flex items-start gap-2 rounded-md border border-border px-3 py-2">
                      <FileSpreadsheet className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{idList.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {idList.ids.length.toLocaleString()} record id{idList.ids.length === 1 ? "" : "s"} from {idList.source}
                          {idList.duplicates > 0 && ` · ${idList.duplicates} duplicate${idList.duplicates === 1 ? "" : "s"} skipped`}
                          {idList.invalidCount > 0 && <span className="text-amber-600"> · {idList.invalidCount} not a record id</span>}
                        </div>
                      </div>
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setIdList(null); resetPreview() }} disabled={busy}>Change</Button>
                    </div>
                  ) : (
                    <>
                      <DropZone isDragging={dragging} onDragOver={() => setDragging(true)} onDragLeave={() => setDragging(false)} onDrop={(e) => { setDragging(false); loadIdFile(e.dataTransfer.files?.[0]) }} onClick={() => fileInput.current?.click()} className="py-5">
                        <FolderOpen className="h-7 w-7 text-muted-foreground mb-2" />
                        <p className="text-sm font-medium">Drop a CSV or Excel file of record ids</p>
                        <p className="text-xs text-muted-foreground mt-1">or click to browse</p>
                      </DropZone>
                      <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={2} placeholder="…or paste record ids" className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs font-mono resize-y focus:outline-none focus:ring-2 focus:ring-ring" />
                      <Button variant="outline" size="sm" className="self-start" disabled={!pasted.trim()} onClick={() => { const got = idsFromText(pasted); if (!got.ids.length) setIdError("No record ids in the pasted text."); else { setIdError(null); setIdList({ ...got, name: "Pasted list" }); resetPreview() } }}>Use pasted ids</Button>
                    </>
                  )}
                  {idError && <p className="text-xs text-destructive">{idError}</p>}
                </>
              )}
              {resolving && <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> {resolving}</p>}
            </CardContent>
          </Card>

          {/* Step 2: columns */}
          <Card className={`flex flex-col ${stepCardClass(running ? "locked" : step2)}`}>
            <CardHeader><CardTitle className="text-lg flex items-center gap-2"><StepMarker n={2} state={step2} /> Columns <span className="text-sm font-normal text-muted-foreground">{defs ? `${chosenDefs.length} of ${defs.length} fields` : "Loading fields…"}</span></CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-xs text-muted-foreground">Always included: record id, title, status, content type, created and modified dates.</p>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input className="pl-8" placeholder="Filter fields…" value={fieldQuery} onChange={(e) => setFieldQuery(e.target.value)} disabled={!defs} />
                </div>
                <Button variant="outline" size="sm" disabled={!defs} onClick={() => { setSelected(allSelected ? new Set() : new Set((defs ?? []).map((f) => f.id))); resetPreview() }}>{allSelected ? "None" : "All"}</Button>
              </div>
              <div className="max-h-52 overflow-y-auto rounded-md border border-border divide-y divide-border">
                {!defs && <div className="px-3 py-4 text-xs text-muted-foreground flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Loading field definitions…</div>}
                {shownDefs.map((f) => (
                  <label key={f.id} className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-muted/50">
                    <Checkbox checked={selected.has(f.id)} onCheckedChange={() => { setSelected((prev) => { const n = new Set(prev); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); return n }); resetPreview() }} />
                    <span className="min-w-0 flex-1 truncate">{f.name}{f.label && f.label !== f.name && <span className="text-muted-foreground"> · {f.label}</span>}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0">{f.dataType}</span>
                  </label>
                ))}
              </div>
              <div className="grid gap-2 text-xs sm:grid-cols-2">
                <label className="inline-flex items-center gap-1.5 cursor-pointer"><Checkbox checked={masterFile} onCheckedChange={(v) => { setMasterFile(!!v); resetPreview() }} /> Master file name, extension, size</label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer"><Checkbox checked={names} onCheckedChange={(v) => { setNames(!!v); resetPreview() }} /> Option and classification names (not ids)</label>
                <label className="flex items-center gap-2">Language
                  <select value={language} onChange={(e) => { setLanguage(e.target.value); resetPreview() }} className="flex-1 rounded-md border border-border bg-background px-2 py-1">
                    <option value="*">All languages in one cell</option>
                    {languages.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.culture})</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-2">Speed
                  <select value={rate} onChange={(e) => setRate(Number(e.target.value))} className="flex-1 rounded-md border border-border bg-background px-2 py-1">
                    {RATES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </label>
              </div>
              {language !== "*" && <p className="text-[11px] text-muted-foreground">Fields without a value in that language fall back to their language-neutral value.</p>}
            </CardContent>
          </Card>
        </div>

        {/* Step 3: preview and export */}
        <Card className={`mb-6 ${stepCardClass(step3)}`}>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-lg flex items-center gap-2"><StepMarker n={3} state={step3} /> Preview and export</CardTitle>
            <div className="flex gap-2">
              <Button variant="outline" onClick={runPreview} disabled={!sourceReady || !defs || busy}>{previewing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />} Preview 5 records</Button>
              {running ? (
                <Button variant="outline" onClick={() => abort.current?.abort()}><Pause className="w-4 h-4" /> Pause</Button>
              ) : (
                <Button onClick={startExport} disabled={!sourceReady || !defs || busy || !!unfinished} title={unfinished ? "Resume or discard the stopped export first" : undefined}><Download className="w-4 h-4" /> Export to CSV…</Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {preview && (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-muted-foreground">{preview.total != null ? `About ${preview.total.toLocaleString()} record${preview.total === 1 ? "" : "s"} to export` : "Record count unknown until the export runs"} · {preview.head.length} columns{preview.total ? ` · at ~1,000 records per request, about ${Math.ceil(preview.total / 1000).toLocaleString()} requests` : ""}</p>
                {preview.warning && <p className="text-xs text-amber-600 flex items-center gap-1.5"><AlertCircle className="h-3.5 w-3.5" /> {preview.warning}</p>}
                {preview.rows.length > 0 && (
                  <div className="overflow-x-auto rounded-md border border-border">
                    <table className="text-[11px]">
                      <thead className="bg-muted/50"><tr>{preview.head.map((h, i) => <th key={i} className="px-2 py-1 text-left font-medium whitespace-nowrap">{h}</th>)}</tr></thead>
                      <tbody>{preview.rows.map((r, i) => <tr key={i} className="border-t border-border">{r.map((c, j) => <td key={j} className="px-2 py-1 max-w-[220px] truncate" title={c}>{c}</td>)}</tr>)}</tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {cpHere && (running || cpHere.written > 0 || cpHere.finishedAt) && (
              <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                  {running ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : cpHere.finishedAt ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <Pause className="h-4 w-4 text-amber-600" />}
                  <span className="tabular-nums font-medium">{cpHere.written.toLocaleString()}{cpHere.total && !cpHere.finishedAt ? ` / ~${cpHere.total.toLocaleString()}` : ""} records{cpHere.finishedAt ? " exported" : ""}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{formatBytes(cpHere.bytes)}{cpHere.part > 1 ? ` · file ${cpHere.part}` : ""}</span>
                  {running && rateNow > 0 && <span className="text-xs text-muted-foreground tabular-nums">{Math.round(rateNow).toLocaleString()} records/s</span>}
                  {eta != null && <span className="text-xs text-muted-foreground tabular-nums">about {fmtDuration(eta)} left</span>}
                  {cpHere.finishedAt && <span className="text-xs text-muted-foreground">done in {fmtDuration(cpHere.finishedAt - cpHere.startedAt)}</span>}
                </div>
                {progress != null && <Progress value={cpHere.finishedAt ? 100 : progress} className="h-1" />}
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono truncate">{cpHere.partPath}</span>
                  {!running && <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => window.exportFiles.reveal(cpHere.partPath)}>Show in folder</Button>}
                  {cpHere.missing.length > 0 && (
                    <Button variant="ghost" size="sm" className="h-6 text-xs text-amber-600" onClick={() => downloadText(`record_id,reason\r\n${cpHere.missing.map((id) => `${id},not found or no access`).join("\r\n")}\r\n`, `metadata-export-missing-${environment}.csv`)}>
                      {cpHere.missing.length.toLocaleString()} id{cpHere.missing.length === 1 ? "" : "s"} not found · save list
                    </Button>
                  )}
                  {cpHere.finishedAt && !running && <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={discard}>Clear</Button>}
                </div>
                {runError && !unfinished && <p className="text-xs text-destructive">{runError}</p>}
              </div>
            )}
            {!preview && !cpHere && <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Play className="h-3.5 w-3.5" /> Preview first to check the columns, the language and the record count, then export.</p>}
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
