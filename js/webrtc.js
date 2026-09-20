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
    this.peers = new Map(); // peerId -> { pc, isPolite, makingOffer, candidateQueue, remoteStream, info }
    this.signalSender = null; // function(targetPeerId, signalType, payload)
    this.myPeerId = null;

    // Callbacks
    this.onRemoteTrackAdded = null;
    this.onRemotePeerDisconnected = null;
    this.onConnectionQuality = null;
  }

  async initLocalMedia(cameraDefaultOn = false) {
    const audioConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    };

    const mobileVideoConstraints = {
      facingMode: "user",
      width: { ideal: 1280 },
      height: { ideal: 720 }
    };

    try {
      // 1. Try ideal mobile constraints
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: mobileVideoConstraints,
        audio: audioConstraints
      });
    } catch (err) {
      console.warn("[WebRTC] Primary camera constraints rejected. Fallback to default video:", err);
      try {
        // 2. Fallback to basic video for mobile WebKit compatibility
        this.localStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: audioConstraints
        });
      } catch (err2) {
        console.warn("[WebRTC] Camera unavailable, falling back to audio only:", err2);
        try {
          // 3. Fallback to pure audio if camera permission denied or missing
          this.localStream = await navigator.mediaDevices.getUserMedia({
            video: false,
            audio: audioConstraints
          });
        } catch (err3) {
          console.error("[WebRTC] Media acquisition completely rejected:", err3);
          throw err3;
        }
      }
    }

    // Disable camera track if defaulted OFF
    if (!cameraDefaultOn && this.localStream) {
      this.localStream.getVideoTracks().forEach(track => {
        track.enabled = false;
      });
    }

    return this.localStream;
  }

  setSignalingSender(senderFn, myPeerId) {
    this.signalSender = senderFn;
    this.myPeerId = myPeerId;
  }

  getOrCreatePeer(peerId, peerInfo = {}) {
    if (this.peers.has(peerId)) {
      return this.peers.get(peerId);
    }

    console.log(`[WebRTC] Initializing RTCPeerConnection for ${peerId}`);
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const peerData = {
      pc,
      candidateQueue: [],
      remoteStream: new MediaStream(),
      info: peerInfo
    };

    // Attach local audio and video tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // ICE Candidate generation
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.sendSignal(peerId, "candidate", {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex
        });
      }
    };

    // Remote Track handling
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

    // Connection state monitoring
    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC] ICE state with ${peerId}: ${pc.iceConnectionState}`);
      if (this.onConnectionQuality) {
        this.onConnectionQuality(peerId, pc.iceConnectionState);
      }
      if (pc.iceConnectionState === "failed") {
        console.warn(`[WebRTC] ICE failed with ${peerId}. Restarting ICE...`);
        pc.restartIce();
      }
    };

    this.peers.set(peerId, peerData);
    return peerData;
  }

  async switchMicrophone(deviceId) {
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true }
      });
      const newAudioTrack = newStream.getAudioTracks()[0];

      const oldTrack = this.localStream.getAudioTracks()[0];
      if (oldTrack) oldTrack.stop();

      this.localStream.removeTrack(oldTrack);
      this.localStream.addTrack(newAudioTrack);

      this.replaceAudioTrackOnAllPeers(newAudioTrack);
    } catch (err) {
      console.error("Failed to switch microphone:", err);
    }
  }

  async createAndSendOffer(targetPeerId) {
    console.log(`[WebRTC] Creating explicit SDP offer for ${targetPeerId}`);
    const peer = this.getOrCreatePeer(targetPeerId);
    try {
      const offer = await peer.pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });
      await peer.pc.setLocalDescription(offer);

      this.sendSignal(targetPeerId, "offer", {
        type: offer.type,
        sdp: offer.sdp
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
        console.log(`[WebRTC] Handling offer from ${fromPeerId}`);
        const rtcDesc = new RTCSessionDescription({
          type: payload.type || "offer",
          sdp: payload.sdp || payload
        });

        await pc.setRemoteDescription(rtcDesc);

        while (peer.candidateQueue.length > 0) {
          const cand = peer.candidateQueue.shift();
          await pc.addIceCandidate(cand).catch(e => console.warn(e));
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        this.sendSignal(fromPeerId, "answer", {
          type: answer.type,
          sdp: answer.sdp
        });

      } else if (signalType === "answer") {
        console.log(`[WebRTC] Handling answer from ${fromPeerId}`);
        const rtcDesc = new RTCSessionDescription({
          type: payload.type || "answer",
          sdp: payload.sdp || payload
        });

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
    if (this.signalSender) {
      this.signalSender(targetPeerId, signalType, payload);
    }
  }

  toggleAudio(enabled) {
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = enabled;
      });
    }
  }

  toggleVideo(enabled) {
    if (this.localStream) {
      this.localStream.getVideoTracks().forEach(track => {
        track.enabled = enabled;
      });
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
      // Mobile Feature Guard
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== "function") {
        if (window.syncApp) {
          window.syncApp.showToast("El uso compartido de pantalla no es compatible con este navegador móvil.");
        }
        return false;
      }

      try {
        // Mobile-friendly constraints without strict desktop parameters
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true
        });

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
        console.warn("[WebRTC] Screen sharing cancelled or restricted:", err);
        if (window.syncApp && err.name !== "NotAllowedError") {
          window.syncApp.showToast("No se pudo iniciar la pantalla compartida.");
        }
        return false;
      }
    }
  }

  replaceVideoTrackOnAllPeers(newTrack) {
    this.peers.forEach(({ pc }) => {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
      if (sender) {
        sender.replaceTrack(newTrack);
      }
    });
  }

  replaceAudioTrackOnAllPeers(newTrack) {
    this.peers.forEach(({ pc }) => {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === "audio");
      if (sender) {
        sender.replaceTrack(newTrack);
      }
    });
  }

  removePeer(peerId) {
    if (this.peers.has(peerId)) {
      const { pc } = this.peers.get(peerId);
      pc.close();
      this.peers.delete(peerId);

      if (window.audioMixer) {
        window.audioMixer.detachPeerStream(peerId);
      }
      if (this.onRemotePeerDisconnected) {
        this.onRemotePeerDisconnected(peerId);
      }
    }
  }

  closeAll() {
    this.peers.forEach(({ pc }) => pc.close());
    this.peers.clear();
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
    }
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
    }
  }
}

window.webrtcManager = new WebRTCManager();