import { Button, Callout, Dialog, IconButton, TextField } from '@radix-ui/themes'
import type { InferRequestType } from 'hono'
import { type PropsWithChildren, useState, type SubmitEvent } from 'react'
import { useTranslation } from 'react-i18next'
import useSWRMutation from 'swr/mutation'
import { client, parseResponse } from '#@/api/client.ts'
import { libraryModeEnum } from '#@/databases/schema.ts'
import { useGlobalLoaderData } from '#@/pages/hooks/use-global-loader-data.ts'
import { DialogRoot } from '#@/pages/library/components/dialog-root.tsx'
import { useIsDemo } from '#@/pages/library/hooks/use-demo.ts'
import { useRom } from '#@/pages/library/hooks/use-rom.ts'
import { useRouter } from '#@/pages/library/hooks/use-router.ts'
import { getRomGoodcodes } from '#@/utils/client/library.ts'
import { GameInfoDataList } from './game-info-data-list.tsx'

const defaultTrigger = (
  <IconButton
    aria-label='Edit metadata'
    className='transition-opacity! group-hover:opacity-100! lg:opacity-0!'
    title='Edit metadata'
    variant='ghost'
  >
    <span className='icon-[mdi--edit]' />
  </IconButton>
)

interface GameInfoDialogProps extends PropsWithChildren {
  autoFocusField?: string
}

export function GameInfoDialog({ autoFocusField, children = defaultTrigger }: Readonly<GameInfoDialogProps>) {
  const rom = useRom()
  const { t } = useTranslation()
  const { currentUser } = useGlobalLoaderData()

  const { reload } = useRouter()
  const isDemo = useIsDemo()

  const [open, setOpen] = useState(false)
  const [matchName, setMatchName] = useState(rom.gameName || rom.fileName.split('/').at(-1) || '')
  const [matching, setMatching] = useState(false)
  const [matchError, setMatchError] = useState('')

  async function handleIdentify() {
    setMatching(true)
    setMatchError('')
    try {
      await parseResponse(client.roms[':id'].identify.$post({ json: { name: matchName }, param: { id: rom.id } }))
      setOpen(false)
      await reload()
    } catch (error) {
      setMatchError(error instanceof Error ? error.message : String(error))
    } finally {
      setMatching(false)
    }
  }

  const { isMutating, trigger } = useSWRMutation(
    { endpoint: 'roms', method: 'patch', param: { id: rom.id } },
    ({ param }, { arg: form }: { arg: InferRequestType<(typeof client.roms)[':id']['$patch']>['form'] }) =>
      client.roms[':id'].$patch({ form, param }),
  )

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const formData = new FormData(event.target)
    await trigger(Object.fromEntries(formData))
    setOpen(false)
    await reload()
  }

  if (isDemo || (currentUser?.libraryMode === libraryModeEnum.shared && !rom.mountedSource)) {
    return
  }

  return (
    <DialogRoot onOpenChange={setOpen} open={open}>
      <Dialog.Trigger>{children}</Dialog.Trigger>

      <Dialog.Content aria-describedby={undefined} className='lg:w-2xl!'>
        <Dialog.Title className='-ml-1! flex items-center gap-2 text-xl font-semibold'>
          <span className='icon-[mdi--view-list]' />
          {getRomGoodcodes(rom).rom}
        </Dialog.Title>

        {rom.mountedSource ? (
          <div className='flex flex-col gap-2'>
            {matchError || rom.mountedSource.metadataError ? (
              <Callout.Root color='orange'>
                <Callout.Text>{matchError || rom.mountedSource.metadataError}</Callout.Text>
              </Callout.Root>
            ) : null}
            <div className='flex items-center gap-2'>
              <TextField.Root
                aria-label={t('common.search')}
                className='flex-1'
                onChange={(event) => setMatchName(event.target.value)}
                value={matchName}
              />
              <Button
                disabled={!matchName.trim()}
                loading={matching}
                onClick={handleIdentify}
                type='button'
                variant='soft'
              >
                <span className='icon-[mdi--search]' />
                {t('common.search')}
              </Button>
            </div>
          </div>
        ) : null}

        <form autoComplete='off' onSubmit={handleSubmit}>
          <GameInfoDataList autoFocusField={autoFocusField} />

          <div className='mt-4 flex justify-end gap-4'>
            <Dialog.Close>
              <Button disabled={isMutating} variant='soft'>
                <span className='icon-[mdi--close]' />
                {t('common.cancel')}
              </Button>
            </Dialog.Close>
            <Button loading={isMutating} type='submit'>
              <span className='icon-[mdi--content-save]' />
              {t('common.save')}
            </Button>
          </div>
        </form>

        <div className='absolute top-6 right-6'>
          <Dialog.Close>
            <Button variant='ghost'>
              <span className='icon-[mdi--close] size-5' />
            </Button>
          </Dialog.Close>
        </div>
      </Dialog.Content>
    </DialogRoot>
  )
}
