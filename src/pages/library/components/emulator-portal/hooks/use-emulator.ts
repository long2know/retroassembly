import { attemptAsync, delay, noop } from 'es-toolkit'
import NoSleep from 'nosleep.js'
import { Nostalgist } from 'nostalgist'
import { useEffect, useMemo } from 'react'
import { useLoaderData, useRevalidator } from 'react-router'
import useSWRImmutable from 'swr/immutable'
import { client } from '#@/api/client.ts'
import type { CoreName } from '#@/constants/core.ts'
import type { Rom } from '#@/controllers/roms/get-roms.ts'
import type { State } from '#@/controllers/states/get-states.ts'
import {
  useEmulatorLaunched,
  useIsFullscreen,
  useLaunchButton,
  useSpatialNavigationPaused,
} from '#@/pages/library/atoms.ts'
import { useIsDemo } from '#@/pages/library/hooks/use-demo.ts'
import { useRom } from '#@/pages/library/hooks/use-rom.ts'
import { getFileUrl } from '#@/pages/library/utils/file.ts'
import { focus, offCancel, onCancel } from '#@/pages/library/utils/spatial-navigation.ts'
import { getCDNUrl } from '#@/utils/isomorphic/cdn.ts'
import { getGlobalCSSVars } from '#@/utils/isomorphic/misc.ts'
import { usePreference } from '../../../hooks/use-preference.ts'
import { useEmulatorSession } from '../emulator-session-provider.tsx'

type NostalgistOption = Parameters<typeof Nostalgist.prepare>[0]
type RetroarchConfig = Partial<NostalgistOption['retroarchConfig']>

const defaultRetroarchConfig: RetroarchConfig = {
  fastforward_ratio: 10,
  input_player1_analog_dpad_mode: 1,
  input_player2_analog_dpad_mode: 1,
  input_player3_analog_dpad_mode: 1,
  input_player4_analog_dpad_mode: 1,
  rewind_granularity: 4,
  rgui_menu_color_theme: 1,
  run_ahead_frames: 1,
  video_gpu_screenshot: true,
  // @ts-expect-error this option is not yet listed in types
  video_viewport_bias_y: 0.1,
}

