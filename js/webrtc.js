// Llamaditas WebRTC Peer-to-Peer Mesh Manager
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
    this.videoConstraints = { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } };
    this.screenStream = null;
    this.isScreenSharing = false;
    this.peers = new Map();
    this.signalSender = null;
    this.myPeerId = null;

    this.otgMode = false;
    this.isMonitoring = false;

    this._mirroredStream = null;
    this._mirroredVideoTrack = null;
    this._rawMirrorVideo = null;
    this._mirrorAnimId = null;

    this.onRemoteTrackAdded = null;
    this.onRemotePeerDisconnected = null;
    this.onConnectionQuality = null;
  }

  setOtgMode(enabled) {
    this.otgMode = enabled;
  }

  _optimizeSdpForMusic(sdp) {
    if (!this.otgMode) return sdp; 
    const match = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
    if (!match) return sdp;
    const opusPayload = match[1];

    const fmtpRegex = new RegExp(`a=fmtp:${opusPayload} (.*)`, 'i');
    return sdp.replace(fmtpRegex, (fullMatch, currentParams) => {
      return `a=fmtp:${opusPayload} ${currentParams}; stereo=1; sprop-stereo=1; maxaveragebitrate=510000; cbr=1; usedtx=0`;
    });
  }

  getAudioConstraints(deviceId = null) {
    let baseConstraints = {};
    
    if (this.otgMode) {
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
    if (window.audioMixer) {
        window.audioMixer.setLocalMonitor(enabled);
    }
  }

  async initLocalMedia(cameraDefaultOn = false) {
    const videoConstraints = cameraDefaultOn ? this.videoConstraints : false;

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: this.getAudioConstraints() });
    } catch (err) {
      if (!cameraDefaultOn) {
        console.error("[WebRTC] Audio acquisition rejected:", err);
        throw err;
      }

      console.warn("[WebRTC] Primary camera constraints rejected. Falling back to default video:", err);
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: this.getAudioConstraints() });
      } catch (err2) {
        console.warn("[WebRTC] Camera unavailable, falling back to audio only:", err2);
        try {
          this.localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: this.getAudioConstraints() });
        } catch (err3) {
          console.error("[WebRTC] Media acquisition completely rejected:", err3);
          throw err3;
        }
      }
    }

    if (this.isMonitoring && window.audioMixer) {
      window.audioMixer.setLocalMonitor(true);
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
      screenStream: null,
      cameraSender: null,
      screenSender: null,
      remoteCameraTrackId: null,
      remoteScreenTrackId: null,
      info: peerInfo
    };

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        const sender = pc.addTrack(track, this.localStream);
        if (track.kind === "video") {
          peerData.cameraSender = sender;
        }
      });
    }

    if (!peerData.cameraSender) {
      try {
        const trans = pc.addTransceiver("video", {
          direction: "sendrecv",
          streams: this.localStream ? [this.localStream] : []
        });
        peerData.cameraSender = trans.sender;
      } catch(e) {}
    }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.sendSignal(peerId, "candidate", { candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex });
      }
    };

    pc.ontrack = (event) => {
      const track = event.track;
      const stream = event.streams[0];

      if (track.kind === "audio") {
        peerData.remoteStream.addTrack(track);
        if (window.audioMixer) {
          window.audioMixer.attachPeerStream(peerId, peerData.remoteStream);
        }
        if (this.onRemoteTrackAdded) {
          this.onRemoteTrackAdded(peerId, peerData.remoteStream, peerData.info, false);
        }
        return;
      }

      // VIDEO TRACK: identify whether it is screen sharing or camera
      // Priority: explicit track ID match > existing screen stream track identity > transceiver index fallback
      let isScreen = false;

      if (peerData.remoteScreenTrackId && track.id === peerData.remoteScreenTrackId) {
        // Explicit signal told us this is the screen track
        isScreen = true;
      } else if (peerData.remoteCameraTrackId && track.id === peerData.remoteCameraTrackId) {
        // Explicit signal told us this is the camera track
        isScreen = false;
      } else if (peerData.screenStream && peerData.screenStream.getVideoTracks().some(t => t.id === track.id)) {
        // This track already lives in the established screenStream — keep it as screen
        isScreen = true;
      } else if (peerData.remoteScreenTrackId && track.id !== peerData.remoteScreenTrackId) {
        // We know the screen track ID; anything different must be camera
        isScreen = false;
      } else if (!peerData.remoteScreenTrackId) {
        // No screen track has been announced — this must be a camera track
        isScreen = false;
      } else {
        // Last-resort fallback: transceiver ordering (unreliable when multiple senders exist)
        const videoTransceivers = pc.getTransceivers().filter(t => t.receiver && t.receiver.track && t.receiver.track.kind === "video");
        const idx = videoTransceivers.findIndex(t => t.receiver.track && t.receiver.track.id === track.id);
        isScreen = (idx > 0);
      }

      console.log(`[WebRTC] ontrack from ${peerId}: kind=${track.kind}, id=${track.id}, isScreen=${isScreen}, remoteScreenTrackId=${peerData.remoteScreenTrackId}, remoteCameraTrackId=${peerData.remoteCameraTrackId}`);

      if (isScreen) {
        // Lock in the screen track ID so future tracks won't be confused with it
        if (!peerData.remoteScreenTrackId) peerData.remoteScreenTrackId = track.id;

        // Build / update the dedicated screenStream — never reuse remoteStream
        if (!peerData.screenStream || peerData.screenStream === peerData.remoteStream) {
          peerData.screenStream = new MediaStream();
        }
        if (!peerData.screenStream.getVideoTracks().some(t => t.id === track.id)) {
          // Remove any stale video tracks from previous screenshare sessions
          peerData.screenStream.getVideoTracks().forEach(t => peerData.screenStream.removeTrack(t));
          peerData.screenStream.addTrack(track);
        }
        track.onended = () => {
          peerData.screenStream = null;
          peerData.remoteScreenTrackId = null;
          if (window.llamaditasApp) window.llamaditasApp.handlePeerScreenState(peerId, false);
        };
        if (this.onRemoteTrackAdded) {
          this.onRemoteTrackAdded(peerId, peerData.screenStream, peerData.info, true);
        }
      } else {
        // CAMERA TRACK — lock in camera track ID
        if (!peerData.remoteCameraTrackId) peerData.remoteCameraTrackId = track.id;

        if (!peerData.remoteStream) peerData.remoteStream = new MediaStream();
        // Replace stale video tracks in remoteStream but never touch screenStream
        peerData.remoteStream.getVideoTracks().forEach(t => {
          if (t.id !== track.id) peerData.remoteStream.removeTrack(t);
        });
        if (!peerData.remoteStream.getTracks().includes(track)) {
          peerData.remoteStream.addTrack(track);
        }
        if (this.onRemoteTrackAdded) {
          this.onRemoteTrackAdded(peerId, peerData.remoteStream, peerData.info, false);
        }
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (this.onConnectionQuality) this.onConnectionQuality(peerId, pc.iceConnectionState);
      // Reiniciar ICE no solo al fallar, sino al desconectarse parcialmente para asegurar fluidez
      if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
          pc.restartIce();
      }
    };

    this.peers.set(peerId, peerData);
    return peerData;
  }

  async switchMicrophone(deviceId) {
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ audio: this.getAudioConstraints(deviceId) });
      const newAudioTrack = newStream.getAudioTracks()[0];

      const oldTrack = this.localStream.getAudioTracks()[0];
      if (oldTrack) oldTrack.stop();

      this.localStream.removeTrack(oldTrack);
      this.localStream.addTrack(newAudioTrack);

      this.replaceAudioTrackOnAllPeers(newAudioTrack);

      if (window.audioMixer) window.audioMixer.attachLocalMic(this.localStream);

      this.peers.forEach((peer, peerId) => this.createAndSendOffer(peerId));
    } catch (err) {
      console.error("Failed to switch microphone:", err);
    }
  }

  async createAndSendOffer(targetPeerId) {
    const peer = this.getOrCreatePeer(targetPeerId);
    try {
      const offer = await peer.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      offer.sdp = this._optimizeSdpForMusic(offer.sdp); 
      await peer.pc.setLocalDescription(offer);
      this.sendSignal(targetPeerId, "offer", {
        type: offer.type,
        sdp: offer.sdp,
        cameraTrackId: this.localStream?.getVideoTracks()[0]?.id || null,
        screenTrackId: this._screenTrackId || null
      });
    } catch (err) {
      console.error(`[WebRTC] Error creating offer for ${targetPeerId}:`, err);
    }
  }

  async handleSignal(fromPeerId, signalType, payload) {
    const peer = this.getOrCreatePeer(fromPeerId);
    const { pc } = peer;

    try {
      if (signalType === "offer") {
        if (payload.cameraTrackId !== undefined) peer.remoteCameraTrackId = payload.cameraTrackId;
        if (payload.screenTrackId !== undefined) peer.remoteScreenTrackId = payload.screenTrackId;

        const rtcDesc = new RTCSessionDescription({ type: payload.type || "offer", sdp: payload.sdp || payload });
        await pc.setRemoteDescription(rtcDesc);

        while (peer.candidateQueue.length > 0) {
          const cand = peer.candidateQueue.shift();
          await pc.addIceCandidate(cand).catch(e => console.warn(e));
        }

        const answer = await pc.createAnswer();
        answer.sdp = this._optimizeSdpForMusic(answer.sdp);
        await pc.setLocalDescription(answer);
        this.sendSignal(fromPeerId, "answer", {
          type: answer.type,
          sdp: answer.sdp,
          cameraTrackId: this.localStream?.getVideoTracks()[0]?.id || null,
          screenTrackId: this._screenTrackId || null
        });

      } else if (signalType === "answer") {
        if (payload.cameraTrackId !== undefined) peer.remoteCameraTrackId = payload.cameraTrackId;
        if (payload.screenTrackId !== undefined) peer.remoteScreenTrackId = payload.screenTrackId;

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

  async toggleVideo(enabled) {
    if (!this.localStream) return false;

    if (!enabled) {
      this.stopLocalMirror();
      this.localStream.getVideoTracks().forEach(track => {
        track.stop();
        this.localStream.removeTrack(track);
      });
      this.peers.forEach((peerData) => {
        if (peerData.cameraSender) {
          peerData.cameraSender.replaceTrack(null).catch(() => {});
        }
      });
      return true;
    }

    try {
      const cameraStream = await navigator.mediaDevices.getUserMedia({ video: this.videoConstraints });
      const videoTrack = cameraStream.getVideoTracks()[0];
      if (!videoTrack) return false;
      this.localStream.addTrack(videoTrack);
      this._cameraTrackId = videoTrack.id;

      // Initialize mirrored stream for local display & PiP
      this.getLocalDisplayStream();

      this.peers.forEach((peerData, peerId) => {
        if (peerData.cameraSender) {
          peerData.cameraSender.replaceTrack(videoTrack).catch(() => {});
        } else {
          peerData.cameraSender = peerData.pc.addTrack(videoTrack, this.localStream);
        }
        this.createAndSendOffer(peerId);
      });
      return true;
    } catch (err) {
      console.warn("[WebRTC] Camera could not be enabled:", err);
      return false;
    }
  }

  stopLocalMirror() {
    if (this._mirrorAnimId) {
      cancelAnimationFrame(this._mirrorAnimId);
      this._mirrorAnimId = null;
    }
    if (this._rawMirrorVideo) {
      try { this._rawMirrorVideo.srcObject = null; } catch(e) {}
      this._rawMirrorVideo = null;
    }
    if (this._mirroredVideoTrack) {
      try { this._mirroredVideoTrack.stop(); } catch(e) {}
      this._mirroredVideoTrack = null;
    }
    this._mirroredStream = null;
  }

  getLocalDisplayStream() {
    if (!this.localStream || this.localStream.getVideoTracks().length === 0) {
      return this.localStream;
    }
    const videoTrack = this.localStream.getVideoTracks()[0];
    if (!videoTrack || videoTrack.readyState !== "live") {
      return this.localStream;
    }

    if (this._mirroredStream && this._mirroredVideoTrack && this._mirroredVideoTrack.readyState === "live") {
      return this._mirroredStream;
    }

    this.stopLocalMirror();

    const rawVideo = document.createElement("video");
    rawVideo.autoplay = true;
    rawVideo.playsInline = true;
    rawVideo.muted = true;
    rawVideo.srcObject = new MediaStream([videoTrack]);
    rawVideo.play().catch(() => {});
    this._rawMirrorVideo = rawVideo;

    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d");

    const draw = () => {
      if (!videoTrack || videoTrack.readyState !== "live") {
        return;
      }
      if (rawVideo.videoWidth > 0 && rawVideo.videoHeight > 0) {
        if (canvas.width !== rawVideo.videoWidth || canvas.height !== rawVideo.videoHeight) {
          canvas.width = rawVideo.videoWidth;
          canvas.height = rawVideo.videoHeight;
        }
        ctx.save();
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(rawVideo, 0, 0, canvas.width, canvas.height);
        ctx.restore();
      }
      this._mirrorAnimId = requestAnimationFrame(draw);
    };
    this._mirrorAnimId = requestAnimationFrame(draw);

    let stream;
    try {
      stream = canvas.captureStream(30);
    } catch(err) {
      console.warn("[WebRTC] canvas.captureStream error:", err);
      return this.localStream;
    }

    this._mirroredStream = stream;
    this._mirroredVideoTrack = stream.getVideoTracks()[0];

    videoTrack.addEventListener("ended", () => {
      this.stopLocalMirror();
    }, { once: true });

    return stream;
  }

  async toggleScreenShare() {
    if (this.isScreenSharing) {
      if (this.screenStream) {
        this.screenStream.getTracks().forEach(t => t.stop());
        this.screenStream = null;
      }
      this.isScreenSharing = false;
      this._screenTrackId = null;

      this.peers.forEach((peerData, peerId) => {
        if (peerData.screenSender) {
          try {
            peerData.pc.removeTrack(peerData.screenSender);
          } catch(e) {}
          peerData.screenSender = null;
          this.createAndSendOffer(peerId);
        }
      });

      const micTrack = this.localStream ? this.localStream.getAudioTracks()[0] : null;
      if (micTrack) this.replaceAudioTrackOnAllPeers(micTrack);

      if (window.supabaseP2P) {
        window.supabaseP2P.sendScreenState(false, null);
      }
      
      return false;
    } else {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== "function") {
        if (window.llamaditasApp) window.llamaditasApp.showToast("El uso compartido de pantalla no es compatible en este dispositivo.");
        return false;
      }

      try {
        // Pausar YouTube si está reproduciéndose para que no suene en la pantalla compartida
        if (window.ytSync && window.ytSync.isPlaying) {
          window.ytSync.togglePlayPause();
          if (window.llamaditasApp) window.llamaditasApp.showToast("Música pausada para compartir pantalla limpiamente");
        }

        // Establecer constraints para capturar audio de pantalla/sistema sin incluir la llamada
        const screenConstraints = {
          video: {
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
            frameRate: { ideal: 15, max: 30 }
          },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: false,
            suppressLocalAudioPlayback: false
          },
          selfBrowserSurface: "exclude",
          systemAudio: "include"
        };
        
        this.screenStream = await navigator.mediaDevices.getDisplayMedia(screenConstraints);
        const screenVideoTrack = this.screenStream.getVideoTracks()[0];
        if (!screenVideoTrack) return false;
        this._screenTrackId = screenVideoTrack.id;

        screenVideoTrack.onended = () => {
          if (window.llamaditasApp) window.llamaditasApp.onScreenShareEnded();
          this.toggleScreenShare();
        };

        this.peers.forEach((peerData, peerId) => {
          peerData.screenSender = peerData.pc.addTrack(screenVideoTrack, this.screenStream);
          this.createAndSendOffer(peerId);
        });

        const screenAudioTracks = this.screenStream.getAudioTracks();
        if (screenAudioTracks.length > 0 && window.audioMixer) {
          const mixedAudioTrack = window.audioMixer.createMixedStream(this.localStream, this.screenStream);
          if (mixedAudioTrack) this.replaceAudioTrackOnAllPeers(mixedAudioTrack);
        }

        this.isScreenSharing = true;
        if (window.supabaseP2P) {
          window.supabaseP2P.sendScreenState(true, this._screenTrackId);
        }
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