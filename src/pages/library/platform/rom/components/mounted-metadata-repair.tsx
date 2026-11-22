import { Button, Dialog, TextField } from '@radix-ui/themes'
import { useState, type SubmitEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useRevalidator } from 'react-router'
import { client, parseResponse } from '#@/api/client.ts'
import type { MountedArtworkOutcome, MountedMatchCandidate } from '#@/constants/mounted-library.ts'
import { useGlobalLoaderData } from '#@/pages/hooks/use-global-loader-data.ts'
import { DialogRoot } from '#@/pages/library/components/dialog-root.tsx'
import { useIsDemo } from '#@/pages/library/hooks/use-demo.ts'
import { useRom } from '#@/pages/library/hooks/use-rom.ts'
import { getRomGoodcodes } from '#@/utils/client/library.ts'

function errorKey(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  switch (code) {
    case 'catalog-provider':
    case 'catalog-unsupported':
    case 'invalid-candidate':
    case 'metadata-policy':
    case 'metadata-stale':
    case 'source-unavailable':
      return `game.metadataRepair.${code}` as const
    default:
      return 'game.metadataRepair.failed'
  }
}

export function MountedMetadataRepair() {
  const { t } = useTranslation()
  const { currentUser, env, mountedLibrary } = useGlobalLoaderData()
  const isDemo = useIsDemo()
  const rom = useRom()
  const { revalidate } = useRevalidator()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ candidates: MountedMatchCandidate[]; snapshot: string }>()
  const [operation, setOperation] = useState<'search' | 'select' | 'artwork'>()
  const [dialogError, setDialogError] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const [selected, setSelected] = useState<MountedArtworkOutcome>()
  const [retried, setRetried] = useState<MountedArtworkOutcome>()

  if (isDemo || !currentUser || !rom.mountedSource?.available) {
    return
  }

  const networkAllowed =
    mountedLibrary?.networkAllowed ?? env.RETROASSEMBLY_RUN_TIME_SHARED_ROM_METADATA_ENABLED === 'true'
  const { match, 'retry-artwork': retryArtwork } = client.roms[':id']
  const param = { id: rom.id }
  const lastArtwork = rom.mountedSource.artwork
  const artwork = retried ?? (lastArtwork === 'missing' || lastArtwork === 'error' ? lastArtwork : undefined)

  function handleOpenChange(open: boolean) {
    if (open) {
      setQuery(getRomGoodcodes(rom).rom.slice(0, 120))
      setResults(undefined)
      setDialogError(undefined)
      setSelected(undefined)
    }
  }

  async function handleSearch(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setOperation('search')
    setSelected(undefined)
    setResults(undefined)
    setDialogError(undefined)
    try {
      setResults(await parseResponse(match.$get({ param, query: { query: query.trim() } })))
    } catch (error) {
      setDialogError(t(errorKey(error)))
    } finally {
      setOperation(undefined)
    }
  }

  async function handleSelect(candidateId: string) {
    if (!results) {
      return
    }
    setOperation('select')
    setDialogError(undefined)
    try {
      const result = await parseResponse(match.$post({ json: { candidateId, snapshot: results.snapshot }, param }))
      setSelected(result.artwork)
      setResults(undefined)
      setRetried(undefined)
      setActionError(undefined)
      await revalidate()
    } catch (error) {
      setDialogError(t(errorKey(error)))
    } finally {
      setOperation(undefined)
    }
  }

  async function handleRetryArtwork() {
    setOperation('artwork')
    setRetried(undefined)
    setActionError(undefined)
    try {
      const result = await parseResponse(retryArtwork.$post({ param }))
      setRetried(result.artwork)
      await revalidate()
    } catch (error) {
      setActionError(t(errorKey(error)))
    } finally {
      setOperation(undefined)
    }
  }

  return (
    <div className='flex flex-col items-start gap-2 lg:px-8'>
      <div className='flex flex-wrap gap-2'>
        <DialogRoot onOpenChange={handleOpenChange}>
          <Dialog.Trigger>
            <Button disabled={!networkAllowed || operation === 'artwork'} type='button' variant='soft'>
              <span aria-hidden className='icon-[mdi--search]' />
              {t('game.metadataRepair.findMatch')}
            </Button>
          </Dialog.Trigger>
          <Dialog.Content className='lg:w-xl!'>
            <Dialog.Title>{t('game.metadataRepair.findMatch')}</Dialog.Title>
            <Dialog.Description className='mb-4'>{t('game.metadataRepair.description')}</Dialog.Description>
            <form className='flex items-center gap-2' onSubmit={handleSearch}>
              <TextField.Root
                aria-label={t('game.metadataRepair.query')}
                className='min-w-0 flex-1'
                disabled={Boolean(operation)}
                maxLength={120}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setResults(undefined)
                  setDialogError(undefined)
                  setSelected(undefined)
                }}
                required
                value={query}
              />
              <Button disabled={Boolean(operation) || !query.trim()} loading={operation === 'search'} type='submit'>
                {t('common.search')}
              </Button>
            </form>
            {dialogError ? (
              <p className='mt-4 text-(--red-11)' role='alert'>
                {dialogError}
              </p>
            ) : null}
            {selected ? (
              <output className='mt-4 block'>
                {t('game.metadataRepair.matchSaved')} {t(`game.metadataRepair.${selected}`)}
              </output>
            ) : null}
            {results?.candidates.length ? (
              <ul aria-label={t('game.metadataRepair.results')} className='mt-4 divide-y divide-(--gray-a6)'>
                {results.candidates.map(({ id, name, region, revision, shortName, year }) => {
                  const details = [shortName, region, revision, year].filter(Boolean).join(' · ')
                  return (
                    <li key={id}>
                      <Button
                        aria-label={t('game.metadataRepair.choose', { title: details ? `${name} · ${details}` : name })}
                        className='h-auto! min-h-12 w-full justify-start! px-2 text-left whitespace-normal'
                        disabled={Boolean(operation)}
                        onClick={() => handleSelect(id)}
                        type='button'
                        variant='ghost'
                      >
                        <span className='flex flex-col gap-0.5'>
                          <span>{name}</span>
                          {details ? <span className='text-xs text-(--gray-11)'>{details}</span> : null}
                        </span>
                        <span aria-hidden className='icon-[mdi--chevron-right] ml-auto shrink-0' />
                      </Button>
                    </li>
                  )
                })}
              </ul>
            ) : null}
            {results && !results.candidates.length ? (
              <output className='mt-4 block'>{t('game.metadataRepair.noMatch')}</output>
            ) : null}
            <div className='mt-4 flex justify-end'>
              <Dialog.Close>
                <Button disabled={operation === 'select'} variant='soft'>
                  {t('common.close')}
                </Button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </DialogRoot>

        <Button
          disabled={!networkAllowed || Boolean(operation)}
          loading={operation === 'artwork'}
          onClick={handleRetryArtwork}
          type='button'
          variant='soft'
        >
          <span aria-hidden className='icon-[mdi--image-refresh]' />
          {t('game.metadataRepair.retryCover')}
        </Button>
      </div>
      {networkAllowed ? null : <p className='text-sm'>{t('game.metadataRepair.metadata-policy')}</p>}
      {actionError ? (
        <p className='text-sm text-(--red-11)' role='alert'>
          {actionError}
        </p>
      ) : null}
      {artwork ? <output className='text-sm'>{t(`game.metadataRepair.${artwork}`)}</output> : null}
    </div>
  )
}
