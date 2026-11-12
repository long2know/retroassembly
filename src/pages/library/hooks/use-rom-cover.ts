import { uniq } from 'es-toolkit'
import useSWRImmutable from 'swr/immutable'
import type { Rom } from '#@/controllers/roms/get-roms.ts'
import { useGlobalLoaderData } from '#@/pages/hooks/use-global-loader-data.ts'
import { imageLoaded } from '#@/utils/client/image.ts'
import {
  getDemoRomThumbnail,
  getLibretroThumbnail,
  getPlatformGameIcon,
  getRomLibretroThumbnail,
} from '#@/utils/client/library.ts'
import { getFileUrl } from '../utils/file.ts'
import { useIsDemo } from './use-demo.ts'

const libretroThumbnailTypes = ['boxart', 'title', 'snap'] as const
export function useRomCover(rom: Rom) {
  const isDemo = useIsDemo()
  const { env } = useGlobalLoaderData()
  const offline = rom.mountedSource && env.RETROASSEMBLY_RUN_TIME_SHARED_ROM_METADATA_ENABLED !== 'true'
  const romCovers: string[] = []
  if (isDemo) {
    romCovers.push(getDemoRomThumbnail(rom))
  } else if (!offline) {
    romCovers.push(
      ...libretroThumbnailTypes.map((type) => getRomLibretroThumbnail(rom, type, 'libretro')),
      ...libretroThumbnailTypes.map((type) => getRomLibretroThumbnail(rom, type, 'jsdelivr')),
      ...libretroThumbnailTypes.map((type) =>
        getLibretroThumbnail({
          host: 'libretro',
          name: rom.fileName.split('/').at(-1)?.split('.')[0] || '',
          platform: rom.platform,
          type,
        }),
      ),
      ...libretroThumbnailTypes.map((type) =>
        getLibretroThumbnail({
          host: 'jsdelivr',
          name: rom.fileName.split('/').at(-1)?.split('.')[0] || '',
          platform: rom.platform,
          type,
        }),
      ),
    )
  }
  if (rom.gameBoxartFileIds) {
    romCovers.unshift(...rom.gameBoxartFileIds.split(',').map((fileId) => getFileUrl(fileId)))
  }
  const uniqueRomCovers = uniq(romCovers).filter(Boolean)
  const platformCover = getPlatformGameIcon(rom.platform)
  const covers = [...uniqueRomCovers, platformCover]

  return useSWRImmutable(covers, async () => {
    for (const romCover of uniqueRomCovers) {
      try {
        await imageLoaded(romCover)
        return { src: romCover, type: 'rom' }
      } catch {}
    }
    return { src: platformCover, type: 'platform' }
  })
}
