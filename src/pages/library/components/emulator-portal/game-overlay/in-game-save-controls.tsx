import { useTranslation } from 'react-i18next'
import { useEmulator } from '../hooks/use-emulator.ts'
import { useGameOverlay } from '../hooks/use-game-overlay.ts'
import { GameOverlayButton } from './game-overlay-button.tsx'

export function InGameSaveControls() {
  const { t } = useTranslation()
  const { inGameSave, syncCartridgeSave } = useEmulator()
  const { isPending } = useGameOverlay()

  if (!inGameSave || inGameSave.phase === 'loading' || inGameSave.phase === 'unsupported') {
    return null
  }

  return (
    <div className='flex flex-wrap items-center gap-3'>
      <GameOverlayButton disabled={isPending || !('version' in inGameSave)} onClick={syncCartridgeSave}>
        <span className='icon-[mdi--cloud-upload-outline] size-5' />
        {t('emulator.inGameSave.action')}
      </GameOverlayButton>
      <output className='text-sm'>{t(`emulator.inGameSave.${inGameSave.phase}`)}</output>
    </div>
  )
}
