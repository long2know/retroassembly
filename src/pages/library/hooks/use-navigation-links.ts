import { sortBy } from 'es-toolkit'
import { useTranslation } from 'react-i18next'
import { generatePath, useLocation, useMatch } from 'react-router'
import { platformMap } from '#@/constants/platform.ts'
import { useGlobalLoaderData } from '#@/pages/hooks/use-global-loader-data.ts'
import { routes } from '#@/pages/routes.ts'
import { getPlatformIcon } from '#@/utils/client/library.ts'
import { useIsDemo } from './use-demo.ts'
import { usePlatform } from './use-platform.ts'
import { usePreference } from './use-preference.ts'

const demoPlatforms = ['gba', 'gbc', 'genesis', 'nes', 'snes']
export function useNavigationLinks() {
  const { t } = useTranslation()
  const { currentUser } = useGlobalLoaderData()
  const { preference } = usePreference()
  const platform = usePlatform()
  const location = useLocation()
  const collectionMatch = useMatch(routes.libraryCollection)
  const isDemo = useIsDemo()
  const platforms = isDemo ? demoPlatforms : preference.ui.platforms

  const platformLinks = platforms.map((platform) => ({
    iconClass: '',
    iconUrl: getPlatformIcon(platform),
    name: platform,
    text: t(platformMap[platform].displayNameI18nKey),
    to: getPlatformLink(platform),
  }))

  const sortedPlatformLinks = sortBy(platformLinks, ['name'])

  const groups = [
    {
      links: isDemo
        ? [
            {
              iconClass: 'icon-[mdi--home]',
              iconUrl: '',
              name: 'home',
              text: t('common.games'),
              to: generatePath(routes.demoHome),
            },
          ]
        : [
            {
              iconClass: 'icon-[mdi--home]',
              iconUrl: '',
              name: 'home',
              text: t('nav.home'),
              to: generatePath(routes.libraryHome),
            },
            {
              iconClass: 'icon-[mdi--bookshelf]',
              iconUrl: '',
              name: 'library',
              text: t('common.games'),
              to: generatePath(routes.libraryRoms),
            },
            {
              iconClass: 'icon-[mdi--heart]',
              iconUrl: '',
              name: 'favorites',
              text: t('nav.favorites'),
              to: generatePath(routes.libraryFavorites),
            },
            ...(currentUser
              ? [
                  {
                    iconClass: 'icon-[mdi--folder-multiple-outline]',
                    iconUrl: '',
                    name: 'collections',
                    text: t('nav.collections'),
                    to: routes.libraryCollections,
                  },
                ]
              : []),
            {
              iconClass: 'icon-[mdi--history]',
              iconUrl: '',
              name: 'history',
              text: t('nav.history'),
              to: generatePath(routes.libraryHistory),
            },
          ],
      title: '',
    },
    { links: sortedPlatformLinks, title: t('common.platform_other') },
  ]

  function isActive(link: string) {
    return (
      location.pathname === link ||
      getPlatformLink(platform?.name) === link ||
      (link === routes.libraryCollections && Boolean(collectionMatch))
    )
  }

  function getPlatformLink(platform?: string) {
    if (!platform) {
      return ''
    }
    return generatePath(isDemo ? routes.demoPlatform : routes.libraryPlatform, { platform })
  }

  return { groups, isActive }
}
