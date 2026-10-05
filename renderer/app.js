// Renderer logic. Bundled with aprimo-js + exceljs into bundle.js.
//
// The Aprimo client is built with the SAME shape the original web app used —
// createClient({ type: "custom", environment, tokenProvider }) — except the
// tokenProvider defers to the Electron main process, which owns the PKCE flow,
// token storage, and silent refresh. That's the seam that let us swap auth
// without touching any of the classifications/export logic below.

import { createClient } from "aprimo-js"
import ExcelJS from "exceljs"
import { loadDataModel } from "./data-model.js"

const $ = (id) => document.getElementById(id)

// ── Aprimo client backed by the main-process token provider ───────────
let client = null

function buildClient(environment) {
  return createClient({
    type: "custom",
    environment,
    tokenProvider: async () => {
      // Delegates to main; throws "NEEDS_LOGIN" when a fresh browser sign-in
      // is required (no refresh token + expired access token).
      return window.aprimoAuth.getAccessToken()
    },
  })
}

// ── Ported helpers (verbatim logic from the original page.tsx) ────────

function toGuid(id) {
  if (id.includes("-") || id.length !== 32) return id
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`
}
function normalizeId(id) {
  return toGuid(String(id).trim().replace(/^\{|\}$/g, "").toLowerCase())
}
function getDisplayLabel(labels, fallback) {
  if (!labels?.length) return fallback
  for (const lang of ["c2bd4f9b-bb95-4bcb-80c3-1e924c9c26dc", "c2bd4f9bbb954bcb80c31e924c9c26dc"]) {
    const m = labels.find((l) => l.languageId.toLowerCase() === lang.toLowerCase())
    if (m?.value) return m.value
  }
  const en = labels.find((l) => l.languageId.toLowerCase().startsWith("en"))
  return en?.value ?? labels[0]?.value ?? fallback
}

// Fetch record counts by searching on the classification relation field.
// This field is always "Classification" for the tenants this tool targets.
async function fetchClassificationCounts(ids, client, onProgress, concurrency = 5) {
  const counts = new Map()
  let done = 0
  const field = "Classification"

  async function tryField(id) {
    const maxRetries = 5
    let delay = 2000
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await client.search.records({
        searchExpression: { expression: `${field} = '${id}'` }, page: 1, pageSize: 1,
      })
      if (res.ok) return res.data?.totalCount ?? 0
      if (res.status === 429 && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, delay))
        delay *= 2
        continue
      }
      const msg = res.error?.message || res.error?.exceptionMessage || `HTTP ${res.status}`
      throw new Error(msg)
    }
  }

  async function fetchOne(id) {
    counts.set(id, await tryField(id))
    done++
    onProgress?.(done, ids.length)
  }

  if (ids.length > 0) {
    try {
      await fetchOne(ids[0])
    } catch (e) {
      throw new Error(`Record count search failed: ${e?.message ?? e}`)
    }
    for (let i = 1; i < ids.length; i += concurrency) {
      await Promise.all(ids.slice(i, i + concurrency).map(fetchOne))
    }
  }
  return counts
}

// ── State ─────────────────────────────────────────────────────────────
let allNodes = []      // { id, name, labelPath, parentId, labels }
let flatItems = []     // DFS-ordered { id, label, name, labelPath, depth, parentId, hasChildren }
let childrenMap = new Map()
let descendantsMap = new Map()
let expanded = new Set()
let checked = new Set()
let languages = []     // { id, name }
let selectedLangs = new Set()
let searchText = ""

function rebuildMaps() {
  childrenMap = new Map()
  for (const n of allNodes) {
    if (n.parentId) {
      const arr = childrenMap.get(n.parentId) ?? []
      arr.push(n.id); childrenMap.set(n.parentId, arr)
    }
  }
  descendantsMap = new Map()
  for (const n of allNodes) {
    const result = []
    const queue = [...(childrenMap.get(n.id) ?? [])]
    while (queue.length) {
      const cur = queue.shift()
      result.push(cur)
      queue.push(...(childrenMap.get(cur) ?? []))
    }
    descendantsMap.set(n.id, result)
  }
}

function buildFlatItems(nodes) {
  if (!nodes.length) return []
  const byParent = new Map()
  for (const n of nodes) {
    const arr = byParent.get(n.parentId) ?? []
    arr.push(n); byParent.set(n.parentId, arr)
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => (a.labelPath || a.name).localeCompare(b.labelPath || b.name))
  }
  const ids = new Set(nodes.map((n) => n.id))
  const roots = nodes.filter((n) => !n.parentId || !ids.has(n.parentId))
    .sort((a, b) => (a.labelPath || a.name).localeCompare(b.labelPath || b.name))
  const result = []
  function walk(node, depth) {
    const children = byParent.get(node.id) ?? []
    result.push({
      id: node.id, label: getDisplayLabel(node.labels, node.name), name: node.name,
      labelPath: node.labelPath, depth, parentId: node.parentId ?? null, hasChildren: children.length > 0,
    })
    for (const c of children) walk(c, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  return result
}

// ── Load ──────────────────────────────────────────────────────────────
async function load() {
  $("toolBody").classList.add("hidden")
  $("loadErr").classList.add("hidden")
  $("loadStatus").textContent = "Loading classifications…"
  checked = new Set(); expanded = new Set()
  try {
    const [classRes, langRes] = await Promise.allSettled([
      (async () => {
        const raw = []
        for await (const r of client.classifications.getPaged(undefined, undefined, "*")) {
          if (!r.ok) break
          raw.push(...((r.data?.items) ?? []))
        }
        return raw
      })(),
      (async () => {
        const all = []
        for await (const r of client.languages.getPaged()) {
          if (!r.ok) break
          const items = (r.data?.items ?? [])
          all.push(...items.filter((l) => l.isEnabledForFields).map((l) => ({ id: normalizeId(l.id), name: l.name })))
        }
        languages = all
        selectedLangs = new Set()
      })(),
    ])
    if (classRes.status === "rejected") throw classRes.reason
    allNodes = classRes.value.map((c) => ({
      id: normalizeId(String(c.id ?? "")),
      name: String(c.name ?? ""),
      labelPath: String(c.labelPath ?? ""),
      parentId: c.parentId ? normalizeId(String(c.parentId)) : undefined,
      labels: c.labels,
    }))
    rebuildMaps()
    flatItems = buildFlatItems(allNodes)
    $("loadStatus").textContent = ""
    $("toolBody").classList.remove("hidden")
    renderLangPills(); renderTree(); updateSelCount()
  } catch (e) {
    if (String(e?.message).includes("NEEDS_LOGIN")) { showConnect(); return }
    $("loadStatus").textContent = ""
    $("loadErr").textContent = e?.message ?? "Failed to load classifications"
    $("loadErr").classList.remove("hidden")
  }
}

// ── Tree rendering ────────────────────────────────────────────────────
function visibleItems() {
  const q = searchText.trim().toLowerCase()
  if (q) {
    return flatItems.filter((f) =>
      f.label.toLowerCase().includes(q) || f.labelPath.toLowerCase().includes(q) || f.name.toLowerCase().includes(q))
  }
  const vis = new Set()
  return flatItems.filter((f) => {
    if (f.depth === 0) { vis.add(f.id); return true }
    if (!f.parentId || !vis.has(f.parentId) || !expanded.has(f.parentId)) return false
    vis.add(f.id); return true
  })
}
function checkState(id) {
  if (checked.has(id)) return "true"
  const d = descendantsMap.get(id) ?? []
  if (d.some((x) => checked.has(x))) return "indeterminate"
  return "false"
}
function renderTree() {
  const tree = $("tree")
  tree.innerHTML = ""
  const items = visibleItems()
  if (!items.length) {
    tree.innerHTML = `<div class="muted" style="text-align:center;padding:20px">No classifications match your search.</div>`
    return
  }
  const searching = !!searchText.trim()
  for (const item of items) {
    const row = document.createElement("div")
    row.className = "node"
    row.style.paddingLeft = `${item.depth * 18 + 8}px`

    const tw = document.createElement("button")
    tw.className = "twisty"
    tw.style.visibility = item.hasChildren ? "visible" : "hidden"
    tw.textContent = expanded.has(item.id) ? "▾" : "▸"
    tw.onclick = () => { if (item.hasChildren) { expanded.has(item.id) ? expanded.delete(item.id) : expanded.add(item.id); renderTree() } }

    const cb = document.createElement("input")
    cb.type = "checkbox"
    const st = checkState(item.id)
    cb.checked = st === "true"
    cb.indeterminate = st === "indeterminate"
    cb.onchange = () => toggleCheck(item.id)

    const lbl = document.createElement("span")
    lbl.textContent = item.label

    row.append(tw, cb, lbl)
    if (item.depth === 0 && !searching) {
      const meta = document.createElement("span")
      meta.className = "muted small mono"
      meta.style.marginLeft = "auto"
      meta.textContent = `${(descendantsMap.get(item.id)?.length ?? 0) + 1} nodes`
      row.append(meta)
    }
    tree.append(row)
  }
}
function toggleCheck(id) {
  const d = descendantsMap.get(id) ?? []
  if (checked.has(id)) { checked.delete(id); d.forEach((x) => checked.delete(x)) }
  else { checked.add(id); d.forEach((x) => checked.add(x)) }
  renderTree(); updateSelCount()
}
function updateSelCount() {
  $("selCount").textContent = `${checked.size.toLocaleString()} of ${flatItems.length.toLocaleString()} selected`
  $("exportBtn").disabled = checked.size === 0
}

// ── Language pills ────────────────────────────────────────────────────
function renderLangPills() {
  const wrap = $("langPills")
  wrap.innerHTML = ""
  $("langWrap").style.display = languages.length ? "block" : "none"
  for (const lang of languages) {
    const b = document.createElement("button")
    b.className = "pill" + (selectedLangs.has(lang.id) ? " on" : "")
    b.textContent = lang.name
    b.onclick = () => { selectedLangs.has(lang.id) ? selectedLangs.delete(lang.id) : selectedLangs.add(lang.id); renderLangPills() }
    wrap.append(b)
  }
}

// ── Export (ported ExcelJS logic) ─────────────────────────────────────
async function doExport() {
  if (!client) return
  $("exportBtn").disabled = true
  $("countErr").textContent = ""
  const setStatus = (s) => { $("exportStatus").textContent = s }
  try {
    const nodeById = new Map(allNodes.map((n) => [n.id, n]))
    const selected = allNodes.filter((n) => checked.has(n.id))
      .sort((a, b) => (a.labelPath || a.name).localeCompare(b.labelPath || b.name))

    let countById = new Map()
    if ($("includeCount").checked) {
      try {
        countById = await fetchClassificationCounts(selected.map((n) => n.id), client,
          (d, t) => setStatus(`Fetching record counts… ${d}/${t}`))
      } catch (e) { $("countErr").textContent = "Count error: " + (e?.message ?? e) }
    }
    setStatus("Building spreadsheet…")

    const langs = languages.filter((l) => selectedLangs.has(l.id))
    const useLang = langs.length > 0
    const includeCount = $("includeCount").checked
    const labelForLang = (labels, langId, fb) => labels?.find((l) => normalizeId(l.languageId) === langId)?.value ?? fb
    const buildPath = (node) => {
      const parts = []; let cur = node
      while (cur) { parts.unshift(cur.name); cur = cur.parentId ? nodeById.get(cur.parentId) : undefined }
      return parts.join(" > ")
    }

    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet("Classifications")
    ws.columns = [
      { header: "Hierarchy Path", key: "path", width: 70 },
      { header: "ID", key: "id", width: 40 },
      { header: "System Name", key: "systemName", width: 35 },
      ...(useLang ? langs.map((l) => ({ header: `Name (${l.name})`, key: `name_${l.id}`, width: 35 }))
                  : [{ header: "Name", key: "name", width: 35 }]),
      { header: "Parent ID", key: "parentId", width: 40 },
      { header: "Parent System Name", key: "parentSystemName", width: 35 },
      ...(useLang ? langs.map((l) => ({ header: `Parent Name (${l.name})`, key: `parentName_${l.id}`, width: 35 }))
                  : [{ header: "Parent Name", key: "parentName", width: 35 }]),
      ...(includeCount ? [{ header: "Record Count", key: "count", width: 14 }] : []),
    ]
    ws.getRow(1).font = { bold: true }

    for (const node of selected) {
      const parent = node.parentId ? nodeById.get(node.parentId) : undefined
      const nameEntries = useLang
        ? Object.fromEntries(langs.map((l) => [`name_${l.id}`, labelForLang(node.labels, l.id, node.name)]))
        : { name: getDisplayLabel(node.labels, node.name) }
      const parentNameEntries = useLang
        ? Object.fromEntries(langs.map((l) => [`parentName_${l.id}`, parent ? labelForLang(parent.labels, l.id, parent.name) : ""]))
        : { parentName: parent ? getDisplayLabel(parent.labels, parent.name) : "" }
      ws.addRow({
        path: buildPath(node),
        id: node.id,
        systemName: node.name,
        ...nameEntries,
        parentId: node.parentId ?? "",
        parentSystemName: parent?.name ?? "",
        ...parentNameEntries,
        ...(includeCount ? { count: countById.get(node.id) ?? 0 } : {}),
      })
    }

    const buf = await wb.xlsx.writeBuffer()
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url; a.download = "classifications.xlsx"; a.click()
    URL.revokeObjectURL(url)
    setStatus("Exported.")
  } catch (e) {
    setStatus("")
    if (String(e?.message).includes("NEEDS_LOGIN")) { showConnect(); return }
    $("countErr").textContent = "Export failed: " + (e?.message ?? e)
  } finally {
    $("exportBtn").disabled = checked.size === 0
  }
}

// ── View switching ────────────────────────────────────────────────────
const ALL_VIEWS = ["connectView", "homeView", "toolView", "dataModelView"]
function hideAll() { ALL_VIEWS.forEach((id) => $(id).classList.add("hidden")) }

function showConnect() {
  hideAll()
  $("connectView").classList.remove("hidden")
  $("signOutBtn").classList.add("hidden")
  $("homeBtn").classList.add("hidden")
  $("headerTitle").textContent = "Aprimo Admin Tools"
  $("sessionLabel").textContent = ""
}

async function showHome() {
  hideAll()
  $("homeView").classList.remove("hidden")
  $("signOutBtn").classList.remove("hidden")
  $("homeBtn").classList.add("hidden")
  $("headerTitle").textContent = "Aprimo Admin Tools"
  const s = await window.aprimoAuth.session()
  $("sessionLabel").textContent = s ? `${s.environment}${s.hasRefreshToken ? " · auto-refresh" : ""}` : ""
  if (s?.environment) client = buildClient(s.environment)
}

async function showTool() {
  hideAll()
  $("toolView").classList.remove("hidden")
  $("signOutBtn").classList.remove("hidden")
  $("homeBtn").classList.remove("hidden")
  $("headerTitle").textContent = "Classifications Exporter"
  await load()
}

async function showDataModel() {
  hideAll()
  $("dataModelView").classList.remove("hidden")
  $("signOutBtn").classList.remove("hidden")
  $("homeBtn").classList.remove("hidden")
  $("headerTitle").textContent = "Data Model Explorer"
  await loadDataModel(client)
}

// ── Wire up ───────────────────────────────────────────────────────────
async function init() {
  $("redirectUriHint").textContent = await window.aprimoAuth.redirectUri()

  // Attempt to restore a prior session.
  const restored = await window.aprimoAuth.restore()
  if (restored?.environment) { $("env").value = restored.environment }
  if (restored?.clientId) { $("clientId").value = restored.clientId }
  if (restored?.signedIn) { await showHome() } else { showConnect() }

  $("loginBtn").onclick = async () => {
    const environment = $("env").value.trim()
    const clientId = $("clientId").value.trim()
    const clientSecret = $("clientSecret").value
    $("connectErr").classList.add("hidden")
    if (!environment || !clientId || !clientSecret) {
      $("connectErr").textContent = "Environment, Client ID, and Client Secret are all required."
      $("connectErr").classList.remove("hidden"); return
    }
    $("loginBtn").disabled = true
    $("connectStatus").textContent = "Opening your browser to sign in…"
    try {
      await window.aprimoAuth.login({ environment, clientId, clientSecret })
      $("connectStatus").textContent = ""
      await showHome()
    } catch (e) {
      $("connectStatus").textContent = ""
      $("connectErr").textContent = e?.message ?? "Sign-in failed."
      $("connectErr").classList.remove("hidden")
    } finally {
      $("loginBtn").disabled = false
    }
  }

  $("homeBtn").onclick = () => showHome()
  $("signOutBtn").onclick = async () => { await window.aprimoAuth.signOut(); client = null; showConnect() }

  // Tile navigation
  $("tileClassifications").onclick = () => showTool()
  $("tileDataModel").onclick = () => showDataModel()
  // Bulk Versioning is its own page (React + Tailwind, built from bulk-versioning/src).
  $("tileBulkVersioning").onclick = () => { window.location.href = "bulk-versioning.html" }

  // Classifications tool controls
  $("reloadBtn").onclick = () => load()
  $("searchBox").oninput = (e) => { searchText = e.target.value; renderTree() }
  $("selectAllBtn").onclick = () => { checked = new Set(flatItems.map((f) => f.id)); renderTree(); updateSelCount() }
  $("deselectAllBtn").onclick = () => { checked = new Set(); renderTree(); updateSelCount() }
  $("langAll").onclick = () => { selectedLangs = new Set(languages.map((l) => l.id)); renderLangPills() }
  $("langNone").onclick = () => { selectedLangs = new Set(); renderLangPills() }
  $("exportBtn").onclick = () => doExport()
}

init()
