import { useLoaderData } from 'react-router'
import type { getLibraryLoaderData } from '#@/utils/server/loader-data.ts'
import { GameEntrySettings } from './game-entry-settings.tsx'
import { HiddenMountedGames } from './hidden-mounted-games.tsx'
import { PlatformSettings } from './platform-settings.tsx'

export function LibrarySettings() {
  const { canRestoreMountedGames, currentUser } = useLoaderData<typeof getLibraryLoaderData>()

  return (
    <div className='flex flex-col gap-8'>
      {canRestoreMountedGames ? <HiddenMountedGames key={currentUser.id} userId={currentUser.id} /> : null}
      <PlatformSettings />
      <GameEntrySettings />
    </div>
  )
}
