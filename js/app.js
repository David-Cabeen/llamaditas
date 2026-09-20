// SyncWave Application Coordinator (Supabase Serverless P2P & Clean Drawer UI)
class SyncWaveApp {
  constructor() {
    this.roomId = null;
    this.userId = "usr_" + Math.random().toString(36).substring(2, 9);
    this.userName = localStorage.getItem("syncwave_username") || "User_" + this.userId.substring(4, 8);
    this.isMicOn = true;
    this.isCamOn = false; 
    this.currentLayout = "studio"; 
    this.remotePeers = new Map(); 
    this.isUsingSupabase = true;
    this.isMusicDrawerOpen = false; 
    this.isMicDropdownOpen = false;
    this.activeMicId = "default";
    this.audioInputs = [];
    this.localScreenStream = null;
    this.isChatOpen = false;
    this.session = null;
    this.username = null;
    this.avatarUrl = null;
    this.callStartTime = 0;

    this.init();
  }

  init() {
    this.initAuth(); // Inicializar Autenticación al cargar la página instantáneamente

    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get("room");
    const savedRoomCode = localStorage.getItem("syncwave_room_code") || "";

    if (roomFromUrl) {
      document.getElementById("input-room-code").value = roomFromUrl.toUpperCase();
      this.joinRoom(roomFromUrl.toUpperCase());
    } else if (savedRoomCode) {
      document.getElementById("input-room-code").value = savedRoomCode.toUpperCase();
    }

    const nameInput = document.getElementById("input-user-name");
    if (nameInput) nameInput.value = this.userName;

    window.audioMixer.onSpeakerChange = (peerId, isSpeaking) => {
      this.updatePeerSpeakingState(peerId, isSpeaking);
      if (this.isUsingSupabase) {
        window.supabaseP2P.sendUserState(this.isMicOn, this.isCamOn, isSpeaking);
      }
    };

    window.audioMixer.onLocalMicActivity = (level) => {
      const bars = document.querySelectorAll(".local-mic-level-bar");
      bars.forEach(bar => bar.style.width = `${level}%`);
    };

    window.webrtcManager.onRemoteTrackAdded = (peerId, stream, info, isScreen) => {
      this.handleRemoteStream(peerId, stream, info, isScreen);
    };

    window.webrtcManager.onRemotePeerDisconnected = (peerId) => {
      this.handlePeerDisconnected(peerId);
    };

    const sbUrlInput = document.getElementById("input-sb-url");
    const sbKeyInput = document.getElementById("input-sb-key");
    if (sbUrlInput) sbUrlInput.value = window.supabaseP2P.supabaseUrl;
    if (sbKeyInput) sbKeyInput.value = window.supabaseP2P.supabaseKey;

    document.addEventListener("click", (e) => {
      if (this.isMicDropdownOpen && !e.target.closest("#mic-selector-container")) {
        this.toggleMicDropdown(false);
      }
    });

    window.addEventListener("resize", () => this.positionTheaterPortal());
    document.addEventListener("fullscreenchange", () => {
      document.body.classList.toggle("theater-fullscreen", !!document.fullscreenElement);
      this.positionTheaterPortal();
    });
  }

  generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "SYNC-";
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    document.getElementById("input-room-code").value = code;
    localStorage.setItem("syncwave_room_code", code);
  }

  async joinRoom(customCode = null) {
    const codeInput = document.getElementById("input-room-code");
    const nameInput = document.getElementById("input-user-name");

    this.roomId = (customCode || (codeInput ? codeInput.value : "")).trim().toUpperCase();
    if (!this.roomId) {
      this.showToast("Ingresa un código de sala o enlace válido");
      return;
    }

    localStorage.setItem("syncwave_room_code", this.roomId);

    if (nameInput && nameInput.value.trim()) {
      this.userName = nameInput.value.trim();
      localStorage.setItem("syncwave_username", this.userName);
    }

    const newUrl = `${window.location.protocol}//${window.location.host}${window.location.pathname}?room=${this.roomId}`;
    window.history.pushState({ path: newUrl }, "", newUrl);

    document.getElementById("landing-screen").classList.add("hidden");
    document.getElementById("call-screen").classList.remove("hidden");
    document.getElementById("display-room-code").innerText = this.roomId;

    // Inicializar rastreo de estadísticas
    this.callStartTime = Date.now();
    this.updateStat('total_calls');

    try {
      const localStream = await window.webrtcManager.initLocalMedia(false);
      this.attachLocalVideo(localStream);
      window.audioMixer.attachLocalMic(localStream);
      this.updateCamButtonUI(false);
      await this.loadDevices(); 
    } catch (err) {
      console.warn("Media acquisition notice:", err);
    }

    this.connectSupabase();

    setInterval(() => {
      if (this.callStartTime > 0) {
        const elapsedSecs = Math.floor((Date.now() - this.callStartTime) / 1000);
        if (elapsedSecs > 0 && elapsedSecs % 60 === 0) {
          this.updateStat('total_time_sec', 60);
        }
      }
    }, 60000);
  }

  toggleMicDropdown(forceState) {
    this.isMicDropdownOpen = forceState !== undefined ? forceState : !this.isMicDropdownOpen;
    const menu = document.getElementById("mic-dropdown-menu");
    const arrow = document.getElementById("mic-selector-arrow");
    
    if (this.isMicDropdownOpen) {
      menu.classList.remove("hidden");
      menu.classList.add("flex", "animate-dropdown");
      arrow.classList.remove("rotate-180");
      arrow.classList.add("rotate-0");
    } else {
      menu.classList.add("hidden");
      menu.classList.remove("flex", "animate-dropdown");
      arrow.classList.remove("rotate-0"); 
      arrow.classList.add("rotate-180");
    }
  }

  toggleOtgMode(checked) {
    window.webrtcManager.setOtgMode(checked);
    // Restart the mic capture to apply the raw audio constraints
    window.webrtcManager.switchMicrophone(this.activeMicId);
    this.showToast(checked ? "🎸 Modo OTG activado: Audio crudo sin compresión" : "🎙️ Procesamiento de voz estándar activado");
  }

  toggleLocalMonitor(checked) {
    window.audioMixer.setLocalMonitor(checked);
    this.showToast(checked ? "🎧 Retorno activado. ¡Usa audífonos para evitar eco!" : "Retorno de audio desactivado");
  }

  async loadDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.audioInputs = devices.filter(d => d.kind === 'audioinput');
      this.renderMicOptions();
    } catch(e) {
      console.warn("Failed to enumerate devices", e);
    }
  }

  renderMicOptions() {
    const list = document.getElementById("mic-options-list");
    if (!list) return;
    
    list.innerHTML = this.audioInputs.map(mic => {
      const isSelected = mic.deviceId === this.activeMicId || (this.activeMicId === "default" && mic.deviceId === "default");
      const baseClass = "w-full text-left px-3 py-2.5 text-xs transition-colors flex items-center justify-between";
      const colorClass = isSelected 
        ? "bg-accent/20 text-white font-medium" 
        : "text-gray-400 hover:bg-white/10 hover:text-gray-100";
      const indicator = isSelected 
        ? `<span class="w-2 h-2 rounded-full bg-accent flex-shrink-0 shadow-[0_0_8px_rgba(139,92,246,0.8)]"></span>` 
        : '';

      return `
        <button onclick="window.syncApp.selectMicInput('${mic.deviceId}', '${mic.label.replace(/'/g, "\\'") || 'Micrófono desconocido'}')" 
                class="${baseClass} ${colorClass}">
          <span class="truncate pr-2">${mic.label || 'Micrófono desconocido'}</span>
          ${indicator}
        </button>
      `;
    }).join('');
  }

  selectMicInput(deviceId, label) {
    this.activeMicId = deviceId;
    document.getElementById("mic-selector-label").innerText = label;
    this.renderMicOptions(); 
    this.toggleMicDropdown(false); 
    window.webrtcManager.switchMicrophone(deviceId); 
  }

  connectSupabase() {
    window.webrtcManager.setSignalingSender((target, signalType, payload) => {
      window.supabaseP2P.sendSignal(target, signalType, payload);
    }, this.userId);

    window.ytSync.setSyncSender((action, payload) => {
      window.supabaseP2P.sendMusicAction(action, payload);
    });

    window.supabaseP2P.connect(
      this.roomId,
      this.userId,
      this.userName,
      (peerId, info) => this.onPeerJoined(peerId, info),
      (peerId) => this.onPeerLeft(peerId),
      (fromPeerId, signalType, payload) => window.webrtcManager.handleSignal(fromPeerId, signalType, payload),
      (action, payload, fromPeerId) => this.handleMusicAction(action, payload, fromPeerId),
      (data) => this.handlePeerStateUpdate(data),
      (payload) => this.handleMusicStateSync(payload)
    );
  }

  handleMusicStateSync(payload) {
    const yt = window.ytSync;
    if (!yt || !payload || yt.queue.length > 0) return;

    if (payload.isPlaying && !yt.isDeckActive) {
      yt.togglePower();
    }

    yt.handleServerState({
      queue: payload.queue || [],
      currentIndex: payload.currentIndex || 0,
      isPlaying: !!payload.isPlaying,
      positionSec: payload.positionSec || 0
    }, payload.from, "sync");
  }

  onPeerJoined(peerId, info) {
    if (this.remotePeers.has(peerId)) return;
    const peerName = info.name || "Amigo";
    console.log(`[App] Adding remote peer ${peerName} (${peerId})`);
    this.remotePeers.set(peerId, { name: peerName, username: info.username, mic: info.mic !== false, cam: info.cam === true });
    window.webrtcManager.getOrCreatePeer(peerId, info);
    this.showToast(`${peerName} se unió a la llamada`);
    this.renderVideoTiles();
    this.renderMixerChannels();
  }

  onPeerLeft(peerId) {
    const p = this.remotePeers.get(peerId);
    if (p) {
      this.showToast(`${p.name || "Amigo"} salió de la sala`);
    }
    window.webrtcManager.removePeer(peerId);
    this.remotePeers.delete(peerId);
    this.renderVideoTiles();
    this.renderMixerChannels();
  }

  handleMusicAction(action, payload, fromPeerId) {
    const yt = window.ytSync;
    if (!yt) return;

    if (action === "play") {
      if (!yt.isDeckActive) yt.togglePower();
      yt.handleServerState({
        queue: yt.queue,
        currentIndex: yt.currentIndex,
        isPlaying: true,
        positionSec: payload.position || 0
      }, fromPeerId, action);
    } else if (action === "pause") {
      yt.handleServerState({
        queue: yt.queue,
        currentIndex: yt.currentIndex,
        isPlaying: false,
        positionSec: payload.position || 0
      }, fromPeerId, action);
    } else if (action === "seek") {
      yt.handleServerState({
        queue: yt.queue,
        currentIndex: yt.currentIndex,
        isPlaying: payload.isPlaying !== undefined ? payload.isPlaying : yt.isPlaying,
        positionSec: payload.position || 0
      }, fromPeerId, action);
    } else if (action === "add-track") {
      if (payload.track) {
        yt.queue.push(payload.track);
        yt.renderQueueUI();
        if (yt.queue.length === 1 && yt.isDeckActive) {
          yt.selectTrackLocally(0);
        }
      }
    } else if (action === "add-multiple") {
      if (payload.tracks && payload.tracks.length > 0) {
        const wasEmpty = yt.queue.length === 0;
        yt.queue.push(...payload.tracks);
        yt.renderQueueUI();
        if (wasEmpty && yt.isDeckActive) {
          yt.selectTrackLocally(0);
        }
      }
    } else if (action === "select-track") {
      yt.currentIndex = payload.index || 0;
      yt.handleServerState({
        queue: yt.queue,
        currentIndex: yt.currentIndex,
        isPlaying: true,
        positionSec: 0
      }, fromPeerId, action);
    } else if (action === "next-track") {
      yt.skipNext();
    } else if (action === "prev-track") {
      yt.skipPrev();
    } else if (action === "remove-track") {
      const idx = payload.index;
      if (idx >= 0 && idx < yt.queue.length) {
        yt.queue.splice(idx, 1);
        if (yt.currentIndex >= yt.queue.length) {
          yt.currentIndex = Math.max(0, yt.queue.length - 1);
        }
        yt.renderQueueUI();
      }
    } else if (action === "reorder") {
      const { fromIndex, toIndex } = payload;
      if (fromIndex >= 0 && fromIndex < yt.queue.length && toIndex >= 0 && toIndex < yt.queue.length) {
        const item = yt.queue.splice(fromIndex, 1)[0];
        yt.queue.splice(toIndex, 0, item);
        yt.renderQueueUI();
      }
    }
  }

  attachLocalVideo(stream) {
    document.querySelectorAll(".local-video-feed").forEach(v => {
      v.srcObject = stream;
      v.muted = true;
      v.play().catch(e => console.warn(e));
    });
    document.querySelectorAll(".local-user-name").forEach(el => el.innerText = `${this.userName} (You)`);
    this.updateCamPlaceholder();
  }

  handleRemoteStream(peerId, stream, info, isScreen) {
    const peerInfo = this.remotePeers.get(peerId) || info || { name: "Amigo" };
    if (isScreen) {
      peerInfo.screenStream = stream;
      this.setLayout('screenshare'); 
    } else {
      peerInfo.stream = stream;
    }
    this.remotePeers.set(peerId, peerInfo);
    this.renderVideoTiles();
    this.renderMixerChannels();
  }

  handlePeerDisconnected(peerId) {
    this.onPeerLeft(peerId);
  }
  
  handlePeerScreenState(peerId, isSharing) {
    if (this.remotePeers.has(peerId)) {
      const p = this.remotePeers.get(peerId);
      p.isSharingScreen = isSharing;
      if (!isSharing) p.screenStream = null;
      this.remotePeers.set(peerId, p);
      
      if (isSharing && this.currentLayout !== 'screenshare') {
         this.showToast(`${p.name || "Un amigo"} empezó a compartir pantalla`);
         this.setLayout('screenshare');
      } else if (!isSharing && this.currentLayout === 'screenshare') {
         let anyoneSharing = !!this.localScreenStream;
         this.remotePeers.forEach(peer => { if (peer.isSharingScreen) anyoneSharing = true; });
         if (!anyoneSharing) this.setLayout('studio');
      }
      this.renderVideoTiles();
    }
  }

  renderVideoTiles() {
    const remotePeersList = Array.from(this.remotePeers.entries());
    const remoteContainer = document.getElementById("remote-video-container");
    const screenshareSidebar = document.getElementById("screenshare-sidebar");
    const screenshareMain = document.getElementById("screenshare-main");

    if (screenshareSidebar && screenshareMain) {
      screenshareSidebar.innerHTML = "";
      screenshareMain.innerHTML = `
        <div class="w-full h-full flex flex-col items-center justify-center text-gray-500 text-sm">
           <svg class="w-12 h-12 mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
           Nadie está compartiendo pantalla
        </div>
      `;
      const activeNameEl = document.getElementById("screenshare-active-name");
      if (activeNameEl) activeNameEl.innerText = "Pantalla Compartida";
      
      const localTile = document.createElement("div");
      localTile.className = "relative h-32 rounded-xl overflow-hidden glass border border-white/10 video-tile";
      localTile.innerHTML = `
        <video class="local-video-feed absolute inset-0 w-full h-full object-cover -z-10" autoplay playsinline muted></video>
        <div class="absolute bottom-1 left-2 bg-black/60 backdrop-blur-md px-2 py-0.5 rounded text-[10px] font-medium text-white flex items-center gap-1.5">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> Tú
        </div>
      `;
      screenshareSidebar.appendChild(localTile);
      const localVid = localTile.querySelector("video");
      if (window.webrtcManager.localStream) localVid.srcObject = window.webrtcManager.localStream;
      
      if (this.localScreenStream) {
         screenshareMain.innerHTML = `
           <div class="video-contain">
             <video autoplay playsinline muted></video>
           </div>
         `;
         screenshareMain.querySelector("video").srcObject = this.localScreenStream;
         if (activeNameEl) activeNameEl.innerText = "Tu Pantalla";
      }
    }

    if (remoteContainer) {
      if (remotePeersList.length === 0) {
        remoteContainer.innerHTML = `
          <div class="w-full h-full flex flex-col items-center justify-center p-8 text-center glass rounded-2xl border border-white/10 bg-gradient-to-b from-gray-900/30 to-black/80 min-h-[400px]">
            <div class="w-16 h-16 rounded-2xl bg-accent/20 border border-accent/40 flex items-center justify-center text-accent mb-4 glow-accent">
              <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"/></svg>
            </div>
            <h4 class="text-white font-bold text-base mb-1">Esperando a que un amigo se conecte</h4>
            <p class="text-xs text-gray-400 max-w-sm mb-4">Envía tu enlace de invitación a un amigo. Cuando lo abra, se verán aquí al instante.</p>
            <button onclick="window.syncApp.copyInviteLink()" class="px-4 py-2 rounded-xl bg-accent text-white text-xs font-semibold hover:opacity-90 transition flex items-center gap-2 glow-accent">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"/></svg>
              <span>Copiar enlace de invitación</span>
            </button>
          </div>
        `;
      } else {
        remoteContainer.innerHTML = "";
        remotePeersList.forEach(([peerId, p]) => {
          const tile = document.createElement("div");
          tile.className = "relative rounded-2xl overflow-hidden glass border border-white/10 flex flex-col justify-between p-4 video-tile group min-h-[400px]";
          tile.id = `peer-tile-${peerId}`;

          const vol = window.audioMixer.getPeerVolume(peerId);

          tile.innerHTML = `
            <video id="video-stream-${peerId}" autoplay playsinline class="absolute inset-0 w-full h-full object-cover -z-10"></video>
            
            <div class="flex items-center justify-between z-10">
              <div class="flex items-center gap-2 bg-black/60 backdrop-blur-md px-3 py-1 rounded-full border border-white/10 text-xs">
                <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
                <span class="font-medium text-white">${p.name || "Amigo"}</span>
                <span class="text-[10px] text-emerald-400 font-mono bg-emerald-400/10 px-1.5 py-0.5 rounded">P2P HD</span>
              </div>
              
              <div class="flex items-center gap-2 bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-full border border-white/10">
                <svg class="w-3.5 h-3.5 custom-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/></svg>
                <input type="range" min="0" max="150" value="${vol}" oninput="window.syncApp.onPeerVolumeSlider('${peerId}', this.value)" class="w-20 cursor-pointer">
                <span id="overlay-vol-${peerId}" class="text-[11px] font-mono text-gray-300 w-7 text-right">${vol}%</span>
              </div>
            </div>

            <div class="flex items-center justify-between z-10">
              <div id="speaking-badge-${peerId}" class="hidden flex items-center gap-1.5 text-xs text-white/90 bg-accent/20 border border-accent/40 px-2.5 py-1 rounded-lg backdrop-blur-md">
                <div class="flex gap-0.5 items-end h-3">
                  <span class="w-0.5 h-3 bg-accent rounded-full animate-bounce"></span>
                  <span class="w-0.5 h-2 bg-accent rounded-full animate-bounce" style="animation-delay: 0.2s"></span>
                  <span class="w-0.5 h-3.5 bg-accent rounded-full animate-bounce" style="animation-delay: 0.4s"></span>
                </div>
                <span class="text-[11px] font-medium">Hablando</span>
              </div>
              <div></div>
            </div>
          `;

          remoteContainer.appendChild(tile);

          if (p.stream) {
            const vid = tile.querySelector(`#video-stream-${peerId}`);
            vid.srcObject = p.stream;
            vid.play().catch(e => console.warn(e));
          }
        });
      }
    }

    remotePeersList.forEach(([peerId, p]) => {
      if (screenshareSidebar) {
        const sideTile = document.createElement("div");
        sideTile.className = "relative h-32 rounded-xl overflow-hidden glass border border-white/10 video-tile";
        sideTile.innerHTML = `
          <video autoplay playsinline class="absolute inset-0 w-full h-full object-cover -z-10"></video>
          <div class="absolute bottom-1 left-2 bg-black/60 backdrop-blur-md px-2 py-0.5 rounded text-[10px] font-medium text-white flex items-center gap-1.5">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> ${p.name || "Amigo"}
          </div>
        `;
        screenshareSidebar.appendChild(sideTile);
        if (p.stream) sideTile.querySelector("video").srcObject = p.stream;
      }

      if ((p.isSharingScreen || p.screenStream) && screenshareMain) {
        screenshareMain.innerHTML = `
         <div class="video-contain">
           <video autoplay playsinline></video>
         </div>
       `;
       const activeNameEl = document.getElementById("screenshare-active-name");
       screenshareMain.querySelector("video").srcObject = p.screenStream;
       if (activeNameEl) activeNameEl.innerText = `Pantalla de ${p.name || "Amigo"}`;
      }
    });
  }

  renderMixerChannels() {
    const list = document.getElementById("mixer-channels-list");
    if (!list) return;

    list.innerHTML = "";

    const musicVol = window.audioMixer.getMusicVolume();
    const musicChan = document.createElement("div");
    musicChan.className = "p-3.5 rounded-xl bg-white/5 border border-white/10 space-y-2";
    musicChan.innerHTML = `
      <div class="flex justify-between items-center">
        <div class="flex items-center gap-2">
          <span class="w-2.5 h-2.5 rounded-full bg-red-500"></span>
          <span class="text-xs font-semibold text-white">Música sincronizada de YouTube</span>
        </div>
        <span id="mixer-disp-music-vol" class="text-xs font-mono custom-accent">${musicVol}%</span>
      </div>
      <input type="range" min="0" max="100" value="${musicVol}" oninput="window.syncApp.onMusicVolumeSlider(this.value)" class="w-full">
    `;
    list.appendChild(musicChan);

    this.remotePeers.forEach((p, peerId) => {
      const vol = window.audioMixer.getPeerVolume(peerId);
      const chan = document.createElement("div");
      chan.className = "p-3.5 rounded-xl bg-white/5 border border-white/10 space-y-2";
      chan.innerHTML = `
        <div class="flex justify-between items-center">
          <div class="flex items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-full bg-emerald-400"></span>
            <span class="text-xs font-semibold text-white">${p.name || "Amigo"}</span>
          </div>
          <div class="flex items-center gap-2">
            <button onclick="window.syncApp.togglePeerMute('${peerId}')" class="text-xs text-gray-400 hover:text-white" title="Silenciar/Activar audio">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/></svg>
            </button>
            <span id="mixer-disp-peer-vol-${peerId}" class="text-xs font-mono custom-accent">${vol}%</span>
          </div>
        </div>
        <input type="range" min="0" max="150" value="${vol}" oninput="window.syncApp.onPeerVolumeSlider('${peerId}', this.value)" class="w-full">
      `;
      list.appendChild(chan);
    });

    const micChan = document.createElement("div");
    micChan.className = "p-3.5 rounded-xl bg-white/5 border border-white/10 space-y-2";
    micChan.innerHTML = `
      <div class="flex justify-between items-center">
        <div class="flex items-center gap-2">
          <span class="w-2.5 h-2.5 rounded-full bg-blue-400"></span>
          <span class="text-xs font-semibold text-white">Sensibilidad de tu micrófono</span>
        </div>
        <span class="text-xs font-mono text-gray-400">Activo</span>
      </div>
      <div class="w-full bg-white/10 h-2 rounded-full overflow-hidden">
        <div class="local-mic-level-bar bg-accent h-full w-0 transition-all duration-75"></div>
      </div>
    `;
    list.appendChild(micChan);
  }

  onMusicVolumeSlider(val) {
    window.audioMixer.setMusicVolume(val);
    const disp = document.getElementById("mixer-disp-music-vol");
    if (disp) disp.innerText = `${val}%`;

    const deckDisp = document.getElementById("deck-music-vol-val");
    if (deckDisp) deckDisp.innerText = `${val}%`;

    const deckSlider = document.getElementById("deck-music-vol-slider");
    if (deckSlider) deckSlider.value = val;
  }

  onPeerVolumeSlider(peerId, val) {
    window.audioMixer.setPeerVolume(peerId, val);

    const overlay = document.getElementById(`overlay-vol-${peerId}`);
    if (overlay) overlay.innerText = `${val}%`;

    const mixerDisp = document.getElementById(`mixer-disp-peer-vol-${peerId}`);
    if (mixerDisp) mixerDisp.innerText = `${val}%`;
  }

  togglePeerMute(peerId) {
    const isMuted = window.audioMixer.togglePeerMute(peerId);
    this.showToast(isMuted ? "Amigo silenciado localmente" : "Amigo reactivado localmente");
  }

  toggleMic() {
    this.isMicOn = !this.isMicOn;
    window.webrtcManager.toggleAudio(this.isMicOn);

    const btn = document.getElementById("btn-toggle-mic");
    const label = btn.querySelector("span");
    const icon = btn.querySelector(".icon-mic");

    if (this.isMicOn) {
      btn.className = "flex items-center gap-2 px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs font-medium transition";
      label.innerText = "Micrófono activo";
      icon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/>`;
    } else {
      btn.className = "flex items-center gap-2 px-3.5 py-2 rounded-xl bg-red-500/20 border border-red-500/40 text-red-400 text-xs font-medium transition";
      label.innerText = "Micrófono apagado";
      icon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2"/>`;
    }

    if (this.isUsingSupabase) {
      window.supabaseP2P.sendUserState(this.isMicOn, this.isCamOn, false);
    }
  }

  toggleCam() {
    this.isCamOn = !this.isCamOn;
    window.webrtcManager.toggleVideo(this.isCamOn);
    this.updateCamButtonUI(this.isCamOn);
    this.updateCamPlaceholder();

    if (this.isUsingSupabase) {
      window.supabaseP2P.sendUserState(this.isMicOn, this.isCamOn, false);
    }
  }

  updateCamButtonUI(isOn) {
    const btn = document.getElementById("btn-toggle-cam");
    if (!btn) return;
    const label = btn.querySelector("span");

    if (isOn) {
      btn.className = "flex items-center gap-2 px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs font-medium transition";
      label.innerText = "Cámara encendida";
    } else {
      btn.className = "flex items-center gap-2 px-3.5 py-2 rounded-xl bg-red-500/20 border border-red-500/40 text-red-400 text-xs font-medium transition";
      label.innerText = "Cámara apagada";
    }
  }

  updateCamPlaceholder() {
    const placeholder = document.getElementById("local-cam-off-placeholder");
    const videoFeed = document.querySelector(".local-video-feed");
    if (placeholder && videoFeed) {
      if (this.isCamOn) {
        placeholder.classList.add("hidden");
        videoFeed.classList.remove("opacity-0");
      } else {
        placeholder.classList.remove("hidden");
        videoFeed.classList.add("opacity-0");
      }
    }
  }

  toggleMusicDrawer() {
    this.isMusicDrawerOpen = !this.isMusicDrawerOpen;
    const drawer = document.getElementById("youtube-slide-drawer");
    const backdrop = document.getElementById("youtube-drawer-backdrop");

    if (drawer) {
      if (this.isMusicDrawerOpen) {
        drawer.classList.remove("translate-x-full");
        drawer.classList.add("translate-x-0");
        if (backdrop) backdrop.classList.remove("hidden");
      } else {
        drawer.classList.remove("translate-x-0");
        drawer.classList.add("translate-x-full");
        if (backdrop) backdrop.classList.add("hidden");
      }
    }
  }

  async toggleScreenShare() {
    if (navigator.userAgent.toLowerCase().includes("firefox") && !this.isScreenSharing) {
      if (window.syncApp) {
        window.syncApp.showToast("Firefox bloquea el audio de pantalla. Usa Chrome/Edge o la cabina de YouTube.");
      }
    }
    const active = await window.webrtcManager.toggleScreenShare();
    const btn = document.getElementById("btn-screenshare");
    
    if (active) {
      btn.className = "flex items-center gap-2 px-3.5 py-2 rounded-xl bg-accent text-white text-xs font-medium transition glow-accent";
      this.showToast("Compartiendo pantalla completa con audio del sistema");
      if (this.isUsingSupabase) window.supabaseP2P.sendScreenShareState(true);
      this.localScreenStream = window.webrtcManager.screenStream; 
      this.setLayout('screenshare');
    } else {
      this.onScreenShareEnded();
    }
    this.renderVideoTiles();
  }

  onScreenShareEnded() {
    const btn = document.getElementById("btn-screenshare");
    if (btn) btn.className = "flex items-center gap-2 px-3.5 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-gray-300 text-xs font-medium transition";
    if (this.isUsingSupabase) window.supabaseP2P.sendScreenShareState(false);
    this.localScreenStream = null;
    if (this.currentLayout === 'screenshare') this.setLayout('studio');
    this.renderVideoTiles();
  }

  handlePeerStateUpdate(data) {
    const { from, mic, cam, speaking } = data;
    if (this.remotePeers.has(from)) {
      const p = this.remotePeers.get(from);
      if (mic !== undefined) p.mic = mic;
      if (cam !== undefined) p.cam = cam;
      if (speaking !== undefined) this.updatePeerSpeakingState(from, speaking);
    }
  }

  updatePeerSpeakingState(peerId, isSpeaking) {
    const tile = document.getElementById(`peer-tile-${peerId}`);
    const badge = document.getElementById(`speaking-badge-${peerId}`);
    if (tile) {
      if (isSpeaking) tile.classList.add("speaking-pulse");
      else tile.classList.remove("speaking-pulse");
    }
    if (badge) {
      if (isSpeaking) badge.classList.remove("hidden");
      else badge.classList.add("hidden");
    }
  }

  setLayout(layout) {
    this.currentLayout = layout;
    const layouts = ["studio", "cinema", "screenshare"];
    
    layouts.forEach(l => {
      const el = document.getElementById(`layout-${l}`);
      const btn = document.getElementById(`btn-layout-${l}`);
      if (l === layout) {
        if (el) el.classList.remove("hidden");
        if (btn) btn.className = "px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all bg-accent text-white shadow-sm flex items-center gap-1.5";
      } else {
        if (el) el.classList.add("hidden");
        if (btn) btn.className = "px-3.5 py-1.5 rounded-lg text-xs font-medium text-gray-400 hover:text-white transition-all flex items-center gap-1.5";
      }
    });

    this.positionTheaterPortal();
    this.renderVideoTiles();
  }

  positionTheaterPortal() {
    const portal = document.getElementById("hidden-audio-container");
    const slot = document.getElementById("cinema-video-container");
    if (!portal || !slot) return;

    if (this.currentLayout === "cinema") {
      const rect = slot.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) {
        requestAnimationFrame(() => this.positionTheaterPortal());
        return;
      }
      Object.assign(portal.style, {
        top: `${rect.top}px`,
        left: `${rect.left}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        opacity: "1",
        pointerEvents: "auto",
        borderRadius: "0.75rem"
      });
    } else {
      Object.assign(portal.style, {
        top: "-9999px",
        left: "-9999px",
        width: "1px",
        height: "1px",
        opacity: "0",
        pointerEvents: "none",
        borderRadius: "0"
      });
    }
  }

  toggleCinemaFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => {
        console.warn(`Error al intentar activar pantalla completa: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  }

  copyInviteLink() {
    const inviteUrl = `${window.location.protocol}//${window.location.host}${window.location.pathname}?room=${this.roomId}`;
    navigator.clipboard.writeText(inviteUrl);
    this.showToast("Enlace de invitación copiado al portapapeles");
  }

  copyRoomCode() {
    navigator.clipboard.writeText(this.roomId);
    this.showToast(`Código de sala ${this.roomId} copiado`);
  }

  toggleMixerModal() {
    document.getElementById("modal-mixer").classList.toggle("hidden");
  }

  toggleSupabaseModal() {
    document.getElementById("modal-supabase").classList.toggle("hidden");
  }

  saveSupabaseSettings() {
    const url = document.getElementById("input-sb-url").value;
    const key = document.getElementById("input-sb-key").value;
    window.supabaseP2P.saveCredentials(url, key);
    this.toggleSupabaseModal();
    this.showToast("Credenciales de Supabase guardadas");
    if (this.roomId) {
      window.supabaseP2P.leave();
      this.connectSupabase();
    }
  }

  leaveCall() {
    window.webrtcManager.closeAll();
    window.supabaseP2P.leave();
    window.location.href = window.location.pathname;
  }

  async initAuth() {
    if (!window.supabaseClient) return;
    const { data } = await window.supabaseClient.auth.getSession();
    if (data && data.session) {
      this.session = data.session;
      this.username = data.session.user.user_metadata.preferred_username || data.session.user.email.split("@")[0];
      this.avatarUrl = data.session.user.user_metadata.avatar_url;
      this.userName = this.username;
      
      const btn = document.getElementById("btn-login");
      if (btn) btn.innerHTML = `<img src="${this.avatarUrl}" class="w-5 h-5 rounded-full object-cover"> <span>Logueado como ${this.username}</span>`;
      
      const nameInput = document.getElementById("input-user-name");
      if (nameInput) nameInput.value = this.userName;
    }
  }

  async loginWithProvider() {
    if (this.session) return;
    if (!window.supabaseClient) return;
    await window.supabaseClient.auth.signInWithOAuth({ provider: 'google' });
  }

  async updateStat(statName, increment = 1) {
    if (!this.session || !window.supabaseClient) return;
    const { error } = await window.supabaseClient.rpc('increment_my_stat', { 
      stat_column: statName, 
      inc_val: increment 
    });
    if (error) console.warn("Stats API req failed", error);
  }

  toggleChat() {
    this.isChatOpen = !this.isChatOpen;
    const sidebar = document.getElementById("chat-sidebar");
    if (this.isChatOpen) {
      sidebar.classList.remove("w-0", "opacity-0");
      sidebar.classList.add("w-[300px]", "opacity-100");
    } else {
      sidebar.classList.add("w-0", "opacity-0");
      sidebar.classList.remove("w-[300px]", "opacity-100");
    }
  }

  sendChat() {
    const input = document.getElementById("input-chat");
    const text = input.value.trim();
    if (!text) return;

    // Manejo del comando /msg (Mensaje Directo)
    if (text.startsWith("/msg ")) {
      if (!this.session) {
        this.showToast("Solo los usuarios registrados pueden enviar mensajes privados.");
        return;
      }
      const parts = text.split(" ");
      const targetUsername = parts[1];
      const actualMsg = parts.slice(2).join(" ");
      
      let targetPeerId = null;
      for (const [pId, pData] of this.remotePeers.entries()) {
        if (pData.username === targetUsername) {
          targetPeerId = pId;
          break;
        }
      }
      if (targetPeerId) {
        window.supabaseP2P.channel.send({
          type: "broadcast", event: "chat",
          payload: { from: this.userId, target: targetPeerId, name: this.userName, avatar: this.avatarUrl, msg: actualMsg, isPrivate: true }
        });
        this.renderChatMessage(this.userName, actualMsg, this.avatarUrl, true, true);
        this.updateStat('messages_sent');
      } else {
        this.showToast(`Usuario ${targetUsername} no encontrado.`);
      }
    } else {
      window.supabaseP2P.channel.send({
        type: "broadcast", event: "chat",
        payload: { from: this.userId, name: this.userName, avatar: this.avatarUrl, msg: text, isPrivate: false }
      });
      this.renderChatMessage(this.userName, text, this.avatarUrl, true, false);
      this.updateStat('messages_sent');
    }
    input.value = "";
  }

  renderChatMessage(senderName, message, avatar, isMine, isPrivate) {
    const container = document.getElementById("chat-messages-container");
    const div = document.createElement("div");
    const avatarSrc = avatar || `https://ui-avatars.com/api/?name=${senderName}&background=random`;
    const privacyBadge = isPrivate ? `<span class="text-[9px] text-accent uppercase font-bold ml-1">Privado</span>` : '';
    
    div.className = `flex gap-2 ${isMine ? "flex-row-reverse" : ""}`;
    div.innerHTML = `
      <img src="${avatarSrc}" class="w-7 h-7 rounded-full flex-shrink-0 mt-1 object-cover">
      <div class="flex flex-col ${isMine ? "items-end" : "items-start"} max-w-[80%]">
        <div class="flex items-center gap-1 mb-0.5">
          <span class="text-[10px] text-gray-400 font-medium">${senderName}</span>
          ${privacyBadge}
        </div>
        <div class="px-3 py-2 rounded-xl text-xs ${isMine ? "bg-accent text-white" : "bg-white/10 text-gray-200"} border ${isPrivate ? "border-accent shadow-[0_0_8px_rgba(139,92,246,0.5)]" : "border-white/5"}">
          ${message}
        </div>
      </div>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  showChatToast(senderName, message, avatar, isPrivate) {
    if (this.isChatOpen) return; // Si el chat está abierto, no molestamos con toasts
    const container = document.getElementById("chat-toast-container");
    const toast = document.createElement("div");
    const avatarSrc = avatar || `https://ui-avatars.com/api/?name=${senderName}&background=random`;
    
    toast.className = `glass border ${isPrivate ? "border-accent" : "border-white/15"} px-3 py-2.5 rounded-2xl shadow-2xl flex items-center gap-3 transition-all duration-300 opacity-0 translate-y-4 max-w-[280px]`;
    toast.innerHTML = `
      <img src="${avatarSrc}" class="w-8 h-8 rounded-full object-cover">
      <div class="min-w-0 flex-1">
        <p class="text-[10px] font-bold text-white uppercase tracking-wide truncate">${senderName} ${isPrivate ? '<span class="text-accent">(Susurro)</span>' : ''}</p>
        <p class="text-xs text-gray-300 truncate">${message}</p>
      </div>
    `;
    container.appendChild(toast);
    
    requestAnimationFrame(() => {
      toast.classList.remove("opacity-0", "translate-y-4");
      toast.classList.add("opacity-100", "translate-y-0");
    });

    setTimeout(() => {
      toast.classList.remove("opacity-100", "translate-y-0");
      toast.classList.add("opacity-0", "translate-y-4");
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  updateConnectionStatus(connected, customText = null) {
    const indicator = document.getElementById("status-indicator");
    const text = document.getElementById("status-text");
    if (connected) {
      if (indicator) indicator.className = "w-2 h-2 rounded-full bg-emerald-400 animate-pulse";
      if (text) text.innerText = customText || "P2P de Supabase conectado";
    } else {
      if (indicator) indicator.className = "w-2 h-2 rounded-full bg-amber-400 animate-pulse";
      if (text) text.innerText = customText || "Conectando...";
    }
  }

  showToast(msg) {
    const toast = document.getElementById("toast-notification");
    const toastMsg = document.getElementById("toast-msg");
    if (toast && toastMsg) {
      toastMsg.innerText = msg;
      toast.classList.remove("opacity-0", "translate-y-4");
      toast.classList.add("opacity-100", "translate-y-0");
      setTimeout(() => {
        toast.classList.remove("opacity-100", "translate-y-0");
        toast.classList.add("opacity-0", "translate-y-4");
      }, 3000);
    }
  }
}

window.syncApp = new SyncWaveApp();