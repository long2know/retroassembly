import { Button } from '@radix-ui/themes'
import { range } from 'es-toolkit'
import { useLoaderData, useSearchParams } from 'react-router'
import type { RomsPagination } from '#@/controllers/roms/get-roms.ts'
import { NavigatableLink } from '../navigatable-link.tsx'

export function GameListPagination() {
  const { gameFilter, pagination } = useLoaderData<{ gameFilter?: string; pagination: RomsPagination }>()
  const [searchParams] = useSearchParams()
  const { current, pages } = pagination

  function getPageLink(page: number) {
    const params = new URLSearchParams(gameFilter === undefined ? undefined : searchParams)
    params.set('page', String(page))
    return `?${params}`
  }

  if (pages <= 1) {
    return
  }

  return (
    <ul className='mt-4 flex flex-wrap justify-center gap-2 px-10'>
      {range(1, pages + 1).map((page) => (
        <li key={page}>
          <Button asChild size='3' variant={current === page ? 'solid' : 'soft'}>
            {current === page ? (
              <span>{page}</span>
            ) : (
              <NavigatableLink data-sn-enabled to={getPageLink(page)}>
                {page}
              </NavigatableLink>
            )}
          </Button>
        </li>
      ))}
    </ul>
  )
}
