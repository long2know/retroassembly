import { Button, Callout, Card, Checkbox, CheckboxCards } from '@radix-ui/themes'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { platforms as allPlatforms } from '#@/constants/platform.ts'
import { useMountedLibrary } from '#@/pages/library/hooks/use-mounted-library.ts'
import { usePreference } from '#@/pages/library/hooks/use-preference.ts'
import { SettingsTitle } from '../settings-title.tsx'
import { UpdateButton } from '../update-button.tsx'
import { PlatformCheckboxItem } from './platform-checkbox-item.tsx'

const platforms = allPlatforms.filter((platform) => !['sega32x'].includes(platform.name))

export function PlatformSettings() {
  const { t } = useTranslation()
  const { isLoading: isUpdating, preference, update } = usePreference()
  const { data, enabled, error, isLoading, isValidating, mutate } = useMountedLibrary({ poll: true })
  const [hideEmpty, setHideEmpty] = useState(false)
  const [requestFailed, setRequestFailed] = useState(false)
  const selectablePlatforms = enabled ? allPlatforms : platforms
  const counts = new Map(data?.platforms.map((entry) => [entry.platform, entry]))
  const detectedPlatforms = data?.platforms.filter((entry) => entry.indexed > 0).map((entry) => entry.platform) || []
  const visiblePlatforms = selectablePlatforms.filter(
    (platform) => !enabled || !hideEmpty || !data || (counts.get(platform.name)?.indexed || 0) > 0,
  )

  async function handleEnableDetected() {
    if (!data || isUpdating || data.running || detectedPlatforms.length === 0) {
      return
    }
    setRequestFailed(false)
    try {
      await update({ ui: { platforms: detectedPlatforms } })
    } catch {
      setRequestFailed(true)
    }
  }

  async function handleReloadStatus() {
    try {
      await mutate()
    } catch {
      setRequestFailed(true)
    }
  }

  function handleHideEmpty(checked: boolean | 'indeterminate') {
    setHideEmpty(checked === true)
  }

  return (
    <div>
      <SettingsTitle>
        <span className='icon-[mdi--order-checkbox-ascending]' />
        {t('settings.enabledPlatforms')}
      </SettingsTitle>
      <Card>
        {enabled ? (
          <div className='mb-4 flex flex-col gap-3'>
            <p className='text-sm opacity-70'>{t('mountedLibrary.detectedDescription')}</p>
            <div className='flex flex-wrap items-center justify-between gap-3'>
              <Button
                disabled={
                  !data || Boolean(error) || isLoading || isUpdating || data.running || detectedPlatforms.length === 0
                }
                loading={isUpdating}
                onClick={handleEnableDetected}
                type='button'
                variant='soft'
              >
                <span aria-hidden className='icon-[mdi--folder-check]' />
                {t('mountedLibrary.enableDetected')}
              </Button>
              <label className='flex items-center gap-2 text-sm'>
                <Checkbox checked={hideEmpty} disabled={!data || Boolean(error)} onCheckedChange={handleHideEmpty} />
                {t('mountedLibrary.hideEmpty')}
              </label>
            </div>
            {!data && !error ? <output>{t('mountedLibrary.loading')}</output> : null}
            {error || requestFailed ? (
              <Callout.Root color='red' role='alert'>
                <Callout.Text>{t(error ? 'mountedLibrary.loadFailed' : 'mountedLibrary.requestFailed')}</Callout.Text>
                <Button loading={isValidating} onClick={handleReloadStatus} size='1' type='button' variant='soft'>
                  {t('common.retry')}
                </Button>
              </Callout.Root>
            ) : null}
            {data && detectedPlatforms.length === 0 ? (
              <p className='text-sm'>{t('mountedLibrary.noDetected')}</p>
            ) : null}
          </div>
        ) : null}

        <CheckboxCards.Root columns={{ initial: '1', md: '4' }} size='1' value={preference.ui.platforms}>
          {visiblePlatforms.map((platform) => (
            <PlatformCheckboxItem
              disabled={preference.ui.platforms.length < 2 && preference.ui.platforms.includes(platform.name)}
              indexed={enabled && data ? counts.get(platform.name)?.indexed || 0 : undefined}
              key={platform.name}
              platform={platform}
              unsupported={enabled && data ? counts.get(platform.name)?.unsupported || 0 : undefined}
            />
          ))}
        </CheckboxCards.Root>

        {enabled ? <p className='mt-3 text-xs opacity-70'>{t('mountedLibrary.compatibility')}</p> : null}

        <div className='mt-4 flex justify-end gap-4'>
          {selectablePlatforms.length > preference.ui.platforms.length ? (
            <UpdateButton preference={{ ui: { platforms: selectablePlatforms.map(({ name }) => name) } }}>
              <span className='icon-[mdi--checkbox-multiple-marked]' />
              {t('common.selectAll')}
            </UpdateButton>
          ) : null}

          <UpdateButton preference={{ ui: { platforms: null } }}>
            <span className='icon-[mdi--undo]' />
            {t('emulator.resetToDefaults')}
          </UpdateButton>
        </div>
      </Card>
    </div>
  )
}
