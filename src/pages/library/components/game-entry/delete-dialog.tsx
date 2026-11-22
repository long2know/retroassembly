import { AlertDialog, Button } from '@radix-ui/themes'
import { isPlainObject } from 'es-toolkit'
import { isMatch } from 'es-toolkit/compat'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { mutate } from 'swr'
import useSWRMutation from 'swr/mutation'
import { client } from '#@/api/client.ts'
import { useRouter } from '../../hooks/use-router.ts'

interface DeleteDialogProps extends AlertDialog.RootProps {
  action: { confirmDescription: string; text: string; type: 'launch_records' | 'roms' }
  romId: string
}

const { ':id': romsEndpoint } = client.roms

export function DeleteDialog({ action, romId, ...props }: Readonly<DeleteDialogProps>) {
  const { t } = useTranslation()
  const { reload } = useRouter()
  const { type } = action
  const { $delete } = { launch_records: romsEndpoint.launch_records, roms: romsEndpoint }[type]
  const endpoint = { launch_records: 'roms/:id/launch_records', roms: 'roms' }[type]

  const [clicked, setClicked] = useState(false)
  const { isMutating, trigger } = useSWRMutation(
    { endpoint, method: 'delete', param: { id: romId } },
    ({ param }) => $delete({ param }),
    {
      onError() {
        setClicked(false)
      },
      onSuccess: () => {
        closeDeleteDialog()
      },
    },
  )

  const isLoading = clicked || isMutating
  function closeDeleteDialog() {
    if (!isMutating) {
      props.onOpenChange?.(false)
    }
  }

  async function handleClickConfirmDelete() {
    await trigger()
    closeDeleteDialog()
    await reload()
    await mutate((key) => isPlainObject(key) && isMatch(key, { endpoint: 'roms/search' }), false)
  }

  return (
    <AlertDialog.Root {...props}>
      <AlertDialog.Content maxWidth='450px'>
        <AlertDialog.Title>{action.text}</AlertDialog.Title>
        <AlertDialog.Description className='leading-loose! whitespace-pre-line' size='2'>
          {action.confirmDescription}
        </AlertDialog.Description>

        <div className='mt-4 flex justify-end gap-3'>
          <AlertDialog.Cancel>
            <Button disabled={isLoading}>
              <span className='icon-[mdi--close]' />
              {t('common.cancel')}
            </Button>
          </AlertDialog.Cancel>
          <Button loading={isLoading} onClick={handleClickConfirmDelete} variant='soft'>
            <span className='icon-[mdi--delete]' />
            {t('common.delete')}
          </Button>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Root>
  )
}
