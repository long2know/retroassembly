import { createHash, randomUUID } from 'node:crypto'
import { open, rm } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { getDirectories } from '#@/constants/env.ts'
import type { MountedMatchCandidate } from '#@/constants/mounted-library.ts'
import { platformMap, type PlatformName } from '#@/constants/platform.ts'
import { getMountedLibrary, MountedRepairError } from './mounted-library-runtime.ts'
import { assertMountedMetadataNetworkAllowed, readMountedProviderBytes } from './mounted-provider.ts'

const revision = '90601bff67dba7057381292f17e08ed2cecbd6dc'
const maxCatalogSize = 10 * 1024 * 1024
const maxCachedCatalogs = 3
const maxCatalogLoads = 2
const maxResults = 12

const editionDetail = z
  .unknown()
  .optional()
  .transform((value) => (typeof value === 'string' ? value.trim().slice(0, 80) : undefined))
function boundedInteger(min: number, max: number) {
  return z
    .unknown()
    .optional()
    .transform((value) =>
      typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined,
    )
}

const recordSchema = z.object({
  description: z.string().optional(),
  developer: z.string().optional(),
  genre: z.string().optional(),
  name: z.string().trim().min(1).max(300),
  publisher: z.string().optional(),
  region: editionDetail,
  releaseyear: boundedInteger(1900, 2100),
  revision: editionDetail,
  rom_name: z.string().optional(),
  users: boundedInteger(1, 100),
})

interface CatalogEntry {
  candidate: MountedMatchCandidate
  coverNames: string[]
  aliases: string[]
  developer?: string
  genres?: string
  publisher?: string
  players?: number
}

type Catalog = Map<string, CatalogEntry>
const cachedCatalogs = new Map<PlatformName, Catalog>()
const pendingCatalogs = new Map<PlatformName, Promise<Catalog>>()

function normalize(name: string) {
  return (
    name
      .normalize('NFKD')
      .toLowerCase()
      .replaceAll(/\p{Mark}/gu, '')
      .match(/[\p{Letter}\p{Number}]+/gu) || []
  )
}

function catalogEntry(platform: PlatformName, record: z.infer<typeof recordSchema>): CatalogEntry {
  const { name } = record
  const shortName = platform === 'arcade' && record.rom_name ? path.posix.parse(record.rom_name).name : undefined
  const normalizedName = normalize(name).join(' ')
  const details = [record.region, record.revision].map((detail) =>
    detail && !normalizedName.includes(normalize(detail).join(' ')) ? detail : undefined,
  )
  const [region, gameRevision] = details
  const id = createHash('sha256')
    .update(JSON.stringify([revision, platform, name, shortName, region, gameRevision]))
    .digest('hex')
  const baseTitle = name.replace(/(?:\s+\([^()]*\)|\s+\[[^\][]*\])+$/u, '')
  const aliases = [
    name,
    baseTitle,
    record.description,
    record.rom_name,
    shortName,
    `${name} ${details.filter(Boolean).join(' ')}`,
  ].flatMap((alias) => (alias ? [normalize(alias).join(' ')] : []))
  return {
    aliases,
    candidate: { id, name, region, revision: gameRevision, shortName, year: record.releaseyear },
    coverNames: shortName && shortName !== name ? [name, shortName] : [name],
    developer: record.developer,
    genres: record.genre,
    players: record.users,
    publisher: record.publisher,
  }
}

