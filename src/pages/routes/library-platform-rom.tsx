import assert from 'node:assert'
import { getContext } from 'hono/context-storage'
import type { PlatformName } from '#@/constants/platform.ts'
import { getRomPlayback } from '#@/controllers/preference/rom-core-preference.ts'
import { getRom } from '#@/controllers/roms/get-rom.ts'
import { getRomGoodcodes } from '#@/utils/client/library.ts'
import { getLibraryLoaderData } from '#@/utils/server/loader-data.ts'
import RomPage from '../library/platform/rom/page.tsx'
import type { Route } from './+types/library-platform-rom.ts'

export async function loader({ params }: Route.LoaderArgs) {
  assert.ok(params.fileName)
  assert.ok(params.platform)
  const platform = params.platform as PlatformName
  const id = getContext().req.query('rom_id')
  const rom = await getRom(id ? { id } : { fileName: params.fileName, platform })
  if (!rom || rom.platform !== platform || rom.fileName !== params.fileName) {
    throw new Response('Not Found', { status: 404 })
  }
  const playback = await getRomPlayback(rom)
  return await getLibraryLoaderData({ ...playback, rom, title: getRomGoodcodes(rom).rom })
}

export default function LibraryPlatformRomRoute() {
  return <RomPage />
}
