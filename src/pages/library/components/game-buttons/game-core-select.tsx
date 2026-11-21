import { Select, Text } from '@radix-ui/themes'
import { attemptAsync } from 'es-toolkit'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useRevalidator } from 'react-router'
import { client, parseResponse } from '#@/api/client.ts'
import { coreDisplayNameMap } from '#@/constants/core.ts'
import { platformMap } from '#@/constants/platform.ts'
import type { GameCorePreference } from '#@/controllers/preference/rom-core-preference.ts'
import type { Rom } from '#@/controllers/roms/get-roms.ts'

interface GameCoreSelectProps {
  gameCorePreference: GameCorePreference
  isPending: boolean
  rom: Pick<Rom, 'id' | 'platform'>
  setIsPending: (value: boolean) => void
}

export function GameCoreSelect({
  gameCorePreference: { override, platformCore },
  isPending,
  rom,
  setIsPending,
}: Readonly<GameCoreSelectProps>) {
  const { t } = useTranslation()
  const labelId = useId()
  const { revalidate, state } = useRevalidator()
  const [hasError, setHasError] = useState(false)
  const cores = platformMap[rom.platform].cores.toSorted((a, b) =>
    coreDisplayNameMap[a].localeCompare(coreDisplayNameMap[b]),
  )

  async function handleValueChange(value: string) {
    const core = value === 'default' ? null : cores.find((name) => name === value)
    if (isPending || state !== 'idle' || core === undefined || core === override) {
      return
    }

    setIsPending(true)
    setHasError(false)
    const [error] = await attemptAsync(async () => {
      await parseResponse(client.preference.roms[':id'].core.$put({ json: { core }, param: { id: rom.id } }))
      await revalidate()
    })
    setHasError(Boolean(error))
    setIsPending(false)
  }

  return (
    <div aria-busy={isPending}>
      <div className='flex flex-wrap items-center gap-2'>
        <Text id={labelId} size='2'>
          {t('emulator.gameCore')}
        </Text>
        <Select.Root
          disabled={isPending || state !== 'idle'}
          onValueChange={handleValueChange}
          value={override ?? 'default'}
        >
          <Select.Trigger aria-labelledby={labelId} data-sn-enabled />
          <Select.Content>
            <Select.Item value='default'>
              {t('emulator.gameCoreDefault', { core: coreDisplayNameMap[platformCore] })}
            </Select.Item>
            {cores.map((core) => (
              <Select.Item key={core} value={core}>
                {coreDisplayNameMap[core]}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </div>
      {hasError ? (
        <Text as='p' color='red' role='alert' size='2'>
          {t('emulator.gameCoreSaveFailed')}
        </Text>
      ) : null}
    </div>
  )
}
