import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router'
import { routes } from '#@/pages/routes.ts'
import { useIsDemo } from './use-demo.ts'

export function useGameActions(canDeleteRom: boolean) {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const isDemo = useIsDemo()
  const isHistory = pathname === routes.libraryHistory
  const canDelete = !isDemo && (isHistory || canDeleteRom)

  const deleteAction = canDelete
    ? ({
        confirmDescription: t(isHistory ? 'dialog.confirmDeleteHistoryMessage' : 'dialog.confirmDeleteRomsMessage'),
        text: t(isHistory ? 'game.deleteFromHistory' : 'game.deleteRom'),
        type: isHistory ? 'launch_records' : 'roms',
      } as const)
    : undefined

  return { deleteAction, selectText: canDelete && !isHistory ? t('common.select') : undefined }
}
