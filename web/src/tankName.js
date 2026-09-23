import { usePolling } from './api.js'

// The tank's name, as the customer typed it in setup. Everything that used
// to say "Reef Tank" says this instead: the home card, the tank view, the
// Settings tile, and the header, where it sits between the date and the
// gear. Polled slowly - it changes once.
export function useTankName() {
  const [tank] = usePolling('/api/tank/latest', 60000)
  return tank?.name ?? 'Reef Tank'
}
