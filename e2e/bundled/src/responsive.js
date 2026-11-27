import { fitNav } from './nav.js'

const other = document.documentElement.dataset.other
console.info(`laid out at ${innerWidth}px`)
setTimeout(function layout() {
  fitNav(innerWidth)
}, 0)
fetch(`${other}/not-shared`).catch(() => {})
