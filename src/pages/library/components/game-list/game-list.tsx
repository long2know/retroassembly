import { useSelectedGames } from '../../atoms.ts'
import { usePreference } from '../../hooks/use-preference.ts'
import { GameEntry } from '../game-entry/game-entry.tsx'
import { GameListActions } from './game-list-actions.tsx'
import { GameListEmpty } from './game-list-empty.tsx'
import { GameListPagination } from './game-list-pagination.tsx'
import { useGameListActions } from './use-game-list-actions.ts'

export function GameList() {
  const { preference } = usePreference()
  const { deletableRomIds, roms, shouldHideActions } = useGameListActions()
  const [selectedIds, setSelectedGames] = useSelectedGames()
  const selectedGames = selectedIds.filter((id) => deletableRomIds.has(id))
  const selecting = selectedGames.length > 0

  function getSelectionHandler(id: string) {
    if (!deletableRomIds.has(id)) {
      return
    }
    return function handleSelectedChange(checked: boolean) {
      setSelectedGames(checked ? [...new Set([...selectedGames, id])] : selectedGames.filter((value) => value !== id))
    }
  }

  const sizeMap = { 'extra-large': 60, 'extra-small': 36, large: 54, medium: 48, small: 42 }
  const size = sizeMap[preference.ui.libraryCoverSize]
  const gridTemplateColumns = `repeat(auto-fill,minmax(min(calc(var(--spacing)*${size}),var(--min-width)),1fr))`

  return (
    <div className='flex flex-col border border-transparent border-t-(--gray-6) pt-4'>
      {shouldHideActions ? null : (
        <GameListActions
          deletableRomIds={deletableRomIds}
          key={String(selecting)}
          selectedGames={selectedGames}
          setSelectedGames={setSelectedGames}
        />
      )}
      {roms?.length ? (
        <div className='mt-4 grid [--min-width:150px] lg:[--min-width:100%]' style={{ gridTemplateColumns }}>
          {roms.map((rom) => (
            <GameEntry
              key={rom.id}
              onSelectedChange={getSelectionHandler(rom.id)}
              rom={rom}
              selected={selecting && deletableRomIds.has(rom.id) ? selectedGames.includes(rom.id) : undefined}
            />
          ))}
        </div>
      ) : (
        <GameListEmpty />
      )}
      <GameListPagination />
    </div>
  )
}
