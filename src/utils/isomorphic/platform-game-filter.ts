export const platformGameFilterParam = 'filter'
export const platformGameFilterMaxLength = 128

export function normalizePlatformGameFilter(value: string | null) {
  return value?.trim().slice(0, platformGameFilterMaxLength).trimEnd() ?? ''
}
