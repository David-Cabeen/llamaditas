// SyncWave WebRTC Peer-to-Peer Mesh Manager (High Stability, Low-Latency & Mobile Optimized)
const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    { urls: "stun:stun4.l.google.com:19302" }
  ],
  iceCandidatePoolSize: 10
};

class WebRTCManager {
  constructor() {
    this.localStream = null;
    this.screenStream = null;
    this.isScreenSharing = false;
    this.peers = new Map();
    this.signalSender = null;
    this.myPeerId = null;

    // Audio Modifiers
    this.otgMode = false;
    this.isMonitoring = false;
    this.monitorAudioEl = new Audio();
    this.monitorAudioEl.autoplay = true;
    this.monitorAudioEl.muted = true;

    // Callbacks
    this.onRemoteTrackAdded = null;
    this.onRemotePeerDisconnected = null;
    this.onConnectionQuality = null;
  }

  setOtgMode(enabled) {
    this.otgMode = enabled;
  }

  // Intercept WebRTC connection data to disable Opus voice compression
  _optimizeSdpForMusic(sdp) {
    if (!this.otgMode) return sdp; // Leave standard voice settings if OTG is off

    // Find the Opus payload type in the SDP
    const match = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
    if (!match) return sdp;
    const opusPayload = match[1];

    // Force high-bitrate stereo and explicitly disable DTX (speech detection gating)
    const fmtpRegex = new RegExp(`a=fmtp:${opusPayload} (.*)`, 'i');
    return sdp.replace(fmtpRegex, (fullMatch, currentParams) => {
      return `a=fmtp:${opusPayload} ${currentParams}; stereo=1; sprop-stereo=1; maxaveragebitrate=510000; cbr=1; usedtx=0`;
    });
  }

  getAudioConstraints(deviceId = null) {
    let baseConstraints = {};
    
    if (this.otgMode) {
      // Force raw audio using 'exact' strictness to prevent Chromium fallbacks
      baseConstraints = {
        echoCancellation: { exact: false },
        noiseSuppression: { exact: false },
        autoGainControl: { exact: false },
        googEchoCancellation: false,
        googAutoGainControl: false,
        googNoiseSuppression: false,
        googHighpassFilter: false,
        googTypingNoiseDetection: false,
        googNoiseReduction: false,
        channelCount: 2
      };
    } else {
      baseConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      };
    }

