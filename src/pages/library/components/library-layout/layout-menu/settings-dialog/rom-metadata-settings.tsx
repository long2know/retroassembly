import { Button, Callout, Card, Switch, TextField } from '@radix-ui/themes'
import { DateTime } from 'luxon'
import { useEffect, useRef, useState, type SubmitEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useRevalidator } from 'react-router'
import useSWRMutation from 'swr/mutation'
import { client, type InferRequestType, parseResponse } from '#@/api/client.ts'
import { useMountedLibrary } from '#@/pages/library/hooks/use-mounted-library.ts'
import { SettingsTitle } from './settings-title.tsx'

type MountedAction = 'scan' | 'metadata' | 'artwork'
type MountedSettingsUpdate = InferRequestType<typeof client['mounted-library']['$patch']>['json']

export function RomMetadataSettings() {
  const { t, i18n } = useTranslation()
  const { revalidate } = useRevalidator()
  const { data, error, isLoading, isValidating, mutate } = useMountedLibrary({ poll: true })
  const [requestError, setRequestError] = useState<string>()
  const [settingsSaved, setSettingsSaved] = useState(false)
  const [activeAction, setActiveAction] = useState<MountedAction>()
  const completion = `${data?.lastScanFinishedAt || ''}:${data?.metadata.lastFinishedAt || ''}`
  const previousCompletion = useRef(completion)

  const { isMutating: isUpdating, trigger: updateSettings } = useSWRMutation(
    { endpoint: 'mounted-library', method: 'patch' },
    async (_key, { arg }: { arg: MountedSettingsUpdate }) => {
      return await parseResponse(client['mounted-library'].$patch({ json: arg }))
    },
  )

  const { isMutating, trigger: triggerAction } = useSWRMutation(
    { endpoint: 'mounted-library', method: 'post' },
    async (_key, { arg }: { arg: MountedAction }) => {
      if (arg === 'scan') {
        return await parseResponse(client['mounted-library'].$post())
      }
      if (arg === 'artwork') {
        return await parseResponse(client['mounted-library'].artwork.$post({ json: {} }))
      }
      return await parseResponse(client['mounted-library'].metadata.$post({ json: {} }))
    },
  )

  useEffect(() => {
    if (previousCompletion.current !== completion) {
      previousCompletion.current = completion
      void revalidate()
    }
  }, [completion, revalidate])

  function formatTime(value?: string) {
    if (!value) {
      return t('common.never')
    }
    const date = DateTime.fromISO(value).setLocale(i18n.language)
    return date.isValid ? date.toLocaleString(DateTime.DATETIME_MED) : t('common.unknown')
  }

  async function handleReloadStatus() {
    setRequestError(undefined)
    try {
      await mutate()
    } catch {
      setRequestError(t('mountedLibrary.loadFailed'))
    }
  }

  async function saveSettings(value: MountedSettingsUpdate) {
    setRequestError(undefined)
    setSettingsSaved(false)
    try {
      const status = await updateSettings(value)
      await mutate(status, { revalidate: false })
      setSettingsSaved(true)
      await revalidate()
    } catch {
      setRequestError(t('mountedLibrary.requestFailed'))
    }
  }

  async function handleAutomaticMetadata(checked: boolean) {
    await saveSettings({ automaticMetadata: checked })
  }

  async function handleIntervalSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const seconds = Number(new FormData(event.currentTarget).get('scanIntervalSeconds'))
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86_400) {
      setRequestError(t('mountedLibrary.invalidInterval'))
      return
    }
    await saveSettings({ scanIntervalSeconds: seconds })
  }

  async function runAction(action: MountedAction) {
    setRequestError(undefined)
    setSettingsSaved(false)
    setActiveAction(action)
    try {
      const status = await triggerAction(action)
      await mutate(status, { revalidate: false })
    } catch {
      setRequestError(t('mountedLibrary.requestFailed'))
    } finally {
      setActiveAction(undefined)
    }
  }

  async function handleScan() {
    await runAction('scan')
  }

  async function handleMetadata() {
    await runAction('metadata')
  }

  async function handleArtwork() {
    await runAction('artwork')
  }

  if (!data) {
    return (
      <Card>
        <p role={error ? 'alert' : 'status'}>{t(error ? 'mountedLibrary.loadFailed' : 'mountedLibrary.loading')}</p>
        {error ? (
          <Button className='mt-3' loading={isValidating} onClick={handleReloadStatus} type='button' variant='soft'>
            {t('common.retry')}
          </Button>
        ) : null}
      </Card>
    )
  }

  const scanning = data.running || activeAction === 'scan'
  const refreshing = data.metadata.running || activeAction === 'metadata' || activeAction === 'artwork'
  const busy = isLoading || Boolean(error) || isUpdating || isMutating || data.running || data.metadata.running

  return (
    <div className='flex flex-col gap-6'>
      <p className='text-sm opacity-70'>{t('mountedLibrary.sharedDescription')}</p>
      {error || requestError ? (
        <Callout.Root color='red' role='alert'>
          <Callout.Text>{error ? t('mountedLibrary.loadFailed') : requestError}</Callout.Text>
          <Button loading={isValidating} onClick={handleReloadStatus} size='1' type='button' variant='soft'>
            {t('common.retry')}
          </Button>
        </Callout.Root>
      ) : null}
      {settingsSaved ? <p className='text-sm' role='status'>{t('mountedLibrary.settingsSaved')}</p> : null}

      <section>
        <SettingsTitle>
          <span aria-hidden className='icon-[mdi--folder-sync]' />
          {t('mountedLibrary.index')}
        </SettingsTitle>
        <Card>
          <div aria-busy={scanning} className='flex flex-col gap-3' data-testid='mounted-library-status'>
            <div className='grid gap-2 text-sm sm:grid-cols-3'>
              <span>{t('mountedLibrary.indexedCount', { count: data.indexed })}</span>
              <span>{t('mountedLibrary.unavailableCount', { count: data.unavailable })}</span>
              <span>{t('mountedLibrary.unsupportedCount', { count: data.unsupported })}</span>
            </div>
            <p className='text-xs opacity-70'>
              {t('mountedLibrary.lastScan')}: <time dateTime={data.lastSuccessfulScanAt}>{formatTime(data.lastSuccessfulScanAt)}</time>
            </p>
            <p className='text-sm opacity-70'>{t('mountedLibrary.scanDescription')}</p>
            {scanning ? <p role='status'>{t('mountedLibrary.scanning')}</p> : null}
            {data.error ? <p className='text-sm text-(--red-11)' role='alert'>{data.error}</p> : null}
            {data.warnings.length > 0 ? (
              <details className='text-sm'>
                <summary className='cursor-pointer'>{t('mountedLibrary.warnings', { count: data.warnings.length })}</summary>
                <ul className='mt-2 list-disc space-y-1 pl-5'>
                  {data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
                </ul>
              </details>
            ) : null}
            <div>
              <Button disabled={busy} loading={isMutating && activeAction === 'scan'} onClick={handleScan} type='button' variant='soft'>
                <span aria-hidden className='icon-[mdi--folder-search]' />
                {t('mountedLibrary.scan')}
              </Button>
            </div>
          </div>

          <form className='mt-5 flex flex-col gap-2 border-t border-(--gray-5) pt-4' key={data.settings.scanIntervalSeconds} onSubmit={handleIntervalSubmit}>
            <label className='text-sm font-medium' htmlFor='mounted-library-scan-interval'>{t('mountedLibrary.scanInterval')}</label>
            <div className='flex flex-wrap items-center gap-3'>
              <TextField.Root
                aria-describedby='mounted-library-interval-description'
                className='w-36'
                defaultValue={data.settings.scanIntervalSeconds}
                disabled={isLoading || Boolean(error) || isUpdating || isMutating || data.running}
                id='mounted-library-scan-interval'
                inputMode='numeric'
                max={86_400}
                min={0}
                name='scanIntervalSeconds'
                required
                step={1}
                type='number'
              />
              <Button disabled={isLoading || Boolean(error) || isUpdating || isMutating || data.running} loading={isUpdating} type='submit' variant='soft'>
                {t('mountedLibrary.saveInterval')}
              </Button>
            </div>
            <p className='text-xs opacity-70' id='mounted-library-interval-description'>{t('mountedLibrary.intervalDescription')}</p>
          </form>
        </Card>
      </section>

      <section>
        <SettingsTitle>
          <span aria-hidden className='icon-[mdi--database-sync]' />
          {t('mountedLibrary.metadata')}
        </SettingsTitle>
        <Card>
          <div className='flex flex-col gap-4'>
            <div>
              <label className='flex items-center justify-between gap-3 text-sm font-medium'>
                {t('mountedLibrary.automaticMetadata')}
                <Switch
                  aria-describedby='mounted-library-automatic-description'
                  aria-label={t('mountedLibrary.automaticMetadata')}
                  checked={data.automaticMetadataEnabled}
                  disabled={isLoading || Boolean(error) || isUpdating || isMutating || !data.networkAllowed}
                  onCheckedChange={handleAutomaticMetadata}
                />
              </label>
              <p className='mt-2 text-xs opacity-70' id='mounted-library-automatic-description'>{t('mountedLibrary.automaticDescription')}</p>
            </div>
            {!data.networkAllowed ? (
              <Callout.Root color='amber'><Callout.Text>{t('mountedLibrary.networkDisabled')}</Callout.Text></Callout.Root>
            ) : null}
            <p className='text-sm opacity-70'>{t('mountedLibrary.metadataDescription')}</p>
            <div aria-busy={refreshing} aria-live='polite' className='text-sm' data-testid='mounted-library-metadata-status'>
              {refreshing ? <p>{t('mountedLibrary.refreshing')}</p> : null}
              <p>{t('mountedLibrary.metadataProgress', { processed: data.metadata.processed, total: data.metadata.total, errors: data.metadata.errors })}</p>
              <p className='mt-1 text-xs opacity-70'>
                {t('mountedLibrary.lastMetadata')}: <time dateTime={data.metadata.lastFinishedAt}>{formatTime(data.metadata.lastFinishedAt)}</time>
              </p>
              {data.metadata.error ? <p className='mt-2 text-(--red-11)' role='alert'>{data.metadata.error}</p> : null}
            </div>
            <div className='flex flex-wrap gap-3'>
              <Button disabled={busy || !data.networkAllowed || data.indexed === 0} loading={isMutating && activeAction === 'metadata'} onClick={handleMetadata} type='button' variant='soft'>
                <span aria-hidden className='icon-[mdi--database-refresh]' />
                {t('mountedLibrary.refreshMetadata')}
              </Button>
              <Button disabled={busy || !data.networkAllowed || data.indexed === 0} loading={isMutating && activeAction === 'artwork'} onClick={handleArtwork} type='button' variant='soft'>
                <span aria-hidden className='icon-[mdi--image-refresh]' />
                {t('mountedLibrary.retryArtwork')}
              </Button>
            </div>
          </div>
        </Card>
      </section>
    </div>
  )
}
