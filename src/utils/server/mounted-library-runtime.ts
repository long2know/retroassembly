import { HTTPException } from 'hono/http-exception'
import type {
  MountedArtworkOutcome,
  MountedLibrarySettings,
  MountedLibraryStatus,
  MountedMatchCandidate,
} from '#@/constants/mounted-library.ts'
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

export interface MountedMatchSelection {
  candidateId: string
  snapshot: string
}

const repairErrors = {
  'catalog-provider': { message: 'The game catalog is temporarily unavailable', status: 502 },
  'catalog-unsupported': { message: 'No matching catalog is available for this mounted system', status: 422 },
  'invalid-candidate': { message: 'That game is not in this platform catalog', status: 409 },
  'metadata-policy': { message: 'Mounted metadata network access is disabled by server policy', status: 403 },
  'metadata-stale': { message: 'The game changed; reload or search again. The newer edit was preserved', status: 409 },
  'source-unavailable': { message: 'Mounted source is unavailable or unsafe; rescan required', status: 503 },
} as const

export class MountedRepairError extends HTTPException {
  readonly code: keyof typeof repairErrors

  constructor(code: keyof typeof repairErrors, cause?: unknown) {
    const { message, status } = repairErrors[code]
    super(status, { cause, message })
    this.code = code
  }
}

type MountedRom = typeof romTable.$inferSelect
interface MountedArtworkResult {
  artwork: MountedArtworkOutcome
}

interface HiddenMountedGame {
  available: boolean
  fileName: string
  gameName: string | null
  id: string
  platform: PlatformName
}

export interface PlaylistDiscRequest {
  id: string
  index: number
  revision: string
}

interface MountedLibraryRuntime {
  applyMatch: (rom: MountedRom, selection: MountedMatchSelection) => Promise<MountedArtworkResult>
  assertPlaylistDiscCurrent: (id: string, revision: string, index: number) => Promise<void>
  assertWritableDirectory: (directory: string) => Promise<void>
  enrichPending: () => Promise<void>
  getBioses: (platform: PlatformName) => MountedBios[]
  getStatus: () => MountedScanStatus
  identify: (rom: typeof romTable.$inferSelect, match: MountedMetadataMatch) => Promise<typeof romTable.$inferSelect>
  listHiddenGames: () => HiddenMountedGame[]
  refreshMetadata: (options?: { platform?: PlatformName; retryArtwork?: boolean }) => MountedLibraryStatus
  restoreHiddenGame: (id: string) => Promise<{ id: string }>
  retryArtwork: (options?: { platform?: PlatformName }) => MountedLibraryStatus
  retryGameArtwork: (rom: MountedRom) => Promise<MountedArtworkResult>
  searchMatches: (rom: MountedRom, query: string) => Promise<{ candidates: MountedMatchCandidate[]; snapshot: string }>
  updateSettings: (settings: Partial<MountedLibrarySettings>) => MountedLibraryStatus
  readFile: (id: string, signal?: AbortSignal) => Promise<{ body: ReadableStream; httpEtag: string; size: number }>
  readPlaylistDisc: (
    disc: PlaylistDiscRequest,
    signal?: AbortSignal,
  ) => Promise<{ body: ReadableStream; httpEtag: string; size: number }>
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
