import { Trans, useTranslation } from 'react-i18next'
import { useLoaderData, useLocation } from 'react-router'
import { metadata } from '#@/constants/metadata.ts'
import { routes } from '#@/pages/routes.ts'
import { getPlatformIcon } from '#@/utils/client/library.ts'
import { usePlatform } from '../../hooks/use-platform.ts'
import { UploadButton } from '../../platform/components/upload-button.tsx'
import { UploadSelectButton } from '../../platform/components/upload-select-button.tsx'
import { HomeLinkButton } from './home-link-button.tsx'

export function GameListEmpty() {
  const { t } = useTranslation()
  const { gameFilter } = useLoaderData<{ gameFilter?: string }>()
  const { pathname, search } = useLocation()
  const platform = usePlatform()

  const isLibrary = pathname === routes.libraryRoms || pathname === routes.libraryHome
  const isHistory = pathname === routes.libraryHistory
  const isFavorites = pathname === routes.libraryFavorites
  const favorite = new URLSearchParams(search).get('favorite') === '1'

  if (gameFilter) {
    return (
      <output className='flex flex-col items-center justify-center gap-2 py-16 text-sm text-(--gray-11) lg:text-xl'>
        <span aria-hidden className='icon-[mdi--package-variant] size-16 text-(--gray-8)' />
        {t('platformFilter.noMatches')}
      </output>
    )
  }

  return (
    <div className='flex flex-col items-center justify-center gap-2 py-16 text-sm lg:text-xl'>
      <span className='icon-[mdi--package-variant] size-32 text-zinc-300' />
      {isLibrary ? (
        <>
          <div className='text-(--gray-11)'>
            {t('home.welcomeWithDescription', {
              title: metadata.title,
            })}
          </div>
          <div className='inline-flex items-center gap-1 text-(--gray-11)'>
            <Trans
              components={{
                1: <UploadSelectButton variant='soft' />,
              }}
              i18nKey='empty.uploadRomsToGetStarted'
            />
          </div>
        </>
      ) : null}

      {isHistory ? (
        <>
          <div className='text-(--gray-11)'>{t('empty.noGamesPlayed')}</div>
          <div className='inline-flex items-center gap-1 text-(--gray-11)'>
            <Trans components={{ 1: <HomeLinkButton /> }} i18nKey='library.playSomeGamesFromLibrary' />
          </div>
        </>
      ) : null}

      {isFavorites ? <div className='text-(--gray-11)'>{t('empty.favoritesDescription')}</div> : null}

      {platform ? (
        <>
          <div className='flex items-center gap-1 text-(--gray-11)'>
            <Trans
              components={{
                1: (
                  <img
                    alt={t(platform.displayNameI18nKey)}
                    className='hidden size-7 lg:inline-block'
                    loading='lazy'
                    src={getPlatformIcon(platform.name)}
                  />
                ),
              }}
              i18nKey={favorite ? 'empty.noFavoriteGamesForPlatform' : 'empty.noGamesForPlatform'}
              values={{
                platform: t(platform.displayNameI18nKey),
              }}
            />
          </div>
          {favorite ? null : (
            <div className='flex items-center gap-1 text-(--gray-11)'>
              <Trans
                components={{
                  1: <UploadButton platform={platform?.name} variant='soft' />,
                }}
                i18nKey='empty.uploadRomsToGetStarted'
              />
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}
