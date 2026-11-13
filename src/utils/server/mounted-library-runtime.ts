import type { MountedLibrarySettings, MountedLibraryStatus } from '#@/constants/mounted-library.ts'
import type { PlatformName } from '#@/constants/platform.ts'
import type { romTable } from '#@/databases/schema.ts'

export interface MountedBios {
  fileId: string
  fileName: string
  mounted: true
}

export type MountedScanStatus = MountedLibraryStatus

export interface MountedMetadataMatch {
  launchboxId?: number
  libretroId?: string
  name?: string
}

interface MountedLibraryRuntime {
  assertWritableDirectory: (directory: string) => Promise<void>
  enrichPending: () => Promise<void>
  getBioses: (platform: PlatformName) => MountedBios[]
  getStatus: () => MountedScanStatus
  identify: (rom: typeof romTable.$inferSelect, match: MountedMetadataMatch) => Promise<typeof romTable.$inferSelect>
  refreshMetadata: (options?: { platform?: PlatformName; retryArtwork?: boolean }) => MountedLibraryStatus
  retryArtwork: (options?: { platform?: PlatformName }) => MountedLibraryStatus
  updateSettings: (settings: Partial<MountedLibrarySettings>) => MountedLibraryStatus
  readFile: (id: string) => Promise<{ body: ReadableStream; httpEtag: string; size: number }>
  scan: () => Promise<MountedScanStatus>
  scheduleEnrichment: () => void
  stop: () => void
}

let mountedLibrary: MountedLibraryRuntime | undefined

export function getMountedLibrary() {
  return mountedLibrary
}

export function setMountedLibrary(library: MountedLibraryRuntime | undefined) {
  mountedLibrary?.stop()
  mountedLibrary = library
}
