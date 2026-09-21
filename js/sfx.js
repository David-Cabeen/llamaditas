// Llamaditas sound effects. Edit these presets to customize the interface sounds.
// Each preset is synthesized in the browser, so no audio files are required.
window.sfx = (() => {
  const presets = {
    toast: { notes: [880], duration: 0.09, volume: 0.035, type: "sine" },
    userJoin: { notes: [523.25, 659.25, 783.99], duration: 0.11, volume: 0.045, type: "sine" },
    userLeave: { notes: [392, 329.63, 261.63], duration: 0.12, volume: 0.04, type: "triangle" },
    callEnter: { notes: [392, 523.25, 659.25], duration: 0.14, volume: 0.05, type: "sine" },
    callExit: { notes: [659.25, 523.25, 392], duration: 0.14, volume: 0.045, type: "sine" },
    drawerOpen: { notes: [330, 440], duration: 0.1, volume: 0.035, type: "triangle" },
    drawerClose: { notes: [440, 330], duration: 0.1, volume: 0.03, type: "triangle" },
    menuOpen: { notes: [520], duration: 0.07, volume: 0.025, type: "sine" },
    menuClose: { notes: [390], duration: 0.07, volume: 0.02, type: "sine" },
    profileOpen: { notes: [440, 659], duration: 0.12, volume: 0.035, type: "sine" },
    profileClose: { notes: [659, 440], duration: 0.1, volume: 0.025, type: "sine" },
    layoutSelect: { notes: [740], duration: 0.08, volume: 0.03, type: "sine" },
    deckOn: { notes: [261.63, 329.63, 392], duration: 0.12, volume: 0.04, type: "sine" },
    deckOff: { notes: [392, 329.63, 261.63], duration: 0.12, volume: 0.04, type: "sine" },
    randomRoom: { notes: [220, 330, 440, 660, 880], duration: 0.06, volume: 0.035, type: "triangle"
}

  };

  let context = null;
  let muted = false;

  function getContext() {
    if (!context) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return null;
      context = new AudioContext();
    }
    if (context.state === "suspended") context.resume().catch(() => {});
    return context;
  }

  function play(name) {
    if (muted) return;
    const preset = presets[name];
    const audio = getContext();
    if (!preset || !audio) return;

    const start = audio.currentTime;
    preset.notes.forEach((frequency, index) => {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const noteStart = start + index * preset.duration * 0.82;
      oscillator.type = preset.type;
      oscillator.frequency.setValueAtTime(frequency, noteStart);
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(preset.volume, noteStart + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + preset.duration);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteStart + preset.duration + 0.02);
    });
  }

  function setMuted(value) {
    muted = Boolean(value);
  }

  return { presets, play, setMuted };
})();