    if (deviceId && deviceId !== "default") {
      baseConstraints.deviceId = { exact: deviceId };
    }
    return baseConstraints;
  }

  setLocalMonitor(enabled) {
    this.isMonitoring = enabled;
    if (enabled && this.localStream) {
      this.monitorAudioEl.srcObject = this.localStream;
      this.monitorAudioEl.muted = false;
      this.monitorAudioEl.play().catch(e => console.warn("Monitor play prevented:", e));
    } else {
      this.monitorAudioEl.muted = true;
      this.monitorAudioEl.srcObject = null;
    }
  }

  async initLocalMedia(cameraDefaultOn = false) {
    const mobileVideoConstraints = {
      facingMode: "user",
      width: { ideal: 1280 },
      height: { ideal: 720 }
    };

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: mobileVideoConstraints,
        audio: this.getAudioConstraints()
      });
    } catch (err) {
      console.warn("[WebRTC] Primary camera constraints rejected. Fallback to default video:", err);
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: this.getAudioConstraints()
        });
      } catch (err2) {
        console.warn("[WebRTC] Camera unavailable, falling back to audio only:", err2);
        try {
          this.localStream = await navigator.mediaDevices.getUserMedia({
            video: false,
            audio: this.getAudioConstraints()
          });
        } catch (err3) {
          console.error("[WebRTC] Media acquisition completely rejected:", err3);
          throw err3;
        }
      }
    }

    if (!cameraDefaultOn && this.localStream) {
      this.localStream.getVideoTracks().forEach(track => { track.enabled = false; });
    }

    if (this.isMonitoring) {
      this.monitorAudioEl.srcObject = this.localStream;
      this.monitorAudioEl.muted = false;
    }

    return this.localStream;
  }

  setSignalingSender(senderFn, myPeerId) {
    this.signalSender = senderFn;
    this.myPeerId = myPeerId;
  }

  getOrCreatePeer(peerId, peerInfo = {}) {
    if (this.peers.has(peerId)) return this.peers.get(peerId);

    console.log(`[WebRTC] Initializing RTCPeerConnection for ${peerId}`);
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const peerData = {
      pc,
      candidateQueue: [],
      remoteStream: new MediaStream(),
      info: peerInfo
    };

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.sendSignal(peerId, "candidate", {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex
        });
      }
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0];
      let isScreen = false;

      if (stream) {
        if (!peerData.mainStreamId) peerData.mainStreamId = stream.id;
        if (stream.id !== peerData.mainStreamId && event.track.kind === "video") {
          isScreen = true;
          peerData.screenStream = stream;
        }
      }

      if (isScreen) {
        console.log(`[WebRTC] Received SCREEN track from ${peerId}`);
      } else {
        console.log(`[WebRTC] Received CAMERA/MIC track from ${peerId}`);
        peerData.remoteStream.addTrack(event.track);
      }

      if (this.onRemoteTrackAdded) {
        this.onRemoteTrackAdded(peerId, isScreen ? peerData.screenStream : peerData.remoteStream, peerData.info, isScreen);
      }

      if (event.track.kind === "audio" && window.audioMixer && !isScreen) {
        window.audioMixer.attachPeerStream(peerId, peerData.remoteStream);
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (this.onConnectionQuality) this.onConnectionQuality(peerId, pc.iceConnectionState);
      if (pc.iceConnectionState === "failed") pc.restartIce();
    };

    this.peers.set(peerId, peerData);
    return peerData;
  }

  async switchMicrophone(deviceId) {
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: this.getAudioConstraints(deviceId)
      });
      const newAudioTrack = newStream.getAudioTracks()[0];

      const oldTrack = this.localStream.getAudioTracks()[0];
      if (oldTrack) oldTrack.stop();

      this.localStream.removeTrack(oldTrack);
      this.localStream.addTrack(newAudioTrack);

      this.replaceAudioTrackOnAllPeers(newAudioTrack);

      if (this.isMonitoring) {
        this.monitorAudioEl.srcObject = this.localStream;
        this.monitorAudioEl.play().catch(e => console.warn(e));
      }

      if (window.audioMixer) {
        window.audioMixer.attachLocalMic(this.localStream);
      }

      // Force renegotiation with connected peers so the new music-grade SDP parameters take effect
      this.peers.forEach((peer, peerId) => {
        this.createAndSendOffer(peerId);
      });

    } catch (err) {
      console.error("Failed to switch microphone:", err);
    }
  }

  async createAndSendOffer(targetPeerId) {
    const peer = this.getOrCreatePeer(targetPeerId);
    try {
      const offer = await peer.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      
      // Inject Music Mode SDP parameters before setting local description
      offer.sdp = this._optimizeSdpForMusic(offer.sdp); 
      
      await peer.pc.setLocalDescription(offer);
      this.sendSignal(targetPeerId, "offer", { type: offer.type, sdp: offer.sdp });
    } catch (err) {
      console.error(`[WebRTC] Error creating offer for ${targetPeerId}:`, err);
    }
  }

  async handleSignal(fromPeerId, signalType, payload) {
    const peer = this.getOrCreatePeer(fromPeerId);
    const { pc } = peer;

    try {
      if (signalType === "offer") {
        const rtcDesc = new RTCSessionDescription({ type: payload.type || "offer", sdp: payload.sdp || payload });
        await pc.setRemoteDescription(rtcDesc);

        while (peer.candidateQueue.length > 0) {
          const cand = peer.candidateQueue.shift();
          await pc.addIceCandidate(cand).catch(e => console.warn(e));
        }

        const answer = await pc.createAnswer();
        
        // Inject Music Mode SDP parameters before answering
        answer.sdp = this._optimizeSdpForMusic(answer.sdp);
        
        await pc.setLocalDescription(answer);
        this.sendSignal(fromPeerId, "answer", { type: answer.type, sdp: answer.sdp });

      } else if (signalType === "answer") {
        const rtcDesc = new RTCSessionDescription({ type: payload.type || "answer", sdp: payload.sdp || payload });
        await pc.setRemoteDescription(rtcDesc);

        while (peer.candidateQueue.length > 0) {
          const cand = peer.candidateQueue.shift();
          await pc.addIceCandidate(cand).catch(e => console.warn(e));
        }

      } else if (signalType === "candidate") {
        const candidateData = payload.candidate ? payload : { candidate: payload };
        if (candidateData.candidate) {
          const candidate = new RTCIceCandidate(candidateData);
          if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(candidate).catch(e => console.warn(e));
          } else {
            peer.candidateQueue.push(candidate);
          }
        }
      }
    } catch (err) {
      console.error(`[WebRTC] Error handling signal ${signalType} from ${fromPeerId}:`, err);
    }
  }

  sendSignal(targetPeerId, signalType, payload) {
    if (this.signalSender) this.signalSender(targetPeerId, signalType, payload);
  }

  toggleAudio(enabled) {
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => { track.enabled = enabled; });
    }
  }

  toggleVideo(enabled) {
    if (this.localStream) {
      this.localStream.getVideoTracks().forEach(track => { track.enabled = enabled; });
    }
  }

  async toggleScreenShare() {
    if (this.isScreenSharing) {
      if (this.screenStream) {
        this.screenStream.getTracks().forEach(t => t.stop());
        this.screenStream = null;
      }
      this.isScreenSharing = false;

      this.peers.forEach((peer, peerId) => {
        const senders = peer.pc.getSenders();
        const screenSender = senders.find(s => s.track && s.track.id === this._screenTrackId);
        if (screenSender) {
          peer.pc.removeTrack(screenSender);
          this.createAndSendOffer(peerId);
        }
      });

      const micTrack = this.localStream ? this.localStream.getAudioTracks()[0] : null;
      if (micTrack) this.replaceAudioTrackOnAllPeers(micTrack);
      
      return false;
    } else {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== "function") {
        if (window.syncApp) window.syncApp.showToast("El uso compartido de pantalla no es compatible en este dispositivo.");
        return false;
      }

      try {
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const screenVideoTrack = this.screenStream.getVideoTracks()[0];
        if (!screenVideoTrack) return false;
        this._screenTrackId = screenVideoTrack.id;

        screenVideoTrack.onended = () => {
          if (window.syncApp) window.syncApp.onScreenShareEnded();
          this.toggleScreenShare();
        };

        this.peers.forEach((peer, peerId) => {
          peer.pc.addTrack(screenVideoTrack, this.screenStream);
          this.createAndSendOffer(peerId);
        });

        const screenAudioTracks = this.screenStream.getAudioTracks();
        if (screenAudioTracks.length > 0 && window.audioMixer) {
          const mixedAudioTrack = window.audioMixer.createMixedStream(this.localStream, this.screenStream);
          if (mixedAudioTrack) this.replaceAudioTrackOnAllPeers(mixedAudioTrack);
        }

        this.isScreenSharing = true;
        return true;
      } catch (err) {
        return false;
      }
    }
  }

  replaceVideoTrackOnAllPeers(newTrack) {
    this.peers.forEach(({ pc }) => {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
      if (sender) sender.replaceTrack(newTrack);
    });
  }

  replaceAudioTrackOnAllPeers(newTrack) {
    this.peers.forEach(({ pc }) => {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === "audio");
      if (sender) sender.replaceTrack(newTrack);
    });
  }

  removePeer(peerId) {
    if (this.peers.has(peerId)) {
      const { pc } = this.peers.get(peerId);
      pc.close();
      this.peers.delete(peerId);

      if (window.audioMixer) window.audioMixer.detachPeerStream(peerId);
      if (this.onRemotePeerDisconnected) this.onRemotePeerDisconnected(peerId);
    }
  }

  closeAll() {
    this.peers.forEach(({ pc }) => pc.close());
    this.peers.clear();
    if (this.localStream) this.localStream.getTracks().forEach(t => t.stop());
    if (this.screenStream) this.screenStream.getTracks().forEach(t => t.stop());
  }
}

window.webrtcManager = new WebRTCManager();