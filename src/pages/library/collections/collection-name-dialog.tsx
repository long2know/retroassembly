import { Button, Callout, Dialog, TextField } from '@radix-ui/themes'
import { useId, useState, type SubmitEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { generatePath, useNavigate, useRevalidator } from 'react-router'
import { client, parseResponse } from '#@/api/client.ts'
import { collectionNameMaxLength, collectionNameSchema } from '#@/constants/game-collections.ts'
import { routes } from '#@/pages/routes.ts'
import { useCollectionDialog } from './use-collection-dialog.ts'

export function CollectionNameDialog({ collection }: Readonly<{ collection?: { id: string; name: string } }>) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { revalidate } = useRevalidator()
  const { open, setOpen } = useCollectionDialog()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const errorId = useId()
  const title = t(collection ? 'collections.rename' : 'collections.create')

  function changeOpen(next: boolean) {
    setOpen(next)
    setError('')
  }

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) {
      return
    }
    const name = collectionNameSchema.safeParse(new FormData(event.currentTarget).get('name'))
    if (!name.success) {
      setError(t('collections.nameInvalid', { max: collectionNameMaxLength }))
      return
    }
    setError('')
    setPending(true)
    try {
      if (collection) {
        await client.collections[':collectionId'].$patch({
          json: { name: name.data },
          param: { collectionId: collection.id },
        })
        await revalidate()
        changeOpen(false)
      } else {
        const created = await parseResponse(client.collections.$post({ json: { name: name.data } }))
        changeOpen(false)
        await navigate(generatePath(routes.libraryCollection, { collectionId: created.id }))
      }
    } catch (error) {
      const duplicate = error && typeof error === 'object' && 'code' in error && error.code === 'duplicateName'
      setError(t(duplicate ? 'collections.duplicateName' : 'collections.saveFailed'))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog.Root onOpenChange={(next) => !pending && changeOpen(next)} open={open}>
      <Dialog.Trigger>
        <Button data-sn-enabled variant={collection ? 'soft' : 'solid'}>
          <span aria-hidden className={collection ? 'icon-[mdi--pencil-outline]' : 'icon-[mdi--folder-plus-outline]'} />
          {title}
        </Button>
      </Dialog.Trigger>
      <Dialog.Content maxWidth='420px'>
        <Dialog.Title>{title}</Dialog.Title>
        <Dialog.Description className='mb-4 text-(--gray-11)' size='2'>
          {t('collections.privateDescription')}
        </Dialog.Description>
        <form aria-busy={pending} onSubmit={handleSubmit}>
          <label className='flex flex-col gap-2 text-sm font-medium'>
            {t('collections.name')}
            <TextField.Root
              aria-describedby={error ? errorId : undefined}
              defaultValue={collection?.name}
              disabled={pending}
              maxLength={collectionNameMaxLength}
              name='name'
              required
            />
          </label>
          {error ? (
            <Callout.Root className='mt-3' color='red' id={errorId} role='alert'>
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          ) : null}
          <div className='mt-5 flex flex-wrap justify-end gap-3'>
            <Dialog.Close>
              <Button disabled={pending} type='button' variant='soft'>
                {t('common.cancel')}
              </Button>
            </Dialog.Close>
            <Button loading={pending} type='submit'>
              {t('common.save')}
            </Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  )
}
