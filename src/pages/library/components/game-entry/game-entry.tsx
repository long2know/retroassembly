import type { MouseEvent, ReactNode } from 'react'
import { getRomUrl } from '#@/pages/library/utils/rom.ts'
import { useIsDemo } from '../../hooks/use-demo.ts'
import { FavoriteButton } from '../favorite-button.tsx'
import { NavigatableLink } from '../navigatable-link.tsx'
import { GameEntryDropdownMenu } from './game-entry-dropdown-menu.tsx'
import { GameEntryImage } from './game-entry-image.tsx'
import { GamePlatform } from './game-platform.tsx'
import { GameTitle } from './game-title.tsx'

interface GameEntryProps {
  actions?: ReactNode
  onSelectedChange?: (checked: boolean) => void
  rom: any
  selected?: boolean
}

export function GameEntry({ actions, onSelectedChange, rom, selected }: Readonly<GameEntryProps>) {
  const isDemo = useIsDemo()

  const url = getRomUrl(rom, isDemo)
  const selecting = selected !== undefined
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (selecting) {
      event.preventDefault()
      onSelectedChange?.(!selected)
    }
  }

  return (
    <div className='group relative'>
      <NavigatableLink
        className='game-entry group flex flex-col items-center justify-center gap-1 lg:p-1'
        onClick={handleClick}
        title={selecting ? `Select ${rom.fileName}` : rom.fileName}
        to={url}
      >
        {({ isPending }) => (
          <>
            <GameEntryImage rom={rom} />
            <GamePlatform platform={rom.platform} />
            <GameTitle rom={rom} />
            {isPending ? (
              <div className='absolute inset-0 z-10 hidden bg-(--color-background)/50 group-focus:block'>
                <div className='flex aspect-square w-full items-center justify-center'>
                  <div className='flex rounded-full bg-(--color-background) p-2 ring-1 ring-(--gray-4)'>
                    <span className='icon-[svg-spinners--180-ring] text-(--accent-9)' />
                  </div>
                </div>
              </div>
            ) : null}
          </>
        )}
      </NavigatableLink>
      {actions === undefined ? (
        <>
          {isDemo ? null : <FavoriteButton rom={rom} variant='overlay' />}
          <GameEntryDropdownMenu onSelectedChange={onSelectedChange} rom={rom} selected={selected} />
        </>
      ) : (
        actions
      )}
    </div>
  )
}
