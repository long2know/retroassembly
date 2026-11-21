import { AlertDialog, Button, Callout } from '@radix-ui/themes'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { client } from '#@/api/client.ts'
import { routes } from '#@/pages/routes.ts'
import { useCollectionDialog } from './use-collection-dialog.ts'

export function DeleteCollectionDialog({ collection }: Readonly<{ collection: { id: string; name: string } }>) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { open, setOpen } = useCollectionDialog()
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)

  function changeOpen(next: boolean) {
    setOpen(next)
    setFailed(false)
  }

  async function handleDelete() {
    if (pending) {
      return
    }
    setPending(true)
    setFailed(false)
    try {
      await client.collections[':collectionId'].$delete({ param: { collectionId: collection.id } })
      changeOpen(false)
      await navigate(routes.libraryCollections, { replace: true })
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }

  return (
    <AlertDialog.Root onOpenChange={(next) => !pending && changeOpen(next)} open={open}>
      <AlertDialog.Trigger>
        <Button color='red' data-sn-enabled variant='soft'>
          <span aria-hidden className='icon-[mdi--trash-can-outline]' />
          {t('collections.delete')}
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Content maxWidth='440px'>
        <AlertDialog.Title>{t('collections.delete')}</AlertDialog.Title>
        <AlertDialog.Description className='wrap-anywhere' size='2'>
          {t('collections.deleteDescription', { interpolation: { escapeValue: false }, name: collection.name })}
        </AlertDialog.Description>
        {failed ? (
          <Callout.Root className='mt-3' color='red' role='alert'>
            <Callout.Text>{t('collections.saveFailed')}</Callout.Text>
          </Callout.Root>
        ) : null}
        <div className='mt-5 flex justify-end gap-3'>
          <AlertDialog.Cancel>
            <Button disabled={pending} type='button' variant='soft'>
              {t('common.cancel')}
            </Button>
          </AlertDialog.Cancel>
          <Button color='red' loading={pending} onClick={handleDelete} type='button'>
            {t('common.delete')}
          </Button>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Root>
  )
}
