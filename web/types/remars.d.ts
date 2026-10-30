export {}

declare global {
  interface Window {
    remars?: {
      command: (action: string, payload?: Record<string, unknown>) => Promise<any>
      onEvent: (listener: (event: Record<string, any>) => void) => () => void
      openFile: () => Promise<{ path: string; name: string; contents: string } | null>
      saveFile: (payload: { path?: string; name: string; contents: string }) => Promise<{ path: string; name: string } | null>
    }
  }
}
