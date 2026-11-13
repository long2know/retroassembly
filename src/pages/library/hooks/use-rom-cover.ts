import { uniq } from 'es-toolkit'
import { useEffect, useRef } from 'react'
import useSWRImmutable from 'swr/immutable'
import type { Rom } from '#@/controllers/roms/get-roms.ts'
import { imageLoaded } from '#@/utils/client/image.ts'
import {
  getDemoRomThumbnail,
  getLibretroThumbnail,
  getPlatformGameIcon,
  getRomLibretroThumbnail,
} from '#@/utils/client/library.ts'
import { getFileUrl } from '../utils/file.ts'
import { useIsDemo } from './use-demo.ts'
import { useMountedLibrary } from './use-mounted-library.ts'

const libretroThumbnailTypes = ['boxart', 'title', 'snap'] as const
export function useRomCover(rom: Rom) {
  const isDemo = useIsDemo()
  const { automaticMetadataEnabled } = useMountedLibrary()
  const remoteCoversEnabled = !rom.mountedSource || automaticMetadataEnabled
  const remoteCoversEnabledRef = useRef(remoteCoversEnabled)
  const cachedRomCovers = rom.gameBoxartFileIds
    ? rom.gameBoxartFileIds.split(',').filter(Boolean).map((fileId) => getFileUrl(fileId))
    : []

  useEffect(() => {
    remoteCoversEnabledRef.current = remoteCoversEnabled
    return () => {
      remoteCoversEnabledRef.current = false
    }
  }, [remoteCoversEnabled])

  const romCovers = [...cachedRomCovers]
  if (isDemo) {
    romCovers.push(getDemoRomThumbnail(rom))
  } else if (remoteCoversEnabled) {
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
  const uniqueRomCovers = uniq(romCovers).filter(Boolean)
  const platformCover = getPlatformGameIcon(rom.platform)
  const covers = [...uniqueRomCovers, platformCover]

  return useSWRImmutable(covers, async () => {
    for (const romCover of uniqueRomCovers) {
      const cached = cachedRomCovers.includes(romCover)
      if (!cached && !remoteCoversEnabledRef.current) {
        continue
      }
      try {
        await imageLoaded(romCover)
        if (cached || remoteCoversEnabledRef.current) {
          return { src: romCover, type: 'rom' }
        }
      } catch {}
    }
    return { src: platformCover, type: 'platform' }
  })
}
