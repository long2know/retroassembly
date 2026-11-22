import { uniq } from 'es-toolkit'
import { useLayoutEffect, useMemo, useRef } from 'react'
import useSWRImmutable from 'swr/immutable'
import type { Rom } from '#@/controllers/roms/get-roms.ts'
import { imageLoaded } from '#@/utils/client/image.ts'
import {
  getDemoRomThumbnail,
  getLibretroThumbnail,
  getPlatformGameIcon,
  getRomLibretroThumbnail,
} from '#@/utils/client/library.ts'
import { getLegacyMountedCoverFallbacks, libretroCoverTypes } from '#@/utils/client/mounted-cover.ts'
import { getFileUrl } from '../utils/file.ts'
import { useIsDemo } from './use-demo.ts'
import { useMountedLibrary } from './use-mounted-library.ts'

export function useRomCover(rom: Rom) {
  const isDemo = useIsDemo()
  const { automaticMetadataEnabled } = useMountedLibrary()
  const cachedRomCovers = rom.gameBoxartFileIds
    ? rom.gameBoxartFileIds
        .split(',')
        .filter(Boolean)
        .map((fileId) => getFileUrl(fileId))
    : []

  const remoteCovers = useMemo(() => {
    if (rom.mountedSource) {
      return getLegacyMountedCoverFallbacks(rom, automaticMetadataEnabled)
    }
    if (isDemo) {
      return [getDemoRomThumbnail(rom)]
    }
    return [
      ...libretroCoverTypes.map((type) => getRomLibretroThumbnail(rom, type, 'libretro')),
      ...libretroCoverTypes.map((type) => getRomLibretroThumbnail(rom, type, 'jsdelivr')),
      ...libretroCoverTypes.map((type) =>
        getLibretroThumbnail({
          host: 'libretro',
          name: rom.fileName.split('/').at(-1)?.split('.')[0] || '',
          platform: rom.platform,
          type,
        }),
      ),
      ...libretroCoverTypes.map((type) =>
        getLibretroThumbnail({
          host: 'jsdelivr',
          name: rom.fileName.split('/').at(-1)?.split('.')[0] || '',
          platform: rom.platform,
          type,
        }),
      ),
    ]
  }, [automaticMetadataEnabled, isDemo, rom])
  const authorizedRemoteCovers = useRef(remoteCovers)
  useLayoutEffect(() => {
    authorizedRemoteCovers.current = remoteCovers
    return () => {
      authorizedRemoteCovers.current = []
    }
  }, [remoteCovers])

  const uniqueRomCovers = uniq([...cachedRomCovers, ...remoteCovers]).filter(Boolean)
  const platformCover = getPlatformGameIcon(rom.platform)
  const covers = [...uniqueRomCovers, platformCover]

  return useSWRImmutable(covers, async () => {
    for (const romCover of uniqueRomCovers) {
      const cached = cachedRomCovers.includes(romCover)
      if (!cached && !authorizedRemoteCovers.current.includes(romCover)) {
        continue
      }
      try {
        await imageLoaded(romCover)
        if (cached || authorizedRemoteCovers.current.includes(romCover)) {
          return { src: romCover, type: 'rom' }
        }
      } catch {}
    }
    return { src: platformCover, type: 'platform' }
  })
}
