// Llamaditas Supabase Realtime P2P Signaling Engine
class SupabaseP2P {
  constructor() {
    this.client = null;
    this.channel = null;
    this.roomId = null;
    this.peerId = null;
    this.userName = null;
    this.isConnected = false;

    const DEFAULT_URL = "https://jeboqfrsscbdwdgyjfdn.supabase.co";
    const DEFAULT_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImplYm9xZnJzc2NiZHdkZ3lqZmRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3Mzc4NDQsImV4cCI6MjEwNTMxMzg0NH0.AYAvpNr9VUnqoTDl3w-g7BEue4AXjyud-GYHRQ2GaIg";

    const savedUrl = localStorage.getItem("llamaditas_sb_url");
    if (!savedUrl || savedUrl.includes("qxtlyeakqbbpffxebiqc")) {
      localStorage.setItem("llamaditas_sb_url", DEFAULT_URL);
      localStorage.setItem("llamaditas_sb_key", DEFAULT_KEY);
      this.supabaseUrl = DEFAULT_URL;
      this.supabaseKey = DEFAULT_KEY;
    } else {
      this.supabaseUrl = savedUrl;
      this.supabaseKey = localStorage.getItem("llamaditas_sb_key") || DEFAULT_KEY;
    }

    if (window.supabase) {
      this.client = window.supabase.createClient(this.supabaseUrl, this.supabaseKey, {
        realtime: {
          params: {
            eventsPerSecond: 25
          }
        }
      });
      window.supabaseClient = this.client;
    }
  }

  saveCredentials(url, key) {
    this.supabaseUrl = url.trim();
    this.supabaseKey = key.trim();
    localStorage.setItem("llamaditas_sb_url", this.supabaseUrl);
    localStorage.setItem("llamaditas_sb_key", this.supabaseKey);
    console.log("[Supabase] Credentials updated");
  }

