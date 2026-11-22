import { getContext } from 'hono/context-storage'
import { platformMap, type PlatformName } from '#@/constants/platform.ts'
import { getRoms } from '#@/controllers/roms/get-roms.ts'
import { normalizePlatformGameFilter, platformGameFilterParam } from '#@/utils/isomorphic/platform-game-filter.ts'
import { getLibraryLoaderData } from '#@/utils/server/loader-data.ts'
import { getRomsQuery } from '#@/utils/server/misc.ts'
import PlatformPage from '../library/platform/page.tsx'
import type { Route } from './+types/library-platform.ts'

export async function loader({ params, url }: Route.LoaderArgs) {
  const { t } = getContext().var
  const platform = params.platform as PlatformName
  const romsQuery = getRomsQuery()
  const gameFilter = normalizePlatformGameFilter(url.searchParams.get(platformGameFilterParam))
  const { pagination, roms } = await getRoms({ ...romsQuery, gameFilter, platform })
  return await getLibraryLoaderData({
    favorite: romsQuery.favorite,
    gameFilter,
    pagination,
    platform,
    roms,
    title: t(platformMap[platform].displayNameI18nKey),
  })
}

export default function LibraryPlatformRoute() {
  return <PlatformPage />
}
