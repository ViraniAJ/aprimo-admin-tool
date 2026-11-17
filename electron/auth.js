// Auth module — runs in Electron's MAIN process.
//
// Implements the OAuth 2.0 Authorization Code + PKCE flow for a desktop app
// using a loopback redirect (RFC 8252). The system browser handles login, a
// tiny localhost HTTP server catches the redirect, and the code is exchanged
// for tokens directly against Aprimo's token endpoint — no app server needed.
//
// Design decisions baked in here (from the planning conversation):
//   • Loopback listener on a FIXED port (3002) so the redirect URI is stable
//     and can be registered once in Aprimo.
//   • Confidential client: the token exchange sends client_secret. Aprimo
//     requires a confidential client (there is no public/PKCE-without-secret
//     option), and this tool talks only to Aprimo — no intermediate server. The
//     secret is entered at runtime and stored in the OS keychain (safeStorage),
//     never hardcoded in the shipped binary, and sent only over TLS.
//   • Refresh tokens are AUTO-DETECTED: we request `offline_access`; if the
//     token response includes a refresh_token we refresh silently, otherwise we
//     re-launch the browser login when the access token expires.

const http = require("http")
const crypto = require("crypto")
const { shell, safeStorage, net } = require("electron")
const fs = require("fs")
const path = require("path")
const os = require("os")

// ── Fixed loopback config ─────────────────────────────────────────────
const PORT = 3002
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`
// The exact string above MUST be registered as a Redirect URI in the Aprimo
// PKCE registration, or the authorize step will reject the request.

const SCOPE = "api offline_access"

// ── Token persistence (OS keychain via safeStorage) ───────────────────
// safeStorage encrypts with an OS-provided key (Keychain / DPAPI / libsecret).
// We persist the encrypted blob to a file in userData; only this machine/user
// can decrypt it. Credentials (env/clientId/secret) live alongside the tokens.

let tokenFilePath = null
function initStorage(userDataDir) {
  tokenFilePath = path.join(userDataDir, "aprimo-auth.bin")
}

function saveState(state) {
  if (!tokenFilePath) throw new Error("Storage not initialized")
  const json = JSON.stringify(state)
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(tokenFilePath, safeStorage.encryptString(json))
  } else {
    // Fallback: plaintext (only if the OS keychain is unavailable). Warn loudly.
    console.warn("[auth] safeStorage unavailable — storing credentials unencrypted.")
    fs.writeFileSync(tokenFilePath, json, "utf8")
  }
}

function loadState() {
  if (!tokenFilePath || !fs.existsSync(tokenFilePath)) return null
  try {
    const buf = fs.readFileSync(tokenFilePath)
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buf)
      : buf.toString("utf8")
    return JSON.parse(json)
  } catch (e) {
    console.error("[auth] Failed to read stored auth:", e)
    return null
  }
}

function clearState() {
  if (tokenFilePath && fs.existsSync(tokenFilePath)) fs.unlinkSync(tokenFilePath)
  current = null
}

// ── In-memory current session ─────────────────────────────────────────
// Shape: { environment, clientId, clientSecret,
//          accessToken, refreshToken, expiresAt }
let current = null

// ── PKCE helpers ──────────────────────────────────────────────────────
function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
function generatePkce() {
  const codeVerifier = base64url(crypto.randomBytes(32))
  const codeChallenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest())
  return { codeVerifier, codeChallenge }
}

// ── Token endpoint calls ──────────────────────────────────────────────
function tokenUrl(environment) {
  return `https://${environment}.aprimo.com/login/connect/token`
}
function authorizeUrl(environment, clientId, codeChallenge, state) {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  })
  return `https://${environment}.aprimo.com/login/connect/authorize?${p.toString()}`
}

async function postToken(environment, body) {
  // Primary: Node's fetch, which is what every release up to 1.1.7 used and
  // which Aprimo's token endpoint parses reliably. Fallback: Electron's
  // net.fetch (Chromium stack, honours the system proxy and OS trust store)
  // for machines where Node cannot reach the host at all. 1.1.8 used
  // net.fetch first and Aprimo answered invalid_client for valid secrets,
  // so the Chromium path is only tried after a network-level failure, with
  // an explicit Content-Length so the form body is never sent chunked.
  const url = tokenUrl(environment)
  const form = new URLSearchParams(body).toString()
  const isNetworkError = (e) => /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network|socket|certificate|ERR_/i.test(String(e?.message) + " " + String(e?.cause?.code ?? e?.cause?.message ?? ""))
  const readResponse = async (res) => {
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error_description || data.error || `Token request failed (${res.status})`)
    return data
  }
  let lastErr
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form })
      return await readResponse(res)
    } catch (e) {
      lastErr = e
      if (!isNetworkError(e)) throw e
      if (attempt === 1) await new Promise((r) => setTimeout(r, 1200))
    }
  }
  try {
    const buf = Buffer.from(form, "utf8")
    const res = await net.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(buf.length) },
      body: buf,
    })
    return await readResponse(res)
  } catch (e) {
    if (!isNetworkError(e)) throw e
    lastErr = e
  }
  const cause = lastErr?.cause?.code || lastErr?.cause?.message
  throw new Error(`Could not reach ${new URL(url).host}${cause ? ` (${cause})` : ""}. Check your network, VPN or proxy and try again.`)
}

