// Llamaditas Synchronized YouTube Player & Queue Manager
class YouTubeSyncEngine {
  constructor() {
    this.player = null;
    this.isReady = false;
    this.isDeckActive = false; 
    this.queue = []; 
    this.currentIndex = 0;
    this.isPlaying = false;
    this.syncSender = null; 
    this.isSyncing = false;
    this.progressInterval = null;
    this.pendingVideoId = null;
    this.pendingStartTime = 0;
  }

  setSyncSender(senderFn) {
    this.syncSender = senderFn;
  }

  togglePower() {
    this.isDeckActive = !this.isDeckActive;
    console.log(`[YT Deck] Power toggled: ${this.isDeckActive ? "ON" : "OFF"}`);

    if (this.isDeckActive) {
      this.loadIframeAPI();
    } else {
      this.sleepPlayer();
    }
    this.renderDeckStateUI();
  }

  loadIframeAPI() {
    if (window.YT && window.YT.Player) {
      this.createPlayer();
      return;
    }
    const existing = document.getElementById("yt-iframe-script");
    if (!existing) {
      const tag = document.createElement("script");
      tag.id = "yt-iframe-script";
      tag.src = "https://www.youtube.com/iframe_api";
      const firstScriptTag = document.getElementsByTagName("script")[0];
      firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

      window.onYouTubeIframeAPIReady = () => {
        if (this.isDeckActive) {
          this.createPlayer();
        }
      };
    } else if (window.YT && window.YT.Player) {
      this.createPlayer();
    }
  }

  createPlayer() {
    const container = document.getElementById("yt-player-target");
    if (!container) return;

    if (this.player && typeof this.player.destroy === "function") {
      try { this.player.destroy(); } catch (e) {}
    }

    const currentTrack = this.queue[this.currentIndex];
    const initialVid = currentTrack ? currentTrack.videoId : "";

    this.player = new YT.Player("yt-player-target", {
      height: "100%",
      width: "100%",
      videoId: initialVid,
      playerVars: { autoplay: 0, controls: 1, disablekb: 0, enablejsapi: 1, fs: 1, modestbranding: 1, rel: 0, playsinline: 1, origin: window.location.origin },
      events: {
        onReady: (event) => this.onPlayerReady(event),
        onStateChange: (event) => this.onPlayerStateChange(event),
        onError: (event) => { console.warn("[YT Player] Error:", event.data); setTimeout(() => this.skipNext(), 2000); }
      }
    });
  }

  sleepPlayer() {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
    if (this.player && typeof this.player.destroy === "function") {
      try { this.player.pauseVideo(); this.player.destroy(); } catch (e) {}
      this.player = null;
    }
    this.isReady = false;
    this.isPlaying = false;
    this.updatePlayPauseButtonUI(false);
  }

  onPlayerReady(event) {
    this.isReady = true;
    const initVol = window.audioMixer ? window.audioMixer.getMusicVolume() : 70;
    this.setVolume(initVol);

    if (this.pendingVideoId) {
      this.player.loadVideoById(this.pendingVideoId, this.pendingStartTime);
      if (!this.isPlaying) this.player.pauseVideo();
      this.pendingVideoId = null;
    }
    this.startProgressTracking();
  }

  setVolume(vol) {
    if (this.player && this.isReady && typeof this.player.setVolume === "function") {
      const linear = vol / 100;
      const logVol = linear === 0 ? 0 : Math.round(Math.pow(linear, 2) * 100);
      this.player.setVolume(logVol);
      if (vol === 0) this.player.mute();
      else this.player.unMute();
    }
  }

  onPlayerStateChange(event) {
    if (this.isSyncing) return;
    const state = event.data;
    const currentTime = this.player.getCurrentTime() || 0;

    if (state === YT.PlayerState.PLAYING) {
      this.isPlaying = true;
      this.sendMusicAction("play", { position: currentTime });
    } else if (state === YT.PlayerState.PAUSED) {
      this.isPlaying = false;
      this.sendMusicAction("pause", { position: currentTime });
    } else if (state === YT.PlayerState.ENDED) {
      this.isPlaying = false;
      this.skipNext();
    }
  }

  sendMusicAction(action, payload) {
    if (this.syncSender) this.syncSender(action, payload);
  }

