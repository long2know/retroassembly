import { Button, Callout, Card } from '@radix-ui/themes'
import { isPlainObject } from 'es-toolkit'
import { isMatch } from 'es-toolkit/compat'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useRevalidator } from 'react-router'
import useSWR, { useSWRConfig } from 'swr'
import { client, parseResponse } from '#@/api/client.ts'
import { platformMap } from '#@/constants/platform.ts'
import { useMountedLibrary } from '#@/pages/library/hooks/use-mounted-library.ts'
import { SettingsTitle } from '../settings-title.tsx'

const hiddenGames = client['mounted-library'].hidden

async function fetchHiddenGames() {
  return await parseResponse(hiddenGames.$get())
}

export function HiddenMountedGames({ userId }: Readonly<{ userId: string }>) {
  const { t } = useTranslation()
  const { revalidate } = useRevalidator()
  const { mutate: mutateCache } = useSWRConfig()
  const { mutate: revalidateStatus } = useMountedLibrary()
  const { data, error, isLoading, isValidating, mutate } = useSWR(
    { endpoint: 'mounted-library/hidden', method: 'get', userId },
    fetchHiddenGames,
    { dedupingInterval: 0, shouldRetryOnError: false },
  )
  const [restoringId, setRestoringId] = useState<string>()
  const [restoreFailed, setRestoreFailed] = useState(false)

  async function handleReload() {
    setRestoreFailed(false)
    await mutate()
  }

  async function handleRestore(id: string) {
    setRestoreFailed(false)
    setRestoringId(id)
    try {
      await parseResponse(hiddenGames[':id'].restore.$post({ param: { id } }))
      await Promise.all([
        mutate(),
        revalidateStatus(),
        revalidate(),
        mutateCache((key) => isPlainObject(key) && isMatch(key, { endpoint: 'roms/search' }), false),
      ])
    } catch {
      setRestoreFailed(true)
      await mutate()
    } finally {
      setRestoringId(undefined)
    }
  }

  return (
    <section aria-labelledby='hidden-mounted-games'>
      <SettingsTitle>
        <span aria-hidden className='icon-[mdi--eye-off-outline]' />
        <span id='hidden-mounted-games'>{t('mountedLibrary.hiddenGames')}</span>
      </SettingsTitle>
      <Card>
        <div className='flex flex-col gap-3'>
          <p className='text-sm opacity-70'>{t('mountedLibrary.hiddenDescription')}</p>
          {error || restoreFailed ? (
            <Callout.Root color='red' role='alert'>
              <Callout.Text>
                {t(error ? 'mountedLibrary.hiddenLoadFailed' : 'mountedLibrary.restoreFailed')}
              </Callout.Text>
              <Button loading={isValidating} onClick={handleReload} size='1' type='button' variant='soft'>
                {t('common.retry')}
              </Button>
            </Callout.Root>
          ) : null}
          {isLoading ? <output>{t('mountedLibrary.hiddenLoading')}</output> : null}
          {data?.length === 0 && !error ? <output className='text-sm'>{t('mountedLibrary.hiddenEmpty')}</output> : null}
          {data?.length && !error ? (
            <ul className='divide-y divide-(--gray-5)'>
              {data.map((game) => (
                <li className='flex flex-wrap items-center justify-between gap-3 py-3' key={game.id}>
                  <div className='min-w-0 wrap-anywhere'>
                    <p className='text-sm font-medium' id={`hidden-game-${game.id}`}>
                      {game.gameName || game.fileName}
                    </p>
                    <p className='text-xs opacity-70'>
                      {t(platformMap[game.platform].displayNameI18nKey)}
                      {game.gameName ? ` · ${game.fileName}` : null}
                    </p>
                    {game.available ? null : (
                      <p className='mt-1 text-xs text-(--amber-11)'>{t('mountedLibrary.hiddenUnavailable')}</p>
                    )}
                  </div>
                  <Button
                    aria-describedby={`hidden-game-${game.id}`}
                    disabled={!game.available || Boolean(restoringId) || isValidating}
                    loading={restoringId === game.id}
                    onClick={() => handleRestore(game.id)}
                    type='button'
                    variant='soft'
                  >
                    {t('mountedLibrary.restoreForEveryone')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Card>
    </section>
  )
}
