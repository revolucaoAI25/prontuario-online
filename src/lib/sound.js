// Short two-tone chime for new internal messages (no audio file needed).
let context;

export function playChime() {
  try {
    context ??= new (window.AudioContext || window.webkitAudioContext)();
    const now = context.currentTime;
    for (const [i, freq] of [880, 1320].entries()) {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.25, now + i * 0.14 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.14 + 0.35);
      osc.connect(gain).connect(context.destination);
      osc.start(now + i * 0.14);
      osc.stop(now + i * 0.14 + 0.4);
    }
  } catch {
    // Browsers block audio until the first click on the page; ignore.
  }
}
