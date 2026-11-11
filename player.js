/* SPsphere Cast receiver player.
   Two full yaw turns at the horizon, then the next photo.
   One photo keeps turning. Timing matches CastTiming.kt (9°/s).
   Manual aim springs toward the phone. Yaw is the heading change since
   the first sample of that hold. Pitch and roll are gravity. A new
   anchor on every sample would freeze yaw.
   GPano PosePitchDegrees and PoseRollDegrees level the sphere before that
   look, matching ProjectionMath.applyPose. The phone bakes cubemaps to
   equirect JPEGs with the standard face orientation, so this page samples
   equirects only. Level-0 strips are 120° wide and one latitude band tall,
   with a 32px gutter, up to the TV's texture edge. The phone sends a 64×32
   overview of the whole photo first. That sphere stays up wherever a sharp
   strip is not resident, so the clear color never shows. Auto-pan loads the
   0° horizon strip first and cascades toward the poles. Steering loads the
   strip at the center of the screen first, keeps every strip of this photo,
   and does not preload the next one. A manual Next or Previous cuts to the
   overview immediately.
   The screen has no counters. */
(function (root) {
  // Baked into player.js and the script URL. A Cast WebView that cached
  // "player.js" will not reuse that file for "player.js?v=<this>".
  var RECEIVER_BUILD = "20261111.5";
  var ROTATIONS = 2;
  var FULL_TURN = 360;
  var DEFAULT_DPS = 9;
  var CROSSFADE_MS = 1200;
  // Photo-to-photo fade from the 2:38 PM restore point.
  var TILE_FADE_MS = 2400;
  var SNAP_FADE_MS = 1200;
  var SNAP_W = 1920;
  var SNAP_H = 1080;
  var OUTPUT_W = 1920;
  var OUTPUT_H = 1080;
  var SENDER_TIMEOUT_MS = 45000;
  var UPLOAD_BUDGET_MS = 4;
  var GPU_CAP = 384 * 1024 * 1024;
  var IDLE_HEARTBEAT_MS = 15000;
  // NanoWSD's read loop blocks on the HTTP socket. This app closes that
  // read after 30s of silence (the /aim drop is 30.0s after the last frame).
  // Stay under that, and under NanoHTTPD's 5s stock SOCKET_READ_TIMEOUT.
  var AIM_KEEPALIVE_MS = 10000;
  var CPU_EQUIRECT_MAX_W = 8192;
  var CPU_EQUIRECT_MAX_H = 4096;
  var CPU_VIEW_MAX_W = 1920;
  var CPU_VIEW_MAX_H = 1080;
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
  var AHEAD_REQUESTS = 2;
  // Once a LAN JPEG has actually arrived, keep a few strips in flight.
  var LAN_AHEAD = 4;
  // One slow JPEG is not a dead phone. That tile falls back to Cast, and
  // Wi-Fi stays up until four misses in a row. A proven LAN waits longer.
  var LAN_PROBE_TIMEOUT_MS = 5000;
  var LAN_TIMEOUT_MS = 8000;
  var LAN_FAIL_LIMIT = 4;
  // A single decode, fetch, or stall must not blank the horizon. Each strip
  // is asked again at least this many times, over Cast, before it is skipped.
  var TILE_RETRIES = 3;
  // How long one strip moves from the master edge toward the far edge.
  // The next band joins at 0.35. The soft band is 0.65 of a strip wide.
  // 0.35 + 0.65 = 1, so the seam is one continuous wave.
  var FOCUS_MS = 1800;
  var FOCUS_FEATHER = 0.65;
  var FOCUS_HANDOFF = 0.35;
  var REVEAL_HANDOFF = FOCUS_HANDOFF;
  var STRIP_LOOKAHEAD_DEG = 55;
  var GEO_MS = 3200;
  var INTRO_FADE_MS = 700;
  var INTRO_CAP_MS = 8000;
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

  function privateLanHost(url) {
    var match = /^http:\/\/([^\/:]+)/i.exec(url || "");
    if (!match) return false;
    var host = match[1];
    if (host === "localhost" || host === "127.0.0.1") return true;
    if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
    return /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  }

  function shouldTryLan(lan, dead, url) {
    return !!lan && !dead && privateLanHost(url);
  }

  function loadHttpJpeg(url, timeoutMs, done) {
    var finished = false;
    var timer = 0;
    function finish(err, img) {
      if (finished) return;
      finished = true;
      if (timer && typeof clearTimeout === "function") clearTimeout(timer);
      done(err, img);
    }
    if (typeof setTimeout === "function") {
      timer = setTimeout(function () { finish(new Error("lan timeout")); }, timeoutMs > 0 ? timeoutMs : 2200);
    }
    function fromImage(blob) {
      if (typeof Image === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) {
        finish(new Error("no image"));
        return;
      }
      var img = new Image();
      var objectUrl = "";
      try { objectUrl = URL.createObjectURL(blob); } catch (error) { finish(error); return; }
      img.onload = function () {
        try { URL.revokeObjectURL(objectUrl); } catch (error) {}
        finish(null, img);
      };
      img.onerror = function () {
        try { URL.revokeObjectURL(objectUrl); } catch (error) {}
        finish(new Error("image"));
      };
      img.src = objectUrl;
    }
    function fromBlob(blob) {
      if (typeof createImageBitmap === "function") {
        var pending;
        try { pending = createImageBitmap(blob); } catch (error) { fromImage(blob); return; }
        pending.then(function (bitmap) {
          if (!bitmap || !(bitmap.width > 0) || !(bitmap.height > 0)) {
            try { if (bitmap && bitmap.close) bitmap.close(); } catch (error) {}
            fromImage(blob);
            return;
          }
          finish(null, bitmap);
        }, function () { fromImage(blob); });
        return;
      }
      fromImage(blob);
    }
    function fromRemoteImage() {
      // fetch() of http:// from an https receiver is mixed active content and
      // fails immediately. An image element is mixed passive content and is
      // the path Chromium may still allow.
      if (typeof Image === "undefined") {
        finish(new Error("no image"));
        return;
      }
      var img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = function () { finish(null, img); };
      img.onerror = function () { finish(new Error("image")); };
      img.src = url;
    }
    var pageHttps = false;
    try {
      pageHttps = typeof location !== "undefined" && location && location.protocol === "https:" &&
        /^http:\/\//i.test(String(url || ""));
    } catch (error) { pageHttps = false; }
    if (pageHttps || typeof fetch !== "function") {
      fromRemoteImage();
      return;
    }
    var pendingFetch;
    try { pendingFetch = fetch(url, { mode: "cors", cache: "no-store", credentials: "omit" }); }
    catch (error) { fromRemoteImage(); return; }
    pendingFetch.then(function (res) {
      if (!res || !res.ok) throw new Error("lan");
      return res.blob();
    }).then(fromBlob, function () { fromRemoteImage(); });
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
    this._uploadPath = "dom";
    this._cpuTiles = false;
    this._typedUploadOk = null;
    this._domUploadOk = null;
    this._uploadFailLogs = 0;
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

  Player.prototype._sameLiveShow = function (entries) {
    if (!entries || !this.ids || entries.length !== this.ids.length || !entries.length) return false;
    for (var i = 0; i < entries.length; i++) {
      if (String(entries[i].id) !== String(this.ids[i])) return false;
    }
    var inflight = 0;
    if (this.session && this.session._inFlight) inflight += this.session._inFlight();
    if (this._standby && this._standby._inFlight) inflight += this._standby._inFlight();
    if (this._back && this._back._inFlight) inflight += this._back._inFlight();
    return !!(this._shownFirstPhoto || inflight > 0 || (this._diagRequested || 0) > 0);
  };

  Player.prototype.setQueue = function (urls) {
    var entries = normalizeEntries(urls);
    var self = this;
    var now = this._clock();
    var sameQueue = !!(
      this.ids &&
      entries.length > 0 &&
      this.ids.length === entries.length &&
      this.ids[0] === entries[0].id &&
      this.ids.every(function (id, idx) { return id === entries[idx].id; })
    );
    var activeLoad = !!(
      this._shownFirstPhoto ||
      this._presented ||
      this._inflight > 0 ||
      (this._tileOrder && Object.keys(this._tileOrder).length > 0) ||
      (this._tileDraw && this._tileDraw.length > 0) ||
      (this.session && (
        this.session.shown ||
        this.session.pending ||
        (this.session._inFlight && this.session._inFlight() > 0) ||
        (this.session.loaded && this.session.loaded.length > 0) ||
        Object.keys(this.session.assemblers || {}).length > 0
      )) ||
      this._diagRequested > 0 ||
      this._loaded > 0
    );
    if (sameQueue && activeLoad && (!this._lastQueueAt || now - this._lastQueueAt <= 15000)) {
      if (window.__onCastStatus) window.__onCastStatus(this.snapshot());
      else if (window.__castSend) window.__castSend({ type: "status", index: this.index, playing: this.playing, phase: this.phase });
      this._sendDiag(true);
      return false;
    }
    this._lastQueueAt = now;
    if (this.session) {
      this.session.dispose();
      // The phone pushes the overview and the front strip at token 1
      // immediately after this queue message.
      this.session.token = 0;
    }
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
    this._useTiles = entries.some(function (entry) {
      return (entry.tiles && entry.tiles.length) || (entry.overview && entry.overview.url);
    });
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
    this._userAimed = false;
    this.yaw = startingYawForEntry(entries[0]);
    this._panBlend = 1;
    this.held = false;
    this._resetAim();
    this.playing = this.items.length > 0;
    this._last = 0;
    if (this._useTiles) {
      this.images = entries.map(function () { return null; });
      this._busy = false;
      this._intro = "hold";
      this._introAlpha = 1;
      this._introSince = this._clock();
      this._geoAt = 0;
      this._diagRequested = 0;
      this._diagReceived = 0;
      this._diagDecoded = 0;
      this._diagUploaded = 0;
      this._diagErrors = 0;
    this._diagNote = "";
    this._diagKey = "";
    // setLan() runs before setQueue(). A new show retries Wi-Fi, and it
    // keeps the flag the queue message just set. The probe starts over.
    this._lanDead = false;
    this._lanFailures = 0;
    this._lanDeadSince = 0;
    this._lanVerified = !!this._lanVerified;
      this._markBusy();
      this._paintMark();
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
    return true;
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
      if ((entry.tiles && entry.tiles.length) || (entry.overview && entry.overview.url)) self._useTiles = true;
      if (self._useTiles) self.images.push(null);
      else self.images.push(self._loadEntry(entry));
    });
    this._preloadAround();
  };

  Player.prototype._dropBaseForId = function (id) {
    var key = String(id);
    if (!this._bases || !this._bases[key]) return;
    var piece = this._bases[key];
    delete this._bases[key];
    if (piece && piece.tex) this._deleteTex(piece.tex);
    if (this._resident && piece && piece.tile) {
      var baseId = piece.tile.id;
      for (var i = this._resident.length - 1; i >= 0; i--) {
        var r = this._resident[i];
        if (r && (r.id === baseId || r.tex === piece.tex)) {
          this._resident.splice(i, 1);
        }
      }
    }
  };

  Player.prototype.removeId = function (id) {
    var targetId = String(id);
    var at = this.ids.indexOf(targetId);
    if (at < 0 || this.ids.length < 2) return false;
    var current = this.ids[this.index];
    var awaitId = (this._awaitingSwap && this._awaitIndex != null && this.ids[this._awaitIndex] != null)
      ? this.ids[this._awaitIndex]
      : null;
    if (this._tex && this._tex[at]) this._deleteTex(this._tex[at]);
    this._dropBaseForId(targetId);
    if (this._standby && this._standby.entry && String(this._standby.entry.id) === targetId) {
      this._standby.dispose();
      this._standby = null;
    }
    if (this._back && this._back.entry && String(this._back.entry.id) === targetId) {
      this._back.dispose();
      this._back = null;
    }
    this.ids.splice(at, 1);
    this.items.splice(at, 1);
    this.images.splice(at, 1);
    this.poses.splice(at, 1);
    this._tex.splice(at, 1);
    if (this.entries) this.entries.splice(at, 1);
    if (awaitId != null) {
      if (awaitId === targetId) {
        this._awaitingSwap = false;
        this._awaitIndex = null;
      } else {
        var nextAwait = this.ids.indexOf(awaitId);
        if (nextAwait >= 0) this._awaitIndex = nextAwait;
        else {
          this._awaitingSwap = false;
          this._awaitIndex = null;
        }
      }
    }
    if (current === targetId) {
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
    var awaitId = (this._awaitingSwap && this._awaitIndex != null && this.ids[this._awaitIndex] != null)
      ? this.ids[this._awaitIndex]
      : null;
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
    if (awaitId != null) {
      var nextAwait = this.ids.indexOf(awaitId);
      if (nextAwait >= 0) this._awaitIndex = nextAwait;
      else {
        this._awaitingSwap = false;
        this._awaitIndex = null;
      }
    }
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

  Player.prototype._isAwaitedPool = function (pool) {
    if (!this._awaitingSwap || this._awaitIndex == null || !pool || !pool.entry) return false;
    var want = this.entries && this.entries[this._awaitIndex];
    return !!(want && String(pool.entry.id) === String(want.id));
  };

  Player.prototype.pause = function (held) {
    this.playing = false;
    if (!this.manual) this._anchored = false;
    if (held) this.held = true;
    if (this._standby && !this._isAwaitedPool(this._standby) && (this._standby.pending || (this._standby._inFlight && this._standby._inFlight() > 0))) {
      this._standby.quietStop();
    }
    if (this._back && !this._isAwaitedPool(this._back) && (this._back.pending || (this._back._inFlight && this._back._inFlight() > 0))) {
      this._back.quietStop();
    }
    if (this._pruneQueues) this._pruneQueues();
    this._mark();
  };

  Player.prototype._mark = function () {
    if (typeof document === "undefined") return;
    var icon = document.getElementById("hold");
    if (!icon) return;
    icon.hidden = true;
  };

  Player.prototype._markBusy = function () {
    if (typeof document === "undefined") return;
    var el = document.getElementById("busy");
    if (!el) return;
    if (this._busy) el.classList.add("on");
    else el.classList.remove("on");
  };

  Player.prototype._send = function (msg) {
    if (!window.__castSend) {
      if (!this._outbox) this._outbox = [];
      this._outbox.push(msg);
      if (this._outbox.length > 30) this._outbox.shift();
      return;
    }
    window.__castSend(msg);
  };

  Player.prototype._flushSends = function () {
    var box = this._outbox || [];
    this._outbox = [];
    if (!window.__castSend) {
      this._outbox = box;
      return;
    }
    for (var i = 0; i < box.length; i++) window.__castSend(box[i]);
  };

  // The probe runs when the page is parsed, before the Cast channel exists.
  // Say the build and the probe again when a sender is actually listening,
  // then stop. Canvas logs used to call this every few seconds, which looked
  // like the receiver was reloading.
  Player.prototype.announceBuild = function (force) {
    if (this._buildAnnounced) return;
    this._flushSends();
    // One unforced copy, then one copy when a sender is actually listening.
    // Canvas logs must not print this again every few seconds.
    if (!force && this._announcedAt) return;
    this._announcedAt = Date.now();
    if (!this._probeNote) {
      this._probeNote = withBuild("upload probe skipped reason=" + (this._setupReason || "not-run"));
    }
    this._send({ type: "log", message: "receiver build " + RECEIVER_BUILD });
    this._send({ type: "log", message: this._probeNote });
    if (force) this._buildAnnounced = true;
  };

  Player.prototype._reportTv = function (message) {
    if (!message) return;
    // Failures are the lines the phone keeps. Repeat the build and probe
    // beside them; the copies sent at page load often leave before the
    // sender is recording.
    if (this.announceBuild) this.announceBuild();
    warn(message);
    this._send({ type: "log", message: String(message) });
  };

  Player.prototype._clock = function () {
    if (typeof this._focusNow === "function") return this._focusNow();
    return Date.now();
  };

  Player.prototype._joinedStamp = function (piece, now) {
    var tile = piece && piece.tile;
    if (!tile || tile._base) return now;
    var entry = this.session && this.session.entry;
    if (!entry || !entry.tiles) return now;
    var view = this._lodView();
    var anchor = stripAnchorRow(entry.tiles, entry.height || this._tileH || 1, view);
    if ((tile.row | 0) === anchor) return now;
    var parent = this._pieceAt(tile.col | 0, parentRowOf(tile.row | 0, anchor));
    if (parent && parent._focusAt > 0) return focusJoinAt(piece._uploadedAt, parent._focusAt, now);
    return now;
  };

  Player.prototype._revealOf = function (piece) {
    if (!piece || !piece.tex || piece.tex.deferred || piece.tex._evicted) return 0;
    if (piece._base || (piece.tile && piece.tile._base)) return 1;
    // A half-uploaded strip stays off the sphere so its missing rows are not black.
    if (piece.tex._spsUploaded === false) return 0;
    // A finished strip stays open when the master moves. The amount still
    // follows the clock, so a strip that has not reached the end of its fade
    // is not stuck at 1.
    if (!(piece._focusAt > 0)) {
      if (piece._revealDone) return 1;
      if (!this._fadeOpen(piece)) return 0;
      piece._focusAt = this._joinedStamp(piece, this._clock());
    }
    var now = this._clock();
    if (now < piece._focusAt) return 0;
    var amount = revealProgress(piece._focusAt, now, FOCUS_MS);
    if (amount >= 1) {
      piece._revealDone = true;
      return 1;
    }
    return amount;
  };

  Player.prototype._pieceAt = function (col, row) {
    var lists = [this.session && this.session.loaded, this._tileDraw];
    for (var n = 0; n < lists.length; n++) {
      var list = lists[n];
      if (!list) continue;
      for (var i = 0; i < list.length; i++) {
        var tile = list[i] && list[i].tile;
        if (!tile || tile._base) continue;
        if ((tile.col | 0) === col && (tile.row | 0) === row) return list[i];
      }
    }
    return null;
  };

  Player.prototype._fadeOpen = function (piece) {
    var tile = piece && piece.tile;
    if (!tile || tile._base) return true;
    var entry = this.session && this.session.entry;
    if (!entry || !entry.tiles || !entry.tiles.length) return true;
    var view = this._lodView();
    var anchor = stripAnchorRow(entry.tiles, entry.height || this._tileH || 1, view);
    var self = this;
    return revealUnlocked(tile, entry.tiles, anchor, function (col, row) {
      var parent = self._pieceAt(col, row);
      if (!parent) return 0;
      return self._revealOf(parent);
    });
  };

  Player.prototype._photoSpan = function () {
    // Tiles are stored in photo pixels. Drawing them before the photo is
    // marked shown used a span of 1, so every sharp fragment was discarded
    // and the fade ran on a tile the TV never displayed.
    var w = this._tileW;
    var h = this._tileH;
    var entry = this.session && this.session.entry;
    if (!(w > 0) && entry && entry.width > 0) w = entry.width;
    if (!(h > 0) && entry && entry.height > 0) h = entry.height;
    return { w: w > 0 ? w : 1, h: h > 0 ? h : 1 };
  };

  Player.prototype._geoLinear = function () {
    if (!(this._geoAt > 0)) return 0;
    var t = (this._clock() - this._geoAt) / GEO_MS;
    if (t < 0) return 0;
    if (t > 1) return 1;
    return t;
  };

  Player.prototype._restampFocus = function (now) {
    var lists = [this._tileDraw, this.session && this.session.loaded];
    for (var n = 0; n < lists.length; n++) {
      var list = lists[n];
      if (!list) continue;
      for (var i = 0; i < list.length; i++) {
        var piece = list[i];
        if (!piece || !piece.tex) continue;
        if (piece._base || (piece.tile && piece.tile._base)) continue;
        if (piece._revealDone || piece._focusAt > 0) continue;
        if (!this._fadeOpen(piece)) continue;
        piece._focusAt = this._joinedStamp(piece, now);
      }
    }
  };

  Player.prototype._armBloom = function () {
    var now = this._clock();
    if (this._geoAt > 0 && now - this._geoAt < 40) return;
    this._geoAt = now;
    this._restampFocus(now);
  };

  Player.prototype._finishSession = function (session) {
    var s = session || this.session;
    var entry = s && s.entry;
    var total = (entry && entry.tiles) ? entry.tiles.length : 0;
    var uploaded = 0;
    if (s && s.loaded && s.loaded.length) {
      for (var i = 0; i < s.loaded.length; i++) {
        if (pieceReady(s.loaded[i])) uploaded += 1;
      }
    } else {
      uploaded = this._diagUploaded || 0;
    }
    if ((total <= 0 || uploaded >= total) && this._diagNote === "LAN JPEG unreachable; using Cast messages" && !this._lanDead) {
      this._diagNote = "";
      this._sendDiag(true);
      return true;
    }
    return false;
  };

  Player.prototype._noteUploaded = function (tex) {
    // A Canvas2D tile is on screen because the GPU upload did not succeed.
    // Counting it as uploaded hid the failure and re-armed the backlog reset.
    if (tex && tex._cpu) {
      this._diagErrors = (this._diagErrors || 0) + 1;
      if (!this._diagNote) this._diagNote = this._cpuReason || "texture upload failed; Canvas2D tiles";
      this._sendDiag();
      return;
    }
    if (tex && (tex._spsUploaded || tex._mip === true) && !tex.deferred && !tex.oom && !tex._evicted) {
      this._diagUploaded = (this._diagUploaded || 0) + 1;
      if (this._finishSession(this.session)) return;
    } else {
      this._diagErrors = (this._diagErrors || 0) + 1;
      if (!this._lastUploadFail) {
        var stage = (tex && tex._deferReason) || "unspecified";
        var failW = (tex && tex._srcW) || 0;
        var failH = (tex && tex._srcH) || 0;
        this._lastUploadFail = "texture upload failed stage=" + stage
          + " gl=none"
          + " lost=" + (this._glLost ? "1" : "0")
          + " webgl2=" + (this._webgl2 ? "1" : "0")
          + " size=" + failW + "x" + failH
          + " source=none path=" + (this._uploadPath || "dom");
      }
      this._diagNote = withBuild(this._lastUploadFail);
      this._lastUploadFail = this._diagNote;
      this._reportTv(this._diagNote);
    }
    this._sendDiag();
  };

  Player.prototype._syncDiagToSession = function () {
    var s = this.session;
    if (!s || !s.entry) return;
    var uploaded = 0;
    var loaded = s.loaded || [];
    for (var i = 0; i < loaded.length; i++) {
      if (pieceReady(loaded[i])) uploaded += 1;
    }
    if (s._overviewReady) uploaded += 1;
    var inflight = (s._inFlight ? s._inFlight() : 0) + (s._overviewPending ? 1 : 0);
    if (this._cpuTiles) {
      this._diagRequested = uploaded + inflight;
      this._diagUploaded = 0;
      if (!(this._diagErrors > 0)) this._diagErrors = uploaded;
      if (!this._diagNote) this._diagNote = this._cpuReason || "texture upload failed; Canvas2D tiles";
      this._diagKey = "";
      return;
    }
    this._diagRequested = uploaded + inflight;
    this._diagReceived = uploaded;
    this._diagDecoded = uploaded;
    this._diagUploaded = uploaded;
    this._diagErrors = 0;
    this._diagKey = "";
  };

  Player.prototype._sendDiag = function (force) {
    var msg = {
      type: "diag",
      requested: this._diagRequested || 0,
      received: this._diagReceived || 0,
      decoded: this._diagDecoded || 0,
      uploaded: this._diagUploaded || 0,
      errors: this._diagErrors || 0,
      note: this._diagNote || "",
      build: RECEIVER_BUILD,
    };
    var key = [msg.requested, msg.received, msg.decoded, msg.uploaded, msg.errors, msg.note].join(":");
    var now = this._clock();
    if (!force && key === this._diagKey && now - (this._diagSentAt || 0) < 2000) return;
    this._diagKey = key;
    this._diagSentAt = now;
    this._send(msg);
    if (force) this._checkHealthWatchdog(now);
  };

  function clearTileStops(entry) {
    if (!entry) return;
    var tiles = entry.tiles || [];
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      if (!tile) continue;
      tile._skip = false;
      tile._retries = 0;
      tile._gpuPending = false;
    }
    if (entry.overview) {
      entry.overview._skip = false;
      entry.overview._retries = 0;
      entry.overview._gpuPending = false;
    }
  }

  function sessionHasWork(session) {
    if (!session || !session.entry) return false;
    if (session.pending) return true;
    if (session.loaded && session.loaded.length) return true;
    var tiles = session.entry.tiles || [];
    for (var i = 0; i < tiles.length; i++) {
      if (tiles[i] && tiles[i]._gpuPending) return true;
    }
    return false;
  }

  /**
   * The picture stays. Queues, the next-photo preload, and a dead Wi-Fi
   * flag are dropped so the show can ask for what it is missing again.
   */
  Player.prototype.softReset = function (reason, detail) {
    var now = this._clock();
    var label = (reason === "phone" ? (detail || "phone") : (reason || "auto"));
    this._softResetAt = now;
    this._lastSoftResetAt = now;
    this._softResets = (this._softResets || 0) + 1;
    this._logSwitch("soft-reset", label);
    this._decodeQueue = [];
    this._decodeBusy = false;
    this._decoding = 0;
    this._uploadQueue = [];
    this._uploading = false;
    this._strip = null;
    this._promoting = false;
    this._lodHold = null;
    if (this._standby) {
      clearTileStops(this._standby.entry);
      this._standby.dispose();
      this._standby = null;
    }
    if (this._back) {
      clearTileStops(this._back.entry);
      this._back.dispose();
      this._back = null;
    }
    if (this._resident && this._resident.length) {
      for (var r = this._resident.length - 1; r >= 0; r--) {
        if (this._resident[r] && this._resident[r].standby && this._resident[r].tex) {
          this._deleteTex(this._resident[r].tex);
        }
      }
    }
    this._evictOffscreen();
    this._lanDead = false;
    this._lanFailures = 0;
    this._lanDeadSince = 0;
    this._lanDeadAt = 0;
    this._lanVerified = !!this._lanVerified;
    var kept = 0;
    if (this._tileDraw) {
      for (var d = 0; d < this._tileDraw.length; d++) {
        if (pieceReady(this._tileDraw[d])) kept += 1;
      }
    }
    this._lastSeq = -1;
    this._diagRequested = kept;
    this._diagReceived = kept;
    this._diagDecoded = kept;
    this._diagUploaded = kept;
    this._diagErrors = 0;
    this._diagNote = "";
    this._diagKey = "";
    var session = this.session;
    if (session) {
      session._tokenEpoch = (session._tokenEpoch || 0) + 1;
      session._openTokens = {};
      session.assemblers = {};
      session._materializing = {};
      session.pending = null;
      session.budgetFull = false;
      session.preloadCapped = false;
      session._reqCount = {};
      clearTileStops(session.entry);
      if (session.entry && !sessionReady(session)) {
        if (!session._overviewReady && session.entry.overview && session._beginOverview) {
          session._beginOverview();
        }
        if (session._requestCurrent) session._requestCurrent();
      }
    }
    var doneLabel = (reason === "phone" ? (detail || "phone") : (reason || "manual"));
    if (reason === "phone") {
      if (typeof console !== "undefined" && console.info) {
        console.info("tv soft-reset complete (" + doneLabel + ")");
      }
    } else if (window.__castSend) {
      window.__castSend({ type: "soft-reset", reason: reason || "watchdog", index: this.index });
    }
    this._diagErrors = 0;
    this._diagNote = "";
    this._sendDiag(true);
    this._send({ type: "log", message: "tv soft-reset complete (" + doneLabel + ")" });
    return true;
  };

  Player.prototype._checkHealthWatchdog = function (now) {
    now = now || this._clock();
    if (this._softResetAt && now - this._softResetAt < 8000) return false;
    if (!this.session || !this.items || !this.items.length) return false;
    var requested = this._diagRequested || 0;
    var uploaded = this._diagUploaded || 0;
    var reason = "";
    if (requested - uploaded > 28) reason = "tile-backlog";
    else if (requested > 45) reason = "request-storm";
    else if (this._decodeQueue && this._decodeQueue.length > 16) reason = "decode-backlog";
    else if (this._uploadQueue && this._uploadQueue.length > 16) reason = "upload-backlog";
    else if (this.session.pending && this.session.pending.started > 0 && now - this.session.pending.started > 10000) reason = "wedged-tile";
    else if (this._lan && this._lanDead) {
      if (!this._lanDeadSince) this._lanDeadSince = now;
      if (now - this._lanDeadSince > 12000) reason = "lan-stuck";
      else reason = "";
    } else {
      this._lanDeadSince = 0;
    }
    if (!reason) return false;
    // A bitmap that will not upload must not be fetched again. That loop is
    // what ended the onn session: tile-backlog, then the same failures.
    if (this._repeatUploadReset(reason)) return false;
    this.softReset(reason);
    return true;
  };

  Player.prototype._repeatUploadReset = function (reason) {
    if (reason !== "tile-backlog" && reason !== "upload-backlog" && reason !== "request-storm") return false;
    if (this._cpuTiles) return true;
    var note = this._diagNote || "";
    return note.indexOf("texture upload failed") >= 0;
  };

  Player.prototype._pieceReadyId = function (session, id) {
    var loaded = session && session.loaded;
    if (!loaded) return false;
    for (var i = 0; i < loaded.length; i++) {
      var piece = loaded[i];
      if (!piece || !piece.tile || piece.tile.id !== id) continue;
      if (pieceReady(piece)) return true;
    }
    return false;
  };

  Player.prototype._photoFrontReady = function (session) {
    if (!session || !session._overviewReady || !session.entry) return false;
    var entry = session.entry;
    var tiles = entry.tiles || [];
    if (!tiles.length) return true;
    var view = this._lodView();
    var anchor = stripAnchorRow(tiles, entry.height, view);
    var col = columnAtU(tiles, entry.width, view.u);
    var master = findStrip(tiles, col, anchor);
    if (!master || master._skip) return true;
    return this._pieceReadyId(session, master.id);
  };

  Player.prototype._markWanted = function () {
    if (!this._useTiles || !this.items || !this.items.length) return false;
    // The title card is only the opening of a Cast session. Once a photo
    // has been on screen, a retile, a slide change, or a pan must not
    // bring the black logo back.
    if (this._presented || this._intro === "off" || this._intro === "out") return false;
    if (this._introSince && this.session && this.session._overviewReady &&
        this._clock() - this._introSince > INTRO_CAP_MS) return false;
    return !this._photoFrontReady(this.session);
  };

  Player.prototype._syncMark = function (dt) {
    var want = this._markWanted();
    if (this._presented || this._intro === "off" || this._intro === "out") want = false;
    if (want) {
      this._intro = "hold";
      this._introAlpha = 1;
      if (!this._introSince) this._introSince = this._clock();
    } else if (this._intro === "hold" || this._intro === "out") {
      if (this._intro !== "out") {
        this._intro = "out";
        this._armBloom();
      }
      var step = (dt > 0 ? dt : 16) / INTRO_FADE_MS;
      this._introAlpha = Math.max(0, (this._introAlpha == null ? 1 : this._introAlpha) - step);
      if (this._introAlpha <= 0) {
        this._intro = "off";
        this._introSince = 0;
      }
    } else if (!(this._geoAt > 0) && this._photoFrontReady(this.session)) {
      this._armBloom();
    }
    this._paintMark();
  };

  Player.prototype._paintMark = function () {
    if (typeof document === "undefined") return;
    var el = document.getElementById("mark");
    if (!el) return;
    var show = this._intro === "hold" || (this._intro === "out" && this._introAlpha > 0);
    el.hidden = !show;
    if (!show || !el.style) return;
    el.style.opacity = String(this._intro === "hold" ? 1 : this._introAlpha);
  };

  Player.prototype._neighborReveal = function (tile, dRow, dCol) {
    var found = this._neighborPiece(tile, dRow, dCol);
    if (found === 1) return 1;
    if (!found) return 0;
    return this._revealOf(found);
  };

  Player.prototype._neighborPiece = function (tile, dRow, dCol) {
    if (!tile || !this.session || !this.session.entry) return 1;
    var row = (tile.row | 0) + dRow;
    var col = (tile.col | 0) + dCol;
    var tiles = this.session.entry.tiles || [];
    var loaded = this.session.loaded || [];
    var exists = false;
    var minCol = tile.col | 0;
    var maxCol = tile.col | 0;
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
      if ((other.row | 0) === row && (other.col | 0) === col) return loaded[j];
    }
    return null;
  };

  // 1 when this tile and every tile that touches it have finished opening.
  // The circle stays inside the rectangle until then, so a finished tile
  // does not cut a straight edge into a neighbor that is still soft.
  Player.prototype._mergeAmount = function (piece) {
    if (!piece || !piece.tile || this._revealOf(piece) < 1) {
      if (piece) piece._mergeAt = 0;
      return 0;
    }
    var deltas = [[0, -1], [0, 1], [-1, 0], [1, 0]];
    for (var i = 0; i < deltas.length; i++) {
      var side = this._neighborPiece(piece.tile, deltas[i][0], deltas[i][1]);
      if (side === 1) continue;
      if (!side || this._revealOf(side) < 1) {
        piece._mergeAt = 0;
        return 0;
      }
    }
    if (!(piece._mergeAt > 0)) piece._mergeAt = this._clock();
    var t = (this._clock() - piece._mergeAt) / 360;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return easeInOut(t);
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
    this.halt();
    this.playing = false;
    this.manual = false;
    this.held = false;
    this._userAimed = false;
    this._controllerHold = false;
    this._panBlend = 1;
    this._mark();
    this.items = [];
    this.entries = [];
    this.ids = [];
    this.images = [];
    this.poses = [];
    this._tex = [];
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
    this._presented = false;
    this._intro = "off";
    this._introAlpha = 0;
    this._introSince = 0;
    this._freeGpu();
    this._lastQueueAt = 0;
    this._shownFirstPhoto = false;
    this._diagRequested = 0;
    this._diagReceived = 0;
    this._diagDecoded = 0;
    this._diagUploaded = 0;
    this._diagErrors = 0;
    this._diagNote = "";
    this._diagKey = "";
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

  Player.prototype.setLan = function (on) {
    this._lan = !!on;
    this._lanEnabled = !!on;
    this._lanDead = false;
    this._lanFailures = 0;
    this._lanDeadSince = 0;
    if (!on) {
      this._lanVerified = false;
    } else if (this._diagNote === "LAN JPEG unreachable; using Cast messages") {
      this._diagNote = "";
      this._sendDiag(true);
    }
  };

  Player.prototype._urlFor = function (id) {
    var want = String(id);
    var pools = [this.session, this._standby, this._back];
    for (var p = 0; p < pools.length; p++) {
      var entry = pools[p] && pools[p].entry;
      if (!entry) continue;
      if (entry.overview && String(entry.overview.id) === want && entry.overview.url) return entry.overview.url;
      var tiles = entry.tiles || [];
      for (var i = 0; i < tiles.length; i++) {
        if (tiles[i] && String(tiles[i].id) === want && tiles[i].url) return tiles[i].url;
      }
    }
    return "";
  };

  Player.prototype._poolWithToken = function (id, token) {
    var pools = [this.session, this._standby, this._back];
    for (var i = 0; i < pools.length; i++) {
      var pool = pools[i];
      if (pool && pool.accepts && pool.accepts({ id: id, token: token })) return pool;
    }
    return null;
  };

  Player.prototype._lanTimeoutMs = function () {
    return this._lanVerified ? LAN_TIMEOUT_MS : LAN_PROBE_TIMEOUT_MS;
  };

  Player.prototype._loadLan = function (id, token, url) {
    var self = this;
    var tileId = (id && typeof id === "object") ? id.id : id;
    var tileUrl = url || ((id && typeof id === "object") ? id.url : "");
    var probing = !self._lanVerified;
    var retried = false;
    function attempt(targetUrl) {
      loadHttpJpeg(targetUrl, probing ? LAN_PROBE_TIMEOUT_MS : LAN_TIMEOUT_MS, function (err, img) {
        if (err || !img) {
          try { if (img && img.close) img.close(); } catch (error) {}
          if (self._lanVerified && !retried) {
            retried = true;
            var base = String(tileUrl || "");
            var retryUrl = base + (base.indexOf("?") >= 0 ? "&" : "?") + "retry=1";
            attempt(retryUrl);
            return;
          }
          // This strip goes over Cast. LAN stays up until four misses in a row,
          // so one hiccup does not drag the rest of the photo through the phone.
          self._lanFailures = (self._lanFailures || 0) + 1;
          if (self._lanFailures >= LAN_FAIL_LIMIT) {
            self._lanDead = true;
            if (!self._lanDeadSince) self._lanDeadSince = self._clock();
            self._diagNote = "LAN JPEG unreachable; using Cast messages";
            self._reportTv(self._diagNote);
          }
          self._diagErrors = (self._diagErrors || 0) + 1;
          self._send({
            type: "log",
            message: "lan fetch failed id=" + tileId + " failures=" + self._lanFailures + " dead=" + self._lanDead + " url=" + tileUrl,
          });
          self._send({ type: "fetch", id: tileId, token: token, reason: "lan" });
          self._sendDiag();
          return;
        }
        var hadTrouble = !!(self._lanDead || (self._lanFailures || 0) > 0);
        var hadUnreachableNote = self._diagNote === "LAN JPEG unreachable; using Cast messages";
        self._lanVerified = true;
        self._lanFailures = 0;
        self._lanDead = false;
        self._lanDeadSince = 0;
        if (hadUnreachableNote) {
          self._diagNote = "";
          self._sendDiag(true);
        }
        if (hadTrouble) {
          self._send({ type: "log", message: "lan recovered on " + tileId });
        }
        var pool = self._poolWithToken(tileId, token);
        if (!pool || !pool.noteImage(tileId, token, img)) {
          try { if (img.close) img.close(); } catch (error) {}
          return;
        }
        self._diagReceived = (self._diagReceived || 0) + 1;
        self._diagDecoded = (self._diagDecoded || 0) + 1;
        self._sendDiag(hadUnreachableNote);
      });
    }
    attempt(tileUrl);
  };

  Player.prototype.noteSender = function (now) {
    this._senderSeen = true;
    this._lastSender = now || Date.now();
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
    // A covered front view, or the overview plus the horizon strip, is enough
    // to cut to the next photo. That must not be reported as stalled: a
    // stalled preload used to evict the photo on screen every frame.
    if (swapReady(standby)) return "view-ready";
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

  Player.prototype._openingFetched = function () {
    var session = this.session;
    var entry = session && session.entry;
    if (!entry || !entry.tiles || !entry.tiles.length) return false;
    var view = this._lodView();
    var anchor = stripAnchorRow(entry.tiles, entry.height || this._tileH || 1, view);
    var col = columnAtU(entry.tiles, entry.width || this._tileW || 1, view.u);
    var found = false;
    for (var row = anchor - 1; row <= anchor + 1; row++) {
      var tile = findStrip(entry.tiles, col, row);
      if (!tile || tile._skip) continue;
      found = true;
      if (!this._pieceReadyId(session, tile.id)) return false;
    }
    return found;
  };

  Player.prototype._hasMidBands = function (session) {
    var entry = session && session.entry;
    if (!entry || !entry.tiles) return false;
    var rows = gridStats(entry.tiles).rows;
    if (rows <= 2) return false;
    for (var i = 0; i < entry.tiles.length; i++) {
      var tile = entry.tiles[i];
      if (!tile || tile._base || tile._skip || tile._overview) continue;
      var row = tile.row | 0;
      if (row > 0 && row < rows - 1) return true;
    }
    return false;
  };

  /** Rows between the pole caps, on every column. The screen and the next horizon. */
  Player.prototype._screenStripsReady = function () {
    var session = this.session;
    var entry = session && session.entry;
    if (!entry || !entry.tiles || !entry.tiles.length) return false;
    var rows = gridStats(entry.tiles).rows;
    var found = false;
    for (var i = 0; i < entry.tiles.length; i++) {
      var tile = entry.tiles[i];
      if (!tile || tile._base || tile._overview) continue;
      var row = tile.row | 0;
      if (row <= 0 || row >= rows - 1) continue;
      found = true;
      // A strip that exhausted its retries must not hold the next photo.
      if (tile._skip) continue;
      if (!this._pieceReadyId(session, tile.id)) return false;
    }
    return found;
  };

  Player.prototype._activeBusy = function () {
    var session = this.session;
    if (!session || !session.entry) return false;
    if (sessionReady(session)) return false;
    // The next photo waits until every non-pole strip of both hemispheres
    // is in. Pole caps and the blur fade do not hold that preload.
    if (this._hasMidBands(session)) return !this._screenStripsReady();
    if (session.pending) return true;
    if (session._inFlight && session._inFlight() > 0) return true;
    if (session._pickTile && session._pickTile()) return true;
    return false;
  };

  Player.prototype._feedPreload = function () {
    if (!this._useTiles || !this.playing || this.manual) return;
    // The photo on screen keeps the phone pipe until its strips are in.
    // The next photo starts only after that, or when the turn is over and
    // the show is waiting on the swap.
    if (!this._awaitingSwap && this._activeBusy()) return;
    var why = this._preloadStatus();
    if (why === "ready" || why === "pending" || why === "single") return;
    if (this._preloadLogged !== why) {
      this._preloadLogged = why;
      this._logSwitch("preload", this._preloadDetail());
    }
    // Photo 2 has no strips yet. Evicting and resuming every frame just
    // spins while the phone is still encoding.
    if (why === "next-has-no-tiles") return;
    if (why === "not-started" || why === "standby-other") this._preloadNeighbors();
    var standby = this._standby;
    if (!standby || !standby.entry) return;
    if (why === "view-ready") {
      // The opening view is already on the GPU. Leave the pause in place
      // until the photo swaps. Clearing it here re-fetched the same strip
      // on every frame once the GPU refused another upload.
      return;
    }
    if (why === "budget-full" || why === "preload-cap") {
      var freed = this._evictOffscreen();
      if (!(freed > 0)) return;
      standby.preloadCapped = false;
      standby.budgetFull = false;
      standby.resume();
      return;
    }
    if (why === "stalled") {
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

  Player.prototype._alignStartYaw = function (entry, force) {
    if (!force && (this.manual || this._userAimed)) return;
    var next = entry || (this.entries && this.entries[this.index]);
    this.yaw = startingYawForEntry(next);
    this._panBlend = 1;
    if (this.manual) {
      this._anchored = false;
      this._tyaw = this.yaw;
      this._vy = 0;
    }
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
    this._alignStartYaw(entry, true);
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
      pool._reqCount = {};
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
    this._syncDiagToSession();
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
    if (!msg.anchor && !isNewer(seq, this._lastSeq)) return false;
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
    this._userAimed = true;
    this.playing = false;
    // Steering keeps this photo and drops the next one so the GPU belongs here.
    // The aim message does not reset a strip that has already started to open.
    this._controllerHold = true;
    this._pausePreload();
    if (this.session && this.session._requestCurrent) this.session._requestCurrent();
    this._kick();
    return true;
  };

  Player.prototype._controllerMode = function () {
    if (this.manual || this.held) return true;
    if (this._presented && !this.playing && !this._awaitingSwap) return true;
    return false;
  };

  Player.prototype._pausePreload = function () {
    var keepStandby = this._isAwaitedPool(this._standby);
    var keepBack = this._isAwaitedPool(this._back);
    if (this._standby && !keepStandby && this._standby.quietStop) this._standby.quietStop();
    if (this._back && !keepBack && this._back.quietStop) this._back.quietStop();
    var keepAwait = keepStandby || keepBack;
    if (this._uploadQueue && this._uploadQueue.length) {
      this._uploadQueue = this._uploadQueue.filter(function (job) {
        if (!job || (job.standby && !keepAwait) || job.cancelled || (job.live && !job.live())) {
          if (job && job.done) job.done(null);
          return false;
        }
        return true;
      });
    }
    if (this._decodeQueue && this._decodeQueue.length) {
      this._decodeQueue = this._decodeQueue.filter(function (job) {
        if (!job || (job.standby && !keepAwait) || job.cancelled || (job.live && !job.live())) {
          if (job) job.cancelled = true;
          if (job && job.done) job.done(new Error("cancelled"));
          return false;
        }
        return true;
      });
    }
    var hadStandby = !!((this._standby && !keepStandby && this._standby.entry) || (this._back && !keepBack && this._back.entry));
    if (!keepStandby && this._standby) {
      this._standby.dispose();
      this._standby = null;
    }
    if (!keepBack && this._back) {
      this._back.dispose();
      this._back = null;
    }
    if (hadStandby) this._syncDiagToSession();
  };

  Player.prototype._pruneQueues = function () {
    if (this._uploadQueue && this._uploadQueue.length) {
      this._uploadQueue = this._uploadQueue.filter(function (job) {
        if (!job || job.cancelled || (job.live && !job.live())) {
          if (job && job.done) job.done(null);
          return false;
        }
        return true;
      });
    }
    if (this._decodeQueue && this._decodeQueue.length) {
      this._decodeQueue = this._decodeQueue.filter(function (job) {
        if (!job || job.cancelled || (job.live && !job.live())) {
          if (job) job.cancelled = true;
          if (job && job.done) job.done(new Error("cancelled"));
          return false;
        }
        return true;
      });
    }
  };

  Player.prototype._syncResidency = function () {
    var hold = this._controllerMode();
    if (hold && !this._controllerHold) {
      this._controllerHold = true;
      this._pausePreload();
    } else if (!hold && this._controllerHold) {
      this._controllerHold = false;
    }
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

  Player.prototype.touchAim = function (now) {
    this._aimTrafficAt = now || Date.now();
  };

  Player.prototype.aimKeepaliveDue = function (now) {
    now = now || Date.now();
    var last = this._aimTrafficAt || 0;
    if (!(last > 0)) return false;
    return now - last >= AIM_KEEPALIVE_MS;
  };

  // An unsolicited echo (type 2, seq 0). The phone already accepts this
  // frame on /aim, and any received byte resets the socket read timeout.
  Player.prototype.aimKeepaliveBytes = function (now) {
    now = now || Date.now();
    var packet = this.encodeEcho(0, now);
    var copy = new Uint8Array(packet.byteLength || 16);
    copy.set(new Uint8Array(packet));
    this.touchAim(now);
    return copy;
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
    this._syncMark(raw);
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
      if ((!this.items || !this.items.length) && this.senderTimedOut(now)) this.onSenderGone("heartbeat-timeout");
    }
    if (!this._holdFrame || this._snapOn) this.draw();
    if (this.frameCover().black) this._noteBlack("draw");
    var fadeLimit = this._fadeLimit > 0 ? this._fadeLimit : TILE_FADE_MS;
    if (this._fading && this._fadeMs >= fadeLimit) this._endFade();
    if (this._snapOn && this._snapReveal && this._snapMs >= (this._snapFadeMs || SNAP_FADE_MS)) this._endSnap();
    this._pumpGpu();
    this._syncResidency();
    this._releaseOutsideBand();
    if (this.session && this.session.entry) this.session._requestCurrent();
    var holdStandby = !this._awaitingSwap && this._activeBusy();
    if (!holdStandby && (!this._controllerMode() || this._awaitingSwap) && this._standby && this._standby.entry) {
      if (this._awaitingSwap) this._openIncoming(this._standby);
      this._standby._requestCurrent();
    }
    this._diagAcc = (this._diagAcc || 0) + raw;
    if (this._diagAcc >= 1000) {
      this._diagAcc = 0;
      this._sendDiag(true);
    }
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

  Player.prototype._enqueueDecode = function (payload, done, meta) {
    if (!this._decodeQueue) this._decodeQueue = [];
    meta = meta || {};
    this._decodeQueue.push({
      payload: payload,
      done: done,
      standby: !!meta.standby,
      cancelled: false,
    });
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
    this._pruneQueues();
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
        tex = this._uploadFailed(job.img, job.tile, "exception", error);
      }
      if (this._strip) {
        this._strip.done = job.done;
        return;
      }
      if (job.done) job.done(tex);
      return;
    }
    if (this._decodeBusy || !this._decodeQueue || !this._decodeQueue.length) return;
    while (this._decodeQueue.length && this._decodeQueue[0].cancelled) {
      var skipped = this._decodeQueue.shift();
      if (skipped && skipped.done) skipped.done(new Error("cancelled"));
    }
    if (!this._decodeQueue.length) return;
    var decode = this._decodeQueue.shift();
    if (decode.cancelled) {
      if (decode.done) decode.done(new Error("cancelled"));
      return;
    }
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
    if (!gl) {
      this._setupReason = "no-webgl";
      this._probeNote = withBuild("upload probe skipped reason=no-webgl");
      this._send({ type: "log", message: this._probeNote });
      return;
    }
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
    if (!prog) {
      this._setupReason = "shader";
      this._gl = gl;
      this._probeUploads(gl);
      if (!this._lastUploadFail) {
        this._lastUploadFail = withBuild("texture upload failed stage=shader gl=none size=0x0 source=none path="
          + (this._uploadPath || "dom") + " throw=Error: " + (lastShaderError || "link"));
      }
      this._engageCpu({ error: new Error(lastShaderError || "shader") });
      return;
    }
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
    // Tiles sit on the same sphere as the overview. The default depth test
    // kept the overview and rejected every sharp tile on a real GPU.
    gl.disable(gl.DEPTH_TEST);
    if (gl.depthMask) gl.depthMask(false);
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
        lostSelf._send({ type: "log", message: "webglcontextlost" });
      }, false);
      this.canvas.addEventListener("webglcontextrestored", function () {
        lostSelf._glLost = false;
        lostSelf._resident = [];
        lostSelf._gpuBytes = 0;
        lostSelf._lodHold = null;
        lostSelf._promoting = false;
        warn("webgl context restored");
        lostSelf._send({ type: "log", message: "webglcontextrestored" });
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
    this._probeUploads(gl);
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
    if (item._base || (item.tex && item.tex._base) || (item.tile && item.tile._base)) return null;
    if (this._listedTex(this._fadeFrom, item.tex)) return null;
    // Controller mode keeps every strip of the photo on screen. A standby
    // texture from the next photo is the only thing that can leave.
    if (this._controllerMode()) return item.standby ? 1 : null;
    var wide = !!(item.tile && item.tile.srcW * 2 >= (item.spanW || 1));
    if (!item.standby) {
      // Ten 180° strips of an 8K photo are about 144 MB. They stay until the
      // GPU is actually over the cap, and a 180° strip is never the one that
      // leaves: dropping it left a hole the LAN payload could not refill.
      if (!(this._gpuBytes > GPU_CAP)) return null;
      if (wide) return null;
      if (!item.tile) return this._drawingTex(item.tex) ? null : 1000;
      if (this._tileVisible(item, view)) return null;
      if (tileInResidentBand(item.tile, item.spanW || 1, item.spanH || 1, view)) return null;
      var sign = view && view.panSign < 0 ? -1 : 1;
      var lead = panLeadDeg(item.u || 0, view ? view.u : 0.5, sign);
      if (lead > 0) return null;
      return 5000 - lead;
    }
    return 100;
  };

  Player.prototype._releaseOutsideBand = function () {
    // Auto-pan trims a strip only while uploading something that does not fit.
    // Controller mode does not trim the current photo at all.
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
    slot.manual = !!this.manual;
    slot.standby = false;
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

  Player.prototype._installOverview = function (img, tile, targetEntry) {
    var entry = targetEntry || (this.session && this.session.entry) || this._showingEntry();
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
      } else if (this._cpuTiles && img) {
        img._cpuRetain = true;
        tex._cpu = true;
        tex._cpuImage = img;
        tex._spsUploaded = true;
        tex._mip = true;
        tex.deferred = false;
        tex._evicted = false;
      }
    }
    if (img && !tex._cpuImage && !(this._gl && !this._glLost && !(this._gl.isContextLost && this._gl.isContextLost()))) {
      // No WebGL context, so the decoded overview has to stay on the CPU
      // atlas. Strips paint over it; the bitmap is not a substitute for them.
      img._cpuRetain = true;
      tex._cpuImage = img;
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
      now: function () { return self._clock(); },
      request: function (id, token) {
        self._diagRequested = (self._diagRequested || 0) + 1;
        self._sendDiag();
        if (self._castRetry && self._castRetry[id]) {
          delete self._castRetry[id];
          if (window.__castSend) window.__castSend({ type: "fetch", id: id, token: token, reason: "retry" });
          return;
        }
        var url = self._urlFor(id);
        if (shouldTryLan(self._lan, self._lanDead, url)) {
          self._loadLan(id, token, url);
          return;
        }
        if (window.__castSend) window.__castSend({ type: "fetch", id: id, token: token });
      },
      onTileRetry: function (tile) {
        // Retry this strip over Cast. Other strips keep using LAN until
        // four HTTP misses have landed in a row.
        if (!self._castRetry) self._castRetry = {};
        if (tile && tile.id) self._castRetry[tile.id] = true;
        if ((self._lanFailures || 0) >= LAN_FAIL_LIMIT) self._lanDead = true;
      },
      ahead: function () {
        var n = (self._lan && !self._lanDead && self._lanVerified) ? LAN_AHEAD : AHEAD_REQUESTS;
        if (self._cpuTiles || self._uploadPath === "cpu") return Math.max(n, 3);
        return n;
      },
      fullSphere: function () { return !!(self._cpuTiles || self._uploadPath === "cpu"); },
      preloadLimit: function () { return self._preloadDepth || 0; },
      gpuRoom: function () { return Math.max(0, GPU_CAP - (self._gpuBytes || 0)); },
      materialize: function (payload, done) {
        self._diagReceived = (self._diagReceived || 0) + 1;
        if (self._injectImage) {
          var injected = self._injectImage(payload);
          if (injected) {
            if (!injected._spsPayload) injected._spsPayload = payload;
            self._diagDecoded = (self._diagDecoded || 0) + 1;
            self._sendDiag();
            done(null, injected);
            return;
          }
        }
        self._enqueueDecode(payload, function (err, img) {
          if (err || !img) {
            self._diagErrors = (self._diagErrors || 0) + 1;
            self._diagNote = err ? String(err.message || err) : "decode failed";
            self._reportTv(self._diagNote);
          } else {
            self._diagDecoded = (self._diagDecoded || 0) + 1;
            if (img && !img._spsPayload) img._spsPayload = payload;
          }
          self._sendDiag();
          done(err, img);
        }, { standby: !!session.standby });
      },
      view: function () {
        var live = self._lodView();
        if (!session.standby) return live;
        // The next photo opens in the middle of its first horizon strip,
        // including when an older phone still puts the seam at yaw 0.
        var startYaw = startingYawForEntry(session.entry);
        var u = startYaw / 360 + 0.5;
        u = u - Math.floor(u);
        return {
          u: u,
          v: 0.5,
          halfU: live.halfU,
          halfV: live.halfV,
          yaw: startYaw,
          pitch: 0,
          roll: 0,
          fov: live.fov,
          aspect: live.aspect,
          lookaheadDeg: live.lookaheadDeg,
          panSign: 1,
          manual: false,
          standby: true,
        };
      },
      onEntry: function (entry) { self._ensureBase(entry); },
      upload: function (img, tile, done) {
        if (tile && tile._overview) {
          var overviewTex = self._installOverview(img, tile, session.entry);
          self._noteUploaded(overviewTex);
          if (typeof done === "function") done(overviewTex);
          return;
        }
        if (isGpuSource(img) || self._uploadDelayMs > 0) {
          self._enqueueUpload(img, tile, !!session.standby, function (tex) {
            self._noteUploaded(tex);
            if (typeof done === "function") done(tex);
          });
          return;
        }
        var uploaded = self._uploadTile(img, tile, !!session.standby);
        self._noteUploaded(uploaded);
        return uploaded;
      },
      dropImage: function (img) {
        if (!img || img._cpuRetain) return;
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
    if (sess.entry && sess.entry.width > 0 && !(this._tileW > 0)) this._tileW = sess.entry.width;
    if (sess.entry && sess.entry.height > 0 && !(this._tileH > 0)) this._tileH = sess.entry.height;
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
    this._fadeBase = null;
    this._fadePose = null;
    this._fadeLimit = 0;
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
    if (this.session && this.session.entry && entry && this.session.entry.id === entry.id) return;
    var standby = this._standby;
    if (!standby || !standby.entry || !sessionHasWork(standby)) {
      if (standby) standby.dispose();
      this._standby = this._newSession();
      this._standby.preload(entry);
      return;
    }
    if (standby.entry.id === entry.id) return;
    if (!this._back || !this._back.entry || !sessionHasWork(this._back)) {
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

  Player.prototype._openIncoming = function (pool) {
    if (!pool || !this._awaitingSwap) return;
    // Standby only prefetches the front three strips. Once the turn is over,
    // that cap must come off or the swap waits on tiles the session refuses
    // to request.
    pool.standby = false;
    pool.budgetFull = false;
    pool.preloadCapped = false;
    pool._reqCount = {};
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
        waiting = this._incomingPool(entry.id) || this._readyPool(entry.id);
        if (waiting && !swapReady(waiting)) {
          this._openIncoming(waiting);
          if (!waiting.pending) waiting._requestCurrent();
        }
        readyNow = this._readyPool(entry.id);
        if (!readyNow) {
          if (waiting && (waiting.budgetFull || waiting.preloadCapped) && !this._holdFrame) this._considerHold(waiting);
          return true;
        }
      }
      if (readyNow) this._commitIndex(at, readyNow);
      return true;
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
    if (incoming) {
      this._openIncoming(incoming);
      if (!incoming.pending) incoming._requestCurrent();
      if (swapReady(incoming)) {
        this._commitIndex(at, incoming);
        return true;
      }
      if ((incoming.budgetFull || incoming.preloadCapped) && !this._holdFrame) this._considerHold(incoming);
    }
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
    this._alignStartYaw(pool.entry, true);
    if (resetYaw) this._resetAim();
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
    pool._reqCount = {};
    if (pool === this._standby) this._standby = null;
    if (pool === this._back) this._back = null;
    var previous = this.session;
    var hadFrame = !!(this._tileDraw && this._tileDraw.length);
    var oldDraw = this._tileDraw ? this._tileDraw.slice() : [];
    var oldW = this._tileW;
    var oldH = this._tileH;
    var oldBase = previous && previous.entry && this._bases ? this._bases[previous.entry.id] : null;
    for (var sharp = 0; sharp < resident.length; sharp++) {
      resident[sharp]._revealDone = true;
      if (!(resident[sharp]._focusAt > 1)) resident[sharp]._focusAt = 1;
    }
    this.session = pool;
    this._tileDraw = resident;
    this._syncDiagToSession();
    var canFade = !held && hadFrame && previous && previous !== pool && oldDraw.length;
    if (canFade) {
      // Keep the photo that is on screen and fade the new one in on top.
      // Deleting these textures here, or copying a discarded framebuffer,
      // is the black frame between photos.
      this._fadeFrom = oldDraw;
      this._fadeW = oldW;
      this._fadeH = oldH;
      this._fadePose = previous && previous.entry ? poseOf(previous.entry) : ZERO_POSE;
      this._fadeBase = oldBase && oldBase.tex && !oldBase.tex._evicted ? oldBase : null;
      this._fadeMs = 0;
      this._fadeLimit = CROSSFADE_MS;
      this._fading = true;
      this._fadeRelease = true;
      this._kick();
    } else {
      this._fading = false;
      this._fadeFrom = null;
      this._fadeBase = null;
      this._fadePose = null;
      this._fadeRelease = false;
    }
    if (previous && previous !== pool) {
      previous.quietStop();
      previous.live = [];
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
    this._geoAt = 0;
    if (this._intro === "hold") {
      this._intro = "out";
      this._armBloom();
    } else {
      this._intro = "off";
      this._introAlpha = 0;
      this._introSince = 0;
      this._armBloom();
    }
    this._paintMark();
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
      if (entry.width > 0) this._tileW = entry.width;
      if (entry.height > 0) this._tileH = entry.height;
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
    if (this.session && this.session.entry && entry && this.session.entry.id === entry.id && (this.session.shown || this.session.pending)) return;
    this._awaitingSwap = true;
    this._awaitIndex = this.index;
    this._switchTick = this._switchTick || nowMs();
    this._ensureIncoming(entry);
    var incoming = this._incomingPool(entry.id);
    if (incoming) {
      this._openIncoming(incoming);
      if (!incoming.pending) incoming._requestCurrent();
      if (swapReady(incoming)) {
        this._commitIndex(this.index, incoming);
        return;
      }
      if ((incoming.budgetFull || incoming.preloadCapped) && !this._holdFrame) this._considerHold(incoming);
    }
  };

  Player.prototype._preloadNeighbors = function () {
    if (!this._useTiles || !this.entries || this.entries.length < 2) return;
    if (this._controllerMode()) return;
    // The overview makes session.shown true after the first strip. The next
    // photo still waits until this one has nothing left to request.
    if (!this._awaitingSwap && this._activeBusy()) return;
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
    if (this._controllerMode()) return;
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
    this._diagErrors = (this._diagErrors || 0) + 1;
    this._diagNote = (msg && msg.message) || "fetch failed";
    this._reportTv(this._diagNote);
    this._sendDiag();
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

  Player.prototype._gridMatches = function (live, next) {
    if (!live || !next) return false;
    var liveN = live.tiles ? live.tiles.length : 0;
    var nextN = next.tiles ? next.tiles.length : 0;
    return (live.width | 0) === (next.width | 0) && (live.height | 0) === (next.height | 0) && liveN === nextN && liveN > 0;
  };

  Player.prototype._sharpUploaded = function (sess) {
    var loaded = sess && sess.loaded;
    if (!loaded) return false;
    for (var i = 0; i < loaded.length; i++) if (pieceReady(loaded[i])) return true;
    return false;
  };

  Player.prototype._refreshEntry = function (sess, next) {
    var live = sess && sess.entry;
    if (!live || !next) return;
    var dimsDiffer = (live.width | 0) !== (next.width | 0) || (live.height | 0) !== (next.height | 0);
    var keepDims = dimsDiffer && this._sharpUploaded(sess);
    if (next.url) live.url = next.url;
    if (next.posePitch != null) live.posePitch = next.posePitch;
    if (next.poseRoll != null) live.poseRoll = next.poseRoll;
    if (!keepDims) {
      if (next.width > 0) live.width = next.width;
      if (next.height > 0) live.height = next.height;
    }
    if (next.overview) {
      if (!live.overview) {
        live.overview = {
          id: next.overview.id,
          url: next.overview.url,
          texW: next.overview.texW,
          texH: next.overview.texH,
        };
      } else {
        if (next.overview.url) live.overview.url = next.overview.url;
        if (!keepDims) {
          live.overview.texW = next.overview.texW;
          live.overview.texH = next.overview.texH;
        }
      }
    }
    var incoming = next.tiles || [];
    var have = live.tiles || [];
    for (var i = 0; i < have.length; i++) {
      var tile = have[i];
      if (!tile) continue;
      var match = null;
      var byPlace = null;
      for (var j = 0; j < incoming.length; j++) {
        var cand = incoming[j];
        if (!cand) continue;
        if (cand.id === tile.id) {
          match = cand;
          break;
        }
        if (!byPlace && (cand.col | 0) === (tile.col | 0) && (cand.row | 0) === (tile.row | 0)) byPlace = cand;
      }
      if (!match) match = byPlace;
      if (!match) continue;
      if (match.url) tile.url = match.url;
      if (keepDims) continue;
      tile.srcX = match.srcX;
      tile.srcY = match.srcY;
      tile.srcW = match.srcW;
      tile.srcH = match.srcH;
      tile.texW = match.texW;
      tile.texH = match.texH;
      tile.padL = match.padL;
      tile.padR = match.padR;
      tile.padT = match.padT;
      tile.padB = match.padB;
    }
  };

  Player.prototype._bindRetile = function (at, entry) {
    this.entries[at] = entry;
    this.ids[at] = entry.id;
    this.items[at] = entry.url;
    this.poses[at] = poseOf(entry);
  };

  Player.prototype.retile = function (id, item) {
    var entry = normalizeEntries([item])[0];
    if (!entry) return;
    var at = this.ids.indexOf(String(id));
    if (at < 0) at = this.ids.indexOf(entry.id);
    if (at < 0) return;
    this._useTiles = true;
    if (!this.entries) this.entries = [];
    var pools = [this.session, this._standby, this._back];
    var keptEntry = null;
    for (var i = 0; i < pools.length; i++) {
      var sess = pools[i];
      if (!sess || !sess.entry || sess.entry.id !== entry.id) continue;
      if (this._gridMatches(sess.entry, entry)) {
        this._refreshEntry(sess, entry);
        if (sess === this.session) keptEntry = sess.entry;
        else if (!keptEntry) keptEntry = sess.entry;
        continue;
      }
      // A new strip layout has to load. Dropping the id here lets
      // _openCurrent start that load instead of treating it as the photo
      // already on screen.
      if (sess === this.session) sess.entry = null;
      else {
        sess.dispose();
        if (sess === this._standby) this._standby = null;
        if (sess === this._back) this._back = null;
      }
    }
    var live = this.session;
    var showingSame = !!(live && live.entry && live.entry.id === entry.id && this._gridMatches(live.entry, entry) &&
      (live.shown || live.pending || (live.loaded && live.loaded.length)));
    if (showingSame && at === this.index) {
      this._bindRetile(at, live.entry);
      if (!this._userAimed) this._alignStartYaw(live.entry, true);
      return;
    }
    if (keptEntry && at !== this.index) {
      this._bindRetile(at, keptEntry);
      if (this._awaitingSwap && this._awaitIndex === at) this._requestIndex(at);
      return;
    }
    this._bindRetile(at, entry);
    if (at === this.index) this._openCurrent();
    else if (this._awaitingSwap && this._awaitIndex === at) this._requestIndex(at);
    else this._preloadNeighbors();
  };

  Player.prototype._prepareTex = function (gl, tex) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    if (gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL != null) gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    if (gl.UNPACK_COLORSPACE_CONVERSION_WEBGL != null && gl.NONE != null) {
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  };

  Player.prototype._uploadSource = function (gl, tex, source) {
    if (!gl || !tex || !source) return { ok: false, error: new Error("no source"), gl: "" };
    this._prepareTex(gl, tex);
    this._clearGlError(gl);
    var w = source.width || source.w || 0;
    var h = source.height || source.h || 0;
    try {
      if (source._pixels) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, source.data);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      }
    } catch (error) {
      return { ok: false, error: error, gl: this._readGlError(gl) };
    }
    if (gl.isContextLost && gl.isContextLost()) return { ok: false, error: new Error("context lost"), gl: "CONTEXT_LOST_WEBGL" };
    var glErr = this._readGlError(gl);
    if (glErr) return { ok: false, error: null, gl: glErr };
    return { ok: true };
  };

  Player.prototype._texImage = function (gl, source) {
    if (!gl || !source || this._uploadPath === "cpu" || this._cpuTiles) return null;
    var tex = gl.createTexture();
    if (!tex) return null;
    this._prepareTex(gl, tex);
    var directOk = this._uploadPath !== "pixels" && this._uploadPath !== "canvas" && this._domUploadOk !== false && !source._pixels;
    if (directOk && this._beginStrip(gl, tex, source)) return tex;
    var stage = "dom";
    var current = source;
    var result = null;
    if (source._pixels || this._uploadPath === "pixels" || this._domUploadOk === false) {
      stage = "pixels";
      current = source._pixels ? source : this._bitmapToPixels(source);
      result = current ? this._uploadSource(gl, tex, current) : { ok: false, error: new Error("no pixels"), gl: "" };
    } else if (this._uploadPath === "canvas") {
      stage = "canvas";
      current = this._bitmapToCanvas(source) || source;
      result = this._uploadSource(gl, tex, current);
      if (!result.ok) {
        var fromCanvas = this._bitmapToPixels(current);
        if (fromCanvas) {
          stage = "pixels";
          current = fromCanvas;
          result = this._uploadSource(gl, tex, fromCanvas);
          if (result.ok) this._uploadPath = "pixels";
        }
      }
    } else {
      result = this._uploadSource(gl, tex, source);
      if (!result.ok && !this._domWarned) {
        this._domWarned = true;
        this._rememberUploadFailure(gl, source, "dom", result);
      }
      if (!result.ok) {
        var canvas = this._bitmapToCanvas(source);
        if (canvas) {
          stage = "canvas";
          current = canvas;
          result = this._uploadSource(gl, tex, canvas);
          if (result.ok) this._uploadPath = "canvas";
        }
        if (!result.ok) {
          var pixels = this._bitmapToPixels(canvas || source);
          if (pixels) {
            stage = "pixels";
            current = pixels;
            result = this._uploadSource(gl, tex, pixels);
            if (result.ok) this._uploadPath = "pixels";
          }
        }
      }
    }
    if (!result || !result.ok) {
      try { gl.deleteTexture(tex); } catch (error) {}
      this._rememberUploadFailure(gl, source, stage, result || { ok: false });
      if (uploadPathBroken(result)) this._engageCpu(result);
      return null;
    }
    var w = current.width || current.w || 0;
    var h = current.height || current.h || 0;
    try {
      this._finishSampler(gl, tex, w, h, current);
    } catch (error) {
      try { gl.deleteTexture(tex); } catch (e) {}
      this._rememberUploadFailure(gl, current, "sampler", { ok: false, error: error, gl: this._readGlError(gl) });
      if (uploadPathBroken({ error: error })) this._engageCpu({ error: error });
      return null;
    }
    var samplerErr = this._readGlError(gl);
    if (samplerErr && samplerErr.indexOf("OUT_OF_MEMORY") >= 0) {
      try { gl.deleteTexture(tex); } catch (e2) {}
      this._rememberUploadFailure(gl, current, "sampler", { ok: false, gl: samplerErr });
      return null;
    }
    tex._contentW = tex._contentW || w;
    tex._contentH = tex._contentH || h;
    tex._spsUploaded = true;
    return tex;
  };

  Player.prototype._finishSampler = function (gl, tex, width, height, source) {
    var uploadW = width;
    var uploadH = height;
    var large = Math.max(width | 0, height | 0) > 512;
    var pot = isPow2(width) && isPow2(height);
    // A full-resolution strip is already CLAMP_TO_EDGE and about one screen
    // tall. WebGL 1 and 2 both sample an NPOT texture that way with LINEAR.
    // Padding it out to a power of two and building a mip chain copied the
    // bitmap again and stalled the fade for a second or more.
    // A small NPOT strip used to be copied onto a power-of-two canvas and
    // uploaded a second time. WebGL 1 can sample the original with clamp and
    // linear. The second upload is skipped when DOM uploads are already unsafe,
    // and a GL error from the pad puts the original pixels back.
    var allowPad = source && !source._pixels && this._domUploadOk !== false && this._uploadPath !== "pixels" && this._uploadPath !== "cpu";
    if (!large && !this._webgl2 && !pot && allowPad) {
      var padded = potPadSource(source);
      if (padded && padded.width && (padded.width !== width || padded.height !== height)) {
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, padded);
          var padErr = this._readGlError(gl);
          if (padErr) throw new Error(padErr);
          uploadW = padded.width;
          uploadH = padded.height;
          pot = isPow2(uploadW) && isPow2(uploadH);
        } catch (error) {
          warn("texture pad failed", error && error.message);
          var restoreErr = "";
          try {
            if (source._pixels) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, source.data);
            else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
            restoreErr = this._readGlError(gl);
          } catch (again) {
            restoreErr = String((again && again.message) || again || "restore failed");
          }
          pot = isPow2(width) && isPow2(height);
          uploadW = width;
          uploadH = height;
          if (restoreErr) throw new Error(restoreErr);
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
    } else if (!large && (this._webgl2 || pot)) {
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
    tex._contentW = width;
    tex._contentH = height;
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

  Player.prototype._openingStrip = function (tile) {
    if (!tile || tile._base || tile._overview) return true;
    var pools = [this._standby, this._back, this.session];
    for (var i = 0; i < pools.length; i++) {
      var entry = pools[i] && pools[i].entry;
      if (!entry || !entry.tiles) continue;
      var mine = false;
      for (var t = 0; t < entry.tiles.length; t++) {
        if (entry.tiles[t] && entry.tiles[t].id === tile.id) mine = true;
      }
      if (!mine) continue;
      var anchor = stripAnchorRow(entry.tiles, entry.height || 1, { u: 0.5, v: 0.5, manual: false });
      return Math.abs((tile.row | 0) - anchor) <= 1;
    }
    return true;
  };

  Player.prototype._uploadFailed = function (img, tile, stage, error) {
    var sized = safeBitmap(img, tile);
    // A texImage2D failure already recorded the GL error. Keep that text
    // instead of replacing it with a generic no-texture line.
    if (stage !== "no-texture" || !this._lastUploadFail) {
      this._rememberUploadFailure(this._gl, sized, stage, {
        ok: false,
        error: error || new Error(stage || "upload"),
        gl: this._gl ? this._readGlError(this._gl) : "",
      });
    }
    if (img) {
      this._engageCpu({ error: error || new Error(stage || "upload") });
      return this._acceptCpuTile(img, tile);
    }
    var deferred = this._deferred(img, tile);
    deferred._deferReason = stage || "unspecified";
    deferred._srcW = sized.width;
    deferred._srcH = sized.height;
    return deferred;
  };

  Player.prototype._uploadTile = function (img, tile, standby) {
    try {
      return this._uploadTileBody(img, tile, standby);
    } catch (error) {
      return this._uploadFailed(img, tile, "exception", error);
    }
  };

  Player.prototype._uploadTileBody = function (img, tile, standby) {
    if ((this._cpuTiles || this._uploadPath === "cpu") && img) return this._acceptCpuTile(img, tile);
    if (this._glLost || !this._gl) this._setup();
    var gl = this._gl;
    if (!gl || (gl.isContextLost && gl.isContextLost())) {
      var lost = !!(gl && gl.isContextLost && gl.isContextLost());
      return this._uploadFailed(img, tile, lost ? "context-lost" : "no-gl", new Error(lost ? "context lost" : "no webgl"));
    }
    if (!img) throw new Error("no image");
    var maxEdge = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    var budget = this._gpuBudget == null ? Infinity : this._gpuBudget;
    if (standby) {
      var incomingBytes = (img.width || (tile && tile.texW) || 1) * (img.height || (tile && tile.texH) || 1) * 4;
      // The next photo's overview and the three opening strips have to land
      // even when the photo on screen already fills most of the GPU.
      if (!this._openingStrip(tile) && (this._gpuBytes || 0) + incomingBytes > GPU_CAP) {
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
    if (slot && !slot.resident) return this._uploadFailed(img, tile, "not-resident", new Error("tile is outside the resident set"));
    var win = slot && slot.window;
    var source = img;
    var upW = img.width || (tile && tile.texW) || 0;
    var upH = img.height || (tile && tile.texH) || 0;
    if (win && !win.full) {
      var cropped = cropSource(img, win.cropX, win.cropY, win.texW, win.texH);
      if (!cropped) {
        return this._uploadFailed(img, tile, "crop", new Error("could not keep a full-resolution window"));
      }
      source = cropped;
      upW = win.texW;
      upH = win.texH;
    }
    if (upW > maxEdge || upH > maxEdge) {
      return this._uploadFailed(img, tile, "max-size", new Error("tile is larger than MAX_TEXTURE_SIZE " + upW + "x" + upH));
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
        return this._uploadFailed(img, tile, "budget", new Error("texture budget"));
      }
    }
    var tex = null;
    var attempts = this._resident.length + 1;
    var uploadStarted = nowMs();
    while (attempts-- > 0) {
      if (this._cpuTiles) break;
      tex = this._texImage(gl, source);
      if (tex || this._cpuTiles) break;
      // A failed upload can evict a tile that is outside the view. It cannot
      // drop a tile the frustum still sees, including a pole tile behind the yaw.
      if (!canEvict()) break;
      if (!this._evictDistant(view)) break;
    }
    if (!tex && this._cpuTiles) return this._acceptCpuTile(source || img, tile);
    if (!tex) return this._uploadFailed(img, tile, "no-texture", new Error("texImage2D produced no texture"));
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
      standby: !!standby,
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
        if (err || !img || !self.session || !self.session.entry || !entry || self.session.entry.id !== entry.id) {
          if (err) warn("could not reopen a tile", err && err.message);
          if (img && self.session && self.session.hooks.dropImage) self.session.hooks.dropImage(img);
          finished();
          return;
        }
        img._spsPayload = job.payload;
        self._enqueueUpload(img, job.piece.tile, false, function (tex) {
          if (tex && !tex.deferred && self.session && self.session.entry && entry && self.session.entry.id === entry.id) {
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
    if (!prog) {
      var plain = glSources(!!this._webgl2, "mediump", false);
      prog = compileProgram(gl, plain.tileVs, plain.tileFs);
    }
    if (!prog) {
      this._diagErrors = (this._diagErrors || 0) + 1;
      this._diagNote = lastShaderError ? ("tile shader: " + lastShaderError) : "tile shader did not compile";
      this._reportTv(this._diagNote);
      return;
    }
    this._tileProg = prog;
    this._tileLoc = {
      mvp: gl.getUniformLocation(prog, "uMvp"),
      tex: gl.getUniformLocation(prog, "uTex"),
      pitch: gl.getUniformLocation(prog, "uPitch"),
      roll: gl.getUniformLocation(prog, "uRoll"),
      poseMesh: gl.getUniformLocation(prog, "uPoseMesh"),
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
      contentW: gl.getUniformLocation(prog, "uContentW"),
      contentH: gl.getUniformLocation(prog, "uContentH"),
      alpha: gl.getUniformLocation(prog, "uAlpha"),
      kind: gl.getUniformLocation(prog, "uKind"),
      debug: gl.getUniformLocation(prog, "uDebug"),
      reveal: gl.getUniformLocation(prog, "uReveal"),
      geo: gl.getUniformLocation(prog, "uGeo"),
      viewU: gl.getUniformLocation(prog, "uViewU"),
      viewV: gl.getUniformLocation(prog, "uViewV"),
      anchorV: gl.getUniformLocation(prog, "uAnchorV"),
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
    gl.disable(gl.DEPTH_TEST);
    this._followView();
    var w = this.canvas.width;
    var h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    var self = this;
    var view = this._lodView();
    if (!this._drawKeep) this._drawKeep = [];
    if (!this._oldKeep) this._oldKeep = [];
    function collectTiles(list, out, spanW, spanH) {
      out.length = 0;
      if (!list) return out;
      var seen = 0;
      var kept = 0;
      for (var n = 0; n < list.length; n++) {
        var piece = list[n];
        if (!piece || !piece.tex || piece.tex.deferred || piece.tex._evicted || piece.tex._spsUploaded === false) continue;
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
    var span = this._photoSpan();
    var pose = this.poses[this.index] || ZERO_POSE;
    var fadePose = this._fadePose || ZERO_POSE;
    function collect(list, out, spanW, spanH, posePitch, poseRoll) {
      view.posePitch = posePitch || 0;
      view.poseRoll = poseRoll || 0;
      return collectTiles(list, out, spanW, spanH);
    }
    var drawable = collect(this._tileDraw, this._drawKeep, span.w, span.h, pose.pitch, pose.roll);
    var oldDrawable = this._fading ? collect(this._fadeFrom, this._oldKeep, this._fadeW || 1, this._fadeH || 1, fadePose.pitch, fadePose.roll) : this._oldKeep;
    if (!this._fading && this._oldKeep) this._oldKeep.length = 0;
    var basePiece = this._activeBase();
    var paintBase = !!(basePiece && basePiece._photo && basePiece.tile);
    var fadeBase = this._fading && this._fadeBase && this._fadeBase.tex && !this._fadeBase.tex.deferred && !this._fadeBase.tex._evicted ? this._fadeBase : null;
    var haveOld = oldDrawable.length > 0 || !!fadeBase;
    var haveNew = drawable.length > 0 || paintBase;
    var alphas = compositeAlphas(this._fadeMs, haveOld, haveNew, this._fadeLimit || TILE_FADE_MS);
    if (!this._tileProg || (!drawable.length && !oldDrawable.length && !paintBase && !fadeBase)) {
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
    if ((haveOld || haveNew) && (paintBase || fadeBase || alphas.clear)) gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this._tileProg);
    fillPerspective(this._proj, this.fov, w / Math.max(h, 1), 0.05, 20);
    fillAimView(this._m0, this._m1, this._m2, this._view, this.yaw, this.pitch, this.roll);
    multiplyInto(this._mvp, this._proj, this._view);
    var loc = this._tileLoc;
    gl.uniformMatrix4fv(loc.mvp, false, this._mvp);
    function paint(list, spanW, spanH, alpha, sharpen, posePitch, poseRoll) {
      if (loc.pitch) gl.uniform1f(loc.pitch, posePitch || 0);
      if (loc.roll) gl.uniform1f(loc.roll, poseRoll || 0);
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
        if (loc.contentW) gl.uniform1f(loc.contentW, sample ? sample.texW : (tex._contentW || tile.texW || tex._uploadW || 0));
        if (loc.contentH) gl.uniform1f(loc.contentH, sample ? sample.texH : (tex._contentH || tile.texH || tex._uploadH || 0));
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
        if (loc.nL) gl.uniform1f(loc.nL, nL);
        if (loc.nR) gl.uniform1f(loc.nR, nR);
        if (loc.nU) gl.uniform1f(loc.nU, nU);
        if (loc.nD) gl.uniform1f(loc.nD, nD);
        gl.uniform1i(loc.tex, 0);
        bindTex(gl, gl.TEXTURE0, tex);
        // The overview sphere is already in world space. A strip patch is
        // built in photo space and has to be un-straightened or its edge
        // clips inside the tile and leaves the blurry overview showing.
        if (loc.poseMesh) gl.uniform1f(loc.poseMesh, overview ? 0 : 1);
        if (overview) self._drawMesh(gl);
        else self._drawPatch(gl, tile, spanW, spanH);
      }
    }
    this._focusAnim = false;
    var geoT = this._geoLinear();
    if (geoT < 1) this._focusAnim = true;
    var anchorV = this.manual ? view.v : 0.5;
    if (loc.geo) gl.uniform1f(loc.geo, geoT);
    if (loc.viewU) gl.uniform1f(loc.viewU, view.u);
    if (loc.viewV) gl.uniform1f(loc.viewV, view.v);
    if (loc.anchorV) gl.uniform1f(loc.anchorV, anchorV);
    gl.disable(gl.BLEND);
    if (fadeBase && alphas.oldAlpha > 0) {
      paint([fadeBase], this._fadeW || this._tileW || 1, this._fadeH || this._tileH || 1, alphas.oldAlpha, false, fadePose.pitch, fadePose.roll);
    }
    if (oldDrawable.length && alphas.oldAlpha > 0) {
      if (alphas.oldAlpha < 0.999) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      }
      paint(oldDrawable, this._fadeW || this._tileW || 1, this._fadeH || this._tileH || 1, alphas.oldAlpha, false, fadePose.pitch, fadePose.roll);
      gl.disable(gl.BLEND);
    }
    if (paintBase && (!this._fading || alphas.newAlpha > 0.001)) {
      var baseEntry = this._showingEntry();
      var baseAlpha = this._fading ? alphas.newAlpha : 1;
      paint([basePiece], (baseEntry && baseEntry.width) || this._tileW || 1, (baseEntry && baseEntry.height) || this._tileH || 1, baseAlpha, false, pose.pitch, pose.roll);
    }
    if (drawable.length && alphas.newAlpha > 0.001) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      paint(drawable, span.w, span.h, alphas.newAlpha, true, pose.pitch, pose.roll);
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

  Player.prototype.wantsPhoneStream = function () {
    return !this._gl;
  };

  Player.prototype.draw = function () {
    if (this._holdFrame && !this._snapOn) return;
    // A connected phone stream is the picture. Canvas2D stays the fallback
    // for the frames before that socket delivers anything.
    if (this._cpuTiles && (this._streamActive || this._streamHold)) {
      if (!(this._streamHold && !this._streamActive)) return;
      resize(this.canvas);
      var holdCtx = this._cpuContext();
      var holdCanvas = this._cpuCanvas || this.canvas;
      if (holdCtx && holdCanvas) this._paintStreamHold(holdCtx, holdCanvas.width, holdCanvas.height);
      return;
    }
    if (this._cpuTiles) {
      var stamp = Date.now();
      if (this._cpuDrawStamp === stamp) {
        this._cpuDirty = true;
        return;
      }
      this._cpuDrawStamp = stamp;
    }
    resize(this.canvas);
    if (this._cpuTiles) this._drawCpuTiles();
    else if (this._mode === "webgl" && this._gl) this._drawGl();
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
    if (this._useTiles) {
      this._drawCpuTiles();
      return;
    }
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
    if (this._uploadPath === "pixels" || this._uploadPath === "cpu" || this._domUploadOk === false || source._pixels) return false;
    if (!shouldStripUpload(source.width, source.height)) return false;
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
    tex._contentW = source.width;
    tex._contentH = source.height;
    tex._spsUploaded = false;
    tex._mip = false;
    this._strip = { gl: gl, tex: tex, source: source, y: 0, rows: rows, w: source.width, h: source.height };
    this._uploadStripSlice();
    return !!this._strip || tex._mip === true;
  };

  Player.prototype._abortStrip = function (job, error) {
    this._strip = null;
    var tex = job && job.tex;
    var result = { ok: false, error: error || new Error("strip"), gl: "" };
    if (job && job.gl && tex && job.source && !this._cpuTiles) {
      result = this._uploadSource(job.gl, tex, job.source);
      var current = job.source;
      if (!result.ok) {
        var canvas = this._bitmapToCanvas(job.source);
        if (canvas) {
          current = canvas;
          result = this._uploadSource(job.gl, tex, canvas);
        }
      }
      if (!result.ok) {
        var pixels = this._bitmapToPixels(current || job.source);
        if (pixels) {
          current = pixels;
          result = this._uploadSource(job.gl, tex, pixels);
          if (result.ok) this._uploadPath = "pixels";
        }
      }
      if (result.ok) {
        try {
          this._finishSampler(job.gl, tex, job.w, job.h, current);
          tex._spsUploaded = true;
        } catch (err) {
          result = { ok: false, error: err, gl: this._readGlError(job.gl) };
        }
      }
    }
    if (!result.ok) {
      this._rememberUploadFailure(job && job.gl, job && job.source, "strip", result);
      if (uploadPathBroken(result)) this._engageCpu(result);
      tex = job && job.source ? this._acceptCpuTile(job.source, null) : null;
    }
    if (job && job.done) job.done(tex);
  };

  Player.prototype._uploadStripSlice = function () {
    var job = this._strip;
    if (!job) return;
    var rows = Math.min(job.rows, job.h - job.y);
    try {
      if (!this._stripCanvas) this._stripCanvas = document.createElement("canvas");
      if (this._stripCanvas.width !== job.w) this._stripCanvas.width = job.w;
      if (this._stripCanvas.height !== rows) this._stripCanvas.height = rows;
      var ctx = this._stripCanvas.getContext("2d");
      if (!ctx) {
        this._abortStrip(job, new Error("no canvas"));
        return;
      }
      ctx.drawImage(job.source, 0, job.y, job.w, rows, 0, 0, job.w, rows);
      job.gl.bindTexture(job.gl.TEXTURE_2D, job.tex);
      job.gl.texSubImage2D(job.gl.TEXTURE_2D, 0, 0, job.y, job.gl.RGBA, job.gl.UNSIGNED_BYTE, this._stripCanvas);
      job.y += rows;
    } catch (error) {
      this._abortStrip(job, error);
      return;
    }
    if (job.y < job.h) return;
    var tex = job.tex;
    var source = job.source;
    var done = job.done;
    this._strip = null;
    this._finishSampler(job.gl, tex, job.w, job.h, source);
    tex._spsUploaded = true;
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
    // A full-frame copy every vsync on a Mali TV runs the GPU out of memory
    // after about a minute and the picture glitches. A fresh copy a few times
    // a second is enough for the next-photo crossfade.
    var now = this._clock();
    if (this._snapCopiedAt && now - this._snapCopiedAt < 400) return;
    this._snapCopiedAt = now;
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
    this._readGlError(gl);
  };

  Player.prototype._clearGlError = function (gl) {
    this._readGlError(gl);
  };

  Player.prototype._readGlError = function (gl) {
    if (!gl || typeof gl.getError !== "function") return "";
    var names = [];
    for (var i = 0; i < 8; i++) {
      var code = 0;
      try { code = gl.getError() | 0; } catch (error) { break; }
      if (!code) break;
      names.push(GL_ERROR_NAMES[code] || ("0x" + code.toString(16)));
    }
    return names.join("+");
  };

  Player.prototype._glRenderer = function () {
    if (this._rendererName != null) return this._rendererName;
    var gl = this._gl;
    var name = "";
    if (gl && gl.getExtension && gl.getParameter) {
      try {
        var info = gl.getExtension("WEBGL_debug_renderer_info");
        if (info) name = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) || "");
      } catch (error) {}
    }
    this._rendererName = name;
    return name;
  };

  Player.prototype._rememberUploadFailure = function (gl, source, stage, result) {
    var thrown = result && result.error;
    var glErr = (result && result.gl) || "";
    if (!glErr && gl) glErr = this._readGlError(gl);
    var lost = !!(gl && gl.isContextLost && gl.isContextLost());
    var w = (source && (source.width || source.w)) || 0;
    var h = (source && (source.height || source.h)) || 0;
    var renderer = "";
    try { renderer = this._glRenderer(); } catch (error) {}
    var text = "texture upload failed"
      + " stage=" + (stage || "?")
      + " gl=" + (glErr || "none")
      + " lost=" + (lost ? "1" : "0")
      + " webgl2=" + (this._webgl2 ? "1" : "0")
      + " size=" + w + "x" + h
      + " source=" + sourceKind(source)
      + " path=" + (this._uploadPath || "dom");
    if (renderer) text += " renderer=" + String(renderer).slice(0, 80);
    if (thrown) {
      var thrownName = thrown.name ? String(thrown.name) : "Error";
      var thrownMessage = thrown.message ? String(thrown.message) : String(thrown);
      text += " throw=" + (thrownName + ": " + thrownMessage).slice(0, 120);
    }
    text = withBuild(text);
    this._lastUploadFail = text;
    this._uploadFailLogs = (this._uploadFailLogs || 0) + 1;
    if (this._uploadFailLogs <= 4) this._reportTv(text);
  };

  Player.prototype._engageCpu = function (result) {
    var why = this._lastUploadFail || "texture upload failed stage=unspecified";
    if (why.indexOf("Canvas2D") < 0) why += "; Canvas2D tiles";
    why = withBuild(why);
    this._cpuReason = why;
    this._diagNote = why;
    this._uploadPath = "cpu";
    if (this._cpuTiles) return;
    this._cpuTiles = true;
    this._uploadFailLogs = (this._uploadFailLogs || 0) + 1;
    if (this._uploadFailLogs <= 4) this._reportTv(why);
  };

  Player.prototype._acceptCpuTile = function (img, tile) {
    if (!img) return this._deferred(img, tile);
    img._cpuRetain = true;
    var sized = safeBitmap(img, tile);
    var w = sized.width;
    var h = sized.height;
    return {
      _cpu: true,
      _cpuImage: img,
      _spsUploaded: true,
      _mip: true,
      _uploadW: w,
      _uploadH: h,
      _contentW: w,
      _contentH: h,
      _bytes: 0,
      _tileId: tile && tile.id,
      deferred: false,
      _evicted: false,
      label: img.label,
    };
  };

  Player.prototype._bitmapToCanvas = function (source) {
    if (!source || source._pixels || !(source.width > 0) || !(source.height > 0)) return null;
    if (typeof HTMLCanvasElement !== "undefined" && source instanceof HTMLCanvasElement) return source;
    if (typeof document === "undefined" || !document.createElement) return null;
    try {
      var canvas = document.createElement("canvas");
      canvas.width = source.width;
      canvas.height = source.height;
      var ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(source, 0, 0);
      return canvas;
    } catch (error) {
      return null;
    }
  };

  Player.prototype._bitmapToPixels = function (source) {
    if (!source || !(source.width > 0) || !(source.height > 0)) return null;
    if (source._pixels && source.data) return source;
    var canvas = source;
    if (!(typeof HTMLCanvasElement !== "undefined" && source instanceof HTMLCanvasElement)) {
      canvas = this._bitmapToCanvas(source);
    }
    if (!canvas || !canvas.getContext) return null;
    try {
      var ctx = canvas.getContext("2d");
      if (!ctx || !ctx.getImageData) return null;
      var data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      if (!data || !data.data) return null;
      return { width: canvas.width, height: canvas.height, data: data.data, _pixels: true };
    } catch (error) {
      return null;
    }
  };

  Player.prototype._probeTypedUpload = function (gl) {
    var tex = gl.createTexture();
    if (!tex) return false;
    var ok = false;
    this._probeTypedGl = "";
    try {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      this._clearGlError(gl);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([8, 12, 16, 255]));
      var err = this._readGlError(gl);
      if (err) this._probeTypedGl = err;
      ok = !err && !(gl.isContextLost && gl.isContextLost());
    } catch (error) {
      ok = false;
      this._probeTypedGl = String(error && error.message || error);
    }
    try { gl.deleteTexture(tex); } catch (error) {}
    return ok;
  };

  Player.prototype._probeDomUpload = function (gl) {
    if (typeof document === "undefined" || !document.createElement) return null;
    var canvas = null;
    try {
      canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      var ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.fillStyle = "#14181c";
      ctx.fillRect(0, 0, 1, 1);
    } catch (error) {
      return null;
    }
    var tex = gl.createTexture();
    if (!tex) return false;
    var result = this._uploadSource(gl, tex, canvas);
    try { gl.deleteTexture(tex); } catch (error) {}
    this._probeDomGl = result && (result.gl || (result.error && result.error.message) || "");
    return !!(result && result.ok);
  };

  Player.prototype._probeUploads = function (gl) {
    if (!gl) return;
    var typed = this._probeTypedUpload(gl);
    var dom = this._probeDomUpload(gl);
    this._typedUploadOk = typed;
    this._domUploadOk = dom;
    if (dom === false && typed) this._uploadPath = "pixels";
    else if (dom === false && typed === false) {
      this._lastUploadFail = withBuild("texture upload failed stage=probe gl=" + (this._probeDomGl || this._probeTypedGl || "none")
        + " size=1x1 source=canvas path=probe");
      this._engageCpu({ gl: this._probeDomGl || this._probeTypedGl || "" });
    } else if (!this._uploadPath) this._uploadPath = "dom";
    var note = "upload probe typed=" + (typed ? "ok" : "fail")
      + " dom=" + (dom == null ? "skip" : (dom ? "ok" : "fail"))
      + " path=" + (this._uploadPath || "dom")
      + " webgl2=" + (this._webgl2 ? "1" : "0")
      + " lost=" + (gl.isContextLost && gl.isContextLost() ? "1" : "0");
    var renderer = this._glRenderer();
    if (renderer) note += " renderer=" + String(renderer).slice(0, 80);
    if (this._probeTypedGl) note += " typedGl=" + String(this._probeTypedGl).slice(0, 60);
    if (this._probeDomGl) note += " domGl=" + String(this._probeDomGl).slice(0, 60);
    note = withBuild(note);
    this._probeNote = note;
    this._send({ type: "log", message: note });
  };

  Player.prototype._cpuContext = function () {
    if (this._cpuCtx) return this._cpuCtx;
    var ctx = null;
    var overlay = null;
    if (typeof document !== "undefined" && document.createElement) {
      try {
        overlay = document.createElement("canvas");
        overlay._spsCpu = true;
        if (overlay.setAttribute) overlay.setAttribute("data-spsphere", "cpu-tiles");
        if (!overlay.style) overlay.style = {};
        overlay.style.position = "fixed";
        overlay.style.inset = "0";
        overlay.style.top = "0";
        overlay.style.left = "0";
        overlay.style.right = "0";
        overlay.style.bottom = "0";
        overlay.style.width = "100%";
        overlay.style.height = "100%";
        overlay.style.zIndex = "1";
        overlay.style.pointerEvents = "none";
        var host = this.canvas;
        if (host && host.parentNode && host.parentNode.insertBefore) host.parentNode.insertBefore(overlay, host.nextSibling);
        if (overlay.getContext) ctx = overlay.getContext("2d");
      } catch (error) {
        ctx = null;
      }
    }
    if (!ctx && this.canvas && this.canvas.getContext) {
      try { ctx = this.canvas.getContext("2d"); } catch (error) { ctx = null; }
      if (ctx) overlay = this.canvas;
    }
    this._cpuCanvas = overlay;
    this._cpuCtx = ctx;
    return ctx;
  };

  Player.prototype._cpuSpan = function () {
    var span = this._photoSpan();
    var entry = this._showingEntry();
    if (entry && entry.width > span.w) span = { w: entry.width, h: (entry.height > span.h ? entry.height : span.h) };
    return span;
  };

  Player.prototype._ensureCpuAtlas = function (key, spanW, spanH) {
    if (!this._cpuAtlases) this._cpuAtlases = {};
    var fit = cpuEquirectSize(spanW, spanH);
    var aw = fit.w;
    var ah = fit.h;
    var slot = this._cpuAtlases[key];
    if (slot && slot.canvas && slot.spanW === spanW && slot.spanH === spanH && slot.canvas.width === aw && slot.canvas.height === ah) return slot;
    var canvas = null;
    var ctx = null;
    if (typeof document !== "undefined" && document.createElement) {
      canvas = document.createElement("canvas");
      canvas.width = aw;
      canvas.height = ah;
      ctx = canvas.getContext("2d");
    }
    slot = { key: key, canvas: canvas, ctx: ctx, spanW: spanW, spanH: spanH, seen: {}, queue: [], width: aw, height: ah };
    this._cpuAtlases[key] = slot;
    return slot;
  };

  Player.prototype._enqueueCpuPieces = function (list, key, spanW, spanH) {
    var atlas = this._ensureCpuAtlas(key, spanW, spanH);
    if (!list) return atlas;
    for (var i = 0; i < list.length; i++) {
      var piece = list[i];
      var tex = piece && piece.tex;
      var img = (tex && tex._cpuImage) || (piece && piece.image) || null;
      var tile = piece && (piece.spec || piece.tile || (tex && tex._window));
      if (!img || !tile || !(tile.srcW > 0) || !(tile.srcH > 0)) continue;
      if (!img._cpuStamp) {
        this._cpuStamp = (this._cpuStamp || 0) + 1;
        img._cpuStamp = this._cpuStamp;
      }
      var id = (tile.id || (tile.srcX + ":" + tile.srcY)) + ":" + img._cpuStamp;
      if (atlas.seen[id]) continue;
      atlas.seen[id] = true;
      atlas.queue.push({ img: img, tile: tile });
    }
    return atlas;
  };

  Player.prototype._paintCpuUnderlay = function (atlas) {
    if (!atlas || !atlas.ctx) return;
    var base = this._activeBase();
    var img = base && base.tex && base.tex._cpuImage;
    if (!img || !base.tile) return;
    if (!img._cpuStamp) {
      this._cpuStamp = (this._cpuStamp || 0) + 1;
      img._cpuStamp = this._cpuStamp;
    }
    var id = (base.tile.id || "base") + ":" + img._cpuStamp;
    if (atlas.underlay === id) return;
    if (paintTileOnAtlas(atlas.ctx, atlas.width, atlas.height, img, base.tile, atlas.spanW, atlas.spanH) > 0) {
      atlas.underlay = id;
      this._noteCpuComposite(img, base.tile);
    }
  };

  Player.prototype._flushCpuAtlas = function (atlas, limit) {
    if (!atlas || !atlas.ctx || !atlas.queue || !atlas.queue.length) return 0;
    var n = 0;
    var cap = limit > 0 ? limit : 1;
    while (atlas.queue.length && n < cap) {
      var job = atlas.queue.shift();
      var parts = paintTileOnAtlas(atlas.ctx, atlas.width, atlas.height, job.img, job.tile, atlas.spanW, atlas.spanH);
      if (parts > 0) {
        n += 1;
        this._noteCpuComposite(job.img, job.tile);
      }
    }
    return n;
  };

  Player.prototype._noteCpuComposite = function (img, tile) {
    var imgW = (img && img.width) || 0;
    var imgH = (img && img.height) || 0;
    var srcW = (tile && tile.srcW) || 0;
    var id = String((tile && tile.id) || "");
    var overview = !!(tile && (tile._overview || tile._base)) || /overview/i.test(id) || (imgW > 0 && imgW <= 256 && srcW > imgW * 4);
    if (overview) {
      this._cpuOverview = (this._cpuOverview || 0) + 1;
    } else {
      this._cpuDetail = (this._cpuDetail || 0) + 1;
      this._cpuDetailPx = (this._cpuDetailPx || 0) + imgW * imgH;
    }
    var line = "canvas2d composed detail " + (this._cpuDetail || 0)
      + " overview " + (this._cpuOverview || 0)
      + " detailPx " + (this._cpuDetailPx || 0);
    if (line !== this._cpuComposeLog) {
      this._cpuComposeLog = line;
      this._reportTv(withBuild(line));
    }
  };

  Player.prototype._drawCpuTiles = function () {
    var ctx = this._cpuContext();
    if (!ctx) return 0;
    var host = this.canvas || this._cpuCanvas;
    var canvas = this._cpuCanvas || host;
    var w = (host && host.width) || (canvas && canvas.width) || 1280;
    var h = (host && host.height) || (canvas && canvas.height) || 720;
    if (w < 2) w = 1280;
    if (h < 2) h = 720;
    var span = this._cpuSpan();
    var pose = (this.poses && this.poses[this.index]) || ZERO_POSE;
    var fadePose = this._fadePose || ZERO_POSE;
    var oldList = this._fading ? (this._fadeFrom || []) : [];
    var newList = this._tileDraw || [];
    var haveOld = oldList.length > 0;
    var haveNew = newList.length > 0;
    var alphas = compositeAlphas(this._fadeMs, haveOld, haveNew, this._fadeLimit || TILE_FADE_MS);
    var posePitch = ((pose.pitch || 0) * 180) / Math.PI;
    var oldPosePitch = ((fadePose.pitch || 0) * 180) / Math.PI;
    var oldSpanW = this._fadeW || span.w;
    var oldSpanH = this._fadeH || span.h;
    this._noteCpuResidents(newList);
    if (haveOld) this._noteCpuResidents(oldList);
    var cols = this._cpuMeshCols || 16;
    var rows = this._cpuMeshRows || 9;
    var panel = cpuPanelCap(w, h);
    var qual = cpuQualityStep(this._cpuDrawMs || 0, this._cpuGapMs || 0, this._cpuViewW || 0, cols, panel.w, this._cpuSlow || 0);
    cols = qual.cols;
    rows = qual.rows;
    var fit = cpuRenderSize(panel.w, panel.h, 0, qual.w);
    var rw = fit.w;
    var rh = fit.h;
    this._cpuViewW = rw;
    this._cpuViewH = rh;
    this._cpuMeshCols = cols;
    this._cpuMeshRows = rows;
    if (canvas) {
      if (canvas.width !== rw) canvas.width = rw;
      if (canvas.height !== rh) canvas.height = rh;
    }
    var debugMode = spsDebugMode();
    var sizeLine = "canvas2d render " + rw + "x" + rh + " mesh " + cols + "x" + rows + " unique " + (this._cpuDetail || 0) + (debugMode ? " debug " + debugMode : "");
    if (sizeLine !== this._cpuSizeLog && (haveNew || haveOld)) {
      this._cpuSizeLog = sizeLine;
      this._reportTv(withBuild(sizeLine));
    }
    var nowDraw = Date.now();
    var moved = Math.abs((this.yaw || 0) - (this._cpuYaw || 0))
      + Math.abs((this.pitch || 0) - (this._cpuPitch || 0))
      + Math.abs((this.roll || 0) - (this._cpuRoll || 0))
      + Math.abs((this.fov || 0) - (this._cpuFov || 0));
    var age = nowDraw - (this._cpuDrewAt || 0);
    var minAge = this.manual ? 32 : 28;
    if (!this._cpuDirty && !this._fading && this._cpuDrewAt && age < minAge && moved < (this.manual ? 0.35 : 0.08)) {
      return this._cpuDrawn || 0;
    }
    var gap = this._cpuPaintAt ? nowDraw - this._cpuPaintAt : 0;
    this._cpuPaintAt = nowDraw;
    ctx.fillStyle = "#0b0d10";
    ctx.fillRect(0, 0, rw, rh);
    var drawn = 0;
    var t0 = Date.now();
    var under = this._cpuUnderlayPiece();
    if (haveOld && alphas.oldAlpha > 0) {
      drawn += paintStripView(ctx, oldList, under, oldSpanW, oldSpanH, this.yaw, (this.pitch || 0) + oldPosePitch, this.roll || 0, this.fov, fadePose.pitch || 0, fadePose.roll || 0, rw, rh, alphas.oldAlpha, cols, rows);
    }
    if (haveNew && (!haveOld || alphas.newAlpha > 0.001)) {
      var show = haveOld ? alphas.newAlpha : 1;
      if (show > 0) {
        drawn += paintStripView(ctx, newList, under, span.w, span.h, this.yaw, (this.pitch || 0) + posePitch, this.roll || 0, this.fov, pose.pitch || 0, pose.roll || 0, rw, rh, show, cols, rows);
      }
    }
    var drawMs = Date.now() - t0;
    this._cpuDrawMs = this._cpuDrawMs ? this._cpuDrawMs * 0.6 + drawMs * 0.4 : drawMs;
    this._cpuSlow = drawMs > 55 ? (this._cpuSlow || 0) + 1 : 0;
    if (gap > 0) this._cpuGapMs = this._cpuGapMs ? this._cpuGapMs * 0.6 + gap * 0.4 : gap;
    this._cpuFrames = (this._cpuFrames || 0) + 1;
    this._cpuFrameSum = (this._cpuFrameSum || 0) + drawMs;
    this._cpuGapSum = (this._cpuGapSum || 0) + (gap > 0 ? gap : 0);
    this._cpuGapN = (this._cpuGapN || 0) + (gap > 0 ? 1 : 0);
    var queue = ((this._decodeQueue && this._decodeQueue.length) || 0) + ((this._uploadQueue && this._uploadQueue.length) || 0);
    if (!this._cpuFpsLogAt) this._cpuFpsLogAt = nowDraw;
    if (nowDraw - this._cpuFpsLogAt >= 2000 && this._cpuFrames > 0) {
      var avgDraw = Math.round(this._cpuFrameSum / this._cpuFrames);
      var avgGap = this._cpuGapN ? Math.round(this._cpuGapSum / this._cpuGapN) : 0;
      var delivered = avgGap > 0 ? Math.round(1000 / avgGap) : 0;
      var outside = avgGap > avgDraw ? avgGap - avgDraw : 0;
      this._reportTv(withBuild(
        "canvas2d cadence draw " + avgDraw + "ms gap " + avgGap + "ms delivered " + delivered
        + " outside " + outside
        + " view " + rw + "x" + rh
        + " mesh " + cols + "x" + rows
        + " unique " + (this._cpuDetail || 0)
        + " overview " + (this._cpuOverview || 0)
        + " queue " + queue
        + " fade " + (this._fading ? 1 : 0)
      ));
      this._cpuFpsLogAt = nowDraw;
      this._cpuFrames = 0;
      this._cpuFrameSum = 0;
      this._cpuGapSum = 0;
      this._cpuGapN = 0;
    }
    this._cpuDirty = false;
    this._cpuDrewAt = nowDraw;
    this._cpuYaw = this.yaw || 0;
    this._cpuPitch = this.pitch || 0;
    this._cpuRoll = this.roll || 0;
    this._cpuFov = this.fov || 0;
    this._cpuDrawn = (this._cpuDrawn || 0) + drawn;
    return drawn;
  };

  Player.prototype._paintStreamHold = function (ctx, width, height) {
    if (!ctx || !(width > 0) || !(height > 0)) return 0;
    ctx.fillStyle = "#0b0d10";
    if (ctx.fillRect) ctx.fillRect(0, 0, width, height);
    var under = this._cpuUnderlayPiece();
    var img = under && under.tex && under.tex._cpuImage;
    if (!img || !(img.width > 0) || !ctx.drawImage) return 0;
    try {
      ctx.drawImage(img, 0, 0, width, height);
      return 1;
    } catch (error) {
      return 0;
    }
  };

  Player.prototype._cpuUnderlayPiece = function () {
    var base = this._activeBase && this._activeBase();
    var img = base && base.tex && base.tex._cpuImage;
    if (!img || !base.tile) return null;
    return { tex: base.tex, tile: base.tile };
  };

  Player.prototype._noteCpuResidents = function (list) {
    if (!list) return;
    if (!this._cpuSeen) this._cpuSeen = {};
    var changed = false;
    for (var i = 0; i < list.length; i++) {
      var piece = list[i];
      var tex = piece && piece.tex;
      var img = (tex && tex._cpuImage) || (piece && piece.image) || null;
      var tile = piece && (piece.spec || piece.tile || (tex && tex._window));
      if (!img || !tile) continue;
      var id = String(tile.id || ((tile.srcX || 0) + ":" + (tile.srcY || 0)));
      if (this._cpuSeen[id]) continue;
      this._cpuSeen[id] = 1;
      changed = true;
      var imgW = img.width || 0;
      var imgH = img.height || 0;
      var srcW = tile.srcW || 0;
      var overview = !!(tile._overview || tile._base) || /overview/i.test(id) || (imgW > 0 && imgW <= 256 && srcW > imgW * 4);
      if (overview) this._cpuOverview = (this._cpuOverview || 0) + 1;
      else {
        this._cpuDetail = (this._cpuDetail || 0) + 1;
        this._cpuDetailPx = (this._cpuDetailPx || 0) + imgW * imgH;
      }
      this._cpuDirty = true;
    }
    if (!changed) return;
    var line = "canvas2d composed unique " + (this._cpuDetail || 0)
      + " overview " + (this._cpuOverview || 0)
      + " detailPx " + (this._cpuDetailPx || 0);
    if (line !== this._cpuComposeLog) {
      this._cpuComposeLog = line;
      this._reportTv(withBuild(line));
    }
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
    heartbeat: 1, ping: 1, speed: 1, aim: 1, chunk: 1, fetchError: 1,
    retile: 1, fov: 1, pace: 1, fade: 1, hello: 1, debug: 1,
    lan: 1, "soft-reset": 1, softReset: 1,
    stream: 1, "stream-choice": 1,
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

  // Phone-rendered picture for a TV with no WebGL. The socket is the aim
  // URL with /stream in place of /aim. The phone chooses h264-mse or jpeg-ws
  // after the probe. Canvas2D keeps drawing until a stream frame is shown.
  function acceptStreamSocket(url) {
    if (typeof url !== "string" || url.length > 300) return "";
    var aim = url.replace(/\/stream$/, "/aim");
    if (aim === url) return "";
    if (!acceptAimSocket(aim)) return "";
    return url;
  }

  function streamUrlFromAim(url) {
    var aim = acceptAimSocket(url);
    if (!aim) return "";
    return aim.replace(/\/aim$/, "/stream");
  }

  function normalizeStreamMode(mode) {
    var name = String(mode || "").toLowerCase();
    if (name === "h264-mse" || name === "h264" || name === "mse") return "h264-mse";
    if (name === "jpeg-ws" || name === "jpeg" || name === "jpegws") return "jpeg-ws";
    return "";
  }

  function safeCodec(codec) {
    var text = String(codec || "");
    if (!/^[a-zA-Z0-9.]{4,32}$/.test(text)) return "";
    return text;
  }

  // avc1.000001 is the Annex-B start code 00 00 01, not a profile. MediaSource
  // rejects it. A real codec is avc1 plus six hex digits.
  function usableAvcCodec(codec) {
    var text = safeCodec(codec);
    if (!/^avc1\.[0-9A-Fa-f]{6}$/.test(text)) return "";
    if (text.toLowerCase() === "avc1.000000" || text.toLowerCase() === "avc1.000001") return "";
    return text;
  }

  function streamProbe(hasWebgl, hasMse) {
    if (hasWebgl) return null;
    var modes = [];
    if (hasMse) modes.push("h264-mse");
    modes.push("jpeg-ws");
    return {
      type: "stream-probe",
      webgl: false,
      mse: !!hasMse,
      modes: modes,
      maxW: 1280,
      maxH: 720,
      build: RECEIVER_BUILD,
      log: "stream probe webgl=0 mse=" + (hasMse ? "1" : "0") + " modes=" + modes.join(",") + " max=1280x720",
    };
  }

  // One rebuild asks the phone for a new init segment and a keyframe at
  // 720p. The next failure leaves H.264 and the phone should send JPEG.
  function mseFailureAction(rebuilds) {
    if ((rebuilds | 0) < 1) {
      return {
        action: "reset",
        message: { type: "stream-reset", reason: "mse-decode", maxW: 1280, maxH: 720 },
      };
    }
    return {
      action: "fallback",
      message: { type: "stream-fallback", reason: "mse-decode" },
    };
  }

  function fmp4Init(bytes) {
    if (!bytes) return false;
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var n = u8.length < 96 ? u8.length : 96;
    for (var i = 0; i + 3 < n; i++) {
      if (u8[i] === 102 && u8[i + 1] === 116 && u8[i + 2] === 121 && u8[i + 3] === 112) return true;
      if (u8[i] === 109 && u8[i + 1] === 111 && u8[i + 2] === 111 && u8[i + 3] === 118) return true;
    }
    return false;
  }

  function readU32(u8, offset) {
    return ((u8[offset] * 16777216) + (u8[offset + 1] * 65536) + (u8[offset + 2] * 256) + u8[offset + 3]) >>> 0;
  }

  function mp4Boxes(bytes) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    var boxes = [];
    var offset = 0;
    while (offset + 8 <= u8.length) {
      var size = readU32(u8, offset);
      var type = String.fromCharCode(u8[offset + 4], u8[offset + 5], u8[offset + 6], u8[offset + 7]);
      var header = 8;
      if (size === 1) {
        if (offset + 16 > u8.length) break;
        var hi = readU32(u8, offset + 8);
        var lo = readU32(u8, offset + 12);
        size = hi * 4294967296 + lo;
        header = 16;
      } else if (size === 0) {
        size = u8.length - offset;
      }
      if (!(size >= header) || offset + size > u8.length) break;
      boxes.push({ type: type, size: size, start: offset, end: offset + size });
      offset += size;
    }
    return { boxes: boxes, rest: offset };
  }

  function mp4Hex(bytes, count) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    var n = Math.min(count > 0 ? count : 64, u8.length);
    var out = "";
    for (var i = 0; i < n; i++) {
      var hex = u8[i].toString(16);
      if (hex.length < 2) hex = "0" + hex;
      out += hex;
    }
    return out;
  }

  function mp4BoxList(bytes) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    var parsed = mp4Boxes(u8);
    var parts = [];
    for (var i = 0; i < parsed.boxes.length; i++) {
      parts.push(parsed.boxes[i].type + ":" + parsed.boxes[i].size);
    }
    if (parsed.rest < u8.length) parts.push("partial:" + (u8.length - parsed.rest));
    return parts.join(",") || "none";
  }

  // One websocket message may hold the init and the first media segment, or
  // only the front of a box. Init is appended by itself. A moof stays with
  // its mdat. Bytes after the last complete box are returned as rest.
  function mp4AppendUnits(bytes) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    var parsed = mp4Boxes(u8);
    var units = [];
    var initStart = -1;
    var initEnd = -1;
    var boxes = parsed.boxes;
    var i = 0;
    function flushInit() {
      if (initStart < 0) return;
      units.push({ kind: "init", start: initStart, end: initEnd });
      initStart = -1;
      initEnd = -1;
    }
    while (i < boxes.length) {
      var box = boxes[i];
      var initBox = box.type === "ftyp" || box.type === "moov" || box.type === "free" || box.type === "skip" || box.type === "wide";
      if (initBox) {
        if (initStart < 0) initStart = box.start;
        initEnd = box.end;
        i += 1;
        continue;
      }
      flushInit();
      if (box.type === "moof" || box.type === "mdat") {
        var end = box.end;
        if (box.type === "moof" && i + 1 < boxes.length && boxes[i + 1].type === "mdat") {
          end = boxes[i + 1].end;
          i += 2;
        } else {
          i += 1;
        }
        units.push({ kind: "media", start: box.start, end: end });
        continue;
      }
      i += 1;
    }
    flushInit();
    return { units: units, rest: parsed.rest };
  }

  function streamChoose(hasMse, request) {
    var mode = normalizeStreamMode(request && request.mode);
    if (!mode) return null;
    if (mode === "h264-mse" && !hasMse) mode = "jpeg-ws";
    var ws = "";
    var given = request && (request.ws || request.streamWs) || "";
    if (given) ws = acceptStreamSocket(given) || streamUrlFromAim(given);
    var codec = safeCodec(request && request.codec);
    return {
      mode: mode,
      codec: codec,
      ws: ws,
      choiceLog: "stream choice " + mode,
      announce: { type: "stream-announce", mode: mode, codec: codec, maxW: 1280, maxH: 720, build: RECEIVER_BUILD },
      announceLog: "stream announce " + mode,
    };
  }

  function codecFromAvcC(bytes) {
    if (!bytes) return "";
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (var i = 0; i + 7 < u8.length; i++) {
      if (u8[i] !== 97 || u8[i + 1] !== 118 || u8[i + 2] !== 99 || u8[i + 3] !== 67) continue;
      function hex(n) {
        var s = (n & 255).toString(16).toUpperCase();
        return s.length < 2 ? "0" + s : s;
      }
      return safeCodec("avc1." + hex(u8[i + 5]) + hex(u8[i + 6]) + hex(u8[i + 7]));
    }
    return "";
  }

  function jpegFrame(bytes) {
    if (!bytes) return false;
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return u8.length >= 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff;
  }

  function socketDisconnectLog(kind, remote, code, reason) {
    var name = kind === "stream" ? "stream" : "aim";
    var why = String(reason == null ? "" : reason).replace(/[\r\n]/g, " ").slice(0, 120);
    var num = code == null ? "" : String(code);
    return name + " disconnect remote=" + String(remote || "") + " code=" + num + " reason=" + why;
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
      var streamMsg = msg.type === "stream" || msg.type === "stream-choice";
      var socket = streamMsg ? (acceptStreamSocket(msg.ws) || streamUrlFromAim(msg.ws)) : acceptAimSocket(msg.ws);
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

  // Inverse of applyPose. poseToCamera is Rx(-pitch) then Ry(-roll) in the
  // swapped frame, so the mesh is Rz/Ry(+roll) then Rx(+pitch) back to world.
  function undoPose(dir, pitchRad, rollRad) {
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
    var rx = cr * nx + sr * nz;
    var ry = ny;
    var rz = -sr * nx + cr * nz;
    var py = cp * ry - sp * rz;
    var pz = sp * ry + cp * rz;
    return [rx, pz, -py];
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

  var GL_ERROR_NAMES = {
    1280: "INVALID_ENUM",
    1281: "INVALID_VALUE",
    1282: "INVALID_OPERATION",
    1283: "STACK_OVERFLOW",
    1285: "OUT_OF_MEMORY",
    1286: "INVALID_FRAMEBUFFER_OPERATION",
    37442: "CONTEXT_LOST_WEBGL",
  };

  function uploadPathBroken(result) {
    if (!result) return true;
    var gl = String(result.gl || "");
    if (gl.indexOf("OUT_OF_MEMORY") >= 0) return false;
    var msg = String((result.error && result.error.message) || "");
    if (/out of memory/i.test(msg)) return false;
    return true;
  }

  function sourceKind(source) {
    if (!source) return "none";
    if (source._kind) return source._kind;
    if (source._pixels) return "pixels";
    try {
      if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) return "ImageBitmap";
      if (typeof HTMLCanvasElement !== "undefined" && source instanceof HTMLCanvasElement) return "canvas";
      if (typeof HTMLImageElement !== "undefined" && source instanceof HTMLImageElement) return "image";
      if (typeof OffscreenCanvas !== "undefined" && source instanceof OffscreenCanvas) return "offscreencanvas";
    } catch (error) {}
    try {
      if (source.width && source.height) return "bitmap";
    } catch (error) {}
    return "unknown";
  }

  function safeBitmap(img, tile) {
    var w = 0;
    var h = 0;
    var source = img;
    try {
      if (img && img.width) w = img.width;
      if (img && img.height) h = img.height;
    } catch (error) {
      source = null;
    }
    if (!(w > 0) && tile) w = tile.texW || tile.srcW || 0;
    if (!(h > 0) && tile) h = tile.texH || tile.srcH || 0;
    if (!source) source = { width: w, height: h };
    else {
      try {
        source = { width: w, height: h, _kind: sourceKind(img) };
      } catch (error) {
        source = { width: w, height: h };
      }
    }
    source.width = w;
    source.height = h;
    return source;
  }

  function equirectWindow(spanW, spanH, yaw, pitch, fov, viewW, viewH) {
    var useFov = fov > 1 ? fov : 75;
    var fovFrac = useFov / 360;
    var center = ((0.5 + (yaw || 0) / 360) % 1 + 1) % 1;
    var srcW = spanW * fovFrac;
    if (!(srcW > 1)) srcW = 1;
    var srcX = center * spanW - srcW / 2;
    var aspect = viewW / Math.max(viewH, 1);
    var vFrac = (useFov / aspect) / 180;
    var centerV = 0.5 - (pitch || 0) / 180;
    var srcH = spanH * vFrac;
    if (!(srcH > 1)) srcH = 1;
    if (srcH > spanH) srcH = spanH;
    var srcY = centerV * spanH - srcH / 2;
    if (srcY < 0) srcY = 0;
    if (srcY + srcH > spanH) srcY = Math.max(0, spanH - srcH);
    return { x: srcX, y: srcY, w: srcW, h: srcH };
  }

  function tilePhotoSegments(tile, spanW) {
    var segs = [];
    var span = spanW > 0 ? spanW : 1;
    var remain = tile && tile.srcW > 0 ? tile.srcW : 0;
    var local = 0;
    var photo = tile ? tile.srcX : 0;
    var guard = 0;
    while (remain > 0.5 && guard < 4) {
      guard += 1;
      var photoMod = photo % span;
      if (photoMod < 0) photoMod += span;
      var room = span - photoMod;
      var take = remain < room ? remain : room;
      if (!(take > 0)) break;
      segs.push({ photoX: photoMod, photoW: take, localX: local });
      local += take;
      remain -= take;
      photo += take;
    }
    return segs;
  }

  function blitTile(ctx, img, tile, viewX, viewY, viewW, viewH, screenX, screenY, screenW, screenH, spanW) {
    var segs = tilePhotoSegments(tile, spanW || (tile.srcX + tile.srcW));
    var y0 = tile.srcY > viewY ? tile.srcY : viewY;
    var y1 = tile.srcY + tile.srcH;
    var viewB = viewY + viewH;
    if (y1 > viewB) y1 = viewB;
    if (!(y1 > y0)) return false;
    var imgW = img.width || tile.texW || tile.srcW;
    var imgH = img.height || tile.texH || tile.srcH;
    var texW = tile.texW || imgW;
    var texH = tile.texH || imgH;
    var scaleX = imgW / texW;
    var scaleY = imgH / texH;
    var drawn = false;
    for (var s = 0; s < segs.length; s++) {
      var seg = segs[s];
      var x0 = seg.photoX > viewX ? seg.photoX : viewX;
      var x1 = seg.photoX + seg.photoW;
      var viewR = viewX + viewW;
      if (x1 > viewR) x1 = viewR;
      if (!(x1 > x0)) continue;
      var local = seg.localX + (x0 - seg.photoX);
      var sx = ((tile.padL || 0) + local) * scaleX;
      var sy = ((tile.padT || 0) + (y0 - tile.srcY)) * scaleY;
      var sw = (x1 - x0) * scaleX;
      var sh = (y1 - y0) * scaleY;
      if (!(sw > 0) || !(sh > 0)) continue;
      var dx = screenX + ((x0 - viewX) / viewW) * screenW;
      var dy = screenY + ((y0 - viewY) / viewH) * screenH;
      var dw = ((x1 - x0) / viewW) * screenW;
      var dh = ((y1 - y0) / viewH) * screenH;
      try {
        ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
        drawn = true;
      } catch (error) {}
    }
    return drawn;
  }

  function paintTileOnAtlas(ctx, atlasW, atlasH, img, tile, spanW, spanH) {
    if (!ctx || !img || !tile || !(spanW > 0) || !(spanH > 0)) return 0;
    var segs = tilePhotoSegments(tile, spanW);
    var imgW = img.width || tile.texW || tile.srcW || 1;
    var imgH = img.height || tile.texH || tile.srcH || 1;
    var texW = tile.texW || imgW;
    var texH = tile.texH || imgH;
    var photoW = tile.srcW || texW || imgW;
    var photoH = tile.srcH || texH || imgH;
    // A 64px overview stands in for the whole photo. A 4064px strip is already
    // in photo pixels and has to be copied at that width, not stretched from
    // the overview.
    var downscale = imgW > 0 && photoW > imgW * 2;
    var scaleX = downscale ? imgW / photoW : imgW / (texW || imgW);
    var scaleY = downscale ? imgH / photoH : imgH / (texH || imgH);
    var drawn = 0;
    for (var s = 0; s < segs.length; s++) {
      var seg = segs[s];
      var sx = ((tile.padL || 0) + seg.localX) * scaleX;
      var sy = (tile.padT || 0) * scaleY;
      var sw = seg.photoW * scaleX;
      var sh = tile.srcH * scaleY;
      if (!(sw > 0) || !(sh > 0)) continue;
      var dx = (seg.photoX / spanW) * atlasW;
      var dy = (tile.srcY / spanH) * atlasH;
      var dw = (seg.photoW / spanW) * atlasW;
      var dh = (tile.srcH / spanH) * atlasH;
      try {
        ctx.drawImage(img, sx, sy, Math.max(sw, 1), Math.max(sh, 1), dx, dy, Math.max(dw, 1), Math.max(dh, 1));
        drawn += 1;
      } catch (error) {}
    }
    return drawn;
  }

  function paintEquirectTiles(ctx, pieces, spanW, spanH, yaw, pitch, fov, viewW, viewH, alpha) {
    if (!ctx || !(alpha > 0) || !(spanW > 0) || !(spanH > 0) || !pieces || !pieces.length) return 0;
    var win = equirectWindow(spanW, spanH, yaw, pitch, fov, viewW, viewH);
    var drawn = 0;
    if (ctx.save) ctx.save();
    ctx.globalAlpha = alpha;
    function paint(photoX, photoW, screenX, screenW) {
      if (!(photoW > 0) || !(screenW > 0)) return;
      for (var i = 0; i < pieces.length; i++) {
        var piece = pieces[i];
        if (!piece) continue;
        var tex = piece.tex;
        var img = (tex && tex._cpuImage) || piece.image || null;
        var tile = piece.spec || piece.tile || (tex && tex._window);
        if (!img || !tile || !(tile.srcW > 0) || !(tile.srcH > 0)) continue;
        if (blitTile(ctx, img, tile, photoX, win.y, photoW, win.h, screenX, 0, screenW, viewH, spanW)) drawn += 1;
      }
    }
    var srcX = win.x;
    var srcW = win.w;
    if (srcX < 0) {
      var leftW = -srcX;
      paint(spanW - leftW, leftW, 0, (leftW / srcW) * viewW);
      paint(0, srcW - leftW, (leftW / srcW) * viewW, ((srcW - leftW) / srcW) * viewW);
    } else if (srcX + srcW > spanW) {
      var right = spanW - srcX;
      paint(srcX, right, 0, (right / srcW) * viewW);
      paint(0, srcW - right, (right / srcW) * viewW, ((srcW - right) / srcW) * viewW);
    } else {
      paint(srcX, srcW, 0, viewW);
    }
    if (ctx.restore) ctx.restore();
    return drawn;
  }

  function cpuEquirectSize(spanW, spanH) {
    var sw = spanW > 1 ? spanW : 2;
    var sh = spanH > 1 ? spanH : 2;
    var aw = sw > CPU_EQUIRECT_MAX_W ? CPU_EQUIRECT_MAX_W : sw;
    var ah = aw * sh / sw;
    if (ah > CPU_EQUIRECT_MAX_H) {
      ah = CPU_EQUIRECT_MAX_H;
      aw = ah * sw / sh;
    }
    var pixels = CPU_EQUIRECT_MAX_W * CPU_EQUIRECT_MAX_H;
    if (aw * ah > pixels) {
      var scale = Math.sqrt(pixels / (aw * ah));
      aw *= scale;
      ah *= scale;
    }
    return { w: Math.max(2, Math.round(aw)), h: Math.max(2, Math.round(ah)) };
  }

  // Cast's layout canvas is often 1280 CSS pixels on a 4K panel. The paint
  // has room for a 1080p backing store, which CSS then scales to the panel.
  function cpuPanelCap(clientW, clientH) {
    var w = clientW > 2 ? clientW : 1280;
    var h = clientH > 2 ? clientH : 720;
    try {
      if (root.screen && root.screen.width > w) w = root.screen.width;
      if (root.screen && root.screen.height > h) h = root.screen.height;
    } catch (error) {}
    if (w >= 960 && h >= 540 && w < 1920) {
      w = 1920;
      h = 1080;
    }
    if (w > 1920) w = 1920;
    if (h > 1080) h = 1080;
    return { w: w, h: h };
  }

  function spsDebugMode() {
    var flag = "";
    try {
      if (root.__spsDebug) flag = String(root.__spsDebug);
      else if (root.location) {
        var q = String(root.location.search || "") + String(root.location.hash || "");
        var match = /(?:^|[?&#])spsdebug=([a-z]+)/i.exec(q);
        if (match) flag = match[1].toLowerCase();
      }
    } catch (error) {}
    if (flag === "mesh" || flag === "strips" || flag === "columns") return flag;
    return "";
  }

  function cpuRenderSize(clientW, clientH, frameMs, prevW) {
    var cw = clientW > 2 ? clientW : 1280;
    var ch = clientH > 2 ? clientH : 720;
    var aspect = cw / ch;
    var maxW = cw > CPU_VIEW_MAX_W ? CPU_VIEW_MAX_W : cw;
    var maxH = ch > CPU_VIEW_MAX_H ? CPU_VIEW_MAX_H : ch;
    if (maxW / maxH > aspect) maxW = maxH * aspect;
    else maxH = maxW / aspect;
    var target = prevW > 0 ? prevW : Math.min(1280, maxW);
    // A slow frame steps down, and a run of cheap frames climbs back toward
    // 1080p. The onn path dropped to 960x540 on the first expensive mesh and
    // never returned, which is the soft picture on a 4K panel.
    if (frameMs > 90 && target > 960) target = Math.max(960, target * 0.8);
    else if (frameMs > 0 && frameMs < 40 && target < maxW) target = Math.min(maxW, target * 1.15);
    if (target > maxW) target = maxW;
    if (target < 960 && maxW >= 960) target = 960;
    var tw = Math.max(2, Math.round(target));
    var th = Math.max(2, Math.round(tw / aspect));
    if (th > CPU_VIEW_MAX_H) {
      th = CPU_VIEW_MAX_H;
      tw = Math.max(2, Math.round(th * aspect));
    }
    return { w: tw, h: th };
  }

  // drawMs is the paint itself. gapMs is the wall time from one paint to the
  // next, including decode, Cast traffic, and the wait for the next frame.
  // A 64ms paint delivered every 250ms is 4 fps. The gap decides the rate.
  // Only a long paint shrinks the mesh, then the view. A long gap caused by
  // a JPEG decode does not throw away resolution.
  function cpuQualityStep(drawMs, gapMs, prevW, prevCols, maxW, slowStreak) {
    slowStreak = slowStreak || 0;
    var cols = prevCols > 4 ? prevCols : 16;
    var cap = maxW > 320 ? maxW : 1920;
    var w = prevW > 320 ? prevW : Math.min(1280, cap);
    // One slow paint, such as the doubled fade frame, must not retile the
    // mesh. The onn jumped 16x9 to 8x5 and back in one second, which moves
    // every seam.
    if (drawMs > 55 && cols > 8 && slowStreak >= 3) cols -= 4;
    else if (drawMs > 80 && cols <= 8 && w > 960 && slowStreak >= 3) w = Math.max(960, Math.round(w * 0.8));
    else if (drawMs > 0 && drawMs < 20 && gapMs > 0 && gapMs < 55) {
      if (w < cap) w = Math.min(cap, Math.round(w * 1.2));
      else if (cols < 16) cols += 4;
    }
    if (w > cap) w = cap;
    var rows = Math.max(5, Math.round(cols * 9 / 16));
    return { w: Math.round(w), cols: cols, rows: rows };
  }

  function cpuDeliveredFps(gaps) {
    if (!gaps || !gaps.length) return 0;
    var sum = 0;
    var n = 0;
    for (var i = 0; i < gaps.length; i++) {
      if (!(gaps[i] > 0)) continue;
      sum += gaps[i];
      n += 1;
    }
    if (!(n > 0) || !(sum > 0)) return 0;
    return Math.round(1000 / (sum / n));
  }

  function pieceImage(piece) {
    var tex = piece && piece.tex;
    return (tex && tex._cpuImage) || (piece && piece.image) || null;
  }

  function pieceTile(piece) {
    var tex = piece && piece.tex;
    return piece && (piece.spec || piece.tile || (tex && tex._window));
  }

  function pieceIsOverview(img, tile) {
    if (!tile) return false;
    var id = String(tile.id || "");
    var imgW = (img && img.width) || 0;
    var srcW = tile.srcW || 0;
    return !!(tile._overview || tile._base) || /overview/i.test(id) || (imgW > 0 && imgW <= 256 && srcW > imgW * 4);
  }

  function indexStrip(img, tile, spanW, spanH) {
    var imgW = (img && img.width) || tile.texW || tile.srcW || 1;
    var imgH = (img && img.height) || tile.texH || tile.srcH || 1;
    var texW = tile.texW || imgW;
    var texH = tile.texH || imgH;
    var photoW = tile.srcW || texW || imgW;
    var photoH = tile.srcH || texH || imgH;
    var downscale = imgW > 0 && photoW > imgW * 2;
    return {
      img: img,
      tile: tile,
      segs: tilePhotoSegments(tile, spanW),
      scaleX: downscale ? imgW / photoW : imgW / (texW || imgW),
      scaleY: downscale ? imgH / photoH : imgH / (texH || imgH),
      y0: tile.srcY || 0,
      y1: (tile.srcY || 0) + (tile.srcH || photoH || spanH || 1),
      overview: pieceIsOverview(img, tile),
    };
  }

  function blitOverlap(ctx, item, px0, px1, py0, py1, x, y, dw, dh) {
    var oy0 = py0 > item.y0 ? py0 : item.y0;
    var oy1 = py1 < item.y1 ? py1 : item.y1;
    if (!(oy1 > oy0)) return 0;
    var drawn = 0;
    for (var s = 0; s < item.segs.length; s++) {
      var seg = item.segs[s];
      var ox0 = px0 > seg.photoX ? px0 : seg.photoX;
      var ox1 = px1 < seg.photoX + seg.photoW ? px1 : seg.photoX + seg.photoW;
      if (!(ox1 > ox0)) continue;
      var local = seg.localX + (ox0 - seg.photoX);
      var sx = ((item.tile.padL || 0) + local) * item.scaleX;
      var sy = ((item.tile.padT || 0) + (oy0 - item.y0)) * item.scaleY;
      var sw = (ox1 - ox0) * item.scaleX;
      var sh = (oy1 - oy0) * item.scaleY;
      if (!(sw > 0.5) || !(sh > 0.5)) continue;
      // One source pixel of bleed. The canvas filter otherwise mixes the
      // edge of this rect with empty and draws a dark line on the cell.
      var imgW = item.img.width || sw;
      var imgH = item.img.height || sh;
      if (sx >= 1) { sx -= 1; sw += 1; }
      if (sy >= 1) { sy -= 1; sh += 1; }
      if (sx + sw < imgW - 1) sw += 1;
      if (sy + sh < imgH - 1) sh += 1;
      var dx = x + ((ox0 - px0) / (px1 - px0)) * dw;
      var dy = y + ((oy0 - py0) / (py1 - py0)) * dh;
      var bw = ((ox1 - ox0) / (px1 - px0)) * dw;
      var bh = ((oy1 - oy0) / (py1 - py0)) * dh;
      if (dx > x) { dx -= 1; bw += 1; }
      if (dy > y) { dy -= 1; bh += 1; }
      if (dx + bw < x + dw) bw += 1;
      if (dy + bh < y + dh) bh += 1;
      if (dx < x) { bw -= x - dx; dx = x; }
      if (dy < y) { bh -= y - dy; dy = y; }
      if (dx + bw > x + dw) bw = x + dw - dx;
      if (dy + bh > y + dh) bh = y + dh - dy;
      try {
        ctx.drawImage(item.img, sx, sy, sw, sh, dx, dy, Math.max(bw, 1), Math.max(bh, 1));
        drawn += 1;
      } catch (error) {}
    }
    return drawn;
  }

  function paintIndexed(ctx, indexed, spanW, spanH, u0, v0, u1, v1, x, y, dw, dh) {
    if (!(u1 > u0) || !(v1 > v0) || !(dw > 0) || !(dh > 0)) return 0;
    var px0 = u0 * spanW;
    var px1 = u1 * spanW;
    var py0 = v0 * spanH;
    var py1 = v1 * spanH;
    var drawn = 0;
    var hit = false;
    for (var i = 0; i < indexed.length; i++) {
      if (indexed[i].overview) continue;
      var n = blitOverlap(ctx, indexed[i], px0, px1, py0, py1, x, y, dw, dh);
      if (n > 0) hit = true;
      drawn += n;
    }
    if (hit) return drawn;
    for (var j = 0; j < indexed.length; j++) {
      if (!indexed[j].overview) continue;
      drawn += blitOverlap(ctx, indexed[j], px0, px1, py0, py1, x, y, dw, dh);
    }
    return drawn;
  }

  // Floor the shared edge and overlap the next cell by one pixel. Independent
  // drawImage rects otherwise round apart, and the filter at each source edge
  // blends with empty, which is the vertical line on every mesh column.
  function cellBox(x0, y0, x1, y1, viewW, viewH, edgeR, edgeB) {
    var left = Math.floor(x0);
    var top = Math.floor(y0);
    var right = edgeR ? viewW : Math.ceil(x1) + 1;
    var bottom = edgeB ? viewH : Math.ceil(y1) + 1;
    if (left < 0) left = 0;
    if (top < 0) top = 0;
    if (right > viewW) right = viewW;
    if (bottom > viewH) bottom = viewH;
    return { x: left, y: top, w: Math.max(1, right - left), h: Math.max(1, bottom - top) };
  }

  function paintStripView(ctx, pieces, underlay, spanW, spanH, yaw, pitch, roll, fov, posePitch, poseRoll, viewW, viewH, alpha, cols, rows) {
    if (!ctx || !(alpha > 0) || !(spanW > 1) || !(spanH > 1) || !(viewW > 1) || !(viewH > 1)) return 0;
    cols = cols > 4 ? cols : 16;
    rows = rows > 4 ? rows : 9;
    var indexed = [];
    var list = pieces || [];
    for (var i = 0; i < list.length; i++) {
      var img = pieceImage(list[i]);
      var tile = pieceTile(list[i]);
      if (!img || !tile || !(tile.srcW > 0)) continue;
      indexed.push(indexStrip(img, tile, spanW, spanH));
    }
    if (underlay) {
      var uimg = pieceImage(underlay);
      var utile = pieceTile(underlay);
      if (uimg && utile) indexed.push(indexStrip(uimg, utile, spanW, spanH));
    }
    if (!indexed.length) return 0;
    var readable = true;
    for (var p = 0; p < indexed.length; p++) {
      indexed[p].pixels = stripPixels(indexed[p].img);
      if (!indexed[p].pixels) readable = false;
    }
    if (ctx.setTransform && ctx.clip && ctx.beginPath) {
      return paintStripAffine(ctx, indexed, spanW, spanH, yaw, pitch, roll, fov, posePitch, poseRoll, viewW, viewH, alpha, cols, rows);
    }
    if (readable && ctx.putImageData) {
      return paintStripPixels(ctx, indexed, spanW, spanH, yaw, pitch, roll, fov, posePitch, poseRoll, viewW, viewH, alpha);
    }
    return paintStripColumns(ctx, indexed, spanW, spanH, yaw, pitch, roll, fov, posePitch, poseRoll, viewW, viewH, alpha);
  }

  function photoAffine(q0, q1, q2, s0, s1, s2) {
    var det = q0.x * (q1.y - q2.y) + q1.x * (q2.y - q0.y) + q2.x * (q0.y - q1.y);
    if (Math.abs(det) < 1e-8) return null;
    var a = (s0.x * (q1.y - q2.y) + s1.x * (q2.y - q0.y) + s2.x * (q0.y - q1.y)) / det;
    var c = (s0.x * (q2.x - q1.x) + s1.x * (q0.x - q2.x) + s2.x * (q1.x - q0.x)) / det;
    var e = s0.x - a * q0.x - c * q0.y;
    var b = (s0.y * (q1.y - q2.y) + s1.y * (q2.y - q0.y) + s2.y * (q0.y - q1.y)) / det;
    var d = (s0.y * (q2.x - q1.x) + s1.y * (q0.x - q2.x) + s2.y * (q1.x - q0.x)) / det;
    var f = s0.y - b * q0.x - d * q0.y;
    return { a: a, b: b, c: c, d: d, e: e, f: f };
  }

  function paintStripAffine(ctx, indexed, spanW, spanH, yaw, pitch, roll, fov, posePitch, poseRoll, viewW, viewH, alpha, cols, rows) {
    var debug = spsDebugMode();
    var aspect = viewW / viewH;
    cols = cols > 4 ? cols : 16;
    rows = rows > 4 ? rows : 9;
    var grid = [];
    for (var gy = 0; gy <= rows; gy++) {
      var row = [];
      var py = (gy / rows) * viewH;
      var ndcY = 1 - (py / viewH) * 2;
      for (var gx = 0; gx <= cols; gx++) {
        var px = (gx / cols) * viewW;
        var ndcX = (px / viewW) * 2 - 1;
        var uv = perspectiveUv(yaw, pitch, roll, fov, aspect, ndcX, ndcY, posePitch, poseRoll);
        row.push({ x: px, y: py, u: uv.u, v: uv.v });
      }
      grid.push(row);
    }
    if (ctx.save) ctx.save();
    ctx.globalAlpha = alpha;
    if (ctx.imageSmoothingEnabled != null) ctx.imageSmoothingEnabled = true;
    var drawn = 0;
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        var a = grid[y][x];
        var b = grid[y][x + 1];
        var c = grid[y + 1][x];
        var d = grid[y + 1][x + 1];
        drawn += drawPhotoTri(ctx, indexed, spanW, spanH, a, b, c, debug);
        drawn += drawPhotoTri(ctx, indexed, spanW, spanH, b, d, c, debug);
      }
    }
    if ((debug === "mesh" || debug === "columns") && ctx.moveTo) paintDebugGrid(ctx, viewW, viewH, debug, cols, rows);
    if (debug && !paintStripAffine.logged) {
      paintStripAffine.logged = true;
      try { if (root.__castSend) root.__castSend({ type: "log", message: "canvas2d debug " + debug }); } catch (error) {}
    }
    if (ctx.restore) ctx.restore();
    return drawn;
  }

  function growTri(p0, p1, p2) {
    var cx = (p0.x + p1.x + p2.x) / 3;
    var cy = (p0.y + p1.y + p2.y) / 3;
    function push(p) {
      var dx = p.x - cx;
      var dy = p.y - cy;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      return { x: p.x + (dx / len) * 0.75, y: p.y + (dy / len) * 0.75 };
    }
    return [push(p0), push(p1), push(p2)];
  }

  // The 16 bands were axis-aligned UV boxes: each mesh cell stretched
  // minU..maxU and minV..maxV across its rectangle, so the shared edge
  // displayed a different photo point on each side. An affine on the true
  // corner samples is continuous, because both triangles of that edge use
  // the same two endpoints. The source rect is the photo window of that
  // same affine, including padL/padT, with no extra bleed.
  function drawPhotoTri(ctx, indexed, spanW, spanH, p0, p1, p2, debug) {
    var parts = splitTriSeam(p0.u, p0.v, p1.u, p1.v, p2.u, p2.v, p0.x, p0.y, p1.x, p1.y, p2.x, p2.y);
    var drawn = 0;
    for (var part = 0; part < parts.length; part++) {
      var tri = parts[part];
      drawn += drawPhotoTriPart(ctx, indexed, spanW, spanH, tri[0], tri[1], tri[2], debug);
    }
    return drawn;
  }

  function drawPhotoTriPart(ctx, indexed, spanW, spanH, p0, p1, p2, debug) {
    var q0 = { x: p0.u * spanW, y: p0.v * spanH };
    var q1 = { x: p1.u * spanW, y: p1.v * spanH };
    var q2 = { x: p2.u * spanW, y: p2.v * spanH };
    var m = photoAffine(q0, q1, q2, p0, p1, p2);
    if (!m || !ctx.setTransform) return 0;
    var grown = growTri(p0, p1, p2);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(grown[0].x, grown[0].y);
    ctx.lineTo(grown[1].x, grown[1].y);
    ctx.lineTo(grown[2].x, grown[2].y);
    ctx.closePath();
    ctx.clip();
    ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    var minX = Math.min(q0.x, q1.x, q2.x);
    var maxX = Math.max(q0.x, q1.x, q2.x);
    var minY = Math.min(q0.y, q1.y, q2.y);
    var maxY = Math.max(q0.y, q1.y, q2.y);
    var drawn = 0;
    var tintIndex = -1;
    function emit(item, seg) {
      var ox0 = Math.max(minX, seg.photoX);
      var ox1 = Math.min(maxX, seg.photoX + seg.photoW);
      var oy0 = Math.max(minY, item.y0);
      var oy1 = Math.min(maxY, item.y1);
      if (!(ox1 > ox0) || !(oy1 > oy0)) return 0;
      var scaleX = item.scaleX || 1;
      var scaleY = item.scaleY || 1;
      var local = seg.localX + (ox0 - seg.photoX);
      var sx = ((item.tile.padL || 0) + local) * scaleX;
      var sy = ((item.tile.padT || 0) + (oy0 - item.y0)) * scaleY;
      var sw = (ox1 - ox0) * scaleX;
      var sh = (oy1 - oy0) * scaleY;
      var destX = ox0;
      var destY = oy0;
      var destW = ox1 - ox0;
      var destH = oy1 - oy0;
      var imgW = item.img.width || 0;
      var imgH = item.img.height || 0;
      if (imgW > 0 && sx < 0) {
        destX += -sx / scaleX;
        destW -= -sx / scaleX;
        sw += sx;
        sx = 0;
      }
      if (imgH > 0 && sy < 0) {
        destY += -sy / scaleY;
        destH -= -sy / scaleY;
        sh += sy;
        sy = 0;
      }
      if (imgW > 0 && sx + sw > imgW) {
        var cutR = sx + sw - imgW;
        sw -= cutR;
        destW -= cutR / scaleX;
      }
      if (imgH > 0 && sy + sh > imgH) {
        var cutB = sy + sh - imgH;
        sh -= cutB;
        destH -= cutB / scaleY;
      }
      if (!(sw > 0.5) || !(sh > 0.5) || !(destW > 0) || !(destH > 0)) return 0;
      try {
        ctx.drawImage(item.img, sx, sy, sw, sh, destX, destY, destW, destH);
      } catch (error) {
        return 0;
      }
      return 1;
    }
    for (var i = 0; i < indexed.length; i++) {
      var item = indexed[i];
      if (item.overview) continue;
      if (maxY < item.y0 || minY > item.y1) continue;
      for (var s = 0; s < item.segs.length; s++) {
        var n = emit(item, item.segs[s]);
        if (n && tintIndex < 0) tintIndex = i;
        drawn += n;
      }
    }
    if (!drawn) {
      for (var j = 0; j < indexed.length; j++) {
        var base = indexed[j];
        if (!base.overview) continue;
        if (maxY < base.y0 || minY > base.y1) continue;
        for (var t = 0; t < base.segs.length; t++) drawn += emit(base, base.segs[t]);
      }
    }
    if (debug === "strips" && tintIndex >= 0 && ctx.fill && ctx.setTransform) {
      var tint = STRIP_TINTS[tintIndex % STRIP_TINTS.length];
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = "rgb(" + tint[0] + "," + tint[1] + "," + tint[2] + ")";
      ctx.fill();
    }
    ctx.restore();
    return drawn;
  }

  function stripPixels(img) {
    if (!img || !(img.width > 0) || !(img.height > 0)) return null;
    if (img._cpuPixels && img._cpuPW === img.width && img._cpuPH === img.height) return img._cpuPixels;
    if (typeof document === "undefined" || !document.createElement) return null;
    try {
      var canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      var ctx = canvas.getContext("2d");
      if (!ctx || !ctx.getImageData || !ctx.drawImage) return null;
      // A test double's drawImage is not the browser sampler. Reading it back
      // would cache a blank buffer and skip the real strips.
      if (String(ctx.drawImage).indexOf("[native code]") < 0) return null;
      ctx.drawImage(img, 0, 0);
      var data = ctx.getImageData(0, 0, img.width, img.height).data;
      img._cpuPixels = data;
      img._cpuPW = img.width;
      img._cpuPH = img.height;
      return data;
    } catch (error) {
      return null;
    }
  }

  function sampleIndexed(indexed, spanW, spanH, u, v, debug) {
    u = u - Math.floor(u);
    if (v < 0) v = 0;
    if (v > 1) v = 1;
    var px = u * spanW;
    var py = v * spanH;
    var found = null;
    for (var pass = 0; pass < 2; pass++) {
      for (var i = 0; i < indexed.length; i++) {
        var item = indexed[i];
        if ((pass === 0) === item.overview) continue;
        if (py < item.y0 || py > item.y1) continue;
        var segs = item.segs;
        for (var s = 0; s < segs.length; s++) {
          var seg = segs[s];
          if (px < seg.photoX || px > seg.photoX + seg.photoW) continue;
          var local = seg.localX + (px - seg.photoX);
          var sx = ((item.tile.padL || 0) + local) * item.scaleX;
          var sy = ((item.tile.padT || 0) + (py - item.y0)) * item.scaleY;
          var color = bilinear(item, sx, sy);
          if (!color) continue;
          found = { c: color, index: i, overview: item.overview };
          if (!item.overview) return tintSample(found, debug);
        }
      }
      if (found) return tintSample(found, debug);
    }
    return null;
  }

  function nearestSample(item, sx, sy) {
    var data = item.pixels;
    var w = item.img.width;
    var h = item.img.height;
    if (!data || !(w > 0) || !(h > 0)) return null;
    var nx = sx + 0.5 | 0;
    var ny = sy + 0.5 | 0;
    if (nx < 0) nx = 0;
    if (ny < 0) ny = 0;
    if (nx > w - 1) nx = w - 1;
    if (ny > h - 1) ny = h - 1;
    var ni = (ny * w + nx) * 4;
    return [data[ni], data[ni + 1], data[ni + 2], 255];
  }

  function bilinear(item, sx, sy) {
    var data = item.pixels;
    var w = item.img.width;
    var h = item.img.height;
    if (!data || !(w > 1) || !(h > 1)) return null;
    if (sx < 0) sx = 0;
    if (sy < 0) sy = 0;
    if (sx > w - 1) sx = w - 1;
    if (sy > h - 1) sy = h - 1;
    if (item.img && item.img._cpuNearest) {
      var nx = Math.round(sx);
      var ny = Math.round(sy);
      if (nx < 0) nx = 0;
      if (ny < 0) ny = 0;
      if (nx > w - 1) nx = w - 1;
      if (ny > h - 1) ny = h - 1;
      var ni = (ny * w + nx) * 4;
      return [data[ni], data[ni + 1], data[ni + 2], 255];
    }
    var x0 = Math.floor(sx);
    var y0 = Math.floor(sy);
    var x1 = x0 + 1 < w ? x0 + 1 : x0;
    var y1 = y0 + 1 < h ? y0 + 1 : y0;
    var tx = sx - x0;
    var ty = sy - y0;
    var i00 = (y0 * w + x0) * 4;
    var i10 = (y0 * w + x1) * 4;
    var i01 = (y1 * w + x0) * 4;
    var i11 = (y1 * w + x1) * 4;
    var out = [0, 0, 0, 255];
    for (var c = 0; c < 3; c++) {
      var a = data[i00 + c] + (data[i10 + c] - data[i00 + c]) * tx;
      var b = data[i01 + c] + (data[i11 + c] - data[i01 + c]) * tx;
      out[c] = a + (b - a) * ty;
    }
    return out;
  }

  var STRIP_TINTS = [
    [255, 70, 70],
    [70, 140, 255],
    [70, 210, 90],
    [240, 190, 40],
    [190, 80, 230],
  ];

  function tintSample(found, debug) {
    if (debug !== "strips" || !found) return found;
    var tint = STRIP_TINTS[found.index % STRIP_TINTS.length];
    found.c[0] = found.c[0] * 0.45 + tint[0] * 0.55;
    found.c[1] = found.c[1] * 0.45 + tint[1] * 0.55;
    found.c[2] = found.c[2] * 0.45 + tint[2] * 0.55;
    return found;
  }

  function locateStrip(detail, overview, spanW, spanH, u, v) {
    u = u - Math.floor(u);
    if (v < 0) v = 0;
    if (v > 1) v = 1;
    var px = u * spanW;
    var py = v * spanH;
    var lists = [detail, overview];
    for (var list = 0; list < 2; list++) {
      var items = lists[list];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (py < item.y0 || py > item.y1) continue;
        var segs = item.segs;
        for (var s = 0; s < segs.length; s++) {
          var seg = segs[s];
          if (px < seg.photoX || px > seg.photoX + seg.photoW) continue;
          return {
            item: item,
            seg: seg,
            index: i,
            sx: ((item.tile.padL || 0) + seg.localX + (px - seg.photoX)) * item.scaleX,
            sy: ((item.tile.padT || 0) + (py - item.y0)) * item.scaleY,
          };
        }
      }
    }
    return null;
  }

  function paintStripPixels(ctx, indexed, spanW, spanH, yaw, pitch, roll, fov, posePitch, poseRoll, viewW, viewH, alpha) {
    var debug = spsDebugMode();
    var aspect = viewW / viewH;
    var bands = 8;
    var focal = 1 / Math.tan(((fov > 1 ? fov : 75) * Math.PI / 180) / 2);
    fillAimView(scratchYaw, scratchPitch, scratchRoll, scratchView, yaw || 0, pitch || 0, roll || 0);
    var buf = new Uint8ClampedArray(viewW * viewH * 4);
    var detail = [];
    var overview = [];
    for (var n = 0; n < indexed.length; n++) {
      if (indexed[n].overview) overview.push(indexed[n]);
      else detail.push(indexed[n]);
    }
    var tint = debug === "strips";
    for (var x = 0; x < viewW; x++) {
      var ndcX = ((x + 0.5) / viewW) * 2 - 1;
      var markU = new Array(bands + 1);
      var markV = new Array(bands + 1);
      for (var b = 0; b <= bands; b++) {
        var ndcY = 1 - (b / bands) * 2;
        var uv = perspectiveUvFast(focal, aspect, ndcX, ndcY, posePitch, poseRoll);
        markU[b] = uv.u;
        markV[b] = uv.v;
      }
      for (var band = 0; band < bands; band++) {
        var y0 = (band * viewH / bands) | 0;
        var y1 = ((band + 1) * viewH / bands) | 0;
        if (y1 <= y0) continue;
        var u0 = markU[band];
        var u1 = unwrapU(markU[band + 1], u0);
        var v0 = markV[band];
        var v1 = markV[band + 1];
        var spanY = y1 - y0;
        var hit0 = locateStrip(detail, overview, spanW, spanH, u0, v0);
        var hit1 = locateStrip(detail, overview, spanW, spanH, u1, v1);
        if (hit0 && hit1 && hit0.item === hit1.item && hit0.seg === hit1.seg) {
          var dsx = (hit1.sx - hit0.sx) / spanY;
          var dsy = (hit1.sy - hit0.sy) / spanY;
          var sx = hit0.sx + dsx * 0.5;
          var sy = hit0.sy + dsy * 0.5;
          var data = hit0.item.pixels;
          var iw = hit0.item.img.width;
          var ih = hit0.item.img.height;
          var dye = tint ? STRIP_TINTS[hit0.index % STRIP_TINTS.length] : null;
          for (var y = y0; y < y1; y++) {
            var ix = sx + 0.5 | 0;
            var iy = sy + 0.5 | 0;
            if (ix < 0) ix = 0;
            if (iy < 0) iy = 0;
            if (ix > iw - 1) ix = iw - 1;
            if (iy > ih - 1) iy = ih - 1;
            var si = (iy * iw + ix) << 2;
            var o = (y * viewW + x) << 2;
            var r = data[si];
            var g = data[si + 1];
            var bch = data[si + 2];
            if (dye) {
              r = r * 0.45 + dye[0] * 0.55;
              g = g * 0.45 + dye[1] * 0.55;
              bch = bch * 0.45 + dye[2] * 0.55;
            }
            buf[o] = r;
            buf[o + 1] = g;
            buf[o + 2] = bch;
            buf[o + 3] = 255;
            sx += dsx;
            sy += dsy;
          }
        } else {
          var du = (u1 - u0) / spanY;
          var dv = (v1 - v0) / spanY;
          var uu = u0 + du * 0.5;
          var vv = v0 + dv * 0.5;
          for (var y2 = y0; y2 < y1; y2++) {
            var hit = locateStrip(detail, overview, spanW, spanH, uu, vv);
            var o2 = (y2 * viewW + x) << 2;
            if (!hit) {
              buf[o2] = 11;
              buf[o2 + 1] = 13;
              buf[o2 + 2] = 16;
              buf[o2 + 3] = 255;
            } else {
              var nix = hit.sx + 0.5 | 0;
              var niy = hit.sy + 0.5 | 0;
              var nw = hit.item.img.width;
              var nh = hit.item.img.height;
              if (nix < 0) nix = 0;
              if (niy < 0) niy = 0;
              if (nix > nw - 1) nix = nw - 1;
              if (niy > nh - 1) niy = nh - 1;
              var nsi = (niy * nw + nix) << 2;
              var nd = hit.item.pixels;
              var rr = nd[nsi];
              var gg = nd[nsi + 1];
              var bb = nd[nsi + 2];
              if (tint) {
                var dye2 = STRIP_TINTS[hit.index % STRIP_TINTS.length];
                rr = rr * 0.45 + dye2[0] * 0.55;
                gg = gg * 0.45 + dye2[1] * 0.55;
                bb = bb * 0.45 + dye2[2] * 0.55;
              }
              buf[o2] = rr;
              buf[o2 + 1] = gg;
              buf[o2 + 2] = bb;
              buf[o2 + 3] = 255;
            }
            uu += du;
            vv += dv;
          }
        }
      }
    }
    var image = null;
    try {
      if (typeof ImageData === "function") image = new ImageData(buf, viewW, viewH);
    } catch (error) {
      image = null;
    }
    if (!image) image = { data: buf, width: viewW, height: viewH };
    paintStripPixels.last = image;
    if (alpha > 0.999 && ctx.putImageData) {
      try {
        ctx.putImageData(image, 0, 0);
      } catch (error) {
        blitPixelBuffer(ctx, image, viewW, viewH, alpha);
      }
    } else {
      blitPixelBuffer(ctx, image, viewW, viewH, alpha);
    }
    if ((debug === "mesh" || debug === "columns") && ctx.moveTo) {
      paintDebugGrid(ctx, viewW, viewH, debug);
    }
    if (debug && !paintStripPixels.logged) {
      paintStripPixels.logged = true;
      try { if (root.__castSend) root.__castSend({ type: "log", message: "canvas2d debug " + debug }); } catch (error) {}
    }
    return viewW * bands;
  }

  function blitPixelBuffer(ctx, image, viewW, viewH, alpha) {
    if (typeof document === "undefined" || !document.createElement) {
      if (ctx.putImageData) ctx.putImageData(image, 0, 0);
      return;
    }
    if (!cpuFrameScratch) {
      cpuFrameScratch = document.createElement("canvas");
      cpuFrameCtx = cpuFrameScratch.getContext("2d");
    }
    if (!cpuFrameCtx || !cpuFrameCtx.putImageData) {
      if (ctx.putImageData) ctx.putImageData(image, 0, 0);
      return;
    }
    if (cpuFrameScratch.width !== viewW) cpuFrameScratch.width = viewW;
    if (cpuFrameScratch.height !== viewH) cpuFrameScratch.height = viewH;
    cpuFrameCtx.putImageData(image, 0, 0);
    if (ctx.save) ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(cpuFrameScratch, 0, 0);
    if (ctx.restore) ctx.restore();
  }

  var cpuFrameScratch = null;
  var cpuFrameCtx = null;

  function paintDebugGrid(ctx, viewW, viewH, mode, cols, rows) {
    if (ctx.save) ctx.save();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = mode === "columns" ? "rgba(255,40,40,0.95)" : "rgba(255,220,0,0.9)";
    ctx.lineWidth = 1;
    cols = cols > 1 ? cols : 16;
    rows = rows > 1 ? rows : 9;
    if (ctx.beginPath) ctx.beginPath();
    for (var i = 1; i < cols; i++) {
      var x = Math.round(i * viewW / cols) + 0.5;
      if (ctx.moveTo) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, viewH);
      }
    }
    if (mode === "mesh") {
      for (var j = 1; j < rows; j++) {
        var y = Math.round(j * viewH / rows) + 0.5;
        if (ctx.moveTo) {
          ctx.moveTo(0, y);
          ctx.lineTo(viewW, y);
        }
      }
    }
    if (ctx.stroke) ctx.stroke();
    if (ctx.restore) ctx.restore();
  }

  // Used only when the strip pixels cannot be read. Columns are a few pixels
  // wide and each one is sampled at its own screen x, so a 16-wide bounding
  // box is never stretched across the row.
  function paintStripColumns(ctx, indexed, spanW, spanH, yaw, pitch, roll, fov, posePitch, poseRoll, viewW, viewH, alpha) {
    var aspect = viewW / viewH;
    var colW = viewW > 960 ? 4 : 2;
    var bands = 8;
    if (ctx.save) ctx.save();
    ctx.globalAlpha = alpha;
    if (ctx.imageSmoothingEnabled != null) ctx.imageSmoothingEnabled = true;
    var drawn = 0;
    for (var x = 0; x < viewW; x += colW) {
      var dw = x + colW > viewW ? viewW - x : colW;
      var ndcL = ((x + 0.5) / viewW) * 2 - 1;
      var ndcR = ((x + dw - 0.5) / viewW) * 2 - 1;
      for (var band = 0; band < bands; band++) {
        var y0 = Math.round(band * viewH / bands);
        var y1 = Math.round((band + 1) * viewH / bands);
        var ndcT = 1 - ((y0 + 0.5) / viewH) * 2;
        var ndcB = 1 - ((y1 - 0.5) / viewH) * 2;
        var lt = perspectiveUv(yaw, pitch, roll, fov, aspect, ndcL, ndcT, posePitch, poseRoll);
        var rt = perspectiveUv(yaw, pitch, roll, fov, aspect, ndcR, ndcT, posePitch, poseRoll);
        var lb = perspectiveUv(yaw, pitch, roll, fov, aspect, ndcL, ndcB, posePitch, poseRoll);
        var rb = perspectiveUv(yaw, pitch, roll, fov, aspect, ndcR, ndcB, posePitch, poseRoll);
        var u0 = lt.u;
        var u1 = unwrapU(rt.u, u0);
        var v0 = (lt.v + rt.v) * 0.5;
        var v1 = (lb.v + rb.v) * 0.5;
        if (u1 < u0) { var swap = u0; u0 = u1; u1 = swap; }
        drawn += paintIndexed(ctx, indexed, spanW, spanH, u0, Math.min(v0, v1), u1, Math.max(v0, v1), x, y0, dw, Math.max(1, y1 - y0));
      }
    }
    if (ctx.restore) ctx.restore();
    return drawn;
  }

  function poseToCameraDir(x, y, z, pitch, roll) {
    var nX = x;
    var nY = -z;
    var nZ = y;
    var cp = Math.cos(pitch || 0);
    var sp = Math.sin(pitch || 0);
    var cr = Math.cos(roll || 0);
    var sr = Math.sin(roll || 0);
    var pX = nX;
    var pY = cp * nY + sp * nZ;
    var pZ = -sp * nY + cp * nZ;
    var cX = cr * pX - sr * pZ;
    var cY = pY;
    var cZ = sr * pX + cr * pZ;
    return [cX, cZ, -cY];
  }

  function equirectFromDir(x, y, z) {
    var lon = Math.abs(x) + Math.abs(z) < 1e-8 ? 0 : Math.atan2(x, -z);
    var lat = Math.asin(Math.max(-1, Math.min(1, y)));
    var u = 0.5 + lon / (Math.PI * 2);
    u = u - Math.floor(u);
    var v = 0.5 - lat / Math.PI;
    if (v < 0) v = 0;
    if (v > 1) v = 1;
    return { u: u, v: v, x: x, y: y, z: z };
  }

  function perspectiveDir(yawDeg, pitchDeg, rollDeg, fovDeg, aspect, ndcX, ndcY) {
    var f = 1 / Math.tan((fovDeg * Math.PI / 180) / 2);
    var x = ndcX * aspect / f;
    var y = ndcY / f;
    var z = -1;
    var len = Math.sqrt(x * x + y * y + z * z) || 1;
    x /= len;
    y /= len;
    z /= len;
    fillAimView(scratchYaw, scratchPitch, scratchRoll, scratchView, yawDeg || 0, pitchDeg || 0, rollDeg || 0);
    var V = scratchView;
    return [
      V[0] * x + V[1] * y + V[2] * z,
      V[4] * x + V[5] * y + V[6] * z,
      V[8] * x + V[9] * y + V[10] * z,
    ];
  }

  function perspectiveUv(yawDeg, pitchDeg, rollDeg, fovDeg, aspect, ndcX, ndcY, posePitch, poseRoll) {
    var world = perspectiveDir(yawDeg, pitchDeg, rollDeg, fovDeg, aspect, ndcX, ndcY);
    var dir = poseToCameraDir(world[0], world[1], world[2], posePitch || 0, poseRoll || 0);
    var len = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]) || 1;
    return equirectFromDir(dir[0] / len, dir[1] / len, dir[2] / len);
  }

  // Same projection as perspectiveUv, with the aim matrix built once per frame.
  function perspectiveUvFast(focal, aspect, ndcX, ndcY, posePitch, poseRoll) {
    var x = ndcX * aspect / focal;
    var y = ndcY / focal;
    var z = -1;
    var len = Math.sqrt(x * x + y * y + z * z) || 1;
    x /= len;
    y /= len;
    z /= len;
    var V = scratchView;
    var wx = V[0] * x + V[1] * y + V[2] * z;
    var wy = V[4] * x + V[5] * y + V[6] * z;
    var wz = V[8] * x + V[9] * y + V[10] * z;
    var dir = poseToCameraDir(wx, wy, wz, posePitch || 0, poseRoll || 0);
    var dlen = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]) || 1;
    return equirectFromDir(dir[0] / dlen, dir[1] / dlen, dir[2] / dlen);
  }

  function unwrapU(u, ref) {
    var d = u - ref;
    if (d > 0.5) return u - 1;
    if (d < -0.5) return u + 1;
    return u;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  function splitTriSeam(u0, v0, u1, v1, u2, v2, x0, y0, x1, y1, x2, y2) {
    var pts = [
      { u: u0, v: v0, x: x0, y: y0 },
      { u: unwrapU(u1, u0), v: v1, x: x1, y: y1 },
      { u: unwrapU(u2, u0), v: v2, x: x2, y: y2 },
    ];
    var minU = Math.min(pts[0].u, pts[1].u, pts[2].u);
    var maxU = Math.max(pts[0].u, pts[1].u, pts[2].u);
    if (minU >= -1e-4 && maxU <= 1 + 1e-4) return [pts];
    var cut = maxU > 1 ? 1 : 0;
    var above = [];
    var below = [];
    for (var i = 0; i < 3; i++) {
      var a = pts[i];
      var b = pts[(i + 1) % 3];
      var aAbove = a.u >= cut;
      if (aAbove) above.push(a);
      else below.push(a);
      if (aAbove !== (b.u >= cut) && b.u !== a.u) {
        var t = (cut - a.u) / (b.u - a.u);
        var hit = { u: cut, v: lerp(a.v, b.v, t), x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
        above.push(hit);
        below.push(hit);
      }
    }
    function fan(poly, shift) {
      if (poly.length < 3) return [];
      var out = [];
      var base = [poly[0], poly[1], poly[2]];
      out.push(base);
      if (poly.length > 3) out.push([poly[0], poly[2], poly[3]]);
      if (!shift) return out;
      return out.map(function (tri) {
        return tri.map(function (p) {
          return { u: p.u + shift, v: p.v, x: p.x, y: p.y };
        });
      });
    }
    var highShift = cut === 1 ? -1 : 0;
    var lowShift = cut === 0 ? 1 : 0;
    return fan(above, highShift).concat(fan(below, lowShift));
  }

  var CPU_SCRATCH = 256;
  var cpuScratch = null;
  var cpuScratchCtx = null;

  function scratchContext() {
    if (typeof document === "undefined" || !document.createElement) return null;
    if (!cpuScratch) {
      cpuScratch = document.createElement("canvas");
      cpuScratch.width = CPU_SCRATCH;
      cpuScratch.height = CPU_SCRATCH;
      cpuScratch._spsScratch = true;
      cpuScratchCtx = cpuScratch.getContext("2d");
      if (cpuScratchCtx) cpuScratchCtx.imageSmoothingEnabled = true;
    }
    return cpuScratchCtx;
  }

  function sourceBounds(points, img) {
    var minU = points[0].u;
    var maxU = points[0].u;
    var minV = points[0].v;
    var maxV = points[0].v;
    for (var i = 1; i < points.length; i++) {
      if (points[i].u < minU) minU = points[i].u;
      if (points[i].u > maxU) maxU = points[i].u;
      if (points[i].v < minV) minV = points[i].v;
      if (points[i].v > maxV) maxV = points[i].v;
    }
    var sx = minU * img.width;
    var sy = minV * img.height;
    var sw = (maxU - minU) * img.width;
    var sh = (maxV - minV) * img.height;
    if (sx < 0) { sw += sx; sx = 0; }
    if (sy < 0) { sh += sy; sy = 0; }
    if (sx + sw > img.width) sw = img.width - sx;
    if (sy + sh > img.height) sh = img.height - sy;
    return { minU: minU, minV: minV, maxU: maxU, maxV: maxV, sx: sx, sy: sy, sw: sw, sh: sh };
  }

  // Source pixels a frame actually reads. The old mesh multiplied the whole
  // equirect by every triangle (8000*4000*288). A cell reads only its UV box.
  function cpuSampleBudget(eqW, eqH, viewW, viewH, fov, cols, rows) {
    cols = cols > 4 ? cols : 16;
    rows = rows > 4 ? rows : 9;
    var aspect = viewW / Math.max(viewH, 1);
    var pixels = 0;
    var maxCell = 0;
    var cells = 0;
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        var samples = [];
        for (var iy = 0; iy <= 1; iy++) {
          for (var ix = 0; ix <= 1; ix++) {
            var ndcX = ((x + ix) / cols) * 2 - 1;
            var ndcY = 1 - ((y + iy) / rows) * 2;
            samples.push(perspectiveUv(0, 0, 0, fov || 75, aspect, ndcX, ndcY, 0, 0));
          }
        }
        var ref = samples[0].u;
        var minU = ref;
        var maxU = ref;
        var minV = samples[0].v;
        var maxV = samples[0].v;
        for (var s = 0; s < samples.length; s++) {
          var u = unwrapU(samples[s].u, ref);
          if (u < minU) minU = u;
          if (u > maxU) maxU = u;
          if (samples[s].v < minV) minV = samples[s].v;
          if (samples[s].v > maxV) maxV = samples[s].v;
        }
        var area = Math.max(0, maxU - minU) * eqW * Math.max(0, maxV - minV) * eqH;
        pixels += area;
        if (area > maxCell) maxCell = area;
        cells += 1;
      }
    }
    return {
      pixels: Math.round(pixels),
      maxCell: Math.round(maxCell),
      cells: cells,
      fullImage: eqW * eqH * cells * 2,
    };
  }

  function blitAffine(ctx, image, s0, s1, s2, p0, p1, p2) {
    var det = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
    if (Math.abs(det) < 1e-3) return false;
    var a = (p0.x * (s1.y - s2.y) + p1.x * (s2.y - s0.y) + p2.x * (s0.y - s1.y)) / det;
    var c = (p0.x * (s2.x - s1.x) + p1.x * (s0.x - s2.x) + p2.x * (s1.x - s0.x)) / det;
    var e = p0.x - a * s0.x - c * s0.y;
    var b = (p0.y * (s1.y - s2.y) + p1.y * (s2.y - s0.y) + p2.y * (s0.y - s1.y)) / det;
    var d = (p0.y * (s2.x - s1.x) + p1.y * (s0.x - s2.x) + p2.y * (s1.x - s0.x)) / det;
    var f = p0.y - b * s0.x - d * s0.y;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.closePath();
    ctx.clip();
    ctx.setTransform(a, b, c, d, e, f);
    ctx.drawImage(image, 0, 0);
    ctx.restore();
    return true;
  }

  function paintCell(ctx, img, points) {
    var bounds = sourceBounds(points, img);
    if (!(bounds.sw > 0.5) || !(bounds.sh > 0.5)) return 0;
    paintPerspective.samplePixels = (paintPerspective.samplePixels || 0) + bounds.sw * bounds.sh;
    if (ctx.setTransform && ctx.beginPath && ctx.clip) {
      var scratch = scratchContext();
      if (scratch && cpuScratch) {
        scratch.drawImage(img, bounds.sx, bounds.sy, bounds.sw, bounds.sh, 0, 0, CPU_SCRATCH, CPU_SCRATCH);
        var su = CPU_SCRATCH / Math.max(bounds.maxU - bounds.minU, 1e-6);
        var sv = CPU_SCRATCH / Math.max(bounds.maxV - bounds.minV, 1e-6);
        function at(p) {
          return { x: (p.u - bounds.minU) * su, y: (p.v - bounds.minV) * sv };
        }
        blitAffine(ctx, cpuScratch, at(points[0]), at(points[1]), at(points[2]), points[0], points[1], points[2]);
        if (points.length > 3) blitAffine(ctx, cpuScratch, at(points[1]), at(points[3]), at(points[2]), points[1], points[3], points[2]);
        return points.length > 3 ? 2 : 1;
      }
    }
    var minX = points[0].x;
    var maxX = points[0].x;
    var minY = points[0].y;
    var maxY = points[0].y;
    for (var i = 1; i < points.length; i++) {
      if (points[i].x < minX) minX = points[i].x;
      if (points[i].x > maxX) maxX = points[i].x;
      if (points[i].y < minY) minY = points[i].y;
      if (points[i].y > maxY) maxY = points[i].y;
    }
    ctx.drawImage(img, bounds.sx, bounds.sy, Math.max(1, bounds.sw), Math.max(1, bounds.sh), minX, minY, Math.max(1, maxX - minX), Math.max(1, maxY - minY));
    return 1;
  }

  function paintPerspective(ctx, img, yaw, pitch, roll, fov, posePitch, poseRoll, viewW, viewH, alpha, cols, rows) {
    if (!ctx || !img || !(img.width > 0) || !(viewW > 1) || !(viewH > 1) || !(alpha > 0)) return 0;
    cols = cols > 4 ? cols : 16;
    rows = rows > 4 ? rows : 9;
    var aspect = viewW / viewH;
    var grid = [];
    for (var y = 0; y <= rows; y++) {
      var row = [];
      var py = (y / rows) * viewH;
      var ndcY = 1 - (py / viewH) * 2;
      for (var x = 0; x <= cols; x++) {
        var px = (x / cols) * viewW;
        var ndcX = (px / viewW) * 2 - 1;
        var uv = perspectiveUv(yaw, pitch, roll, fov, aspect, ndcX, ndcY, posePitch, poseRoll);
        row.push({ x: px, y: py, u: uv.u, v: uv.v });
      }
      grid.push(row);
    }
    if (ctx.save) ctx.save();
    ctx.globalAlpha = alpha;
    if (ctx.imageSmoothingEnabled != null) ctx.imageSmoothingEnabled = true;
    paintPerspective.samplePixels = 0;
    var drawn = 0;
    for (var gy = 0; gy < rows; gy++) {
      for (var gx = 0; gx < cols; gx++) {
        var a = grid[gy][gx];
        var b = grid[gy][gx + 1];
        var c = grid[gy + 1][gx];
        var dpt = grid[gy + 1][gx + 1];
        var ub = unwrapU(b.u, a.u);
        var uc = unwrapU(c.u, a.u);
        var ud = unwrapU(dpt.u, a.u);
        var span = Math.max(a.u, ub, uc, ud) - Math.min(a.u, ub, uc, ud);
        if (span > 0.5) {
          var partsA = splitTriSeam(a.u, a.v, b.u, b.v, c.u, c.v, a.x, a.y, b.x, b.y, c.x, c.y);
          var partsB = splitTriSeam(b.u, b.v, dpt.u, dpt.v, c.u, c.v, b.x, b.y, dpt.x, dpt.y, c.x, c.y);
          for (var i = 0; i < partsA.length; i++) drawn += paintCell(ctx, img, partsA[i]);
          for (var j = 0; j < partsB.length; j++) drawn += paintCell(ctx, img, partsB[j]);
        } else {
          drawn += paintCell(ctx, img, [
            { u: a.u, v: a.v, x: a.x, y: a.y },
            { u: ub, v: b.v, x: b.x, y: b.y },
            { u: uc, v: c.v, x: c.x, y: c.y },
            { u: ud, v: dpt.v, x: dpt.x, y: dpt.y },
          ]);
        }
      }
    }
    if (ctx.restore) ctx.restore();
    return drawn;
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
    // Replicate the last column and row into the power-of-two margin so a
    // bilinear sample never reads the canvas's transparent black.
    try {
      var srcData = ctx.getImageData(0, 0, w, h);
      var dst = ctx.createImageData(pw, ph);
      var srcPx = srcData.data;
      var dstPx = dst.data;
      for (var y = 0; y < h; y++) {
        var srcRow = y * w * 4;
        var dstRow = y * pw * 4;
        dstPx.set(srcPx.subarray(srcRow, srcRow + w * 4), dstRow);
        var edge = srcRow + (w - 1) * 4;
        for (var x = w; x < pw; x++) {
          var at = dstRow + x * 4;
          dstPx[at] = srcPx[edge];
          dstPx[at + 1] = srcPx[edge + 1];
          dstPx[at + 2] = srcPx[edge + 2];
          dstPx[at + 3] = srcPx[edge + 3];
        }
      }
      var lastRow = (h - 1) * pw * 4;
      for (var yy = h; yy < ph; yy++) dstPx.set(dstPx.subarray(lastRow, lastRow + pw * 4), yy * pw * 4);
      ctx.putImageData(dst, 0, 0);
    } catch (error) {
      if (pw > w) ctx.drawImage(source, w - 1, 0, 1, h, w, 0, pw - w, h);
      if (ph > h) ctx.drawImage(canvas, 0, h - 1, pw, 1, 0, h, pw, ph - h);
    }
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
        "    " + color + ".a=uAlpha;\n" +
        "  } else {\n" +
        "  float spanU=max(uU1-uU0,1e-6);\n" +
        "  float spanV=max(uV1-uV0,1e-6);\n" +
        "  float uu=u;float midU=(uU0+uU1)*0.5;\n" +
        "  if(abs(u+1.0-midU)<abs(uu-midU)) uu=u+1.0;\n" +
        "  if(abs(u-1.0-midU)<abs(uu-midU)) uu=u-1.0;\n" +
        "  float sx=(uu-uU0)/spanU;\n" +
        "  float sy=(v-uV0)/spanV;\n" +
        "  float dLonX=dFdx(lon);float dLonY=dFdy(lon);\n" +
        "  dLonX=mod(dLonX+PI,TWO_PI)-PI;\n" +
        "  dLonY=mod(dLonY+PI,TWO_PI)-PI;\n" +
        "  float dLatX=dFdx(lat);float dLatY=dFdy(lat);\n" +
        "  float kx=(uSrcW/max(uTexW,1.0))/spanU/TWO_PI;\n" +
        "  float ky=-(uSrcH/max(uTexH,1.0))/spanV/PI;\n" +
        "  vec2 dstDx=vec2(kx*dLonX,ky*dLatX);\n" +
        "  vec2 dstDy=vec2(kx*dLonY,ky*dLatY);\n" +
        "  float contentW=uContentW>0.0?uContentW:uTexW;\n" +
        "  float contentH=uContentH>0.0?uContentH:uTexH;\n" +
        "  vec2 st=vec2((uPadL+sx*uSrcW)/max(uTexW,1.0),(uPadT+sy*uSrcH)/max(uTexH,1.0));\n" +
        "  float padR=max(contentW-uPadL-uSrcW,0.0);\n" +
        "  float padB=max(contentH-uPadT-uSrcH,0.0);\n" +
        "  float roomX=max(min(uPadL,padR),0.5);\n" +
        "  float roomY=max(min(uPadT,padB),0.5);\n" +
        "  float texelX=st.x*uTexW;float texelY=st.y*uTexH;\n" +
        "  roomX=min(roomX,max(min(texelX,contentW-texelX),0.5));\n" +
        "  roomY=min(roomY,max(min(texelY,contentH-texelY),0.5));\n" +
        "  vec2 tdx=dstDx*vec2(uTexW,uTexH);\n" +
        "  vec2 tdy=dstDy*vec2(uTexW,uTexH);\n" +
        "  float extX=max(abs(tdx.x),abs(tdy.x));\n" +
        "  float extY=max(abs(tdx.y),abs(tdy.y));\n" +
        "  float lim=min(extX>roomX?roomX/max(extX,1e-6):1.0,extY>roomY?roomY/max(extY,1e-6):1.0);\n" +
        "  dstDx*=lim;dstDy*=lim;\n" +
        "  vec2 minSt=vec2(0.5/max(uTexW,1.0),0.5/max(uTexH,1.0));\n" +
        "  vec2 maxSt=vec2((contentW-0.5)/max(uTexW,1.0),(contentH-0.5)/max(uTexH,1.0));\n" +
        "  st=clamp(st,minSt,maxSt);\n" +
        "  float edgePx=min(min(sx,1.0-sx)*uSrcW,min(sy,1.0-sy)*uSrcH);\n" +
        "  if(edgePx<3.0) " + color + "=" + sampleExpr + ";\n" +
        "  else " + color + "=" + (webgl2 ? "texture" : "texture2D") + "(uTex,st);\n" +
        "  " + color + ".a=uAlpha*focusMask(uu,v);\n" +
        "  float slopU=max(0.5*spanU/max(uSrcW,1.0),0.5/360.0);\n" +
        "  float slopV=0.5*spanV/max(uSrcH,1.0);\n" +
        "  if(uDebug>0.5)" + color + ".rgb*=vec3(1.05,0.78,0.42);\n" +
        "  if(uu<uU0-slopU||uu>uU1+slopU||v<uV0-slopV||v>uV1+slopV) discard;\n" +
        "  }\n"
      : "  vec2 uv=equirectUv(poseToCamera(normalize(vObj),uPitch,uRoll));\n" +
        "  if(uKind>0.5){\n" +
        "    vec2 ost=vec2(uv.x,clamp(uv.y,0.5/max(uTexH,1.0),1.0-0.5/max(uTexH,1.0)));\n" +
        "    " + color + "=overviewColor(ost);\n" +
        "    if(uDebug>0.5)" + color + ".rgb*=vec3(0.45,0.62,1.0);\n" +
        "    " + color + ".a=uAlpha;\n" +
        "  } else {\n" +
        "  float spanU=max(uU1-uU0,1e-6);\n" +
        "  float spanV=max(uV1-uV0,1e-6);\n" +
        "  float uu=uv.x;float midU=(uU0+uU1)*0.5;\n" +
        "  if(abs(uv.x+1.0-midU)<abs(uu-midU)) uu=uv.x+1.0;\n" +
        "  if(abs(uv.x-1.0-midU)<abs(uu-midU)) uu=uv.x-1.0;\n" +
        "  float sx=(uu-uU0)/spanU;\n" +
        "  float sy=(uv.y-uV0)/spanV;\n" +
        "  float contentW=uContentW>0.0?uContentW:uTexW;\n" +
        "  float contentH=uContentH>0.0?uContentH:uTexH;\n" +
        "  vec2 st=vec2((uPadL+sx*uSrcW)/max(uTexW,1.0),(uPadT+sy*uSrcH)/max(uTexH,1.0));\n" +
        "  vec2 minSt=vec2(0.5/max(uTexW,1.0),0.5/max(uTexH,1.0));\n" +
        "  vec2 maxSt=vec2((contentW-0.5)/max(uTexW,1.0),(contentH-0.5)/max(uTexH,1.0));\n" +
        "  st=clamp(st,minSt,maxSt);\n" +
        "  " + color + "=" + (webgl2 ? "texture" : "texture2D") + "(uTex,st);\n" +
        "  " + color + ".a=uAlpha*focusMask(uu,uv.y);\n" +
        "  float slopU=max(0.5*spanU/max(uSrcW,1.0),0.5/360.0);\n" +
        "  float slopV=0.5*spanV/max(uSrcH,1.0);\n" +
        "  if(uDebug>0.5)" + color + ".rgb*=vec3(1.05,0.78,0.42);\n" +
        "  if(uu<uU0-slopU||uu>uU1+slopU||uv.y<uV0-slopV||uv.y>uV1+slopV) discard;\n" +
        "  }\n";
    return head + vary + " vec3 vObj;\n" + outDecl +
      "uniform sampler2D uTex;\n" +
      "uniform float uPitch;uniform float uRoll;uniform float uAlpha;\n" +
      "uniform float uU0;uniform float uU1;uniform float uV0;uniform float uV1;\n" +
      "uniform float uPadL;uniform float uPadT;uniform float uSrcW;uniform float uSrcH;uniform float uTexW;uniform float uTexH;\n" +
      "uniform float uContentW;uniform float uContentH;\n" +
      "uniform float uKind;uniform float uDebug;\n" +
      "uniform float uReveal;uniform float uGeo;uniform float uViewU;uniform float uViewV;uniform float uAnchorV;\n" +
      "uniform float uNL;uniform float uNR;uniform float uNU;uniform float uND;\n" +
      "vec4 overviewColor(vec2 ost){\n" +
      "  return " + (webgl2 ? "texture" : "texture2D") + "(uTex,ost);\n" +
      "}\n" +
      "float focusMask(float su,float sv){\n" +
      "  float e=clamp(uReveal,0.0,1.0);\n" +
      "  float spanV=max(uV1-uV0,1e-4);\n" +
      "  float sy=clamp((sv-uV0)/spanV,0.0,1.0);\n" +
      "  float anchor=clamp((uAnchorV-uV0)/spanV,-0.25,1.25);\n" +
      "  float along;\n" +
      "  if(anchor<=0.0) along=sy;\n" +
      "  else if(anchor>=1.0) along=1.0-sy;\n" +
      "  else along=abs(sy-anchor)/max(max(anchor,1.0-anchor),1e-4);\n" +
      "  float feather=" + FOCUS_FEATHER.toFixed(2) + ";\n" +
      "  float handoff=" + FOCUS_HANDOFF.toFixed(2) + ";\n" +
      "  float lead=e/max(handoff,1.0e-4);\n" +
      "  return clamp((lead-along)/max(feather,1.0e-4),0.0,1.0);\n" +
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
      tileVs: version + vsIn + " vec3 aPos;uniform mat4 uMvp;uniform float uPitch;uniform float uRoll;uniform float uPoseMesh;" + vsOut + " vec3 vObj;" +
        "vec3 worldFromPhoto(vec3 v,float pitch,float roll){" +
        "  vec3 n=vec3(v.x,-v.z,v.y);" +
        "  float cp=cos(pitch);float sp=sin(pitch);float cr=cos(roll);float sr=sin(roll);" +
        "  vec3 rolled=vec3(cr*n.x+sr*n.z,n.y,-sr*n.x+cr*n.z);" +
        "  vec3 pitched=vec3(rolled.x,cp*rolled.y-sp*rolled.z,sp*rolled.y+cp*rolled.z);" +
        "  return vec3(pitched.x,pitched.z,-pitched.y);" +
        "}" +
        "void main(){vec3 spun=worldFromPhoto(aPos,uPitch,uRoll);vObj=uPoseMesh>0.5?spun:aPos;gl_Position=uMvp*vec4(vObj,1.0);}",
      tileFs: tileFragment(webgl2, precision, grad, vary, outDecl, color, pose),
    };
  }

  var lastShaderError = "";

  function link(gl, vsSrc, fsSrc) {
    function sh(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        lastShaderError = String(gl.getShaderInfoLog(s) || "shader");
        warn("shader", lastShaderError);
      }
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
        lastShaderError = String(gl.getProgramInfoLog(prog) || "link");
        warn("shader link", lastShaderError);
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
    this._tokenEpoch = 0;
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
    this._tokenEpoch = (this._tokenEpoch || 0) + 1;
    this._releaseAll();
    this.loaded = [];
    this.assemblers = {};
    this.pending = null;
    this.entry = null;
    this.waitingShrink = false;
    this.shown = false;
    this._openTokens = {};
    this._reqCount = {};
    this._overviewPending = false;
    this._overviewReady = false;
  };

  PhotoSession.prototype.open = function (entry) {
    this.dispose();
    // dispose() climbed the counter so a late chunk from the previous photo
    // cannot match. The phone still pushes this photo's overview and the
    // front horizon at token 1, so the new wave starts there again.
    this.token = 0;
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
    var hasTiles = !!(entry && entry.tiles && entry.tiles.length);
    var hasOverview = !!(entry && entry.overview && entry.overview.url);
    if (!entry || (!hasTiles && !hasOverview)) {
      this._failOrRetry("no tiles");
      return;
    }
    if (this.hooks.onEntry) this.hooks.onEntry(entry);
    if (hasOverview) this._beginOverview();
    if (hasTiles) this._requestCurrent();
  };

  PhotoSession.prototype.preload = function (entry) {
    if (!entry || !entry.tiles || !entry.tiles.length) return;
    if (this.entry && this.entry.id === entry.id && (this.loaded.length || this.pending)) return;
    this.dispose();
    this.token = 0;
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
    this._tokenEpoch = (this._tokenEpoch || 0) + 1;
    this._openTokens = {};
    this.pending = null;
    this.assemblers = {};
    this.budgetFull = false;
    clearTileStops(this.entry);
  };

  PhotoSession.prototype.resume = function () {
    if (!this.entry || this.pending) return;
    if (!this.entry.tiles || !this.entry.tiles.length) return;
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

  PhotoSession.prototype._bandsOutstanding = function (view) {
    var entry = this.entry;
    if (!entry || !entry.tiles) return false;
    var anchor = stripAnchorRow(entry.tiles, entry.height, view);
    var viewCol = columnAtU(entry.tiles, entry.width, view && view.u);
    var stats = gridStats(entry.tiles);
    for (var i = 0; i < entry.tiles.length; i++) {
      var tile = entry.tiles[i];
      if (!tile || tile._base || tile._skip || tile._overview) continue;
      if (Math.abs((tile.row | 0) - anchor) > 1) continue;
      var dist = Math.abs((tile.col | 0) - viewCol);
      var wrap = stats.cols - dist;
      if (wrap < dist) dist = wrap;
      if (stats.cols === 2 && (tile.col | 0) !== viewCol) dist = 1;
      if (dist > 1) continue;
      if (this.assemblers[tile.id] || this._tileReady(tile.id)) continue;
      return true;
    }
    return false;
  };

  PhotoSession.prototype._pickTile = function () {
    var entry = this.entry;
    if (!entry || !entry.tiles) return null;
    var view = this.hooks.view ? this.hooks.view() : { u: 0.5, v: 0.5, panSign: 1 };
    var masters = activeMasters(entry.tiles, entry.width, entry.height, view, this._masterInfo(view));
    var anchor = stripAnchorRow(entry.tiles, entry.height, view);
    // Pole caps wait until the screen and the next horizon's bands are at
    // least on the wire. A free slot must not download r0 while r2c1 is in flight.
    var deferPoles = this._bandsOutstanding(view);
    var fullSphere = !!(this.hooks.fullSphere && this.hooks.fullSphere());
    var best = null;
    var bestRank = 1e15;
    var pool = masters;
    if (fullSphere) {
      // No GPU budget to protect. Every strip is wanted, still in front-first
      // rank, so a pan around the sphere is not a black hemisphere.
      pool = [];
      for (var p = 0; p < entry.tiles.length; p++) {
        var all = entry.tiles[p];
        if (!all || all._base || all._skip) continue;
        if (!fetchUnlocked(all, entry.tiles, anchor, this._masterInfo(view).loaded)) continue;
        pool.push(all);
      }
    }
    for (var i = 0; i < pool.length; i++) {
      var tile = pool[i];
      if (!tile || tile._skip || tile._gpuPending || this.assemblers[tile.id] || this._tileReady(tile.id)) continue;
      if (!fullSphere && deferPoles && Math.abs((tile.row | 0) - anchor) > 1) continue;
      // The column under the lens finishes its visible bands before the
      // other hemisphere is requested. Pole caps wait until that lookahead.
      var rank = masterRank(tile, entry.tiles, entry.width, entry.height, view);
      if (rank < bestRank) {
        bestRank = rank;
        best = tile;
      }
    }
    return best;
  };

  PhotoSession.prototype._isOpeningStrip = function (tile) {
    if (!tile) return false;
    if (tile._overview || tile._base) return true;
    if ((tile.col | 0) !== 0) return false;
    var stats = gridStats(this.entry && this.entry.tiles);
    var rows = stats.rows || 1;
    return (tile.row | 0) === Math.floor(rows / 2);
  };

  PhotoSession.prototype._leadToken = function (tile) {
    // Only the first wave. Once the counter has climbed, a later strip must
    // not reuse token 1. open() resets the counter so this wave's overview
    // and front horizon still match the phone's token-1 push.
    if (!tile || (this.token | 0) > 1) return false;
    return this._isOpeningStrip(tile);
  };

  PhotoSession.prototype._chunkTokenOk = function (box, token) {
    if (!box) return false;
    if (token == null) return true;
    if ((token | 0) === (box.token | 0)) return true;
    // The phone pushes the overview and the front horizon at token 1 even
    // when this session had already climbed past that (retile, photo 2+).
    return (token | 0) === 1 && !!(box.tile && this._isOpeningStrip(box.tile));
  };

  PhotoSession.prototype._issue = function (tile) {
    var entry = this.entry;
    if (!entry || !tile) return false;
    if (!this._reqCount) this._reqCount = {};
    var asked = this._reqCount[tile.id] | 0;
    // One request plus the retries. A GPU refusal must not ask again forever.
    if (asked >= 1 + TILE_RETRIES) {
      if (!tile._overview && !tile._base) tile._skip = true;
      return false;
    }
    this._reqCount[tile.id] = asked + 1;
    var token;
    if (this._leadToken(tile)) {
      token = 1;
      if (this.token < 1) this.token = 1;
    } else {
      this.token += 1;
      token = this.token;
    }
    if (!this._openTokens) this._openTokens = {};
    // Refcount, not a boolean. The overview and the front horizon share
    // token 1, and one finishing must not retire the other.
    this._openTokens[token] = (this._openTokens[token] | 0) + 1;
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
      _tokenHeld: true,
      _epoch: this._tokenEpoch || 0,
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
    var ahead = this.hooks.ahead ? (this.hooks.ahead() | 0) : AHEAD_REQUESTS;
    if (!(ahead > 0)) ahead = AHEAD_REQUESTS;
    while (this._inFlight() < ahead && guard < ahead) {
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

  PhotoSession.prototype._tokenLive = function (token, gen, epoch) {
    if (gen !== this.generation) return false;
    if ((epoch || 0) !== (this._tokenEpoch || 0)) return false;
    return !!(this._openTokens && (this._openTokens[token] | 0) > 0);
  };

  PhotoSession.prototype._releaseToken = function (token) {
    if (!this._openTokens) return;
    var left = (this._openTokens[token] | 0) - 1;
    if (left > 0) this._openTokens[token] = left;
    else delete this._openTokens[token];
  };

  /** One release per _issue. A second call, or a transfer from an older wave, is a no-op. */
  PhotoSession.prototype._releaseHold = function (box) {
    if (!box || !box._tokenHeld) return;
    box._tokenHeld = false;
    if ((box._epoch || 0) !== (this._tokenEpoch || 0)) return;
    this._releaseToken(box.token);
  };

  PhotoSession.prototype._pieceFor = function (tile) {
    if (!tile) return null;
    var loaded = this.loaded || [];
    for (var i = 0; i < loaded.length; i++) {
      var piece = loaded[i];
      if (piece && piece.tile && piece.tile.id === tile.id) return piece;
    }
    return null;
  };

  PhotoSession.prototype._revealAt = function (col, row) {
    if (!this.entry) return 0;
    var tile = findStrip(this.entry.tiles, col, row);
    if (!tile) return 0;
    var piece = this._pieceFor(tile);
    if (!piece || !piece.tex || piece.tex.deferred || piece.tex._evicted) return 0;
    if (!(piece._focusAt > 0)) return piece._revealDone ? 1 : 0;
    var now = this._now();
    if (now < piece._focusAt) return 0;
    var amount = revealProgress(piece._focusAt, now, FOCUS_MS);
    if (amount >= 1) piece._revealDone = true;
    return amount;
  };

  PhotoSession.prototype._stampFocus = function (tile, piece, now) {
    if (!tile || tile._base || tile._overview) return 0;
    if (!this.entry || !this.entry.tiles) return now;
    var view = this.hooks.view ? this.hooks.view() : { u: 0.5, v: 0.5 };
    var anchor = stripAnchorRow(this.entry.tiles, this.entry.height, view);
    if ((tile.row | 0) === anchor) return now;
    var parentTile = findStrip(this.entry.tiles, tile.col | 0, parentRowOf(tile.row | 0, anchor));
    var parent = parentTile ? this._pieceFor(parentTile) : null;
    if (parent && parent._focusAt > 0) return focusJoinAt(piece && piece._uploadedAt, parent._focusAt, now);
    if (!this._openForFade(tile)) return 0;
    return now;
  };

  PhotoSession.prototype._openForFade = function (tile) {
    if (!tile || tile._base || tile._overview) return true;
    if (!this.entry || !this.entry.tiles) return true;
    var view = this.hooks.view ? this.hooks.view() : { u: 0.5, v: 0.5 };
    var anchor = stripAnchorRow(this.entry.tiles, this.entry.height, view);
    var self = this;
    return revealUnlocked(tile, this.entry.tiles, anchor, function (col, row) {
      return self._revealAt(col, row);
    });
  };

  PhotoSession.prototype._masterInfo = function (view) {
    var self = this;
    return {
      loaded: function (tile) {
        var piece = self._pieceFor(tile);
        return !!(piece && piece.tex && !piece.tex.deferred && !piece.tex._evicted);
      },
      revealAt: function (col, row) { return self._revealAt(col, row); },
    };
  };

  PhotoSession.prototype._releaseStale = function () {
    // A strip that has already been requested for this photo finishes.
    // Panning across a column boundary must not abort the transfer.
  };

  PhotoSession.prototype._pickListed = function () {
    var entry = this.entry;
    if (!entry || !entry.tiles) return null;
    var order = this.tileOrder;
    var total = order ? order.length : entry.tiles.length;
    var start = order ? (this.orderPos | 0) : (this.tileIndex | 0);
    for (var s = start; s < total; s++) {
      var index = order ? order[s] : s;
      var tile = entry.tiles[index];
      if (!tile || tile._skip || tile._gpuPending) continue;
      if (this.assemblers[tile.id] || this._tileReady(tile.id)) continue;
      return tile;
    }
    return null;
  };

  PhotoSession.prototype._requestCurrent = function () {
    var entry = this.entry;
    if (!entry || !entry.tiles || this.budgetFull) return;
    if (this._preloadCapped()) {
      this.preloadCapped = true;
      return;
    }
    var view = this.hooks.view ? this.hooks.view() : null;
    if (!view) {
      // A session with no camera still feeds the next listed strip as each
      // one finishes, one at a time. The TV always has a view, and that path
      // spends the whole pipe on the current master strips.
      this._syncCursor();
      this._syncPending();
      if (this._inFlight() > 0) return;
      var listed = this._pickListed();
      if (listed && !this.assemblers[listed.id]) this._issue(listed);
      return;
    }
    this._releaseStale();
    this._aimOrder();
    this._syncCursor();
    this._syncPending();
    var guard = 0;
    var ahead = this.hooks.ahead ? (this.hooks.ahead() | 0) : AHEAD_REQUESTS;
    if (!(ahead > 0)) ahead = AHEAD_REQUESTS;
    while (this._inFlight() < ahead && guard < ahead) {
      guard += 1;
      var tile = this._pickTile(false);
      if (!tile) return;
      if (!this.assemblers[tile.id]) this._issue(tile);
    }
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
    // Token 1 is also accepted for the overview and the front horizon,
    // because the phone pushes those at token 1 after every open.
    if (!this._chunkTokenOk(box, msg.token)) return;
    var level = msg.level | 0;
    if (level > 0) {
      this._noteLevel(box, level, msg);
      return;
    }
    var index = msg.i | 0;
    var count = msg.n | 0;
    if (count <= 0 || index < 0 || index >= count) return;
    // A different part count is a new transfer on this token, not more of
    // the previous one. A leftover chunk from the last time this id was
    // shown must not freeze the tile the show is opening on.
    if (box.n && count !== box.n) {
      box.n = 0;
      box.got = 0;
      box.parts = [];
    }
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
    if (!this._chunkTokenOk(box, msg.token)) return;
    this._skipTile(box, msg.message || "fetch");
  };

  PhotoSession.prototype._materialize = function (box, payload) {
    var self = this;
    var token = box.token;
    var gen = box.gen;
    var epoch = box._epoch || 0;
    var accepted = false;
    var settled = false;
    if (box.tile) box.tile._gpuPending = true;
    function releaseGpu() {
      if (box.tile) box.tile._gpuPending = false;
    }
    var finish = function (err, image) {
      // Chrome fires onerror when the decoded image's src is cleared. That
      // second callback used to release the textures just drawn and clear
      // the frame. The first result owns this tile. settled waits until the
      // upload is applied, so an async upload can still land.
      if (accepted || settled) return;
      accepted = true;
      if (!self._tokenLive(token, gen, epoch)) {
        settled = true;
        releaseGpu();
        if (image && self.hooks.dropImage) self.hooks.dropImage(image);
        return;
      }
      if (err || !image) {
        settled = true;
        releaseGpu();
        if (image && self.hooks.dropImage) self.hooks.dropImage(image);
        self._skipTile(box, err || "load");
        return;
      }
      function apply(tex) {
        if (settled) return;
        settled = true;
        releaseGpu();
        if (!self._tokenLive(token, gen, epoch)) {
          if (image && self.hooks.dropImage) self.hooks.dropImage(image);
          if (tex && self.hooks.release) self.hooks.release(tex);
          return;
        }
        self._releaseHold(box);
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
        var nowStamp = self._now();
        var stored = { tex: tex, tile: box.tile, payload: image._spsPayload || null, _focusAt: 0, _uploadedAt: nowStamp };
        if (tex._spsUploaded !== false && self.standby) {
          // Preloaded strips are already on the GPU when the photo opens.
          // They must not fade in from transparent on the first frame.
          stored._revealDone = true;
          stored._focusAt = 1;
        } else if (!self.standby && tex._spsUploaded !== false) {
          stored._focusAt = self._stampFocus(box.tile, stored, nowStamp);
        }
        if (replaced >= 0) self.loaded[replaced] = stored;
        else self.loaded.push(stored);
        self._syncCursor();
        if (self.hooks.onTile) self.hooks.onTile(self, self.loaded[self.loaded.length - 1]);
        // Refill the pipe before deciding the photo is shown, so the next
        // strip is already requested while another one is still arriving.
        self._requestCurrent();
        var tileCount = (self.entry && self.entry.tiles && self.entry.tiles.length) || 0;
        var finished = !self.entry || !tileCount || (self.tileOrder
          ? self.orderPos >= self.tileOrder.length
          : self.tileIndex >= tileCount);
        var band = self._bandLoaded();
        if (self.pending && !band && !finished) return;
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
      }
      function startUpload() {
        var returned;
        try {
          returned = self.hooks.upload ? self.hooks.upload(image, box.tile, apply) : null;
        } catch (error) {
          settled = true;
          releaseGpu();
          if (self.hooks.dropImage) self.hooks.dropImage(image);
          if (isOom(error)) self._oom(box.photoId);
          else self._skipTile(box, error);
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
    if (box._readyImage) {
      var ready = box._readyImage;
      box._readyImage = null;
      finish(null, ready);
      return;
    }
    if (this.hooks.materialize) this.hooks.materialize(payload, finish);
    else finish(new Error("no materialize"));
  };

  PhotoSession.prototype.noteImage = function (id, token, image) {
    var box = this.assemblers[id];
    if (!box || box.gen !== this.generation) return false;
    if (!this._chunkTokenOk(box, token)) return false;
    if (image && box.tile && box.tile.url && !image._spsUrl) image._spsUrl = box.tile.url;
    delete this.assemblers[id];
    box._readyImage = image;
    this._materialize(box, "");
    return true;
  };

  PhotoSession.prototype._skipTile = function (box, reason) {
    this._releaseHold(box);
    if (box && box.id) delete this.assemblers[box.id];
    this._syncPending();
    var tile = box && box.tile;
    if (tile && (tile._overview || tile._base)) {
      this._overviewPending = false;
      this._requestCurrent();
      return;
    }
    if (tile) {
      tile._retries = (tile._retries || 0) + 1;
      if (tile._retries <= TILE_RETRIES) {
        if (this.hooks.onTileRetry) this.hooks.onTileRetry(tile, tile._retries);
        if (this.hooks.onLog) this.hooks.onLog("retry " + tile.id);
        this._issue(tile);
        return;
      }
      tile._skip = true;
    }
    var text = String((reason && reason.message) || reason || "tile skipped");
    if (this.hooks.onLog) this.hooks.onLog(text);
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
    this._tokenEpoch = (this._tokenEpoch || 0) + 1;
    this._openTokens = {};
    this._releaseAll();
    this.loaded = [];
    this.assemblers = {};
    this._reqCount = {};
    this.pending = null;
    this.tileIndex = 0;
    clearTileStops(entry);
    if (this.attempt < 1 && entry) {
      this.entry = entry;
      if (entry.tiles) {
        for (var i = 0; i < entry.tiles.length; i++) {
          if (entry.tiles[i]) {
            entry.tiles[i]._skip = false;
            entry.tiles[i]._retries = 0;
          }
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
    this._tokenEpoch = (this._tokenEpoch || 0) + 1;
    this._openTokens = {};
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
      if (stalled) this._skipTile(stalled, "timeout");
      else this._requestCurrent();
      return;
    }
    this._failOrRetry("timeout");
  };

  function withBuild(text) {
    var tag = " build=" + RECEIVER_BUILD;
    text = text || "";
    if (text.indexOf("build=") >= 0) tag = "";
    var max = 300;
    if ((text + tag).length > max) text = text.slice(0, Math.max(0, max - tag.length));
    return text + tag;
  }

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
    var uu = unwrapStripU(u, u0, u1);
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
      row: tile.row,
      col: tile.col,
      padL: ix0 - cropX,
      padT: iy0 - cropY,
      padR: cropX + cropW - ix1,
      padB: cropY + cropH - iy1,
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
      var contains = stripContainsU(u0, u1, view.u) && view.v >= v0 && view.v <= v1;
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
      var win;
      if (fit.full) {
        win = {
          row: src.row,
          col: src.col,
          srcX: src.srcX,
          srcY: src.srcY,
          srcW: src.srcW,
          srcH: src.srcH,
          padL: src.padL || 0,
          padT: src.padT || 0,
          padR: src.padR || 0,
          padB: src.padB || 0,
          texW: imgW,
          texH: imgH,
          full: true,
        };
      } else {
        var px = viewPixel(src, width, height, view.u, view.v);
        var origin = cropOrigin(imgW, imgH, fit.w, fit.h, px.x, px.y);
        win = windowFromCrop(src, origin.x, origin.y, fit.w, fit.h);
      }
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
    var uu = unwrapStripU(u, u0, u1);
    if (uu < u0 || uu > u1 || v < v0 || v > v1) return null;
    var du = u1 - u0;
    var dv = v1 - v0;
    var sx = du ? (uu - u0) / du : 0;
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

  function forwardEdgeDeg(u0, u1, viewU, sign) {
    if (stripContainsU(u0, u1, viewU)) return 0;
    var raw = sign < 0 ? ((Number(viewU) || 0) - u1) : (u0 - (Number(viewU) || 0));
    return ((raw % 1) + 1) % 1 * 360;
  }

  function tileInResidentBand(tile, width, height, view) {
    if (!tile || !view) return true;
    if (!(view.lookaheadDeg > 0) && view.panSign !== 1 && view.panSign !== -1) return true;
    var span = Math.max(width, 1);
    // Both 180° columns of the photo on screen stay resident for the whole
    // turn. Measuring the center and wrapping at ±180° called the upcoming
    // column "behind" for the first half of every column.
    if ((tile.srcW || 0) * 2 >= span) return true;
    if (tileInView(tile, width, height, view)) return true;
    var sign = view.panSign < 0 ? -1 : 1;
    var u0 = tile.srcX / span;
    var u1 = (tile.srcX + tile.srcW) / span;
    var ahead = forwardEdgeDeg(u0, u1, view.u, sign);
    var limit = (view.halfU || 0) * 360 + (view.lookaheadDeg || 0) + RESIDENT_MARGIN_DEG;
    if (ahead <= limit) return true;
    var back = forwardEdgeDeg(u0, u1, view.u, -sign);
    return back <= RESIDENT_MARGIN_DEG;
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

  function gridStats(tiles) {
    var rows = 1;
    var cols = 1;
    if (!tiles) return { rows: rows, cols: cols };
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      if (!tile || tile._base) continue;
      if ((tile.row | 0) + 1 > rows) rows = (tile.row | 0) + 1;
      if ((tile.col | 0) + 1 > cols) cols = (tile.col | 0) + 1;
    }
    return { rows: rows, cols: cols };
  }

  function stripAnchorRow(tiles, height, view) {
    var stats = gridStats(tiles);
    var mid = Math.floor(stats.rows / 2);
    if (!view || !view.manual) return mid;
    var v = view.v == null ? 0.5 : view.v;
    var span = Math.max(height, 1);
    var found = mid;
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      if (!tile || tile._base) continue;
      var v0 = tile.srcY / span;
      var v1 = (tile.srcY + tile.srcH) / span;
      var last = (tile.row | 0) === stats.rows - 1;
      if (v >= v0 && (v < v1 || (last && v <= v1 + 1e-6))) return tile.row | 0;
      if (v >= v0 && v <= v1) found = tile.row | 0;
    }
    return found;
  }

  function columnAtU(tiles, width, u) {
    var span = Math.max(width, 1);
    var uu = u == null ? 0.5 : u;
    var best = 0;
    var bestD = 2;
    var found = false;
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      if (!tile || tile._base) continue;
      var u0 = tile.srcX / span;
      var u1 = (tile.srcX + tile.srcW) / span;
      if (stripContainsU(u0, u1, uu)) {
        // An exact seam stays with the lower column, the strip the view is
        // still in. The next column is the pan-direction neighbor.
        if (!found || (tile.col | 0) < best) best = tile.col | 0;
        found = true;
        continue;
      }
      var d = uDist((u0 + u1) / 2, uu);
      if (!found && d < bestD) {
        bestD = d;
        best = tile.col | 0;
      }
    }
    return best;
  }

  function findStrip(tiles, col, row) {
    if (!tiles) return null;
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      if (!tile || tile._base) continue;
      if ((tile.col | 0) === col && (tile.row | 0) === row) return tile;
    }
    return null;
  }

  function parentRowOf(row, anchor) {
    if (row === anchor) return -1;
    return row < anchor ? row + 1 : row - 1;
  }

  function revealUnlocked(tile, tiles, anchor, revealAt) {
    if (!tile || tile._base) return true;
    var row = tile.row | 0;
    if (row === anchor) return true;
    var parent = parentRowOf(row, anchor);
    var amount = revealAt ? revealAt(tile.col | 0, parent) : 0;
    return amount >= REVEAL_HANDOFF;
  }

  function fetchUnlocked(tile, tiles, anchor, loadedFn) {
    if (!tile || tile._base) return true;
    var row = tile.row | 0;
    if (row === anchor) return true;
    var parent = findStrip(tiles, tile.col | 0, parentRowOf(row, anchor));
    if (parent && parent._skip) return true;
    return !!(parent && loadedFn && loadedFn(parent));
  }

  function columnEngaged(col, viewCol, tiles, width, view) {
    if ((col | 0) === (viewCol | 0)) return true;
    // Two 180° columns both fit in GPU memory. The one the camera has not
    // reached yet is always a master once the horizon under the lens is in,
    // including the first half of the current column where a wrapped lead
    // used to look negative.
    if (gridStats(tiles).cols <= 2) return true;
    var sample = null;
    for (var i = 0; i < tiles.length; i++) {
      if (tiles[i] && !tiles[i]._base && (tiles[i].col | 0) === (col | 0)) {
        sample = tiles[i];
        break;
      }
    }
    if (!sample) return false;
    var span = Math.max(width, 1);
    var u0 = sample.srcX / span;
    var u1 = (sample.srcX + sample.srcW) / span;
    var vu = view && view.u != null ? view.u : 0.5;
    var sign = view && view.panSign < 0 ? -1 : 1;
    var halfU = (view && view.halfU) || 0.12;
    if (stripContainsU(u0, u1, vu) || uOverlap(u0, u1, vu, halfU)) return true;
    var ahead = forwardEdgeDeg(u0, u1, vu, sign);
    var half = halfU * 360;
    var extra = STRIP_LOOKAHEAD_DEG;
    if (view && view.lookaheadDeg > 0) extra = Math.max(extra, Math.min(view.lookaheadDeg, 90));
    if (ahead <= half + extra) return true;
    var back = forwardEdgeDeg(u0, u1, vu, -sign);
    return back <= half + 8 && back + 0.5 < ahead;
  }

  function activeMasters(tiles, width, height, view, info) {
    info = info || {};
    var loaded = info.loaded || function () { return false; };
    view = view || {};
    var anchor = stripAnchorRow(tiles, height, view);
    var viewCol = columnAtU(tiles, width, view.u);
    var anchorTile = findStrip(tiles, viewCol, anchor);
    // A horizon that exhausted its retries must not freeze every other strip.
    var anchorLoaded = !!(anchorTile && (anchorTile._skip || loaded(anchorTile)));
    var masters = [];
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      if (!tile || tile._base || tile._skip) continue;
      if (!fetchUnlocked(tile, tiles, anchor, loaded)) continue;
      var col = tile.col | 0;
      if (col !== viewCol) {
        if (!anchorLoaded) continue;
        if (!columnEngaged(col, viewCol, tiles, width, view)) continue;
      }
      if (view.standby) {
        // Opening band of the swap column first, then the same band on the
        // other column, so either landing yaw is already sharp. Pole caps wait.
        if (Math.abs((tile.row | 0) - anchor) > 1) continue;
      }
      masters.push(tile);
    }
    return masters;
  }

  function masterRank(tile, tiles, width, height, view) {
    var stats = gridStats(tiles);
    var anchor = stripAnchorRow(tiles, height, view);
    var viewCol = columnAtU(tiles, width, view && view.u);
    var tier = Math.abs((tile.row | 0) - anchor);
    var dist = Math.abs((tile.col | 0) - viewCol);
    var wrap = stats.cols - dist;
    if (wrap < dist) dist = wrap;
    var sign = view && view.panSign < 0 ? -1 : 1;
    var delta = (tile.col | 0) - viewCol;
    if (stats.cols === 2) {
      // The other 180° column is the one the pan is heading toward. A
      // shortest-path wrap of exactly half a turn called it "behind" once
      // the camera sat in column 1.
      delta = (tile.col | 0) === viewCol ? 0 : sign;
      if ((tile.col | 0) !== viewCol) dist = 1;
    } else {
      if (delta > stats.cols / 2) delta -= stats.cols;
      if (delta < -stats.cols / 2) delta += stats.cols;
    }
    var ahead = delta * sign;
    var side = ahead > 0 ? 0 : (ahead < 0 ? 1 : 0);
    var vertical = (tile.row | 0) < anchor ? 0 : 1;
    var other = (tile.col | 0) !== viewCol;
    // 0: the bands on the TV right now. 1: the same bands on the hemisphere
    // the pan is about to enter. 2: pole caps under the lens. 3: the rest.
    var phase = 3;
    if (tier <= 1 && !other) phase = 0;
    else if (tier <= 1 && dist <= 1) phase = 1;
    else if (!other) phase = 2;
    var rank = phase * 10000 + tier * 1000 + dist * 100 + side * 10 + vertical;
    // Steering finishes the column under the crosshair (horizon and the
    // bands beside it) before it spends the pipe on the next column.
    if (view && view.manual && tier <= 1 && other) rank += 1000;
    // Standby finishes the column the next photo will open on before it
    // spends the pipe on the other hemisphere.
    if (view && view.standby && other) rank += 5000;
    return rank;
  }

  function tileLoadOrder(tiles, width, height, view) {
    view = view || {};
    var order = [];
    for (var i = 0; i < tiles.length; i++) order.push(i);
    order.sort(function (a, b) {
      var ra = masterRank(tiles[a], tiles, width, height, view);
      var rb = masterRank(tiles[b], tiles, width, height, view);
      if (ra !== rb) return ra - rb;
      return a - b;
    });
    return order;
  }

  function easeInOut(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t * t * (3 - 2 * t);
  }

  function revealProgress(born, now, duration) {
    if (!(born > 0)) return 0;
    var span = duration > 0 ? duration : FOCUS_MS;
    var t = (now - born) / span;
    if (t < 0) return 0;
    if (t > 1) return 1;
    return t;
  }

  function focusJoinAt(uploadedAt, parentFocusAt, now) {
    var handoffAt = (parentFocusAt || 0) + Math.round(FOCUS_MS * REVEAL_HANDOFF);
    var uploaded = uploadedAt > 0 ? uploadedAt : (now || 0);
    return Math.max(uploaded, handoffAt);
  }

  function geoRadii(t) {
    var e = easeInOut(t);
    var radialT = easeInOut(Math.min(1, e / 0.62));
    var bandT = e < 0.28 ? 0 : easeInOut((e - 0.28) / 0.72);
    return { rad: radialT * 220, band: bandT * 110 };
  }

  function shouldStripUpload(width, height) {
    var w = width | 0;
    var h = height | 0;
    if (w <= 0 || h <= 0) return false;
    // A decoded strip goes up in one texImage2D. Slicing it across frames
    // left _spsUploaded false for a second and blocked every other strip.
    return w > 4096 || h > 2048;
  }

  function stripContainsU(u0, u1, u) {
    if (!(u1 > u0)) return false;
    var uu = unwrapStripU(u, u0, u1);
    return uu >= u0 - 1e-6 && uu <= u1 + 1e-6;
  }

  function smoothstep(edge0, edge1, x) {
    var span = edge1 - edge0;
    var t = span ? (x - edge0) / span : (x >= edge1 ? 1 : 0);
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return t * t * (3 - 2 * t);
  }

  function focusMask(u, v, tile, spanW, spanH, reveal, neighbors, geo) {
    geo = geo || {};
    var tileA = reveal > 0 ? reveal : 0;
    if (tileA > 1) tileA = 1;
    var e = tileA;
    var u0 = tile.srcX / spanW;
    var u1 = (tile.srcX + tile.srcW) / spanW;
    var v0 = tile.srcY / spanH;
    var v1 = (tile.srcY + tile.srcH) / spanH;
    var uu = unwrapStripU(u, u0, u1);
    var spanU = Math.max(u1 - u0, 1e-4);
    var spanV = Math.max(v1 - v0, 1e-4);
    var sx = (uu - u0) / spanU;
    var sy = (v - v0) / spanV;
    if (sx < 0) sx = 0;
    if (sx > 1) sx = 1;
    if (sy < 0) sy = 0;
    if (sy > 1) sy = 1;
    var anchorV = geo.anchorV == null ? 0.5 : geo.anchorV;
    var anchor = (anchorV - v0) / spanV;
    if (anchor < -0.25) anchor = -0.25;
    if (anchor > 1.25) anchor = 1.25;
    var along;
    if (anchor <= 0) along = sy;
    else if (anchor >= 1) along = 1 - sy;
    else along = Math.abs(sy - anchor) / Math.max(Math.max(anchor, 1 - anchor), 1e-4);
    var feather = FOCUS_FEATHER > 0 ? FOCUS_FEATHER : 1;
    var handoff = REVEAL_HANDOFF > 0 ? REVEAL_HANDOFF : 1;
    var lead = e / handoff;
    var wave = (lead - along) / feather;
    if (wave < 0) wave = 0;
    if (wave > 1) wave = 1;
    return wave;
  }

  function standbyAllowance(cap, used) {
    return Math.max(0, cap - (used || 0));
  }

  function armSenderGrace(grace, lastSender, now, senderCount, timeoutMs) {
    if (senderCount > 0) return 0;
    var windowMs = timeoutMs > 0 ? timeoutMs : SENDER_TIMEOUT_MS;
    if (lastSender && now - lastSender < windowMs) return 0;
    return grace || now;
  }

  function receiverStartup() {
    return {
      disableIdleTimeout: true,
      maxInactivity: 86400,
      skipMplLoad: false,
      streamType: "LIVE",
      heartbeatMs: IDLE_HEARTBEAT_MS,
    aimKeepaliveMs: AIM_KEEPALIVE_MS,
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
    if (tex._spsUploaded === false) return false;
    if (tex._window && tex._window.full === false) return false;
    if (tex._mip !== true) return false;
    return true;
  }

  function anchorPieceReady(session) {
    if (!session || !session.entry || !session.entry.tiles) return false;
    var tiles = session.entry.tiles;
    var anchor = stripAnchorRow(tiles, session.entry.height, { manual: false, v: 0.5 });
    var col = columnAtU(tiles, session.entry.width, 0.5);
    var tile = findStrip(tiles, col, anchor) || findStrip(tiles, 0, anchor);
    if (!tile) return false;
    var loaded = session.loaded || [];
    for (var i = 0; i < loaded.length; i++) {
      if (loaded[i] && loaded[i].tile && loaded[i].tile.id === tile.id && pieceReady(loaded[i])) return true;
    }
    return false;
  }

  function swapReady(session) {
    if (!session) return false;
    if (sessionReady(session)) return true;
    // The opening frustum is enough. Waiting on every lookahead strip,
    // including both pole caps, deadlocked the swap: standby was not
    // allowed to fetch those rows, so this never became true.
    if (session._viewCovered && session._viewCovered()) return true;
    if (session._overviewReady && anchorPieceReady(session)) return true;
    return false;
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

  function patchHitsFrustum(tile, width, height, planes, pitch, roll) {
    var cells = patchCells(tile, width, height);
    var posed = pitch || roll;
    var box = [0, 0, 0, 0, 0, 0];
    for (var i = 0; i < cells.length; i += 6) {
      if (!posed) {
        if (!cellOutsideFrustum(cells, i, planes)) return true;
        continue;
      }
      var x0 = cells[i];
      var y0 = cells[i + 1];
      var z0 = cells[i + 2];
      var x1 = cells[i + 3];
      var y1 = cells[i + 4];
      var z1 = cells[i + 5];
      var minX = Infinity;
      var minY = Infinity;
      var minZ = Infinity;
      var maxX = -Infinity;
      var maxY = -Infinity;
      var maxZ = -Infinity;
      for (var c = 0; c < 8; c++) {
        var spun = undoPose([c & 1 ? x1 : x0, c & 2 ? y1 : y0, c & 4 ? z1 : z0], pitch, roll);
        if (spun[0] < minX) minX = spun[0];
        if (spun[1] < minY) minY = spun[1];
        if (spun[2] < minZ) minZ = spun[2];
        if (spun[0] > maxX) maxX = spun[0];
        if (spun[1] > maxY) maxY = spun[1];
        if (spun[2] > maxZ) maxZ = spun[2];
      }
      box[0] = minX;
      box[1] = minY;
      box[2] = minZ;
      box[3] = maxX;
      box[4] = maxY;
      box[5] = maxZ;
      if (!cellOutsideFrustum(box, 0, planes)) return true;
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
    return patchHitsFrustum(tile, width, height, frustumOf(view, look), view.posePitch || 0, view.poseRoll || 0);
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
      var uu = unwrapStripU(uv.u, u0, u1);
      var inU = atNorth || atSouth || (uu >= u0 - 1e-4 && uu <= u1 + 1e-4);
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
    var span = Math.max(width, 1);
    var spanH = Math.max(height, 1);
    var u0 = tile.srcX / span;
    var u1 = (tile.srcX + tile.srcW) / span;
    var v0 = tile.srcY / spanH;
    var v1 = (tile.srcY + tile.srcH) / spanH;
    var halfDegU = 0.5 / 360;
    // Half a source pixel, not half a degree. A wider vertical overlap
    // paints this strip's still-fading edge over the neighbor and leaves
    // a hard line with a blurry band under it.
    var halfTexV = 0.5 / spanH;
    var gutterL = (tile.padL || 0) / span;
    var gutterR = (tile.padR || 0) / span;
    var gutterT = (tile.padT || 0) / spanH;
    var gutterB = (tile.padB || 0) / spanH;
    function edgeExpand(gutter, limit, atPole) {
      if (atPole) return 0;
      if (gutter > 0) return Math.min(limit, gutter);
      return Math.min(limit, 0.5 / span);
    }
    u0 -= edgeExpand(gutterL, halfDegU, false);
    u1 += edgeExpand(gutterR, halfDegU, false);
    v0 -= edgeExpand(gutterT, halfTexV, v0 <= 1e-6 && !(tile.padT > 0));
    v1 += edgeExpand(gutterB, halfTexV, v1 >= 1 - 1e-6 && !(tile.padB > 0));
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

  function unwrapStripU(u, u0, u1) {
    var mid = ((Number(u0) || 0) + (Number(u1) || 0)) / 2;
    var best = Number(u) || 0;
    var bestD = Math.abs(best - mid);
    var plus = best + 1;
    var minus = best - 1;
    if (Math.abs(plus - mid) < bestD) {
      best = plus;
      bestD = Math.abs(plus - mid);
    }
    if (Math.abs(minus - mid) < bestD) best = minus;
    return best;
  }

  function clampStripSt(sx, sy, padL, padT, srcW, srcH, texW, texH, contentW, contentH) {
    var tw = Math.max(texW || 1, 1);
    var th = Math.max(texH || 1, 1);
    var cw = contentW > 0 ? contentW : tw;
    var ch = contentH > 0 ? contentH : th;
    var stX = ((padL || 0) + sx * srcW) / tw;
    var stY = ((padT || 0) + sy * srcH) / th;
    var minX = 0.5 / tw;
    var minY = 0.5 / th;
    var maxX = (cw - 0.5) / tw;
    var maxY = (ch - 0.5) / th;
    if (stX < minX) stX = minX;
    if (stY < minY) stY = minY;
    if (stX > maxX) stX = maxX;
    if (stY > maxY) stY = maxY;
    return { x: stX * tw, y: stY * th };
  }

  function compositeAlphas(fadeMs, haveOld, haveNew, durationMs) {
    if (!haveOld && !haveNew) return { clear: false, oldAlpha: 0, newAlpha: 0 };
    if (!haveOld) return { clear: true, oldAlpha: 0, newAlpha: 1 };
    var span = durationMs > 0 ? durationMs : TILE_FADE_MS;
    var t = haveNew ? Math.max(0, Math.min(1, (fadeMs || 0) / span)) : 0;
    return { clear: true, oldAlpha: 1, newAlpha: t };
  }

  function startingYawForEntry(entry) {
    if (!entry || !(entry.width > 0) || !entry.tiles || !entry.tiles.length) return 0;
    var height = entry.height > 0 ? entry.height : 1;
    var anchor = stripAnchorRow(entry.tiles, height, { u: 0.5, v: 0.5, manual: false });
    var tile0 = null;
    var fallback = null;
    for (var i = 0; i < entry.tiles.length; i++) {
      var tile = entry.tiles[i];
      if (!tile || tile._base || (tile.col | 0) !== 0) continue;
      if (!fallback) fallback = tile;
      if ((tile.row | 0) === anchor) {
        tile0 = tile;
        break;
      }
    }
    if (!tile0) tile0 = fallback;
    if (!tile0 || !(tile0.srcW > 0)) return 0;
    var centerU = (tile0.srcX + tile0.srcW * 0.5) / entry.width;
    centerU = centerU - Math.floor(centerU);
    if (centerU < 0) centerU += 1;
    return (centerU - 0.5) * 360;
  }

  root.SpsphereCast = {
    ROTATIONS: ROTATIONS,
    DEFAULT_DPS: DEFAULT_DPS,
    CROSSFADE_MS: CROSSFADE_MS,
    TILE_FADE_MS: TILE_FADE_MS,
    FOCUS_MS: FOCUS_MS,
    FOCUS_FEATHER: FOCUS_FEATHER,
    FOCUS_HANDOFF: FOCUS_HANDOFF,
    REVEAL_HANDOFF: REVEAL_HANDOFF,
    LAN_PROBE_TIMEOUT_MS: LAN_PROBE_TIMEOUT_MS,
    LAN_TIMEOUT_MS: LAN_TIMEOUT_MS,
    LAN_FAIL_LIMIT: LAN_FAIL_LIMIT,
    TILE_RETRIES: TILE_RETRIES,
    LAN_AHEAD: LAN_AHEAD,
    AHEAD_REQUESTS: AHEAD_REQUESTS,
    GEO_MS: GEO_MS,
    easeInOut: easeInOut,
    revealProgress: revealProgress,
    focusJoinAt: focusJoinAt,
    geoRadii: geoRadii,
    shouldStripUpload: shouldStripUpload,
    focusMask: focusMask,
    activeMasters: activeMasters,
    revealUnlocked: revealUnlocked,
    fetchUnlocked: fetchUnlocked,
    clampStripSt: clampStripSt,
    unwrapStripU: unwrapStripU,
    tilePatch: tilePatch,
    stripAnchorRow: stripAnchorRow,
    columnAtU: columnAtU,
    columnEngaged: columnEngaged,
    masterRank: masterRank,
    swapReady: swapReady,
    forwardEdgeDeg: forwardEdgeDeg,
    viewPixel: viewPixel,
    startingYawForEntry: startingYawForEntry,
    armSenderGrace: armSenderGrace,
    shouldTryLan: shouldTryLan,
    loadHttpJpeg: loadHttpJpeg,
    tilePole: tilePole,
    materializeJpeg: materializeJpeg,
    SNAP_FADE_MS: SNAP_FADE_MS,
    SENDER_TIMEOUT_MS: SENDER_TIMEOUT_MS,
    AIM_KEEPALIVE_MS: AIM_KEEPALIVE_MS,
    GPU_CAP: GPU_CAP,
    OMEGA: OMEGA,
    tileLoadOrder: tileLoadOrder,
    tilePhotoSegments: tilePhotoSegments,
    perspectiveUv: perspectiveUv,
    perspectiveDir: perspectiveDir,
    cpuEquirectSize: cpuEquirectSize,
    cpuRenderSize: cpuRenderSize,
    cpuSampleBudget: cpuSampleBudget,
    cpuQualityStep: cpuQualityStep,
    cpuDeliveredFps: cpuDeliveredFps,
    paintPerspective: paintPerspective,
    paintStripView: paintStripView,
    paintTileOnAtlas: paintTileOnAtlas,
    panLookaheadDeg: panLookaheadDeg,
    panLeadDeg: panLeadDeg,
    BASE_BYTES: BASE_BYTES,
    standbyAllowance: standbyAllowance,
    RECEIVER_BUILD: RECEIVER_BUILD,
    receiverStartup: receiverStartup,
    IdleGuard: IdleGuard,
    decodeAim: decodeAim,
    decodeSkip: decodeSkip,
    acceptCastMessage: acceptCastMessage,
    acceptAimSocket: acceptAimSocket,
    acceptStreamSocket: acceptStreamSocket,
    streamUrlFromAim: streamUrlFromAim,
    streamProbe: streamProbe,
    streamChoose: streamChoose,
    codecFromAvcC: codecFromAvcC,
    usableAvcCodec: usableAvcCodec,
    mseFailureAction: mseFailureAction,
    fmp4Init: fmp4Init,
    mp4Hex: mp4Hex,
    mp4BoxList: mp4BoxList,
    mp4AppendUnits: mp4AppendUnits,
    jpegFrame: jpegFrame,
    socketDisconnectLog: socketDisconnectLog,
    httpUrl: httpUrl,
    stepIndex: stepIndex,
    applyPose: applyPose,
    undoPose: undoPose,
    windowFromCrop: windowFromCrop,
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