  async connect(roomId, peerId, userName, onPeerJoin, onPeerLeave, onSignal, onMusicAction, onUserState, onMusicStateSync) {
    this.roomId = roomId.toUpperCase();
    this.peerId = peerId;
    this.userName = userName;

    if (!window.supabaseClient) {
      if (window.supabase) {
        this.client = window.supabase.createClient(this.supabaseUrl, this.supabaseKey, {
          realtime: { params: { eventsPerSecond: 25 } }
        });
        window.supabaseClient = this.client;
      } else {
        console.warn("[Supabase] Waiting for Supabase SDK...");
        setTimeout(() => this.connect(roomId, peerId, userName, onPeerJoin, onPeerLeave, onSignal, onMusicAction, onUserState, onMusicStateSync), 300);
        return;
      }
    } else {
      this.client = window.supabaseClient;
    }

    try {
      const channelName = `llamaditas_room_${this.roomId}`;
      this.channel = this.client.channel(channelName, {
        config: {
          broadcast: { self: false, ack: false },
          presence: { key: this.peerId }
        }
      });

      this.channel.on("broadcast", { event: "peer-announce" }, ({ payload }) => {
        if (payload && payload.from !== this.peerId) {
          console.log(`[Supabase P2P] Received announcement from ${payload.name} (${payload.from})`);
          onPeerJoin(payload.from, payload);
          window.webrtcManager.createAndSendOffer(payload.from);
          this.channel.send({
            type: "broadcast",
            event: "peer-announce-reply",
            payload: {
              target: payload.from,
              from: this.peerId,
              name: this.userName
            }
          });
          this.sendMusicStateSync(payload.from);
        }
      });

      this.channel.on("broadcast", { event: "peer-announce-reply" }, ({ payload }) => {
        if (payload && payload.target === this.peerId) {
          console.log(`[Supabase P2P] Discovered existing peer ${payload.name} (${payload.from})`);
          onPeerJoin(payload.from, payload);
        }
      });

      this.channel.on("broadcast", { event: "music-state-sync" }, ({ payload }) => {
        if (payload && payload.target === this.peerId) {
          onMusicStateSync(payload);
        }
      });

      this.channel.on("broadcast", { event: "signal" }, ({ payload }) => {
        if (payload && payload.target === this.peerId) {
          onSignal(payload.from, payload.signalType, payload.payload);
        }
      });

      this.channel.on("broadcast", { event: "music" }, ({ payload }) => {
        if (payload && payload.from !== this.peerId) {
          onMusicAction(payload.action, payload.payload, payload.from);
        }
      });

      this.channel.on("broadcast", { event: "user-state" }, ({ payload }) => {
        if (payload && payload.from !== this.peerId) {
          onUserState(payload);
        }
      });

      this.channel.on("broadcast", { event: "screen-state" }, ({ payload }) => {
        if (payload && payload.from !== this.peerId) {
          if (window.llamaditasApp) window.llamaditasApp.handlePeerScreenState(payload.from, payload.isSharing);
        }
      });

      this.channel.on("presence", { event: "sync" }, () => {
        const state = this.channel.presenceState();
        Object.entries(state).forEach(([pid, presences]) => {
          if (pid !== this.peerId && presences && presences[0]) {
            onPeerJoin(pid, presences[0]);
          }
        });
      });

      this.channel.on("presence", { event: "leave" }, ({ key }) => {
        if (key !== this.peerId) {
          onPeerLeave(key);
        }
      });

      this.channel.on("broadcast", { event: "chat" }, ({ payload }) => {
        if (payload.isPrivate && payload.target !== this.peerId) return;
        
        if (window.llamaditasApp) {
          window.llamaditasApp.renderChatMessage(payload.name, payload.msg, payload.avatar, false, payload.isPrivate);
          window.llamaditasApp.showChatToast(payload.name, payload.msg, payload.avatar, payload.isPrivate);
        }
      });

      await this.channel.subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          this.isConnected = true;
          console.log(`[Supabase] Connected to channel: ${channelName}`);
          
          await this.channel.track({
            name: this.userName,
            username: window.llamaditasApp.username,
            avatar_url: window.llamaditasApp.avatarUrl,
            mic: true,
            cam: false,
            joinedAt: Date.now()
          });

          this.channel.send({
            type: "broadcast",
            event: "peer-announce",
            payload: {
              from: this.peerId,
              name: this.userName
            }
          });

          if (window.llamaditasApp) {
            window.llamaditasApp.updateConnectionStatus(true, "P2P de Supabase conectado");
          }
        } else if (status === "CHANNEL_ERROR") {
          if (window.llamaditasApp) {
            window.llamaditasApp.updateConnectionStatus(false, "Supabase reconectando...");
          }
        }
      });

    } catch (err) {
      console.error("[Supabase] Initialization error:", err);
    }
  }

  sendSignal(targetPeerId, signalType, payload) {
    if (this.channel && this.isConnected) {
      this.channel.send({
        type: "broadcast",
        event: "signal",
        payload: {
          target: targetPeerId,
          from: this.peerId,
          signalType,
          payload
        }
      });
    }
  }

  sendMusicStateSync(targetPeerId) {
    const yt = window.ytSync;
    if (!this.channel || !this.isConnected || !yt || !yt.queue || yt.queue.length === 0) return;

    const positionSec = (yt.isDeckActive && yt.player && typeof yt.player.getCurrentTime === "function")
      ? (yt.player.getCurrentTime() || 0)
      : (yt.pendingStartTime || 0);

    this.channel.send({
      type: "broadcast",
      event: "music-state-sync",
      payload: {
        target: targetPeerId,
        from: this.peerId,
        queue: yt.queue,
        currentIndex: yt.currentIndex,
        isPlaying: yt.isPlaying,
        positionSec
      }
    });
  }

  sendMusicAction(action, payload) {
    if (this.channel && this.isConnected) {
      this.channel.send({
        type: "broadcast",
        event: "music",
        payload: {
          from: this.peerId,
          action,
          payload
        }
      });
    }
  }

  sendUserState(mic, cam, speaking) {
    if (this.channel && this.isConnected) {
      this.channel.send({
        type: "broadcast",
        event: "user-state",
        payload: {
          from: this.peerId,
          mic,
          cam,
          speaking
        }
      });
    }
  }

  sendScreenShareState(isSharing) {
    if (this.channel && this.isConnected) {
      this.channel.send({
        type: "broadcast",
        event: "screen-state",
        payload: { from: this.peerId, isSharing }
      });
    }
  }

  leave() {
    if (this.channel) {
      this.channel.untrack();
      this.channel.unsubscribe();
      this.channel = null;
    }
    this.isConnected = false;
  }
}

window.supabaseP2P = new SupabaseP2P();