export function total(items) {
  if (items.length === 0) {
    throw new TypeError('thrown from a bundle')
  }
  return items.reduce((sum, item) => sum + item, 0)
}