function applyTokenResponse(data) {
  current.accessToken = data.access_token
  current.refreshToken = data.refresh_token ?? current.refreshToken ?? null
  current.expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000
  // Persist everything needed to refresh or reconnect later.
  saveState(current)
}

// ── Public: interactive login via the system browser ──────────────────
// Resolves once the loopback listener has captured the code and the token
// exchange has succeeded.
function login({ environment, clientId, clientSecret }) {
  return new Promise((resolve, reject) => {
    const { codeVerifier, codeChallenge } = generatePkce()
    const state = base64url(crypto.randomBytes(16))
    current = { environment, clientId, clientSecret, accessToken: null, refreshToken: null, expiresAt: 0 }

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, REDIRECT_URI)
        if (url.pathname !== "/callback") { res.writeHead(404); res.end(); return }

        const err = url.searchParams.get("error")
        const code = url.searchParams.get("code")
        const returnedState = url.searchParams.get("state")

        // Always show the user a friendly page, then shut the listener.
        const done = (msg) => {
          res.writeHead(200, { "Content-Type": "text/html" })
          res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:3rem;text-align:center"><h2>${msg}</h2><p>You can close this tab and return to the app.</p></body>`)
          server.close()
        }

        if (err) { done("Sign-in was cancelled."); return reject(new Error(err)) }
        if (returnedState !== state) { done("Sign-in failed (state mismatch)."); return reject(new Error("state mismatch")) }
        if (!code) { done("Sign-in failed (no code)."); return reject(new Error("no authorization code")) }

        const data = await postToken(environment, {
          grant_type: "authorization_code",
          client_id: clientId,
          client_secret: clientSecret,
          code,
          code_verifier: codeVerifier,
          redirect_uri: REDIRECT_URI,
        })
        applyTokenResponse(data)
        done("Signed in successfully.")
        resolve({ hasRefreshToken: !!current.refreshToken })
      } catch (e) {
        // Show the real reason in the browser tab; the app shows it too.
        const msg = String(e?.message ?? e)
        const hint = /invalid_client/i.test(msg)
          ? "Aprimo rejected the client id and secret. Check the Client Secret against the registration, and that the registration is a confidential 'Authorization Code with PKCE' client."
          : /invalid_grant/i.test(msg)
            ? "The sign-in code was already used or has expired. Go back to the app and click Sign in again."
            : "Go back to the app, check the details, and click Sign in again."
        const esc = (t) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])
        try {
          res.writeHead(500, { "Content-Type": "text/html" })
          res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:3rem;max-width:40rem;margin:auto"><h2>Sign-in did not complete</h2><p><code>${esc(msg)}</code></p><p>${esc(hint)}</p><p>You can close this tab.</p></body>`)
        } catch {}
        server.close()
        reject(e)
      }
    })

    server.on("error", (e) => {
      if (e.code === "EADDRINUSE") {
        reject(new Error(`Port ${PORT} is already in use. Close whatever is using it and try again.`))
      } else reject(e)
    })

    server.listen(PORT, "127.0.0.1", () => {
      shell.openExternal(authorizeUrl(environment, clientId, codeChallenge, state))
    })
  })
}

// ── Public: silent refresh (only works if we got a refresh token) ─────
async function refresh() {
  if (!current?.refreshToken) throw new Error("No refresh token available")
  const data = await postToken(current.environment, {
    grant_type: "refresh_token",
    client_id: current.clientId,
    client_secret: current.clientSecret,
    refresh_token: current.refreshToken,
  })
  applyTokenResponse(data)
}

// ── Public: the tokenProvider handed to aprimo-js ─────────────────────
// Returns a valid access token, refreshing when near expiry. When no refresh
// token exists and the token has expired, it throws NEEDS_LOGIN so the UI can
// re-trigger the browser flow.
async function getAccessToken() {
  if (!current?.accessToken) throw new Error("NEEDS_LOGIN")
  const soon = Date.now() > current.expiresAt - 60_000 // 60s skew
  if (soon) {
    if (current.refreshToken) {
      await refresh()
    } else {
      throw new Error("NEEDS_LOGIN")
    }
  }
  return current.accessToken
}

// ── Public: restore a prior session on app start ──────────────────────
function restore() {
  const s = loadState()
  if (!s) return null
  current = s
  return {
    environment: s.environment,
    clientId: s.clientId,
    hasCredentials: !!s.clientSecret,
    signedIn: !!s.accessToken,
    hasRefreshToken: !!s.refreshToken,
  }
}

function getSessionInfo() {
  if (!current) return null
  return {
    environment: current.environment,
    signedIn: !!current.accessToken,
    hasRefreshToken: !!current.refreshToken,
    expiresAt: current.expiresAt,
  }
}

module.exports = {
  REDIRECT_URI,
  PORT,
  initStorage,
  login,
  refresh,
  getAccessToken,
  restore,
  getSessionInfo,
  clearState,
  // expose for the renderer's client construction
  getEnvironment: () => current?.environment ?? null,
}
