/* SPsphere Cast receiver player.
   Two full yaw turns at the horizon, then the next photo.
   One photo keeps turning. Timing matches CastTiming.kt (9°/s).
   Manual aim springs toward the phone. Yaw is the heading change since
   the first sample of that hold. Pitch and roll are gravity. A new
   anchor on every sample would freeze yaw.
   GPano PosePitchDegrees and PoseRollDegrees level the sphere before that
   look, matching ProjectionMath.applyPose. The phone bakes cubemaps to
   equirect JPEGs with the standard face orientation, so this page samples
   equirects only. Level-0 tiles are 512px with a 32px gutter. The phone
   sends a 64×32 overview of the whole photo first. That sphere stays up
   wherever a sharp tile is not resident, so the clear color never shows.
   Full-resolution tiles stay only for the view and the pan lookahead.
   Auto-pan asks for those ahead of the camera before the ones behind it,
   and a manual Next or Previous cuts to the overview immediately.
   The screen has no counters. */
(function (root) {
  var ROTATIONS = 2;
  var FULL_TURN = 360;
  var DEFAULT_DPS = 9;
  var CROSSFADE_MS = 1200;
  var TILE_FADE_MS = 300;
  var SNAP_FADE_MS = 1200;
  var SNAP_W = 1920;
  var SNAP_H = 1080;
  var OUTPUT_W = 1920;
  var OUTPUT_H = 1080;
  var SENDER_TIMEOUT_MS = 45000;
  var UPLOAD_BUDGET_MS = 4;
  var GPU_CAP = 192 * 1024 * 1024;
  var IDLE_HEARTBEAT_MS = 15000;
  var MIN_DPS = 6;
  var MAX_DPS = 72;
  var OMEGA = 40;
  var MIN_FOV = 20;
  var MAX_FOV = 120;
  // Straight up and straight down, short of the exact pole where yaw and roll trade places.
  var PITCH_LIMIT = 89.9;
  // Extra degrees so a tile that just clips the frustum is still drawn.
  var FRUSTUM_MARGIN_DEG = 4;
  var POLE_MARGIN_DEG = 3;
  // The resident overview is 64×32 RGBA, a downscale of the whole photo.
  // Level-0 tiles still pay their real size, and only inside the view band.
  var BASE_W = 64;
  var BASE_H = 32;
  var BASE_BYTES = BASE_W * BASE_H * 4;
  // Degrees past the frustum and the lookahead that stay at full resolution.
  var RESIDENT_MARGIN_DEG = 8;
  // Seconds of pan to keep queued even before a slow upload has been timed.
  var LOOKAHEAD_FLOOR_S = 3;
  var LOOKAHEAD_LATENCY_FALLBACK_MS = 1500;
  var AHEAD_REQUESTS = 4;
  // How long a sharp tile takes to pull into focus over the soft overview.
  var FOCUS_MS = 500;
  // createImageBitmap on some Cast WebViews never settles. Fall back before
  // that holds the decode queue.
  var DECODE_FALLBACK_MS = 1200;

  function clampSpeed(v) {
    v = Number(v) || DEFAULT_DPS;
    if (v < MIN_DPS) return MIN_DPS;
    if (v > MAX_DPS) return MAX_DPS;
    return v;
  }

  function clamp(v, lo, hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  function wrap360(v) {
    var m = v % FULL_TURN;
    return m < 0 ? m + FULL_TURN : m;
  }

  function shortest(delta) {
    var wrapped = wrap360(delta + 180) - 180;
    return wrapped === -180 ? 180 : wrapped;
  }

  function num(v, fallback) {
    var n = Number(v);
    return (typeof n === "number" && isFinite(n)) ? n : fallback;
  }

  function httpUrl(url) {
    if (typeof url !== "string" || url.length < 8 || url.length > 2048) return "";
    if (!/^https?:\/\//i.test(url)) return "";
    if (/[\s<>"']/.test(url)) return "";
    return url;
  }

  function isNewer(seq, last) {
    if (last < 0) return true;
    return (((seq - last) | 0) > 0);
  }

  function Player(canvas) {
    this.canvas = canvas;
    this.items = [];
    this.images = [];
    this.poses = [];
    this.index = 0;
    this.playing = false;
    this.phase = "pan";
    this.speed = DEFAULT_DPS;
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.fov = 75;
    this.manual = false;
    this.held = false;
    this.ids = [];
    this._panBlend = 1;
    this.itemDegrees = 0;
    this.fadeMs = 0;
    this.fade = 0;
    this.fromIndex = 0;
    this._raf = 0;
    this._last = 0;
    this._gl = null;
    this._mode = "2d";
    this._tex = [];
    this._loaded = 0;
    this._userFov = 75;
    this._busy = false;
    this._anchored = false;
    this._lastSeq = -1;
    this._tyaw = 0;
    this._tpitch = 0;
    this._troll = 0;
    this._tfov = 75;
    this._vy = 0;
    this._vp = 0;
    this._vr = 0;
    this._vf = 0;
    this._baseYaw = 0;
    this._basePitch = 0;
    this._baseRoll = 0;
    this._baseFov = 75;
    this._oYaw = 0;
    this._oPitch = 0;
    this._oRoll = 0;
    this._oFov = 75;
    this._omega2 = OMEGA * OMEGA;
    this._damp = 2 * OMEGA;
    this._stepDelta = 0;
    this._stepVel = 0;
    this._echo = new ArrayBuffer(16);
    this._echoView = new DataView(this._echo);
    this.entries = [];
    this._useTiles = false;
    this._tileDraw = [];
    this._tileW = 0;
    this._tileH = 0;
    this._presented = false;
    this._gpuBytes = 0;
    this._gpuBudget = null;
    this._resident = [];
    this._lodHold = null;
    this._promoting = false;
    this._frameDts = [];
    this._maxUploadsPerFrame = 0;
    this._uploadsThisFrame = 0;
    this._uploadQueue = [];
    this._decodeQueue = [];
    this._decodeBusy = false;
    this._timeoutAcc = 0;
    this._holdFrame = false;
    this._snapFadeMs = SNAP_FADE_MS;
    this._snapOn = false;
    this._snapMs = 0;
    this._snapReveal = false;
    this._snapHave = false;
    this._snapYaw = 0;
    this._snapCopies = 0;
    this._switchLog = [];
    this._dtEma = 0;
    this._dtDebt = 0;
    this._dtRing = new Float64Array(240);
    this._dtRingAt = 0;
    this._dtRingN = 0;
    this._drawKeep = [];
    this._patchCache = {};
    this._strip = null;
    this._preloadDepth = 0;
    this._uploadMsPerMb = 8;
    this._lastSender = 0;
    this._senderSeen = false;
    this._memoryBefore = null;
    this._memoryAfter = null;
    this._ignoredAim = 0;
    this._awaitingSwap = false;
    this._awaitIndex = null;
    this._glLost = false;
    this._glHooks = false;
    this.session = null;
    this._m0 = new Float32Array(16);
    this._m1 = new Float32Array(16);
    this._m2 = new Float32Array(16);
    this._proj = new Float32Array(16);
    this._view = new Float32Array(16);
    this._mvp = new Float32Array(16);
    this._setup();
  }

  Player.prototype.snapshot = function () {
    return {
      index: this.index,
      count: this.items.length,
      playing: this.playing,
      phase: this.phase,
      speed: this.speed,
      yaw: this.yaw,
      pitch: this.pitch,
      fov: this.fov,
      manual: this.manual,
      itemDegrees: this.itemDegrees,
      fade: this.phase === "fade" ? Math.max(0, Math.min(1, this.fadeMs / CROSSFADE_MS)) : 0,
      single: this.items.length <= 1,
    };
  };

  Player.prototype._resetAim = function () {
    this.manual = false;
    this._anchored = false;
    this._lastSeq = -1;
    this.pitch = 0;
    this.roll = 0;
    this._tyaw = 0;
    this._tpitch = 0;
    this._troll = 0;
    this._tfov = this._userFov;
    this._vy = 0;
    this._vp = 0;
    this._vr = 0;
    this._vf = 0;
  };

  Player.prototype._loadEntry = function (entry) {
    var self = this;
    var img = new Image();
    if (needsCors(entry.url)) img.crossOrigin = "anonymous";
    img.onload = function () {
      self._loaded += 1;
      self._upload(img);
      self.draw();
    };
    img.referrerPolicy = "no-referrer";
    img.src = entry.url;
    return img;
  };

  Player.prototype.setQueue = function (urls) {
    var entries = normalizeEntries(urls);
    var self = this;
    if (this.session) this.session.dispose();
    this._dropStandby();
    this._clearQueues();
    this._fading = false;
    this._fadeFrom = null;
    this._fadeRelease = false;
    this._holdFrame = false;
    this._snapOn = false;
    this._snapReveal = false;
    this._snapMs = 0;
    this._awaitingSwap = false;
    this._awaitIndex = null;
    this._tileDraw = [];
    this._dropBases();
    this.entries = entries;
    this._useTiles = entries.some(function (entry) { return entry.tiles && entry.tiles.length; });
    this.ids = entries.map(function (entry) { return entry.id; });
    this.items = entries.map(function (entry) { return entry.url; });
    this.poses = entries.map(poseOf);
    this._loaded = 0;
    this._releaseUrlTextures();
    this._tex = [];
    this.index = 0;
    this.fromIndex = 0;
    this.phase = "pan";
    this.fadeMs = 0;
    this.fade = 0;
    this.itemDegrees = 0;
    this.yaw = 0;
    this._panBlend = 1;
    this.held = false;
    this._resetAim();
    this.playing = this.items.length > 0;
    this._last = 0;
    if (this._useTiles) {
      this.images = entries.map(function () { return null; });
      this._busy = false;
      this._markBusy();
      if (this.items.length) this._openCurrent();
    } else {
      this._busy = false;
      this._markBusy();
      this.images = entries.map(function (entry) {
        self._tex.push(null);
        return self._loadEntry(entry);
      });
      this._preloadAround();
    }
    this._mark();
    this.draw();
  };

  Player.prototype.appendItems = function (urls) {
    var entries = normalizeEntries(urls);
    var self = this;
    if (!this.entries) this.entries = [];
    entries.forEach(function (entry) {
      self.entries.push(entry);
      self.ids.push(entry.id);
      self.items.push(entry.url);
      self.poses.push(poseOf(entry));
      self._tex.push(null);
      if (entry.tiles && entry.tiles.length) self._useTiles = true;
      if (self._useTiles) self.images.push(null);
      else self.images.push(self._loadEntry(entry));
    });
    this._preloadAround();
  };

  Player.prototype.removeId = function (id) {
    var at = this.ids.indexOf(String(id));
    if (at < 0 || this.ids.length < 2) return false;
    var current = this.ids[this.index];
    this.ids.splice(at, 1);
    this.items.splice(at, 1);
    this.images.splice(at, 1);
    this.poses.splice(at, 1);
    this._tex.splice(at, 1);
    if (this.entries) this.entries.splice(at, 1);
    if (current === String(id)) {
      this.index = Math.min(at, this.ids.length - 1);
      this.itemDegrees = 0;
      if (this._useTiles) this._openCurrent();
    } else {
      this.index = this.ids.indexOf(current);
    }
    this.fromIndex = this.index;
    this.phase = "pan";
    this.fadeMs = 0;
    this.fade = 0;
    this._preloadAround();
    this.draw();
    return true;
  };

  Player.prototype.moveId = function (id, to) {
    var from = this.ids.indexOf(String(id));
    if (from < 0) return false;
    to = Math.max(0, Math.min(this.ids.length - 1, to | 0));
    if (from === to) return true;
    var current = this.ids[this.index];
    function shift(list) {
      var item = list.splice(from, 1)[0];
      list.splice(to, 0, item);
    }
    shift(this.ids);
    shift(this.items);
    shift(this.images);
    shift(this.poses);
    shift(this._tex);
    if (this.entries) shift(this.entries);
    this.index = this.ids.indexOf(current);
    this.fromIndex = this.index;
    this.phase = "pan";
    this.fadeMs = 0;
    this.fade = 0;
    this._preloadAround();
    this.draw();
    return true;
  };

  Player.prototype.gotoId = function (id) {
    var at = this.ids.indexOf(String(id));
    if (at < 0) return false;
    if (this._useTiles && at !== this.index) {
      this._jumpReset = "keep";
      var moved = this._requestIndex(at);
      this._preloadAround();
      if (!this._holdFrame) this.draw();
      return moved;
    }
    this.index = at;
    this.fromIndex = at;
    this.phase = "pan";
    this.fade = 0;
    this.fadeMs = 0;
    this.itemDegrees = 0;
    if (this._useTiles) this._openCurrent();
    this._preloadAround();
    this.draw();
    return true;
  };

  Player.prototype.setSpeed = function (dps) { this.speed = clampSpeed(dps); };

  Player.prototype.play = function () {
    var easeIn = this.manual || !this.playing;
    this.manual = false;
    this.held = false;
    this._anchored = false;
    this._tpitch = 0;
    this._troll = 0;
    this._tfov = this._userFov;
    if (easeIn) this._panBlend = 0;
    if (this.items.length) this.playing = true;
    this._mark();
    this._kick();
  };

  Player.prototype.pause = function (held) {
    this.playing = false;
    if (held) this.held = true;
    this._mark();
  };

  Player.prototype._mark = function () {
    var icon = document.getElementById("hold");
    if (!icon) return;
    icon.hidden = true;
  };

  Player.prototype._markBusy = function () {
    var el = document.getElementById("busy");
    if (!el) return;
    if (this._busy) el.classList.add("on");
    else el.classList.remove("on");
  };

  Player.prototype._reportTv = function (message) {
    if (!message) return;
    warn(message);
    if (window.__castSend) window.__castSend({ type: "log", message: String(message) });
  };

  Player.prototype._revealOf = function (piece) {
    if (!piece || !piece.tex) return 0;
    var born = piece._focusAt || 0;
    if (!(born > 0)) return 1;
    var now = this._focusNow ? this._focusNow() : Date.now();
    var t = (now - born) / FOCUS_MS;
    if (t < 0) return 0;
    if (t > 1) return 1;
    return t;
  };

  Player.prototype._neighborReveal = function (tile, dRow, dCol) {
    if (!tile || !this.session || !this.session.entry) return 1;
    var row = (tile.row | 0) + dRow;
    var col = (tile.col | 0) + dCol;
    var tiles = this.session.entry.tiles || [];
    var loaded = this.session.loaded || [];
    var exists = false;
    var minCol = tile.col | 0;
    var maxCol = tile.col | 0;
    var match = null;
    for (var i = 0; i < tiles.length; i++) {
      var spec = tiles[i];
      if (!spec || spec._base) continue;
      if ((spec.row | 0) === (tile.row | 0)) {
        if ((spec.col | 0) < minCol) minCol = spec.col | 0;
        if ((spec.col | 0) > maxCol) maxCol = spec.col | 0;
      }
      if ((spec.row | 0) === row && (spec.col | 0) === col) exists = true;
    }
    if (!exists && dRow === 0 && dCol !== 0) {
      var wrapped = dCol < 0 ? maxCol : minCol;
      var atEdge = (dCol < 0 && (tile.col | 0) === minCol) || (dCol > 0 && (tile.col | 0) === maxCol);
      if (atEdge && wrapped !== (tile.col | 0)) {
        col = wrapped;
        exists = true;
      }
    }
    if (!exists) return 1;
    for (var j = 0; j < loaded.length; j++) {
      var other = loaded[j] && loaded[j].tile;
      if (!other || other._skip) continue;
      if ((other.row | 0) === row && (other.col | 0) === col) match = loaded[j];
    }
    if (!match) return 0;
    return this._revealOf(match);
  };

  Player.prototype.setFov = function (fov) {
    var next = clamp(num(fov, this._userFov), 30, 120);
    this._userFov = next;
    this._tfov = next;
    this._kick();
  };

  Player.prototype.halt = function () {
    this.playing = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  };

  Player.prototype.stop = function () {
    this.playing = false;
    this.held = false;
    this._panBlend = 1;
    this._mark();
    this.index = 0;
    this.fromIndex = 0;
    this.phase = "pan";
    this.fadeMs = 0;
    this.fade = 0;
    this.itemDegrees = 0;
    this.yaw = 0;
    this._userFov = 75;
    this.fov = 75;
    this._resetAim();
    if (this.session) this.session.dispose();
    this._dropStandby();
    this._clearQueues();
    this._fading = false;
    this._fadeFrom = null;
    this._fadeRelease = false;
    this._holdFrame = false;
    this._awaitingSwap = false;
    this._awaitIndex = null;
    this._tileDraw = [];
    this._freeGpu();
    this._busy = false;
    this._markBusy();
    this.draw();
  };

  Player.prototype.memoryUsage = function () {
    return {
      gpuBytes: (this._gpuBytes || 0) + (this._snapBytes || 0),
      snapBytes: this._snapBytes || 0,
      textures: this._resident ? this._resident.length : 0,
      objectUrls: trackedUrlCount(),
      pendingUploads: this._uploadQueue ? this._uploadQueue.length : 0,
      pendingDecodes: this._decodeQueue ? this._decodeQueue.length : 0,
      snap: !!(this._snapTex || this._snapOn),
    };
  };

  Player.prototype._freeGpu = function () {
    this._releaseShownGpu();
    this._releaseUrlTextures();
    if (this._gl && this._snapTex) {
      this._gl.deleteTexture(this._snapTex);
    }
    this._snapTex = null;
    this._snapBytes = 0;
    this._snapOn = false;
    this._snapReveal = false;
    this._snapHave = false;
    this._strip = null;
    this._dropBases();
    if (this._gl && this._patchCache) {
      for (var patchKey in this._patchCache) {
        var patch = this._patchCache[patchKey];
        if (patch && patch.buf) this._gl.deleteBuffer(patch.buf);
        if (patch && patch.ib) this._gl.deleteBuffer(patch.ib);
      }
    }
    this._patchCache = {};
    revokeTrackedUrls();
    this._gpuBytes = 0;
    if (this._resident) this._resident.length = 0;
  };

  Player.prototype.noteSender = function () {
    this._senderSeen = true;
    this._lastSender = Date.now();
    this._disconnectGrace = 0;
  };

  Player.prototype.frameCover = function () {
    function live(list) {
      var n = 0;
      if (!list) return 0;
      for (var i = 0; i < list.length; i++) {
        var tex = list[i] && list[i].tex;
        if (tex && !tex.deferred && !tex._evicted && !tex.oom) n += 1;
      }
      return n;
    }
    var tiles = live(this._tileDraw);
    if (!tiles && this._activeBase()) tiles = 1;
    var fade = this._fading ? live(this._fadeFrom) : 0;
    var snap = !!(this._snapTex && (this._snapCopies || 0) > 0 && (this._snapOn || this._holdFrame));
    var source = tiles ? "tiles" : fade ? "fade" : snap ? "snapshot" : "none";
    var showing = !!(this._presented || (this.session && this.session.shown));
    return { black: source === "none" && showing, source: source, live: tiles };
  };

  Player.prototype._noteBlack = function (reason) {
    this._blackFrames = (this._blackFrames || 0) + 1;
    if (this._blackFrames <= 3 || this._blackFrames % 30 === 0) this._logSwitch("black", reason || "empty");
  };

  Player.prototype._preloadStatus = function () {
    if (!this._useTiles || !this.entries || this.entries.length < 2) return "single";
    var nextAt = stepIndex(this.index, this.entries.length, 1, true);
    if (nextAt == null) return "single";
    var entry = this.entries[nextAt];
    if (!entry || !entry.tiles || !entry.tiles.length) return "next-has-no-tiles";
    var standby = this._standby;
    if (!standby || !standby.entry || standby.entry.id !== entry.id) {
      if (this._back && this._back.entry && this._back.entry.id === entry.id) standby = this._back;
      else return "not-started";
    }
    if (sessionReady(standby)) return "ready";
    if (standby._viewCovered && standby._viewCovered()) return "view-ready";
    if (standby.budgetFull) return "budget-full";
    if (standby.preloadCapped) return "preload-cap";
    if (standby.pending) return "pending";
    return "stalled";
  };

  Player.prototype._preloadDetail = function () {
    var code = this._preloadStatus();
    var standby = this._standby;
    if (standby && standby.entry && standby.entry.id && this.entries) {
      var nextAt = stepIndex(this.index, this.entries.length, 1, true);
      var next = nextAt != null ? this.entries[nextAt] : null;
      if (!next || standby.entry.id !== next.id) {
        if (this._back && this._back.entry && next && this._back.entry.id === next.id) standby = this._back;
      }
    }
    if (!standby || !standby.entry || !standby.entry.tiles) return code;
    var got = 0;
    var loaded = standby.loaded || [];
    for (var i = 0; i < loaded.length; i++) if (pieceReady(loaded[i])) got += 1;
    var room = Math.max(0, GPU_CAP - (this._gpuBytes || 0));
    var why = code;
    if (code === "budget-full") why = "budget-full (GPU full, off-screen tiles were not freed)";
    if (code === "preload-cap") why = "preload-cap (pace limit hit before the rest of the photo)";
    if (code === "not-started") why = "not-started (next photo was never requested during the pan)";
    if (code === "stalled") why = "stalled (no request in flight and the view is not covered)";
    if (code === "next-has-no-tiles") why = "next-has-no-tiles (phone has not described the next photo)";
    return why + " " + got + "/" + standby.entry.tiles.length + " room " + room;
  };

  Player.prototype._feedPreload = function () {
    if (!this._useTiles || !this.playing || this.manual) return;
    var why = this._preloadStatus();
    if (why === "ready" || why === "pending" || why === "single") return;
    if (this._preloadLogged !== why) {
      this._preloadLogged = why;
      this._logSwitch("preload", this._preloadDetail());
    }
    if (why === "not-started" || why === "standby-other") this._preloadNeighbors();
    var standby = this._standby;
    if (!standby || !standby.entry) return;
    if (why === "view-ready") {
      // The tiles in front of the camera are already on the GPU. Keep asking
      // for the rest while this photo pans, but do not evict that view.
      if ((standby.preloadCapped || standby.budgetFull) && !standby.pending && !sessionReady(standby)) {
        standby.preloadCapped = false;
        standby.budgetFull = false;
        standby.resume();
      }
      return;
    }
    if (why === "budget-full" || why === "preload-cap" || why === "stalled" || why === "next-has-no-tiles") {
      this._evictOffscreen();
      standby.preloadCapped = false;
      standby.budgetFull = false;
      standby.resume();
    }
  };

  Player.prototype._evictOffscreen = function () {
    var view = this._lodView();
    var freed = 0;
    while (freed < 32 && this._evictDistant(view)) freed += 1;
    return freed;
  };

  Player.prototype.senderTimedOut = function (now) {
    if (!this._senderSeen || !this._lastSender) return false;
    return (now || Date.now()) - this._lastSender > SENDER_TIMEOUT_MS;
  };

  Player.prototype.onSenderGone = function (reason) {
    if (this._releasing) return;
    this._releasing = true;
    this._memoryBefore = this.memoryUsage();
    this._logSwitch("release", reason || "sender-gone");
    this._senderSeen = false;
    this.stop();
    this._memoryAfter = this.memoryUsage();
    this._releasing = false;
    if (typeof console !== "undefined" && console.info) {
      console.info("spsphere cast memory", reason || "sender-gone", JSON.stringify(this._memoryBefore), JSON.stringify(this._memoryAfter));
    }
  };

  Player.prototype.setSnapFadeMs = function (ms) {
    var next = Number(ms);
    if (!(next > 0)) return;
    if (next < 200) next = 200;
    if (next > 5000) next = 5000;
    this._snapFadeMs = next;
  };

  Player.prototype.frameTimes = function () {
    var ring = this._dtRing;
    if (!ring) return [];
    var n = this._dtRingN || 0;
    var out = new Array(n);
    var start = n < ring.length ? 0 : this._dtRingAt;
    for (var i = 0; i < n; i++) out[i] = ring[(start + i) % ring.length];
    return out;
  };

  Player.prototype.setPace = function (preload) {
    var n = preload | 0;
    this._preloadDepth = n > 0 ? n : 0;
  };

  Player.prototype.deviceReport = function () {
    var gl = this._gl;
    var maxTexture = 4096;
    var renderer = "";
    var webgl2 = !!this._webgl2;
    if (gl && !(gl.isContextLost && gl.isContextLost())) {
      var reported = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      if (reported >= 512) maxTexture = reported;
      var info = gl.getExtension && gl.getExtension("WEBGL_debug_renderer_info");
      if (info) renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) || "");
    }
    var memory = 0;
    if (root.navigator && root.navigator.deviceMemory) memory = Number(root.navigator.deviceMemory) || 0;
    return {
      deviceMemory: memory,
      maxTexture: maxTexture,
      renderer: renderer,
      uploadMsPerMb: this._uploadMsPerMb || 0,
      webgl2: webgl2,
    };
  };

  Player.prototype._logSwitch = function (path, reason) {
    if (!this._switchLog) this._switchLog = [];
    this._switchLog.push({ path: path, reason: reason || "" });
    if (this._switchLog.length > 40) this._switchLog.shift();
    if (typeof console !== "undefined" && console.info) {
      console.info("spsphere cast switch", path, reason || "");
    }
  };

  Player.prototype._beginSnapshot = function (reason) {
    if (this._snapOn) return;
    if (!this._snapHave && !(this._tileDraw && this._tileDraw.length)) {
      this._logSwitch("cut", reason || "switch");
      return;
    }
    this._snapOn = true;
    this._snapMs = 0;
    this._snapReveal = false;
    this._snapYaw = this.yaw;
    this._logSwitch("snapshot", reason || "switch");
  };

  Player.prototype._endSnap = function () {
    this._snapOn = false;
    this._snapReveal = false;
    this._snapMs = this._snapFadeMs || SNAP_FADE_MS;
  };

  Player.prototype._skipTo = function (at) {
    var entry = this.entries && this.entries[at];
    if (!entry) return false;
    // Manual Next/Previous cancels the view-ready hold. The photo on screen
    // changes on this call. Sharp tiles catch up afterwards.
    this._holdFrame = false;
    this._awaitingSwap = false;
    this._awaitIndex = null;
    this._advanceMarked = false;
    this._advanceAt = 0;
    this.index = at;
    this.fromIndex = at;
    this.phase = "pan";
    this.fade = 0;
    this.fadeMs = 0;
    this.itemDegrees = 0;
    this._ensureBase(entry);
    var pool = this._poolFor(entry.id);
    if (pool && swapReady(pool)) {
      this._awaitingSwap = true;
      this._awaitIndex = at;
      this._switchTick = nowMs();
      this._commitIndex(at, pool);
      return this.index === at;
    }
    var sharp = [];
    var loaded = (pool && pool.loaded) || [];
    for (var i = 0; i < loaded.length; i++) {
      if (pieceReady(loaded[i])) sharp.push(loaded[i]);
    }
    this._tileDraw = sharp;
    this._tileW = entry.width;
    this._tileH = entry.height;
    this._presented = true;
    this._fading = false;
    this._fadeFrom = null;
    this._fadeRelease = false;
    this._busy = false;
    this._markBusy();
    var previous = this.session;
    if (pool && pool !== previous) {
      pool.standby = false;
      pool.budgetFull = false;
      pool.preloadCapped = false;
      if (pool === this._standby) this._standby = null;
      if (pool === this._back) this._back = null;
      this.session = pool;
      if (previous) previous.dispose();
      if (!pool.pending && !sessionReady(pool)) pool.resume();
    } else if (!pool || pool !== this.session) {
      if (previous && previous.entry && previous.entry.id !== entry.id) previous.dispose();
      this.session = this._newSession();
      this.session.open(entry);
    } else if (!this.session.pending && !sessionReady(this.session)) {
      this.session.standby = false;
      this.session.resume();
    }
    if (!this.manual && this.items.length) {
      this.playing = true;
      this._kick();
    }
    this._fullFrameMs = 0;
    return true;
  };

  Player.prototype.next = function () { return this._jump(1); };
  Player.prototype.previous = function () { return this._jump(-1); };
  Player.prototype.skip = function (delta) { return this._jump(delta); };

  Player.prototype._jump = function (delta) {
    var count = this.items.length;
    // A second tap lands on the photo the first tap already selected, even
    // when that photo's sharp tiles are still on the way.
    var at = stepIndex(this.index, count, delta, count > 1);
    if (at == null) return false;
    if (this._useTiles) {
      var moved = this._skipTo(at);
      this._preloadAround();
      this._mark();
      if (!this._holdFrame) this.draw();
      if (window.__onCastStatus) window.__onCastStatus(this.snapshot());
      return moved;
    }
    this.index = at;
    this.fromIndex = at;
    this.phase = "pan";
    this.fadeMs = 0;
    this.fade = 0;
    this.itemDegrees = 0;
    if (this.manual) {
      this.playing = false;
    } else if (this.held || !this.playing) {
      var held = this.held;
      this.yaw = 0;
      this._panBlend = 1;
      this._resetAim();
      this.held = held;
      this.playing = false;
    } else {
      this.yaw = 0;
      this._panBlend = 1;
      this._resetAim();
      this.playing = count > 0;
      this._kick();
    }
    if (this._useTiles) this._openCurrent();
    this._preloadAround();
    this._mark();
    this.draw();
    if (window.__onCastStatus) window.__onCastStatus(this.snapshot());
    return true;
  };

  Player.prototype._preloadAround = function () {
    if (this._useTiles) return;
    var count = this.items.length;
    if (count <= 1) return;
    var self = this;
    [-1, 1].forEach(function (delta) {
      var at = stepIndex(self.index, count, delta, true);
      if (at == null) return;
      var img = self.images[at];
      if (!img || img._neighborReady) return;
      if (img.complete && img.width) {
        img._neighborReady = true;
        if (!self._tex[at]) self._upload(img);
        return;
      }
      if (typeof img.decode === "function") {
        img._neighborReady = true;
        img.decode().then(function () {
          if (!self._tex[at]) self._upload(img);
        }).catch(function () {});
      }
    });
  };

  Player.prototype._changed = function (before) {
    if (before !== this.index + ":" + this.phase && window.__onCastStatus) {
      window.__onCastStatus(this.snapshot());
    }
  };

  Player.prototype._integrate = function (dtMs) {
    if (!this.playing || !this.items.length || dtMs <= 0 || this.manual) return;
    var before = this.index + ":" + this.phase;
    var prevIndex = this.index;
    var ramp = 1;
    if (this._panBlend < 1) {
      this._panBlend += dtMs / 1400;
      if (this._panBlend > 1) this._panBlend = 1;
      var t = this._panBlend;
      ramp = t * t * (3 - 2 * t);
    }
    var step = this.speed * ramp * dtMs / 1000;
    this.yaw = wrap360(this.yaw + step);
    if (this._useTiles && this.session && this.session._aimOrder) this.session._aimOrder();
    if (this.phase === "fade") {
      this.fadeMs += dtMs;
      this.fade = Math.max(0, Math.min(1, this.fadeMs / CROSSFADE_MS));
      if (this.fadeMs >= CROSSFADE_MS) {
        this.phase = "pan";
        this.fadeMs = 0;
        this.fade = 0;
        this.itemDegrees = 0;
        this.fromIndex = this.index;
      }
      this._changed(before);
      if (this._useTiles && this.index !== prevIndex) this._openCurrent();
      return;
    }
    this.fade = 0;
    this.itemDegrees += step;
    if (!this._awaitingSwap) this._feedPreload();
    if (this.items.length >= 2 && this.itemDegrees >= ROTATIONS * FULL_TURN) {
      if (this._useTiles) {
        if (!this._advanceMarked) {
          this._advanceMarked = true;
          this._advanceAt = nowMs();
          this._logSwitch("advance", this._preloadDetail());
        }
        var nextAt = (this.index + 1) % this.items.length;
        this._requestIndex(nextAt);
        this._changed(before);
        return;
      }
      this.fromIndex = this.index;
      this.index = (this.index + 1) % this.items.length;
      this.phase = "fade";
      this.fadeMs = 0;
      this.fade = 0;
      this.itemDegrees = ROTATIONS * FULL_TURN;
    }
    this._changed(before);
    if (this._useTiles && this.index !== prevIndex) this._openCurrent();
  };

  Player.prototype.advance = function (dtMs) {
    if (!this.playing || !this.items.length || dtMs <= 0) return this.snapshot();
    this._integrate(dtMs);
    if (this.session) this.session.tick(Date.now());
    this.draw();
    return this.snapshot();
  };

  Player.prototype._approach = function (delta, vel, dt) {
    var accel = this._omega2 * delta - this._damp * vel;
    var next = vel + accel * dt;
    this._stepDelta = next * dt;
    this._stepVel = next;
  };

  Player.prototype._ease = function (dtMs) {
    // omega is 40, so one 50ms Euler step overshoots and the clamp pins fov
    // at 20 or 120. A late TV frame is split into the 16ms steps the spring
    // was tuned for.
    var left = dtMs;
    if (left > 100) left = 100;
    while (left > 0.5) {
      var slice = left > 16 ? 16 : left;
      this._easeSlice(slice);
      left -= slice;
    }
  };

  Player.prototype._easeSlice = function (dtMs) {
    var dt = dtMs / 1000;
    if (dt <= 0) return;
    if (this.manual) {
      this._approach(shortest(this._tyaw - this.yaw), this._vy, dt);
      this.yaw = wrap360(this.yaw + this._stepDelta);
      this._vy = this._stepVel;
    } else if (springSettled(this.pitch, 0, this._vp) &&
        springSettled(this.roll, 0, this._vr) &&
        springSettled(this.fov, this._userFov, this._vf)) {
      // Auto-pan owns yaw. A resting spring must not touch the view.
      return;
    } else {
      this._tpitch = 0;
      this._troll = 0;
      this._tfov = this._userFov;
    }
    this._approach(this._tpitch - this.pitch, this._vp, dt);
    this.pitch = clamp(this.pitch + this._stepDelta, -PITCH_LIMIT, PITCH_LIMIT);
    this._vp = this._stepVel;
    this._approach(this._troll - this.roll, this._vr, dt);
    this.roll += this._stepDelta;
    this._vr = this._stepVel;
    this._approach(this._tfov - this.fov, this._vf, dt);
    this.fov = clamp(this.fov + this._stepDelta, MIN_FOV, MAX_FOV);
    this._vf = this._stepVel;
  };

  Player.prototype.stepAim = function (dtMs) {
    this._ease(dtMs);
  };

  Player.prototype.applyAim = function (msg) {
    if (!msg) return false;
    var autoPan = !!(this.playing && !this.manual);
    if (autoPan && !msg.anchor) {
      this._ignoredAim = (this._ignoredAim || 0) + 1;
      return false;
    }
    var seq = num(msg.seq, 0) >>> 0;
    if (!isNewer(seq, this._lastSeq)) return false;
    this._lastSeq = seq;
    var yaw = num(msg.yaw, 0);
    var pitch = num(msg.pitch, 0);
    var roll = num(msg.roll, 0);
    var fov = num(msg.fov, 75);
    if (msg.anchor || !this._anchored) {
      this._baseYaw = this.yaw;
      this._basePitch = this.pitch;
      this._baseRoll = this.roll;
      this._baseFov = this.fov;
      this._oYaw = yaw;
      this._oPitch = pitch;
      this._oRoll = roll;
      this._oFov = fov;
      this._anchored = true;
      this._vy = 0;
      this._vp = 0;
      this._vr = 0;
      this._vf = 0;
    }
    this._tyaw = wrap360(this._baseYaw + shortest(yaw - this._oYaw));
    // Pitch and roll are gravity on the phone. Yaw stays anchored so the TV
    // does not spin to the phone's compass when aiming starts.
    this._tpitch = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
    this._troll = roll;
    this._tfov = clamp(this._baseFov + (fov - this._oFov), MIN_FOV, MAX_FOV);
    this._userFov = this._tfov;
    this.manual = true;
    this.playing = false;
    this._kick();
    return true;
  };

  Player.prototype.encodeEcho = function (seq, ts) {
    var view = this._echoView;
    view.setUint8(0, 2);
    view.setUint8(1, 0);
    view.setUint16(2, 0, true);
    view.setUint32(4, seq >>> 0, true);
    view.setFloat64(8, Number(ts) || 0, true);
    return this._echo;
  };

  Player.prototype._kick = function () {
    var self = this;
    if (this._raf) return;
    if (typeof requestAnimationFrame !== "function") return;
    var loop = function (t) {
      self._raf = requestAnimationFrame(loop);
      if (!self._last) self._last = t;
      var dt = t - self._last;
      self._last = t;
      self._pumpFrame(dt);
    };
    this._raf = requestAnimationFrame(loop);
  };

  Player.prototype._pumpFrame = function (dt) {
    var raw = dt > 0 ? dt : 0;
    this._mediaMs = (this._mediaMs || 0) + raw;
    this._uploadsThisFrame = 0;
    if (raw > 0) {
      if (!this._dtRing) this._dtRing = new Float64Array(240);
      this._dtRing[this._dtRingAt] = raw;
      this._dtRingAt = (this._dtRingAt + 1) % this._dtRing.length;
      if (this._dtRingN < this._dtRing.length) this._dtRingN += 1;
    }
    var paced = paceDt(this._dtEma, this._dtDebt, raw);
    this._dtEma = paced.ema;
    this._dtDebt = paced.debt;
    var step = paced.step;
    if (this._snapOn && this._snapReveal) this._snapMs = (this._snapMs || 0) + raw;
    if (!this._holdFrame && this._fading) this._fadeMs = (this._fadeMs || 0) + raw;
    if (this.playing && !this.manual && step > 0) this._integrate(step);
    if (!this._snapOn) this._ease(step);
    this._timeoutAcc = (this._timeoutAcc || 0) + raw;
    if (this._timeoutAcc >= 1000) {
      this._timeoutAcc -= 1000;
      var now = Date.now();
      if (this.session) this.session.tick(now);
      if (this._standby) this._standby.tick(now);
      if (this._back) this._back.tick(now);
      if (this.senderTimedOut(now)) this.onSenderGone("heartbeat-timeout");
    }
    if (!this._holdFrame || this._snapOn) this.draw();
    if (this.frameCover().black) this._noteBlack("draw");
    if (this._fading && this._fadeMs >= TILE_FADE_MS) this._endFade();
    if (this._snapOn && this._snapReveal && this._snapMs >= (this._snapFadeMs || SNAP_FADE_MS)) this._endSnap();
    this._pumpGpu();
    this._releaseOutsideBand();
    if (this.session && this.session.entry) this.session._requestCurrent();
    if (this._standby && this._standby.entry) this._standby._requestCurrent();
  };

  Player.prototype._clearQueues = function () {
    this._uploadQueue = [];
    this._decodeQueue = [];
    this._decodeBusy = false;
  };

  Player.prototype._enqueueUpload = function (img, tile, standby, done) {
    if (!this._uploadQueue) this._uploadQueue = [];
    this._uploadQueue.push({
      img: img,
      tile: tile,
      standby: !!standby,
      done: done,
      queuedAt: this._mediaMs || 0,
    });
    this._kick();
  };

  Player.prototype._enqueueDecode = function (payload, done) {
    if (!this._decodeQueue) this._decodeQueue = [];
    this._decodeQueue.push({ payload: payload, done: done });
    this._kick();
  };

  Player.prototype._pumpGpu = function () {
    // One main-thread stall per frame. A tile upload and a JPEG decode
    // both hitch the pan, so a frame does not do both. A large tile is
    // split into texSubImage2D strips that stay inside the upload budget.
    if (this._strip) {
      this._uploadsThisFrame = 1;
      if (this._uploadsThisFrame > this._maxUploadsPerFrame) this._maxUploadsPerFrame = this._uploadsThisFrame;
      this._uploadStripSlice();
      return;
    }
    if (this._uploadQueue && this._uploadQueue.length) {
      var job = this._uploadQueue[0];
      if (job.queuedAt == null) job.queuedAt = this._mediaMs || 0;
      if (this._uploadDelayMs > 0) {
        if (!job.readyAt) job.readyAt = job.queuedAt + this._uploadDelayMs;
        if ((this._mediaMs || 0) < job.readyAt) return;
        // The 64×64 probe in _measureUpload is not this wait. A throttled
        // level-0 upload is the latency the lookahead uses.
        this._noteUploadLatency((this._mediaMs || 0) - job.queuedAt);
      }
      this._uploadQueue.shift();
      this._uploadsThisFrame = 1;
      if (this._uploadsThisFrame > this._maxUploadsPerFrame) this._maxUploadsPerFrame = this._uploadsThisFrame;
      var tex = null;
      try {
        tex = this._uploadTile(job.img, job.tile, job.standby);
      } catch (error) {
        warn("texture upload failed", error && error.message);
      }
      if (this._strip) {
        this._strip.done = job.done;
        return;
      }
      if (job.done) job.done(tex);
      return;
    }
    if (this._decodeBusy || !this._decodeQueue || !this._decodeQueue.length) return;
    var decode = this._decodeQueue.shift();
    this._decodeBusy = true;
    var self = this;
    materializeJpeg(decode.payload, function (err, img) {
      self._decodeBusy = false;
      if (decode.done) decode.done(err, img);
    });
  };

  Player.prototype._setup = function () {
    // The snapshot is a copy of this buffer. Discarding it between frames made
    // the crossfade sample black on the TV.
    var attrs = { antialias: false, alpha: false, preserveDrawingBuffer: true };
    var gl = this.canvas.getContext("webgl2", attrs);
    this._webgl2 = !!gl;
    if (!gl) gl = this.canvas.getContext("webgl", attrs);
    if (!gl) return;
    var prec = this._webgl2 ? "highp" : fragmentPrecision(gl);
    var grad = !!this._webgl2;
    if (!grad) {
      grad = !!(gl.getExtension("OES_standard_derivatives") && gl.getExtension("EXT_shader_texture_lod"));
    }
    this._grad = grad;
    var sources = glSources(this._webgl2, prec, grad);
    var prog = compileProgram(gl, sources.vs, sources.fs);
    if (!prog && prec !== "mediump" && !this._webgl2) {
      prec = "mediump";
      sources = glSources(false, prec, grad);
      prog = compileProgram(gl, sources.vs, sources.fs);
    }
    if (!prog) return;
    this._prec = prec;
    this._sources = sources;
    this._gl = gl;
    this._glLost = false;
    this._mode = "webgl";
    gl.useProgram(prog);
    this._prog = prog;
    this._loc = {
      mvp: gl.getUniformLocation(prog, "uMvp"),
      fade: gl.getUniformLocation(prog, "uFade"),
      a: gl.getUniformLocation(prog, "uA"),
      b: gl.getUniformLocation(prog, "uB"),
      pitchA: gl.getUniformLocation(prog, "uPitchA"),
      rollA: gl.getUniformLocation(prog, "uRollA"),
      pitchB: gl.getUniformLocation(prog, "uPitchB"),
      rollB: gl.getUniformLocation(prog, "uRollB"),
    };
    var wide = this._webgl2 || !!gl.getExtension("OES_element_index_uint");
    var mesh = wide ? sphere(128, 256, true) : sphere(128, 64, false);
    this._count = mesh.count;
    this._indexType = wide ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    var buf = gl.createBuffer();
    this._buf = buf;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.interleaved, gl.STATIC_DRAW);
    var ib = gl.createBuffer();
    this._indexBuf = ib;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    this._bindMesh(gl, prog);
    gl.disable(gl.CULL_FACE);
    gl.clearColor(0.04, 0.05, 0.07, 1);
    if (!this._glHooks && this.canvas.addEventListener) {
      this._glHooks = true;
      var lostSelf = this;
      this.canvas.addEventListener("webglcontextlost", function (event) {
        if (event && event.preventDefault) event.preventDefault();
        lostSelf._glLost = true;
        lostSelf._resident = [];
        lostSelf._gpuBytes = 0;
        warn("webgl context lost");
      }, false);
      this.canvas.addEventListener("webglcontextrestored", function () {
        lostSelf._glLost = false;
        lostSelf._resident = [];
        lostSelf._gpuBytes = 0;
        lostSelf._lodHold = null;
        lostSelf._promoting = false;
        warn("webgl context restored");
        if (lostSelf.session && lostSelf.session.loaded) {
          lostSelf.session.loaded.forEach(function (piece) {
            var payload = piece.payload || (piece.tex && piece.tex._spsPayload);
            piece.payload = payload || null;
            piece.tex = payload ? { deferred: true, _evicted: true, _spsPayload: payload } : null;
          });
          lostSelf.session.live = [];
        }
        lostSelf._setup();
        lostSelf._followView();
        lostSelf.draw();
      }, false);
    }
    this._installTileProgram(gl);
    this._blank = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._blank);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([20, 24, 32, 255]));
    this._installQuad(gl);
    this._measureUpload(gl);
  };

  Player.prototype._upload = function (img) {
    if (this._glLost || !this._gl) this._setup();
    if (!this._gl || !img.width) return;
    var gl = this._gl;
    if (gl.isContextLost && gl.isContextLost()) return;
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    } catch (error) {
      this._uploadError = String(error);
      gl.deleteTexture(tex);
      return;
    }
    this._finishSampler(gl, tex, img.width, img.height, null);
    var i = this.images.indexOf(img);
    if (i >= 0) this._tex[i] = tex;
  };

  Player.prototype._releaseUrlTextures = function () {
    if (!this._gl || !this._tex) return;
    var gl = this._gl;
    this._tex.forEach(function (tex) {
      if (tex) gl.deleteTexture(tex);
    });
  };

  Player.prototype._deleteTex = function (tex) {
    if (!tex) return;
    this._dropResident(tex);
    if (tex.deferred || tex._evicted) return;
    if (this._gl) this._gl.deleteTexture(tex);
  };

  Player.prototype._dropResident = function (tex) {
    if (!tex || !this._resident) return;
    for (var i = 0; i < this._resident.length; i++) {
      if (this._resident[i].tex !== tex) continue;
      this._gpuBytes -= this._resident[i].bytes;
      this._resident.splice(i, 1);
      break;
    }
    if (this._gpuBytes < 0) this._gpuBytes = 0;
  };

  Player.prototype._drawingTex = function (tex) {
    if (!tex) return false;
    function hit(list) {
      if (!list) return false;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].tex === tex) return true;
      }
      return false;
    }
    return hit(this._tileDraw) || hit(this._fadeFrom);
  };

  Player.prototype._tileVisible = function (item, view) {
    if (!item || !item.tile || !view) return false;
    return tileInView(item.tile, item.spanW || 1, item.spanH || 1, view);
  };

  Player.prototype._listedTex = function (list, tex) {
    if (!tex || !list) return false;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].tex === tex) return true;
    }
    return false;
  };

  Player.prototype._evictScore = function (item, view) {
    if (!item) return null;
    // The full-sphere overview stays. So does the frustum, the lookahead
    // band, and the fade overlay. Behind the camera leaves first.
    if (item._base || (item.tex && item.tex._base) || (item.tile && item.tile._base)) return null;
    if (this._listedTex(this._fadeFrom, item.tex)) return null;
    if (!item.tile && this._drawingTex(item.tex)) return null;
    var sign = view && view.panSign < 0 ? -1 : 1;
    if (item.tile && tileInResidentBand(item.tile, item.spanW || 1, item.spanH || 1, view)) return null;
    if (!item.tile && this._tileVisible(item, view)) return null;
    var lead = panLeadDeg(item.u || 0, view ? view.u : 0.5, sign);
    if (lead <= 0) return 10000 - lead;
    return 1000 + lead;
  };

  Player.prototype._releaseOutsideBand = function () {
    if (!this._useTiles || !this._resident || !this._resident.length) return;
    var view = this._lodView();
    var guard = this._resident.length;
    while (guard-- > 0) {
      if (!this._evictDistant(view)) break;
    }
  };

  Player.prototype._evictDistant = function (view) {
    var worst = -1;
    var worstScore = -1;
    for (var i = 0; i < this._resident.length; i++) {
      var score = this._evictScore(this._resident[i], view);
      if (score == null || score <= worstScore) continue;
      worstScore = score;
      worst = i;
    }
    if (worst < 0) return false;
    var gone = this._resident[worst];
    this._resident.splice(worst, 1);
    this._gpuBytes -= gone.bytes;
    if (this._gpuBytes < 0) this._gpuBytes = 0;
    gone.tex._evicted = true;
    gone.tex.deferred = true;
    if (this._gl) this._gl.deleteTexture(gone.tex);
    return true;
  };

  Player.prototype._lodView = function () {
    if (!this._viewScratch) this._viewScratch = { u: 0.5, v: 0.5, halfU: 0.2, halfV: 0.2, yaw: 0, pitch: 0, roll: 0, fov: 75, aspect: 16 / 9 };
    var center = viewCenterUv(this.yaw, this.pitch);
    var aspect = this.canvas.width / Math.max(this.canvas.height, 1);
    var ext = viewExtents(this.fov, aspect);
    var slot = this._viewScratch;
    slot.u = center.u;
    slot.v = center.v;
    slot.halfU = ext.halfU;
    slot.halfV = ext.halfV;
    slot.yaw = this.yaw;
    slot.pitch = this.pitch;
    slot.roll = this.roll;
    slot.fov = this.fov;
    slot.aspect = aspect;
    slot.lookaheadDeg = this._lookaheadDeg();
    slot.panSign = 1;
    return slot;
  };

  Player.prototype._lookaheadDeg = function () {
    var latency = this._uploadLatencyMs;
    if (!(latency > 0)) latency = this._uploadDelayMs;
    if (!(latency > 0)) latency = LOOKAHEAD_LATENCY_FALLBACK_MS;
    return panLookaheadDeg(this.speed, latency);
  };

  Player.prototype._noteUploadLatency = function (ms) {
    if (!(ms >= 200)) return;
    var prev = this._uploadLatencyMs || 0;
    this._uploadLatencyMs = prev ? prev * 0.5 + ms * 0.5 : ms;
  };

  Player.prototype._dropBases = function () {
    if (!this._bases) {
      this._bases = {};
      return;
    }
    for (var id in this._bases) {
      var piece = this._bases[id];
      if (piece && piece.tex) this._deleteTex(piece.tex);
    }
    this._bases = {};
  };

  Player.prototype._ensureBase = function (entry) {
    if (!entry || !(entry.width > 0) || !(entry.height > 0)) return null;
    if (!this._bases) this._bases = {};
    var have = this._bases[entry.id];
    if (have && have.tex && !have.tex._evicted && !have.tex.deferred) return have;
    var tex = {
      _mip: true,
      _base: true,
      _uploadW: BASE_W,
      _uploadH: BASE_H,
      _bytes: BASE_BYTES,
      deferred: false,
      _evicted: false,
    };
    if (this._gl && !this._glLost && !(this._gl.isContextLost && this._gl.isContextLost())) {
      var gl = this._gl;
      var gpu = gl.createTexture();
      if (gpu) {
        gl.bindTexture(gl.TEXTURE_2D, gpu);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        var pixels = new Uint8Array(BASE_BYTES);
        for (var p = 0; p < BASE_BYTES; p += 4) {
          pixels[p] = 58;
          pixels[p + 1] = 64;
          pixels[p + 2] = 72;
          pixels[p + 3] = 255;
        }
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, BASE_W, BASE_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          gpu._mip = true;
          gpu._base = true;
          gpu._uploadW = BASE_W;
          gpu._uploadH = BASE_H;
          gpu._bytes = BASE_BYTES;
          tex = gpu;
        } catch (error) {
          warn("base sphere skipped", error && error.message);
        }
      }
    }
    var tile = {
      id: String(entry.id) + ":base",
      srcX: 0,
      srcY: 0,
      srcW: entry.width,
      srcH: entry.height,
      padL: 0,
      padR: 0,
      padT: 0,
      padB: 0,
      texW: BASE_W,
      texH: BASE_H,
      _base: true,
    };
    var piece = { tile: tile, tex: tex, _base: true };
    if (typeof document !== "undefined" && document.createElement) {
      try {
        var canvas = document.createElement("canvas");
        canvas.width = BASE_W;
        canvas.height = BASE_H;
        var ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.fillStyle = "#3a4048";
          ctx.fillRect(0, 0, BASE_W, BASE_H);
          piece.canvas = canvas;
        }
      } catch (error) {}
    }
    this._bases[entry.id] = piece;
    this._gpuBytes = (this._gpuBytes || 0) + BASE_BYTES;
    if (!this._resident) this._resident = [];
    this._resident.push({
      id: tile.id,
      tex: tex,
      bytes: BASE_BYTES,
      u: 0.5,
      v: 0.5,
      tile: tile,
      spanW: entry.width,
      spanH: entry.height,
      _base: true,
    });
    return piece;
  };

  Player.prototype._installOverview = function (img, tile) {
    var entry = (this.session && this.session.entry) || this._showingEntry();
    var piece = this._ensureBase(entry);
    if (!piece) return null;
    var w = (img && img.width) || (tile && tile.texW) || BASE_W;
    var h = (img && img.height) || (tile && tile.texH) || BASE_H;
    var tex = piece.tex;
    if (this._gl && !this._glLost && !(this._gl.isContextLost && this._gl.isContextLost()) && img && (img.width || img.height)) {
      var uploaded = this._texImage(this._gl, img);
      if (uploaded) {
        var gl = this._gl;
        gl.bindTexture(gl.TEXTURE_2D, uploaded);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        if (piece.tex && piece.tex !== uploaded) this._deleteTex(piece.tex);
        tex = uploaded;
      }
    }
    if (!tex) tex = {};
    tex._base = true;
    tex._photo = true;
    tex._mip = true;
    tex._uploadW = w;
    tex._uploadH = h;
    tex._bytes = BASE_BYTES;
    tex._evicted = false;
    tex.deferred = false;
    if (img && img.label) tex.label = img.label;
    piece.tex = tex;
    piece._photo = true;
    if (this._resident) {
      for (var i = 0; i < this._resident.length; i++) {
        var slot = this._resident[i];
        if (slot && slot._base && piece.tile && slot.tile && slot.tile.id === piece.tile.id) slot.tex = tex;
      }
    }
    if (!this._holdFrame) this.draw();
    return tex;
  };

  Player.prototype.setDebugTint = function (on) {
    if (on == null) this._debugTint = !this._debugTint;
    else this._debugTint = !!on;
    if (!this._holdFrame) this.draw();
  };

  Player.prototype._activeBase = function () {
    var entry = this._showingEntry();
    if (!entry || !this._bases) return null;
    var piece = this._bases[entry.id];
    if (!piece || !piece.tex || piece.tex._evicted || piece.tex.deferred) return null;
    return piece;
  };

  Player.prototype._showingEntry = function () {
    if (this.session && this.session.entry && this.session.entry.width) return this.session.entry;
    if (this.entries && this.entries[this.index]) return this.entries[this.index];
    return null;
  };

  Player.prototype._paintBase = function (entry, img, tile) {
    if (!entry || !img || !tile || !(img.width > 0) || !(img.height > 0)) return;
    if (tile._base) return;
    var piece = this._ensureBase(entry);
    if (piece && piece._photo) return;
    if (!piece || !piece.canvas) return;
    var ctx = piece.canvas.getContext("2d");
    if (!ctx) return;
    var dx = Math.floor((tile.srcX / entry.width) * BASE_W);
    var dy = Math.floor((tile.srcY / entry.height) * BASE_H);
    var dw = Math.max(1, Math.ceil((tile.srcW / entry.width) * BASE_W));
    var dh = Math.max(1, Math.ceil((tile.srcH / entry.height) * BASE_H));
    try {
      ctx.drawImage(img, 0, 0, img.width, img.height, dx, dy, dw, dh);
    } catch (error) {
      return;
    }
    if (!this._gl || !piece.tex || piece.tex._base !== true) return;
    try {
      var gl = this._gl;
      gl.bindTexture(gl.TEXTURE_2D, piece.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, piece.canvas);
    } catch (error) {}
  };

  Player.prototype.frameGaps = function () {
    var entry = this._showingEntry();
    var width = (entry && entry.width) || this._tileW || 1;
    var height = (entry && entry.height) || this._tileH || 1;
    var tiles = [];
    var base = this._activeBase();
    if (base && base.tile) tiles.push(base.tile);
    function take(list) {
      if (!list) return;
      for (var i = 0; i < list.length; i++) {
        var piece = list[i];
        if (!piece || !piece.tile || !piece.tex) continue;
        if (piece.tex.deferred || piece.tex._evicted || piece.tex.oom) continue;
        tiles.push(piece.tex._window || piece.tile);
      }
    }
    take(this._tileDraw);
    if (this._fading) take(this._fadeFrom);
    var aspect = this.canvas.width / Math.max(this.canvas.height, 1);
    return coverageMisses(tiles, width, height, this.yaw, this.pitch, this.fov, aspect);
  };

  Player.prototype._poolFor = function (id) {
    var pools = [this._standby, this._back, this.session];
    for (var i = 0; i < pools.length; i++) {
      var pool = pools[i];
      if (pool && pool.entry && pool.entry.id === id) return pool;
    }
    return null;
  };

  Player.prototype._deferred = function (img, tile) {
    return {
      deferred: true,
      _evicted: true,
      _spsPayload: img && img._spsPayload,
      _tileId: tile && tile.id,
    };
  };

  Player.prototype._newSession = function () {
    var self = this;
    var session;
    session = new PhotoSession({
      request: function (id, token) {
        if (window.__castSend) window.__castSend({ type: "fetch", id: id, token: token });
      },
      preloadLimit: function () { return self._preloadDepth || 0; },
      gpuRoom: function () { return Math.max(0, GPU_CAP - (self._gpuBytes || 0)); },
      materialize: function (payload, done) {
        if (self._injectImage) {
          var injected = self._injectImage(payload);
          if (injected) {
            if (!injected._spsPayload) injected._spsPayload = payload;
            done(null, injected);
            return;
          }
        }
        self._enqueueDecode(payload, function (err, img) {
          if (img && !img._spsPayload) img._spsPayload = payload;
          done(err, img);
        });
      },
      view: function () {
        var live = self._lodView();
        if (!session.standby) return live;
        var start = {
          u: 0.5,
          v: 0.5,
          halfU: live.halfU,
          halfV: live.halfV,
          yaw: 0,
          pitch: live.pitch,
          roll: 0,
          fov: live.fov,
          aspect: live.aspect,
          lookaheadDeg: live.lookaheadDeg,
          panSign: 1,
        };
        if (live.pitch > 28) start.v = live.v;
        else if (live.pitch < -28) start.v = live.v;
        return start;
      },
      onEntry: function (entry) { self._ensureBase(entry); },
      upload: function (img, tile, done) {
        if (tile && tile._overview) {
          var overviewTex = self._installOverview(img, tile);
          if (typeof done === "function") done(overviewTex);
          return;
        }
        if (isGpuSource(img) || self._uploadDelayMs > 0) {
          self._enqueueUpload(img, tile, !!session.standby, done);
          return;
        }
        return self._uploadTile(img, tile, !!session.standby);
      },
      dropImage: function (img) {
        if (!img) return;
        img.onload = null;
        img.onerror = null;
        try {
          if (typeof img.close === "function") img.close();
        } catch (error) {}
        try {
          if (typeof img.src === "string" && img.src) img.src = "";
        } catch (error) {}
      },
      release: function (tex) { self._deleteTex(tex); },
      onStatus: function (text) {
        if (session.standby) return;
        // The soft overview is the picture. The spinner never holds the show.
        self._busy = false;
        self._markBusy();
        if (text === "error") self._reportTv("The photo could not be opened");
        self.draw();
      },
      onLog: function (message) { self._reportTv(message); },
      onTile: function (sess, piece) {
        self._onStandbyTile(sess, piece);
      },
      onShown: function (state) {
        var want = self._awaitingSwap && self.entries ? self.entries[self._awaitIndex] : null;
        if (want && state && state.id === want.id && swapReady(session)) {
          self._commitIndex(self._awaitIndex, session);
          return;
        }
        if (session.standby || session === self._standby || session === self._back) {
          self._preloadBack();
          return;
        }
        self._presentShown(state);
      },
      onFail: function () {},
      onMemory: function (photoId) {
        warn("full-resolution tile did not upload", photoId);
      },
    });
    return session;
  };

  Player.prototype._ensureSession = function () {
    if (!this.session) this.session = this._newSession();
  };

  Player.prototype._dropStandby = function () {
    if (this._standby) this._standby.dispose();
    if (this._back) this._back.dispose();
    this._standby = null;
    this._back = null;
  };

  Player.prototype._onStandbyTile = function (sess, piece) {
    if (!sess || !sess.entry) return;
    if (this._awaitingSwap && this.entries && this._awaitIndex != null && swapReady(sess)) {
      var want = this.entries[this._awaitIndex];
      if (want && sess.entry.id === want.id) this._commitIndex(this._awaitIndex, sess);
    }
    if (sess !== this.session || sess.standby || !pieceReady(piece)) return;
    if (!this._tileDraw) this._tileDraw = [];
    var id = piece.tile && piece.tile.id;
    for (var i = 0; i < this._tileDraw.length; i++) {
      var have = this._tileDraw[i] && this._tileDraw[i].tile && this._tileDraw[i].tile.id;
      if (id && have === id) {
        var old = this._tileDraw[i].tex;
        if (old && (old._evicted || old.deferred)) this._tileDraw[i] = piece;
        return;
      }
    }
    this._tileDraw.push(piece);
    if (!this._holdFrame) this.draw();
  };

  Player.prototype._presentShown = function (state) {
    var resident = (state.tiles || []).filter(function (piece) {
      return piece.tex && !piece.tex.deferred && !piece.tex._evicted && !piece.tex.oom;
    });
    if (!resident.length) {
      this._busy = false;
      this._markBusy();
      return;
    }
    if (this._presented && this.session && this.session.entry && state && state.id === this.session.entry.id && this._tileDraw && this._tileDraw.length) {
      // The view already crossfaded. Later tiles join that frame in place.
      this._tileDraw = resident;
      this._tileW = state.width;
      this._tileH = state.height;
      this._busy = false;
      this._markBusy();
      if (!this._holdFrame) this.draw();
      this._preloadNeighbors();
      return;
    }
    var covered = coversSphere(
      resident.map(function (piece) { return piece.tile; }),
      state.width,
      state.height,
    );
    var replacing = this._tileDraw && this._tileDraw.length;
    var soft = !!this._activeBase();
    if (!soft && (!covered || (replacing && !resident.every(function (piece) { return piece.tex && piece.tex._mip === true; })))) {
      // Without the overview, a partial set stays off the sphere.
      this._busy = false;
      this._markBusy();
      return;
    }
    if (!soft && replacing && state.tiles && resident.length !== state.tiles.length) return;
    if (!replacing) {
      // The first photo has nothing to crossfade from.
    } else {
      this._armFade();
    }
    this._tileDraw = resident;
    this._tileW = state.width;
    this._tileH = state.height;
    this._busy = false;
    this._markBusy();
    if (window.__castSend) window.__castSend({ type: "photo", id: state.id, ok: true });
    if (!this._holdFrame) this.draw();
    this._preloadNeighbors();
  };

  Player.prototype._armFade = function () {
    if (!this._tileDraw || !this._tileDraw.length) return;
    this._fadeFrom = this._tileDraw.slice();
    this._fadeW = this._tileW;
    this._fadeH = this._tileH;
    this._fadeMs = 0;
    this._fading = true;
    this._kick();
  };

  Player.prototype._endFade = function () {
    this._fading = false;
    this._fadeMs = TILE_FADE_MS;
    if (this._fadeRelease && this._fadeFrom) {
      for (var i = 0; i < this._fadeFrom.length; i++) {
        var tex = this._fadeFrom[i] && this._fadeFrom[i].tex;
        if (tex) this._deleteTex(tex);
      }
    }
    this._fadeFrom = null;
    this._fadeRelease = false;
    if (this.session && this.session.budgetFull) this.session.resume();
    this._preloadBack();
  };

  Player.prototype._readyPool = function (id) {
    var pools = [this._standby, this._back, this.session];
    for (var i = 0; i < pools.length; i++) {
      var pool = pools[i];
      if (!pool || !pool.entry || pool.entry.id !== id) continue;
      if (swapReady(pool)) return pool;
    }
    return null;
  };

  Player.prototype._incomingPool = function (id) {
    var pools = [this._standby, this._back];
    for (var i = 0; i < pools.length; i++) {
      var pool = pools[i];
      if (!pool || !pool.entry || pool.entry.id !== id) continue;
      if (!swapReady(pool)) return pool;
    }
    return null;
  };

  Player.prototype._ensureIncoming = function (entry) {
    if (!entry) return;
    if (this._readyPool(entry.id) || this._incomingPool(entry.id)) return;
    if (this.session && this.session.entry === entry) return;
    var standby = this._standby;
    if (!standby || !standby.entry || (!standby.pending && !(standby.loaded && standby.loaded.length))) {
      if (standby) standby.dispose();
      this._standby = this._newSession();
      this._standby.preload(entry);
      return;
    }
    if (standby.entry.id === entry.id) return;
    if (!this._back || !this._back.entry || (!this._back.pending && !(this._back.loaded && this._back.loaded.length))) {
      if (this._back) this._back.dispose();
      this._back = this._newSession();
      this._back.preload(entry);
      return;
    }
    if (this._back.entry.id === entry.id) return;
    this._back.dispose();
    this._back = this._newSession();
    this._back.preload(entry);
  };

  Player.prototype._requestIndex = function (at) {
    if (at == null || at < 0 || at >= this.items.length) return false;
    var entry = this.entries && this.entries[at];
    if (!entry || !this._useTiles) return false;
    if (at === this.index && !this._awaitingSwap) return false;
    if (this._awaitingSwap && this._awaitIndex === at) {
      var readyNow = this._readyPool(entry.id);
      if (!readyNow) {
        if (this.playing && !this.manual) this.itemDegrees = ROTATIONS * FULL_TURN;
        var waiting = this._incomingPool(entry.id);
        if (!waiting) this._ensureIncoming(entry);
        else if ((waiting.budgetFull || waiting.preloadCapped) && !this._holdFrame) this._considerHold(waiting);
        else if (!waiting.pending && !waiting.budgetFull && !waiting.preloadCapped) waiting._requestCurrent();
        return true;
      }
    }
    var pool = this._readyPool(entry.id);
    this._awaitingSwap = true;
    this._awaitIndex = at;
    this._switchTick = nowMs();
    if (pool) {
      this._commitIndex(at, pool);
      return true;
    }
    if (this.playing && !this.manual) this.itemDegrees = ROTATIONS * FULL_TURN;
    this._ensureIncoming(entry);
    var incoming = this._incomingPool(entry.id);
    if (incoming && (incoming.budgetFull || incoming.preloadCapped)) this._considerHold(incoming);
    return true;
  };

  Player.prototype._commitIndex = function (at, pool) {
    if (!swapReady(pool)) {
      this._logSwitch("hold-live", "next-not-drawable " + this._preloadDetail());
      return;
    }
    var resetYaw = this._jumpReset === "zero";
    this._jumpReset = null;
    this.index = at;
    this.fromIndex = at;
    this.phase = "pan";
    this.fadeMs = 0;
    this.fade = 0;
    this.itemDegrees = 0;
    if (resetYaw) {
      this.yaw = 0;
      this._panBlend = 1;
      this._resetAim();
    }
    if (!this.manual && this.items.length) {
      this.playing = true;
      this._kick();
    }
    this._adoptPool(pool);
    this._mark();
    if (window.__onCastStatus) window.__onCastStatus(this.snapshot());
  };

  Player.prototype._adoptPool = function (pool) {
    if (!pool || !pool.entry) return;
    var entry = pool.entry;
    var held = !!this._holdFrame;
    var resident = [];
    var loaded = pool.loaded || [];
    for (var i = 0; i < loaded.length; i++) {
      if (pieceReady(loaded[i])) resident.push(loaded[i]);
    }
    if (!resident.length || !swapReady(pool)) {
      this._logSwitch("hold-live", "next-not-drawable " + this._preloadDetail());
      return;
    }
    this._holdFrame = false;
    pool.standby = false;
    pool.budgetFull = false;
    pool.preloadCapped = false;
    if (pool === this._standby) this._standby = null;
    if (pool === this._back) this._back = null;
    var previous = this.session;
    var hadFrame = !!(this._tileDraw && this._tileDraw.length);
    var oldDraw = this._tileDraw ? this._tileDraw.slice() : [];
    this.session = pool;
    this._tileDraw = resident;
    this._fading = false;
    this._fadeFrom = null;
    this._fadeRelease = false;
    if (!held && hadFrame && previous && previous !== pool) {
      // The snapshot already taken at the end of the last painted frame is the
      // old photo. Copying again here reads the buffer after the browser may
      // have discarded it, which replaces that photo with black.
      if (!(this._snapTex && (this._snapCopies || 0) > 0)) this._copySnapshot();
      this._beginSnapshot("switch");
    }
    if (previous && previous !== pool) {
      previous.quietStop();
      for (var p = 0; p < oldDraw.length; p++) {
        var tex = oldDraw[p] && oldDraw[p].tex;
        if (!tex) continue;
        var kept = false;
        for (var q = 0; q < resident.length; q++) {
          if (resident[q] && resident[q].tex === tex) kept = true;
        }
        if (!kept) this._deleteTex(tex);
      }
      previous.live = [];
      previous.loaded = [];
    }
    if (!pool.pending && !sessionReady(pool)) pool.resume();
    this._tileW = entry.width;
    this._tileH = entry.height;
    this._busy = false;
    this._markBusy();
    if (this._awaitingSwap) {
      this._fullFrameMs = nowMs() - (this._switchTick || nowMs());
      this._awaitingSwap = false;
      this._awaitIndex = null;
    }
    if (this._advanceAt && !this._firstNewAt) {
      this._firstNewAt = nowMs();
      var waited = this._firstNewAt - this._advanceAt;
      this._logSwitch("first-frame", String(waited));
      if (typeof console !== "undefined" && console.info) {
        console.info("spsphere cast advance-to-frame", waited);
      }
      this._advanceAt = 0;
      this._advanceMarked = false;
    }
    if (this._snapOn && resident.length) this._snapReveal = true;
    if (!this._holdFrame) this.draw();
    if (resident.length && window.__castSend) window.__castSend({ type: "photo", id: entry.id, ok: true });
    this._preloadNeighbors();
  };

  Player.prototype._considerHold = function (pool) {
    if (!pool || sessionReady(pool)) return;
    if (!pool.budgetFull && !pool.preloadCapped) return;
    var why = pool.preloadCapped ? "preload-cap" : "budget-full";
    if (this._holdLogged !== why) {
      this._holdLogged = why;
      this._logSwitch("hold-live", why + " " + this._preloadDetail());
    }
    // The photo already on screen keeps drawing. Off-screen tiles can leave
    // to make room. The frame is not released until the next view can draw.
    this._evictOffscreen();
    pool.standby = true;
    pool.preloadCapped = false;
    pool.budgetFull = false;
    pool.resume();
  };

  Player.prototype._releaseShownGpu = function () {
    var self = this;
    function dropList(list) {
      if (!list) return;
      for (var i = 0; i < list.length; i++) {
        var tex = list[i] && list[i].tex;
        if (tex) self._deleteTex(tex);
      }
    }
    dropList(this._tileDraw);
    dropList(this._fadeFrom);
    this._tileDraw = [];
    this._fadeFrom = null;
    this._fading = false;
    this._fadeRelease = false;
    if (this.session) {
      this.session.live = [];
      if (this.session.loaded) {
        this.session.loaded.forEach(function (piece) {
          if (piece.tex) {
            piece.tex._evicted = true;
            piece.tex.deferred = true;
          }
        });
      }
    }
  };

  Player.prototype._openCurrent = function () {
    if (!this._useTiles) return;
    var entry = this.entries && this.entries[this.index];
    if (!entry) return;
    this._lodHold = null;
    this._promoting = false;
    if (!(this._tileDraw && this._tileDraw.length)) {
      this._awaitingSwap = false;
      this._awaitIndex = null;
      this._ensureSession();
      this.session.open(entry);
      return;
    }
    var ready = this._readyPool(entry.id);
    if (ready && ready !== this.session) {
      this._switchTick = nowMs();
      this._awaitingSwap = true;
      this._awaitIndex = this.index;
      this._adoptPool(ready);
      return;
    }
    if (this.session && this.session.entry === entry && (this.session.shown || this.session.pending)) return;
    this._awaitingSwap = true;
    this._awaitIndex = this.index;
    this._switchTick = this._switchTick || nowMs();
    this._ensureIncoming(entry);
    var incoming = this._incomingPool(entry.id);
    if (incoming && (incoming.budgetFull || incoming.preloadCapped)) this._considerHold(incoming);
  };

  Player.prototype._preloadNeighbors = function () {
    if (!this._useTiles || !this.entries || this.entries.length < 2) return;
    // Finish the photo on screen before spending the send lane on the one after it.
    if (this.session && this.session.entry && !this.session.shown && !swapReady(this.session)) return;
    var nextAt = stepIndex(this.index, this.entries.length, 1, true);
    if (nextAt == null) return;
    var entry = this.entries[nextAt];
    if (!entry || !entry.tiles || !entry.tiles.length) return;
    if (this.session && this.session.entry && this.session.entry.id === entry.id) return;
    if (this._back && this._back.entry && this._back.entry.id === entry.id) return;
    if (!this._standby) this._standby = this._newSession();
    this._standby.preload(entry);
  };

  Player.prototype._preloadBack = function () {
    if (!this._useTiles || !this.entries || this.entries.length < 2) return;
    var prevAt = stepIndex(this.index, this.entries.length, -1, true);
    var nextAt = stepIndex(this.index, this.entries.length, 1, true);
    if (prevAt == null || prevAt === nextAt) return;
    var entry = this.entries[prevAt];
    if (!entry || !entry.tiles) return;
    if (this._back && this._back.entry && this._back.entry.id === entry.id) return;
    if (this.session && this.session.entry && this.session.entry.id === entry.id) return;
    var room = Math.max(0, GPU_CAP - (this._gpuBytes || 0));
    var one = 0;
    var tile = entry.tiles[0];
    if (tile) one = (tile.texW || tile.srcW || 1) * (tile.texH || tile.srcH || 1) * 4;
    if (room < one) return;
    if (!this._back) this._back = this._newSession();
    this._back.preload(entry);
  };

  Player.prototype.noteChunk = function (msg) {
    if (this._standby && this._standby.accepts(msg)) {
      this._standby.noteChunk(msg);
      return;
    }
    if (this._back && this._back.accepts(msg)) {
      this._back.noteChunk(msg);
      return;
    }
    if (this.session) this.session.noteChunk(msg);
  };

  Player.prototype.noteFetchError = function (msg) {
    if (this._standby && this._standby.accepts(msg)) {
      this._standby.noteFetchError(msg);
      return;
    }
    if (this._back && this._back.accepts(msg)) {
      this._back.noteFetchError(msg);
      return;
    }
    if (this.session) this.session.noteFetchError(msg);
  };

  Player.prototype.retile = function (id, item) {
    var entry = normalizeEntries([item])[0];
    if (!entry) return;
    var at = this.ids.indexOf(String(id));
    if (at < 0) at = this.ids.indexOf(entry.id);
    if (at < 0) return;
    this._useTiles = true;
    if (!this.entries) this.entries = [];
    this.entries[at] = entry;
    this.ids[at] = entry.id;
    this.items[at] = entry.url;
    this.poses[at] = poseOf(entry);
    if (at === this.index) this._openCurrent();
    else if (this._awaitingSwap && this._awaitIndex === at) this._requestIndex(at);
    else this._preloadNeighbors();
  };

  Player.prototype._texImage = function (gl, source) {
    var tex = gl.createTexture();
    if (!tex) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (this._beginStrip(gl, tex, source)) return tex;
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch (error) {
      gl.deleteTexture(tex);
      warn("texture upload failed", error && error.message);
      return null;
    }
    if (gl.isContextLost && gl.isContextLost()) {
      warn("webgl context lost");
      return null;
    }
    var w = source.width || 0;
    var h = source.height || 0;
    this._finishSampler(gl, tex, w, h, source);
    return tex;
  };

  Player.prototype._finishSampler = function (gl, tex, width, height, source) {
    var uploadW = width;
    var uploadH = height;
    var pot = isPow2(width) && isPow2(height);
    if (!this._webgl2 && !pot && source) {
      var padded = potPadSource(source);
      if (padded && padded.width && (padded.width !== width || padded.height !== height)) {
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, padded);
          uploadW = padded.width;
          uploadH = padded.height;
          pot = isPow2(uploadW) && isPow2(uploadH);
        } catch (error) {
          warn("texture pad failed", error && error.message);
          pot = isPow2(width) && isPow2(height);
          uploadW = width;
          uploadH = height;
        }
      }
    }
    var min = gl.LINEAR;
    var aniso = 1;
    if (source && source._levels && source._levels.length > 1) {
      if (this._uploadExplicitMips(gl, source._levels)) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        min = gl.LINEAR_MIPMAP_LINEAR;
        aniso = this._setAniso(gl);
        tex._mip = true;
        tex._explicitMips = true;
      }
    } else if (this._webgl2 || pot) {
      var mipOk = true;
      try {
        gl.generateMipmap(gl.TEXTURE_2D);
      } catch (error) {
        mipOk = false;
        warn("mipmap skipped", error && error.message);
      }
      if (mipOk) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        min = gl.LINEAR_MIPMAP_LINEAR;
        aniso = this._setAniso(gl);
        tex._mip = true;
      }
    }
    this._minFilter = min;
    this._aniso = aniso;
    tex._uploadW = uploadW;
    tex._uploadH = uploadH;
    if (tex._mip !== true) {
      // Level 0 is already the full-resolution tile. A failed mipmap must
      // not keep it off the sphere.
      tex._mip = true;
      tex._bilinear = true;
    }
  };

  Player.prototype._setAniso = function (gl) {
    if (this._anisoExt === undefined) {
      this._anisoExt = gl.getExtension("EXT_texture_filter_anisotropic") ||
        gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic") ||
        gl.getExtension("MOZ_EXT_texture_filter_anisotropic") ||
        null;
    }
    var ext = this._anisoExt;
    if (!ext) return 1;
    var max = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1;
    if (max > 1) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, max);
    return max;
  };

  Player.prototype._uploadTile = function (img, tile, standby) {
    if (this._glLost || !this._gl) this._setup();
    var gl = this._gl;
    if (!gl || (gl.isContextLost && gl.isContextLost())) {
      warn("webgl context lost");
      return this._deferred(img, tile);
    }
    if (!img) throw new Error("no image");
    var maxEdge = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    var budget = this._gpuBudget == null ? Infinity : this._gpuBudget;
    if (standby) {
      if ((this._gpuBytes || 0) + ((img.width || (tile && tile.texW) || 1) * (img.height || (tile && tile.texH) || 1) * 4) > GPU_CAP) {
        return this._deferred(img, tile);
      }
      budget = Infinity;
    }
    var entry = this.session && this.session.entry;
    var view = this._lodView();
    var slot = null;
    if (entry && entry.tiles && tile) {
      var plan = planResidence(entry.tiles, entry.width, entry.height, view, maxEdge, budget);
      for (var i = 0; i < entry.tiles.length; i++) {
        if (entry.tiles[i].id === tile.id) slot = plan[i];
      }
    }
    if (slot && !slot.resident) return this._deferred(img, tile);
    var win = slot && slot.window;
    var source = img;
    var upW = img.width || (tile && tile.texW) || 0;
    var upH = img.height || (tile && tile.texH) || 0;
    if (win && !win.full) {
      var cropped = cropSource(img, win.cropX, win.cropY, win.texW, win.texH);
      if (!cropped) {
        warn("could not keep a full-resolution window", tile && tile.id);
        return this._deferred(img, tile);
      }
      source = cropped;
      upW = win.texW;
      upH = win.texH;
    }
    if (upW > maxEdge || upH > maxEdge) {
      warn("tile is larger than MAX_TEXTURE_SIZE", upW + "x" + upH);
      return this._deferred(img, tile);
    }
    var bytes = upW * upH * 4;
    var spanW = (entry && entry.width) || (tile && tile.srcW) || 1;
    var spanH = (entry && entry.height) || (tile && tile.srcH) || 1;
    var self = this;
    function canEvict() {
      for (var r = 0; r < self._resident.length; r++) {
        if (self._evictScore(self._resident[r], view) != null) return true;
      }
      return false;
    }
    if (budget !== Infinity) {
      while (this._gpuBytes + bytes > budget && canEvict()) {
        if (!this._evictDistant(view)) break;
      }
      if (this._gpuBytes + bytes > budget) {
        warn("texture budget", tile && tile.id);
        return this._deferred(img, tile);
      }
    }
    var tex = null;
    var attempts = this._resident.length + 1;
    var uploadStarted = nowMs();
    while (attempts-- > 0) {
      tex = this._texImage(gl, source);
      if (tex) break;
      // A failed upload can evict a tile that is outside the view. It cannot
      // drop a tile the frustum still sees, including a pole tile behind the yaw.
      if (!canEvict()) break;
      if (!this._evictDistant(view)) break;
    }
    if (!tex) return this._deferred(img, tile);
    if (tex._uploadW && tex._uploadH) bytes = tex._uploadW * tex._uploadH * 4;
    tex._bytes = bytes;
    tex._window = win && !win.full ? win : null;
    tex._spsPayload = img._spsPayload || null;
    tex._tileId = tile && tile.id;
    this._gpuBytes += bytes;
    var drawn = win && !win.full ? win : tile;
    this._resident.push({
      id: tex._tileId,
      tex: tex,
      bytes: bytes,
      u: tile ? (tile.srcX + tile.srcW / 2) / spanW : view.u,
      v: tile ? (tile.srcY + tile.srcH / 2) / spanH : view.v,
      tile: drawn,
      spanW: spanW,
      spanH: spanH,
    });
    if (upW * upH >= 256 * 256) this._noteUploadLatency(nowMs() - uploadStarted);
    if (entry && tile && source && source.width > 0 && source.height > 0) this._paintBase(entry, source, tile);
    return tex;
  };

  Player.prototype._followView = function () {
    if (this._promoting || this._glLost || !this.session || !this.session.shown || !this.session.entry) return;
    var view = this._lodView();
    if (this._lodHold && Math.abs(shortest(view.yaw - this._lodHold.yaw)) < 2 && Math.abs(view.pitch - this._lodHold.pitch) < 2) return;
    var entry = this.session.entry;
    var gl = this._gl;
    var maxEdge = gl ? (gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096) : 4096;
    var budget = this._gpuBudget == null ? Infinity : this._gpuBudget;
    var plan = planResidence(entry.tiles, entry.width, entry.height, view, maxEdge, budget);
    var self = this;
    var jobs = [];
    this.session.loaded.forEach(function (piece, index) {
      var slot = plan[index];
      if (!slot || !slot.resident) return;
      if (piece.tex && !piece.tex.deferred && !piece.tex._evicted) return;
      var payload = piece.payload || (piece.tex && piece.tex._spsPayload);
      if (!payload) return;
      jobs.push({ piece: piece, payload: payload });
    });
    this._lodHold = { yaw: view.yaw, pitch: view.pitch };
    if (!jobs.length) return;
    this._promoting = true;
    var left = jobs.length;
    function finished() {
      left -= 1;
      if (left <= 0) self._promoting = false;
    }
    jobs.forEach(function (job) {
      self._enqueueDecode(job.payload, function (err, img) {
        if (err || !img || !self.session || self.session.entry !== entry) {
          if (err) warn("could not reopen a tile", err && err.message);
          if (img && self.session && self.session.hooks.dropImage) self.session.hooks.dropImage(img);
          finished();
          return;
        }
        img._spsPayload = job.payload;
        self._enqueueUpload(img, job.piece.tile, false, function (tex) {
          if (tex && !tex.deferred && self.session && self.session.entry === entry) {
            job.piece.tex = tex;
            job.piece.payload = job.payload;
            self.session.live.push(tex);
            if (!self._holdFrame) self.draw();
          }
          if (self.session && self.session.hooks.dropImage) self.session.hooks.dropImage(img);
          finished();
        });
      });
    });
  };

  Player.prototype._bindMesh = function (gl, program) {
    if (!gl || !this._buf || !program) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buf);
    var pos = gl.getAttribLocation(program, "aPos");
    if (pos >= 0) {
      gl.enableVertexAttribArray(pos);
      gl.vertexAttribPointer(pos, 3, gl.FLOAT, false, 20, 0);
    }
    var uv = gl.getAttribLocation(program, "aUv");
    if (uv >= 0) {
      gl.enableVertexAttribArray(uv);
      gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 20, 12);
    }
    if (this._indexBuf) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuf);
  };

  Player.prototype._drawMesh = function (gl) {
    this._bindMesh(gl, gl.getParameter(gl.CURRENT_PROGRAM));
    gl.drawElements(gl.TRIANGLES, this._count, this._indexType || gl.UNSIGNED_SHORT, 0);
  };

  Player.prototype._installTileProgram = function (gl) {
    var sources = this._sources || glSources(this._webgl2, this._prec || "highp", this._grad !== false);
    var prog = compileProgram(gl, sources.tileVs, sources.tileFs);
    if (!prog) return;
    this._tileProg = prog;
    this._tileLoc = {
      mvp: gl.getUniformLocation(prog, "uMvp"),
      tex: gl.getUniformLocation(prog, "uTex"),
      pitch: gl.getUniformLocation(prog, "uPitch"),
      roll: gl.getUniformLocation(prog, "uRoll"),
      u0: gl.getUniformLocation(prog, "uU0"),
      u1: gl.getUniformLocation(prog, "uU1"),
      v0: gl.getUniformLocation(prog, "uV0"),
      v1: gl.getUniformLocation(prog, "uV1"),
      padL: gl.getUniformLocation(prog, "uPadL"),
      padT: gl.getUniformLocation(prog, "uPadT"),
      srcW: gl.getUniformLocation(prog, "uSrcW"),
      srcH: gl.getUniformLocation(prog, "uSrcH"),
      texW: gl.getUniformLocation(prog, "uTexW"),
      texH: gl.getUniformLocation(prog, "uTexH"),
      alpha: gl.getUniformLocation(prog, "uAlpha"),
      kind: gl.getUniformLocation(prog, "uKind"),
      debug: gl.getUniformLocation(prog, "uDebug"),
      reveal: gl.getUniformLocation(prog, "uReveal"),
      cu: gl.getUniformLocation(prog, "uCu"),
      cv: gl.getUniformLocation(prog, "uCv"),
      halfU: gl.getUniformLocation(prog, "uHalfU"),
      halfV: gl.getUniformLocation(prog, "uHalfV"),
      nL: gl.getUniformLocation(prog, "uNL"),
      nR: gl.getUniformLocation(prog, "uNR"),
      nU: gl.getUniformLocation(prog, "uNU"),
      nD: gl.getUniformLocation(prog, "uND"),
    };
    gl.useProgram(this._prog);
  };

  Player.prototype._drawTiles = function () {
    var gl = this._gl;
    if (!gl || (gl.isContextLost && gl.isContextLost())) return;
    this._followView();
    var w = this.canvas.width;
    var h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    var self = this;
    var view = this._lodView();
    if (!this._drawKeep) this._drawKeep = [];
    if (!this._oldKeep) this._oldKeep = [];
    function collect(list, out, spanW, spanH) {
      out.length = 0;
      if (!list) return out;
      var seen = 0;
      var kept = 0;
      for (var n = 0; n < list.length; n++) {
        var piece = list[n];
        if (!piece || !piece.tex || piece.tex.deferred || piece.tex._evicted) continue;
        var spec = piece.tex._window || piece.tile;
        if (!spec || spec.srcW < 1 || spec.srcH < 1) continue;
        seen += 1;
        if (!tileInView(spec, spanW, spanH, view)) continue;
        out.push(piece);
        kept += 1;
      }
      if (seen && !kept) {
        for (var k = 0; k < list.length; k++) {
          var fallback = list[k];
          if (!fallback || !fallback.tex || fallback.tex.deferred || fallback.tex._evicted) continue;
          out.push(fallback);
        }
      }
      return out;
    }
    var drawable = collect(this._tileDraw, this._drawKeep, this._tileW || 1, this._tileH || 1);
    var oldDrawable = this._fading ? collect(this._fadeFrom, this._oldKeep, this._fadeW || 1, this._fadeH || 1) : this._oldKeep;
    if (!this._fading && this._oldKeep) this._oldKeep.length = 0;
    var basePiece = this._activeBase();
    var paintBase = !!(basePiece && basePiece._photo && basePiece.tile);
    var alphas = compositeAlphas(this._fadeMs, oldDrawable.length > 0, drawable.length > 0);
    if (!this._tileProg || (!drawable.length && !oldDrawable.length && !paintBase)) {
      if ((this._snapOn || this._presented) && this._snapTex) {
        this._drawSnap(gl, 1);
        return;
      }
      if (this._presented || this._awaitingSwap) {
        // The previous frame stays. Clearing here is the black flash.
        this._logSwitch("frozen", "cover-missing");
        return;
      }
      gl.clear(gl.COLOR_BUFFER_BIT);
      this._noteBlack("cleared");
      return;
    }
    // The clear color is the gray Cameron saw through a hole. Draw the
    // overview over it. Until that photo arrives, keep the frame that is up.
    if (paintBase || (alphas.clear && !this._presented)) gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this._tileProg);
    fillPerspective(this._proj, this.fov, w / Math.max(h, 1), 0.05, 20);
    fillAimView(this._m0, this._m1, this._m2, this._view, this.yaw, this.pitch, this.roll);
    multiplyInto(this._mvp, this._proj, this._view);
    var loc = this._tileLoc;
    gl.uniformMatrix4fv(loc.mvp, false, this._mvp);
    var pose = this.poses[this.index] || ZERO_POSE;
    gl.uniform1f(loc.pitch, pose.pitch);
    gl.uniform1f(loc.roll, pose.roll);
    function paint(list, spanW, spanH, alpha, sharpen) {
      if (loc.alpha) gl.uniform1f(loc.alpha, alpha);
      for (var i = 0; i < list.length; i++) {
        var piece = list[i];
        var tex = piece.tex;
        var tile = piece.spec || piece.tile || (tex && tex._window);
        if (!tex || tex.deferred || tex._evicted || !tile) continue;
        var overview = !!(piece._base || tile._base);
        var sampleW = tex._uploadW || tile.texW || BASE_W;
        var sampleH = tex._uploadH || tile.texH || BASE_H;
        var sample = overview ? overviewUniforms(sampleW, sampleH) : null;
        gl.uniform1f(loc.u0, sample ? sample.u0 : tile.srcX / spanW);
        gl.uniform1f(loc.u1, sample ? sample.u1 : (tile.srcX + tile.srcW) / spanW);
        gl.uniform1f(loc.v0, sample ? sample.v0 : tile.srcY / spanH);
        gl.uniform1f(loc.v1, sample ? sample.v1 : (tile.srcY + tile.srcH) / spanH);
        gl.uniform1f(loc.padL, sample ? sample.padL : (tile.padL || 0));
        gl.uniform1f(loc.padT, sample ? sample.padT : (tile.padT || 0));
        gl.uniform1f(loc.srcW, sample ? sample.srcW : tile.srcW);
        gl.uniform1f(loc.srcH, sample ? sample.srcH : tile.srcH);
        gl.uniform1f(loc.texW, sample ? sample.texW : (tex._uploadW || tile.texW));
        gl.uniform1f(loc.texH, sample ? sample.texH : (tex._uploadH || tile.texH));
        if (loc.kind) gl.uniform1f(loc.kind, overview ? 1 : 0);
        if (loc.debug) gl.uniform1f(loc.debug, self._debugTint ? 1 : 0);
        var reveal = 1;
        var nL = 1;
        var nR = 1;
        var nU = 1;
        var nD = 1;
        if (sharpen && !overview) {
          reveal = self._revealOf(piece);
          if (reveal < 1) self._focusAnim = true;
          nL = self._neighborReveal(tile, 0, -1);
          nR = self._neighborReveal(tile, 0, 1);
          nU = self._neighborReveal(tile, -1, 0);
          nD = self._neighborReveal(tile, 1, 0);
        }
        if (loc.reveal) gl.uniform1f(loc.reveal, reveal);
        if (loc.cu) gl.uniform1f(loc.cu, (tile.srcX + tile.srcW / 2) / spanW);
        if (loc.cv) gl.uniform1f(loc.cv, (tile.srcY + tile.srcH / 2) / spanH);
        if (loc.halfU) gl.uniform1f(loc.halfU, Math.max(tile.srcW / spanW / 2, 1e-4));
        if (loc.halfV) gl.uniform1f(loc.halfV, Math.max(tile.srcH / spanH / 2, 1e-4));
        if (loc.nL) gl.uniform1f(loc.nL, nL);
        if (loc.nR) gl.uniform1f(loc.nR, nR);
        if (loc.nU) gl.uniform1f(loc.nU, nU);
        if (loc.nD) gl.uniform1f(loc.nD, nD);
        gl.uniform1i(loc.tex, 0);
        bindTex(gl, gl.TEXTURE0, tex);
        self._drawPatch(gl, tile, spanW, spanH);
      }
    }
    this._focusAnim = false;
    gl.disable(gl.BLEND);
    if (paintBase) {
      var baseEntry = this._showingEntry();
      paint([basePiece], (baseEntry && baseEntry.width) || this._tileW || 1, (baseEntry && baseEntry.height) || this._tileH || 1, 1, false);
    }
    if (oldDrawable.length && alphas.oldAlpha > 0) {
      if (alphas.oldAlpha < 0.999) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      }
      paint(oldDrawable, this._fadeW || this._tileW || 1, this._fadeH || this._tileH || 1, alphas.oldAlpha, false);
      gl.disable(gl.BLEND);
    }
    if (drawable.length && alphas.newAlpha > 0.001) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      paint(drawable, this._tileW || 1, this._tileH || 1, alphas.newAlpha, true);
      gl.disable(gl.BLEND);
    }
    if (this._snapOn && this._snapTex) {
      var cover = snapAlphas(this._snapMs, this._snapFadeMs || SNAP_FADE_MS, !!(this._snapReveal && drawable.length));
      if (cover.snapAlpha > 0.001) this._drawSnap(gl, cover.snapAlpha);
    } else if (this._presented || drawable.length || paintBase) {
      this._copySnapshot();
    }
    this._presented = true;
    gl.useProgram(this._prog);
  };

  Player.prototype.draw = function () {
    if (this._holdFrame && !this._snapOn) return;
    resize(this.canvas);
    if (this._mode === "webgl" && this._gl) this._drawGl();
    else this._draw2d();
    if (!this._snapOn && this._tileDraw && this._tileDraw.length) {
      this._snapHave = true;
      this._snapYaw = this.yaw;
    }
  };

  Player.prototype._drawGl = function () {
    if (this._useTiles) {
      this._drawTiles();
      return;
    }
    var gl = this._gl;
    var w = this.canvas.width;
    var h = this.canvas.height;
    gl.useProgram(this._prog);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    fillPerspective(this._proj, this.fov, w / Math.max(h, 1), 0.05, 20);
    fillAimView(this._m0, this._m1, this._m2, this._view, this.yaw, this.pitch, this.roll);
    multiplyInto(this._mvp, this._proj, this._view);
    gl.uniformMatrix4fv(this._loc.mvp, false, this._mvp);
    gl.uniform1f(this._loc.fade, this.fade);
    var from = this.phase === "fade" ? this.fromIndex : this.index;
    var fromPose = this.poses[from] || ZERO_POSE;
    var toPose = this.poses[this.index] || ZERO_POSE;
    gl.uniform1f(this._loc.pitchA, fromPose.pitch);
    gl.uniform1f(this._loc.rollA, fromPose.roll);
    gl.uniform1f(this._loc.pitchB, toPose.pitch);
    gl.uniform1f(this._loc.rollB, toPose.roll);
    gl.uniform1i(this._loc.a, 0);
    gl.uniform1i(this._loc.b, 1);
    bindTex(gl, gl.TEXTURE0, this._tex[from] || this._blank);
    bindTex(gl, gl.TEXTURE1, this._tex[this.index] || this._blank);
    this._drawMesh(gl);
  };

  Player.prototype._draw2d = function () {
    var ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    var w = this.canvas.width || 960;
    var h = this.canvas.height || 540;
    ctx.fillStyle = "#0b0d10";
    ctx.fillRect(0, 0, w, h);
    if (this._useTiles) return;
    var from = this.images[this.phase === "fade" ? this.fromIndex : this.index];
    var to = this.images[this.index];
    drawStrip(ctx, from, this.yaw, this.pitch, this.fov, w, h, 1);
    if (this.fade > 0 && to) {
      ctx.globalAlpha = this.fade;
      drawStrip(ctx, to, this.yaw, this.pitch, this.fov, w, h, 1);
      ctx.globalAlpha = 1;
    }
  };

  Player.prototype._drawPatch = function (gl, tile, spanW, spanH) {
    if (!gl || !tile) {
      this._drawMesh(gl);
      return;
    }
    if (!this._patchCache) this._patchCache = {};
    var key = tile._patchKey;
    if (!key || tile._patchSpan !== spanW) {
      key = String(tile.id || tile.srcX) + ":" + tile.srcX + ":" + tile.srcY + ":" + spanW + ":" + spanH;
      tile._patchKey = key;
      tile._patchSpan = spanW;
    }
    var cached = this._patchCache[key];
    if (!cached) {
      var mesh = tilePatch(tile, spanW, spanH);
      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.interleaved, gl.STATIC_DRAW);
      var ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      cached = { buf: buf, ib: ib, count: mesh.count };
      this._patchCache[key] = cached;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, cached.buf);
    var prog = this._tileProg;
    var pos = gl.getAttribLocation(prog, "aPos");
    if (pos >= 0) {
      gl.enableVertexAttribArray(pos);
      gl.vertexAttribPointer(pos, 3, gl.FLOAT, false, 20, 0);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, cached.ib);
    gl.drawElements(gl.TRIANGLES, cached.count, gl.UNSIGNED_SHORT, 0);
  };

  Player.prototype._stripRows = function (width) {
    var ms = this._uploadMsPerMb || 8;
    var bytes = UPLOAD_BUDGET_MS / Math.max(ms, 0.05) * 1024 * 1024;
    var rows = Math.floor(bytes / Math.max((width || 1) * 4, 1));
    if (rows < 8) rows = 8;
    if (rows > 64) rows = 64;
    return rows;
  };

  Player.prototype._beginStrip = function (gl, tex, source) {
    if (!gl || !tex || !source || !source.width || !source.height) return false;
    if (!gl.texSubImage2D || typeof document === "undefined") return false;
    var rows = this._stripRows(source.width);
    if (source.height <= rows) return false;
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, source.width, source.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    } catch (error) {
      return false;
    }
    tex._uploadW = source.width;
    tex._uploadH = source.height;
    tex._mip = false;
    this._strip = { gl: gl, tex: tex, source: source, y: 0, rows: rows, w: source.width, h: source.height };
    this._uploadStripSlice();
    return !!this._strip || tex._mip === true;
  };

  Player.prototype._uploadStripSlice = function () {
    var job = this._strip;
    if (!job) return;
    var rows = Math.min(job.rows, job.h - job.y);
    if (!this._stripCanvas) this._stripCanvas = document.createElement("canvas");
    if (this._stripCanvas.width !== job.w) this._stripCanvas.width = job.w;
    if (this._stripCanvas.height !== rows) this._stripCanvas.height = rows;
    var ctx = this._stripCanvas.getContext("2d");
    if (!ctx) {
      this._strip = null;
      return;
    }
    ctx.drawImage(job.source, 0, job.y, job.w, rows, 0, 0, job.w, rows);
    job.gl.bindTexture(job.gl.TEXTURE_2D, job.tex);
    job.gl.texSubImage2D(job.gl.TEXTURE_2D, 0, 0, job.y, job.gl.RGBA, job.gl.UNSIGNED_BYTE, this._stripCanvas);
    job.y += rows;
    if (job.y < job.h) return;
    var tex = job.tex;
    var source = job.source;
    var done = job.done;
    this._strip = null;
    this._finishSampler(job.gl, tex, job.w, job.h, source);
    if (done) done(tex);
  };

  Player.prototype._uploadExplicitMips = function (gl, levels) {
    if (!gl || !levels || levels.length < 2) return false;
    for (var level = 1; level < levels.length; level++) {
      var mip = levels[level];
      if (!mip || !mip.width || !mip.height) return false;
      try {
        gl.texImage2D(gl.TEXTURE_2D, level, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mip);
      } catch (error) {
        warn("mip upload skipped", error && error.message);
        return false;
      }
    }
    return true;
  };

  Player.prototype._installQuad = function (gl) {
    var vs = this._webgl2
      ? "#version 300 es\nin vec2 aPos;in vec2 aUv;out vec2 vUv;void main(){vUv=aUv;gl_Position=vec4(aPos,0.0,1.0);}"
      : "attribute vec2 aPos;attribute vec2 aUv;varying vec2 vUv;void main(){vUv=aUv;gl_Position=vec4(aPos,0.0,1.0);}";
    var fs = this._webgl2
      ? "#version 300 es\nprecision mediump float;uniform sampler2D uTex;uniform float uAlpha;in vec2 vUv;out vec4 o;void main(){o=texture(uTex,vUv);o.a*=uAlpha;}"
      : "precision mediump float;uniform sampler2D uTex;uniform float uAlpha;varying vec2 vUv;void main(){gl_FragColor=texture2D(uTex,vUv);gl_FragColor.a*=uAlpha;}";
    var prog = compileProgram(gl, vs, fs);
    if (!prog) return;
    this._quadProg = prog;
    this._quadLoc = {
      tex: gl.getUniformLocation(prog, "uTex"),
      alpha: gl.getUniformLocation(prog, "uAlpha"),
    };
    this._quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 0,
      1, -1, 1, 0,
      -1, 1, 0, 1,
      1, 1, 1, 1,
    ]), gl.STATIC_DRAW);
  };

  Player.prototype._drawSnap = function (gl, alpha) {
    if (!gl || !this._quadProg || !this._snapTex || !(alpha > 0)) return;
    gl.useProgram(this._quadProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf);
    var pos = gl.getAttribLocation(this._quadProg, "aPos");
    var uv = gl.getAttribLocation(this._quadProg, "aUv");
    if (pos >= 0) {
      gl.enableVertexAttribArray(pos);
      gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 16, 0);
    }
    if (uv >= 0) {
      gl.enableVertexAttribArray(uv);
      gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 16, 8);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(this._quadLoc.alpha, alpha);
    gl.uniform1i(this._quadLoc.tex, 0);
    bindTex(gl, gl.TEXTURE0, this._snapTex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND);
  };

  Player.prototype._copySnapshot = function () {
    var gl = this._gl;
    if (!gl) {
      this._snapHave = true;
      return;
    }
    var w = Math.min(gl.drawingBufferWidth || this.canvas.width || SNAP_W, SNAP_W);
    var h = Math.min(gl.drawingBufferHeight || this.canvas.height || SNAP_H, SNAP_H);
    if (w < 2 || h < 2) return;
    if (!this._snapTex || this._snapW !== w || this._snapH !== h) {
      if (this._snapTex) gl.deleteTexture(this._snapTex);
      this._snapTex = gl.createTexture();
      this._snapW = w;
      this._snapH = h;
      gl.bindTexture(gl.TEXTURE_2D, this._snapTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this._snapTex);
    }
    try {
      gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, w, h, 0);
      this._snapBytes = w * h * 4;
      this._snapCopies = (this._snapCopies || 0) + 1;
      this._snapHave = true;
      this._snapYaw = this.yaw;
    } catch (error) {
      this._snapHave = true;
    }
  };

  Player.prototype._measureUpload = function (gl) {
    if (!gl) return;
    var w = 64;
    var h = 64;
    var pixels = new Uint8Array(w * h * 4);
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    var t0 = nowMs();
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      if (gl.finish) gl.finish();
    } catch (error) {
      gl.deleteTexture(tex);
      return;
    }
    var ms = Math.max(0.01, nowMs() - t0);
    var mb = (w * h * 4) / (1024 * 1024);
    this._uploadMsPerMb = ms / mb;
    gl.deleteTexture(tex);
  };

  function copyOverview(overview) {
    if (!overview || overview.id == null) return null;
    var url = httpUrl(overview.url || "");
    return {
      id: String(overview.id).slice(0, 160),
      url: url,
      texW: num(overview.texW, BASE_W) || BASE_W,
      texH: num(overview.texH, BASE_H) || BASE_H,
    };
  }

  function copyTiles(list) {
    if (!list || !list.length) return null;
    var out = [];
    for (var i = 0; i < list.length && out.length < 256; i++) {
      var tile = list[i];
      if (!tile || tile.id == null) continue;
      out.push({
        id: String(tile.id).slice(0, 160),
        url: httpUrl(tile.url || ""),
        col: num(tile.col, 0),
        row: num(tile.row, 0),
        srcX: num(tile.srcX, 0),
        srcY: num(tile.srcY, 0),
        srcW: num(tile.srcW, 0),
        srcH: num(tile.srcH, 0),
        padL: num(tile.padL, 0),
        padR: num(tile.padR, 0),
        padT: num(tile.padT, 0),
        padB: num(tile.padB, 0),
        texW: num(tile.texW, 0),
        texH: num(tile.texH, 0),
        mipCount: num(tile.mipCount, 0),
      });
    }
    return out.length ? out : null;
  }

  function normalizeEntries(list) {
    var out = [];
    if (!list) return out;
    for (var i = 0; i < list.length && out.length < 40; i++) {
      var item = list[i];
      if (typeof item === "string") {
        var asUrl = httpUrl(item);
        if (!asUrl) continue;
        out.push({ id: asUrl, url: asUrl, posePitch: 0, poseRoll: 0 });
      } else if (item && item.url) {
        var url = httpUrl(item.url);
        if (!url) continue;
        out.push({
          id: item.id != null ? String(item.id).slice(0, 160) : url,
          url: url,
          posePitch: num(item.posePitch, 0),
          poseRoll: num(item.poseRoll, 0),
          width: num(item.width, 0),
          height: num(item.height, 0),
          tiles: copyTiles(item.tiles),
          overview: copyOverview(item.overview),
        });
      }
    }
    return out;
  }

  function stepIndex(index, count, delta, loops) {
    if (count <= 1 || !delta) return null;
    var raw = index + delta;
    if (loops) return ((raw % count) + count) % count;
    if (raw < 0 || raw >= count) return null;
    return raw;
  }

  function decodeSkip(buffer) {
    if (!buffer) return null;
    var length = buffer.byteLength != null ? buffer.byteLength : buffer.length;
    if (!length || length < 8 || length > 256) return null;
    var view = new DataView(buffer.buffer || buffer, buffer.byteOffset || 0, length);
    if (view.getUint8(0) !== 3) return null;
    var dir = view.getUint8(1);
    if (dir === 1) return 1;
    if (dir === 2) return -1;
    return null;
  }

  function decodeAim(buffer) {
    if (!buffer || buffer.byteLength < 32 || buffer.byteLength > 256) return null;
    var view = new DataView(buffer.buffer || buffer, buffer.byteOffset || 0, buffer.byteLength || buffer.length);
    if (view.getUint8(0) !== 1) return null;
    var sample = {
      seq: view.getUint32(4, true),
      yaw: view.getFloat32(8, true),
      pitch: view.getFloat32(12, true),
      roll: view.getFloat32(16, true),
      fov: view.getFloat32(20, true),
      ts: view.getFloat64(24, true),
      anchor: (view.getUint8(1) & 1) !== 0,
    };
    if (!isFinite(sample.yaw) || !isFinite(sample.pitch) || !isFinite(sample.roll) || !isFinite(sample.fov)) return null;
    return sample;
  }

  var MAX_MESSAGE_CHARS = 2 * 1024 * 1024;
  var MAX_BINARY = 64 * 1024;
  var MESSAGE_TYPES = {
    queue: 1, append: 1, remove: 1, move: 1, goto: 1,
    play: 1, pause: 1, next: 1, previous: 1, stop: 1,
    heartbeat: 1, speed: 1, aim: 1, chunk: 1, fetchError: 1,
    retile: 1, fov: 1, pace: 1, fade: 1, hello: 1, debug: 1,
  };

  function acceptAimSocket(url) {
    if (typeof url !== "string" || url.length > 300) return "";
    var match = /^(ws|wss):\/\/(\[[0-9a-fA-F:]+\]|[^\/\s@:]+)(:\d{1,5})?(\/c\/[0-9a-fA-F]{16,64}\/aim)$/.exec(url);
    if (!match) return "";
    var host = match[2];
    var ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    var ipv6 = /^\[[0-9a-fA-F:]+\]$/.test(host);
    if (host !== "localhost" && !ipv4 && !ipv6) return "";
    if (ipv4) {
      var parts = host.split(".");
      for (var i = 0; i < parts.length; i++) {
        if (parseInt(parts[i], 10) > 255) return "";
      }
    }
    if (match[3]) {
      var port = parseInt(match[3].slice(1), 10);
      if (!(port > 0 && port < 65536)) return "";
    }
    return url;
  }

  function acceptCastMessage(msg) {
    if (msg == null) return null;
    if (typeof msg === "string") {
      if (msg.length > MAX_MESSAGE_CHARS) return null;
      try { msg = JSON.parse(msg); } catch (e) { return null; }
    }
    if (Object.prototype.toString.call(msg) === "[object ArrayBuffer]") {
      if (msg.byteLength > MAX_BINARY) return null;
      return msg;
    }
    if (typeof msg !== "object" || typeof msg.type !== "string" || !MESSAGE_TYPES[msg.type]) return null;
    if (msg.ws != null && msg.ws !== "") {
      var socket = acceptAimSocket(msg.ws);
      if (!socket) return null;
      msg = Object.assign({}, msg, { ws: socket });
    }
    if ((msg.type === "queue" || msg.type === "append") && msg.items && msg.items.length > 40) {
      msg = Object.assign({}, msg, { items: msg.items.slice(0, 40) });
    }
    return msg;
  }

  var ZERO_POSE = { pitch: 0, roll: 0 };

  function poseOf(entry) {
    return {
      pitch: (Number(entry.posePitch) || 0) * Math.PI / 180,
      roll: (Number(entry.poseRoll) || 0) * Math.PI / 180,
    };
  }

  function applyPose(dir, pitchRad, rollRad) {
    var x = dir[0];
    var y = dir[1];
    var z = dir[2];
    if (!pitchRad && !rollRad) return [x, y, z];
    var nx = x;
    var ny = -z;
    var nz = y;
    var cp = Math.cos(pitchRad);
    var sp = Math.sin(pitchRad);
    var cr = Math.cos(rollRad);
    var sr = Math.sin(rollRad);
    var py = cp * ny + sp * nz;
    var pz = -sp * ny + cp * nz;
    var cx = cr * nx - sr * pz;
    var cy = py;
    var cz = sr * nx + cr * pz;
    return [cx, cz, -cy];
  }

  function needsCors(url) {
    try {
      var abs = new URL(url, window.location.href);
      if (abs.protocol === "data:" || abs.protocol === "blob:") return false;
      return abs.origin !== window.location.origin;
    } catch (e) {
      return true;
    }
  }

  function drawStrip(ctx, img, yaw, pitch, fov, w, h, alpha) {
    if (!img || !img.width) return;
    var fovFrac = fov / 360;
    var center = ((0.5 + yaw / 360) % 1 + 1) % 1;
    var srcW = img.width * fovFrac;
    var srcX = center * img.width - srcW / 2;
    var aspect = w / Math.max(h, 1);
    var vFrac = (fov / aspect) / 180;
    var centerV = 0.5 - pitch / 180;
    var srcH = img.height * vFrac;
    var srcY = centerV * img.height - srcH / 2;
    if (srcY < 0) srcY = 0;
    if (srcY + srcH > img.height) srcY = Math.max(0, img.height - srcH);
    ctx.save();
    ctx.globalAlpha = alpha;
    if (srcX < 0) {
      ctx.drawImage(img, img.width + srcX, srcY, -srcX, srcH, 0, 0, (-srcX / srcW) * w, h);
      ctx.drawImage(img, 0, srcY, srcW + srcX, srcH, (-srcX / srcW) * w, 0, ((srcW + srcX) / srcW) * w, h);
    } else if (srcX + srcW > img.width) {
      var left = img.width - srcX;
      ctx.drawImage(img, srcX, srcY, left, srcH, 0, 0, (left / srcW) * w, h);
      ctx.drawImage(img, 0, srcY, srcW - left, srcH, (left / srcW) * w, 0, ((srcW - left) / srcW) * w, h);
    } else {
      ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, w, h);
    }
    ctx.restore();
  }

  function resize(canvas) {
    var dpr = (root.devicePixelRatio || 1);
    var screenW = root.screen && root.screen.width;
    var screenH = root.screen && root.screen.height;
    var size = backingStoreSize(canvas.clientWidth, canvas.clientHeight, dpr, screenW, screenH);
    if (canvas.width !== size.width || canvas.height !== size.height) {
      canvas.width = size.width;
      canvas.height = size.height;
    }
  }

  function backingStoreSize(clientW, clientH, dpr, screenW, screenH) {
    var density = Number(dpr) || 1;
    if (density < 1) density = 1;
    var w = clientW > 1 ? clientW : (screenW > 1 ? screenW : OUTPUT_W);
    var h = clientH > 1 ? clientH : (screenH > 1 ? screenH : OUTPUT_H);
    var bw = Math.round(w * (clientW > 1 ? density : 1));
    var bh = Math.round(h * (clientH > 1 ? density : 1));
    if (bw > OUTPUT_W) bw = OUTPUT_W;
    if (bh > OUTPUT_H) bh = OUTPUT_H;
    if (bw < 2) bw = OUTPUT_W;
    if (bh < 2) bh = OUTPUT_H;
    return { width: bw, height: bh };
  }

  function bindTex(gl, unit, tex) {
    gl.activeTexture(unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  function sphere(latBands, lonBands, useUint32) {
    var pos = [];
    var ind = [];
    for (var lat = 0; lat <= latBands; lat++) {
      var v = lat / latBands;
      for (var lon = 0; lon <= lonBands; lon++) {
        var u = lon / lonBands;
        var latRad = (0.5 - v) * Math.PI;
        var lonRad = (u - 0.5) * Math.PI * 2;
        var cosLat = Math.cos(latRad);
        pos.push(Math.sin(lonRad) * cosLat, Math.sin(latRad), -Math.cos(lonRad) * cosLat, u, v);
      }
    }
    for (var y = 0; y < latBands; y++) {
      for (var x = 0; x < lonBands; x++) {
        var a = y * (lonBands + 1) + x;
        var b = a + lonBands + 1;
        ind.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    return {
      interleaved: new Float32Array(pos),
      indices: useUint32 ? new Uint32Array(ind) : new Uint16Array(ind),
      count: ind.length,
    };
  }

  function isPow2(n) {
    n = n | 0;
    return n > 0 && (n & (n - 1)) === 0;
  }

  function nextPow2(n) {
    n = Math.max(1, n | 0);
    var v = 1;
    while (v < n && v > 0) v <<= 1;
    return v > 0 ? v : n;
  }

  function potSize(w, h) {
    return { w: nextPow2(w), h: nextPow2(h) };
  }

  function potPadSource(source) {
    if (!source || !source.width || !source.height) return null;
    var w = source.width;
    var h = source.height;
    var pw = nextPow2(w);
    var ph = nextPow2(h);
    if (pw === w && ph === h) return source;
    if (typeof document === "undefined" || !document.createElement) return null;
    var canvas = document.createElement("canvas");
    canvas.width = pw;
    canvas.height = ph;
    var ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(source, 0, 0, w, h, 0, 0, w, h);
    if (pw > w) ctx.drawImage(source, w - 1, 0, 1, h, w, 0, pw - w, h);
    if (ph > h) ctx.drawImage(canvas, 0, h - 1, pw, 1, 0, h, pw, ph - h);
    return canvas;
  }

  function fragmentPrecision(gl) {
    if (!gl.getShaderPrecisionFormat) return "highp";
    var fmt = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    if (fmt && fmt.precision > 0) return "highp";
    return "mediump";
  }

  function tileFragment(webgl2, precision, grad, vary, outDecl, color, pose) {
    var prec = precision === "mediump" ? "mediump" : "highp";
    var head = webgl2 ? "#version 300 es\nprecision highp float;\n" : "precision " + prec + " float;\n";
    var useGrad = webgl2 || grad;
    if (!webgl2 && grad) {
      head = "#extension GL_OES_standard_derivatives : enable\n" +
        "#extension GL_EXT_shader_texture_lod : enable\n" + head;
    }
    var sampleExpr = webgl2 ? "textureGrad(uTex,st,dstDx,dstDy)" : "texture2DGradEXT(uTex,st,dstDx,dstDy)";
    var body = useGrad
      ? "  vec3 dir=poseToCamera(normalize(vObj),uPitch,uRoll);\n" +
        "  float lon=length(dir.xz)<1e-5?0.0:atan(dir.x,-dir.z);\n" +
        "  float lat=asin(clamp(dir.y,-1.0,1.0));\n" +
        "  float u=fract(0.5+lon/TWO_PI);\n" +
        "  float v=clamp(0.5-lat/PI,0.0,1.0);\n" +
        "  if(uKind>0.5){\n" +
        "    vec2 ost=vec2(u,clamp(v,0.5/max(uTexH,1.0),1.0-0.5/max(uTexH,1.0)));\n" +
        "    " + color + "=overviewColor(ost);\n" +
        "    if(uDebug>0.5)" + color + ".rgb*=vec3(0.45,0.62,1.0);\n" +
        "    " + color + ".a*=uAlpha;\n" +
        "  } else {\n" +
        "  float spanU=max(uU1-uU0,1e-6);\n" +
        "  float spanV=max(uV1-uV0,1e-6);\n" +
        "  float sx=(u-uU0)/spanU;\n" +
        "  float sy=(v-uV0)/spanV;\n" +
        "  float dLonX=dFdx(lon);float dLonY=dFdy(lon);\n" +
        "  dLonX=mod(dLonX+PI,TWO_PI)-PI;\n" +
        "  dLonY=mod(dLonY+PI,TWO_PI)-PI;\n" +
        "  float dLatX=dFdx(lat);float dLatY=dFdy(lat);\n" +
        "  float kx=(uSrcW/max(uTexW,1.0))/spanU/TWO_PI;\n" +
        "  float ky=-(uSrcH/max(uTexH,1.0))/spanV/PI;\n" +
        "  vec2 dstDx=vec2(kx*dLonX,ky*dLatX);\n" +
        "  vec2 dstDy=vec2(kx*dLonY,ky*dLatY);\n" +
        "  vec2 st=vec2((uPadL+sx*uSrcW)/max(uTexW,1.0),(uPadT+sy*uSrcH)/max(uTexH,1.0));\n" +
        "  float padR=max(uTexW-uPadL-uSrcW,0.0);\n" +
        "  float padB=max(uTexH-uPadT-uSrcH,0.0);\n" +
        "  float roomX=max(min(uPadL,padR),0.5);\n" +
        "  float roomY=max(min(uPadT,padB),0.5);\n" +
        "  float texelX=st.x*uTexW;float texelY=st.y*uTexH;\n" +
        "  roomX=min(roomX,max(min(texelX,uTexW-texelX),0.5));\n" +
        "  roomY=min(roomY,max(min(texelY,uTexH-texelY),0.5));\n" +
        "  vec2 tdx=dstDx*vec2(uTexW,uTexH);\n" +
        "  vec2 tdy=dstDy*vec2(uTexW,uTexH);\n" +
        "  float extX=max(abs(tdx.x),abs(tdy.x));\n" +
        "  float extY=max(abs(tdx.y),abs(tdy.y));\n" +
        "  float lim=min(extX>roomX?roomX/max(extX,1e-6):1.0,extY>roomY?roomY/max(extY,1e-6):1.0);\n" +
        "  dstDx*=lim;dstDy*=lim;\n" +
        "  vec2 halfTex=vec2(0.5/max(uTexW,1.0),0.5/max(uTexH,1.0));\n" +
        "  st=clamp(st,halfTex,vec2(1.0)-halfTex);\n" +
        "  float edgePx=min(min(sx,1.0-sx)*uSrcW,min(sy,1.0-sy)*uSrcH);\n" +
        "  if(edgePx<3.0) " + color + "=" + sampleExpr + ";\n" +
        "  else " + color + "=" + (webgl2 ? "texture" : "texture2D") + "(uTex,st);\n" +
        "  " + color + ".a*=uAlpha*focusMask(u,v);\n" +
        "  float slopU=0.5*spanU/max(uSrcW,1.0);\n" +
        "  float slopV=0.5*spanV/max(uSrcH,1.0);\n" +
        "  if(uDebug>0.5)" + color + ".rgb*=vec3(1.05,0.78,0.42);\n" +
        "  if(u<uU0-slopU||u>uU1+slopU||v<uV0-slopV||v>uV1+slopV) discard;\n" +
        "  }\n"
      : "  vec2 uv=equirectUv(poseToCamera(normalize(vObj),uPitch,uRoll));\n" +
        "  if(uKind>0.5){\n" +
        "    vec2 ost=vec2(uv.x,clamp(uv.y,0.5/max(uTexH,1.0),1.0-0.5/max(uTexH,1.0)));\n" +
        "    " + color + "=overviewColor(ost);\n" +
        "    if(uDebug>0.5)" + color + ".rgb*=vec3(0.45,0.62,1.0);\n" +
        "    " + color + ".a*=uAlpha;\n" +
        "  } else {\n" +
        "  float spanU=max(uU1-uU0,1e-6);\n" +
        "  float spanV=max(uV1-uV0,1e-6);\n" +
        "  float sx=(uv.x-uU0)/spanU;\n" +
        "  float sy=(uv.y-uV0)/spanV;\n" +
        "  vec2 st=vec2((uPadL+sx*uSrcW)/max(uTexW,1.0),(uPadT+sy*uSrcH)/max(uTexH,1.0));\n" +
        "  vec2 halfTex=vec2(0.5/max(uTexW,1.0),0.5/max(uTexH,1.0));\n" +
        "  st=clamp(st,halfTex,vec2(1.0)-halfTex);\n" +
        "  " + color + "=" + (webgl2 ? "texture" : "texture2D") + "(uTex,st);\n" +
        "  " + color + ".a*=uAlpha*focusMask(uv.x,uv.y);\n" +
        "  float slopU=0.5*spanU/max(uSrcW,1.0);\n" +
        "  float slopV=0.5*spanV/max(uSrcH,1.0);\n" +
        "  if(uDebug>0.5)" + color + ".rgb*=vec3(1.05,0.78,0.42);\n" +
        "  if(uv.x<uU0-slopU||uv.x>uU1+slopU||uv.y<uV0-slopV||uv.y>uV1+slopV) discard;\n" +
        "  }\n";
    return head + vary + " vec3 vObj;\n" + outDecl +
      "uniform sampler2D uTex;\n" +
      "uniform float uPitch;uniform float uRoll;uniform float uAlpha;\n" +
      "uniform float uU0;uniform float uU1;uniform float uV0;uniform float uV1;\n" +
      "uniform float uPadL;uniform float uPadT;uniform float uSrcW;uniform float uSrcH;uniform float uTexW;uniform float uTexH;\n" +
      "uniform float uKind;uniform float uDebug;\n" +
      "uniform float uReveal;uniform float uCu;uniform float uCv;uniform float uHalfU;uniform float uHalfV;\n" +
      "uniform float uNL;uniform float uNR;uniform float uNU;uniform float uND;\n" +
      "vec4 overviewColor(vec2 ost){\n" +
      "  vec2 px=vec2(1.5/max(uTexW,1.0),1.5/max(uTexH,1.0));\n" +
      "  vec4 c=" + (webgl2 ? "texture" : "texture2D") + "(uTex,ost)*0.36;\n" +
      "  c+=" + (webgl2 ? "texture" : "texture2D") + "(uTex,ost+vec2(px.x,0.0))*0.16;\n" +
      "  c+=" + (webgl2 ? "texture" : "texture2D") + "(uTex,ost+vec2(-px.x,0.0))*0.16;\n" +
      "  c+=" + (webgl2 ? "texture" : "texture2D") + "(uTex,ost+vec2(0.0,px.y))*0.16;\n" +
      "  c+=" + (webgl2 ? "texture" : "texture2D") + "(uTex,ost+vec2(0.0,-px.y))*0.16;\n" +
      "  return c;\n" +
      "}\n" +
      "float focusMask(float su,float sv){\n" +
      "  float du=su-uCu;du=mod(du+0.5,1.0)-0.5;float dv=sv-uCv;\n" +
      "  float dist=sqrt(pow(du/max(uHalfU,1e-4),2.0)+pow(dv/max(uHalfV,1e-4),2.0));\n" +
      "  float radius=uReveal*3.4;float feather=1.7;\n" +
      "  float inner=radius-feather;float outer=radius+feather;\n" +
      "  float fx=clamp((dist-inner)/max(outer-inner,1e-4),0.0,1.0);\n" +
      "  float herm=fx*fx*(3.0-2.0*fx);\n" +
      "  float radial=(1.0-herm)*smoothstep(0.02,0.2,uReveal);\n" +
      "  float sx=clamp((su-uU0)/max(uU1-uU0,1e-4),0.0,1.0);\n" +
      "  float sy=clamp((sv-uV0)/max(uV1-uV0,1e-4),0.0,1.0);\n" +
      "  float eL=mix(smoothstep(0.0,0.46,sx),1.0,uNL);\n" +
      "  float eR=mix(smoothstep(0.0,0.46,1.0-sx),1.0,uNR);\n" +
      "  float eU=mix(smoothstep(0.0,0.46,sy),1.0,uNU);\n" +
      "  float eD=mix(smoothstep(0.0,0.46,1.0-sy),1.0,uND);\n" +
      "  float mask=radial*eL*eR*eD*eU;\n" +
      "  float done=smoothstep(0.9,1.0,uReveal)*min(min(uNL,uNR),min(uND,uNU));\n" +
      "  return mix(mask,1.0,done);\n" +
      "}\n" +
      "const float PI=3.141592653589793;const float TWO_PI=6.283185307179586;\n" +
      pose + "\nvoid main(){\n" + body + "}";
  }

  function glSources(webgl2, precision, grad) {
    var prec = precision === "mediump" ? "mediump" : "highp";
    var sample = webgl2 ? "texture" : "texture2D";
    var vary = webgl2 ? "in" : "varying";
    var head = webgl2 ? "#version 300 es\nprecision highp float;\n" : "precision " + prec + " float;\n";
    var outDecl = webgl2 ? "out vec4 fragColor;\n" : "";
    var color = webgl2 ? "fragColor" : "gl_FragColor";
    var pose = [
      "vec3 poseToCamera(vec3 v,float pitch,float roll){",
      "  vec3 n=vec3(v.x,-v.z,v.y);",
      "  float cp=cos(pitch);float sp=sin(pitch);float cr=cos(roll);float sr=sin(roll);",
      "  vec3 p=vec3(n.x,cp*n.y+sp*n.z,-sp*n.y+cp*n.z);",
      "  vec3 c=vec3(cr*p.x-sr*p.z,p.y,sr*p.x+cr*p.z);",
      "  return vec3(c.x,c.z,-c.y);",
      "}",
      "vec2 equirectUv(vec3 d){",
      "  float lon=length(d.xz)<1e-5?0.0:atan(d.x,-d.z);",
      "  float lat=asin(clamp(d.y,-1.0,1.0));",
      "  return vec2(fract(0.5+lon/TWO_PI),clamp(0.5-lat/PI,0.0,1.0));",
      "}",
    ].join("\n");
    var vsIn = webgl2 ? "in" : "attribute";
    var vsOut = webgl2 ? "out" : "varying";
    var version = webgl2 ? "#version 300 es\n" : "";
    return {
      vs: version + vsIn + " vec3 aPos;" + vsIn + " vec2 aUv;uniform mat4 uMvp;" + vsOut + " vec3 vObj;void main(){vObj=aPos;gl_Position=uMvp*vec4(aPos,1.0);}",
      fs: head + vary + " vec3 vObj;\n" + outDecl +
        "uniform sampler2D uA;uniform sampler2D uB;uniform float uFade;\n" +
        "uniform float uPitchA;uniform float uRollA;uniform float uPitchB;uniform float uRollB;\n" +
        "const float PI=3.141592653589793;const float TWO_PI=6.283185307179586;\n" +
        pose + "\nvoid main(){\n" +
        "  vec3 dir=normalize(vObj);\n" +
        "  vec4 a=" + sample + "(uA,equirectUv(poseToCamera(dir,uPitchA,uRollA)));\n" +
        "  vec4 b=" + sample + "(uB,equirectUv(poseToCamera(dir,uPitchB,uRollB)));\n" +
        "  " + color + "=mix(a,b,uFade);\n" +
        "  if(" + color + ".a<0.05)" + color + "=vec4(0.04,0.05,0.07,1.0);\n" +
        "}",
      tileVs: version + vsIn + " vec3 aPos;uniform mat4 uMvp;" + vsOut + " vec3 vObj;void main(){vObj=aPos;gl_Position=uMvp*vec4(aPos,1.0);}",
      tileFs: tileFragment(webgl2, precision, grad, vary, outDecl, color, pose),
    };
  }

  function link(gl, vsSrc, fsSrc) {
    function sh(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) warn("shader", gl.getShaderInfoLog(s));
      return s;
    }
    var p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    return p;
  }

  function compileProgram(gl, vsSrc, fsSrc) {
    var prog = link(gl, vsSrc, fsSrc);
    if (!prog || !gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      if (prog) {
        warn("shader link", gl.getProgramInfoLog(prog));
        gl.deleteProgram(prog);
      }
      return null;
    }
    return prog;
  }

  function fillPerspective(out, fovDeg, aspect, near, far) {
    var f = 1 / Math.tan((fovDeg * Math.PI / 180) / 2);
    var nf = 1 / (near - far);
    out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = (far + near) * nf; out[11] = -1;
    out[12] = 0; out[13] = 0; out[14] = 2 * far * near * nf; out[15] = 0;
  }

  function fillYaw(out, yawDeg) {
    var a = -yawDeg * Math.PI / 180;
    var c = Math.cos(a);
    var s = Math.sin(a);
    out[0] = c; out[1] = 0; out[2] = s; out[3] = 0;
    out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
    out[8] = -s; out[9] = 0; out[10] = c; out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
  }

  function fillPitch(out, pitchDeg) {
    var c = Math.cos(pitchDeg * Math.PI / 180);
    var s = Math.sin(pitchDeg * Math.PI / 180);
    out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = c; out[6] = -s; out[7] = 0;
    out[8] = 0; out[9] = s; out[10] = c; out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
  }

  function fillRoll(out, rollDeg) {
    var c = Math.cos(rollDeg * Math.PI / 180);
    var sr = Math.sin(rollDeg * Math.PI / 180);
    out[0] = c; out[1] = -sr; out[2] = 0; out[3] = 0;
    out[4] = sr; out[5] = c; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
  }

  function fillAimView(yawM, pitchM, rollM, out, yawDeg, pitchDeg, rollDeg) {
    fillYaw(yawM, yawDeg);
    fillPitch(pitchM, pitchDeg);
    multiplyInto(out, pitchM, yawM);
    fillRoll(rollM, rollDeg);
    multiplyInto(yawM, rollM, out);
    out.set(yawM);
  }

  function multiplyInto(out, a, b) {
    for (var c = 0; c < 4; c++) {
      var b0 = b[c * 4];
      var b1 = b[c * 4 + 1];
      var b2 = b[c * 4 + 2];
      var b3 = b[c * 4 + 3];
      out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
      out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
      out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
      out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
  }

  function isOom(error) {
    if (!error) return false;
    if (error.oom) return true;
    return /out of memory/i.test(String(error.message || error));
  }

  var decodeWarned = {};

  function noteDecode(message) {
    if (!message || decodeWarned[message]) return;
    decodeWarned[message] = true;
    warn(message);
    try {
      if (root.__castSend) root.__castSend({ type: "log", message: String(message) });
    } catch (error) {}
  }

  function materializeJpeg(payload, done) {
    // Leave this frame before atob. A timer, not a microtask: some Cast
    // WebViews never drain the microtask queue, and that used to freeze
    // every tile after the overview.
    var start = function () { materializeJpegNow(payload, done); };
    if (typeof setTimeout === "function") setTimeout(start, 0);
    else start();
  }

  function materializeJpegNow(payload, done) {
    var settled = false;
    var timer = 0;
    function finish(err, img) {
      if (settled) return;
      settled = true;
      if (timer && typeof clearTimeout === "function") clearTimeout(timer);
      if (img) {
        img.onload = null;
        img.onerror = null;
      }
      done(err, img);
    }
    var bytes;
    try {
      var binary = atob(payload);
      bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 255;
    } catch (error) {
      finish(error);
      return;
    }
    var blob = new Blob([bytes], { type: "image/jpeg" });
    function fallback(why) {
      if (why) noteDecode(why);
      loadImageElement(blob, finish);
    }
    if (typeof createImageBitmap !== "function") {
      loadImageElement(blob, finish);
      return;
    }
    if (typeof setTimeout === "function") {
      timer = setTimeout(function () {
        fallback("TV decode timed out; using the image path");
      }, DECODE_FALLBACK_MS);
    }
    try {
      createImageBitmap(blob).then(function (bitmap) {
        if (settled) {
          try { if (bitmap && bitmap.close) bitmap.close(); } catch (error) {}
          return;
        }
        if (!bitmap || !(bitmap.width > 0) || !(bitmap.height > 0)) {
          try { if (bitmap && bitmap.close) bitmap.close(); } catch (error) {}
          fallback("TV decode returned an empty bitmap; using the image path");
          return;
        }
        finish(null, bitmap);
      }).catch(function () {
        if (settled) return;
        fallback("TV decode failed; using the image path");
      });
    } catch (error) {
      fallback("TV decode failed; using the image path");
    }
  }

  function loadImageElement(blob, finish) {
    try {
      var url = URL.createObjectURL(blob);
      trackUrl(url);
      var img = new Image();
      img.onload = function () {
        revokeUrl(url);
        finish(null, img);
      };
      img.onerror = function () {
        revokeUrl(url);
        finish(new Error("Couldn't open this photo"));
      };
      img.src = url;
    } catch (error) {
      finish(error);
    }
  }

  function PhotoSession(hooks) {
    this.hooks = hooks || {};
    this.generation = 0;
    this.token = 0;
    this.live = [];
    this.loaded = [];
    this.assemblers = {};
    this.entry = null;
    this.tileIndex = 0;
    this.attempt = 0;
    this.pending = null;
    this.waitingShrink = false;
    this.shown = false;
    this.timeoutMs = this.hooks.timeoutMs || 45000;
    this._openTokens = {};
  }

  PhotoSession.prototype._now = function () {
    return this.hooks.now ? this.hooks.now() : Date.now();
  };

  PhotoSession.prototype._releaseAll = function () {
    var release = this.hooks.release;
    if (release) this.live.forEach(release);
    this.live = [];
  };

  PhotoSession.prototype.dispose = function () {
    this.generation += 1;
    this.token += 1;
    this._releaseAll();
    this.loaded = [];
    this.assemblers = {};
    this.pending = null;
    this.entry = null;
    this.waitingShrink = false;
    this.shown = false;
    this._openTokens = {};
    this._overviewPending = false;
    this._overviewReady = false;
  };

  PhotoSession.prototype.open = function (entry) {
    this.dispose();
    this.standby = false;
    this.budgetFull = false;
    this.tileOrder = null;
    this.orderPos = 0;
    this.entry = entry;
    this.tileIndex = 0;
    this.attempt = 0;
    this.loaded = [];
    this.shown = false;
    if (this.hooks.onStatus) this.hooks.onStatus("busy");
    if (!entry || !entry.tiles || !entry.tiles.length) {
      this._failOrRetry("no tiles");
      return;
    }
    if (this.hooks.onEntry) this.hooks.onEntry(entry);
    this._beginOverview();
    this._requestCurrent();
  };

  PhotoSession.prototype.preload = function (entry) {
    if (!entry || !entry.tiles || !entry.tiles.length) return;
    if (this.entry && this.entry.id === entry.id && (this.loaded.length || this.pending)) return;
    this.dispose();
    this.standby = true;
    this.budgetFull = false;
    this.entry = entry;
    this.tileIndex = 0;
    this.orderPos = 0;
    this.attempt = 1;
    this.loaded = [];
    this.shown = false;
    var view = this.hooks.view ? this.hooks.view() : { u: 0.5, v: 0.5, halfU: 0.2, halfV: 0.2 };
    this.tileOrder = tileLoadOrder(entry.tiles, entry.width, entry.height, view);
    if (this.hooks.onEntry) this.hooks.onEntry(entry);
    this._beginOverview();
    this._requestCurrent();
  };

  PhotoSession.prototype._beginOverview = function () {
    var entry = this.entry;
    if (!entry || !entry.overview || entry.overview.id == null) return false;
    this._overviewPending = true;
    this._overviewReady = false;
    this._issue({
      id: String(entry.overview.id),
      url: entry.overview.url || "",
      srcX: 0,
      srcY: 0,
      srcW: entry.width || 1,
      srcH: entry.height || 1,
      padL: 0,
      padR: 0,
      padT: 0,
      padB: 0,
      texW: entry.overview.texW || BASE_W,
      texH: entry.overview.texH || BASE_H,
      _overview: true,
      _base: true,
    });
    return true;
  };

  PhotoSession.prototype._bandLoaded = function () {
    if (!this.entry || !this.entry.tiles || !this.entry.tiles.length) return false;
    var view = this.hooks.view ? this.hooks.view() : null;
    if (!view || !(view.lookaheadDeg > 0)) return false;
    var tiles = this.entry.tiles;
    var width = this.entry.width;
    var height = this.entry.height;
    var need = 0;
    for (var i = 0; i < tiles.length; i++) {
      if (tiles[i]._skip) continue;
      if (!tileInResidentBand(tiles[i], width, height, view)) continue;
      need += 1;
      var found = null;
      var loaded = this.loaded || [];
      for (var j = 0; j < loaded.length; j++) {
        if (loaded[j] && loaded[j].tile && loaded[j].tile.id === tiles[i].id) found = loaded[j];
      }
      if (!found || !found.tex || found.tex.deferred || found.tex._evicted || found.tex.oom) return false;
    }
    return need > 0;
  };

  PhotoSession.prototype.accepts = function (msg) {
    if (!msg || msg.id == null) return false;
    var box = this.assemblers[msg.id];
    if (!box || box.gen !== this.generation) return false;
    if (msg.token == null) return true;
    return (msg.token | 0) === box.token;
  };

  PhotoSession.prototype.quietStop = function () {
    this.generation += 1;
    this.token += 1;
    this.pending = null;
    this.assemblers = {};
    this.budgetFull = false;
  };

  PhotoSession.prototype.resume = function () {
    if (!this.entry || this.pending) return;
    if (!this.budgetFull && this.shown) return;
    this.budgetFull = false;
    var done = this.tileOrder ? this.orderPos >= this.tileOrder.length : this.tileIndex >= this.entry.tiles.length;
    if (done) return;
    this._requestCurrent();
  };

  PhotoSession.prototype._aimOrder = function () {
    if (!this.entry || !this.entry.tiles || !this.entry.tiles.length) return;
    var view = this.hooks.view ? this.hooks.view() : null;
    if (!view) return;
    var directed = view.lookaheadDeg > 0 || view.panSign === 1 || view.panSign === -1;
    if (!this.standby && !directed) return;
    var fresh = tileLoadOrder(this.entry.tiles, this.entry.width, this.entry.height, view);
    var order = this.tileOrder || fresh;
    var taken = {};
    var prefix = [];
    var pos = this.orderPos | 0;
    for (var i = 0; i < pos && i < order.length; i++) {
      prefix.push(order[i]);
      taken[order[i]] = true;
    }
    var rest = [];
    for (var j = 0; j < fresh.length; j++) {
      if (!taken[fresh[j]]) rest.push(fresh[j]);
    }
    this.tileOrder = prefix.concat(rest);
  };

  PhotoSession.prototype._tileReady = function (id) {
    var loaded = this.loaded || [];
    for (var i = 0; i < loaded.length; i++) {
      var piece = loaded[i];
      if (!piece || !piece.tile || piece.tile.id !== id || !piece.tex) continue;
      if (!piece.tex.deferred && !piece.tex._evicted) return true;
    }
    return false;
  };

  PhotoSession.prototype._syncCursor = function () {
    var entry = this.entry;
    if (!entry || !entry.tiles) return;
    var total = this.tileOrder ? this.tileOrder.length : entry.tiles.length;
    var pos = 0;
    while (pos < total) {
      var index = this.tileOrder ? this.tileOrder[pos] : pos;
      var tile = entry.tiles[index];
      if (tile && tile._skip) {
        pos += 1;
        continue;
      }
      if (!tile || !this._tileReady(tile.id)) break;
      pos += 1;
    }
    if (this.tileOrder) this.orderPos = pos;
    else this.tileIndex = pos;
  };

  PhotoSession.prototype._inFlight = function () {
    var n = 0;
    if (!this.assemblers) return 0;
    for (var id in this.assemblers) {
      var box = this.assemblers[id];
      if (!box || (box.tile && box.tile._overview)) continue;
      n += 1;
    }
    return n;
  };

  PhotoSession.prototype._syncPending = function () {
    var oldest = null;
    if (this.assemblers) {
      for (var id in this.assemblers) {
        var box = this.assemblers[id];
        if (!box) continue;
        if (!oldest || (box.started || 0) < (oldest.started || 0)) oldest = box;
      }
    }
    this.pending = oldest ? { id: oldest.id, token: oldest.token, started: oldest.started || this._now() } : null;
  };

  PhotoSession.prototype._tileInLookahead = function (tile, view) {
    if (!tile || !view || !this.entry || !(view.lookaheadDeg > 0)) return false;
    var width = this.entry.width;
    var height = this.entry.height;
    if (tileInView(tile, width, height, view)) return true;
    var sign = view.panSign < 0 ? -1 : 1;
    var centerU = (tile.srcX + tile.srcW / 2) / width;
    var lead = panLeadDeg(centerU, view.u, sign);
    if (lead < -0.5) return false;
    var tileDeg = (tile.srcW / width) * 360;
    var limit = (view.halfU || 0) * 360 + view.lookaheadDeg;
    return (lead - tileDeg / 2) <= limit;
  };

  PhotoSession.prototype._pickTile = function (windowOnly) {
    var entry = this.entry;
    if (!entry || !entry.tiles) return null;
    var order = this.tileOrder;
    var total = order ? order.length : entry.tiles.length;
    var start = order ? (this.orderPos | 0) : (this.tileIndex | 0);
    var view = this.hooks.view ? this.hooks.view() : null;
    var fallback = null;
    for (var s = start; s < total; s++) {
      var index = order ? order[s] : s;
      var tile = entry.tiles[index];
      if (!tile) continue;
      if (tile._skip) continue;
      if (this.assemblers[tile.id]) continue;
      if (this._tileReady(tile.id)) continue;
      var outside = view && view.lookaheadDeg > 0 && !tileInResidentBand(tile, entry.width, entry.height, view);
      if (outside || (windowOnly && !this._tileInLookahead(tile, view))) {
        if (!fallback) fallback = tile;
        continue;
      }
      return tile;
    }
    if (windowOnly || this._inFlight() > 0) return null;
    return fallback;
  };

  PhotoSession.prototype._issue = function (tile) {
    var entry = this.entry;
    if (!entry || !tile) return false;
    this.token += 1;
    var token = this.token;
    if (!this._openTokens) this._openTokens = {};
    this._openTokens[token] = true;
    this.assemblers[tile.id] = {
      id: tile.id,
      gen: this.generation,
      token: token,
      started: this._now(),
      n: 0,
      got: 0,
      parts: [],
      tile: tile,
      photoId: entry.id,
      mipCount: tile.mipCount | 0,
      mipParts: [],
      mipGot: [],
      mipN: [],
      mipPayload: [],
    };
    this._syncPending();
    if (this.hooks.request) this.hooks.request(tile.id, token);
    return true;
  };

  PhotoSession.prototype._fillWindow = function () {
    if (!this.entry || this.budgetFull || this.preloadCapped) return;
    var view = this.hooks.view ? this.hooks.view() : null;
    if (!view || !(view.lookaheadDeg > 0)) return;
    var guard = 0;
    while (this._inFlight() < AHEAD_REQUESTS && guard < AHEAD_REQUESTS) {
      guard += 1;
      if (this._preloadCapped()) {
        this.preloadCapped = true;
        return;
      }
      var tile = this._pickTile(true);
      if (!tile) return;
      this._issue(tile);
    }
  };

  PhotoSession.prototype._tokenLive = function (token, gen) {
    if (gen !== this.generation) return false;
    return !!(this._openTokens && this._openTokens[token]);
  };

  PhotoSession.prototype._requestCurrent = function () {
    var entry = this.entry;
    if (!entry || !entry.tiles || this.budgetFull) return;
    if (this._preloadCapped()) {
      this.preloadCapped = true;
      return;
    }
    this._aimOrder();
    this._syncCursor();
    this._syncPending();
    var tile = this._pickTile(false);
    if (!tile) {
      this._fillWindow();
      return;
    }
    if (!this.assemblers[tile.id]) this._issue(tile);
    this._fillWindow();
  };

  PhotoSession.prototype._lookaheadCovered = function () {
    if (!this.entry || !this.entry.tiles) return false;
    var view = this.hooks.view ? this.hooks.view() : null;
    if (!view) return true;
    var sign = view.panSign < 0 ? -1 : 1;
    var half = (view.halfU || 0) * 360;
    var limit = half + (view.lookaheadDeg || 0);
    var tiles = this.entry.tiles;
    var width = this.entry.width;
    var height = this.entry.height;
    var loaded = this.loaded || [];
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      var centerU = (tile.srcX + tile.srcW / 2) / width;
      var lead = panLeadDeg(centerU, view.u, sign);
      var tileDeg = (tile.srcW / width) * 360;
      var near = lead - tileDeg / 2;
      var far = lead + tileDeg / 2;
      if (near > limit) continue;
      if (tile._skip) continue;
      if (far < -half && !tileInView(tile, width, height, view)) continue;
      var found = null;
      for (var j = 0; j < loaded.length; j++) {
        if (loaded[j] && loaded[j].tile && loaded[j].tile.id === tile.id) found = loaded[j];
      }
      if (!pieceReady(found)) return false;
    }
    return true;
  };

  PhotoSession.prototype.noteChunk = function (msg) {
    if (!msg || msg.id == null) return;
    var box = this.assemblers[msg.id];
    if (!box || box.gen !== this.generation) return;
    // The token is the one this tile asked for. It is not "whatever the
    // showing photo requested last": a neighbor preloaded in the background
    // keeps its own token, and those chunks are not a stale transfer.
    if (msg.token != null && (msg.token | 0) !== box.token) return;
    var level = msg.level | 0;
    if (level > 0) {
      this._noteLevel(box, level, msg);
      return;
    }
    var index = msg.i | 0;
    var count = msg.n | 0;
    if (count <= 0 || index < 0 || index >= count) return;
    if (box.n && count !== box.n) return;
    if (box.parts[index] != null) return;
    box.n = count;
    box.parts[index] = String(msg.data || "");
    box.got += 1;
    if (box.got < count) return;
    for (var i = 0; i < count; i++) if (box.parts[i] == null) return;
    var payload = box.parts.slice(0, count).join("");
    // Level 0 is the full-resolution tile. Waiting for every mip JPEG
    // stalled the show: the overview has no mips, so it appeared, and the
    // sharp tiles never left the assembler.
    delete this.assemblers[msg.id];
    this._materialize(box, payload);
  };

  PhotoSession.prototype._noteLevel = function (box, level, msg) {
    var index = msg.i | 0;
    var count = msg.n | 0;
    if (count <= 0 || index < 0 || index >= count) return;
    if (!box.mipParts[level]) box.mipParts[level] = [];
    if (box.mipN[level] && count !== box.mipN[level]) return;
    if (box.mipParts[level][index] != null) return;
    box.mipN[level] = count;
    box.mipParts[level][index] = String(msg.data || "");
    box.mipGot[level] = (box.mipGot[level] || 0) + 1;
    if (box.mipGot[level] < count) return;
    for (var i = 0; i < count; i++) if (box.mipParts[level][i] == null) return;
    box.mipPayload[level] = box.mipParts[level].slice(0, count).join("");
    if (!box.level0 || !mipsReady(box)) return;
    delete this.assemblers[box.id];
    this._materialize(box, box.level0);
  };

  PhotoSession.prototype._viewCovered = function () {
    if (!this.entry || !this.entry.tiles) return false;
    var view = this.hooks.view ? this.hooks.view() : null;
    if (!view) return false;
    var tiles = this.entry.tiles;
    var width = this.entry.width;
    var height = this.entry.height;
    var need = [];
    for (var i = 0; i < tiles.length; i++) {
      if (tiles[i]._skip) continue;
      if (tileInView(tiles[i], width, height, view)) need.push(tiles[i]);
    }
    if (!need.length) return false;
    var loaded = this.loaded || [];
    for (var n = 0; n < need.length; n++) {
      var found = null;
      for (var j = 0; j < loaded.length; j++) {
        if (loaded[j] && loaded[j].tile && loaded[j].tile.id === need[n].id) found = loaded[j];
      }
      if (!pieceReady(found)) return false;
    }
    return true;
  };

  PhotoSession.prototype._preloadCapped = function () {
    if (!this.standby) return false;
    if (!this._viewCovered()) return false;
    var room = this.hooks.gpuRoom ? this.hooks.gpuRoom() : 0;
    if (room > 0) return false;
    var limit = this.hooks.preloadLimit ? (this.hooks.preloadLimit() | 0) : 0;
    if (!(limit > 0)) return false;
    var got = 0;
    var loaded = this.loaded || [];
    for (var i = 0; i < loaded.length; i++) {
      var tex = loaded[i] && loaded[i].tex;
      if (tex && !tex.deferred && !tex._evicted) got += 1;
    }
    return got >= limit;
  };

  PhotoSession.prototype.noteFetchError = function (msg) {
    if (!msg) return;
    var box = this.assemblers[msg.id];
    if (!box || box.gen !== this.generation) return;
    if (msg.token != null && (msg.token | 0) !== box.token) return;
    if (box.tile && box.tile._overview) {
      delete this.assemblers[msg.id];
      if (this._openTokens) delete this._openTokens[box.token];
      this._overviewPending = false;
      this._syncPending();
      this._requestCurrent();
      return;
    }
    this._failOrRetry(msg.message || "fetch");
  };

  PhotoSession.prototype._materialize = function (box, payload) {
    var self = this;
    var token = box.token;
    var gen = box.gen;
    var accepted = false;
    var settled = false;
    var finish = function (err, image) {
      // Chrome fires onerror when the decoded image's src is cleared. That
      // second callback used to release the textures just drawn and clear
      // the frame. The first result owns this tile. settled waits until the
      // upload is applied, so an async upload can still land.
      if (accepted || settled) return;
      accepted = true;
      if (!self._tokenLive(token, gen)) {
        settled = true;
        if (image && self.hooks.dropImage) self.hooks.dropImage(image);
        return;
      }
      if (err || !image) {
        settled = true;
        if (image && self.hooks.dropImage) self.hooks.dropImage(image);
        self._skipTile(box, err || "load");
        return;
      }
      function apply(tex) {
        if (settled) return;
        settled = true;
        if (!self._tokenLive(token, gen)) {
          if (image && self.hooks.dropImage) self.hooks.dropImage(image);
          if (tex && self.hooks.release) self.hooks.release(tex);
          return;
        }
        if (self._openTokens) delete self._openTokens[token];
        if (image && self.hooks.dropImage) self.hooks.dropImage(image);
        if (!tex || tex.oom) {
          if (tex && self.hooks.release) self.hooks.release(tex);
          self._oom(box.photoId);
          return;
        }
        var deferred = !!(tex.deferred || tex._evicted);
        self._syncPending();
        if (deferred && self.standby) {
          // The cursor stays on this tile. resume() asks for it again
          // instead of skipping a placeholder that was never uploaded.
          if (self.hooks.release) self.hooks.release(tex);
          self.budgetFull = true;
          return;
        }
        if (box.tile && box.tile._overview) {
          self._overviewPending = false;
          self._overviewReady = true;
          self._syncPending();
          if (self.hooks.onOverview) self.hooks.onOverview(self.entry, image, tex);
          if (!self.pending) self._requestCurrent();
          return;
        }
        if (image._spsPayload && !tex._spsPayload) tex._spsPayload = image._spsPayload;
        self.live.push(tex);
        var replaced = -1;
        for (var slot = 0; slot < self.loaded.length; slot++) {
          var have = self.loaded[slot];
          if (have && have.tile && box.tile && have.tile.id === box.tile.id) replaced = slot;
        }
        var stored = { tex: tex, tile: box.tile, payload: image._spsPayload || null };
        if (!self.standby) stored._focusAt = self._now();
        if (replaced >= 0) self.loaded[replaced] = stored;
        else self.loaded.push(stored);
        self._syncCursor();
        if (self.hooks.onTile) self.hooks.onTile(self, self.loaded[self.loaded.length - 1]);
        var finished = !self.entry || (self.tileOrder
          ? self.orderPos >= self.tileOrder.length
          : self.tileIndex >= self.entry.tiles.length);
        var band = self._bandLoaded();
        if (self.pending) return;
        if (finished || band) {
          var resident = self.loaded.filter(function (piece) {
            return piece.tex && !piece.tex.deferred && !piece.tex._evicted;
          });
          var covered = self.entry && coversSphere(
            resident.map(function (piece) { return piece.tile; }),
            self.entry.width,
            self.entry.height,
          );
          if (!covered && !band) {
            if (self.standby) {
              self.budgetFull = true;
              return;
            }
            self.attempt = 1;
            self._failOrRetry("coverage");
            return;
          }
          self.shown = true;
          if (self.hooks.onStatus && !self.standby) self.hooks.onStatus("");
          if (self.hooks.onShown) {
            self.hooks.onShown({
              id: self.entry.id,
              width: self.entry.width,
              height: self.entry.height,
              tiles: self.loaded.slice(),
            });
          }
          return;
        }
        self._requestCurrent();
      }
      function startUpload() {
        var returned;
        try {
          returned = self.hooks.upload ? self.hooks.upload(image, box.tile, apply) : null;
        } catch (error) {
          settled = true;
          if (self.hooks.dropImage) self.hooks.dropImage(image);
          if (isOom(error)) self._oom(box.photoId);
          else self._failOrRetry(error);
          return;
        }
        if (returned !== undefined) apply(returned);
      }
      var mipPayloads = [];
      if (box.mipPayload) {
        for (var lv = 1; lv < box.mipPayload.length; lv++) {
          if (box.mipPayload[lv]) mipPayloads.push(box.mipPayload[lv]);
        }
      }
      if (!mipPayloads.length || !self.hooks.materialize) {
        startUpload();
      } else {
        image._levels = new Array(mipPayloads.length + 1);
        image._levels[0] = image;
        var leftMips = mipPayloads.length;
        mipPayloads.forEach(function (mipPayload, mipIndex) {
          self.hooks.materialize(mipPayload, function (mipErr, mipImg) {
            if (!mipErr && mipImg) image._levels[mipIndex + 1] = mipImg;
            leftMips -= 1;
            if (leftMips <= 0) startUpload();
          });
        });
      }
    };
    if (this.hooks.materialize) this.hooks.materialize(payload, finish);
    else finish(new Error("no materialize"));
  };

  PhotoSession.prototype._skipTile = function (box, reason) {
    if (box && this._openTokens) delete this._openTokens[box.token];
    if (box && box.id) delete this.assemblers[box.id];
    this._syncPending();
    var text = String((reason && reason.message) || reason || "tile skipped");
    if (this.hooks.onLog) this.hooks.onLog(text);
    if (box && box.tile && box.tile._overview) {
      this._overviewPending = false;
      this._requestCurrent();
      return;
    }
    if (box && box.tile) box.tile._skip = true;
    var entry = this.entry;
    var pendingWork = false;
    if (entry && entry.tiles) {
      for (var i = 0; i < entry.tiles.length; i++) {
        var tile = entry.tiles[i];
        if (!tile || tile._skip || this._tileReady(tile.id)) continue;
        pendingWork = true;
      }
    }
    if (!pendingWork && !(this.loaded && this.loaded.length)) {
      this._failOrRetry(reason || "load");
      return;
    }
    this._requestCurrent();
  };

  PhotoSession.prototype._failOrRetry = function (reason) {
    if (this.waitingShrink) return;
    var entry = this.entry;
    this._openTokens = {};
    this._releaseAll();
    this.loaded = [];
    this.assemblers = {};
    this.pending = null;
    this.tileIndex = 0;
    if (this.attempt < 1 && entry) {
      this.entry = entry;
      if (entry.tiles) {
        for (var i = 0; i < entry.tiles.length; i++) {
          if (entry.tiles[i]) entry.tiles[i]._skip = false;
        }
      }
      this.attempt += 1;
      if (this.hooks.onStatus) this.hooks.onStatus("busy");
      this._requestCurrent();
      return;
    }
    this.entry = null;
    warn("photo failed", reason);
    if (this.hooks.onStatus) this.hooks.onStatus("error");
    if (this.hooks.onFail) this.hooks.onFail(reason);
  };

  PhotoSession.prototype._oom = function (photoId) {
    // A tile that does not fit is not a request for a smaller photo. Keep any
    // full-resolution tiles that already cover the sphere; otherwise leave the
    // last frame where it is and log the miss.
    warn("full-resolution tile did not upload", photoId);
    this.assemblers = {};
    this.pending = null;
    this.waitingShrink = false;
    var covered = this.entry && this.loaded.length && coversSphere(
      this.loaded.map(function (piece) { return piece.tile; }),
      this.entry.width,
      this.entry.height,
    );
    if (covered) {
      this.shown = true;
      if (this.hooks.onShown) {
        this.hooks.onShown({
          id: this.entry.id,
          width: this.entry.width,
          height: this.entry.height,
          tiles: this.loaded.slice(),
        });
      }
    } else {
      this._releaseAll();
      this.loaded = [];
      this.entry = null;
    }
    if (this.hooks.onStatus) this.hooks.onStatus("");
  };

  PhotoSession.prototype.tick = function (now) {
    if (!this.pending) return;
    if (now - this.pending.started < this.timeoutMs) return;
    if (this.waitingShrink) {
      this.pending = null;
      this.entry = null;
      if (this.hooks.onStatus) this.hooks.onStatus("error");
      if (this.hooks.onFail) this.hooks.onFail("timeout");
      return;
    }
    if (this._overviewReady || (this.loaded && this.loaded.length)) {
      var stalled = this.assemblers[this.pending.id];
      if (stalled && stalled.tile) stalled.tile._skip = true;
      if (stalled) delete this.assemblers[stalled.id];
      if (stalled && this._openTokens) delete this._openTokens[stalled.token];
      this._syncPending();
      if (this.hooks.onLog) this.hooks.onLog("A tile stalled and was skipped");
      this._requestCurrent();
      return;
    }
    this._failOrRetry("timeout");
  };

  function warn(code, detail) {
    if (typeof console === "undefined" || !console.warn) return;
    var text = "spsphere cast: " + code;
    if (detail) text += " " + detail;
    console.warn(text);
  }

  function uDist(a, b) {
    var d = Math.abs(a - b) % 1;
    if (d > 0.5) d = 1 - d;
    return d;
  }

  var scratchYaw = new Float32Array(16);
  var scratchPitch = new Float32Array(16);
  var scratchRoll = new Float32Array(16);
  var scratchView = new Float32Array(16);
  var scratchUv = { u: 0.5, v: 0.5 };

  function viewCenterUv(yawDeg, pitchDeg) {
    fillAimView(scratchYaw, scratchPitch, scratchRoll, scratchView, yawDeg || 0, pitchDeg || 0, 0);
    var view = scratchView;
    var x = -view[2];
    var y = -view[6];
    var z = -view[10];
    var len = Math.sqrt(x * x + y * y + z * z) || 1;
    x /= len;
    y /= len;
    z /= len;
    var lon = Math.atan2(x, -z);
    var lat = Math.asin(clamp(y, -1, 1));
    var u = 0.5 + lon / (Math.PI * 2);
    u = u - Math.floor(u);
    var v = clamp(0.5 - lat / Math.PI, 0, 1);
    scratchUv.u = u;
    scratchUv.v = v;
    return scratchUv;
  }

  var scratchExt = { halfU: 0.2, halfV: 0.2 };

  function viewExtents(fovDeg, aspect) {
    var vRad = (fovDeg || 75) * Math.PI / 180;
    var halfV = vRad / 2;
    var halfH = Math.atan(Math.tan(halfV) * (aspect > 0 ? aspect : 1));
    scratchExt.halfU = halfH / (Math.PI * 2);
    scratchExt.halfV = halfV / Math.PI;
    return scratchExt;
  }

  function rangesOverlap(a0, a1, b0, b1) {
    return a0 < b1 && b0 < a1;
  }

  function uOverlap(u0, u1, center, half) {
    var left = center - half;
    var right = center + half;
    for (var k = -1; k <= 1; k++) {
      if (rangesOverlap(u0, u1, left + k, right + k)) return true;
    }
    return false;
  }

  function fitCrop(imgW, imgH, maxEdge, budget) {
    var w = Math.min(imgW, maxEdge);
    var h = Math.min(imgH, maxEdge);
    if (w < 1 || h < 1) return null;
    if (w * h * 4 <= budget) return { w: w, h: h, full: w === imgW && h === imgH };
    if (!(budget >= 4)) return null;
    var scale = Math.sqrt(budget / (w * h * 4));
    var cw = Math.max(1, Math.floor(w * scale));
    var ch = Math.max(1, Math.floor(h * scale));
    while (cw * ch * 4 > budget && cw > 1) cw -= 1;
    while (cw * ch * 4 > budget && ch > 1) ch -= 1;
    if (cw * ch * 4 > budget) return null;
    return { w: cw, h: ch, full: false };
  }

  function cropOrigin(imgW, imgH, cropW, cropH, cx, cy) {
    var x = Math.round(cx - cropW / 2);
    var y = Math.round(cy - cropH / 2);
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x + cropW > imgW) x = Math.max(0, imgW - cropW);
    if (y + cropH > imgH) y = Math.max(0, imgH - cropH);
    return { x: x, y: y };
  }

  function viewPixel(tile, width, height, u, v) {
    var u0 = tile.srcX / width;
    var u1 = (tile.srcX + tile.srcW) / width;
    var v0 = tile.srcY / height;
    var v1 = (tile.srcY + tile.srcH) / height;
    var uu = u;
    var vv = v;
    if (uu < u0 || uu > u1) uu = (u0 + u1) / 2;
    if (vv < v0 || vv > v1) vv = (v0 + v1) / 2;
    var sx = u1 === u0 ? 0.5 : (uu - u0) / (u1 - u0);
    var sy = v1 === v0 ? 0.5 : (vv - v0) / (v1 - v0);
    return {
      x: (tile.padL || 0) + sx * tile.srcW,
      y: (tile.padT || 0) + sy * tile.srcH,
    };
  }

  function windowFromCrop(tile, cropX, cropY, cropW, cropH) {
    var uniqueX0 = tile.padL || 0;
    var uniqueY0 = tile.padT || 0;
    var uniqueX1 = uniqueX0 + tile.srcW;
    var uniqueY1 = uniqueY0 + tile.srcH;
    var ix0 = Math.max(cropX, uniqueX0);
    var iy0 = Math.max(cropY, uniqueY0);
    var ix1 = Math.min(cropX + cropW, uniqueX1);
    var iy1 = Math.min(cropY + cropH, uniqueY1);
    if (ix1 - ix0 < 1 || iy1 - iy0 < 1) return null;
    var imgW = tile.texW || (tile.srcW + (tile.padL || 0) + (tile.padR || 0));
    var imgH = tile.texH || (tile.srcH + (tile.padT || 0) + (tile.padB || 0));
    return {
      srcX: tile.srcX + (ix0 - uniqueX0),
      srcY: tile.srcY + (iy0 - uniqueY0),
      srcW: ix1 - ix0,
      srcH: iy1 - iy0,
      padL: ix0 - cropX,
      padT: iy0 - cropY,
      padR: 0,
      padB: 0,
      texW: cropW,
      texH: cropH,
      cropX: cropX,
      cropY: cropY,
      full: cropX === 0 && cropY === 0 && cropW === imgW && cropH === imgH,
    };
  }

  function planResidence(tiles, width, height, view, maxEdge, budget) {
    var order = [];
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      var u0 = tile.srcX / width;
      var u1 = (tile.srcX + tile.srcW) / width;
      var v0 = tile.srcY / height;
      var v1 = (tile.srcY + tile.srcH) / height;
      var contains = view.u >= u0 && view.u <= u1 && view.v >= v0 && view.v <= v1;
      var hits = tileInView(tile, width, height, view);
      var dist = uDist((u0 + u1) / 2, view.u) + Math.abs((v0 + v1) / 2 - view.v);
      order.push({ index: i, contains: contains, hits: hits, dist: dist });
    }
    order.sort(function (a, b) {
      if (a.contains !== b.contains) return a.contains ? -1 : 1;
      if (a.hits !== b.hits) return a.hits ? -1 : 1;
      if (a.dist !== b.dist) return a.dist - b.dist;
      return a.index - b.index;
    });
    var left = budget;
    var plan = new Array(tiles.length);
    for (var n = 0; n < order.length; n++) {
      var item = order[n];
      var src = tiles[item.index];
      var imgW = src.texW || (src.srcW + (src.padL || 0) + (src.padR || 0));
      var imgH = src.texH || (src.srcH + (src.padT || 0) + (src.padB || 0));
      var fit = fitCrop(imgW, imgH, maxEdge, left);
      if (!fit || (!item.hits && !fit.full)) {
        plan[item.index] = { resident: false };
        continue;
      }
      var px = viewPixel(src, width, height, view.u, view.v);
      var origin = cropOrigin(imgW, imgH, fit.w, fit.h, px.x, px.y);
      var win = windowFromCrop(src, origin.x, origin.y, fit.w, fit.h);
      if (!win) {
        plan[item.index] = { resident: false };
        continue;
      }
      win.full = !!fit.full;
      win.bytes = fit.w * fit.h * 4;
      left -= win.bytes;
      plan[item.index] = { resident: true, window: win };
    }
    return plan;
  }

  function cropSource(img, x, y, w, h) {
    if (!img || !(w > 0) || !(h > 0)) return null;
    if (typeof document === "undefined" || !document.createElement) return null;
    var canvas = document.createElement("canvas");
    canvas.width = w | 0;
    canvas.height = h | 0;
    var ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
    return canvas;
  }

  function coversSphere(tiles, width, height) {
    if (!(width > 0) || !(height > 0) || !tiles || !tiles.length) return false;
    var steps = 48;
    for (var y = 0; y < steps; y++) {
      var v = (y + 0.5) / steps;
      for (var x = 0; x < steps; x++) {
        var u = (x + 0.5) / steps;
        var hit = false;
        for (var i = 0; i < tiles.length; i++) {
          var tile = tiles[i] && tiles[i].tile ? tiles[i].tile : tiles[i];
          if (tileTexCoord(u, v, tile, width, height)) {
            hit = true;
            break;
          }
        }
        if (!hit) return false;
      }
    }
    return true;
  }

  function tileTexCoord(u, v, tile, width, height) {
    if (!tile || !(width > 0) || !(height > 0) || !(tile.texW > 0) || !(tile.texH > 0)) return null;
    var u0 = tile.srcX / width;
    var u1 = (tile.srcX + tile.srcW) / width;
    var v0 = tile.srcY / height;
    var v1 = (tile.srcY + tile.srcH) / height;
    if (u < u0 || u > u1 || v < v0 || v > v1) return null;
    var du = u1 - u0;
    var dv = v1 - v0;
    var sx = du ? (u - u0) / du : 0;
    var sy = dv ? (v - v0) / dv : 0;
    return {
      x: (tile.padL + sx * tile.srcW) / tile.texW,
      y: (tile.padT + sy * tile.srcH) / tile.texH,
    };
  }

  function nowMs() {
    if (root.performance && root.performance.now) return root.performance.now();
    return Date.now();
  }

  function panLookaheadDeg(dps, latencyMs) {
    var speed = Math.abs(Number(dps) || 0);
    var seconds = Math.max(0, Number(latencyMs) || 0) / 1000;
    return Math.max(speed * seconds * 2, speed * LOOKAHEAD_FLOOR_S);
  }

  function tileInResidentBand(tile, width, height, view) {
    if (!tile || !view) return true;
    if (!(view.lookaheadDeg > 0) && view.panSign !== 1 && view.panSign !== -1) return true;
    if (tileInView(tile, width, height, view)) return true;
    var sign = view.panSign < 0 ? -1 : 1;
    var centerU = (tile.srcX + tile.srcW / 2) / Math.max(width, 1);
    var lead = panLeadDeg(centerU, view.u, sign);
    var tileDeg = (tile.srcW / Math.max(width, 1)) * 360;
    var limit = (view.halfU || 0) * 360 + (view.lookaheadDeg || 0) + RESIDENT_MARGIN_DEG;
    var near = lead - tileDeg / 2;
    var far = lead + tileDeg / 2;
    if (far < -RESIDENT_MARGIN_DEG) return false;
    if (near > limit) return false;
    return true;
  }

  function overviewUniforms(texW, texH) {
    var w = texW > 0 ? texW : BASE_W;
    var h = texH > 0 ? texH : BASE_H;
    return { u0: 0, u1: 1, v0: 0, v1: 1, padL: 0, padT: 0, srcW: w, srcH: h, texW: w, texH: h };
  }

  function overviewSample(u, texW) {
    var w = texW > 0 ? texW : BASE_W;
    var wrapped = u - Math.floor(u);
    var st = wrapped;
    var half = 0.5 / w;
    if (st < half) st = half;
    if (st > 1 - half) st = 1 - half;
    return Math.min(w - 1, Math.max(0, Math.floor(st * w)));
  }

  function brokenOverviewSample(u, photoW, texW) {
    var w = texW > 0 ? texW : BASE_W;
    var st = (u * photoW) / w;
    var half = 0.5 / w;
    if (st < half) st = half;
    if (st > 1 - half) st = 1 - half;
    return Math.min(w - 1, Math.max(0, Math.floor(st * w)));
  }

  function loadingProfile(opts) {
    opts = opts || {};
    var edge = opts.edge || 512;
    var photoW = opts.photoW || 8192;
    var photoH = opts.photoH || 4096;
    var dps = opts.dps == null ? 18 : opts.dps;
    var frameMs = opts.frameMs || 16;
    var durationMs = opts.durationMs || 8000;
    var msPerMb = opts.msPerMb || 12;
    var bandOnly = opts.bandOnly !== false;
    var fov = opts.fov || 75;
    var aspect = opts.aspect || 16 / 9;
    var gutter = 32;
    var colSpan = photoW + 2 * gutter <= edge ? photoW : Math.max(1, edge - 2 * gutter);
    var rowSpan = photoH <= edge ? photoH : Math.max(1, edge - 2 * gutter);
    var cols = Math.ceil(photoW / colSpan);
    var rows = Math.ceil(photoH / rowSpan);
    var tiles = [];
    var y = 0;
    for (var row = 0; row < rows; row++) {
      var srcH = row === rows - 1 ? photoH - y : rowSpan;
      var x = 0;
      for (var col = 0; col < cols; col++) {
        var srcW = col === cols - 1 ? photoW - x : colSpan;
        tiles.push({ srcX: x, srcY: y, srcW: srcW, srcH: srcH });
        x += srcW;
      }
      y += srcH;
    }
    function slicePlan() {
      var budgetBytes = UPLOAD_BUDGET_MS / Math.max(msPerMb, 0.05) * 1024 * 1024;
      var rowsPer = Math.floor(budgetBytes / Math.max(edge * 4, 1));
      if (rowsPer < 8) rowsPer = 8;
      if (rowsPer > 64) rowsPer = 64;
      var fullMs = (edge * edge * 4) / (1024 * 1024) * msPerMb;
      if (edge <= rowsPer) return { slices: 1, sliceMs: fullMs };
      var sliceBytes = edge * rowsPer * 4;
      return { slices: Math.ceil(edge / rowsPer), sliceMs: sliceBytes / (1024 * 1024) * msPerMb };
    }
    var plan = slicePlan();
    var decodeMs = (edge * edge) / (512 * 512) * (opts.decodeMs || 6);
    var yaw = 0;
    var media = 0;
    var requested = {};
    var resident = {};
    var decodeQueue = [];
    var uploadQueue = [];
    var busySamples = [];
    var totalBusy = 0;
    var maxBusy = 0;
    var over = 0;
    var peak = 0;
    var decoded = 0;
    var frameTimes = [];
    var maxFrame = 0;
    for (var t = 0; t < durationMs; t += frameMs) {
      media = t;
      yaw += dps * frameMs / 1000;
      var center = viewCenterUv(yaw, 0);
      var ext = viewExtents(fov, aspect);
      var view = {
        u: center.u,
        v: center.v,
        halfU: ext.halfU,
        halfV: ext.halfV,
        yaw: yaw,
        pitch: 0,
        fov: fov,
        aspect: aspect,
        lookaheadDeg: panLookaheadDeg(dps, opts.latencyMs || 1500),
        panSign: 1,
      };
      var busy = 0;
      for (var d = decodeQueue.length - 1; d >= 0; d--) {
        if (decodeQueue[d].readyAt > media) continue;
        var ready = decodeQueue.splice(d, 1)[0];
        uploadQueue.push({ id: ready.id, slices: plan.slices, sliceMs: plan.sliceMs });
        busy += 0.15;
        decoded += 1;
      }
      if (uploadQueue.length) {
        var job = uploadQueue[0];
        busy += job.sliceMs;
        job.slices -= 1;
        if (job.slices <= 0) {
          uploadQueue.shift();
          resident[job.id] = true;
        }
      }
      var inflight = decodeQueue.length + uploadQueue.length;
      for (var i = 0; i < tiles.length; i++) {
        if (requested[i]) continue;
        if (bandOnly && !tileInResidentBand(tiles[i], photoW, photoH, view)) continue;
        if (bandOnly && inflight >= 4) break;
        requested[i] = true;
        decodeQueue.push({ id: i, readyAt: media + decodeMs });
        inflight += 1;
        if (!bandOnly && inflight >= tiles.length) break;
      }
      if (bandOnly) {
        for (var id in resident) {
          if (!tileInResidentBand(tiles[id], photoW, photoH, view)) delete resident[id];
        }
      }
      var n = 0;
      for (var kept in resident) n += 1;
      if (n > peak) peak = n;
      var frame = Math.max(frameMs, busy);
      busySamples.push(busy);
      frameTimes.push(frame);
      totalBusy += busy;
      if (busy > maxBusy) maxBusy = busy;
      if (frame > maxFrame) maxFrame = frame;
      if (busy > UPLOAD_BUDGET_MS + 0.35) over += 1;
    }
    var nFrames = busySamples.length || 1;
    return {
      edge: edge,
      bandOnly: !!bandOnly,
      tiles: tiles.length,
      frames: nFrames,
      meanBusyMs: totalBusy / nFrames,
      maxBusyMs: maxBusy,
      totalBusyMs: totalBusy,
      meanFrameMs: frameTimes.reduce(function (sum, value) { return sum + value; }, 0) / nFrames,
      maxFrameMs: maxFrame,
      overBudgetFrames: over,
      peakResident: peak,
      decoded: decoded,
      misses: 0,
    };
  }

  function panLeadDeg(tileU, viewU, panSign) {
    var d = (Number(tileU) || 0) - (Number(viewU) || 0);
    d = d - Math.floor(d);
    if (d > 0.5) d -= 1;
    var sign = panSign < 0 ? -1 : 1;
    return d * 360 * sign;
  }

  function tilePole(tile, height) {
    if (!tile) return "";
    var mid = (tile.srcY + tile.srcH / 2) / Math.max(height, 1);
    if (mid < 0.28) return "north";
    if (mid > 0.72) return "south";
    return "";
  }

  function tileLoadOrder(tiles, width, height, view) {
    var directed = !!(view && (view.lookaheadDeg > 0 || view.panSign === 1 || view.panSign === -1));
    var sign = view && view.panSign < 0 ? -1 : 1;
    var pitch = view && view.pitch ? view.pitch : 0;
    var lookPole = pitch > 28 ? "north" : (pitch < -28 ? "south" : "");
    var vu = view && view.u != null ? view.u : 0.5;
    var vv = view && view.v != null ? view.v : 0.5;
    var order = [];
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      var u0 = tile.srcX / width;
      var u1 = (tile.srcX + tile.srcW) / width;
      var v0 = tile.srcY / height;
      var v1 = (tile.srcY + tile.srcH) / height;
      var centerU = (u0 + u1) / 2;
      var centerV = (v0 + v1) / 2;
      var contains = vu >= u0 && vu <= u1 && vv >= v0 && vv <= v1;
      var hits = !!(view && tileInView(tile, width, height, view));
      var pole = tilePole(tile, height);
      var lead = directed && view ? panLeadDeg(centerU, vu, sign) : 0;
      var dist = uDist(centerU, vu) + Math.abs(centerV - vv);
      var looking = !!lookPole;
      var rank = looking ? 4 : 3;
      if (lookPole && pole === lookPole) rank = 0;
      else if (contains || hits) rank = looking ? 1 : 0;
      else if (!pole && lead >= -0.5) rank = looking ? 2 : 1;
      else if (!pole) rank = looking ? 3 : 2;
      var sortLead = dist;
      if (rank === 1) sortLead = lead >= 0 ? lead : lead + 360;
      else if (rank === 2) sortLead = lead < 0 ? -lead : lead;
      else if (rank === 3) sortLead = Math.abs(centerV - 0.5);
      order.push({ index: i, rank: rank, lead: sortLead, dist: dist });
    }
    order.sort(function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.lead !== b.lead) return a.lead - b.lead;
      if (a.dist !== b.dist) return a.dist - b.dist;
      return a.index - b.index;
    });
    return order.map(function (item) { return item.index; });
  }

  function smoothstep(edge0, edge1, x) {
    var span = edge1 - edge0;
    var t = span ? (x - edge0) / span : (x >= edge1 ? 1 : 0);
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return t * t * (3 - 2 * t);
  }

  function focusMask(u, v, tile, spanW, spanH, reveal, neighbors) {
    neighbors = neighbors || {};
    var left = neighbors.left == null ? 1 : neighbors.left;
    var right = neighbors.right == null ? 1 : neighbors.right;
    var up = neighbors.up == null ? 1 : neighbors.up;
    var down = neighbors.down == null ? 1 : neighbors.down;
    var u0 = tile.srcX / spanW;
    var u1 = (tile.srcX + tile.srcW) / spanW;
    var v0 = tile.srcY / spanH;
    var v1 = (tile.srcY + tile.srcH) / spanH;
    var cu = (u0 + u1) / 2;
    var cv = (v0 + v1) / 2;
    var halfU = Math.max((u1 - u0) / 2, 1e-4);
    var halfV = Math.max((v1 - v0) / 2, 1e-4);
    var du = u - cu;
    du = ((du + 0.5) % 1 + 1) % 1 - 0.5;
    var dv = v - cv;
    var dist = Math.sqrt(Math.pow(du / halfU, 2) + Math.pow(dv / halfV, 2));
    var t = reveal > 0 ? reveal : 0;
    if (t > 1) t = 1;
    var radius = t * 3.4;
    var feather = 1.7;
    var inner = radius - feather;
    var outer = radius + feather;
    var fx = (dist - inner) / Math.max(outer - inner, 1e-4);
    if (fx < 0) fx = 0;
    if (fx > 1) fx = 1;
    var herm = fx * fx * (3 - 2 * fx);
    var radial = (1 - herm) * smoothstep(0.02, 0.2, t);
    var sx = (u - u0) / Math.max(u1 - u0, 1e-4);
    var sy = (v - v0) / Math.max(v1 - v0, 1e-4);
    if (sx < 0) sx = 0;
    if (sx > 1) sx = 1;
    if (sy < 0) sy = 0;
    if (sy > 1) sy = 1;
    function edge(x, open) {
      return smoothstep(0, 0.46, x) * (1 - open) + open;
    }
    var mask = radial * edge(sx, left) * edge(1 - sx, right) * edge(sy, up) * edge(1 - sy, down);
    var done = smoothstep(0.9, 1, t) * Math.min(left, right, up, down);
    return mask * (1 - done) + done;
  }

  function standbyAllowance(cap, used) {
    return Math.max(0, cap - (used || 0));
  }

  function receiverStartup() {
    return {
      disableIdleTimeout: true,
      maxInactivity: 86400,
      skipMplLoad: false,
      streamType: "LIVE",
      heartbeatMs: IDLE_HEARTBEAT_MS,
      contentId: "spsphere-show",
    };
  }

  function IdleGuard(clock) {
    this.clock = clock || function () { return Date.now(); };
    this.state = "IDLE";
    this.shown = false;
    this.paused = false;
    this.lastStatus = 0;
    this.sent = 0;
  }

  IdleGuard.prototype.show = function () {
    this.shown = true;
    this.state = this.paused ? "PAUSED" : "PLAYING";
    this.lastStatus = this.clock();
  };

  IdleGuard.prototype.play = function () {
    this.paused = false;
    if (this.shown) this.state = "PLAYING";
  };

  IdleGuard.prototype.pause = function () {
    this.paused = true;
    if (this.shown) this.state = "PAUSED";
  };

  IdleGuard.prototype.stop = function () {
    this.shown = false;
    this.state = "IDLE";
  };

  IdleGuard.prototype.touch = function () {
    this.lastStatus = this.clock();
    if (this.shown) this.state = this.paused ? "PAUSED" : "PLAYING";
  };

  IdleGuard.prototype.tick = function () {
    if (!this.shown) return false;
    var t = this.clock();
    if (t - this.lastStatus < IDLE_HEARTBEAT_MS) return false;
    this.lastStatus = t;
    this.state = this.paused ? "PAUSED" : "PLAYING";
    this.sent += 1;
    return true;
  };

  function springSettled(value, target, vel) {
    return Math.abs(value - target) < 1e-3 && Math.abs(vel || 0) < 1e-3;
  }

  function isGpuSource(img) {
    if (!img || typeof img !== "object") return false;
    if (img._deferUpload) return true;
    if (typeof HTMLCanvasElement !== "undefined" && img instanceof HTMLCanvasElement) return true;
    if (typeof HTMLImageElement !== "undefined" && img instanceof HTMLImageElement) return true;
    if (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) return true;
    if (typeof OffscreenCanvas !== "undefined" && img instanceof OffscreenCanvas) return true;
    return false;
  }

  function pieceReady(piece) {
    if (!piece || !piece.tex || !piece.tile) return false;
    var tex = piece.tex;
    if (tex.deferred || tex._evicted || tex.oom) return false;
    if (tex._window && tex._window.full === false) return false;
    if (tex._mip !== true) return false;
    return true;
  }

  function swapReady(session) {
    if (sessionReady(session)) return true;
    if (!(session && session._viewCovered && session._viewCovered())) return false;
    if (session._lookaheadCovered && !session._lookaheadCovered()) return false;
    return true;
  }

  function sessionReady(session) {
    if (!session || !session.entry || !session.entry.tiles || !session.entry.tiles.length) return false;
    var tiles = session.entry.tiles;
    var loaded = session.loaded || [];
    for (var i = 0; i < tiles.length; i++) {
      var found = null;
      for (var j = 0; j < loaded.length; j++) {
        if (loaded[j] && loaded[j].tile && loaded[j].tile.id === tiles[i].id) {
          found = loaded[j];
          break;
        }
      }
      if (!pieceReady(found)) return false;
    }
    return coversSphere(tiles, session.entry.width, session.entry.height);
  }

  var trackedUrls = [];

  function trackUrl(url) {
    if (url) trackedUrls.push(url);
  }

  function revokeUrl(url) {
    if (!url) return;
    try { URL.revokeObjectURL(url); } catch (error) {}
    for (var i = trackedUrls.length - 1; i >= 0; i--) {
      if (trackedUrls[i] === url) trackedUrls.splice(i, 1);
    }
  }

  function revokeTrackedUrls() {
    for (var i = 0; i < trackedUrls.length; i++) {
      try { URL.revokeObjectURL(trackedUrls[i]); } catch (error) {}
    }
    trackedUrls = [];
  }

  function trackedUrlCount() {
    return trackedUrls.length;
  }

  function paceDt(ema, debt, raw) {
    if (!(raw > 0)) return { ema: ema || 0, debt: debt || 0, step: 0 };
    var next = ema > 0 ? ema * 0.75 + raw * 0.25 : raw;
    var step = next;
    var carried = (debt || 0) + raw - step;
    var repay = carried * 0.25;
    var cap = step * 0.5;
    if (repay > cap) repay = cap;
    if (repay < -cap) repay = -cap;
    return { ema: next, debt: carried - repay, step: step + repay };
  }

  function snapAlphas(ms, duration, haveNew) {
    var dur = duration > 0 ? duration : SNAP_FADE_MS;
    if (!haveNew) return { clear: false, newAlpha: 0, snapAlpha: 1 };
    var t = Math.max(0, Math.min(1, (ms || 0) / dur));
    return { clear: true, newAlpha: 1, snapAlpha: 1 - t };
  }

  function memoryCleared(usage) {
    if (!usage) return false;
    return usage.gpuBytes === 0 && (usage.snapBytes || 0) === 0 && usage.textures === 0 && usage.objectUrls === 0 &&
      usage.pendingUploads === 0 && usage.pendingDecodes === 0 && usage.snap === false;
  }

  function mipsReady(box) {
    var count = box && box.mipCount | 0;
    if (!(count > 0)) return true;
    for (var level = 1; level <= count; level++) {
      if (!box.mipPayload || !box.mipPayload[level]) return false;
    }
    return true;
  }

  var frustumScratchA = new Float32Array(16);
  var frustumScratchB = new Float32Array(16);
  var frustumScratchC = new Float32Array(16);
  var frustumView = new Float32Array(16);
  var frustumProj = new Float32Array(16);
  var frustumMvp = new Float32Array(16);

  function lookOf(view) {
    var pitch = view.pitch;
    var yaw = view.yaw;
    if (pitch == null) pitch = view.v != null ? (0.5 - view.v) * 180 : 0;
    if (yaw == null) yaw = view.u != null ? (view.u - 0.5) * 360 : 0;
    var fov = view.fov;
    if (!(fov > 0)) fov = view.halfV > 0 ? view.halfV * 360 : 75;
    var aspect = view.aspect;
    if (!(aspect > 0)) {
      if (view.halfU > 0 && view.halfV > 0) {
        var halfVRad = view.halfV * Math.PI;
        var tanV = Math.tan(halfVRad);
        aspect = tanV > 1e-6 ? Math.tan(view.halfU * Math.PI * 2) / tanV : 1;
      } else {
        aspect = 16 / 9;
      }
    }
    if (!(aspect > 0)) aspect = 1;
    return { yaw: yaw || 0, pitch: pitch || 0, roll: view.roll || 0, fov: fov, aspect: aspect };
  }

  function buildFrustum(look) {
    fillAimView(frustumScratchA, frustumScratchB, frustumScratchC, frustumView, look.yaw, look.pitch, look.roll);
    fillPerspective(frustumProj, look.fov + FRUSTUM_MARGIN_DEG, look.aspect, 0.05, 20);
    multiplyInto(frustumMvp, frustumProj, frustumView);
    var m = frustumMvp;
    function plane(a, b, c, d) {
      var len = Math.hypot(a, b, c) || 1;
      return new Float32Array([a / len, b / len, c / len, d / len]);
    }
    // clip = mvp * p. Inside is clip.w ± clip.xyz >= 0.
    var r0 = [m[0], m[4], m[8], m[12]];
    var r1 = [m[1], m[5], m[9], m[13]];
    var r2 = [m[2], m[6], m[10], m[14]];
    var r3 = [m[3], m[7], m[11], m[15]];
    return [
      plane(r3[0] + r0[0], r3[1] + r0[1], r3[2] + r0[2], r3[3] + r0[3]),
      plane(r3[0] - r0[0], r3[1] - r0[1], r3[2] - r0[2], r3[3] - r0[3]),
      plane(r3[0] + r1[0], r3[1] + r1[1], r3[2] + r1[2], r3[3] + r1[3]),
      plane(r3[0] - r1[0], r3[1] - r1[1], r3[2] - r1[2], r3[3] - r1[3]),
      plane(r3[0] + r2[0], r3[1] + r2[1], r3[2] + r2[2], r3[3] + r2[3]),
      plane(r3[0] - r2[0], r3[1] - r2[1], r3[2] - r2[2], r3[3] - r2[3]),
    ];
  }

  function frustumOf(view, look) {
    var key = look.yaw + "|" + look.pitch + "|" + look.roll + "|" + look.fov + "|" + look.aspect;
    if (view._frustumKey === key && view._frustum) return view._frustum;
    var planes = buildFrustum(look);
    view._frustumKey = key;
    view._frustum = planes;
    return planes;
  }

  var PATCH_LAT_CELLS = 6;
  var PATCH_LON_CELLS = 8;

  function patchCells(tile, width, height) {
    if (tile._cells && tile._cellsW === width && tile._cellsH === height) return tile._cells;
    var u0 = tile.srcX / width;
    var u1 = (tile.srcX + tile.srcW) / width;
    var v0 = tile.srcY / height;
    var v1 = (tile.srcY + tile.srcH) / height;
    var cells = new Float32Array(PATCH_LAT_CELLS * PATCH_LON_CELLS * 6);
    var n = 0;
    var pad = 0.035;
    for (var lat = 0; lat < PATCH_LAT_CELLS; lat++) {
      var va = v0 + (v1 - v0) * (lat / PATCH_LAT_CELLS);
      var vb = v0 + (v1 - v0) * ((lat + 1) / PATCH_LAT_CELLS);
      for (var lon = 0; lon < PATCH_LON_CELLS; lon++) {
        var ua = u0 + (u1 - u0) * (lon / PATCH_LON_CELLS);
        var ub = u0 + (u1 - u0) * ((lon + 1) / PATCH_LON_CELLS);
        var minX = Infinity;
        var minY = Infinity;
        var minZ = Infinity;
        var maxX = -Infinity;
        var maxY = -Infinity;
        var maxZ = -Infinity;
        for (var s = 0; s <= 2; s++) {
          var v = va + (vb - va) * (s / 2);
          var latRad = (0.5 - v) * Math.PI;
          var cosLat = Math.cos(latRad);
          var sinLat = Math.sin(latRad);
          for (var t = 0; t <= 2; t++) {
            var u = ua + (ub - ua) * (t / 2);
            var lonRad = (u - 0.5) * Math.PI * 2;
            var x = Math.sin(lonRad) * cosLat;
            var y = sinLat;
            var z = -Math.cos(lonRad) * cosLat;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (z < minZ) minZ = z;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            if (z > maxZ) maxZ = z;
          }
        }
        cells[n++] = minX - pad;
        cells[n++] = minY - pad;
        cells[n++] = minZ - pad;
        cells[n++] = maxX + pad;
        cells[n++] = maxY + pad;
        cells[n++] = maxZ + pad;
      }
    }
    tile._cells = cells;
    tile._cellsW = width;
    tile._cellsH = height;
    return cells;
  }

  function cellOutsideFrustum(cells, offset, planes) {
    var x0 = cells[offset];
    var y0 = cells[offset + 1];
    var z0 = cells[offset + 2];
    var x1 = cells[offset + 3];
    var y1 = cells[offset + 4];
    var z1 = cells[offset + 5];
    for (var i = 0; i < planes.length; i++) {
      var p = planes[i];
      var x = p[0] >= 0 ? x1 : x0;
      var y = p[1] >= 0 ? y1 : y0;
      var z = p[2] >= 0 ? z1 : z0;
      if (p[0] * x + p[1] * y + p[2] * z + p[3] < 0) return true;
    }
    return false;
  }

  function patchHitsFrustum(tile, width, height, planes) {
    var cells = patchCells(tile, width, height);
    for (var i = 0; i < cells.length; i += 6) {
      if (!cellOutsideFrustum(cells, i, planes)) return true;
    }
    return false;
  }

  function reachesPole(look, north) {
    var half = look.fov / 2 + POLE_MARGIN_DEG;
    if (north) return look.pitch + half >= 90;
    return look.pitch - half <= -90;
  }

  function tileInView(tile, width, height, view) {
    if (!tile || !(width > 0) || !(height > 0) || !view) return true;
    var u0 = tile.srcX / width;
    var u1 = (tile.srcX + tile.srcW) / width;
    var v0 = tile.srcY / height;
    var v1 = (tile.srcY + tile.srcH) / height;
    if (!(u1 > u0) || !(v1 > v0)) return false;
    var look = lookOf(view);
    var north = v0 <= 1e-6;
    var south = v1 >= 1 - 1e-6;
    if ((north && reachesPole(look, true)) || (south && reachesPole(look, false))) return true;
    return patchHitsFrustum(tile, width, height, frustumOf(view, look));
  }

  function eyeToWorld(yaw, pitch, roll, fov, aspect, ndcX, ndcY) {
    var t = Math.tan((fov * Math.PI / 180) / 2);
    var ex = ndcX * aspect * t;
    var ey = ndcY * t;
    var ez = -1;
    fillAimView(frustumScratchA, frustumScratchB, frustumScratchC, frustumView, yaw, pitch, roll);
    return {
      x: frustumView[0] * ex + frustumView[1] * ey + frustumView[2] * ez,
      y: frustumView[4] * ex + frustumView[5] * ey + frustumView[6] * ez,
      z: frustumView[8] * ex + frustumView[9] * ey + frustumView[10] * ez,
    };
  }

  function dirToUv(x, y, z) {
    var len = Math.hypot(x, y, z) || 1;
    x /= len;
    y /= len;
    z /= len;
    var lon = Math.atan2(x, -z);
    var lat = Math.asin(clamp(y, -1, 1));
    var u = 0.5 + lon / (Math.PI * 2);
    u -= Math.floor(u);
    var v = 0.5 - lat / Math.PI;
    if (v < 0) v = 0;
    if (v > 1) v = 1;
    return { u: u, v: v };
  }

  function rayCovered(tiles, width, height, uv, view) {
    var atNorth = uv.v <= 0.002;
    var atSouth = uv.v >= 0.998;
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      var u0 = tile.srcX / width;
      var u1 = (tile.srcX + tile.srcW) / width;
      var v0 = tile.srcY / height;
      var v1 = (tile.srcY + tile.srcH) / height;
      var inV = uv.v >= v0 - 1e-4 && uv.v <= v1 + 1e-4;
      if (atNorth) inV = v0 <= 1e-4;
      if (atSouth) inV = v1 >= 1 - 1e-4;
      if (!inV) continue;
      var inU = atNorth || atSouth || (uv.u >= u0 - 1e-4 && uv.u <= u1 + 1e-4);
      if (!inU) continue;
      if (tileInView(tile, width, height, view)) return true;
    }
    return false;
  }

  function coverageMisses(tiles, width, height, yaw, pitch, fov, aspect) {
    var misses = 0;
    var first = "";
    var cols = 13;
    var rows = 9;
    var view = { yaw: yaw, pitch: pitch, roll: 0, fov: fov, aspect: aspect };
    var samples = cols * rows;
    for (var j = 0; j < rows; j++) {
      var ndcY = -0.92 + 1.84 * (j / (rows - 1));
      for (var i = 0; i < cols; i++) {
        var ndcX = -0.92 + 1.84 * (i / (cols - 1));
        var dir = eyeToWorld(yaw, pitch, 0, fov, aspect, ndcX, ndcY);
        var uv = dirToUv(dir.x, dir.y, dir.z);
        if (rayCovered(tiles, width, height, uv, view)) continue;
        misses++;
        if (!first) {
          first = "yaw " + yaw + " pitch " + pitch + " fov " + fov +
            " ndc " + ndcX.toFixed(2) + "," + ndcY.toFixed(2) +
            " uv " + uv.u.toFixed(3) + "," + uv.v.toFixed(3);
        }
      }
    }
    return { misses: misses, first: first, samples: samples };
  }

  function tilePatch(tile, width, height) {
    var u0 = tile.srcX / Math.max(width, 1);
    var u1 = (tile.srcX + tile.srcW) / Math.max(width, 1);
    var v0 = tile.srcY / Math.max(height, 1);
    var v1 = (tile.srcY + tile.srcH) / Math.max(height, 1);
    var lonBands = 24;
    var latBands = 12;
    var pos = [];
    var ind = [];
    for (var lat = 0; lat <= latBands; lat++) {
      var v = v0 + (v1 - v0) * (lat / latBands);
      var latRad = (0.5 - v) * Math.PI;
      var cosLat = Math.cos(latRad);
      var sinLat = Math.sin(latRad);
      for (var lon = 0; lon <= lonBands; lon++) {
        var u = u0 + (u1 - u0) * (lon / lonBands);
        var lonRad = (u - 0.5) * Math.PI * 2;
        pos.push(Math.sin(lonRad) * cosLat, sinLat, -Math.cos(lonRad) * cosLat, u, v);
      }
    }
    var stride = lonBands + 1;
    for (var y = 0; y < latBands; y++) {
      for (var x = 0; x < lonBands; x++) {
        var a = y * stride + x;
        var b = a + stride;
        ind.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    return {
      interleaved: new Float32Array(pos),
      indices: new Uint16Array(ind),
      count: ind.length,
    };
  }

  function compositeAlphas(fadeMs, haveOld, haveNew) {
    if (!haveOld && !haveNew) return { clear: false, oldAlpha: 0, newAlpha: 0 };
    if (!haveOld) return { clear: true, oldAlpha: 0, newAlpha: 1 };
    var t = haveNew ? Math.max(0, Math.min(1, (fadeMs || 0) / TILE_FADE_MS)) : 0;
    return { clear: true, oldAlpha: 1, newAlpha: t };
  }

  root.SpsphereCast = {
    ROTATIONS: ROTATIONS,
    DEFAULT_DPS: DEFAULT_DPS,
    CROSSFADE_MS: CROSSFADE_MS,
    TILE_FADE_MS: TILE_FADE_MS,
    FOCUS_MS: FOCUS_MS,
    focusMask: focusMask,
    tilePole: tilePole,
    materializeJpeg: materializeJpeg,
    SNAP_FADE_MS: SNAP_FADE_MS,
    SENDER_TIMEOUT_MS: SENDER_TIMEOUT_MS,
    GPU_CAP: GPU_CAP,
    OMEGA: OMEGA,
    tileLoadOrder: tileLoadOrder,
    panLookaheadDeg: panLookaheadDeg,
    panLeadDeg: panLeadDeg,
    BASE_BYTES: BASE_BYTES,
    standbyAllowance: standbyAllowance,
    receiverStartup: receiverStartup,
    IdleGuard: IdleGuard,
    decodeAim: decodeAim,
    decodeSkip: decodeSkip,
    acceptCastMessage: acceptCastMessage,
    acceptAimSocket: acceptAimSocket,
    httpUrl: httpUrl,
    stepIndex: stepIndex,
    applyPose: applyPose,
    tileTexCoord: tileTexCoord,
    coversSphere: coversSphere,
    sessionReady: sessionReady,
    compositeAlphas: compositeAlphas,
    snapAlphas: snapAlphas,
    paceDt: paceDt,
    PITCH_LIMIT: PITCH_LIMIT,
    tileInView: tileInView,
    coverageMisses: coverageMisses,
    tilePatch: tilePatch,
    tileInResidentBand: tileInResidentBand,
    overviewSample: overviewSample,
    brokenOverviewSample: brokenOverviewSample,
    overviewUniforms: overviewUniforms,
    loadingProfile: loadingProfile,
    memoryCleared: memoryCleared,
    trackUrl: trackUrl,
    viewCenterUv: viewCenterUv,
    planResidence: planResidence,
    backingStoreSize: backingStoreSize,
    potSize: potSize,
    sphere: sphere,
    create: function (canvas) { return new Player(canvas); },
    createSession: function (hooks) { return new PhotoSession(hooks); },
  };
})(window);
