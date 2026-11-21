import type { ReactNode } from 'react'
import { usePreference } from '../hooks/use-preference.ts'
import { GameEntry } from './game-entry/game-entry.tsx'

const sizeMap = { 'extra-large': 60, 'extra-small': 36, large: 54, medium: 48, small: 42 }

interface GameEntryGridProps<TRom> {
  renderActions?: (rom: TRom) => ReactNode
  roms: readonly TRom[]
}

export function GameEntryGrid<TRom extends { id: string }>({
  renderActions,
  roms,
}: Readonly<GameEntryGridProps<TRom>>) {
  const { preference } = usePreference()
  const size = sizeMap[preference.ui.libraryCoverSize]

  const gridTemplateColumns = `repeat(auto-fill,minmax(min(calc(var(--spacing)*${size}),var(--min-width)),1fr))`

  return (
    <div className='grid [--min-width:150px] lg:[--min-width:100%]' style={{ gridTemplateColumns }}>
      {roms.map((rom) => (
        <GameEntry actions={renderActions?.(rom)} key={rom.id} rom={rom} />
      ))}
    </div>
  )
}
