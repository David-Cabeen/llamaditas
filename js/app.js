// Llamaditas Application Coordinator (Supabase Serverless P2P, Mobile PWA & Clean UI)
class LlamaditasApp {
  constructor() {
    this.roomId = null;
    this.userId = "usr_" + Math.random().toString(36).substring(2, 9);
    this.userName = localStorage.getItem("llamaditas_username") || "User_" + this.userId.substring(4, 8);
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
    this.callPartnerIds = new Set();
    this.recordedCallPartnerIds = new Set();
    this.lastPartnerStatAt = 0;
    this.deferredPwaPrompt = null;
    this.stats = { totalCalls: 0, totalTimeSec: 0, topFriendName: '', topFriendAvatar: '', topFriendLink: '#' };

    this.init();
  }

  init() {
    this.initAuth();
    this.initPwa();
    this.initChatCommands();

    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get("room");
    const savedRoomCode = localStorage.getItem("llamaditas_room_code") || "";

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
      if (this.isUsingSupabase) window.supabaseP2P.sendUserState(this.isMicOn, this.isCamOn, isSpeaking);
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

    document.addEventListener("click", (e) => {
      if (this.isMicDropdownOpen && !e.target.closest("#mic-group")) {
        this.toggleMicDropdown(false);
      }
    });

    window.addEventListener("resize", () => this.positionTheaterPortal());
    document.addEventListener("fullscreenchange", () => {
      document.body.classList.toggle("theater-fullscreen", !!document.fullscreenElement);
      this.positionTheaterPortal();
    });
  }

