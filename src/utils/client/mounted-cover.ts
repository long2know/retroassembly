import { hasMountedCatalogScope } from '#@/constants/mounted-library.ts'
import { isPlatformName, platformMap } from '#@/constants/platform.ts'
import type { Rom } from '#@/controllers/roms/get-roms.ts'
import { getLibretroThumbnail } from './library.ts'

export const libretroCoverTypes = ['boxart', 'title', 'snap'] as const

type CoverRom = Pick<
  Rom,
  'fileName' | 'gameBoxartFileIds' | 'gameName' | 'mountedSource' | 'platform' | 'rawGameMetadata'
>

function providerName(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function getLegacyMountedCoverFallbacks(rom: CoverRom, automaticMetadataEnabled: boolean) {
  const source = rom.mountedSource
  if (
    !automaticMetadataEnabled ||
    !source?.available ||
    source.catalogMatch ||
    source.artwork === 'manual' ||
    source.manualMetadataFields?.includes('gameName') ||
    rom.gameBoxartFileIds?.split(',').some((id) => id && !id.startsWith('metadata/')) ||
    !hasMountedCatalogScope(rom.platform, source.path)
  ) {
    return []
  }

  const libretroName = providerName(rom.rawGameMetadata?.libretro?.name)
  const launchboxName = providerName(rom.rawGameMetadata?.launchbox?.name)
  if (!rom.gameName || (rom.gameName !== libretroName && rom.gameName !== launchboxName)) {
    return []
  }

  const providerPlatform = providerName(rom.rawGameMetadata?.libretro?.platform)
  const system =
    providerPlatform && isPlatformName(providerPlatform) ? platformMap[providerPlatform].libretroName : providerPlatform
  const isFbneo = rom.platform === 'arcade' && system === 'FBNeo - Arcade Games'
  const isMame = rom.platform === 'arcade' && Boolean(system && /^MAME(?: \d{4}(?:-Plus)?)?$/u.test(system))
  if (system && system !== platformMap[rom.platform].libretroName && !isFbneo && !isMame) {
    return []
  }

  const paths = [
    { name: libretroName, platform: isFbneo ? 'FBNeo - Arcade Games' : rom.platform },
    { name: rom.fileName.split('/').at(-1)?.split('.')[0], platform: rom.platform },
  ]
  const urls: string[] = []
  for (const { name, platform } of paths) {
    if (name) {
      for (const host of ['libretro', 'jsdelivr'] as const) {
        urls.push(...libretroCoverTypes.map((type) => getLibretroThumbnail({ host, name, platform, type })))
      }
    }
  }
  return urls
}
