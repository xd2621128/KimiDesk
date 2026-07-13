export {}

declare global {
  interface Window {
    electronAPI?: {
      getAppVersion: () => Promise<string>
      onKimiWebError: (callback: (message: string) => void) => void
    }
  }
}
