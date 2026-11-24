const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron")
const path = require("path")
const fs = require("fs")
const auth = require("./auth")

let win = null

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 820,
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"))

  // Links that open a new window (e.g. "Open in Aprimo") go to the system
  // browser instead of a bare Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url)
    return { action: "deny" }
  })
  // The app only ever navigates between its own pages; anything else (such
  // as a file dropped outside a drop zone) is blocked.
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file:") || !/\.html(\?|#|$)/.test(url)) event.preventDefault()
  })
}

app.whenReady().then(() => {
  auth.initStorage(app.getPath("userData"))
  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

// ── IPC surface (called from the renderer via the preload bridge) ─────

ipcMain.handle("auth:restore", () => auth.restore())

ipcMain.handle("auth:login", async (_e, creds) => {
  return auth.login(creds)
})

ipcMain.handle("auth:session", () => auth.getSessionInfo())

ipcMain.handle("auth:signout", () => { auth.clearState(); return true })

// The renderer's aprimo-js client calls this through its tokenProvider before
// every request. Returns a fresh access token or throws NEEDS_LOGIN.
ipcMain.handle("auth:getAccessToken", async () => {
  return auth.getAccessToken()
})

ipcMain.handle("auth:redirectUri", () => auth.REDIRECT_URI)

// ── Export files (Metadata Export) ────────────────────────────────────
// The renderer streams CSV text here page by page. It can only write to files
// the user picked in a Save dialog (and that file's -partN siblings), which are
// remembered so an interrupted export can be resumed after a restart.

const openFiles = new Map() // id -> { handle, path, bytes }
let nextFileId = 1
const allowListFile = () => path.join(app.getPath("userData"), "export-paths.json")
function allowed() {
  try { return JSON.parse(fs.readFileSync(allowListFile(), "utf8")) } catch { return [] }
}
function allow(p) {
  const list = [p, ...allowed().filter((x) => x !== p)].slice(0, 50)
  fs.writeFileSync(allowListFile(), JSON.stringify(list))
}
const basePath = (p) => p.replace(/-part\d+(\.csv)$/i, "$1")
function assertAllowed(p) {
  if (typeof p !== "string" || !/\.csv$/i.test(p) || !allowed().includes(basePath(p))) throw new Error("That file was not chosen in a Save dialog")
}

ipcMain.handle("export:choose", async (_e, defaultName) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath("downloads"), String(defaultName || "aprimo-export.csv")),
    filters: [{ name: "CSV", extensions: ["csv"] }],
  })
  if (r.canceled || !r.filePath) return null
  const p = /\.csv$/i.test(r.filePath) ? r.filePath : `${r.filePath}.csv`
  allow(p)
  return p
})

// Opens for writing. Without `resumeAt` the file is created or emptied; with it,
// the file is cut back to that many bytes (dropping a page written after the
// last checkpoint) and appended to.
ipcMain.handle("export:open", async (_e, { path: p, resumeAt }) => {
  assertAllowed(p)
  let bytes = 0
  if (resumeAt != null && fs.existsSync(p)) {
    await fs.promises.truncate(p, Math.min(resumeAt, fs.statSync(p).size))
    bytes = fs.statSync(p).size
  }
  const handle = await fs.promises.open(p, resumeAt != null ? "a" : "w")
  const id = nextFileId++
  openFiles.set(id, { handle, path: p, bytes })
  return { id, bytes }
})

ipcMain.handle("export:write", async (_e, { id, text }) => {
  const f = openFiles.get(id)
  if (!f) throw new Error("Export file is not open")
  const buf = Buffer.from(String(text), "utf8")
  await f.handle.write(buf)
  f.bytes += buf.length
  return f.bytes
})

ipcMain.handle("export:close", async (_e, id) => {
  const f = openFiles.get(id)
  if (!f) return true
  openFiles.delete(id)
  await f.handle.sync().catch(() => {})
  await f.handle.close()
  return true
})

ipcMain.handle("export:reveal", (_e, p) => { assertAllowed(p); shell.showItemInFolder(p); return true })
