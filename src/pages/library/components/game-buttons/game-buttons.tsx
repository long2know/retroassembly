import { Button, Callout, HoverCard } from '@radix-ui/themes'
import { clsx } from 'clsx'
import { type MouseEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useRevalidator } from 'react-router'
import { platformMap } from '#@/constants/platform.ts'
import type { GameCorePreference } from '#@/controllers/preference/rom-core-preference.ts'
import { useLaunchButton } from '#@/pages/library/atoms.ts'
import { useEmulator } from '#@/pages/library/components/emulator-portal/hooks/use-emulator.ts'
import { useFocusIndicator } from '#@/pages/library/hooks/use-focus-indicator.ts'
import { usePreference } from '#@/pages/library/hooks/use-preference.ts'
import { useRom } from '#@/pages/library/hooks/use-rom.ts'
import { getFileUrl } from '#@/pages/library/utils/file.ts'
import { LaunchButton } from '../../platform/rom/components/launch-button.tsx'
import { EmulatorPortal } from '../emulator-portal/emulator-portal.tsx'
import { EmulatorSessionProvider } from '../emulator-portal/emulator-session-provider.tsx'
import { BioseMissingMessage } from './biose-missing-message.tsx'
import { GameCoreSelect } from './game-core-select.tsx'

const isAppleMobile = /iphone|ipad|ipod/iu.test(navigator.userAgent)
const isChromeLike = /chrome/iu.test(navigator.userAgent)
const isMacLike = /macintosh/iu.test(navigator.userAgent)
const isAppleMobileDesktopMode =
  !isChromeLike && isMacLike && /safari/iu.test(navigator.userAgent) && screen.height <= 1366
const mayNeedsUserInteraction = isAppleMobile || isAppleMobileDesktopMode

export function GameButtons({ gameCorePreference }: Readonly<{ gameCorePreference?: GameCorePreference | null }>) {
  const rom = useRom()
  const { t } = useTranslation()
  const [isChangingCore, setIsChangingCore] = useState(false)

  const platformName = t(platformMap[rom.platform].displayNameI18nKey)

  if (rom.mountedSource?.unsupportedReason) {
    return (
      <Callout.Root>
        <Callout.Icon>
          <span className='icon-[mdi--warning]' />
        </Callout.Icon>
        <Callout.Text>{rom.mountedSource.unsupportedReason}</Callout.Text>
      </Callout.Root>
    )
  }

  return (
    <EmulatorSessionProvider>
      <div>
        <GameButtonsContent isChangingCore={isChangingCore} />
        {gameCorePreference ? (
          <div className='mt-3'>
            <GameCoreSelect
              gameCorePreference={gameCorePreference}
              isPending={isChangingCore}
              key={rom.id}
              rom={rom}
              setIsPending={setIsChangingCore}
            />
          </div>
        ) : null}
        {['psx', 'n64'].includes(rom.platform) ? (
          <div className='mt-1 text-sm opacity-60'>
            {t('platform.emulationExperimental', { platform: platformName })}
          </div>
        ) : null}
      </div>
    </EmulatorSessionProvider>
  )
}

function GameButtonsContent({ isChangingCore }: Readonly<{ isChangingCore: boolean }>) {
  const rom = useRom()
  const { t } = useTranslation()
  const { state: revalidationState } = useRevalidator()
  const { error, isPreparing, launch, prepare, resumeState: state } = useEmulator()
  const [, setLaunchButton] = useLaunchButton()
  const { syncStyle } = useFocusIndicator()
  const { preference } = usePreference()
  const isPending = isPreparing || isChangingCore || revalidationState !== 'idle'

  const { bioses } = preference.emulator.platform[rom.platform]

  const expectedBioses = platformMap[rom.platform].bioses
  const missingBioses = expectedBioses?.filter(
    (bios) => bios.required && !bioses?.some((b) => b.fileName === bios.name),
  )

  function handleClickCommon(event: MouseEvent<HTMLButtonElement>) {
    const button = event.currentTarget
    if (button) {
      setLaunchButton(button)
      button.blur()
      syncStyle()
    }
  }

  async function handleClickContinue(event: MouseEvent<HTMLButtonElement>) {
    if (isPending || (mayNeedsUserInteraction && !event?.clientX && !event?.clientY)) {
      event.preventDefault()
      event.stopPropagation()
      return
    }

    handleClickCommon(event)
    await launch({ withState: true })
  }

  async function handleClickStart(event: MouseEvent<HTMLButtonElement>) {
    if (isPending || (mayNeedsUserInteraction && !event?.clientX && !event?.clientY)) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    handleClickCommon(event)
    await launch()
  }

  async function handleClickRetry() {
    if (!isPending) {
      await prepare()
    }
  }

  if (missingBioses?.length) {
    return <BioseMissingMessage bioses={missingBioses} />
  }

  if (!isPending && error) {
    return (
      <div className='flex h-16 w-full items-center justify-center gap-2 rounded bg-(--accent-3) lg:w-80'>
        <span className='icon-[mdi--warning-decagram]' />
        <span className='text-sm opacity-60'>{t('error.failedToLoadEmulator')}</span>
        <Button onClick={handleClickRetry} size='1' type='button'>
          <span className='icon-[mdi--reload]' />
          {t('common.retry')}
        </Button>
      </div>
    )
  }

  return (
    <div className='flex w-full flex-col gap-4 xl:flex-row'>
      {state ? (
        <LaunchButton disabled={isPending} onClick={handleClickContinue}>
          <span
            className={clsx(
              'absolute left-10',
              isPending
                ? 'icon-[svg-spinners--180-ring]'
                : [
                    'size-6',
                    mayNeedsUserInteraction ? 'icon-[mdi--gesture-touch]' : 'icon-[mdi--arrow-u-right-top-bold]',
                  ],
            )}
          />
          <span className='flex-1 text-2xl font-semibold'>{t('common.continue')}</span>
          <HoverCard.Root>
            <HoverCard.Trigger>
              <img
                alt={t('common.state')}
                className='absolute right-3 size-10 rounded-sm border-2 border-white bg-neutral-200 object-cover shadow'
                src={getFileUrl(state.thumbnailFileId)}
              />
            </HoverCard.Trigger>
            <HoverCard.Content align='center' hideWhenDetached side='top' size='1'>
              <img
                alt={t('common.state')}
                className='size-48 cursor-pointer rounded-sm border-2 border-white bg-neutral-200 object-cover shadow'
                src={getFileUrl(state.thumbnailFileId)}
              />
            </HoverCard.Content>
          </HoverCard.Root>
        </LaunchButton>
      ) : null}

      <LaunchButton disabled={isPending} onClick={handleClickStart} variant={state ? 'outline' : 'solid'}>
        <span
          className={clsx(
            'absolute left-10',
            isPending
              ? 'icon-[svg-spinners--180-ring]'
              : ['size-6', mayNeedsUserInteraction ? 'icon-[mdi--gesture-touch]' : 'icon-[mdi--play]'],
          )}
        />
        <span className='flex-1 text-2xl font-semibold'>{t('emulator.start')}</span>
      </LaunchButton>

      <EmulatorPortal />
    </div>
  )
}
