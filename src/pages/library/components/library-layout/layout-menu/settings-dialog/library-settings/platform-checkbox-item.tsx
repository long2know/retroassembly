import { CheckboxCards } from '@radix-ui/themes'
import { useTranslation } from 'react-i18next'
import type { Platform } from '#@/constants/platform.ts'
import { usePreference } from '#@/pages/library/hooks/use-preference.ts'
import { getPlatformIcon } from '#@/utils/client/library.ts'

interface PlatformCheckboxItemProps {
  disabled: boolean
  indexed?: number
  platform: Platform
  unsupported?: number
}

export function PlatformCheckboxItem({
  disabled,
  indexed,
  platform,
  unsupported,
}: Readonly<PlatformCheckboxItemProps>) {
  const { t } = useTranslation()
  const { isLoading, preference, update } = usePreference()

  async function handleClick() {
    if (isLoading) {
      return
    }

    const platforms = new Set(preference.ui.platforms)
    if (platforms.has(platform.name)) {
      platforms.delete(platform.name)
    } else {
      platforms.add(platform.name)
    }
    await update({ ui: { platforms: [...platforms] } })
  }

  return (
    <CheckboxCards.Item
      aria-describedby={indexed === undefined ? undefined : `platform-status-${platform.name}`}
      aria-label={t(platform.displayNameI18nKey)}
      data-testid={`platform-option-${platform.name}`}
      disabled={isLoading || disabled}
      key={platform.name}
      onClick={handleClick}
      value={platform.name}
    >
      <div className='flex items-center gap-2 text-xs'>
        <img
          alt=''
          className='size-6 rounded object-contain object-center'
          loading='lazy'
          src={getPlatformIcon(platform.name)}
        />
        <div>
          <div>{t(platform.displayNameI18nKey)}</div>
          {indexed === undefined ? null : (
            <div className='mt-1 text-[11px] opacity-70' id={`platform-status-${platform.name}`}>
              <div data-testid={`platform-count-${platform.name}`}>
                {t('mountedLibrary.indexedCount', { count: indexed })}
              </div>
              {unsupported ? (
                <div data-testid={`platform-unsupported-${platform.name}`}>
                  {t('mountedLibrary.unsupportedCount', { count: unsupported })}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </CheckboxCards.Item>
  )
}
