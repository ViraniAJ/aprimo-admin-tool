const { app, BrowserWindow, ipcMain, shell } = require("electron")
const path = require("path")
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
