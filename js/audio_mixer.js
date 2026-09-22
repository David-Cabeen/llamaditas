// Llamaditas Granular Multi-Track Audio Mixer (Web Audio API)
class AudioMixer {
  constructor() {
    this.audioCtx = null;
    this.peerTracks = new Map();
    this.localAnalyser = null;
    this.localMicSource = null;
    this.localMonitorGain = null;
    this.musicVolume = parseInt(localStorage.getItem("llamaditas_music_vol") || "70", 10);
    this.onSpeakerChange = null; 
    this.onLocalMicActivity = null; 
    this.monitorInterval = null;
    this.mixedDestination = null;
    this.speakingStates = new Map();
  }

  ensureContext() {
    if (!this.audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioContextClass();
    }
    if (this.audioCtx.state === "suspended") {
      this.audioCtx.resume();
    }
    if (!this.monitorInterval) {
      this.startVoiceActivityDetection();
    }
  }

  createMixedStream(micStream, screenStream) {
    this.ensureContext();
    this.mixedDestination = this.audioCtx.createMediaStreamDestination();

    if (micStream && micStream.getAudioTracks().length > 0) {
      try {
        const micSource = this.audioCtx.createMediaStreamSource(micStream);
        micSource.connect(this.mixedDestination);
      } catch (e) {
        console.warn("[Mixer] Error adding mic to mix:", e);
      }
    }

    if (screenStream && screenStream.getAudioTracks().length > 0) {
      try {
        const screenSource = this.audioCtx.createMediaStreamSource(screenStream);
        screenSource.connect(this.mixedDestination);
      } catch (e) {
        console.warn("[Mixer] Error adding system audio to mix:", e);
      }
    }

    return this.mixedDestination.stream.getAudioTracks()[0];
  }

  attachPeerStream(peerId, stream) {
    this.ensureContext();
    this.detachPeerStream(peerId);

    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) return;

    try {
      const audioStream = new MediaStream([audioTrack]);
      const sourceNode = this.audioCtx.createMediaStreamSource(audioStream);
      const gainNode = this.audioCtx.createGain();
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 256;

      const savedVol = parseInt(localStorage.getItem(`llamaditas_vol_${peerId}`) || "85", 10);
      const linear = savedVol / 100;
      gainNode.gain.value = linear === 0 ? 0 : Math.pow(linear, 2);

      sourceNode.connect(analyser);
      analyser.connect(gainNode);
      gainNode.connect(this.audioCtx.destination);

      this.peerTracks.set(peerId, { stream, sourceNode, gainNode, analyser, volume: savedVol, isMuted: false });
    } catch (err) {
      console.error(`[Mixer] Error routing peer stream:`, err);
    }
  }

  detachPeerStream(peerId) {
    if (this.peerTracks.has(peerId)) {
      const p = this.peerTracks.get(peerId);
      try {
        p.sourceNode.disconnect();
        p.gainNode.disconnect();
        p.analyser.disconnect();
      } catch (e) {}
      this.peerTracks.delete(peerId);
      this.speakingStates.delete(peerId);
    }
  }

  setPeerVolume(peerId, volumePercent) {
    const vol = Math.max(0, Math.min(150, parseInt(volumePercent, 10)));
    localStorage.setItem(`llamaditas_vol_${peerId}`, vol.toString());

    if (this.peerTracks.has(peerId)) {
      const p = this.peerTracks.get(peerId);
      p.volume = vol;
      if (!p.isMuted) {
        const linear = vol / 100;
        const gainValue = linear === 0 ? 0 : Math.pow(linear, 2);
        p.gainNode.gain.setTargetAtTime(gainValue, this.audioCtx.currentTime, 0.05);
      }
    }
    return vol;
  }

  getPeerVolume(peerId) {
    if (this.peerTracks.has(peerId)) {
      return this.peerTracks.get(peerId).volume;
    }
    return parseInt(localStorage.getItem(`llamaditas_vol_${peerId}`) || "85", 10);
  }

  togglePeerMute(peerId) {
    if (this.peerTracks.has(peerId)) {
      const p = this.peerTracks.get(peerId);
      p.isMuted = !p.isMuted;
      const linear = p.volume / 100;
      const targetGain = p.isMuted ? 0 : (linear === 0 ? 0 : Math.pow(linear, 2));
      p.gainNode.gain.setTargetAtTime(targetGain, this.audioCtx.currentTime, 0.05);
      return p.isMuted;
    }
    return false;
  }

  attachLocalMic(stream) {
    this.ensureContext();
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) return;

    try {
      if (this.localMicSource) {
        this.localMicSource.disconnect();
      }

      const micStream = new MediaStream([audioTrack]);
      this.localMicSource = this.audioCtx.createMediaStreamSource(micStream);
      
      this.localAnalyser = this.audioCtx.createAnalyser();
      this.localAnalyser.fftSize = 256;
      this.localMicSource.connect(this.localAnalyser);

      if (!this.localMonitorGain) {
        this.localMonitorGain = this.audioCtx.createGain();
        this.localMonitorGain.gain.value = 0; 
        this.localMonitorGain.connect(this.audioCtx.destination);
      }
      
      this.localMicSource.connect(this.localMonitorGain);
    } catch (e) {
      console.warn("[Mixer] Error attaching local mic:", e);
    }
  }

  setLocalMonitor(enable) {
    this.ensureContext();
    if (this.localMonitorGain) {
      this.localMonitorGain.gain.setTargetAtTime(enable ? 1 : 0, this.audioCtx.currentTime, 0.05);
    }
  }

  setMusicVolume(volumePercent) {
    const vol = Math.max(0, Math.min(100, parseInt(volumePercent, 10)));
    this.musicVolume = vol;
    clearTimeout(this.musicVolumePersistTimer);
    this.musicVolumePersistTimer = setTimeout(() => {
      localStorage.setItem("llamaditas_music_vol", this.musicVolume.toString());
    }, 250);
    
    if (window.ytSync?.player && typeof window.ytSync.player.setVolume === "function") {
       const linear = vol / 100;
       const logVol = linear === 0 ? 0 : Math.round(Math.pow(linear, 2) * 100);
       window.ytSync.player.setVolume(logVol);
    }
    return vol;
  }

  getMusicVolume() {
    return this.musicVolume;
  }

  startVoiceActivityDetection() {
    const buffer = new Uint8Array(128);

    this.monitorInterval = setInterval(() => {
      const now = Date.now();
      
      this.peerTracks.forEach((p, peerId) => {
        if (!p.analyser || p.isMuted) return;
        p.analyser.getByteFrequencyData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) {
          sum += buffer[i];
        }
        const avg = sum / buffer.length;
        const isSpeakingNow = avg > 25; 

        let state = this.speakingStates.get(peerId) || { speaking: false, lastSpoke: 0 };
        
        if (isSpeakingNow) {
            state.lastSpoke = now;
            if (!state.speaking) {
                state.speaking = true;
                if (this.onSpeakerChange) this.onSpeakerChange(peerId, true);
            }
        } else if (state.speaking && (now - state.lastSpoke > 800)) { 
            state.speaking = false;
            if (this.onSpeakerChange) this.onSpeakerChange(peerId, false);
        }
        
        this.speakingStates.set(peerId, state);
      });

      if (this.localAnalyser) {
        this.localAnalyser.getByteFrequencyData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) {
          sum += buffer[i];
        }
        const level = Math.min(100, Math.round((sum / buffer.length) * 1.6));
        if (this.onLocalMicActivity) {
          this.onLocalMicActivity(level);
        }
      }
    }, 120);
  }
}

window.audioMixer = new AudioMixer();