  handleServerState(state, triggeredBy, action) {
    this.queue = state.queue || [];
    this.currentIndex = state.currentIndex || 0;
    const serverPlaying = state.isPlaying;
    const serverPos = state.positionSec || 0;

    this.renderQueueUI();

    const currentTrack = this.queue[this.currentIndex];
    if (!currentTrack) {
      this.updateTrackInfoPlaceholder();
      return;
    }

    this.updateNowPlayingUI(currentTrack);

    if (!this.isDeckActive || !this.isReady || !this.player || typeof this.player.getPlayerState !== "function") {
      this.pendingVideoId = currentTrack.videoId;
      this.pendingStartTime = serverPos;
      this.isPlaying = serverPlaying;
      return;
    }

    const currUrl = this.player.getVideoUrl() || "";
    const isSameVideo = currUrl.includes(currentTrack.videoId);

    this.isSyncing = true;

    try {
      if (!isSameVideo) {
        this.player.loadVideoById({ videoId: currentTrack.videoId, startSeconds: serverPos });
        if (!serverPlaying) {
          setTimeout(() => { if (this.player && typeof this.player.pauseVideo === "function") this.player.pauseVideo(); }, 300);
        }
      } else {
        const localPos = this.player.getCurrentTime() || 0;
        const drift = Math.abs(localPos - serverPos);
        if (drift > 1.2) this.player.seekTo(serverPos, true);

        const localState = this.player.getPlayerState();
        if (serverPlaying && localState !== YT.PlayerState.PLAYING) this.player.playVideo();
        else if (!serverPlaying && localState === YT.PlayerState.PLAYING) this.player.pauseVideo();
      }
    } catch (e) {
      console.warn("[YT Sync] Adjust error:", e);
    } finally {
      setTimeout(() => { this.isSyncing = false; }, 400);
    }

    this.updatePlayPauseButtonUI(serverPlaying);
  }

  togglePlayPause() {
    if (!this.isDeckActive) {
      this.togglePower();
      return;
    }
    if (!this.player || !this.isReady) return;
    const pos = this.player.getCurrentTime() || 0;
    if (this.isPlaying) {
      this.player.pauseVideo(); 
      this.isPlaying = false;
      this.updatePlayPauseButtonUI(false);
      if (this.syncSender) this.syncSender("pause", { position: pos });
    } else {
      this.player.playVideo(); 
      this.isPlaying = true;
      this.updatePlayPauseButtonUI(true);
      if (this.syncSender) this.syncSender("play", { position: pos });
    }
  }

  seekFromProgressBar(event, element) {
    if (!this.player || !this.isReady || typeof this.player.getDuration !== "function") return;
    const rect = element.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const duration = this.player.getDuration() || 0;
    const targetTime = duration * percent;
    
    this.player.seekTo(targetTime, true);
    this.isPlaying = true;
    this.updatePlayPauseButtonUI(true);
    
    if (this.syncSender) this.syncSender("seek", { position: targetTime });
  }

  skipNext() {
    if (this.queue.length === 0) return;
    let nextIdx = this.currentIndex + 1;
    if (nextIdx >= this.queue.length) nextIdx = 0;
    this.selectTrack(nextIdx);
  }

  skipPrev() {
    if (this.queue.length === 0) return;
    let prevIdx = this.currentIndex - 1;
    if (prevIdx < 0) prevIdx = this.queue.length - 1;
    this.selectTrack(prevIdx);
  }

  selectTrack(index) {
    this.applyLocalAction("select-track", { index });
    if (this.syncSender) this.syncSender("select-track", { index });
  }

  removeTrack(index) {
    this.applyLocalAction("remove-track", { index });
    if (this.syncSender) this.syncSender("remove-track", { index });
  }

  reorderTrack(fromIndex, toIndex) {
    if (fromIndex === toIndex) return;
    this.applyLocalAction("reorder", { fromIndex, toIndex });
    if (this.syncSender) this.syncSender("reorder", { fromIndex, toIndex });
  }

