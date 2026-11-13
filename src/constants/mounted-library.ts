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

export interface MountedSource {
  available: boolean
  metadata: 'disabled' | 'pending' | 'ready' | 'error' | 'manual'
  metadataError?: string
  metadataAttemptedAt?: number
  metadataOutcome?: 'matched' | 'no-match' | 'error'
  artwork?: 'disabled' | 'pending' | 'ready' | 'missing' | 'error' | 'manual'
  artworkError?: string
  artworkAttemptedAt?: number
  identification?: MountedIdentification
  path: string
  revision: string
  unsupportedReason?: string
}

export const mountedFilePrefix = 'mounted/'

export function isMountedFileId(id: string) {
  return id.startsWith(mountedFilePrefix)
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

const knownRomExtensions = new Set([
  ...Object.values(platformMap).flatMap((platform) => platform.fileExtensions),
  '.7z',
  '.rar',
  '.img',
  '.rom',
  '.smd',
  '.v64',
])

export function getMountedFormat(platform: PlatformName, extension: string) {
  if (platformMap[platform].fileExtensions.includes(extension.toLowerCase())) {
    return { supported: true }
  }
  if (['.cue', '.m3u', '.m3u8', '.iso', '.ccd', '.gdi', '.pbp'].includes(extension.toLowerCase())) {
    return {
      supported: false,
      unsupportedReason:
        'This mounted disc/playlist format is not supported by this browser integration. CUE/M3U dependencies are not loaded. PlayStation currently requires a standalone CHD. No source conversion is performed.',
    }
  }
  if (knownRomExtensions.has(extension.toLowerCase())) {
    return {
      supported: false,
      unsupportedReason: `The ${extension} format is not supported for ${platform} by this browser integration. The source is indexed without conversion and cannot be launched.`,
    }
  }
}
