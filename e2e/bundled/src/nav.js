export function fitNav(width) {
  if (width < 640) {
    throw new RangeError(`the nav does not fit in ${width}px`)
  }
  return width
}