  initPwa() {
    const isMobilePhone = /Android.*Mobile|iPhone|iPod/i.test(navigator.userAgent);
    if (isMobilePhone) {
      document.querySelectorAll(".btn-install-pwa").forEach(btn => btn.classList.remove("hidden"));
    }

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      this.deferredPwaPrompt = e;
    });

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(err => console.warn("[PWA] Service worker registration failed:", err));
    }
  }

  async installPwa() {
    if (!this.deferredPwaPrompt) return;
    this.deferredPwaPrompt.prompt();
    const { outcome } = await this.deferredPwaPrompt.userChoice;
    if (outcome === "accepted") this.showToast("¡Aplicación instalada en tu dispositivo!");
    this.deferredPwaPrompt = null;
    document.querySelectorAll(".btn-install-pwa").forEach(btn => btn.classList.add("hidden"));
  }

  generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "SYNC-";
    window.sfx.play("randomRoom");
    for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    document.getElementById("input-room-code").value = code;
    localStorage.setItem("llamaditas_room_code", code);
  }

  async joinRoom(customCode = null) {
    const codeInput = document.getElementById("input-room-code");
    const nameInput = document.getElementById("input-user-name");

    this.roomId = (customCode || (codeInput ? codeInput.value : "")).trim().toUpperCase();
    if (!this.roomId) {
      this.showToast("Ingresa un código de sala o enlace válido");
      return;
    }

    localStorage.setItem("llamaditas_room_code", this.roomId);

    if (nameInput && nameInput.value.trim()) {
      this.userName = nameInput.value.trim();
      localStorage.setItem("llamaditas_username", this.userName);
    }

    const newUrl = `${window.location.protocol}//${window.location.host}${window.location.pathname}?room=${this.roomId}`;
    window.history.pushState({ path: newUrl }, "", newUrl);

    document.getElementById("layout-switchers").classList.remove("hidden");
    document.getElementById("layout-switchers").classList.add("flex");
    this.setLayout(this.currentLayout);
    document.getElementById("btn-nav-chat").classList.remove("hidden");
    document.getElementById("btn-nav-chat").classList.add("flex");
    document.getElementById("btn-nav-deck").classList.remove("hidden");
    document.getElementById("btn-nav-deck").classList.add("flex");
    document.getElementById("nav-dividers").classList.remove("hidden");

    document.getElementById("landing-screen").classList.add("hidden");
    document.getElementById("call-screen").classList.remove("hidden");
    document.getElementById("display-room-code").innerText = this.roomId;
    window.sfx.play("callEnter");

    this.callStartTime = Date.now();
    this.callPartnerIds.clear();
    this.recordedCallPartnerIds.clear();
    this.lastPartnerStatAt = this.callStartTime;
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
        if (elapsedSecs > 0 && elapsedSecs % 60 === 0 && this.lastPartnerStatAt < this.callStartTime + elapsedSecs * 1000) {
          this.updateStat('total_time_sec', 60);
          this.updatePartnerTime(60);
          this.lastPartnerStatAt = this.callStartTime + elapsedSecs * 1000;
        }
      }
    }, 60000);
  }

  updateCamPlaceholder() {
    const placeholders = document.querySelectorAll("[id$='cam-off-local']");
    const videoFeeds = document.querySelectorAll("[id$='video-stream-local']");
    
    if (this.isCamOn) {
        placeholders.forEach(p => { p.style.opacity = "0"; setTimeout(() => p.classList.add("hidden"), 300); });
        videoFeeds.forEach(v => v.classList.remove("opacity-0"));
    } else {
        placeholders.forEach(p => { p.classList.remove("hidden"); p.style.opacity = "1"; this.renderCamOffPlaceholder(p, this.avatarUrl, `local-cam-${p.id}`); });
        videoFeeds.forEach(v => v.classList.add("opacity-0"));
    }
  }

  renderCamOffPlaceholder(container, avatar, idPrefix) {
    if (!container) return;
    if (avatar) {
      container.innerHTML = `
        <img src="${avatar}" id="${idPrefix}-img" class="w-20 h-20 sm:w-24 sm:h-24 rounded-full object-cover shadow-2xl border-2 border-white/20 mb-3" crossorigin="anonymous">
        <p class="text-xs sm:text-sm font-semibold text-white">Cámara desactivada</p>
      `;
      this.extractProminentColor(avatar, container.id);
    } else {
      container.style.backgroundColor = "#000000";
      container.innerHTML = `
        <div class="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-gray-400 mb-3 glow-subtle">
          <svg class="w-8 h-8 sm:w-10 sm:h-10" fill="currentColor" viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
        </div>
        <p class="text-xs sm:text-sm font-semibold text-white">Cámara desactivada</p>
        <p class="text-[10px] sm:text-xs text-gray-500 mt-1">Usuario Invitado</p>
      `;
    }
  }

  extractProminentColor(imgSrc, containerId) {
    if (!imgSrc) return;
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
      try {
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let r=0, g=0, b=0, count=0;
        for(let i=0; i<data.length; i+=32) { r += data[i]; g += data[i+1]; b += data[i+2]; count++; }
        r = Math.floor(r/count); g = Math.floor(g/count); b = Math.floor(b/count);
        const el = document.getElementById(containerId);
        if (el) el.style.backgroundColor = `rgba(${r},${g},${b}, 0.5)`;
      } catch(e) {}
    };
    img.src = imgSrc;
  }

  toggleMicDropdown(forceState) {
    const wasOpen = this.isMicDropdownOpen;
    this.isMicDropdownOpen = forceState !== undefined ? forceState : !this.isMicDropdownOpen;
    const menu = document.getElementById("mic-dropdown-menu");
    const arrow = document.getElementById("mic-selector-arrow");
    
    if (this.isMicDropdownOpen) {
      menu.classList.remove("hidden"); menu.classList.add("flex", "animate-dropdown");
      if (!wasOpen) window.sfx.play("menuOpen");
      if (arrow) { arrow.classList.remove("rotate-180"); arrow.classList.add("rotate-0"); }
    } else {
      menu.classList.add("hidden"); menu.classList.remove("flex", "animate-dropdown");
      if (wasOpen) window.sfx.play("menuClose");
      if (arrow) { arrow.classList.remove("rotate-0"); arrow.classList.add("rotate-180"); }
    }
  }

  toggleOtgMode(checked) {
    if (window.webrtcManager.setOtgMode) window.webrtcManager.setOtgMode(checked);
    window.webrtcManager.switchMicrophone(this.activeMicId);
    this.showToast(checked ? "🎸 Modo OTG activado: Audio crudo sin compresión" : "🎙️ Procesamiento de voz estándar activado");
  }

  toggleLocalMonitor(checked) {
    if (window.webrtcManager.setLocalMonitor) window.webrtcManager.setLocalMonitor(checked);
    this.showToast(checked ? "🎧 Retorno activado. ¡Usa audífonos para evitar eco!" : "Retorno de audio desactivado");
  }

  async loadDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.audioInputs = devices.filter(d => d.kind === 'audioinput');
      this.renderMicOptions();
    } catch(e) { console.warn("Failed to enumerate devices", e); }
  }

  renderMicOptions() {
    const list = document.getElementById("mic-options-list");
    if (!list) return;
    list.innerHTML = this.audioInputs.map(mic => {
      const isSelected = mic.deviceId === this.activeMicId || (this.activeMicId === "default" && mic.deviceId === "default");
      const baseClass = "w-full text-left px-3 py-2.5 text-xs transition-all flex items-center justify-between rounded-lg cursor-pointer";
      const colorClass = isSelected ? "bg-accent/20 text-white font-medium border border-accent shadow-[0_0_8px_rgba(139,92,246,0.3)]" : "text-gray-400 hover:bg-white/10 hover:text-gray-100 border border-transparent";
      const indicator = isSelected ? `<span class="w-2 h-2 rounded-full bg-accent flex-shrink-0 shadow-[0_0_8px_rgba(139,92,246,0.8)]"></span>` : '';
      return `<button onclick="window.llamaditasApp.selectMicInput('${mic.deviceId}')" class="${baseClass} ${colorClass}"><span class="truncate pr-2">${mic.label || 'Micrófono predeterminado'}</span>${indicator}</button>`;
    }).join('');
  }

  selectMicInput(deviceId) {
    this.activeMicId = deviceId;
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
      this.roomId, this.userId, this.userName,
      (peerId, info) => this.onPeerJoined(peerId, info),
      (peerId) => this.onPeerLeft(peerId),
      (fromPeerId, signalType, payload) => {
        if (signalType === "avatar-sync") {
          if (this.remotePeers.has(fromPeerId)) {
            const p = this.remotePeers.get(fromPeerId);
            p.avatar_url = payload.avatar_url;
            this.remotePeers.set(fromPeerId, p);
            this.renderVideoTiles();
          }
        } else { window.webrtcManager.handleSignal(fromPeerId, signalType, payload); }
      },
      (action, payload, fromPeerId) => this.handleMusicAction(action, payload, fromPeerId),
      (data) => this.handlePeerStateUpdate(data),
      (payload) => this.handleMusicStateSync(payload)
    );
  }

  handleMusicStateSync(payload) {
    const yt = window.ytSync;
    if (!yt || !payload || yt.queue.length > 0) return;
    if (payload.isPlaying && !yt.isDeckActive) yt.togglePower();
    yt.handleServerState({ queue: payload.queue || [], currentIndex: payload.currentIndex || 0, isPlaying: !!payload.isPlaying, positionSec: payload.positionSec || 0 }, payload.from, "sync");
  }

  onPeerJoined(peerId, info) {
    if (this.remotePeers.has(peerId)) return;
    const peerName = info.name || "Amigo";
    this.remotePeers.set(peerId, { authUserId: info.auth_user_id, name: peerName, username: info.username, avatar_url: info.avatar_url, mic: info.mic !== false, cam: info.cam === true });
    if (info.auth_user_id && info.auth_user_id !== this.session?.user?.id) {
      this.callPartnerIds.add(info.auth_user_id);
      this.recordCallPartner(info.auth_user_id);
    }
    window.webrtcManager.getOrCreatePeer(peerId, info);
    this.showToast(`${peerName} se unió a la llamada`);
    window.sfx.play("userJoin");
    this.renderVideoTiles();
    this.renderMixerChannels();

    if (this.avatarUrl) window.supabaseP2P.sendSignal(peerId, "avatar-sync", { avatar_url: this.avatarUrl });
  }

  onPeerLeft(peerId) {
    const p = this.remotePeers.get(peerId);
    if (p) this.showToast(`${p.name || "Amigo"} salió de la sala`);
    window.sfx.play("userLeave");
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
      yt.handleServerState({ queue: yt.queue, currentIndex: yt.currentIndex, isPlaying: true, positionSec: payload.position || 0 }, fromPeerId, action);
    } else if (action === "pause") {
      yt.handleServerState({ queue: yt.queue, currentIndex: yt.currentIndex, isPlaying: false, positionSec: payload.position || 0 }, fromPeerId, action);
    } else if (action === "seek") {
      yt.handleServerState({ queue: yt.queue, currentIndex: yt.currentIndex, isPlaying: payload.isPlaying !== undefined ? payload.isPlaying : yt.isPlaying, positionSec: payload.position || 0 }, fromPeerId, action);
    } else if (action === "add-track") {
      if (payload.track) {
        yt.queue.push(payload.track); yt.renderQueueUI();
        if (yt.queue.length === 1 && yt.isDeckActive) yt.selectTrackLocally(0);
      }
    } else if (action === "add-multiple") {
      if (payload.tracks && payload.tracks.length > 0) {
        const wasEmpty = yt.queue.length === 0;
        yt.queue.push(...payload.tracks); yt.renderQueueUI();
        if (wasEmpty && yt.isDeckActive) yt.selectTrackLocally(0);
      }
    } else if (action === "select-track") {
      yt.currentIndex = payload.index || 0;
      yt.handleServerState({ queue: yt.queue, currentIndex: yt.currentIndex, isPlaying: true, positionSec: 0 }, fromPeerId, action);
    } else if (action === "next-track") {
      yt.skipNext();
    } else if (action === "prev-track") {
      yt.skipPrev();
    } else if (action === "remove-track") {
      const idx = payload.index;
      if (idx >= 0 && idx < yt.queue.length) {
        yt.queue.splice(idx, 1);
        if (yt.currentIndex >= yt.queue.length) yt.currentIndex = Math.max(0, yt.queue.length - 1);
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
    document.querySelectorAll(".local-video-feed").forEach(v => { v.srcObject = stream; v.muted = true; v.play().catch(e => console.warn(e)); });
    this.renderVideoTiles(); 
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

  generateTileHTML(peerId, p, isLocal, layoutPrefix) {
      const vol = isLocal ? 100 : window.audioMixer.getPeerVolume(peerId);
      const nameText = isLocal ? `${this.userName} (Tú)` : (p.name || "Amigo");
      const usernameDisplay = p.username ? `<span class="text-[9px] text-gray-400 leading-none pb-0.5">@${p.username}</span>` : '';
      
      const volControl = isLocal ? `
          <div class="flex items-center gap-1.5 bg-black/60 backdrop-blur-md px-2.5 py-1 rounded-full border border-white/10 text-[10px] sm:text-xs text-gray-300">
            <span class="text-[10px] sm:text-[11px] hidden xs:inline">Micrófono:</span>
            <div class="w-10 sm:w-12 h-1.5 bg-white/10 rounded-full overflow-hidden">
              <div class="local-mic-level-bar h-full bg-accent w-0 transition-all duration-75"></div>
            </div>
          </div>
      ` : `
          <div class="flex items-center gap-1.5 sm:gap-2 bg-black/60 backdrop-blur-md px-2 py-1 sm:px-3 sm:py-1.5 rounded-full border border-white/10">
            <svg class="w-3.5 h-3.5 custom-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/></svg>
            <input type="range" min="0" max="150" value="${vol}" oninput="window.llamaditasApp.onPeerVolumeSlider('${peerId}', this.value)" class="w-14 sm:w-20 cursor-pointer">
            <span id="${layoutPrefix}-overlay-vol-${peerId}" class="text-[10px] sm:text-[11px] font-mono text-gray-300 w-6 text-right">${vol}%</span>
          </div>
      `;

      return `
      <video id="${layoutPrefix}-video-stream-${peerId}" autoplay playsinline webkit-playsinline class="absolute inset-0 w-full h-full object-cover -z-10 transition-opacity duration-300 ${isLocal ? 'local-video-feed' : ''} ${p.cam ? 'opacity-100' : 'opacity-0'}" muted></video>
      <div id="${layoutPrefix}-cam-off-${peerId}" class="absolute inset-0 flex flex-col items-center justify-center p-4 text-center bg-black transition-opacity duration-500 ${p.cam ? 'opacity-0 hidden' : 'opacity-100'}"></div>
      
      <div class="flex items-start justify-between z-10 gap-2 w-full">
        <div class="flex items-center gap-1.5 sm:gap-2 bg-black/60 backdrop-blur-md px-2.5 py-1 rounded-full border border-white/10 text-[11px] sm:text-xs">
          <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
          <div class="flex flex-col">
              <span class="font-medium text-white truncate max-w-[100px] sm:max-w-none">${nameText}</span>
              ${usernameDisplay}
          </div>
          ${!isLocal ? `<span class="text-[9px] sm:text-[10px] text-emerald-400 font-mono bg-emerald-400/10 px-1.5 py-0.5 rounded ml-1">P2P HD</span>` : ''}
        </div>
        ${volControl}
      </div>

      <div class="flex items-center justify-between z-10 w-full mt-auto">
        <div id="${layoutPrefix}-speaking-badge-${peerId}" class="hidden flex items-center gap-1.5 text-xs text-white/90 bg-accent/20 border border-accent/40 px-2.5 py-1 rounded-lg backdrop-blur-md mt-auto">
          <div class="flex gap-0.5 items-end h-3">
            <span class="w-0.5 h-3 bg-accent rounded-full animate-bounce"></span>
            <span class="w-0.5 h-2 bg-accent rounded-full animate-bounce" style="animation-delay: 0.2s"></span>
            <span class="w-0.5 h-3.5 bg-accent rounded-full animate-bounce" style="animation-delay: 0.4s"></span>
          </div>
          <span class="text-[10px] sm:text-[11px] font-medium">Hablando</span>
        </div>
        <div></div>
      </div>
      `;
  }

  renderVideoTiles() {
    const remoteContainer = document.getElementById("remote-video-container");
    const screenshareSidebar = document.getElementById("screenshare-sidebar");
    const screenshareMain = document.getElementById("screenshare-main");
    const peersList = Array.from(this.remotePeers.entries());
    const localData = { cam: this.isCamOn, username: this.username, avatar_url: this.avatarUrl, name: "Tú" };

    if (screenshareMain) {
      screenshareMain.innerHTML = `
        <div class="w-full h-full flex flex-col items-center justify-center text-gray-500 text-sm">
           <svg class="w-12 h-12 mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
           Nadie está compartiendo pantalla
        </div>
      `;
      const activeNameEl = document.getElementById("screenshare-active-name");
      if (activeNameEl) activeNameEl.innerText = "Pantalla Compartida";
      
      if (this.localScreenStream) {
         screenshareMain.innerHTML = `<div class="video-contain"><video autoplay playsinline webkit-playsinline muted></video></div>`;
         screenshareMain.querySelector("video").srcObject = this.localScreenStream;
         if (activeNameEl) activeNameEl.innerText = "Tu Pantalla";
      } else {
        peersList.forEach(([peerId, p]) => {
          if (p.isSharingScreen || p.screenStream) {
            screenshareMain.innerHTML = `<div class="video-contain"><video autoplay playsinline webkit-playsinline></video></div>`;
            screenshareMain.querySelector("video").srcObject = p.screenStream;
            if (activeNameEl) activeNameEl.innerText = `Pantalla de ${p.name || "Amigo"}`;
          }
        });
      }
    }

    if (remoteContainer) {
      remoteContainer.innerHTML = "";
      const cameraCount = peersList.length + 1;
      const columns = cameraCount <= 2 ? 1 : Math.ceil(Math.sqrt(cameraCount));
      const mobileColumns = Math.min(columns, 2);
      remoteContainer.dataset.cameraCount = String(cameraCount);
      remoteContainer.style.setProperty("--camera-columns", columns);
      remoteContainer.style.setProperty("--camera-rows", Math.ceil(cameraCount / columns));
      remoteContainer.style.setProperty("--camera-mobile-columns", mobileColumns);
      remoteContainer.style.setProperty("--camera-mobile-rows", Math.ceil(cameraCount / mobileColumns));
    }
    if (screenshareSidebar) screenshareSidebar.innerHTML = "";

    if (remoteContainer) {
      const tile = document.createElement("div");
      tile.className = "relative rounded-2xl overflow-hidden glass border border-white/10 flex flex-col justify-between p-3 sm:p-4 video-tile group min-h-[260px] sm:min-h-[400px]";
      tile.id = `peer-tile-local`;
      tile.innerHTML = this.generateTileHTML("local", localData, true, "studio");
      remoteContainer.appendChild(tile);
      this.renderCamOffPlaceholder(document.getElementById(`studio-cam-off-local`), this.avatarUrl, `studio-cam-local`);
      const vid = document.getElementById(`studio-video-stream-local`);
      if (vid && window.webrtcManager.localStream) vid.srcObject = window.webrtcManager.localStream;
      
      if (peersList.length === 0) {
          const inviteTile = document.createElement("div");
          inviteTile.className = "camera-invite flex flex-col items-center justify-center p-6 sm:p-8 text-center glass rounded-2xl border border-white/10 bg-gradient-to-b from-gray-900/30 to-black/80";
          inviteTile.innerHTML = `
            <div class="w-12 h-12 sm:w-16 sm:h-16 rounded-2xl bg-accent/20 border border-accent/40 flex items-center justify-center text-accent mb-4 glow-accent">
              <svg class="w-6 h-6 sm:w-8 sm:h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"/></svg>
            </div>
            <h4 class="text-white font-bold text-sm sm:text-base mb-1">Esperando a que un amigo se conecte</h4>
            <p class="text-xs text-gray-400 max-w-sm mb-4">Envía tu enlace de invitación a un amigo. Cuando lo abra, se verán aquí al instante.</p>
            <button onclick="window.llamaditasApp.copyInviteLink()" class="px-4 py-2 rounded-xl bg-accent text-white text-xs font-semibold hover:opacity-90 transition flex items-center gap-2 glow-accent">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"/></svg>
              <span>Copiar enlace de invitación</span>
            </button>
          `;
          remoteContainer.appendChild(inviteTile);
      }
    }

    if (screenshareSidebar) {
      const sideTile = document.createElement("div");
      sideTile.className = "relative rounded-2xl overflow-hidden glass border border-white/10 flex flex-col justify-between p-3 video-tile group min-h-[220px]";
      sideTile.id = `screen-peer-tile-local`;
      sideTile.innerHTML = this.generateTileHTML("local", localData, true, "screen");
      screenshareSidebar.appendChild(sideTile);
      this.renderCamOffPlaceholder(document.getElementById(`screen-cam-off-local`), this.avatarUrl, `screen-cam-local`);
      const vid = document.getElementById(`screen-video-stream-local`);
      if (vid && window.webrtcManager.localStream) vid.srcObject = window.webrtcManager.localStream;
    }

    peersList.forEach(([peerId, p]) => {
      if (remoteContainer) {
          const tile = document.createElement("div");
          tile.className = "relative rounded-2xl overflow-hidden glass border border-white/10 flex flex-col justify-between p-3 sm:p-4 video-tile group min-h-[260px] sm:min-h-[400px]";
          tile.id = `peer-tile-${peerId}`;
          tile.innerHTML = this.generateTileHTML(peerId, p, false, "studio");
          remoteContainer.appendChild(tile);
          this.renderCamOffPlaceholder(document.getElementById(`studio-cam-off-${peerId}`), p.avatar_url, `studio-cam-${peerId}`);
          if (p.stream) {
              const vid = document.getElementById(`studio-video-stream-${peerId}`);
              vid.srcObject = p.stream;
              vid.play().catch(e=>console.warn(e));
          }
      }
      if (screenshareSidebar) {
          const sideTile = document.createElement("div");
          sideTile.className = "relative rounded-2xl overflow-hidden glass border border-white/10 flex flex-col justify-between p-3 video-tile group min-h-[220px]";
          sideTile.id = `screen-peer-tile-${peerId}`;
          sideTile.innerHTML = this.generateTileHTML(peerId, p, false, "screen");
          screenshareSidebar.appendChild(sideTile);
          this.renderCamOffPlaceholder(document.getElementById(`screen-cam-off-${peerId}`), p.avatar_url, `screen-cam-${peerId}`);
          if (p.stream) {
              const vid = document.getElementById(`screen-video-stream-${peerId}`);
              vid.srcObject = p.stream;
              vid.play().catch(e=>console.warn(e));
          }
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
          <span class="text-xs font-semibold text-white">Música de YouTube</span>
        </div>
        <span id="mixer-disp-music-vol" class="text-xs font-mono custom-accent">${musicVol}%</span>
      </div>
      <input type="range" min="0" max="100" value="${musicVol}" oninput="window.llamaditasApp.onMusicVolumeSlider(this.value)" class="w-full">
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
            <button onclick="window.llamaditasApp.togglePeerMute('${peerId}')" class="text-xs text-gray-400 hover:text-white" title="Silenciar/Activar audio">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/></svg>
            </button>
            <span id="mixer-disp-peer-vol-${peerId}" class="text-xs font-mono custom-accent">${vol}%</span>
          </div>
        </div>
        <input type="range" min="0" max="150" value="${vol}" oninput="window.llamaditasApp.onPeerVolumeSlider('${peerId}', this.value)" class="w-full">
      `;
      list.appendChild(chan);
    });
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
    const overlayS = document.getElementById(`studio-overlay-vol-${peerId}`);
    const overlaySc = document.getElementById(`screen-overlay-vol-${peerId}`);
    if (overlayS) overlayS.innerText = `${val}%`;
    if (overlaySc) overlaySc.innerText = `${val}%`;
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
    
    const group = document.getElementById("mic-group");
    const btn = document.getElementById("btn-toggle-mic");
    const label = btn.querySelector(".label-mic");
    const icon = btn.querySelector(".icon-mic");

    if (this.isMicOn) {
      group.className = "flex items-stretch rounded-xl bg-white/10 hover:bg-white/15 transition border border-transparent focus-within:border-white/20 flex-1 sm:flex-initial";
      if (label) label.innerText = "Micrófono activo";
      if (icon) {
        icon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/>`;
        icon.classList.add("text-emerald-400");
        icon.classList.remove("text-red-400");
      }
    } else {
      group.className = "flex items-stretch rounded-xl bg-red-500/20 border border-red-500/40 transition flex-1 sm:flex-initial";
      if (label) label.innerText = "Micrófono apagado";
      if (icon) {
        icon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2"/>`;
        icon.classList.remove("text-emerald-400");
        icon.classList.add("text-red-400");
      }
    }
    if (this.isUsingSupabase) window.supabaseP2P.sendUserState(this.isMicOn, this.isCamOn, false);
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
    const label = btn.querySelector(".label-cam");
    if (isOn) {
      btn.className = "flex items-center justify-center gap-1.5 sm:gap-2 px-3 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs font-medium transition flex-1 sm:flex-initial";
      if (label) label.innerText = "Cámara encendida";
    } else {
      btn.className = "flex items-center justify-center gap-1.5 sm:gap-2 px-3 py-2 rounded-xl bg-red-500/20 border border-red-500/40 text-red-400 text-xs font-medium transition flex-1 sm:flex-initial";
      if (label) label.innerText = "Cámara apagada";
    }
  }

  toggleMusicDrawer() {
    this.isMusicDrawerOpen = !this.isMusicDrawerOpen;
    window.sfx.play(this.isMusicDrawerOpen ? "drawerOpen" : "drawerClose");
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
    const active = await window.webrtcManager.toggleScreenShare();
    const btn = document.getElementById("btn-screenshare");
    
    if (active) {
      if (btn) btn.className = "flex items-center justify-center gap-1.5 sm:gap-2 px-3 py-2 rounded-xl bg-accent text-white text-xs font-medium transition glow-accent flex-1 sm:flex-initial";
      this.showToast("Compartiendo pantalla completa");
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
    if (btn) btn.className = "flex items-center justify-center gap-1.5 sm:gap-2 px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-gray-300 text-xs font-medium transition flex-1 sm:flex-initial";
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
      if (speaking !== undefined) this.updatePeerSpeakingState(from, speaking);
      
      if (cam !== undefined) {
        p.cam = cam;
        const vidEls = [
            document.getElementById(`studio-video-stream-${from}`),
            document.getElementById(`screen-video-stream-${from}`)
        ];
        const offEls = [
            document.getElementById(`studio-cam-off-${from}`),
            document.getElementById(`screen-cam-off-${from}`)
        ];
        
        for (let i = 0; i < vidEls.length; i++) {
          if (vidEls[i] && offEls[i]) {
            if (cam) {
              vidEls[i].classList.remove("opacity-0");
              offEls[i].style.opacity = "0";
              setTimeout(() => offEls[i].classList.add("hidden"), 300);
            } else {
              vidEls[i].classList.add("opacity-0");
              offEls[i].classList.remove("hidden");
              offEls[i].style.opacity = "1";
            }
          }
        }
      }
    }
  }

  updatePeerSpeakingState(peerId, isSpeaking) {
    const tileIds = [`peer-tile-${peerId}`, `screen-peer-tile-${peerId}`];
    const badgeIds = [`studio-speaking-badge-${peerId}`, `screen-speaking-badge-${peerId}`];
    
    tileIds.forEach(id => {
      const tile = document.getElementById(id);
      if (tile) {
        if (isSpeaking) tile.classList.add("speaking-pulse");
        else tile.classList.remove("speaking-pulse");
      }
    });

    badgeIds.forEach(id => {
      const badge = document.getElementById(id);
      if (badge) {
        if (isSpeaking) badge.classList.remove("hidden");
        else badge.classList.add("hidden");
      }
    });
  }

  setLayout(layout) {
    const layoutChanged = this.currentLayout !== layout;
    this.currentLayout = layout;
    const layouts = ["studio", "cinema", "screenshare"];
    layouts.forEach(l => {
      const el = document.getElementById(`layout-${l}`);
      const btn = document.getElementById(`btn-layout-${l}`);
      if (l === layout) {
        if (el) el.classList.remove("hidden");
        if (btn) btn.className = "layout-option is-active relative z-10 px-2.5 sm:px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all bg-transparent text-white shadow-sm flex items-center gap-1.5";
      } else {
        if (el) el.classList.add("hidden");
        if (btn) btn.className = "layout-option relative z-10 px-2.5 sm:px-3.5 py-1.5 rounded-lg text-xs font-medium text-gray-400 hover:text-white transition-all flex items-center gap-1.5";
      }
    });
    this.updateLayoutIndicator(layout);
    if (layoutChanged) window.sfx.play("layoutSelect");
    requestAnimationFrame(() => this.positionTheaterPortal());
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
        top: `${rect.top}px`, left: `${rect.left}px`,
        width: `${rect.width}px`, height: `${rect.height}px`,
        opacity: "1", pointerEvents: "auto", borderRadius: "0.75rem"
      });
    } else {
      Object.assign(portal.style, {
        top: "-9999px", left: "-9999px",
        width: "1px", height: "1px",
        opacity: "0", pointerEvents: "none", borderRadius: "0"
      });
    }
  }

  updateLayoutIndicator(layout) {
    const indicator = document.getElementById("layout-active-indicator");
    const button = document.getElementById(`btn-layout-${layout}`);
    const switcher = document.getElementById("layout-switchers");
    if (!indicator || !button || !switcher) return;
    indicator.style.left = `${button.offsetLeft}px`;
    indicator.style.width = `${button.offsetWidth}px`;
  }

  toggleCinemaFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => {
        console.warn(`Error pantalla completa: ${err.message}`);
      });
    } else document.exitFullscreen();
  }

  copyInviteLink() {
    const inviteUrl = `${window.location.protocol}//${window.location.host}${window.location.pathname}?room=${this.roomId}`;
    navigator.clipboard.writeText(inviteUrl);
    this.showToast("Enlace copiado al portapapeles");
  }

  copyRoomCode() {
    navigator.clipboard.writeText(this.roomId);
    this.showToast(`Código de sala ${this.roomId} copiado`);
  }

  toggleMixerModal() { document.getElementById("modal-mixer").classList.toggle("hidden"); }
  
  async leaveCall() {
    window.sfx.play("callExit");
    if (this.callStartTime > 0) {
      const unsavedSeconds = Math.max(0, Math.floor((Date.now() - this.lastPartnerStatAt) / 1000));
      if (unsavedSeconds > 0) await this.updatePartnerTime(unsavedSeconds);
    }
    window.webrtcManager.closeAll();
    window.supabaseP2P.leave();
    window.location.href = window.location.pathname;
  }

  async initAuth() {
    if (!window.supabaseClient) return;
    const { data } = await window.supabaseClient.auth.getSession();
    if (data && data.session) {
      this.session = data.session;
      const user = data.session.user;
      const metadata = user.user_metadata || {};
      this.username = metadata.preferred_username || metadata.user_name || metadata.username || user.email?.split("@")[0] || `user_${user.id.slice(0, 8)}`;
      this.userName = metadata.full_name || metadata.name || this.username;
      this.avatarUrl = metadata.avatar_url || metadata.picture || null;
      await this.ensureProfile(user);
      
      const btn = document.getElementById("btn-login");
      if (btn) btn.innerHTML = `<img src="${this.avatarUrl}" class="w-5 h-5 rounded-full object-cover"> <span>Ver Perfil</span>`;
      
      const nameInput = document.getElementById("input-user-name");
      if (nameInput) nameInput.value = this.userName;
      
      this.loadUserStats();
    }
  }

  handleLoginBtnClick() {
    if (this.session) this.openProfile();
    else this.loginWithProvider();
  }

  async loginWithProvider() {
    if (!window.supabaseClient) return;
    await window.supabaseClient.auth.signInWithOAuth({ provider: 'google' });
  }

  async logout() {
    if (window.supabaseClient) await window.supabaseClient.auth.signOut();
    window.location.reload();
  }

  async deleteAccount() {
    const confirmDelete = confirm("¿Estás seguro de que deseas eliminar tu cuenta permanentemente? Esto borrará tus estadísticas y datos. Esta acción no se puede deshacer.");
    if (confirmDelete && window.supabaseClient) {
      try {
        await window.supabaseClient.rpc('delete_user_account');
        await window.supabaseClient.auth.signOut();
        window.location.reload();
      } catch (err) {
        this.showToast("Error al eliminar la cuenta.");
      }
    }
  }

  openProfile() {
    const nameEl = document.getElementById("profile-modal-name");
    const avatarEl = document.getElementById("profile-modal-avatar");
    const callsEl = document.getElementById("profile-stat-calls");
    const timeEl = document.getElementById("profile-stat-time");

    if (nameEl) nameEl.innerText = this.userName;
    if (avatarEl) avatarEl.src = this.avatarUrl || "https://ui-avatars.com/api/?name=?&background=random";
    if (callsEl) callsEl.innerText = this.stats.totalCalls;
    if (timeEl) timeEl.innerText = this.stats.totalTimeSec;
    
    const topFriendLink = document.getElementById("profile-top-friend-link");
    const topFriendAvatar = document.getElementById("profile-top-friend-avatar");
    
    if (topFriendLink && topFriendAvatar) {
      if (this.stats.topFriendName) {
        topFriendLink.innerText = this.stats.topFriendName;
        topFriendLink.href = this.stats.topFriendLink;
        topFriendAvatar.src = this.stats.topFriendAvatar;
      } else {
        topFriendLink.innerText = "Aún no hay datos";
        topFriendLink.href = "#";
        topFriendAvatar.src = "https://ui-avatars.com/api/?name=?&background=random";
      }
    }
    
    const modal = document.getElementById("modal-profile");
    if (modal) {
      modal.classList.remove("hidden", "is-closing");
      window.sfx.play("profileOpen");
    }
  }

  closeProfile() {
    const modal = document.getElementById("modal-profile");
    if (modal) {
      modal.classList.add("is-closing");
      window.sfx.play("profileClose");
      setTimeout(() => modal.classList.add("hidden"), 180);
    }
    document.getElementById("input-avatar-url").classList.add("hidden");
  }

  async updateProfilePicture() {
    const input = document.getElementById("avatar-url-field").value.trim();
    if (input && window.supabaseClient && this.session) {
      const { error: authError } = await window.supabaseClient.auth.updateUser({
        data: { avatar_url: input }
      });
      
      const { error: dbError } = await window.supabaseClient
        .from('profiles') 
        .update({ avatar_url: input })
        .eq('id', this.session.user.id);

      if (!authError && !dbError) {
        this.avatarUrl = input;
        document.getElementById("profile-modal-avatar").src = input;
        this.showToast("Foto de perfil actualizada.");
        document.getElementById("input-avatar-url").classList.add("hidden");
        this.updateCamPlaceholder(); 
      } else {
        console.error("Error updating avatar:", authError || dbError);
        this.showToast("Hubo un error al guardar la imagen.");
      }
    }
  }

  async ensureProfile(user) {
    if (!user || !window.supabaseClient) return;
    const { error } = await window.supabaseClient.from('profiles').upsert({
      id: user.id,
      username: this.username,
      avatar_url: this.avatarUrl
    }, { onConflict: 'id' });
    if (error) console.warn("Error guardando perfil:", error.message);
  }

  async loadUserStats() {
    if (!this.session || !window.supabaseClient) return;
    try {
      const { data, error } = await window.supabaseClient.rpc('get_my_stats');

      const stats = Array.isArray(data) ? data[0] : data;
      if (stats && !error) {
        this.stats.totalCalls = stats.total_calls || 0;
        this.stats.totalTimeSec = Math.floor((stats.total_time_sec || 0) / 60);
        this.stats.topFriendName = stats.top_friend_name || "";
        this.stats.topFriendAvatar = stats.top_friend_avatar || "";
        this.stats.topFriendLink = stats.top_friend_id ? `#user-${stats.top_friend_id}` : "#";
        
        const callsEl = document.getElementById("profile-stat-calls");
        const timeEl = document.getElementById("profile-stat-time");
        if (callsEl) callsEl.innerText = this.stats.totalCalls;
        if (timeEl) timeEl.innerText = this.stats.totalTimeSec;
      } else if (error && error.code !== 'PGRST116') {
        console.warn("Error fetching stats:", error.message);
      }
    } catch(e) { 
      console.warn("Error cargando stats", e); 
    }
  }

  async updateStat(statName, increment = 1) {
    if (!this.session || !window.supabaseClient) return;
    const { error } = await window.supabaseClient.rpc('increment_my_stat', { 
      stat_column: statName, inc_val: increment 
    });
    if (error) console.warn("Stats API req failed", error);
  }

  async recordCallPartner(partnerId) {
    if (!this.session || !partnerId || this.recordedCallPartnerIds.has(partnerId)) return;
    this.recordedCallPartnerIds.add(partnerId);
    const { error } = await window.supabaseClient.rpc('record_call_partner', { partner_user_id: partnerId, duration_seconds: 0 });
    if (error) console.warn("Partner call stat failed:", error.message);
  }

  async updatePartnerTime(seconds) {
    if (!this.session || this.callPartnerIds.size === 0) return;
    for (const partnerId of this.callPartnerIds) {
      const { error } = await window.supabaseClient.rpc('record_call_partner', { partner_user_id: partnerId, duration_seconds: seconds });
      if (error) console.warn("Partner time stat failed:", error.message);
    }
  }

  toggleChat() {
    this.isChatOpen = !this.isChatOpen;
    window.sfx.play(this.isChatOpen ? "drawerOpen" : "drawerClose");
    const sidebar = document.getElementById("chat-sidebar");
    if (this.isChatOpen) {
      sidebar.classList.remove("w-0", "opacity-0", "hidden");
      sidebar.classList.add("w-full", "sm:w-80", "opacity-100", "animate-surface-pop");
    } else {
      sidebar.classList.remove("animate-surface-pop");
      sidebar.classList.add("w-0", "opacity-0");
      sidebar.classList.remove("w-full", "sm:w-80", "opacity-100");
    }
  }

  initChatCommands() {
    const input = document.getElementById("input-chat");
    const menu = document.createElement("div");
    menu.id = "chat-command-menu";
    menu.className = "hidden absolute bottom-[100%] left-0 right-0 mb-2 mx-3 bg-[#0f111a] border border-white/10 rounded-xl overflow-hidden shadow-[0_0_20px_rgba(0,0,0,0.8)] z-50 flex-col max-h-48 overflow-y-auto";
    
    input.parentElement.parentElement.appendChild(menu);

    input.addEventListener("input", (e) => {
        const val = e.target.value;
        if (val === "/") {
            this.showCommandMenu([{ cmd: '/msg', desc: 'Mensaje privado a otros usuarios' }]);
        } else if (val.startsWith("/msg @")) {
            const search = val.substring(6).split(' ')[0].toLowerCase();
            const spaceIndex = val.indexOf(' ', 6);
            if (spaceIndex === -1) {
                const users = Array.from(this.remotePeers.values())
                    .filter(p => p.username && p.username.toLowerCase().includes(search));
                this.showUsersMenu(users);
            } else {
                this.hideCommandMenu();
            }
        } else {
            this.hideCommandMenu();
        }
    });
  }

  showCommandMenu(commands) {
    const menu = document.getElementById("chat-command-menu");
    menu.innerHTML = commands.map(c => `
        <button onclick="window.llamaditasApp.selectCommand('${c.cmd}')" class="w-full text-left px-3 py-2.5 hover:bg-white/10 transition flex flex-col border-b border-white/5 last:border-0">
            <span class="text-xs font-bold text-accent">${c.cmd}</span>
            <span class="text-[10px] text-gray-400 mt-0.5">${c.desc}</span>
        </button>
    `).join('');
    menu.classList.remove("hidden");
    menu.classList.add("flex");
  }

  showUsersMenu(users) {
    const menu = document.getElementById("chat-command-menu");
    if (users.length === 0) {
        menu.innerHTML = `<div class="px-3 py-3 text-[10px] text-gray-500 text-center">No hay usuarios disponibles</div>`;
    } else {
        menu.innerHTML = users.map(u => `
            <button onclick="window.llamaditasApp.selectUser('${u.username}')" class="w-full text-left px-3 py-2.5 hover:bg-white/10 transition flex items-center gap-2.5 border-b border-white/5 last:border-0">
                <img src="${u.avatar_url || 'https://ui-avatars.com/api/?name='+u.name}" class="w-6 h-6 rounded-full object-cover shadow-sm">
                <div class="flex flex-col">
                    <span class="text-xs font-bold text-white">${u.name}</span>
                    <span class="text-[10px] text-gray-400">@${u.username}</span>
                </div>
            </button>
        `).join('');
    }
    menu.classList.remove("hidden");
    menu.classList.add("flex");
  }

  hideCommandMenu() {
    const menu = document.getElementById("chat-command-menu");
    if (menu) {
      menu.classList.add("hidden");
      menu.classList.remove("flex");
    }
  }

  selectCommand(cmd) {
    const input = document.getElementById("input-chat");
    input.value = cmd + ' @';
    input.focus();
    input.dispatchEvent(new Event('input'));
  }

  selectUser(username) {
    const input = document.getElementById("input-chat");
    input.value = `/msg @${username} `;
    input.focus();
    this.hideCommandMenu();
  }

  sendChat() {
    const input = document.getElementById("input-chat");
    const text = input.value.trim();
    if (!text) return;

    if (text.startsWith("/msg ")) {
      if (!this.session) {
        this.showToast("Solo los usuarios registrados pueden enviar mensajes privados.");
        return;
      }
      const parts = text.split(" ");
      let targetUsername = parts[1];
      if (targetUsername.startsWith("@")) targetUsername = targetUsername.substring(1);
      const actualMsg = parts.slice(2).join(" ");
      
      let targetPeerId = null;
      for (const [pId, pData] of this.remotePeers.entries()) {
        if (pData.username === targetUsername) { targetPeerId = pId; break; }
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
    this.hideCommandMenu();
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
    if (this.isChatOpen) return;
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
    if (indicator) indicator.className = connected ? "w-2 h-2 rounded-full bg-emerald-400 animate-pulse" : "w-2 h-2 rounded-full bg-amber-400 animate-pulse";
    if (text) text.innerText = customText || (connected ? "P2P de Supabase conectado" : "Conectando...");
  }

  showToast(msg) {
    window.sfx.play("toast");
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

window.llamaditasApp = new LlamaditasApp();