import { Badge, Card } from '@radix-ui/themes'
import { useTranslation } from 'react-i18next'
import { generatePath, useLoaderData } from 'react-router'
import { NavigatableLink } from '#@/pages/library/components/navigatable-link.tsx'
import { routes } from '#@/pages/routes.ts'
import type { loader } from '#@/pages/routes/library-collections.tsx'
import LibraryLayout from '../components/library-layout/library-layout.tsx'
import { CollectionGames } from './collection-games.tsx'
import { CollectionNameDialog } from './collection-name-dialog.tsx'

export function CollectionsPage() {
  const { t } = useTranslation()
  const data = useLoaderData<typeof loader>()

  return (
    <LibraryLayout>
      <div className='mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 lg:px-8 lg:py-10'>
        {'collection' in data ? (
          <CollectionGames key={data.collection.id} {...data} />
        ) : (
          <>
            <header className='flex flex-wrap items-center justify-between gap-4'>
              <div className='flex flex-col gap-2'>
                <h1 className='text-3xl font-bold'>{t('nav.collections')}</h1>
                <p className='flex items-center gap-2 text-sm text-(--gray-11)'>
                  <span aria-hidden className='icon-[mdi--lock-outline] size-4 shrink-0' />
                  {t('collections.privateDescription')}
                </p>
              </div>
              <CollectionNameDialog />
            </header>
            {data.collections.length ? (
              <ul className='grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3'>
                {data.collections.map(({ id, name, total }) => (
                  <li key={id}>
                    <Card asChild className='h-full'>
                      <NavigatableLink
                        className='flex items-center gap-3'
                        to={generatePath(routes.libraryCollection, { collectionId: id })}
                      >
                        <span className='flex size-10 shrink-0 items-center justify-center rounded-md bg-(--accent-3) text-(--accent-11)'>
                          <span aria-hidden className='icon-[mdi--folder-outline] size-6' />
                        </span>
                        <div className='flex min-w-0 flex-1 flex-col items-start gap-1'>
                          <h2 className='font-semibold wrap-anywhere'>{name}</h2>
                          <Badge color='gray' variant='soft'>
                            {t('collections.gameCount', { count: total })}
                          </Badge>
                        </div>
                        <span aria-hidden className='icon-[mdi--chevron-right] size-5 shrink-0 text-(--gray-11)' />
                      </NavigatableLink>
                    </Card>
                  </li>
                ))}
              </ul>
            ) : (
              <div className='flex flex-col items-center gap-3 rounded-lg border border-dashed border-(--gray-6) px-5 py-12 text-center'>
                <span aria-hidden className='icon-[mdi--folder-multiple-outline] size-8 text-(--accent-11)' />
                <p className='text-sm text-(--gray-11)'>{t('collections.empty')}</p>
              </div>
            )}
          </>
        )}
      </div>
    </LibraryLayout>
  )
}