  async addLink(url) {
    if (!url || !url.trim()) return;
    const cleanUrl = url.trim();

    const playlistMatch = cleanUrl.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    if (playlistMatch) {
        const pid = playlistMatch[1];
        try {
            const res = await fetch(`https://yt.lemnoslife.com/playlistItems?part=snippet&playlistId=${pid}&maxResults=50`);
            const data = await res.json();
            if (data && data.items && data.items.length > 0) {
                const tracks = data.items.map(item => {
                    const snippet = item.snippet;
                    return {
                        id: `vid-${snippet.resourceId.videoId}-${Date.now()}-${Math.random()}`,
                        title: snippet.title,
                        videoId: snippet.resourceId.videoId,
                        author: snippet.videoOwnerChannelTitle || "YouTube",
                        thumbnail: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || `https://img.youtube.com/vi/${snippet.resourceId.videoId}/mqdefault.jpg`,
                        duration: "Track"
                    };
                }).filter(t => t.title !== "Private video" && t.title !== "Deleted video");
                
                if (tracks.length > 0) {
                    this.applyLocalAction("add-multiple", { tracks });
                    if (this.syncSender) this.syncSender("add-multiple", { tracks });
                    this.ensureActiveOnAdd();
                    return;
                }
            }
        } catch (e) {
            console.warn("Error fetching playlist API, falling back to single video...", e);
        }
    }

    const videoMatch = cleanUrl.match(/(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([a-zA-Z0-9_-]{11})/);
    const videoId = videoMatch ? videoMatch[1] : null;

    if (!videoId) {
      if (window.llamaditasApp) window.llamaditasApp.showToast("Pega un enlace de YouTube válido.");
      return;
    }

    let title = `YouTube Track (${videoId})`;
    let author = "YouTube";
    const thumbnail = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;

    try {
      const oembedUrl = `https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`;
      const resp = await fetch(oembedUrl);
      if (resp.ok) {
        const data = await resp.json();
        if (data.title && !data.error) title = data.title;
        if (data.author_name) author = data.author_name;
      }
    } catch (err) {}

    const track = { id: `vid-${videoId}-${Date.now()}`, title, videoId, author, thumbnail, duration: "Track" };
    this.applyLocalAction("add-track", { track });
    if (this.syncSender) this.syncSender("add-track", { track });
    this.ensureActiveOnAdd();
  }

  applyLocalAction(action, payload) {
    if (action === "add-track") {
      if (payload.track) {
        this.queue.push(payload.track);
        this.renderQueueUI();
        if (this.queue.length === 1) this.selectTrackLocally(0);
      }
    } else if (action === "add-multiple") {
      if (payload.tracks && payload.tracks.length > 0) {
        const wasEmpty = this.queue.length === 0;
        this.queue.push(...payload.tracks);
        this.renderQueueUI();
        if (wasEmpty) this.selectTrackLocally(0);
      }
    } else if (action === "remove-track") {
      const idx = payload.index;
      if (idx >= 0 && idx < this.queue.length) {
        this.queue.splice(idx, 1);
        if (this.currentIndex >= this.queue.length) this.currentIndex = Math.max(0, this.queue.length - 1);
        this.renderQueueUI();
      }
    } else if (action === "reorder") {
      const { fromIndex, toIndex } = payload;
      if (fromIndex >= 0 && fromIndex < this.queue.length && toIndex >= 0 && toIndex < this.queue.length) {
        const item = this.queue.splice(fromIndex, 1)[0];
        this.queue.splice(toIndex, 0, item);
        this.renderQueueUI();
      }
    } else if (action === "select-track") {
      this.selectTrackLocally(payload.index || 0);
    }
  }

  selectTrackLocally(index) {
    if (index < 0 || index >= this.queue.length) return;
    this.currentIndex = index;
    const track = this.queue[index];
    this.updateNowPlayingUI(track);
    this.renderQueueUI();

    if (this.isDeckActive && this.isReady && this.player && typeof this.player.loadVideoById === "function") {
      this.player.loadVideoById({ videoId: track.videoId, startSeconds: 0 });
      this.isPlaying = true;
      this.updatePlayPauseButtonUI(true);
    } else if (this.isDeckActive) {
      this.pendingVideoId = track.videoId;
      this.pendingStartTime = 0;
      this.isPlaying = true;
    }
  }

  ensureActiveOnAdd() {
    if (!this.isDeckActive) this.togglePower();
  }

  renderDeckStateUI() {
    const powerBtn = document.getElementById("btn-deck-power");
    const sleepingCard = document.getElementById("deck-sleeping-card");
    const activePlayerCard = document.getElementById("deck-active-card");

    if (powerBtn) {
      if (this.isDeckActive) {
        powerBtn.className = "px-2.5 py-1 rounded-lg bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 text-xs font-semibold hover:bg-emerald-500/30 transition flex items-center gap-1";
        powerBtn.innerHTML = `<span>● Cabina ON</span>`;
      } else {
        powerBtn.className = "px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/15 text-gray-400 text-xs font-semibold transition flex items-center gap-1";
        powerBtn.innerHTML = `<span>○ Cabina apagada (reposo)</span>`;
      }
    }

    if (sleepingCard && activePlayerCard) {
      if (this.isDeckActive) {
        sleepingCard.classList.add("hidden");
        activePlayerCard.classList.remove("hidden");
      } else {
        sleepingCard.classList.remove("hidden");
        activePlayerCard.classList.add("hidden");
      }
    }
  }

  updateNowPlayingUI(track) {
    document.querySelectorAll(".now-playing-title").forEach(el => el.innerText = track.title || "Título desconocido");
    document.querySelectorAll(".now-playing-author").forEach(el => el.innerText = track.author || "Música de YouTube");
    document.querySelectorAll(".now-playing-art").forEach(el => {
      if (el.tagName === "IMG") el.src = track.thumbnail;
    });
  }

  updateTrackInfoPlaceholder() {
    document.querySelectorAll(".now-playing-title").forEach(el => el.innerText = "La cola está vacía");
    document.querySelectorAll(".now-playing-author").forEach(el => el.innerText = "Pega un enlace de YouTube abajo para empezar a escuchar");
    document.querySelectorAll(".now-playing-art").forEach(el => {
      if (el.tagName === "IMG") el.src = "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=500&auto=format&fit=crop&q=80";
    });
  }

  updatePlayPauseButtonUI(isPlaying) {
    this.isPlaying = isPlaying;
    document.querySelectorAll(".btn-play-pause").forEach(btn => {
      btn.innerHTML = isPlaying
        ? `<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/></svg>`
        : `<svg class="w-5 h-5 ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
    });
  }

  renderQueueUI() {
    const listEl = document.getElementById("queue-items-container");
    const countEl = document.getElementById("queue-count-badge");
    if (countEl) countEl.innerText = this.queue.length;
    if (!listEl) return;

    if (this.queue.length === 0) {
      listEl.innerHTML = `
        <div class="p-6 text-center text-xs text-gray-500 glass-subtle rounded-xl border border-white/5 space-y-2">
          <p class="font-medium text-gray-400">La cola está completamente vacía</p>
          <p class="text-[11px] text-gray-500">Pega cualquier enlace de video o lista de reproducción de YouTube arriba para empezar a escuchar.</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = "";
    this.queue.forEach((item, index) => {
      const isCurrent = index === this.currentIndex;
      const row = document.createElement("div");
      row.className = `group flex items-center justify-between p-2.5 rounded-xl border transition-all ${isCurrent ? "bg-accent/15 border-accent/40 shadow-sm" : "bg-white/5 hover:bg-white/10 border-white/5"}`;
      row.draggable = true;
      row.dataset.index = index;

      row.innerHTML = `
        <div class="flex items-center gap-3 min-w-0 flex-1 cursor-pointer" onclick="window.ytSync.selectTrack(${index})">
          <span class="text-xs font-mono ${isCurrent ? "custom-accent font-bold" : "text-gray-500"}">${String(index + 1).padStart(2, "0")}</span>
          <img src="${item.thumbnail}" class="w-8 h-8 rounded-lg object-cover flex-shrink-0">
          <div class="min-w-0 pr-2">
            <p class="text-xs font-medium truncate ${isCurrent ? "text-white font-semibold" : "text-gray-200"}">${item.title}</p>
            <p class="text-[10px] text-gray-400 truncate">${item.author || "YouTube"}</p>
          </div>
        </div>
        <div class="flex items-center gap-1 opacity-80 group-hover:opacity-100 flex-shrink-0">
          <button onclick="window.ytSync.moveItem(${index}, -1)" class="p-1 text-gray-400 hover:text-white rounded" title="Move Up" ${index === 0 ? "disabled" : ""}>▲</button>
          <button onclick="window.ytSync.moveItem(${index}, 1)" class="p-1 text-gray-400 hover:text-white rounded" title="Move Down" ${index === this.queue.length - 1 ? "disabled" : ""}>▼</button>
          <button onclick="window.ytSync.removeTrack(${index})" class="p-1 text-red-400 hover:text-red-300 rounded ml-1" title="Remove">✕</button>
        </div>
      `;

      row.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", index); row.classList.add("dragging"); });
      row.addEventListener("dragend", () => { row.classList.remove("dragging"); });
      row.addEventListener("dragover", (e) => { e.preventDefault(); });
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        const fromIdx = parseInt(e.dataTransfer.getData("text/plain"), 10);
        const toIdx = index;
        if (!isNaN(fromIdx) && fromIdx !== toIdx) this.reorderTrack(fromIdx, toIdx);
      });
      listEl.appendChild(row);
    });
  }

  moveItem(index, direction) {
    const target = index + direction;
    if (target >= 0 && target < this.queue.length) this.reorderTrack(index, target);
  }

  startProgressTracking() {
    if (this.progressInterval) clearInterval(this.progressInterval);

    this.progressInterval = setInterval(() => {
      if (!this.player || !this.isReady || typeof this.player.getCurrentTime !== "function") return;
      const curr = this.player.getCurrentTime() || 0;
      const total = this.player.getDuration() || 0;

      const formatTime = (secs) => {
        const m = Math.floor(secs / 60);
        const s = Math.floor(secs % 60);
        return `${m}:${String(s).padStart(2, "0")}`;
      };

      document.querySelectorAll(".playback-curr-time").forEach(el => el.innerText = formatTime(curr));
      document.querySelectorAll(".playback-total-time").forEach(el => el.innerText = formatTime(total));

      if (total > 0) {
        const pct = Math.min(100, (curr / total) * 100);
        document.querySelectorAll(".playback-bar-fill").forEach(el => el.style.width = `${pct}%`);
      }
    }, 500);
  }
}

window.ytSync = new YouTubeSyncEngine();