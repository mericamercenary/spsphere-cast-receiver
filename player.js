/* SPsphere Cast receiver player.
   Two full yaw turns at the horizon, then the next photo.
   One photo keeps turning. Timing matches CastTiming.kt (9°/s).
   Manual aim springs toward the phone. Yaw is the heading change since
   the first sample of that hold. Pitch and roll are gravity. A new
   anchor on every sample would freeze yaw.
   GPano PosePitchDegrees and PoseRollDegrees level the sphere before that
   look, matching ProjectionMath.applyPose. The phone bakes cubemaps to
   equirect JPEGs with the standard face orientation, so this page samples
   equirects only. A tiled photo is split to the TV's max texture size and
   drawn as sphere segments. Tiles that do not fit stay full resolution and
   load for the current view. A failed load leaves the last frame on screen.
   The screen has no counters. */
(function (root) {
  var ROTATIONS = 2;
  var FULL_TURN = 360;
  var DEFAULT_DPS = 9;
  var CROSSFADE_MS = 1200;
  var MIN_DPS = 6;
  var MAX_DPS = 72;
  var OMEGA = 40;
  var MIN_FOV = 20;
  var MAX_FOV = 120;

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
    return n === n ? n : fallback;
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
    this._tileDraw = [];
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
    this._tileDraw = [];
    this._busy = false;
    this._markBusy();
    this.draw();
  };

  Player.prototype.next = function () { return this._jump(1); };
  Player.prototype.previous = function () { return this._jump(-1); };
  Player.prototype.skip = function (delta) { return this._jump(delta); };

  Player.prototype._jump = function (delta) {
    var count = this.items.length;
    var at = stepIndex(this.index, count, delta, count > 1);
    if (at == null) return false;
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
    if (this.items.length >= 2 && this.itemDegrees >= ROTATIONS * FULL_TURN) {
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
    } else {
      this._tpitch = 0;
      this._troll = 0;
      this._tfov = this._userFov;
    }
    this._approach(this._tpitch - this.pitch, this._vp, dt);
    this.pitch = clamp(this.pitch + this._stepDelta, -89, 89);
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
    this._tpitch = clamp(pitch, -90, 90);
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
    var loop = function (t) {
      self._raf = requestAnimationFrame(loop);
      if (!self._last) self._last = t;
      var dt = t - self._last;
      self._last = t;
      if (dt > 100) dt = 100;
      self._ease(dt);
      if (self.playing && !self.manual) self._integrate(dt);
      if (self.session) self.session.tick(Date.now());
      self.draw();
    };
    this._raf = requestAnimationFrame(loop);
  };

  Player.prototype._setup = function () {
    var attrs = { antialias: true, alpha: false, preserveDrawingBuffer: true };
    var gl = this.canvas.getContext("webgl2", attrs);
    this._webgl2 = !!gl;
    if (!gl) gl = this.canvas.getContext("webgl", attrs);
    if (!gl) return;
    var prec = this._webgl2 ? "highp" : fragmentPrecision(gl);
    var sources = glSources(this._webgl2, prec);
    var prog = compileProgram(gl, sources.vs, sources.fs);
    if (!prog && prec !== "mediump" && !this._webgl2) {
      prec = "mediump";
      sources = glSources(false, prec);
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
  };

  Player.prototype._upload = function (img) {
    if (this._glLost || !this._gl) this._setup();
    if (!this._gl || !img.width) return;
    var gl = this._gl;
    if (gl.isContextLost && gl.isContextLost()) return;
    clearGlErrors(gl);
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

  Player.prototype._evictDistant = function (view) {
    var worst = -1;
    var worstDist = -1;
    for (var i = 0; i < this._resident.length; i++) {
      var item = this._resident[i];
      var dist = uDist(item.u, view.u) + Math.abs(item.v - view.v);
      if (dist > worstDist) {
        worstDist = dist;
        worst = i;
      }
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
    var center = viewCenterUv(this.yaw, this.pitch);
    var aspect = this.canvas.width / Math.max(this.canvas.height, 1);
    var ext = viewExtents(this.fov, aspect);
    return {
      u: center.u,
      v: center.v,
      halfU: ext.halfU,
      halfV: ext.halfV,
      yaw: this.yaw,
      pitch: this.pitch,
    };
  };

  Player.prototype._deferred = function (img, tile) {
    return {
      deferred: true,
      _evicted: true,
      _spsPayload: img && img._spsPayload,
      _tileId: tile && tile.id,
    };
  };

  Player.prototype._ensureSession = function () {
    if (this.session) return;
    var self = this;
    this.session = new PhotoSession({
      request: function (id, token) {
        if (window.__castSend) window.__castSend({ type: "fetch", id: id, token: token });
      },
      materialize: function (payload, done) {
        materializeJpeg(payload, function (err, img) {
          if (img) img._spsPayload = payload;
          done(err, img);
        });
      },
      upload: function (img, tile) { return self._uploadTile(img, tile); },
      // Clearing src after a successful decode fires onerror in Chrome. Drop
      // the handlers first so that error cannot finish the load a second time.
      dropImage: function (img) {
        if (!img) return;
        img.onload = null;
        img.onerror = null;
        try {
          if (typeof img.src === "string" && img.src) img.src = "";
        } catch (error) {}
      },
      release: function (tex) { self._deleteTex(tex); },
      onStatus: function (text) {
        self._busy = text === "busy";
        if (text) self._tileDraw = [];
        self._markBusy();
        self.draw();
      },
      onShown: function (state) {
        var raw = (state.tiles || []).map(function (piece) { return piece.tile || piece; });
        if (!coversSphere(raw, state.width, state.height)) {
          warn("photo does not cover the sphere", state && state.id);
          self._busy = false;
          self._markBusy();
          return;
        }
        self._tileDraw = state.tiles;
        self._tileW = state.width;
        self._tileH = state.height;
        self._busy = false;
        self._markBusy();
        if (window.__castSend) window.__castSend({ type: "photo", id: state.id, ok: true });
        self.draw();
      },
      onFail: function () {
      },
      onMemory: function (photoId) {
        warn("full-resolution tile did not upload", photoId);
      },
    });
  };

  Player.prototype._openCurrent = function () {
    if (!this._useTiles) return;
    var entry = this.entries && this.entries[this.index];
    if (!entry) return;
    this._ensureSession();
    this._tileDraw = [];
    this._lodHold = null;
    this._promoting = false;
    this.session.open(entry);
  };

  Player.prototype.noteChunk = function (msg) {
    if (this.session) this.session.noteChunk(msg);
  };

  Player.prototype.noteFetchError = function (msg) {
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
  };

  Player.prototype._texImage = function (gl, source) {
    clearGlErrors(gl);
    var tex = gl.createTexture();
    if (!tex) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
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
    var glErr = gl.getError ? gl.getError() : 0;
    if (glErr === gl.OUT_OF_MEMORY || glErr === gl.INVALID_VALUE || glErr === gl.INVALID_OPERATION) {
      gl.deleteTexture(tex);
      warn("texture upload failed", String(glErr));
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
        clearGlErrors(gl);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, padded);
          uploadW = padded.width;
          uploadH = padded.height;
          pot = isPow2(uploadW) && isPow2(uploadH);
        } catch (error) {
          warn("texture pad failed", error && error.message);
        }
        var padErr = gl.getError ? gl.getError() : 0;
        if (padErr) {
          warn("texture pad failed", String(padErr));
          pot = isPow2(width) && isPow2(height);
          uploadW = width;
          uploadH = height;
        }
      }
    }
    var min = gl.LINEAR;
    var aniso = 1;
    if (this._webgl2 || pot) {
      clearGlErrors(gl);
      var mipOk = true;
      try {
        gl.generateMipmap(gl.TEXTURE_2D);
      } catch (error) {
        mipOk = false;
        warn("mipmap skipped", error && error.message);
      }
      var mipErr = gl.getError ? gl.getError() : 0;
      if (mipOk && !mipErr) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        min = gl.LINEAR_MIPMAP_LINEAR;
        aniso = this._setAniso(gl);
      } else if (mipErr) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        warn("mipmap skipped", String(mipErr));
      }
    }
    this._minFilter = min;
    this._aniso = aniso;
    tex._uploadW = uploadW;
    tex._uploadH = uploadH;
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

  Player.prototype._uploadTile = function (img, tile) {
    if (this._glLost || !this._gl) this._setup();
    var gl = this._gl;
    if (!gl || (gl.isContextLost && gl.isContextLost())) {
      warn("webgl context lost");
      return this._deferred(img, tile);
    }
    if (!img) throw new Error("no image");
    var maxEdge = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    var budget = this._gpuBudget == null ? Infinity : this._gpuBudget;
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
    var incoming = tile
      ? uDist((tile.srcX + tile.srcW / 2) / spanW, view.u) + Math.abs((tile.srcY + tile.srcH / 2) / spanH - view.v)
      : 0;
    var self = this;
    function farthestResident() {
      var best = -1;
      for (var r = 0; r < self._resident.length; r++) {
        var item = self._resident[r];
        var dist = uDist(item.u, view.u) + Math.abs(item.v - view.v);
        if (dist > best) best = dist;
      }
      return best;
    }
    if (budget !== Infinity) {
      while (this._gpuBytes + bytes > budget && farthestResident() > incoming + 1e-6) {
        if (!this._evictDistant(view)) break;
      }
      if (this._gpuBytes + bytes > budget) {
        warn("texture budget", tile && tile.id);
        return this._deferred(img, tile);
      }
    }
    var tex = null;
    var attempts = this._resident.length + 1;
    while (attempts-- > 0) {
      tex = this._texImage(gl, source);
      if (tex) break;
      // A failed upload can evict a tile farther from the view. It cannot
      // drop the tile the viewer is looking at in order to keep an edge tile.
      if (!(farthestResident() > incoming + 1e-6)) break;
      if (!this._evictDistant(view)) break;
    }
    if (!tex) return this._deferred(img, tile);
    if (tex._uploadW && tex._uploadH) bytes = tex._uploadW * tex._uploadH * 4;
    tex._bytes = bytes;
    tex._window = win && !win.full ? win : null;
    tex._spsPayload = img._spsPayload || null;
    tex._tileId = tile && tile.id;
    this._gpuBytes += bytes;
    this._resident.push({
      id: tex._tileId,
      tex: tex,
      bytes: bytes,
      u: tile ? (tile.srcX + tile.srcW / 2) / spanW : view.u,
      v: tile ? (tile.srcY + tile.srcH / 2) / spanH : view.v,
    });
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
    jobs.forEach(function (job) {
      materializeJpeg(job.payload, function (err, img) {
        left -= 1;
        if (!err && img && self.session && self.session.entry === entry) {
          img._spsPayload = job.payload;
          try {
            var tex = self._uploadTile(img, job.piece.tile);
            if (tex && !tex.deferred) {
              job.piece.tex = tex;
              job.piece.payload = job.payload;
              self.session.live.push(tex);
              self.draw();
            }
          } catch (error) {
            warn("texture upload failed", error && error.message);
          }
          if (self.session.hooks.dropImage) self.session.hooks.dropImage(img);
        } else if (err) {
          warn("could not reopen a tile", err && err.message);
        }
        if (left <= 0) self._promoting = false;
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
    var sources = this._sources || glSources(this._webgl2, this._prec || "highp");
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
    var tiles = this._tileDraw || [];
    var drawable = [];
    for (var n = 0; n < tiles.length; n++) {
      var piece = tiles[n];
      if (!piece || !piece.tex || piece.tex.deferred || piece.tex._evicted) continue;
      var spec = piece.tex._window || piece.tile;
      if (!spec || spec.srcW < 1 || spec.srcH < 1) continue;
      drawable.push({ tex: piece.tex, spec: spec });
    }
    // An empty list used to clear the color buffer, so a late load error
    // turned a frame that had already drawn into the background color.
    if (!this._tileProg || !drawable.length) {
      if (!this._presented) gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this._tileProg);
    this._bindMesh(gl, this._tileProg);
    fillPerspective(this._proj, this.fov, w / Math.max(h, 1), 0.05, 20);
    fillAimView(this._m0, this._m1, this._m2, this._view, this.yaw, this.pitch, this.roll);
    multiplyInto(this._mvp, this._proj, this._view);
    var loc = this._tileLoc;
    gl.uniformMatrix4fv(loc.mvp, false, this._mvp);
    var pose = this.poses[this.index] || ZERO_POSE;
    gl.uniform1f(loc.pitch, pose.pitch);
    gl.uniform1f(loc.roll, pose.roll);
    var spanW = this._tileW || 1;
    var spanH = this._tileH || 1;
    for (var i = 0; i < drawable.length; i++) {
      var tile = drawable[i].spec;
      gl.uniform1f(loc.u0, tile.srcX / spanW);
      gl.uniform1f(loc.u1, (tile.srcX + tile.srcW) / spanW);
      gl.uniform1f(loc.v0, tile.srcY / spanH);
      gl.uniform1f(loc.v1, (tile.srcY + tile.srcH) / spanH);
      gl.uniform1f(loc.padL, tile.padL || 0);
      gl.uniform1f(loc.padT, tile.padT || 0);
      gl.uniform1f(loc.srcW, tile.srcW);
      gl.uniform1f(loc.srcH, tile.srcH);
      gl.uniform1f(loc.texW, drawable[i].tex._uploadW || tile.texW);
      gl.uniform1f(loc.texH, drawable[i].tex._uploadH || tile.texH);
      gl.uniform1i(loc.tex, 0);
      bindTex(gl, gl.TEXTURE0, drawable[i].tex);
      this._drawMesh(gl);
    }
    this._presented = true;
    gl.useProgram(this._prog);
  };

  Player.prototype.draw = function () {
    resize(this.canvas);
    if (this._mode === "webgl" && this._gl) this._drawGl();
    else this._draw2d();
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

  function copyTiles(list) {
    if (!list || !list.length) return null;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var tile = list[i];
      if (!tile || tile.id == null) continue;
      out.push({
        id: String(tile.id),
        url: tile.url || "",
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
      });
    }
    return out.length ? out : null;
  }

  function normalizeEntries(list) {
    var out = [];
    if (!list) return out;
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (typeof item === "string") out.push({ id: item, url: item, posePitch: 0, poseRoll: 0 });
      else if (item && item.url) {
        out.push({
          id: item.id != null ? String(item.id) : item.url,
          url: item.url,
          posePitch: num(item.posePitch, 0),
          poseRoll: num(item.poseRoll, 0),
          width: num(item.width, 0),
          height: num(item.height, 0),
          tiles: copyTiles(item.tiles),
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
    if (!length || length < 8) return null;
    var view = new DataView(buffer.buffer || buffer, buffer.byteOffset || 0, length);
    if (view.getUint8(0) !== 3) return null;
    var dir = view.getUint8(1);
    if (dir === 1) return 1;
    if (dir === 2) return -1;
    return null;
  }

  function decodeAim(buffer) {
    if (!buffer || buffer.byteLength < 32) return null;
    var view = new DataView(buffer.buffer || buffer, buffer.byteOffset || 0, buffer.byteLength || buffer.length);
    if (view.getUint8(0) !== 1) return null;
    return {
      seq: view.getUint32(4, true),
      yaw: view.getFloat32(8, true),
      pitch: view.getFloat32(12, true),
      roll: view.getFloat32(16, true),
      fov: view.getFloat32(20, true),
      ts: view.getFloat64(24, true),
      anchor: (view.getUint8(1) & 1) !== 0,
    };
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
    var w = Math.max(clientW || 0, screenW || 0);
    var h = Math.max(clientH || 0, screenH || 0);
    if (w < 2) w = 1920;
    if (h < 2) h = 1080;
    return {
      width: Math.max(2, Math.round(w * density)),
      height: Math.max(2, Math.round(h * density)),
    };
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

  function clearGlErrors(gl) {
    if (!gl || !gl.getError) return;
    for (var i = 0; i < 8; i++) {
      if (gl.getError() === (gl.NO_ERROR || 0)) return;
    }
  }

  function fragmentPrecision(gl) {
    if (!gl.getShaderPrecisionFormat) return "highp";
    var fmt = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    if (fmt && fmt.precision > 0) return "highp";
    return "mediump";
  }

  function glSources(webgl2, precision) {
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
      tileFs: head + vary + " vec3 vObj;\n" + outDecl +
        "uniform sampler2D uTex;\n" +
        "uniform float uPitch;uniform float uRoll;\n" +
        "uniform float uU0;uniform float uU1;uniform float uV0;uniform float uV1;\n" +
        "uniform float uPadL;uniform float uPadT;uniform float uSrcW;uniform float uSrcH;uniform float uTexW;uniform float uTexH;\n" +
        "const float PI=3.141592653589793;const float TWO_PI=6.283185307179586;\n" +
        pose + "\nvoid main(){\n" +
        "  vec2 uv=equirectUv(poseToCamera(normalize(vObj),uPitch,uRoll));\n" +
        "  if(uv.x<uU0||uv.x>uU1||uv.y<uV0||uv.y>uV1) discard;\n" +
        "  float sx=(uv.x-uU0)/max(uU1-uU0,1e-6);\n" +
        "  float sy=(uv.y-uV0)/max(uV1-uV0,1e-6);\n" +
        "  vec2 st=vec2((uPadL+sx*uSrcW)/uTexW,(uPadT+sy*uSrcH)/uTexH);\n" +
        "  " + color + "=" + sample + "(uTex,st);\n" +
        "}",
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

  function materializeJpeg(payload, done) {
    var settled = false;
    function finish(err, img) {
      if (settled) return;
      settled = true;
      if (img) {
        img.onload = null;
        img.onerror = null;
      }
      done(err, img);
    }
    try {
      var binary = atob(payload);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 255;
      var blob = new Blob([bytes], { type: "image/jpeg" });
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        img.onload = null;
        img.onerror = null;
        URL.revokeObjectURL(url);
        finish(null, img);
      };
      img.onerror = function () {
        img.onload = null;
        img.onerror = null;
        URL.revokeObjectURL(url);
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
  };

  PhotoSession.prototype.open = function (entry) {
    this.dispose();
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
    this._requestCurrent();
  };

  PhotoSession.prototype._requestCurrent = function () {
    var entry = this.entry;
    if (!entry || !entry.tiles) return;
    var tile = entry.tiles[this.tileIndex];
    if (!tile) return;
    this.token += 1;
    var token = this.token;
    this.assemblers[tile.id] = {
      id: tile.id,
      gen: this.generation,
      token: token,
      n: 0,
      got: 0,
      parts: [],
      tile: tile,
      photoId: entry.id,
    };
    this.pending = { id: tile.id, token: token, started: this._now() };
    if (this.hooks.request) this.hooks.request(tile.id, token);
  };

  PhotoSession.prototype.noteChunk = function (msg) {
    if (!msg || msg.id == null) return;
    var box = this.assemblers[msg.id];
    if (!box || box.gen !== this.generation || box.token !== this.token) return;
    // A chunk that names a token has to be the transfer this tile asked for.
    // Photo 1's leftover pieces reuse the id when the phone resets its counter,
    // and a different n leaves this assembler waiting forever.
    if (msg.token != null && (msg.token | 0) !== box.token) return;
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
    delete this.assemblers[msg.id];
    this._materialize(box, payload);
  };

  PhotoSession.prototype.noteFetchError = function (msg) {
    if (!msg) return;
    var box = this.assemblers[msg.id];
    if (!box || box.gen !== this.generation || box.token !== this.token) return;
    this._failOrRetry(msg.message || "fetch");
  };

  PhotoSession.prototype._materialize = function (box, payload) {
    var self = this;
    var token = box.token;
    var gen = box.gen;
    var settled = false;
    var finish = function (err, image) {
      // Chrome fires onerror when the decoded image's src is cleared. That
      // second callback used to release the textures just drawn and clear
      // the frame. The first result owns this tile.
      if (settled) return;
      settled = true;
      if (gen !== self.generation || token !== self.token) {
        if (image && self.hooks.dropImage) self.hooks.dropImage(image);
        return;
      }
      if (err || !image) {
        if (image && self.hooks.dropImage) self.hooks.dropImage(image);
        self._failOrRetry(err || "load");
        return;
      }
      var tex = null;
      try {
        tex = self.hooks.upload(image, box.tile);
      } catch (error) {
        if (self.hooks.dropImage) self.hooks.dropImage(image);
        if (isOom(error)) self._oom(box.photoId);
        else self._failOrRetry(error);
        return;
      }
      if (self.hooks.dropImage) self.hooks.dropImage(image);
      if (!tex || tex.oom) {
        if (tex && self.hooks.release) self.hooks.release(tex);
        self._oom(box.photoId);
        return;
      }
      if (image._spsPayload && !tex._spsPayload) tex._spsPayload = image._spsPayload;
      self.live.push(tex);
      self.loaded.push({ tex: tex, tile: box.tile, payload: image._spsPayload || null });
      self.pending = null;
      self.tileIndex += 1;
      if (!self.entry || self.tileIndex >= self.entry.tiles.length) {
        var covered = self.entry && coversSphere(
          self.loaded.map(function (piece) { return piece.tile; }),
          self.entry.width,
          self.entry.height,
        );
        if (!covered) {
          self.attempt = 1;
          self._failOrRetry("coverage");
          return;
        }
        self.shown = true;
        if (self.hooks.onStatus) self.hooks.onStatus("");
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
    };
    if (this.hooks.materialize) this.hooks.materialize(payload, finish);
    else finish(new Error("no materialize"));
  };

  PhotoSession.prototype._failOrRetry = function (reason) {
    if (this.waitingShrink) return;
    var entry = this.entry;
    this._releaseAll();
    this.loaded = [];
    this.assemblers = {};
    this.pending = null;
    this.tileIndex = 0;
    if (this.attempt < 1 && entry) {
      this.entry = entry;
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

  function viewCenterUv(yawDeg, pitchDeg) {
    var yawM = new Float32Array(16);
    var pitchM = new Float32Array(16);
    var rollM = new Float32Array(16);
    var view = new Float32Array(16);
    fillAimView(yawM, pitchM, rollM, view, yawDeg || 0, pitchDeg || 0, 0);
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
    return { u: u, v: v };
  }

  function viewExtents(fovDeg, aspect) {
    var vRad = (fovDeg || 75) * Math.PI / 180;
    var halfV = vRad / 2;
    var halfH = Math.atan(Math.tan(halfV) * (aspect > 0 ? aspect : 1));
    return { halfU: halfH / (Math.PI * 2), halfV: halfV / Math.PI };
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
      var hits = contains || (
        uOverlap(u0, u1, view.u, view.halfU || 0) &&
        rangesOverlap(v0, v1, view.v - (view.halfV || 0), view.v + (view.halfV || 0))
      );
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

  root.SpsphereCast = {
    ROTATIONS: ROTATIONS,
    DEFAULT_DPS: DEFAULT_DPS,
    CROSSFADE_MS: CROSSFADE_MS,
    OMEGA: OMEGA,
    decodeAim: decodeAim,
    decodeSkip: decodeSkip,
    stepIndex: stepIndex,
    applyPose: applyPose,
    tileTexCoord: tileTexCoord,
    coversSphere: coversSphere,
    viewCenterUv: viewCenterUv,
    planResidence: planResidence,
    backingStoreSize: backingStoreSize,
    potSize: potSize,
    sphere: sphere,
    create: function (canvas) { return new Player(canvas); },
    createSession: function (hooks) { return new PhotoSession(hooks); },
  };
})(window);
