import { createContext, useContext, useMemo, type ReactNode } from "react"
import { createClient } from "aprimo-js"

// Stand-in for the web app's Aprimo context. The Electron main process owns
// sign-in, token storage, and refresh (electron/auth.js); the renderer asks it
// for an access token through the preload bridge before every request.

declare global {
  interface Window {
    aprimoAuth: {
      restore: () => Promise<unknown>
      session: () => Promise<{ environment: string; signedIn: boolean; hasRefreshToken: boolean; expiresAt: number } | null>
      signOut: () => Promise<boolean>
      getAccessToken: () => Promise<string>
      redirectUri: () => Promise<string>
    }
  }
}

type AprimoClient = ReturnType<typeof createClient>

interface AprimoContextValue {
  client: AprimoClient | null
  isConnected: boolean
  connection: { environment: string } | null
}

const Ctx = createContext<AprimoContextValue>({ client: null, isConnected: false, connection: null })

/** Sends the user back to the home screen, which shows the sign-in form when needed. */
export function goHome() {
  window.location.href = "index.html"
}

export function AprimoProvider({ environment, children }: { environment: string; children: ReactNode }) {
  const value = useMemo<AprimoContextValue>(() => {
    const client = createClient({
      type: "custom",
      environment,
      tokenProvider: async () => {
        try {
          return await window.aprimoAuth.getAccessToken()
        } catch (e) {
          // No refresh token and the access token expired: sign in again from home.
          if (String((e as Error)?.message).includes("NEEDS_LOGIN")) goHome()
          throw e
        }
      },
    })
    return { client, isConnected: true, connection: { environment } }
  }, [environment])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAprimo() {
  return useContext(Ctx)
}