async function loadCatalog(platform: PlatformName) {
  const system = platformMap[platform].libretroName
  const url = `https://raw.githubusercontent.com/libretro/libretro-database/${revision}/rdb/${encodeURIComponent(system)}.rdb`
  assertMountedMetadataNetworkAllowed()
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) })
  if (!response.ok || response.headers.get('Content-Type')?.split(';')[0] !== 'application/octet-stream') {
    await response.body?.cancel()
    throw new Error(`Unexpected catalog response (HTTP ${response.status})`)
  }
  const bytes = await readMountedProviderBytes(response, maxCatalogSize, 'Libretro catalog')

  const { dataDirectory } = getDirectories()
  await getMountedLibrary()?.assertWritableDirectory(dataDirectory)
  // The parser requires a filename. Stage it in app data, outside mounted or served files.
  const filename = path.join(dataDirectory, `.libretro-catalog-${randomUUID()}.rdb`)
  const file = await open(filename, 'wx', 0o600)
  try {
    try {
      await file.writeFile(bytes)
    } finally {
      await file.close()
    }
    const { Libretrodb } = await import('libretrodb')
    const parsed = await Libretrodb.from(filename, { indexHashes: false })
    const catalog: Catalog = new Map()
    for (const raw of parsed.getEntries()) {
      const { data: record } = recordSchema.safeParse(raw)
      if (record) {
        const entry = catalogEntry(platform, record)
        const existing = catalog.get(entry.candidate.id)
        if (existing) {
          const preferred = !existing.candidate.year && entry.candidate.year ? entry : existing
          preferred.aliases = [...new Set([...existing.aliases, ...entry.aliases])]
          catalog.set(entry.candidate.id, preferred)
        } else {
          catalog.set(entry.candidate.id, entry)
        }
      }
    }
    if (!catalog.size) {
      throw new Error('Libretro catalog contains no recognized game records')
    }
    return catalog
  } finally {
    await rm(filename, { force: true })
  }
}

async function getCatalog(platform: PlatformName) {
  assertMountedMetadataNetworkAllowed()
  const cached = cachedCatalogs.get(platform)
  if (cached) {
    cachedCatalogs.delete(platform)
    cachedCatalogs.set(platform, cached)
    return cached
  }
  const pending = pendingCatalogs.get(platform)
  if (pending) {
    return await pending
  }
  if (pendingCatalogs.size >= maxCatalogLoads) {
    throw new MountedRepairError('catalog-provider')
  }

  async function remember() {
    try {
      const catalog = await loadCatalog(platform)
      cachedCatalogs.set(platform, catalog)
      if (cachedCatalogs.size > maxCachedCatalogs) {
        const oldest = cachedCatalogs.keys().next().value
        if (oldest) {
          cachedCatalogs.delete(oldest)
        }
      }
      return catalog
    } catch (error) {
      if (error instanceof MountedRepairError) {
        throw error
      }
      console.warn('Unable to load the mounted game catalog:', error)
      throw new MountedRepairError('catalog-provider', error)
    } finally {
      pendingCatalogs.delete(platform)
    }
  }

  const loading = remember()
  pendingCatalogs.set(platform, loading)
  return await loading
}

function scoreAlias(alias: string, tokens: string[], query: string) {
  if (alias === query) {
    return 4
  }
  if (alias.startsWith(query)) {
    return 3
  }
  if (alias.includes(query)) {
    return 2
  }
  return tokens.every((token) => alias.includes(token)) ? 1 : 0
}

export async function searchMountedCatalog(platform: PlatformName, query: string) {
  const tokens = normalize(query)
  if (!tokens.length) {
    return []
  }
  const catalog = await getCatalog(platform)
  const normalizedQuery = tokens.join(' ')
  const matches: { candidate: MountedMatchCandidate; score: number }[] = []
  for (const { aliases, candidate } of catalog.values()) {
    const score = Math.max(...aliases.map((alias) => scoreAlias(alias, tokens, normalizedQuery)))
    if (score > 0) {
      matches.push({ candidate, score })
    }
  }
  return matches
    .toSorted(
      (a, b) =>
        b.score - a.score ||
        a.candidate.name.localeCompare(b.candidate.name, 'en') ||
        a.candidate.id.localeCompare(b.candidate.id),
    )
    .slice(0, maxResults)
    .map(({ candidate }) => candidate)
}

export async function getMountedCatalogEntry(platform: PlatformName, candidateId: string) {
  const catalog = await getCatalog(platform)
  const entry = catalog.get(candidateId)
  if (!entry) {
    throw new MountedRepairError('invalid-candidate')
  }
  return entry
}
