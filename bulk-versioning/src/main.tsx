import { createRoot } from "react-dom/client"
import { Toaster } from "sonner"
import { ArrowLeft, LogOut } from "lucide-react"
import { AprimoProvider, goHome } from "@/aprimo"
import { BulkTool, type ToolMode } from "@/bulk-tool"

// Entry point for renderer/bulk-versioning.html, which serves both Bulk
// Versioning and (with ?mode=preview) Bulk Previews. Runs as its own page so
// its Tailwind styles never touch the other tools in index.html.

const MODE: ToolMode = new URLSearchParams(window.location.search).get("mode") === "preview" ? "preview" : "version"
const TITLE = MODE === "preview" ? "Bulk Previews" : "Bulk Versioning"

function followSystemTheme() {
  const mq = window.matchMedia("(prefers-color-scheme: dark)")
  const apply = () => document.documentElement.classList.toggle("dark", mq.matches)
  apply()
  mq.addEventListener("change", apply)
}

function Header({ environment, autoRefresh }: { environment: string; autoRefresh: boolean }) {
  return (
    <header className="sticky top-0 z-40 flex items-center justify-between gap-4 border-b border-border bg-background/95 backdrop-blur px-5 py-3">
      <div className="flex items-center gap-3">
        <button onClick={goHome} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm hover:bg-muted transition-colors">
          <ArrowLeft className="h-3.5 w-3.5" /> Home
        </button>
        <h1 className="text-base font-bold">{TITLE}</h1>
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>{environment}{autoRefresh ? " · auto-refresh" : ""}</span>
        <button
          onClick={async () => {
            await window.aprimoAuth.signOut()
            goHome()
          }}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm text-foreground hover:bg-muted transition-colors"
        >
          <LogOut className="h-3.5 w-3.5" /> Sign out
        </button>
      </div>
    </header>
  )
}

async function boot() {
  document.title = `${TITLE} · Aprimo Admin Tools`
  followSystemTheme()
  // A file dropped outside the drop zone would otherwise replace the page.
  window.addEventListener("dragover", (e) => e.preventDefault())
  window.addEventListener("drop", (e) => e.preventDefault())
  const session = await window.aprimoAuth.session()
  if (!session?.signedIn || !session.environment) return goHome()
  createRoot(document.getElementById("root")!).render(
    <AprimoProvider environment={session.environment}>
      <Header environment={session.environment} autoRefresh={session.hasRefreshToken} />
      <BulkTool mode={MODE} />
      <Toaster richColors position="bottom-right" theme="system" />
    </AprimoProvider>,
  )
}

boot()
