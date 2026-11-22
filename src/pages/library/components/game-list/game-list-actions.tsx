import { clsx } from 'clsx'
import { useState } from 'react'
import { DeleteDialog } from './delete-dialog.tsx'
import { FilterActions } from './filter-actions.tsx'
import { SelectionActions } from './selection-actions.tsx'
import { SelectionInfo } from './selection-info.tsx'

interface GameListActionsProps {
  deletableRomIds: ReadonlySet<string>
  selectedGames: string[]
  setSelectedGames: (ids: string[]) => void
}

export function GameListActions({ deletableRomIds, selectedGames, setSelectedGames }: Readonly<GameListActionsProps>) {
  const hasSelectedGames = selectedGames.length > 0
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  return (
    <div
      className={clsx('flex px-4', {
        'justify-between': hasSelectedGames,
        'justify-end': !hasSelectedGames,
      })}
    >
      {hasSelectedGames ? (
        <>
          <SelectionInfo
            selectedCount={selectedGames.length}
            canSelectAll={selectedGames.length < deletableRomIds.size}
            onSelectAll={() => setSelectedGames([...deletableRomIds])}
          />
          <SelectionActions
            selectedCount={selectedGames.length}
            onDelete={() => setDeleteDialogOpen(true)}
            onCancel={() => setSelectedGames([])}
          />
          <DeleteDialog
            onDeleted={() => setSelectedGames([])}
            onOpenChange={setDeleteDialogOpen}
            open={deleteDialogOpen}
            selectedGames={selectedGames}
          />
        </>
      ) : (
        <FilterActions />
      )}
    </div>
  )
}
