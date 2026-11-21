import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useIsDemo } from '#@/pages/library/hooks/use-demo.ts'
import { focus } from '#@/pages/library/utils/spatial-navigation.ts'
import { useEmulator } from '../hooks/use-emulator.ts'
import { useGameOverlay } from '../hooks/use-game-overlay.ts'
import { useGameStates } from '../hooks/use-game-states.ts'
import { GameOverlayButton } from './game-overlay-button.tsx'

export function GameOverlayButtons() {
  const { t } = useTranslation()
  const { emulator, exit, playlist } = useEmulator()
  const { saveManualState } = useGameStates()
  const { hide, isPending, setIsPending } = useGameOverlay()
  const isDemo = useIsDemo()
  const [saveFailed, setSaveFailed] = useState(false)

  async function handleClickResume() {
    await hide()
  }

  async function handleClickRestart() {
    await hide()
    emulator?.restart()
  }

  async function handleClickSaveState() {
    if (isPending) {
      return
    }
    setSaveFailed(false)
    setIsPending(true)
    try {
      await saveManualState()
      focus('.game-overlay button')
    } catch (error) {
      if (!playlist) {
        throw error
      }
      setSaveFailed(true)
    } finally {
      setIsPending(false)
    }
  }

  async function handleClickExit() {
    await hide()
    await exit({ reloadAfterExit: true })
  }

  async function handleClickSaveExit() {
    if (isPending) {
      return
    }
    setSaveFailed(false)
    setIsPending(true)
    try {
      await saveManualState()
      await hide()
      await exit({ reloadAfterExit: true })
    } catch (error) {
      if (!playlist) {
        throw error
      }
      setSaveFailed(true)
    } finally {
      setIsPending(false)
    }
  }

  return (
    <>
      <GameOverlayButton
        dataSnLeft='.game-overlay-buttons button:last-child'
        disabled={isPending}
        onClick={handleClickResume}
      >
        <span className='icon-[mdi--play] size-5' />
        {t('game.resume')}
      </GameOverlayButton>

      <GameOverlayButton disabled={isDemo || isPending} onClick={handleClickSaveState}>
        <span className='icon-[mdi--content-save] size-5' />
        {t('emulator.saveState')}
      </GameOverlayButton>

      <div className='hidden lg:block lg:flex-1' />

      <GameOverlayButton disabled={isPending} onClick={handleClickRestart}>
        <span className='icon-[mdi--restart] size-5' />
        {t('emulator.restart')}
      </GameOverlayButton>

      <GameOverlayButton disabled={isPending} onClick={handleClickExit}>
        <span className='icon-[mdi--exit-to-app] size-5' />
        {t('common.exit')}
      </GameOverlayButton>

      <GameOverlayButton
        dataSnRight='.game-overlay-buttons button:first-child'
        disabled={isDemo || isPending}
        onClick={handleClickSaveExit}
      >
        <span className='icon-[mdi--location-exit] size-5' />
        {t('emulator.saveAndExit')}
      </GameOverlayButton>
      {saveFailed ? (
        <p className='text-sm text-red-300' role='alert'>
          {t('error.failedToSavePlaylistState')}
        </p>
      ) : null}
    </>
  )
}
