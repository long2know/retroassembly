import type { PlatformName } from '#@/constants/platform.ts'
import type { romTable } from '#@/databases/schema.ts'

export interface MountedBios {
  fileId: string
  fileName: string
  mounted: true
}

export interface MountedScanStatus {
  biosCount: number
  error?: string
  indexed: number
  lastScanFinishedAt?: string
  lastScanStartedAt?: string
  lastSuccessfulScanAt?: string
  running: boolean
  unavailable: number
  unsupported: number
  warnings: string[]
}

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
