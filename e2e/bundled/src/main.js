import { total } from './checkout.js'

console.info('logged from a bundle')
setTimeout(function checkout() {
  total([])
}, 0)
