import { useEffect, useMemo, useState } from "react"
import { Loader2, Eraser, Search, RefreshCw, CheckCircle2, AlertCircle, ExternalLink, Download, Link2 } from "lucide-react"
import { useAprimo } from "@/aprimo"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Progress } from "@/components/ui/progress"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { toast } from "sonner"
import { formatBytes } from "@/lib/bulk-versioning"
import { type CollectionInfo, type ExtraFile, type RecordScan, listCollections, collectionRecordIds, scanRecord, mapLimit, failedScan, removeAdditionalFiles, filesToCsv, downloadText } from "@/lib/rendition-cleanup"

// Rendition Cleanup: pick a collection, scan the master file's latest version
// of every record in it, filter the additional files (renditions, crops,
// trims…) and remove the selected ones. Nothing is written until the
// confirmation dialog is accepted; the master files themselves are never
// touched.

type Outcome = "deleted" | "failed"

const TYPE_LABEL: Record<string, string> = {
  OriginalRendition: "Rendition",
  Crop: "Crop",
  Trim: "Trim",
  Still: "Still",
  Spinset: "Spinset",
  Threedimensional: "3D",
  Subtitle: "Subtitle",
  External: "External",
  Custom: "Custom",
  AdditionalFile: "Additional file",
}

export function RenditionCleanupPage() {
  const { client, isConnected, connection } = useAprimo()

  const [collections, setCollections] = useState<CollectionInfo[] | null>(null)
  const [colError, setColError] = useState<string | null>(null)
  const [colQuery, setColQuery] = useState("")
  const [collection, setCollection] = useState<CollectionInfo | null>(null)

  const [scanning, setScanning] = useState<{ done: number; total: number } | null>(null)
  const [scans, setScans] = useState<RecordScan[] | null>(null)
  const [scanNote, setScanNote] = useState<string | null>(null)

  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set(["OriginalRendition"]))
  const [labelFilter, setLabelFilter] = useState<Set<string>>(new Set())
  const [extFilter, setExtFilter] = useState<Set<string>>(new Set())
  const [manualFilter, setManualFilter] = useState<"all" | "auto" | "manual">("all")
  const [hideLinked, setHideLinked] = useState(true)
  const [text, setText] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const [confirm, setConfirm] = useState(false)
  const [deleting, setDeleting] = useState<{ done: number; total: number } | null>(null)
  const [outcome, setOutcome] = useState<Map<string, Outcome>>(new Map())
  const [errors, setErrors] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    if (!isConnected || !client) return
    let cancelled = false
    listCollections(client)
      .then((c) => !cancelled && setCollections(c))
      .catch((e) => !cancelled && setColError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [isConnected, client])

  const filteredCollections = useMemo(() => {
    const q = colQuery.trim().toLowerCase()
    const all = collections ?? []
    return (q ? all.filter((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)) : all).slice(0, 50)
  }, [collections, colQuery])

  // ── Scan ───────────────────────────────────────────────────────────────────
  async function scan() {
    if (!client || !collection) return
    setScans(null)
    setScanNote(null)
    setSelected(new Set())
    setOutcome(new Map())
    setErrors(new Map())
    setScanning({ done: 0, total: 0 })
    try {
      const { ids, capped } = await collectionRecordIds(client, collection.id)
      if (!ids.length) {
        setScanNote("This collection has no records, or none you can see.")
        setScans([])
        return
      }
      setScanning({ done: 0, total: ids.length })
      const results = await mapLimit(ids, 3, (id) => scanRecord(client, id), (done) => setScanning({ done, total: ids.length }), failedScan)
      setScans(results)
      describe(results, capped)
    } catch (e) {
      setScanNote(e instanceof Error ? e.message : "Scan failed")
      setScans([])
    } finally {
      setScanning(null)
    }
  }

  function describe(results: RecordScan[], capped = false) {
    const files = results.reduce((a, r) => a + r.files.length, 0)
    const failed = results.filter((r) => r.error).length
    setScanNote(`${results.length} record${results.length === 1 ? "" : "s"} in the collection · ${results.length - failed} read · ${files} additional file${files === 1 ? "" : "s"} found${failed ? ` · ${failed} could not be read (retry below)` : ""}${capped ? " · stopped at 5000 records" : ""}`)
  }

  /** Re-reads only the records that failed last time and merges them in. */
  async function retryFailed() {
    if (!client || !scans) return
    const failedIds = scans.filter((r) => r.error).map((r) => r.recordId)
    if (!failedIds.length) return
    setScanning({ done: 0, total: failedIds.length })
    try {
      const redo = await mapLimit(failedIds, 2, (id) => scanRecord(client, id), (done) => setScanning({ done, total: failedIds.length }), failedScan)
      const byId = new Map(redo.map((r) => [r.recordId, r]))
      const merged = scans.map((r) => byId.get(r.recordId) ?? r)
      setScans(merged)
      describe(merged)
    } finally {
      setScanning(null)
    }
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const allFiles = useMemo<ExtraFile[]>(() => (scans ?? []).flatMap((r) => r.files), [scans])
  const facet = (pick: (f: ExtraFile) => string) => {
    const m = new Map<string, number>()
    for (const f of allFiles) m.set(pick(f), (m.get(pick(f)) ?? 0) + 1)
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1])
  }
  const typeFacet = useMemo(() => facet((f) => f.type), [allFiles]) // eslint-disable-line react-hooks/exhaustive-deps
  const labelFacet = useMemo(() => facet((f) => f.label || "(no label)"), [allFiles]) // eslint-disable-line react-hooks/exhaustive-deps
  const extFacet = useMemo(() => facet((f) => f.extension || "(none)"), [allFiles]) // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    const q = text.trim().toLowerCase()
    return allFiles.filter((f) => {
      if (outcome.has(f.id)) return true
      if (typeFilter.size && !typeFilter.has(f.type)) return false
      if (labelFilter.size && !labelFilter.has(f.label || "(no label)")) return false
      if (extFilter.size && !extFilter.has(f.extension || "(none)")) return false
      if (manualFilter === "auto" && f.isManual) return false
      if (manualFilter === "manual" && !f.isManual) return false
      if (hideLinked && f.publicLinks > 0) return false
      if (q && !`${f.recordTitle} ${f.masterFileName} ${f.label} ${f.fileName} ${f.tag}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [allFiles, typeFilter, labelFilter, extFilter, manualFilter, hideLinked, text, outcome])

  const selectable = visible.filter((f) => !outcome.has(f.id) && f.fileId && f.versionId)
  const selectedFiles = allFiles.filter((f) => selected.has(f.id) && !outcome.has(f.id))
  const selectedRecords = new Set(selectedFiles.map((f) => f.recordId)).size
  const selectedBytes = selectedFiles.reduce((a, f) => a + f.fileSize, 0)
  const linkedSelected = selectedFiles.filter((f) => f.publicLinks > 0).length
  const busy = !!scanning || !!deleting
  const damUrl = (recordId: string) => `https://${connection?.environment}.dam.aprimo.com/dam/contentitems/${recordId.replace(/-/g, "")}`

  function toggleFacet(set: Set<string>, setter: (s: Set<string>) => void, key: string) {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setter(next)
  }
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const allVisibleSelected = selectable.length > 0 && selectable.every((f) => selected.has(f.id))
  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) for (const f of selectable) next.delete(f.id)
      else for (const f of selectable) next.add(f.id)
      return next
    })
  }

  // ── Delete ─────────────────────────────────────────────────────────────────
  async function runDelete() {
    if (!client) return
    setConfirm(false)
    const byRecord = new Map<string, ExtraFile[]>()
    for (const f of selectedFiles) byRecord.set(f.recordId, [...(byRecord.get(f.recordId) ?? []), f])
    const groups = Array.from(byRecord.values())
    setDeleting({ done: 0, total: groups.length })
    let okFiles = 0
    let failFiles = 0
    await mapLimit(
      groups,
      2,
      async (files) => {
        const first = files[0]
        try {
          await removeAdditionalFiles(client, first.recordId, first.fileId, first.versionId, files.map((f) => f.id))
          setOutcome((prev) => {
            const next = new Map(prev)
            for (const f of files) next.set(f.id, "deleted")
            return next
          })
          okFiles += files.length
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          setOutcome((prev) => {
            const next = new Map(prev)
            for (const f of files) next.set(f.id, "failed")
            return next
          })
          setErrors((prev) => {
            const next = new Map(prev)
            for (const f of files) next.set(f.id, msg)
            return next
          })
          failFiles += files.length
        }
      },
      (done) => setDeleting({ done, total: groups.length }),
    )
    setDeleting(null)
    setSelected(new Set())
    toast[failFiles ? "warning" : "success"](`${okFiles} removed${failFiles ? `, ${failFiles} failed` : ""} across ${groups.length} record${groups.length === 1 ? "" : "s"}`)
  }

  function exportCsv(which: "selected" | "visible" | "log") {
    if (!collection) return
    const env = connection?.environment ?? "aprimo"
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")
    if (which === "log") {
      const done = allFiles.filter((f) => outcome.has(f.id))
      downloadText(filesToCsv(done, env, collection.name, new Map(Array.from(outcome.entries()).map(([id, o]) => [id, o === "failed" ? `failed: ${errors.get(id) ?? ""}` : o]))), `rendition-cleanup-log-${env}-${stamp}.csv`)
    } else {
      downloadText(filesToCsv(which === "selected" ? selectedFiles : visible, env, collection.name), `rendition-cleanup-${which}-${env}-${stamp}.csv`)
    }
  }

  const step1: StepState = collection ? "done" : "active"
  const step2: StepState = !collection ? "locked" : scans ? "done" : "active"
  const step3: StepState = !scans || !allFiles.length ? "locked" : "active"

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <main className="flex-1 w-full px-6 py-6">
        <div>
          <p className="text-muted-foreground mb-8 max-w-3xl">
            Pick a collection, scan the records in it, then remove renditions, crops or other additional files from each record&apos;s current master file version. Filter down to what you want gone, review the list, and confirm. Master files and versions are never touched.
          </p>

          <div className="grid gap-6 lg:grid-cols-2 mb-6">
            {/* Step 1: collection */}
            <Card className={`flex flex-col ${stepCardClass(step1)}`}>
              <CardHeader><CardTitle className="text-lg flex items-center gap-2"><StepMarker n={1} state={step1} /> Collection</CardTitle></CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input className="pl-8" placeholder={collections ? `Search ${collections.length} collections…` : "Loading collections…"} value={colQuery} onChange={(e) => setColQuery(e.target.value)} disabled={!collections || busy} />
                </div>
                {colError && <p className="text-xs text-destructive">{colError}</p>}
                {collection ? (
                  <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{collection.name}</div>
                      <div className="text-xs text-muted-foreground truncate">{collection.type}{collection.description ? ` · ${collection.description}` : ""}</div>
                    </div>
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setCollection(null); setScans(null); setScanNote(null); setSelected(new Set()) }} disabled={busy}>Change</Button>
                  </div>
                ) : (
                  <div className="max-h-64 overflow-y-auto divide-y divide-border rounded-md border border-border">
                    {collections && filteredCollections.length === 0 && <div className="text-xs text-muted-foreground px-3 py-4">No collection matches.</div>}
                    {filteredCollections.map((c) => (
                      <button key={c.id} onClick={() => setCollection(c)} className="w-full text-left px-3 py-2 hover:bg-muted/60 flex items-center gap-2">
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm truncate">{c.name}</span>
                          {c.description && <span className="block text-[11px] text-muted-foreground truncate">{c.description}</span>}
                        </span>
                        <Badge variant="outline" className="text-[10px] shrink-0">{c.type}</Badge>
                      </button>
                    ))}
                    {collections && collections.length > 50 && filteredCollections.length === 50 && <div className="text-[11px] text-muted-foreground px-3 py-1.5">Showing the first 50; type to narrow.</div>}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Step 2: scan */}
            <Card className={`flex flex-col ${stepCardClass(step2)}`} aria-disabled={step2 === "locked"}>
              <CardHeader><CardTitle className="text-lg flex items-center gap-2"><StepMarker n={2} state={step2} /> Scan records{step2 === "locked" && <span className="text-xs font-normal text-muted-foreground">Pick a collection first</span>}</CardTitle></CardHeader>
              <CardContent className="flex flex-col gap-3 flex-1">
                <p className="text-sm text-muted-foreground">Reads every record in the collection and lists the additional files on its master file&apos;s latest version, with their type, label, size and whether a public link points at them. Nothing is changed.</p>
                <div className="flex items-center gap-3">
                  <Button onClick={scan} disabled={!collection || busy}>
                    {scanning ? <><Loader2 className="w-4 h-4 animate-spin" /> Scanning…</> : <><RefreshCw className="w-4 h-4" /> {scans ? "Rescan" : "Scan collection"}</>}
                  </Button>
                  {scanning && scanning.total > 0 && <span className="text-xs text-muted-foreground tabular-nums">{scanning.done} / {scanning.total} records</span>}
                </div>
                {scanning && scanning.total > 0 && <Progress value={(scanning.done / scanning.total) * 100} className="h-1" />}
                {scanNote && <p className="text-xs text-muted-foreground">{scanNote}</p>}
                {scans && scans.some((r) => r.error) && (
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={retryFailed} disabled={busy}><RefreshCw className="w-4 h-4" /> Retry {scans.filter((r) => r.error).length} failed</Button>
                    <span className="text-xs text-amber-600">Those records are missing from the list below until they are read.</span>
                  </div>
                )}
                {scans && scans.some((r) => r.error) && (
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Records that could not be read</summary>
                    <ul className="mt-1 list-disc pl-4">{scans.filter((r) => r.error).map((r) => <li key={r.recordId}>{r.recordId}: {r.error}</li>)}</ul>
                  </details>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Step 3: filter, select, delete */}
          {scans && allFiles.length > 0 ? (
            <Card className={`mb-6 ${stepCardClass(step3)}`}>
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
                <CardTitle className="text-lg flex items-center gap-2"><StepMarker n={3} state={step3} /> Choose what to remove <span className="text-muted-foreground text-sm font-normal">{visible.length} of {allFiles.length} shown · {selectedFiles.length} selected</span></CardTitle>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => exportCsv("visible")} disabled={!visible.length}><Download className="w-4 h-4" /> Export shown</Button>
                  {outcome.size > 0 && <Button variant="outline" size="sm" onClick={() => exportCsv("log")}><Download className="w-4 h-4" /> Export log</Button>}
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <div className="flex flex-col gap-2 px-4 py-3 border-y border-border bg-muted/30 text-xs">
                  <FacetRow label="Type" items={typeFacet.map(([k, n]) => [k, n, TYPE_LABEL[k] ?? k] as const)} active={typeFilter} onToggle={(k) => toggleFacet(typeFilter, setTypeFilter, k)} disabled={busy} />
                  <FacetRow label="Label" items={labelFacet.map(([k, n]) => [k, n, k] as const)} active={labelFilter} onToggle={(k) => toggleFacet(labelFilter, setLabelFilter, k)} disabled={busy} />
                  <FacetRow label="Format" items={extFacet.map(([k, n]) => [k, n, k] as const)} active={extFilter} onToggle={(k) => toggleFacet(extFilter, setExtFilter, k)} disabled={busy} />
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground w-12">Origin</span>
                    {(["all", "auto", "manual"] as const).map((k) => (
                      <button key={k} onClick={() => setManualFilter(k)} disabled={busy} className={`rounded-full border px-2.5 py-1 transition-colors ${manualFilter === k ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border hover:bg-muted"}`}>{k === "all" ? "Any" : k === "auto" ? "Generated" : "Uploaded manually"}</button>
                    ))}
                    <label className="ml-2 inline-flex items-center gap-1.5 cursor-pointer"><Checkbox checked={hideLinked} onCheckedChange={(v) => setHideLinked(!!v)} disabled={busy} /> Hide files with public links</label>
                    <Input className="h-7 text-xs max-w-xs ml-auto" placeholder="Filter by record, label or file name…" value={text} onChange={(e) => setText(e.target.value)} disabled={busy} />
                  </div>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[36px]"><Checkbox checked={allVisibleSelected} onCheckedChange={toggleAllVisible} disabled={busy || !selectable.length} aria-label="Select all shown" /></TableHead>
                      <TableHead>Record</TableHead>
                      <TableHead>Additional file</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Size</TableHead>
                      <TableHead className="w-[150px]">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-6">Nothing matches these filters.</TableCell></TableRow>}
                    {visible.slice(0, 500).map((f) => {
                      const o = outcome.get(f.id)
                      return (
                        <TableRow key={f.id} className={o === "deleted" ? "opacity-60" : ""}>
                          <TableCell className="align-top"><Checkbox checked={selected.has(f.id)} onCheckedChange={() => toggleOne(f.id)} disabled={busy || !!o || !f.fileId || !f.versionId} aria-label="Select" /></TableCell>
                          <TableCell className="align-top">
                            <div className="flex items-center gap-2 min-w-0">
                              {f.thumbnailUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={f.thumbnailUrl} alt="" className="h-8 w-8 rounded object-cover border border-border shrink-0" />
                              ) : (
                                <div className="h-8 w-8 rounded bg-muted border border-border shrink-0" />
                              )}
                              <div className="min-w-0">
                                <a href={damUrl(f.recordId)} target="_blank" rel="noopener noreferrer" className="text-xs font-medium truncate block hover:underline underline-offset-2">{f.recordTitle || f.masterFileName || f.recordId}</a>
                                <div className="text-[11px] text-muted-foreground truncate">{f.masterFileName}</div>
                              </div>
                              <a href={damUrl(f.recordId)} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground shrink-0" title="Open in Aprimo"><ExternalLink className="w-3.5 h-3.5" /></a>
                            </div>
                          </TableCell>
                          <TableCell className="align-top">
                            <div className="text-xs font-medium break-all">{f.label || f.fileName || "(unnamed)"}</div>
                            <div className="text-[11px] text-muted-foreground break-all">{f.fileName}{f.tag ? ` · tag ${f.tag}` : ""}{f.purposes.length ? ` · ${f.purposes.join(", ")}` : ""}</div>
                            {f.publicLinks > 0 && <div className="text-[11px] text-amber-600 flex items-center gap-1 mt-0.5"><Link2 className="w-3 h-3" /> {f.publicLinks} public link{f.publicLinks === 1 ? "" : "s"} would break</div>}
                          </TableCell>
                          <TableCell className="align-top"><Badge variant="outline" className="text-[10px]">{TYPE_LABEL[f.type] ?? f.type}</Badge>{f.isManual && <span className="block text-[10px] text-muted-foreground mt-0.5">manual</span>}</TableCell>
                          <TableCell className="align-top text-right text-xs tabular-nums">{formatBytes(f.fileSize)}<div className="text-[10px] text-muted-foreground">{f.extension}</div></TableCell>
                          <TableCell className="align-top">
                            {o === "deleted" && <span className="text-xs flex items-center gap-1 text-green-600"><CheckCircle2 className="w-3.5 h-3.5" /> Removed</span>}
                            {o === "failed" && <span className="text-xs flex items-start gap-1 text-destructive"><AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {errors.get(f.id)}</span>}
                            {!o && (!f.fileId || !f.versionId) && <span className="text-xs text-muted-foreground">No master version</span>}
                            {!o && f.fileId && f.versionId && <span className="text-xs text-muted-foreground">{selected.has(f.id) ? "Selected" : ""}</span>}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                    {visible.length > 500 && <TableRow><TableCell colSpan={6} className="text-center text-xs text-muted-foreground py-3">Showing the first 500 of {visible.length}. Narrow the filters to see the rest; selection and deletion still apply to everything selected.</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : (
            <Card className={`mb-6 ${stepCardClass("locked")}`} aria-disabled>
              <CardHeader><CardTitle className="text-lg flex items-center gap-2"><StepMarker n={3} state="locked" /> Choose what to remove <span className="text-xs font-normal text-muted-foreground">{scans ? "No additional files found in this collection" : "Scan a collection first"}</span></CardTitle></CardHeader>
            </Card>
          )}

          {/* Footer */}
          <div className="flex items-center justify-between pt-4 border-t border-border">
            <div className="text-xs text-muted-foreground">
              {selectedFiles.length ? <>{selectedFiles.length} file{selectedFiles.length === 1 ? "" : "s"} · {formatBytes(selectedBytes)} · {selectedRecords} record{selectedRecords === 1 ? "" : "s"}{linkedSelected ? <span className="text-amber-600"> · {linkedSelected} with public links</span> : null}</> : "Nothing selected"}
              {deleting && <span className="ml-3 tabular-nums">Removing… {deleting.done} / {deleting.total} records</span>}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => exportCsv("selected")} disabled={!selectedFiles.length || busy}><Download className="w-4 h-4" /> Export selection</Button>
              <Button variant="destructive" onClick={() => setConfirm(true)} disabled={!selectedFiles.length || busy}>
                {deleting ? <><Loader2 className="w-4 h-4 animate-spin" /> Removing…</> : <><Eraser className="w-4 h-4" /> Remove {selectedFiles.length} selected</>}
              </Button>
            </div>
          </div>

          <Dialog open={confirm} onOpenChange={setConfirm}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Remove {selectedFiles.length} additional file{selectedFiles.length === 1 ? "" : "s"} from Aprimo?</DialogTitle>
                <DialogDescription asChild>
                  <div className="space-y-2 text-sm">
                    <p>
                      This deletes {selectedFiles.length} file{selectedFiles.length === 1 ? "" : "s"} ({formatBytes(selectedBytes)}) from {selectedRecords} record{selectedRecords === 1 ? "" : "s"} in <strong>{collection?.name}</strong> on <span className="font-mono">{connection?.environment}</span>. Master files and versions stay as they are.
                    </p>
                    {linkedSelected > 0 && <p className="text-amber-600"><strong>{linkedSelected}</strong> of them have public links. Those links stop working once the file is gone.</p>}
                    <p>This cannot be undone from here. Renditions from presets can be regenerated in Aprimo; manually uploaded files cannot.</p>
                    <p className="text-muted-foreground">Tip: Export selection first if you want a record of what was removed.</p>
                  </div>
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirm(false)}>Cancel</Button>
                <Button variant="destructive" onClick={runDelete}><Eraser className="w-4 h-4" /> Yes, remove {selectedFiles.length}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </main>
    </div>
  )
}

function FacetRow({ label, items, active, onToggle, disabled }: { label: string; items: ReadonlyArray<readonly [string, number, string]>; active: Set<string>; onToggle: (k: string) => void; disabled?: boolean }) {
  if (!items.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground w-12">{label}</span>
      {items.slice(0, 24).map(([k, n, text]) => (
        <button key={k} onClick={() => onToggle(k)} disabled={disabled} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition-colors ${active.has(k) ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border hover:bg-muted"}`}>
          {text}<span className={`tabular-nums ${active.has(k) ? "opacity-80" : "text-muted-foreground"}`}>{n}</span>
        </button>
      ))}
      {items.length > 24 && <span className="text-muted-foreground">+{items.length - 24} more</span>}
      {active.size > 0 && <button onClick={() => Array.from(active).forEach(onToggle)} className="underline underline-offset-2 text-muted-foreground hover:text-foreground">any</button>}
    </div>
  )
}

type StepState = "active" | "done" | "locked"
function stepCardClass(state: StepState): string {
  if (state === "active") return "ring-2 ring-primary shadow-lg transition-all duration-300"
  if (state === "done") return "transition-all duration-300"
  return "opacity-45 pointer-events-none select-none grayscale-[40%] transition-all duration-300"
}
function StepMarker({ n, state }: { n: number; state: StepState }) {
  if (state === "done") return <span className="h-6 w-6 rounded-full bg-green-600 text-white flex items-center justify-center shrink-0"><CheckCircle2 className="h-4 w-4" /></span>
  return <span className={`h-6 w-6 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${state === "active" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground border border-border"}`}>{n}</span>
}
