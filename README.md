# Aprimo Admin Tools

A standalone desktop app (Electron) with tools for Aprimo administrators. Sign in once with your Aprimo credentials and access all tools from a single home screen.

> **This is a sample tool.** Embedding a client secret in a desktop application is acceptable for internal use by a small number of trusted admins, but a server-side token broker is recommended for broader distribution.

## Tools

### Classifications Exporter
Export your classification tree to Excel. For every selected node: hierarchy path, ID, system name, localized names for the languages you pick, parent info, and an optional record count. Downloads as `classifications.xlsx`.

### Data Model Explorer
Select any field definition to see a visual graph of everywhere it is used — field groups, content types, classifications, cross-field expression references, and rules.

### Bulk Versioning
Pick classifications from the tree (a parent includes all of its children), then drop updated files or a whole folder. Each local file is matched by name to the record whose master file has the same or a similar name, ignoring revision markers like `_v2` or `final`, sizes like `10x10`, and counters like `(002)`. Matches are colour-coded by confidence and can be filtered; records can also be picked manually. Hovering a row compares the current version in Aprimo with the proposed file. Version one row at a time, or everything in the current filter. Each file is uploaded and added as a new version of the record's master file; nothing is created or deleted.

This tool is the desktop build of the Bulk Versioning page in [virani-editor-tools](https://github.com/ViraniAJ/aprimo-editor-tools). Its source lives in `bulk-versioning/src` (React + Tailwind, bundled by esbuild into `renderer/bulk-versioning.js` and `.css`) and runs as its own page so its styles never touch the other tools. The matching logic in `bulk-versioning/src/lib` is shared with the web version; keep the two in step when changing it.

## How auth works

Sign-in uses the OAuth 2.0 **Authorization Code + PKCE** flow with a **loopback redirect** (RFC 8252 — the pattern recommended for native apps):

1. Enter your Aprimo **environment**, **client ID**, and **client secret** once.
2. The app opens your **system browser** to Aprimo's sign-in page — SSO, MFA, and password managers all work normally.
3. After sign-in, Aprimo redirects to `http://127.0.0.1:3002/callback`, which a local listener inside the app catches.
4. The app exchanges the code for tokens directly against Aprimo and stores them encrypted using your **OS keychain key** (via Electron `safeStorage`) — never in plaintext, never in the shipped binary.

Tokens are refreshed automatically if your registration issues refresh tokens (the app requests `offline_access` and auto-detects). Otherwise the browser sign-in re-opens when the access token expires.

### One-time Aprimo setup

In Aprimo, go to **Settings → Registrations** and create (or edit) a registration:

- **Grant type:** Authorization Code with PKCE
- **Redirect URI:** `http://127.0.0.1:3002/callback` (this exact string)

Note the **Client ID** and **Client Secret** — you'll enter them in the app on first launch.

### SSO users

Because sign-in happens in the system browser, SSO and MFA work automatically — Aprimo redirects to your identity provider (Okta, Azure AD, Ping, etc.) and the app only receives the resulting code.

Two things to verify on the Aprimo side:

- The redirect URI (`http://127.0.0.1:3002/callback`) must be registered on the same PKCE registration your SSO users authenticate through.
- The client secret is still required for SSO users. The secret authenticates the *app* to Aprimo at the token-exchange step; SSO authenticates the *person*. They are separate concerns.

### Security note

Your Client ID and Secret are encrypted using your OS keychain key and stored locally on this machine. They are sent only to Aprimo over HTTPS during the OAuth token exchange — never transmitted anywhere else by the application.

To keep deployment simple for this sample tool, the client secret is stored locally on each machine rather than behind a server-side token broker. Because the tool uses PKCE with the signed-in user's credentials, it inherits that user's full Aprimo permissions — there is no way to restrict scope at the registration level. For a production build, consider rethinking the auth model: a dedicated service account with read-only permissions, or a server-side token broker that authenticates with a least-privilege identity.

## Run locally

```bash
npm install
npm start        # bundles the renderer and Bulk Versioning, then launches the app
```

## Build a distributable

```bash
npm run build          # current OS
npm run build:win      # Windows (NSIS installer)
npm run build:mac      # macOS (.dmg)
npm run build:linux    # Linux (AppImage)
```

Output lands in `dist/`. GitHub Actions builds all three platforms automatically — see `.github/workflows/build.yml`. Push a `v*` tag to create a GitHub Release with installers attached.

## Project layout

```
electron/
  auth.js       PKCE flow, loopback listener, token exchange, refresh, keychain storage
  main.js       Window creation and IPC wiring
  preload.js    Secure IPC bridge to the renderer
renderer/
  app.js        Main renderer entry point, classifications exporter logic
  data-model.js Data model explorer logic (Cytoscape graph)
  index.html    UI shell and styles
  bulk-versioning.html  Bulk Versioning page (loads the built .js and .css)
bulk-versioning/
  src/          Bulk Versioning source: page, matching logic, UI components
build/
  icon.png      App icon (source; electron-builder converts per platform)
.github/
  workflows/
    build.yml   CI — builds and releases on all platforms
```
