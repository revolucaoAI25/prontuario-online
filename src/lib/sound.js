// Short two-tone chime for new messages (no audio file needed), plus a
// system notification when the tab is in the background.
let context;
let lastChime = 0;

function audio() {
  context ??= new (window.AudioContext || window.webkitAudioContext)();
  return context;
}

// Browsers keep audio muted until the person interacts with the page: the
// first click or key press anywhere unlocks it (and asks, once, whether the
// system may show message notifications).
export function installSoundUnlock() {
  const unlock = () => {
    try {
      audio().resume();
    } catch {
      // no audio support
    }
    if (window.Notification?.permission === 'default') window.Notification.requestPermission().catch(() => {});
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

export function playChime() {
  const now = Date.now();
  if (now - lastChime < 1200) return; // one chime for a burst of messages
  lastChime = now;
  try {
    const ctx = audio();
    if (ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;
    for (const [i, freq] of [880, 1320].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + i * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.25, t + i * 0.14 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.14 + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t + i * 0.14);
      osc.stop(t + i * 0.14 + 0.4);
    }
  } catch {
    // audio blocked or unavailable
  }
}

// Shown only while the app is in another tab or minimized.
export function notify(title, body, onClick) {
  if (!document.hidden || window.Notification?.permission !== 'granted') return;
  try {
    const n = new window.Notification(title, { body: String(body ?? '').slice(0, 140), icon: '/favicon.png', tag: title });
    n.onclick = () => {
      window.focus();
      onClick?.();
      n.close();
    };
  } catch {
    // notifications unavailable
  }
}
