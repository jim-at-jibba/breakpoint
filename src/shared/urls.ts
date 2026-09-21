export function isWebUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const url = URL.parse(value)
  return url?.protocol === 'http:' || url?.protocol === 'https:'
}