let noSleep: NoSleep
const originalGetUserMedia = globalThis.navigator?.mediaDevices?.getUserMedia?.bind(globalThis.navigator.mediaDevices)
export function useEmulator() {
  const rom: Rom = useRom()
  const { core: playbackCore, state } = useLoaderData<{ core?: CoreName; state?: State | null }>()
  const { preference } = usePreference()
  const { activeEmulator, emulatorGamepadMapping, setActiveEmulator } = useEmulatorSession()
  const [launched, setLaunched] = useEmulatorLaunched()
  const isDemo = useIsDemo()
  const { revalidate } = useRevalidator()
  const [isFullscreen, setIsFullscreen] = useIsFullscreen()
  const [launchButton] = useLaunchButton()
  const [, setSpatialNavigationPaused] = useSpatialNavigationPaused()

  const romUrl = isDemo
    ? // @ts-expect-error we can guarantee the platform is supported here
      getCDNUrl(`retrobrews/${{ genesis: 'md' }[rom.platform] || rom.platform}-games`, rom.fileName)
    : getFileUrl(rom.fileId) || ''
  const core = activeEmulator?.core ?? playbackCore ?? preference.emulator.platform[rom.platform].core
  const romId = activeEmulator?.romId ?? rom.id
  const resumeState = state?.core === core ? state : undefined

  const platformShader = preference.emulator.platform[rom.platform].shader
  const shader =
    platformShader === 'inherit' ? preference.emulator.shader : (platformShader ?? preference.emulator.shader)

  const romObject = useMemo(
    () => ({ fileContent: romUrl, fileName: rom.fileName.split('/').at(-1) || rom.fileName }),
    [rom, romUrl],
  )
  const bios = preference.emulator.platform[rom.platform].bioses.map(({ fileId, fileName }) => ({
    fileContent: getFileUrl(fileId),
    fileName,
  }))
  const playbackOptions: NostalgistOption = useMemo(
    () => ({
      bios,
      core,
      retroarchConfig: {
        ...defaultRetroarchConfig,
        ...preference.input.keyboardMapping,
        ...emulatorGamepadMapping,
        // this might be a bug of retroarch's emscripten build, y plus and y minus are swapped
        input_player1_l_y_minus: preference.input.keyboardMapping.input_player1_l_y_plus,
        input_player1_l_y_plus: preference.input.keyboardMapping.input_player1_l_y_minus,
        rewind_buffer_size: ['mupen64plus_next', 'pcsx_rearmed'].includes(core) ? 100 : 20,
        rewind_enable: preference.emulator.platform[rom.platform].rewindEnabled,
        run_ahead_enabled: !['mupen64plus_next', 'pcsx_rearmed'].includes(core),
        video_smooth: preference.emulator.videoSmooth,
      },
      retroarchCoreConfig: preference.emulator.core[core],
      rom: romObject,
      shader,
      state: resumeState?.fileId ? getFileUrl(resumeState.fileId) : undefined,
    }),
    [romObject, bios, core, preference, emulatorGamepadMapping, shader, resumeState?.fileId, rom.platform],
  )
  const options = activeEmulator?.options ?? playbackOptions

  const {
    data: preparedEmulator,
    error,
    isValidating,
    mutate: prepare,
  } = useSWRImmutable(rom.mountedSource?.unsupportedReason ? null : options, () => Nostalgist.prepare(options))

  const emulator = activeEmulator?.emulator ?? preparedEmulator
  const isPreparing = !rom || isValidating

  async function launch({ withState }: { withState?: boolean } = {}) {
    if (
      !emulator ||
      activeEmulator ||
      isPreparing ||
      rom.mountedSource?.unsupportedReason ||
      (withState && !resumeState)
    ) {
      return
    }

    if (!withState) {
      emulator.getEmulator().on('beforeLaunch', () => {
        try {
          //@ts-expect-error Using an undocumented API here. There should be a way to do this.
          emulator.getEmscriptenFS().unlink(`${emulator.getEmulator().stateFilePath}.auto`)
        } catch {}
      })
    }

    const canvas = emulator.getCanvas()
    canvas.setAttribute('tabindex', '-1')
    canvas.dataset.snFocusStyle = JSON.stringify({ display: 'none' })
    focus(canvas)

    setActiveEmulator({ core, emulator, options, romId })
    setLaunched(true)

    if (!isDemo) {
      await client.launch_records.$post({ form: { core, rom: romId } })
    }
  }

  async function start() {
    if (!emulator || !rom) {
      return
    }
    try {
      // @ts-expect-error an ad-hoc patch for disabling request for camera access
      globalThis.navigator.mediaDevices.getUserMedia = null
    } catch {}
    await emulator.start()
    try {
      globalThis.navigator.mediaDevices.getUserMedia = originalGetUserMedia
    } catch {}
    const canvas = emulator.getCanvas()
    if (canvas) {
      canvas.style.opacity = '1'
      const cssVars = getGlobalCSSVars(preference)
      if (cssVars['--game-saturate'] !== '100%') {
        canvas.style.filter = `saturate(var(--game-saturate))`
      }
      focus('canvas')
    }

    if (preference.emulator.fullscreen) {
      await toggleFullscreen()
    }
    onCancel(noop)
    noSleep ||= new NoSleep()
    await noSleep.enable()

    // ad-hoc patch for mupen64plus_next
    if (core === 'mupen64plus_next') {
      await delay(0)
      emulator.sendCommand('PAUSE_TOGGLE')
      await delay(0)
      emulator.sendCommand('PAUSE_TOGGLE')
    }
  }

  async function exit({ reloadAfterExit = false } = {}) {
    const status = emulator?.getStatus() || ''
    if (['paused', 'running'].includes(status)) {
      emulator?.exit()
      setLaunched(false)
      noSleep.disable()
      const promises: Promise<void>[] = []
      if (document.fullscreenElement) {
        promises.push(document.exitFullscreen())
      }
      await attemptAsync(() => Promise.all(promises))
      setSpatialNavigationPaused(false)
      setIsFullscreen(false)
      focus(launchButton)
      offCancel()
      await attemptAsync(prepare)
      setActiveEmulator(null)
      if (reloadAfterExit) {
        await revalidate()
      }
    }
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
        setIsFullscreen(false)
      } else {
        await document.body.requestFullscreen()
        setIsFullscreen(true)
      }
    } catch {}

    if (emulator) {
      focus(emulator.getCanvas())
    }
  }

  useEffect(() => {
    const abortController = new AbortController()
    document.body.addEventListener(
      'fullscreenchange',
      () => {
        setIsFullscreen(document.fullscreenElement === document.body)
      },
      { signal: abortController.signal },
    )
    return () => {
      abortController.abort()
    }
  })

  return {
    core,
    emulator,
    error,
    exit,
    isFullscreen,
    isPreparing,
    launch,
    launched,
    prepare,
    resumeState,
    romId,
    setLaunched,
    start,
    toggleFullscreen,
  }
}
