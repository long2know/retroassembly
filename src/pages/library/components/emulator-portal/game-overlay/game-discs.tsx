import { Button } from '@radix-ui/themes'
import { useId, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { PlaylistPlayback } from '#@/pages/library/utils/mounted-playlist.ts'
import { useGameOverlay } from '../hooks/use-game-overlay.ts'

export function GameDiscs({ playback }: Readonly<{ playback: PlaylistPlayback }>) {
  const { t } = useTranslation()
  const title = useId()
  const active = useSyncExternalStore(playback.subscribe, playback.getDisc)
  const { isPending, setIsPending } = useGameOverlay()
  const [failed, setFailed] = useState(false)

  async function handleSelect(index: number) {
    if (!active || active === index || isPending) {
      return
    }
    setFailed(false)
    setIsPending(true)
    try {
      await playback.select(index)
    } catch {
      setFailed(true)
    } finally {
      setIsPending(false)
    }
  }

  return (
    <section>
      <h3 className='mb-2 flex items-center gap-2 text-xl font-semibold text-white' id={title}>
        <span className='icon-[mdi--disc] size-6' />
        {t('emulator.playlistDiscs')}
      </h3>
      <fieldset aria-busy={isPending} aria-labelledby={title} className='flex flex-wrap gap-2'>
        {playback.playlist.discs.map((disc, index) => (
          <Button
            aria-pressed={active === index + 1}
            className='text-white! focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white'
            data-sn-enabled
            disabled={isPending || !active}
            key={disc.path}
            onClick={() => handleSelect(index + 1)}
            type='button'
            variant={active === index + 1 ? 'solid' : 'outline'}
          >
            {t('emulator.playlistDisc', { number: index + 1 })}
          </Button>
        ))}
      </fieldset>
      {failed || !active ? (
        <p className='mt-2 text-sm text-red-300' role='alert'>
          {t('error.failedToChangeDisc')}
        </p>
      ) : null}
    </section>
  )
}
