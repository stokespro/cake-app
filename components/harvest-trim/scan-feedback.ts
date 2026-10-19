// Tiny "got it" feedback for a camera read: a short vibration where the browser
// has one (Android) and a brief beep. iOS Safari has no vibrate, and WebAudio
// only sounds if the context was created or resumed during a tap, so
// primeScanFeedback() is called from the camera button's click handler.

let ctx: AudioContext | null = null

type AudioContextCtor = typeof AudioContext

function audioContext(): AudioContext | null {
  if (ctx) return ctx
  try {
    const Ctor: AudioContextCtor | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext
    if (!Ctor) return null
    ctx = new Ctor()
    return ctx
  } catch {
    return null
  }
}

/** Call from a user gesture so a later beep is allowed to sound. */
export function primeScanFeedback(): void {
  const c = audioContext()
  if (c && c.state === 'suspended') void c.resume().catch(() => {})
}

export function scanFeedback(): void {
  try {
    navigator.vibrate?.(40)
  } catch {
    // not supported; ignore
  }
  const c = audioContext()
  if (!c) return
  try {
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.frequency.value = 1100
    gain.gain.value = 0.08
    osc.connect(gain)
    gain.connect(c.destination)
    osc.start()
    osc.stop(c.currentTime + 0.09)
  } catch {
    // audio is a nicety
  }
}
