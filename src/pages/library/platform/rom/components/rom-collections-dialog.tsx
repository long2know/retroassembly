import { Button, Callout, Dialog } from '@radix-ui/themes'
import { useState, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import useSWR from 'swr'
import { client, parseResponse } from '#@/api/client.ts'
import { useCollectionDialog } from '#@/pages/library/collections/use-collection-dialog.ts'
import { routes } from '#@/pages/routes.ts'

export function RomCollectionsDialog({ romId, userId }: Readonly<{ romId: string; userId: string }>) {
  const { t } = useTranslation()
  const { open, setOpen } = useCollectionDialog()
  const [pendingId, setPendingId] = useState<string>()
  const [failed, setFailed] = useState(false)
  const { data, error, isLoading, isValidating, mutate } = useSWR(
    open ? { endpoint: 'collections/for-rom', romId, userId } : null,
    () => parseResponse(client.collections['for-rom'][':romId'].$get({ param: { romId } })),
    { dedupingInterval: 0, shouldRetryOnError: false },
  )

  function changeOpen(next: boolean) {
    if (!pendingId) {
      setOpen(next)
      setFailed(false)
    }
  }

  async function toggleGame(collectionId: string, includesGame: boolean) {
    setPendingId(collectionId)
    setFailed(false)
    try {
      const endpoint = client.collections[':collectionId'].roms[':romId']
      const request = { param: { collectionId, romId } }
      await (includesGame ? endpoint.$delete(request) : endpoint.$put(request))
      await mutate(
        (collections) =>
          collections?.map((collection) =>
            collection.id === collectionId ? { ...collection, includesGame: !includesGame } : collection,
          ),
        { revalidate: false },
      )
    } catch {
      setFailed(true)
    } finally {
      setPendingId(undefined)
    }
  }

  function goToCollections(event: MouseEvent<HTMLAnchorElement>) {
    if (pendingId) {
      event.preventDefault()
    } else {
      changeOpen(false)
    }
  }

  return (
    <Dialog.Root onOpenChange={changeOpen} open={open}>
      <Dialog.Trigger>
        <Button className='self-start' data-sn-enabled size='2' variant='soft'>
          <span aria-hidden className='icon-[mdi--folder-multiple-outline]' />
          {t('nav.collections')}
        </Button>
      </Dialog.Trigger>
      <Dialog.Content maxWidth='440px'>
        <Dialog.Title>{t('nav.collections')}</Dialog.Title>
        <Dialog.Description className='mb-3 text-(--gray-11)' size='2'>
          {t('collections.chooseDescription')}
        </Dialog.Description>
        {error || failed ? (
          <Callout.Root className='mb-3' color='red' role='alert'>
            <Callout.Text>{t(error ? 'collections.loadFailed' : 'collections.saveFailed')}</Callout.Text>
            {error ? (
              <Button loading={isValidating} onClick={() => mutate()} size='1' type='button' variant='soft'>
                {t('common.retry')}
              </Button>
            ) : null}
          </Callout.Root>
        ) : null}
        {isLoading ? <output>{t('collections.loading')}</output> : null}
        {!error && data?.length ? (
          <ul aria-busy={Boolean(pendingId)} className='max-h-[45vh] divide-y divide-(--gray-5) overflow-y-auto'>
            {data.map(({ id, includesGame, name }) => (
              <li className='flex items-center justify-between gap-3 py-2' key={id}>
                <span className='min-w-0 text-sm font-medium wrap-anywhere'>{name}</span>
                <Button
                  aria-label={t(includesGame ? 'collections.removeFrom' : 'collections.addTo', {
                    interpolation: { escapeValue: false },
                    name,
                  })}
                  disabled={Boolean(pendingId) || isValidating}
                  loading={id === pendingId}
                  onClick={() => toggleGame(id, includesGame)}
                  size='1'
                  type='button'
                  variant='soft'
                >
                  <span aria-hidden className={includesGame ? 'icon-[mdi--check]' : 'icon-[mdi--plus]'} />
                  {t(includesGame ? 'collections.remove' : 'common.add')}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {!error && data?.length === 0 ? (
          <p className='rounded-md bg-(--gray-3) p-3 text-sm text-(--gray-11)'>{t('collections.empty')}</p>
        ) : null}
        <div className='mt-4 flex flex-wrap justify-between gap-3'>
          <Button asChild variant='ghost'>
            <Link onClick={goToCollections} to={routes.libraryCollections}>
              {t('collections.manage')}
            </Link>
          </Button>
          <Dialog.Close>
            <Button disabled={Boolean(pendingId)} type='button' variant='soft'>
              {t('common.done')}
            </Button>
          </Dialog.Close>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  )
}
