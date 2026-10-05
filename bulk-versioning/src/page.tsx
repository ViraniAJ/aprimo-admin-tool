import { useEffect, useMemo, useRef, useState } from "react"
import { Expander } from "aprimo-js"
import type { Record as AprimoSDKRecord, FileVersion } from "aprimo-js/model"
import { Loader2, Upload, Layers, FolderOpen, FileIcon, CheckCircle2, AlertCircle, Trash2, ExternalLink, RefreshCw, X } from "lucide-react"
import { ClassificationTreePicker } from "@/components/classification-tree-picker"
import { useAprimo } from "@/aprimo"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { DropZone } from "@/components/ui/drop-zone"
import { toast } from "sonner"
import type { ClassificationNode } from "@/models"
import { type VersionTarget, type Candidate, candidatesFor, AUTO_MATCH_SCORE, formatBytes } from "@/lib/bulk-versioning"
import { type PickedFile, filesFromDrop, filesFromInput, isUsable } from "@/lib/dropped-files"

// Bulk Versioning: pick a classification, drop local files (or a folder), and
// the tool finds the record in that classification whose master file has the
// same or a similar name. Each match can be versioned on its own, or all
// confirmed matches at once. The local file becomes a new version of the
// record's master file; nothing is created and nothing is deleted.

type Status = "pending" | "uploading" | "versioning" | "done" | "error"

const BROWSER_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml", "image/avif", "image/bmp"])

interface LocalItem {
  uid: string
  file: File
  relativePath: string
  /** Object URL for browser-renderable images; revoked when the row goes away. */
  previewUrl: string | null
  candidates: Candidate[]
  /** Chosen target record id, or null to skip. */
  targetId: string | null
  auto: boolean
  /** Text typed into the row's manual search; undefined when closed. */
  search?: string
  status: Status
  progress: number
  error?: string
}

const MAX_RECORDS = 3000
const PAGE_SIZE = 100
const IDS_PER_QUERY = 40

