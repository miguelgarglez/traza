import { WebHaptics } from 'web-haptics'

// iOS-capable haptics: navigator.vibrate on Android, a hidden switch click
// on iOS Safari. User-switchable — rides fire detents, so it must be able
// to go quiet. Persisted per browser.
const KEY = 'traza.haptics'
let enabled = localStorage.getItem(KEY) !== '0'
let haptics: WebHaptics | null = null

export function hapticsOn() {
  return enabled
}

export function setHaptics(v: boolean) {
  enabled = v
  localStorage.setItem(KEY, v ? '1' : '0')
  if (!v) haptics?.cancel()
}

export function haptic(pattern: 'nudge' | 'success' | 'buzz') {
  if (!enabled) return
  try {
    haptics ??= new WebHaptics()
    void haptics.trigger(pattern)
  } catch {
    /* unsupported environment — haptics stay silent */
  }
}
