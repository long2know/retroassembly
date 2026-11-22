import type { PropsWithChildren, ReactNode } from 'react'
import { useLocation } from 'react-router'
import { GameList } from './game-list/game-list.tsx'
import { PageBreadcrumb } from './page-breadcrumb.tsx'

export function GameListMain({ children, filter }: Readonly<PropsWithChildren<{ filter?: ReactNode }>>) {
  const { key } = useLocation()

  return (
    <>
      <PageBreadcrumb />
      <div className='flex min-h-full w-full flex-col gap-5 p-4'>
        <div className='relative flex flex-col justify-between pt-4 lg:flex-row lg:px-4'>{children}</div>
        {filter}
        <GameList key={key} />
      </div>
    </>
  )
}