function q(s: string) {
  return s.replace(/'/g, "''")
}

export default function BulkVersioningPage() {
  const { client, isConnected, connection } = useAprimo()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  const [allClassifications, setAllClassifications] = useState<ClassificationNode[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [targets, setTargets] = useState<VersionTarget[]>([])
  const [loadingTargets, setLoadingTargets] = useState(false)
  const [targetsNote, setTargetsNote] = useState<string | null>(null)
  const [items, setItems] = useState<LocalItem[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [comment, setComment] = useState("")
  const [reading, setReading] = useState(false)
  const [running, setRunning] = useState(false)
  const [filter, setFilter] = useState<MatchFilter>("all")

  useEffect(() => {
    if (!isConnected || !client) return
    async function loadClassifications() {
      const all: ClassificationNode[] = []
      for await (const result of client!.classifications.getPaged(undefined, undefined, "*")) {
        if (!result.ok) break
        all.push(...((result.data?.items ?? []) as unknown as ClassificationNode[]))
      }
      setAllClassifications(all)
    }
    loadClassifications()
  }, [isConnected, client])

  // Folder picker: the attribute is non-standard, so set it imperatively.
  useEffect(() => {
    folderInputRef.current?.setAttribute("webkitdirectory", "")
    folderInputRef.current?.setAttribute("directory", "")
  }, [])

  const classificationIds = useMemo(() => Array.from(selectedIds), [selectedIds])

  // ── Load the records in the chosen classification ──────────────────────────
  async function loadTargets() {
    if (!client || classificationIds.length === 0) return
    setLoadingTargets(true)
    setTargetsNote(null)
    try {
      const expander = Expander.create()
        .for<AprimoSDKRecord>("Record").expand("masterfile", "masterfilelatestversion")
        .for<FileVersion>("FileVersion").expand("thumbnail", "preview")
      const found: VersionTarget[] = []
      const seen = new Set<string>()
      for (let i = 0; i < classificationIds.length && found.length < MAX_RECORDS; i += IDS_PER_QUERY) {
        const expr = classificationIds.slice(i, i + IDS_PER_QUERY).map((id) => `Classification = '${q(id)}'`).join(" OR ")
        for (let page = 1; found.length < MAX_RECORDS; page++) {
          const r = await client.search.records({ searchExpression: { expression: expr }, page, pageSize: PAGE_SIZE }, expander)
          if (!r.ok) throw new Error(r.error?.message ?? "Search failed")
          const rows = ((r.data as unknown as { items?: RawRecord[] })?.items ?? [])
          for (const rec of rows) {
            if (seen.has(rec.id)) continue
            seen.add(rec.id)
            found.push(toTarget(rec))
          }
          if (rows.length < PAGE_SIZE) break
        }
      }
      setTargets(found)
      setTargetsNote(found.length >= MAX_RECORDS ? `Stopped at ${MAX_RECORDS} records; narrow the classification for complete matching.` : `${found.length} record${found.length === 1 ? "" : "s"} with a master file in scope.`)
      // Re-match anything already dropped.
      setItems((prev) => prev.map((it) => rematch(it, found)))
    } catch (e) {
      setTargetsNote(e instanceof Error ? e.message : "Could not load records")
      setTargets([])
    } finally {
      setLoadingTargets(false)
    }
  }

  // ── Local files ────────────────────────────────────────────────────────────
  function addFiles(incoming: PickedFile[]) {
    const usable = incoming.filter(isUsable)
    const existing = new Set(items.map((p) => p.relativePath))
    const fresh = usable
      .filter((f) => !existing.has(f.relativePath))
      .map(({ file, relativePath }) =>
        rematch(
          { uid: crypto.randomUUID(), file, relativePath, previewUrl: BROWSER_IMAGE_TYPES.has(file.type) ? URL.createObjectURL(file) : null, candidates: [], targetId: null, auto: false, status: "pending" as Status, progress: 0 },
          targets,
        ),
      )
    const skipped = incoming.length - fresh.length
    if (!fresh.length) {
      toast.message(incoming.length ? "Those files are already in the list" : "No files found")
      return
    }
    setItems((prev) => {
      const seen = new Set(prev.map((p) => p.relativePath))
      return [...prev, ...fresh.filter((f) => !seen.has(f.relativePath))]
    })
    const withMatch = fresh.filter((f) => f.targetId).length
    toast.success(
      `Added ${fresh.length} file${fresh.length === 1 ? "" : "s"}` +
        (targets.length ? `, ${withMatch} matched` : "") +
        (skipped ? `. Skipped ${skipped} duplicate, hidden, or empty` : ""),
    )
  }

  async function onDropFiles(dt: DataTransfer) {
    setReading(true)
    try {
      addFiles(await filesFromDrop(dt))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not read the dropped files")
    } finally {
      setReading(false)
    }
  }

  function rematch(item: LocalItem, pool: VersionTarget[]): LocalItem {
    if (item.status === "done") return item
    // The best candidate is always pre-selected; the confidence colour tells the user how much to trust it.
    const candidates = candidatesFor(item.file.name, pool)
    const best = candidates[0]
    return { ...item, candidates, targetId: best ? best.target.recordId : null, auto: !!best, status: "pending", progress: 0, error: undefined }
  }

  function update(uid: string, patch: Partial<LocalItem>) {
    setItems((prev) => prev.map((it) => (it.uid === uid ? { ...it, ...patch } : it)))
  }

  /** Chooses any record in scope for a row, adding it to the row's candidates as a manual match. */
  function pickManual(uid: string, target: VersionTarget) {
    setItems((prev) =>
      prev.map((it) => {
        if (it.uid !== uid) return it
        const candidates = it.candidates.some((c) => c.target.recordId === target.recordId) ? it.candidates : [{ target, score: 0, reason: "manual" }, ...it.candidates]
        return { ...it, candidates, targetId: target.recordId, auto: false, search: undefined, status: "pending", error: undefined }
      }),
    )
  }

  function removeItems(keep: (it: LocalItem) => boolean) {
    setItems((prev) => {
      for (const it of prev) if (!keep(it) && it.previewUrl) URL.revokeObjectURL(it.previewUrl)
      return prev.filter(keep)
    })
  }

  // ── Versioning ─────────────────────────────────────────────────────────────
  async function versionOne(item: LocalItem): Promise<boolean> {
    if (!client) return false
    const target = item.candidates.find((c) => c.target.recordId === item.targetId)?.target
    if (!target) return false
    if (!target.fileId) {
      update(item.uid, { status: "error", error: "Record has no master file id; cannot add a version" })
      return false
    }
    try {
      update(item.uid, { status: "uploading", progress: 0, error: undefined })
      const uploadResult = await client.uploader.uploadFile(item.file, {
        parallelLimit: 4,
        onProgress: (uploaded, total) => update(item.uid, { progress: total > 0 ? Math.round((uploaded / total) * 100) : 0 }),
      })
      const token = (uploadResult.data as unknown as { token?: string } | undefined)?.token
      if (!uploadResult.ok || !token) throw new Error(uploadResult.error?.message ?? "Upload failed")
      update(item.uid, { status: "versioning", progress: 100 })
      const version: { id: string; fileName: string; comment?: string } = { id: token, fileName: item.file.name }
      if (comment.trim()) version.comment = comment.trim()
      const r = await client.records.update(target.recordId, {
        files: { addOrUpdate: [{ id: target.fileId, versions: { addOrUpdate: [version] } }] },
      })
      if (!r.ok) throw new Error(r.error?.message ?? "Record update failed")
      update(item.uid, { status: "done" })
      return true
    } catch (e) {
      update(item.uid, { status: "error", error: e instanceof Error ? e.message : "Unknown error" })
      return false
    }
  }

  async function versionAll() {
    // Only the rows the current filter shows.
    const todo = items.filter((it) => matchesFilter(it, filter) && isVersionable(it))
    if (!todo.length) {
      toast.error(filter === "all" ? "No confirmed matches to version" : "No versionable rows in this filter")
      return
    }
    setRunning(true)
    let ok = 0
    for (const it of todo) if (await versionOne(it)) ok++
    setRunning(false)
    toast[ok === todo.length ? "success" : "warning"](`${ok} of ${todo.length} versioned`)
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const visibleItems = items.filter((it) => matchesFilter(it, filter))
  const filterCounts = Object.fromEntries(MATCH_FILTERS.map((f) => [f.key, items.filter((it) => matchesFilter(it, f.key)).length])) as Record<MatchFilter, number>
  const versionableShown = visibleItems.filter(isVersionable).length
  const targetById = useMemo(() => new Map(targets.map((t) => [t.recordId, t])), [targets])
  const matched = items.filter((it) => it.targetId && it.status !== "done").length
  const lowConfidence = items.filter((it) => it.targetId && it.status !== "done" && (it.candidates.find((c) => c.target.recordId === it.targetId)?.score ?? 100) < AUTO_MATCH_SCORE && it.candidates.find((c) => c.target.recordId === it.targetId)?.reason !== "manual").length
  const unmatched = items.filter((it) => !it.targetId && it.status !== "done").length
  const done = items.filter((it) => it.status === "done").length
  const failed = items.filter((it) => it.status === "error").length
  const busy = running || items.some((it) => it.status === "uploading" || it.status === "versioning")
  // Guided flow: each step unlocks when the one before it is complete. Step 1 always stays editable.
  const step1: StepState = targets.length ? "done" : "active"
  const step2: StepState = !targets.length ? "locked" : items.length ? "done" : "active"
  const step3: StepState = !targets.length || !items.length ? "locked" : items.every((it) => it.status === "done" || !it.targetId) && done > 0 ? "done" : "active"
  const damUrl = (recordId: string) => `https://${connection?.environment}.dam.aprimo.com/dam/contentitems/${recordId.replace(/-/g, "")}`
  // A record chosen by more than one local file would get several versions in a row; flag it.
  const targetUse = new Map<string, number>()
  for (const it of items) if (it.targetId && it.status !== "done") targetUse.set(it.targetId, (targetUse.get(it.targetId) ?? 0) + 1)

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <main className="flex-1 w-full px-6 py-6">
        <div>
          <p className="text-muted-foreground mb-8 max-w-3xl">
            Pick a classification, then drop the updated files. Each local file is matched to the record in that classification whose master file has the same or a similar name, and becomes a new version of it. Review the matches, then version them one at a time or all at once.
          </p>

          {/* Steps 1 and 2 side by side on wide screens */}
          <div className="grid gap-6 lg:grid-cols-2 mb-6 items-stretch">
          {/* Step 1: scope */}
          <Card className={`flex flex-col ${stepCardClass(step1)}`}>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2"><StepMarker n={1} state={step1} /> Records to version</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="space-y-1.5">
                <Label>Classifications</Label>
                <p className="text-xs text-muted-foreground">Tick a parent to include everything beneath it, or expand it and tick individual children. Hover a parent for &quot;this only&quot;.</p>
                <ClassificationTreePicker nodes={allClassifications} selected={selectedIds} onChange={(next) => { setSelectedIds(next); setTargets([]); setTargetsNote(null) }} disabled={busy} maxHeight={260} />
              </div>
              <div className="flex items-center gap-3">
                <Button onClick={loadTargets} disabled={selectedIds.size === 0 || loadingTargets || busy}>
                  {loadingTargets ? <><Loader2 className="w-4 h-4 animate-spin" /> Loading…</> : <><RefreshCw className="w-4 h-4" /> Load records</>}
                </Button>
                <span className="text-xs text-muted-foreground">{selectedIds.size === 0 ? "Select at least one classification." : `${selectedIds.size} classification${selectedIds.size === 1 ? "" : "s"} in scope.`}</span>
              </div>
              {targetsNote && <p className="text-xs text-muted-foreground">{targetsNote}</p>}
            </CardContent>
          </Card>

          {/* Step 2: files */}
          <Card className={`flex flex-col ${stepCardClass(step2)}`} aria-disabled={step2 === "locked"}>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
              <CardTitle className="text-lg flex items-center gap-2"><StepMarker n={2} state={step2} /> Updated files{step2 === "locked" && <span className="text-xs font-normal text-muted-foreground">Load records in step 1 first</span>}</CardTitle>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={busy}><FileIcon className="w-4 h-4" /> Add files</Button>
                <Button variant="outline" size="sm" onClick={() => folderInputRef.current?.click()} disabled={busy}><FolderOpen className="w-4 h-4" /> Add folder</Button>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col flex-1 gap-4">
              <DropZone
                isDragging={isDragging}
                onDragOver={() => setIsDragging(true)}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(e) => { setIsDragging(false); onDropFiles(e.dataTransfer) }}
                onClick={() => fileInputRef.current?.click()}
                label={reading ? "Reading files…" : "Drop files or a folder here, or click to browse"}
                sublabel={targets.length ? "Files are matched to records by name as you add them" : "Load records first so files can be matched as you add them"}
                className={items.length ? "p-4" : "p-8 flex-1 min-h-[180px]"}
              />
              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => { if (e.target.files) addFiles(filesFromInput(e.target.files)); e.target.value = "" }} />
              <input ref={folderInputRef} type="file" multiple className="hidden" onChange={(e) => { if (e.target.files) addFiles(filesFromInput(e.target.files)); e.target.value = "" }} />
              {items.length > 0 && (
                <div className="rounded-md border border-border">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 border-b border-border text-xs">
                    <span className="font-medium">{items.length} file{items.length === 1 ? "" : "s"} added</span>
                    <span className="text-muted-foreground">{formatBytes(items.reduce((a, it) => a + it.file.size, 0))}</span>
                    {targets.length > 0 && <span className="text-muted-foreground">{items.filter((it) => it.targetId).length} matched · {items.filter((it) => !it.targetId).length} unmatched</span>}
                    <span className="ml-auto flex items-center gap-2">
                      <button onClick={() => document.getElementById("bv-matches")?.scrollIntoView({ behavior: "smooth", block: "start" })} className="underline underline-offset-2 text-muted-foreground hover:text-foreground">Review matches</button>
                      <button onClick={() => removeItems(() => false)} className="underline underline-offset-2 text-muted-foreground hover:text-foreground" disabled={busy}>Clear</button>
                    </span>
                  </div>
                  <ul className="max-h-40 overflow-y-auto divide-y divide-border">
                    {items.map((it) => {
                      const cand = it.candidates.find((c) => c.target.recordId === it.targetId)
                      const tone = it.status === "done" ? "bg-green-600" : !cand ? "bg-muted-foreground/40" : cand.reason === "manual" || cand.score >= AUTO_MATCH_SCORE ? "bg-green-600" : cand.score >= 60 ? "bg-amber-500" : "bg-red-500"
                      const note = it.status === "done" ? "versioned" : it.status === "error" ? "failed" : !targets.length ? "not matched yet" : cand ? (cand.reason === "manual" ? "manual" : `${cand.score}%`) : "no match"
                      return (
                        <li key={it.uid} className="flex items-center gap-2 px-3 py-1 text-xs">
                          {it.previewUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={it.previewUrl} alt="" className="h-6 w-6 rounded object-cover border border-border shrink-0" />
                          ) : (
                            <FileIcon className="h-4 w-4 mx-1 text-muted-foreground shrink-0" />
                          )}
                          <span className="truncate min-w-0 flex-1" title={it.relativePath}>{it.relativePath}</span>
                          <span className="text-muted-foreground shrink-0">{formatBytes(it.file.size)}</span>
                          <span className="flex items-center gap-1 shrink-0 w-[92px] justify-end">
                            <span className={`h-1.5 w-1.5 rounded-full ${tone}`} />
                            <span className="text-muted-foreground">{note}</span>
                          </span>
                          <button onClick={() => removeItems((p) => p.uid !== it.uid)} className="text-muted-foreground hover:text-foreground shrink-0" disabled={busy || it.status === "uploading" || it.status === "versioning"} title="Remove"><X className="h-3.5 w-3.5" /></button>
                        </li>
                      )
                    })}
                  </ul>
                  <p className="px-3 py-1.5 border-t border-border text-[11px] text-muted-foreground">Nothing is sent to Aprimo until you click Version or Version all.</p>
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="version-comment" className="text-sm">Version comment</Label>
                <Input id="version-comment" placeholder="Optional, stored on every new version" value={comment} onChange={(e) => setComment(e.target.value)} disabled={busy} />
              </div>
            </CardContent>
          </Card>
          </div>

          {/* Step 3: review */}
          {items.length > 0 ? (
            <Card className={`mb-6 scroll-mt-20 ${stepCardClass(step3)}`} id="bv-matches" aria-disabled={step3 === "locked"}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-lg flex flex-wrap items-center gap-2">
                  <StepMarker n={3} state={step3} /> Review and version {step3 === "locked" && <span className="text-xs font-normal text-muted-foreground">Load records in step 1 to match these files</span>}<span className="text-muted-foreground text-sm font-normal">{matched} matched{lowConfidence ? ` (${lowConfidence} low confidence)` : ""} · {unmatched} unmatched · {done} done{failed ? ` · ${failed} failed` : ""}</span>
                </CardTitle>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setItems((prev) => prev.map((it) => rematch(it, targets)))} disabled={busy || !targets.length}><RefreshCw className="w-4 h-4" /> Re-match</Button>
                  <Button variant="outline" size="sm" onClick={() => removeItems(() => false)} disabled={busy}><Trash2 className="w-4 h-4" /> Clear</Button>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <div className="flex flex-wrap items-center gap-1.5 px-4 py-2.5 border-y border-border bg-muted/30">
                  <span className="text-xs text-muted-foreground mr-1">Show</span>
                  {MATCH_FILTERS.map((f) => (
                    <button
                      key={f.key}
                      onClick={() => setFilter(f.key)}
                      disabled={filterCounts[f.key] === 0 && f.key !== "all"}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${filter === f.key ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border hover:bg-muted"}`}
                    >
                      {f.dot && <span className={`h-1.5 w-1.5 rounded-full ${f.dot}`} />}
                      {f.label}
                      <span className={`tabular-nums ${filter === f.key ? "opacity-80" : "text-muted-foreground"}`}>{filterCounts[f.key]}</span>
                    </button>
                  ))}
                  {filter !== "all" && (
                    <span className="ml-auto text-xs text-muted-foreground">Version all applies to the {visibleItems.length} row{visibleItems.length === 1 ? "" : "s"} shown</span>
                  )}
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Local file</TableHead>
                      <TableHead>Record to version</TableHead>
                      <TableHead className="w-[110px]">Match</TableHead>
                      <TableHead className="w-[150px]">Status</TableHead>
                      <TableHead className="w-[120px] text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleItems.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-6">No files in this filter.</TableCell>
                      </TableRow>
                    )}
                    {visibleItems.map((it) => {
                      const chosen = it.targetId ? targetById.get(it.targetId) : undefined
                      const chosenCand = it.candidates.find((c) => c.target.recordId === it.targetId)
                      const dup = it.targetId ? (targetUse.get(it.targetId) ?? 0) > 1 : false
                      const sameSize = chosen?.fileSize != null && chosen.fileSize === it.file.size && chosen.fileName.toLowerCase() === it.file.name.toLowerCase()
                      return (
                        <TableRow key={it.uid}>
                          <TableCell className="align-top">
                            <div className="flex items-start gap-2 min-w-0">
                              <Thumb src={it.previewUrl}><ComparePreview item={it} target={chosen ?? null} /></Thumb>
                              <div className="min-w-0">
                                <div className="text-sm font-medium break-all">{it.file.name}</div>
                                <div className="text-xs text-muted-foreground">{formatBytes(it.file.size)}{it.relativePath !== it.file.name ? ` · ${it.relativePath}` : ""}</div>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="align-top">
                            {it.status === "done" && chosen ? (
                              <TargetLine target={chosen} href={damUrl(chosen.recordId)} hover={<ComparePreview item={it} target={chosen} />} />
                            ) : (
                              <div className="flex flex-col gap-1.5">
                                {it.candidates.length > 0 && (
                                  <Select value={it.targetId ?? "__skip"} onValueChange={(v) => update(it.uid, { targetId: v === "__skip" ? null : v, auto: false, status: "pending", error: undefined })} disabled={busy}>
                                    <SelectTrigger className="h-8 text-xs max-w-md"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="__skip" className="text-xs">Skip this file</SelectItem>
                                      {it.candidates.map((c) => (
                                        <SelectItem key={c.target.recordId} value={c.target.recordId} className="text-xs">
                                          {c.target.fileName} · {c.reason === "manual" ? "chosen by you" : `${c.score}% ${c.reason}`}{c.target.title && c.target.title !== c.target.fileName ? ` · ${c.target.title}` : ""}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                )}
                                {chosen && <TargetLine target={chosen} href={damUrl(chosen.recordId)} hover={<ComparePreview item={it} target={chosen} />} />}
                                {!it.candidates.length && <span className="text-xs text-muted-foreground">{targets.length ? "No similar file name in this classification." : "Load records to match."}</span>}
                                {targets.length > 0 && it.search === undefined ? (
                                  <button onClick={() => update(it.uid, { search: "" })} className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground text-left w-fit" disabled={busy}>
                                    {it.candidates.length ? "Pick a different record…" : "Pick a record manually…"}
                                  </button>
                                ) : targets.length > 0 ? (
                                  <ManualSearch targets={targets} query={it.search ?? ""} onQuery={(v) => update(it.uid, { search: v })} onPick={(t) => pickManual(it.uid, t)} onClose={() => update(it.uid, { search: undefined })} />
                                ) : null}
                                {dup && <span className="text-[11px] text-amber-600">Another local file also targets this record; both would become versions.</span>}
                                {sameSize && <span className="text-[11px] text-amber-600">Same name and size as the current version; it may already be up to date.</span>}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="align-top">
                            {chosenCand ? (
                              <ConfidenceBadge score={chosenCand.score} manual={chosenCand.reason === "manual"} reason={chosenCand.reason} />
                            ) : null}
                          </TableCell>
                          <TableCell className="align-top">
                            {it.status === "pending" && <span className="text-xs text-muted-foreground">{it.targetId ? "Ready" : "Skipped"}</span>}
                            {(it.status === "uploading" || it.status === "versioning") && (
                              <div className="flex flex-col gap-1">
                                <span className="text-xs flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> {it.status === "uploading" ? `Uploading ${it.progress}%` : "Adding version…"}</span>
                                <Progress value={it.progress} className="h-1" />
                              </div>
                            )}
                            {it.status === "done" && <span className="text-xs flex items-center gap-1 text-green-600"><CheckCircle2 className="w-3.5 h-3.5" /> New version added</span>}
                            {it.status === "error" && <span className="text-xs flex items-start gap-1 text-destructive"><AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {it.error}</span>}
                          </TableCell>
                          <TableCell className="align-top text-right">
                            {it.status === "done" ? (
                              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => removeItems((p) => p.uid !== it.uid)}><X className="w-3.5 h-3.5" /></Button>
                            ) : (
                              <Button size="sm" className="h-7 text-xs" onClick={() => versionOne(it)} disabled={!it.targetId || busy}>
                                <Upload className="w-3.5 h-3.5" /> {it.status === "error" ? "Retry" : "Version"}
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : (
            <Card className={`mb-6 ${stepCardClass("locked")}`} aria-disabled>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2"><StepMarker n={3} state="locked" /> Review and version <span className="text-xs font-normal text-muted-foreground">{targets.length ? "Add files in step 2 to see matches" : "Complete steps 1 and 2 first"}</span></CardTitle>
              </CardHeader>
            </Card>
          )}

          {/* Footer actions */}
          <div className="flex items-center justify-between pt-4 border-t border-border">
            <div className="text-xs text-muted-foreground">
              {items.length} file{items.length === 1 ? "" : "s"} · {matched} matched{lowConfidence ? <span className="text-amber-600"> · {lowConfidence} below {AUTO_MATCH_SCORE}%, check before versioning</span> : null} · {done} versioned{failed ? ` · ${failed} failed` : ""}
            </div>
            <Button onClick={versionAll} disabled={busy || versionableShown === 0 || step3 === "locked"}>
              {running ? <><Loader2 className="w-4 h-4 animate-spin" /> Versioning…</> : <><Layers className="w-4 h-4" /> {filter === "all" ? `Version all (${versionableShown})` : `Version ${versionableShown} shown`}</>}
            </Button>
          </div>
        </div>
      </main>
    </div>
  )
}

/** Type-ahead over every record in scope, for rows the matcher could not place. */
function ManualSearch({ targets, query, onQuery, onPick, onClose }: { targets: VersionTarget[]; query: string; onQuery: (v: string) => void; onPick: (t: VersionTarget) => void; onClose: () => void }) {
  const needle = query.trim().toLowerCase()
  const hits = (needle ? targets.filter((t) => t.fileName.toLowerCase().includes(needle) || t.title.toLowerCase().includes(needle)) : targets).slice(0, 25)
  return (
    <div className="rounded-md border border-border bg-card p-2 max-w-md">
      <div className="flex items-center gap-2">
        <Input autoFocus placeholder={`Search ${targets.length} records by file name or title…`} value={query} onChange={(e) => onQuery(e.target.value)} className="h-7 text-xs" />
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose} title="Close"><X className="w-3.5 h-3.5" /></Button>
      </div>
      <div className="mt-1.5 max-h-56 overflow-y-auto divide-y divide-border">
        {hits.length === 0 && <div className="text-xs text-muted-foreground py-2 px-1">Nothing matches.</div>}
        {hits.map((t) => (
          <button key={t.recordId} onClick={() => onPick(t)} className="w-full text-left py-1.5 px-1 hover:bg-muted/60 rounded flex items-center gap-2">
            {t.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={t.thumbnailUrl} alt="" className="h-7 w-7 rounded object-cover border border-border shrink-0" />
            ) : (
              <div className="h-7 w-7 rounded bg-muted border border-border shrink-0" />
            )}
            <span className="min-w-0">
              <span className="block text-xs truncate">{t.fileName}</span>
              {t.title && t.title !== t.fileName && <span className="block text-[11px] text-muted-foreground truncate">{t.title}</span>}
            </span>
            <span className="ml-auto text-[11px] text-muted-foreground shrink-0">{formatBytes(t.fileSize)}</span>
          </button>
        ))}
        {targets.length > hits.length && needle === "" && <div className="text-[11px] text-muted-foreground py-1.5 px-1">Showing the first {hits.length}; type to narrow.</div>}
      </div>
    </div>
  )
}

// ── Match filters ────────────────────────────────────────────────────────────
type MatchFilter = "all" | "exact" | "high" | "medium" | "low" | "manual" | "none" | "done"

const MATCH_FILTERS: Array<{ key: MatchFilter; label: string; dot?: string }> = [
  { key: "all", label: "All" },
  { key: "exact", label: "100%", dot: "bg-green-600" },
  { key: "high", label: "80% and up", dot: "bg-green-600" },
  { key: "medium", label: "60 to 79%", dot: "bg-amber-500" },
  { key: "low", label: "Below 60%", dot: "bg-red-500" },
  { key: "manual", label: "Manual", dot: "bg-muted-foreground" },
  { key: "none", label: "No match", dot: "bg-muted-foreground/40" },
  { key: "done", label: "Versioned", dot: "bg-green-600" },
]

function chosenCandidate(it: LocalItem): Candidate | undefined {
  return it.candidates.find((c) => c.target.recordId === it.targetId)
}

/** Which rows a filter shows. Score filters cover rows still to version; "Versioned" shows finished ones. */
function matchesFilter(it: LocalItem, f: MatchFilter): boolean {
  if (f === "all") return true
  if (f === "done") return it.status === "done"
  if (it.status === "done") return false
  const c = chosenCandidate(it)
  if (f === "none") return !c
  if (!c) return false
  if (f === "manual") return c.reason === "manual"
  if (c.reason === "manual") return false
  if (f === "exact") return c.score === 100
  if (f === "high") return c.score >= AUTO_MATCH_SCORE
  if (f === "medium") return c.score >= 60 && c.score < AUTO_MATCH_SCORE
  return c.score < 60
}

function isVersionable(it: LocalItem): boolean {
  return !!it.targetId && it.status !== "done" && it.status !== "uploading" && it.status !== "versioning"
}

type StepState = "active" | "done" | "locked"

/** Active step is spotlit, finished steps stay usable, later steps are dimmed and inert. */
function stepCardClass(state: StepState): string {
  if (state === "active") return "ring-2 ring-primary shadow-lg transition-all duration-300"
  if (state === "done") return "transition-all duration-300"
  return "opacity-45 pointer-events-none select-none grayscale-[40%] transition-all duration-300"
}

function StepMarker({ n, state }: { n: number; state: StepState }) {
  if (state === "done")
    return (
      <span className="h-6 w-6 rounded-full bg-green-600 text-white flex items-center justify-center shrink-0" aria-label={`Step ${n} complete`}>
        <CheckCircle2 className="h-4 w-4" />
      </span>
    )
  return (
    <span className={`h-6 w-6 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${state === "active" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground border border-border"}`}>
      {n}
    </span>
  )
}

/** Confidence badge: green is a safe match, amber needs a glance, red is a guess. */
function ConfidenceBadge({ score, manual, reason }: { score: number; manual: boolean; reason: string }) {
  if (manual) return <Badge variant="outline" className="text-[10px]" title="Chosen by you">manual</Badge>
  const cls = score >= AUTO_MATCH_SCORE ? "bg-green-600 text-white border-transparent" : score >= 60 ? "bg-amber-500 text-white border-transparent" : "bg-red-500 text-white border-transparent"
  return (
    <Badge className={`text-[10px] tabular-nums ${cls}`} title={reason}>
      {score}%
    </Badge>
  )
}

/** Side-by-side of what is in Aprimo now and what would replace it. */
function ComparePreview({ item, target }: { item: LocalItem; target: VersionTarget | null }) {
  const pane = (label: string, src: string | null, caption: string, tone: "current" | "proposed") => (
    <div className="flex flex-col gap-1.5 min-w-0 w-[280px]">
      <div className={`text-[11px] uppercase tracking-[0.12em] ${tone === "proposed" ? "text-primary" : "text-muted-foreground"}`}>{label}</div>
      <div className="h-[220px] rounded border border-border bg-muted flex items-center justify-center overflow-hidden">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="" className="max-w-full max-h-full object-contain" />
        ) : (
          <span className="text-xs text-muted-foreground px-3 text-center">No preview for this file type</span>
        )}
      </div>
      <div className="text-[11px] text-muted-foreground break-all leading-snug">{caption}</div>
    </div>
  )
  return (
    <div className="flex gap-3">
      {target
        ? pane("Current version in Aprimo", target.previewUrl ?? target.thumbnailUrl, `${target.fileName} · ${formatBytes(target.fileSize)}${target.versionNumber != null ? ` · v${target.versionNumber}` : ""}${target.modifiedOn ? ` · ${new Date(target.modifiedOn).toLocaleDateString()}` : ""}`, "current")
        : pane("Current version in Aprimo", null, "No record chosen yet", "current")}
      {pane("Proposed new version", item.previewUrl, `${item.file.name} · ${formatBytes(item.file.size)} · ${new Date(item.file.lastModified).toLocaleDateString()} · local`, "proposed")}
    </div>
  )
}

/** Small thumbnail; hovering shows the comparison card passed as children. */
function Thumb({ src, children }: { src: string | null; children: React.ReactNode }) {
  const trigger = src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" className="h-10 w-10 rounded object-cover border border-border shrink-0 cursor-zoom-in bg-muted" />
  ) : (
    <div className="h-10 w-10 rounded bg-muted border border-border shrink-0 flex items-center justify-center cursor-zoom-in"><FileIcon className="w-4 h-4 text-muted-foreground" /></div>
  )
  return (
    <HoverCard openDelay={150} closeDelay={80}>
      <HoverCardTrigger asChild>{trigger}</HoverCardTrigger>
      <HoverCardContent side="right" align="start" className="w-auto p-3">{children}</HoverCardContent>
    </HoverCard>
  )
}

function TargetLine({ target, href, hover }: { target: VersionTarget; href: string; hover?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      {hover ? (
        <Thumb src={target.thumbnailUrl}>{hover}</Thumb>
      ) : target.thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={target.thumbnailUrl} alt="" className="h-10 w-10 rounded object-cover border border-border shrink-0" />
      ) : (
        <div className="h-10 w-10 rounded bg-muted border border-border shrink-0" />
      )}
      <div className="min-w-0">
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-xs font-medium truncate block hover:underline underline-offset-2" title="Open this record in Aprimo">
          {target.title || target.fileName}
        </a>
        <div className="text-[11px] text-muted-foreground truncate">
          <a href={href} target="_blank" rel="noopener noreferrer" className="hover:underline underline-offset-2" title="Open this record in Aprimo">{target.fileName}</a>
          {" · "}{formatBytes(target.fileSize)}{target.versionNumber != null ? ` · v${target.versionNumber}` : ""}{target.modifiedOn ? ` · ${new Date(target.modifiedOn).toLocaleDateString()}` : ""}
        </div>
      </div>
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground shrink-0" title="Open in Aprimo"><ExternalLink className="w-3.5 h-3.5" /></a>
    </div>
  )
}

// ── Record shape as returned by the search with our expansions ───────────────
interface RawRecord {
  id: string
  title?: string | null
  modifiedOn?: string
  _embedded?: {
    masterfile?: { id?: string }
    masterfilelatestversion?: {
      id?: string
      fileName?: string
      fileSize?: number
      versionNumber?: number
      createdOn?: string
      _embedded?: { thumbnail?: { uri?: string }; preview?: { uri?: string } }
    }
  }
}

function toTarget(rec: RawRecord): VersionTarget {
  const v = rec._embedded?.masterfilelatestversion
  return {
    recordId: rec.id,
    title: rec.title ?? "",
    fileName: v?.fileName ?? "",
    fileId: rec._embedded?.masterfile?.id ?? null,
    fileSize: v?.fileSize ?? null,
    versionNumber: v?.versionNumber ?? null,
    modifiedOn: v?.createdOn ?? rec.modifiedOn ?? null,
    thumbnailUrl: v?._embedded?.thumbnail?.uri ?? null,
    previewUrl: v?._embedded?.preview?.uri ?? null,
  }
}
