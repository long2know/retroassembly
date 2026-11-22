import { isPlatformName, platformMap, type PlatformName } from './platform.ts'

export interface MountedLibrarySettings {
  automaticMetadata: boolean
  scanIntervalSeconds: number
}

export interface MountedIdentification {
  version: 1
  revision: string
  mode: 'file' | 'zip-entry' | 'arcade-set' | 'name-only' | 'ambiguous'
  name: string
  md5?: string
  payloadName?: string
  bytes?: number
  hashedAt?: number
  confidence?: 'content' | 'filename'
  error?: string
}

export interface MountedMetadataProgress {
  running: boolean
  operation?: 'metadata' | 'artwork'
  processed: number
  total: number
  errors: number
  lastStartedAt?: string
  lastFinishedAt?: string
  error?: string
}

export interface MountedLibraryStatus {
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
  settings: MountedLibrarySettings
  networkAllowed: boolean
  automaticMetadataEnabled: boolean
  platforms: { platform: PlatformName; indexed: number; unsupported: number }[]
  metadata: MountedMetadataProgress
}

export interface MountedMediaFile {
  path: string
  revision: string
}

export interface MountedPlaylist {
  discs: MountedMediaFile[]
  revision: string
}

export interface MountedPlaylistState {
  disc: number
  revision: string
}

export interface MountedPlaylistIssue {
  code: 'Duplicate' | 'Encoding' | 'Format' | 'Missing' | 'Path' | 'TooFew' | 'TooLarge' | 'TooMany'
  line?: number
}

export interface MountedPbpEndPatch {
  offset: number
  end: number
}

export const mountedMetadataFields = [
  'gameDescription',
  'gameDeveloper',
  'gameGenres',
  'gameName',
  'gamePlayers',
  'gamePublisher',
  'gameReleaseDate',
] as const

export type MountedMetadataField = (typeof mountedMetadataFields)[number]

export interface MountedMatchCandidate {
  id: string
  name: string
  region?: string
  revision?: string
  shortName?: string
  year?: number
}

export const mountedMatchIntents = ['match', 'cover'] as const
export type MountedMatchIntent = (typeof mountedMatchIntents)[number]

export type MountedArtworkOutcome = 'ready' | 'missing' | 'error' | 'manual' | 'no-title'

export interface MountedSource extends MountedMediaFile {
  available: boolean
  metadata: 'disabled' | 'pending' | 'ready' | 'error' | 'manual'
  metadataError?: string
  metadataAttemptedAt?: number
  metadataOutcome?: 'matched' | 'no-match' | 'error'
  artwork?: 'disabled' | 'pending' | 'ready' | 'missing' | 'error' | 'manual'
  artworkError?: string
  artworkAttemptedAt?: number
  artworkMatch?: { name: string; shortName?: string }
  artworkTarget?: string
  catalogMatch?: { id: string; name: string; shortName?: string }
  manualMetadataFields?: MountedMetadataField[]
  identification?: MountedIdentification
  pbpEndPatch?: MountedPbpEndPatch
  playlist?: MountedPlaylist
  playlistIssue?: MountedPlaylistIssue
  unsupportedReason?: string
}

export function getMountedManualMetadataFields(source: MountedSource) {
  return source.manualMetadataFields ?? (source.metadata === 'manual' ? mountedMetadataFields : [])
}

export const mountedFilePrefix = 'mounted/'
export const mountedPlaylistMaxBytes = 64 * 1024
export const mountedPlaylistMaxDiscs = 8
export const mountedRevisionPattern = /^[a-f0-9]{64}$/u

export function isMountedFileId(id: string) {
  return id.startsWith(mountedFilePrefix)
}

export function isCompatiblePlaylistState(playlist?: MountedPlaylist, state?: MountedPlaylistState | null) {
  if (!playlist) {
    return !state
  }
  if (!state) {
    return false
  }
  return (
    state.revision === playlist.revision &&
    Number.isInteger(state.disc) &&
    state.disc >= 1 &&
    state.disc <= playlist.discs.length
  )
}

const systemAliases: Record<string, PlatformName> = {
  coleco: 'colecovision',
  famicom: 'nes',
  fbneo: 'arcade',
  gameboy: 'gb',
  gameboyadvance: 'gba',
  gameboycolor: 'gbc',
  genesis: 'genesis',
  lynx: 'atarilynx',
  mame: 'arcade',
  mame2003: 'arcade',
  'mame2003-plus': 'arcade',
  mastersystem: 'sms',
  md: 'genesis',
  megadrive: 'genesis',
  neogeo: 'arcade',
  pcenginecd: 'pcengine',
  ps1: 'psx',
  sfc: 'snes',
  sg1000: 'sg-1000',
  supergrafx: 'pcengine',
  tg16: 'pcengine',
  virtualboy: 'vb',
  ws: 'wonderswan',
  wsc: 'wonderswancolor',
}

export function resolveMountedPlatform(directory: string) {
  const name = directory.toLowerCase()
  if (Object.hasOwn(systemAliases, name)) {
    return systemAliases[name]
  }
  return isPlatformName(name) ? name : undefined
}

export function hasMountedCatalogScope(platform: PlatformName, sourcePath: string) {
  const system = sourcePath.split('/', 1)[0].toLowerCase()
  return platform !== 'pcengine' || (system !== 'pcenginecd' && system !== 'supergrafx')
}

const knownRomExtensions = new Set([
  ...Object.values(platformMap).flatMap((platform) => platform.fileExtensions),
  '.7z',
  '.rar',
  '.img',
  '.rom',
  '.smd',
  '.v64',
])

export function isMountedPsxPbp(platform: PlatformName, extension: string) {
  return platform === 'psx' && extension.toLowerCase() === '.pbp'
}

export function getMountedFormat(platform: PlatformName, extension: string) {
  const ext = extension.toLowerCase()
  if (
    platformMap[platform].fileExtensions.includes(ext) ||
    (platform === 'psx' && ext === '.m3u') ||
    isMountedPsxPbp(platform, ext)
  ) {
    return { supported: true }
  }
  if (['.cue', '.m3u', '.m3u8', '.iso', '.ccd', '.gdi', '.pbp'].includes(ext)) {
    return {
      supported: false,
      unsupportedReason:
        'This mounted disc/playlist format is not supported. PlayStation mounts accept standalone CHD, compatible single-disc PBP, or M3U listing only CHDs. No source conversion is performed.',
    }
  }
  if (knownRomExtensions.has(extension.toLowerCase())) {
    return {
      supported: false,
      unsupportedReason: `The ${extension} format is not supported for ${platform} by this browser integration. The source is indexed without conversion and cannot be launched.`,
    }
  }
}
