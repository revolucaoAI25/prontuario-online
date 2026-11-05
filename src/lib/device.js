// Phones and tablets: a touch screen as the main pointer, on a small screen.
// The Financeiro screen stays on the clinic's computers.
export function isMobileDevice() {
  try {
    return window.matchMedia('(pointer: coarse)').matches && Math.min(window.screen.width, window.screen.height) < 900;
  } catch {
    return false;
  }
}
