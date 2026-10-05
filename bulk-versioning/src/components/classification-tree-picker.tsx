"use client"

import { useMemo, useState } from "react"
import { ChevronRight, ChevronDown, Search, X } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import type { ClassificationNode } from "@/models"

// A classification tree with checkboxes, like Aprimo's own picker. Ticking a
// parent selects it and every descendant; ticking a child selects only that
// child. A parent with some (not all) of its branch selected shows a mixed
// state. The selection is the flat set of classification ids in scope.

interface Props {
  nodes: ClassificationNode[]
  selected: Set<string>
  onChange: (next: Set<string>) => void
  languageId?: string
  disabled?: boolean
  maxHeight?: number
}

interface TreeNode {
  id: string
  label: string
  children: TreeNode[]
}

function labelOf(c: ClassificationNode, languageId?: string): string {
  const l = languageId ? c.labels?.find((x) => x.languageId.toLowerCase() === languageId.toLowerCase())?.value : undefined
  return l ?? c.labels?.[0]?.value ?? c.name
}

export function buildTree(nodes: ClassificationNode[], languageId?: string): TreeNode[] {
  const ids = new Set(nodes.map((n) => n.id))
  const byParent = new Map<string, ClassificationNode[]>()
  const roots: ClassificationNode[] = []
  for (const n of nodes) {
    if (n.parentId && ids.has(n.parentId)) {
      const list = byParent.get(n.parentId) ?? []
      list.push(n)
      byParent.set(n.parentId, list)
    } else roots.push(n)
  }
  const build = (c: ClassificationNode): TreeNode => ({
    id: c.id,
    label: labelOf(c, languageId),
    children: (byParent.get(c.id) ?? []).map(build).sort((a, b) => a.label.localeCompare(b.label)),
  })
  return roots.map(build).sort((a, b) => a.label.localeCompare(b.label))
}

function descendants(n: TreeNode, out: string[] = []): string[] {
  for (const c of n.children) {
    out.push(c.id)
    descendants(c, out)
  }
  return out
}

export function ClassificationTreePicker({ nodes, selected, onChange, languageId, disabled, maxHeight = 360 }: Props) {
  const tree = useMemo(() => buildTree(nodes, languageId), [nodes, languageId])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState("")

  // With a filter, show only nodes whose label or any descendant's label matches, expanded along the way.
  const needle = filter.trim().toLowerCase()
  const visible = useMemo(() => {
    if (!needle) return null
    const keep = new Set<string>()
    const walk = (n: TreeNode): boolean => {
      let hit = n.label.toLowerCase().includes(needle)
      for (const c of n.children) if (walk(c)) hit = true
      if (hit) keep.add(n.id)
      return hit
    }
    for (const r of tree) walk(r)
    return keep
  }, [tree, needle])

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleBranch(n: TreeNode) {
    const branch = [n.id, ...descendants(n)]
    const all = branch.every((id) => selected.has(id))
    const next = new Set(selected)
    for (const id of branch) {
      if (all) next.delete(id)
      else next.add(id)
    }
    onChange(next)
  }

  function toggleOnly(n: TreeNode) {
    const next = new Set(selected)
    if (next.has(n.id)) next.delete(n.id)
    else next.add(n.id)
    onChange(next)
  }

  function Row({ n, depth }: { n: TreeNode; depth: number }) {
    if (visible && !visible.has(n.id)) return null
    const has = n.children.length > 0
    const open = needle ? true : expanded.has(n.id)
    const branch = has ? descendants(n) : []
    const selfOn = selected.has(n.id)
    const under = branch.filter((id) => selected.has(id)).length
    const state: boolean | "indeterminate" = selfOn && (!has || under === branch.length) ? true : selfOn || under > 0 ? "indeterminate" : false
    return (
      <div>
        <div className="flex items-center gap-1.5 py-0.5 pr-2 rounded hover:bg-muted/60 group" style={{ paddingLeft: depth * 16 + 4 }}>
          {has ? (
            <button onClick={() => toggleExpand(n.id)} className="h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground shrink-0" aria-label={open ? "Collapse" : "Expand"}>
              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          ) : (
            <span className="h-5 w-5 shrink-0" />
          )}
          <Checkbox checked={state} onCheckedChange={() => (has ? toggleBranch(n) : toggleOnly(n))} disabled={disabled} aria-label={has ? `${n.label} and all children` : n.label} />
          <button onClick={() => (has ? toggleExpand(n.id) : toggleOnly(n))} className="text-sm text-left truncate min-w-0 flex-1" disabled={disabled}>
            {n.label}
            {has && <span className="ml-1.5 text-[11px] text-muted-foreground">{n.children.length}</span>}
          </button>
          {has && (
            <button onClick={() => toggleOnly(n)} className="text-[11px] text-muted-foreground underline underline-offset-2 opacity-0 group-hover:opacity-100 shrink-0" disabled={disabled} title="Select or clear this classification without its children">
              {selfOn ? "clear this" : "this only"}
            </button>
          )}
        </div>
        {has && open && n.children.map((c) => <Row key={c.id} n={c} depth={depth + 1} />)}
      </div>
    )
  }

  return (
    <div className="rounded-md border border-border bg-card">
      <div className="flex items-center gap-2 p-2 border-b border-border">
        <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a classification…" className="h-7 text-xs border-0 shadow-none focus-visible:ring-0 px-0" disabled={disabled} />
        {filter && <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setFilter("")}><X className="h-3.5 w-3.5" /></Button>}
        <span className="text-[11px] text-muted-foreground whitespace-nowrap">{selected.size} selected</span>
        {selected.size > 0 && <Button variant="ghost" size="sm" className="h-6 text-[11px] px-1.5" onClick={() => onChange(new Set())} disabled={disabled}>Clear</Button>}
      </div>
      <div className="overflow-y-auto py-1" style={{ maxHeight }}>
        {tree.length === 0 && <div className="text-xs text-muted-foreground px-3 py-4">Loading classifications…</div>}
        {tree.map((r) => <Row key={r.id} n={r} depth={0} />)}
        {visible && visible.size === 0 && <div className="text-xs text-muted-foreground px-3 py-4">Nothing matches.</div>}
      </div>
    </div>
  )
}
