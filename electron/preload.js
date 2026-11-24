const { contextBridge, ipcRenderer } = require("electron")

// Minimal, explicit surface. The renderer never touches Node or tokens
// directly — it asks the main process for an access token when the SDK needs
// one, and the main process owns all secret material.
contextBridge.exposeInMainWorld("aprimoAuth", {
  restore: () => ipcRenderer.invoke("auth:restore"),
  login: (creds) => ipcRenderer.invoke("auth:login", creds),
  session: () => ipcRenderer.invoke("auth:session"),
  signOut: () => ipcRenderer.invoke("auth:signout"),
  getAccessToken: () => ipcRenderer.invoke("auth:getAccessToken"),
  redirectUri: () => ipcRenderer.invoke("auth:redirectUri"),
})

// Metadata Export writes its CSV through the main process, only to files the
// user picked in a Save dialog.
contextBridge.exposeInMainWorld("exportFiles", {
  choose: (defaultName) => ipcRenderer.invoke("export:choose", defaultName),
  open: (path, resumeAt) => ipcRenderer.invoke("export:open", { path, resumeAt }),
  write: (id, text) => ipcRenderer.invoke("export:write", { id, text }),
  close: (id) => ipcRenderer.invoke("export:close", id),
  reveal: (path) => ipcRenderer.invoke("export:reveal", path),
})
