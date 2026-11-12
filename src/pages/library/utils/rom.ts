import { generatePath } from 'react-router'
import { routes } from '#@/pages/routes.ts'

export function getRomUrl(rom: { fileName: string; id?: string; platform: string }, isDemo = false) {
  const pathname = generatePath(isDemo ? routes.demoPlatformRom : routes.libraryPlatformRom, {
    fileName: rom.fileName,
    platform: rom.platform,
  })
  return !isDemo && rom.id ? `${pathname}?rom_id=${encodeURIComponent(rom.id)}` : pathname
}
