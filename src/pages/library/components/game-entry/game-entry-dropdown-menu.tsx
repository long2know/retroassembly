import { Checkbox, DropdownMenu, IconButton } from '@radix-ui/themes'
import { clsx } from 'clsx'
import { useState } from 'react'
import { useGameActions } from '../../hooks/use-game-actions.ts'
import { DeleteDialog } from './delete-dialog.tsx'

interface GameEntryDropdownMenuProps {
  onSelectedChange?: (checked: boolean) => void
  rom: { fileName: string; id: string }
  selected?: boolean
}

export function GameEntryDropdownMenu({ onSelectedChange, rom, selected }: Readonly<GameEntryDropdownMenuProps>) {
  const { deleteAction, selectText } = useGameActions(Boolean(onSelectedChange))
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  if (!deleteAction) {
    return
  }

  if (selected !== undefined) {
    return (
      <div className='absolute top-1 right-1 z-10'>
        <Checkbox aria-label={rom.fileName} checked={selected} onCheckedChange={onSelectedChange} value={rom.id} />
      </div>
    )
  }

  return (
    <>
      <DropdownMenu.Root onOpenChange={setMenuOpen} open={menuOpen}>
        <DropdownMenu.Trigger>
          <div
            className={clsx('absolute top-1 right-1 z-10 transition-opacity group-hover:opacity-100', {
              'opacity-0': !menuOpen,
            })}
          >
            <IconButton aria-label='Menu' className='bg-(--gray-1)!' size='1' title='Menu' variant='ghost'>
              <span className='icon-[mdi--more-vert] font-bold text-(--accent-9)' />
            </IconButton>
          </div>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content>
          {selectText ? (
            <DropdownMenu.Item onClick={() => onSelectedChange?.(true)}>
              <span className='icon-[mdi--checkbox-multiple-marked]' />
              {selectText}
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Item color='red' onClick={() => setDeleteDialogOpen(true)}>
            <span className='icon-[mdi--delete]' />
            {deleteAction.text}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>

      <DeleteDialog action={deleteAction} onOpenChange={setDeleteDialogOpen} open={deleteDialogOpen} romId={rom.id} />
    </>
  )
}
