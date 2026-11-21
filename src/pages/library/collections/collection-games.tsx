import { Badge, Button, Callout } from '@radix-ui/themes'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useRevalidator } from 'react-router'
import { client } from '#@/api/client.ts'
import type { getCollectionGames } from '#@/controllers/collections/collections.ts'
import { routes } from '#@/pages/routes.ts'
import { getRomGoodcodes } from '#@/utils/client/library.ts'
import { GameEntryGrid } from '../components/game-entry-grid.tsx'
import { GameListPagination } from '../components/game-list/game-list-pagination.tsx'
import { NavigatableLink } from '../components/navigatable-link.tsx'
import { CollectionNameDialog } from './collection-name-dialog.tsx'
import { DeleteCollectionDialog } from './delete-collection-dialog.tsx'

type CollectionGamesProps = NonNullable<Awaited<ReturnType<typeof getCollectionGames>>>

export function CollectionGames({ collection, pagination, roms }: Readonly<CollectionGamesProps>) {
  const { t } = useTranslation()
  const { revalidate } = useRevalidator()
  const titleRef = useRef<HTMLHeadingElement>(null)
  const [pendingId, setPendingId] = useState<string>()
  const [failedId, setFailedId] = useState<string>()

  async function removeGame(romId: string) {
    setPendingId(romId)
    setFailedId(undefined)
    try {
      await client.collections[':collectionId'].roms[':romId'].$delete({
        param: { collectionId: collection.id, romId },
      })
      titleRef.current?.focus({ preventScroll: true })
      await revalidate()
    } catch {
      setFailedId(romId)
    } finally {
      setPendingId(undefined)
    }
  }

  return (
    <>
      <header className='flex flex-col items-start gap-4 border-b border-(--gray-5) pb-5'>
        <Button asChild variant='ghost'>
          <NavigatableLink to={routes.libraryCollections}>
            <span aria-hidden className='icon-[mdi--arrow-left]' />
            {t('nav.collections')}
          </NavigatableLink>
        </Button>
        <div className='flex w-full flex-wrap items-end justify-between gap-4'>
          <div className='flex min-w-0 flex-col items-start gap-2'>
            <h1 className='text-3xl font-bold wrap-anywhere' ref={titleRef} tabIndex={-1}>
              {collection.name}
            </h1>
            <output>
              <Badge color='gray' variant='soft'>
                <span aria-hidden className='icon-[mdi--lock-outline]' />
                {t('collections.gameCount', { count: pagination.total })}
              </Badge>
            </output>
          </div>
          <div className='flex flex-wrap gap-2'>
            <CollectionNameDialog collection={collection} />
            <DeleteCollectionDialog collection={collection} />
          </div>
        </div>
      </header>
      {roms.length ? (
        <>
          <GameEntryGrid
            renderActions={(rom) => (
              <div className='flex flex-col items-center gap-2 pb-2'>
                <Button
                  aria-label={t('collections.removeNamedGame', {
                    game: getRomGoodcodes(rom).rom,
                    interpolation: { escapeValue: false },
                  })}
                  data-sn-enabled
                  disabled={Boolean(pendingId)}
                  loading={pendingId === rom.id}
                  onClick={() => removeGame(rom.id)}
                  size='1'
                  type='button'
                  variant='soft'
                >
                  <span aria-hidden className='icon-[mdi--minus-circle-outline]' />
                  {t('collections.remove')}
                </Button>
                {failedId === rom.id ? (
                  <Callout.Root color='red' role='alert' size='1'>
                    <Callout.Text>{t('collections.saveFailed')}</Callout.Text>
                  </Callout.Root>
                ) : null}
              </div>
            )}
            roms={roms}
          />
          <GameListPagination />
        </>
      ) : (
        <div className='flex flex-col items-center gap-3 rounded-lg border border-dashed border-(--gray-6) px-5 py-12 text-center'>
          <span aria-hidden className='icon-[mdi--gamepad-variant-outline] size-8 text-(--accent-11)' />
          <p className='text-sm text-(--gray-11)'>{t('collections.emptyGameList')}</p>
          <Button asChild variant='soft'>
            <NavigatableLink to={routes.libraryRoms}>{t('collections.browseGames')}</NavigatableLink>
          </Button>
        </div>
      )}
    </>
  )
}
