import { getRomPlayback } from '#@/controllers/preference/rom-core-preference.ts'
import { getRomsWithStates } from '#@/controllers/roms/get-roms-with-states.ts'
import { getRoms } from '#@/controllers/roms/get-roms.ts'
import { getLibraryLoaderData } from '#@/utils/server/loader-data.ts'
import { LibraryHomePage } from '../library/home/page.tsx'

export async function loader() {
  const [{ roms: recentlySavedRoms }, { roms: newAddedRoms }, { roms: favoriteRoms }, libraryLoaderData] =
    await Promise.all([
      getRomsWithStates({ pageSize: 1 }),
      getRoms({ direction: 'desc', orderBy: 'added', pageSize: 20 }),
      getRoms({ favorite: true, pageSize: 20 }),
      getLibraryLoaderData(),
    ])

  const { recentlyLaunchedRoms } = libraryLoaderData
  const rom = recentlySavedRoms[0] || recentlyLaunchedRoms[0] || newAddedRoms[0] || null
  const playback = rom ? await getRomPlayback(rom) : null
  return {
    ...libraryLoaderData,
    core: playback?.core,
    favoriteRoms,
    newAddedRoms,
    recentlySavedRoms,
    rom,
    state: playback?.state,
  }
}

export default function LibraryRoute() {
  return <LibraryHomePage />
}
