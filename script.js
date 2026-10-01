(() => {
  'use strict';

  /* ====================================================================
   *  CONFIG
   * ==================================================================== */

  const CFG = Object.freeze({
    AI_SKILL: 0.15,       // AI difficulty, 0 (easiest) to 1 (hardest)
    WIN_SCORE: 5,         // "Reach 5 points"

    COURT_RATIO: 0.845,   // court width / height (measured from the video)
    MIN_RATIO: 0.42,      // never let the court get thinner than this
    MAX_RATIO: 0.95,
    GOAL_SPAN: 0.40,      // goal bar width as a fraction of court width

    MAX_DPR: 2,
    STEP: 1 / 240,        // fixed physics step (seconds)
    MAX_FRAME: 0.1,       // longest frame we will try to catch up on

    SERVE_DELAY: 0.8,
    GOAL_TIME: 0.3,
    REPLAY_LOCK: 0.7,

    WALL_BOUNCE: 0.97,
    RESTITUTION: 0.78,    // mallet -> puck
    PUCK_DAMPING: 0.4,    // how fast a fast puck settles toward cruise speed
  });

  const COLORS = Object.freeze({
    bg: '#1e4c7f',
    wall: 'rgba(255,255,255,0.95)',
    edge: 'rgba(255,255,255,0.14)',
    centre: 'rgba(255,255,255,0.20)',
    goalTop: '#f3b2c3',
    goalBottom: '#97bbf3',
    red: '#ea0002',
    blue: '#4a86f9',
    puck: '#ffffff',
    text: '#ffffff',
  });

  const TAU = Math.PI * 2;
  const DIFF = Math.max(0, Math.min(1, CFG.AI_SKILL));

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);

  /* ====================================================================
   *  DOM
   * ==================================================================== */

  const canvas = document.getElementById('gameCanvas');
  const wrap = document.querySelector('.game-wrap');
  const statusEl = document.getElementById('gameStatus');
  const ctx = canvas.getContext('2d', { alpha: false });

  // Static board (court, lines, goals) is painted once per resize.
  const bgCanvas = document.createElement('canvas');
  const bgCtx = bgCanvas.getContext('2d');

  // Invisible probe used to read the safe-area insets (notch, home bar).
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;' +
    'pointer-events:none;padding:env(safe-area-inset-top,0px) ' +
    'env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) ' +
    'env(safe-area-inset-left,0px);';
  document.body.appendChild(probe);

  /* ====================================================================
   *  STATE
   * ==================================================================== */

  const view = {
    W: 0, H: 0, dpr: 1,
    u: 1,          // size scale (from court width)
    S: 1,          // speed scale (from court area)
    compact: false,
    insetTop: 0,
    wallW: 2,
  };

  const court = { left: 0, right: 0, top: 0, bottom: 0, w: 0, h: 0, cx: 0, midY: 0 };
  const goal = { w: 0, left: 0, right: 0, thick: 3 };

  const makeMallet = () => ({
    x: 0, y: 0, ox: 0, oy: 0, vx: 0, vy: 0, tx: 0, ty: 0, r: 16,
  });

  const player = makeMallet();
  const ai = makeMallet();

  const puck = {
    x: 0, y: 0, ox: 0, oy: 0, vx: 0, vy: 0,
    r: 8, alpha: 1, scale: 1,
  };

  const game = {
    phase: 'serve',     // 'serve' | 'play' | 'goal' | 'over'
    playerScore: 0,
    aiScore: 0,
    winner: null,       // 'player' | 'ai'
    lock: 0,            // replay lockout after a game ends
    stall: 0,
  };

  const serve = { t: 0, vx: 0, vy: 0 };
  const goalAnim = { side: 'top', t: 0, x: 0, y0: 0 };

  const fx = {
    hit: 0,
    launch: 0,
    flashSide: null,
    flash: 0,
    time: 0,
    trail: [],
  };

  const brain = {
    think: 0,
    errX: 0,
    errY: 0,
    aimX: 0,
    mode: 'home',
    vmax: 0,
  };

  const keys = new Set();
  const pointer = { id: null };

  let acc = 0;
  let lastTime = performance.now();
  let resizePending = false;

  /* ====================================================================
   *  LAYOUT  (adapts to any screen; keeps game state when resized)
   * ==================================================================== */

  function readInsets(rect) {
    const cs = getComputedStyle(probe);
    const t = parseFloat(cs.paddingTop) || 0;
    const r = parseFloat(cs.paddingRight) || 0;
    const b = parseFloat(cs.paddingBottom) || 0;
    const l = parseFloat(cs.paddingLeft) || 0;

    // Only count an inset if the canvas actually touches that screen edge.
    return {
      t: Math.max(0, t - rect.top),
      r: Math.max(0, r - (window.innerWidth - rect.right)),
      b: Math.max(0, b - (window.innerHeight - rect.bottom)),
      l: Math.max(0, l - rect.left),
    };
  }

  function fitCourt(w, h, padTop, padBottom, minGutter) {
    const availH = Math.max(100, h - padTop - padBottom);

    let ch = availH;
    let cw = Math.min(ch * CFG.COURT_RATIO, w - 2 * minGutter);

    if (cw / ch < CFG.MIN_RATIO) {
      ch = cw / CFG.MIN_RATIO;
    } else if (cw / ch > CFG.MAX_RATIO) {
      cw = ch * CFG.MAX_RATIO;
    }

    const left = (w - cw) / 2;
    const top = padTop + (availH - ch) / 2;

    return { left, right: left + cw, top, bottom: top + ch, w: cw, h: ch };
  }

  function snapshotNormalized() {
    if (!court.w) return null;

    const n = (x, y) => [(x - court.left) / court.w, (y - court.top) / court.h];

    return {
      S: view.S,
      puck: n(puck.x, puck.y),
      player: n(player.x, player.y),
      ai: n(ai.x, ai.y),
      pt: n(player.tx, player.ty),
      at: n(ai.tx, ai.ty),
      goal: n(goalAnim.x, goalAnim.y0),
    };
  }

  function restoreNormalized(s) {
    const p = (a) => [court.left + a[0] * court.w, court.top + a[1] * court.h];
    const k = view.S / s.S;

    [puck.x, puck.y] = p(s.puck);
    [player.x, player.y] = p(s.player);
    [ai.x, ai.y] = p(s.ai);
    [player.tx, player.ty] = p(s.pt);
    [ai.tx, ai.ty] = p(s.at);
    [goalAnim.x, goalAnim.y0] = p(s.goal);

    puck.vx *= k; puck.vy *= k;
    serve.vx *= k; serve.vy *= k;
    player.vx *= k; player.vy *= k;
    ai.vx *= k; ai.vy *= k;
  }

  function snap(e) {
    e.ox = e.x;
    e.oy = e.y;
  }

  function placeMalletsHome() {
    player.x = player.tx = court.cx;
    player.y = player.ty = court.bottom - court.h * 0.12;
    ai.x = ai.tx = court.cx;
    ai.y = ai.ty = court.top + court.h * 0.12;
    player.vx = player.vy = ai.vx = ai.vy = 0;
    snap(player);
    snap(ai);
  }

  function layout() {
    const rect = wrap.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);

    if (w < 120 || h < 120) return;

    const saved = snapshotNormalized();
    const firstLayout = !court.w;

    view.W = w;
    view.H = h;
    view.dpr = Math.min(window.devicePixelRatio || 1, CFG.MAX_DPR);

    const pxW = Math.round(w * view.dpr);
    const pxH = Math.round(h * view.dpr);

    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }

    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

    const ins = readInsets(rect);
    view.insetTop = ins.t;

    const edge = Math.max(8, h * 0.022);
    const minGutter = clamp(w * 0.105, 34, 60);

    let c = fitCourt(w, h, ins.t + edge, ins.b + edge, minGutter);

    // Narrow gutters can't hold the HUD text, so use a compact top row.
    view.compact = c.left < 76;

    if (view.compact) {
      c = fitCourt(w, h, ins.t + 34, ins.b + edge, minGutter);
    }

    court.left = c.left;
    court.right = c.right;
    court.top = c.top;
    court.bottom = c.bottom;
    court.w = c.w;
    court.h = c.h;
    court.cx = (c.left + c.right) / 2;
    court.midY = (c.top + c.bottom) / 2;

    view.u = clamp(court.w / 300, 0.8, 1.7);
    view.S = clamp(Math.sqrt(court.w * court.h) / 330, 0.75, 2.2);
    view.wallW = Math.max(1.5, 2 * view.u);

    player.r = ai.r = clamp(16 * view.u, 13, 26);
    puck.r = clamp(8 * view.u, 7, 13.5);

    goal.w = court.w * CFG.GOAL_SPAN;
    goal.left = court.cx - goal.w / 2;
    goal.right = court.cx + goal.w / 2;
    goal.thick = Math.max(2.5, 3 * view.u);

    if (firstLayout) {
      placeMalletsHome();
    } else if (saved) {
      restoreNormalized(saved);
      snap(puck);
      snap(player);
      snap(ai);
    }

    buildBackground();
  }

  function scheduleLayout() {
    if (resizePending) return;
    resizePending = true;

    requestAnimationFrame(() => {
      resizePending = false;
      layout();
    });
  }

  /* ====================================================================
   *  STATIC BACKGROUND
   * ==================================================================== */

  function buildBackground() {
    bgCanvas.width = canvas.width;
    bgCanvas.height = canvas.height;

    const b = bgCtx;
    b.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

    b.fillStyle = COLORS.bg;
    b.fillRect(0, 0, view.W, view.H);

    // Faint end lines so wall bounces make sense.
    b.strokeStyle = COLORS.edge;
    b.lineWidth = 1;
    b.beginPath();
    b.moveTo(court.left, court.top);
    b.lineTo(court.right, court.top);
    b.moveTo(court.left, court.bottom);
    b.lineTo(court.right, court.bottom);
    b.stroke();

    // Centre line.
    b.strokeStyle = COLORS.centre;
    b.beginPath();
    b.moveTo(court.left, court.midY);
    b.lineTo(court.right, court.midY);
    b.stroke();

    // White side walls.
    b.strokeStyle = COLORS.wall;
    b.lineWidth = view.wallW;
    b.beginPath();
    b.moveTo(court.left, court.top);
    b.lineTo(court.left, court.bottom);
    b.moveTo(court.right, court.top);
    b.lineTo(court.right, court.bottom);
    b.stroke();

    // Goal bars (the exact span used for scoring).
    drawGoalBar(b, 'top', 1);
    drawGoalBar(b, 'bottom', 1);
  }

  function drawGoalBar(g, side, glow) {
    const y = side === 'top' ? court.top : court.bottom;

    g.save();
    g.fillStyle = side === 'top' ? COLORS.goalTop : COLORS.goalBottom;
    g.shadowColor = side === 'top' ? 'rgba(243,178,195,0.7)' : 'rgba(151,187,243,0.7)';
    g.shadowBlur = 8 * glow;
    g.fillRect(goal.left, y - goal.thick / 2, goal.w, goal.thick);
    g.restore();
  }

  /* ====================================================================
   *  AUDIO
   * ==================================================================== */

  let audioCtx = null;
  let audioReady = false;
  let muted = false;
  let lastWallSound = 0;

  function ensureAudio() {
    if (audioReady) {
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      return;
    }

    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;

      audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      audioReady = true;
    } catch (_) {
      audioReady = false;
    }
  }

  function tone(freq, dur, type, vol, endFreq) {
    if (!audioReady || !audioCtx || muted) return;

    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);

    if (endFreq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), now + dur);
    }

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(vol, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  const sfx = {
    paddle(isHuman) {
      tone(isHuman ? 460 : 320, 0.055, 'triangle', 0.032, isHuman ? 600 : 410);
    },
    wall() {
      const t = performance.now();
      if (t - lastWallSound < 60) return;
      lastWallSound = t;
      tone(220, 0.035, 'square', 0.018, 180);
    },
    goal(human) {
      if (human) {
        tone(660, 0.09, 'sine', 0.045, 920);
        setTimeout(() => tone(920, 0.12, 'sine', 0.045, 1180), 55);
      } else {
        tone(250, 0.12, 'sine', 0.04, 150);
        setTimeout(() => tone(150, 0.14, 'sine', 0.035, 100), 70);
      }
    },
    serve() {
      tone(380, 0.06, 'sine', 0.02, 520);
    },
  };

  /* ====================================================================
   *  INPUT
   * ==================================================================== */

  function pointerToCourt(e) {
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) * (view.W / r.width);
    let y = (e.clientY - r.top) * (view.H / r.height);

    // On touch, hold the mallet just above the finger so it stays visible.
    if (e.pointerType === 'touch') y -= player.r * 1.6;

    player.tx = x;
    player.ty = y;
  }

  function tryReplay() {
    if (game.phase === 'over' && game.lock <= 0) {
      startGame();
      return true;
    }
    return false;
  }

  canvas.addEventListener('pointerdown', (e) => {
    ensureAudio();

    if (pointer.id !== null && e.pointerType === 'touch') return;

    pointer.id = e.pointerId;
    canvas.setPointerCapture?.(e.pointerId);

    if (!tryReplay()) pointerToCourt(e);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' || e.pointerId === pointer.id) {
      pointerToCourt(e);
    }
  });

  const releasePointer = (e) => {
    if (e.pointerId === pointer.id) pointer.id = null;
  };

  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);
  canvas.addEventListener('lostpointercapture', releasePointer);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  const GAME_KEYS = new Set([
    'arrowleft', 'arrowright', 'arrowup', 'arrowdown',
    'a', 'd', 'w', 's', 'r', 'm', 'enter', ' ',
  ]);

  const normKey = (k) => (k.length === 1 ? k.toLowerCase() : k.toLowerCase());

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const k = normKey(e.key);
    if (!GAME_KEYS.has(k)) return;

    e.preventDefault();
    ensureAudio();

    if (k === 'm' && !e.repeat) {
      muted = !muted;
      return;
    }

    if (k === 'r' || k === 'enter' || k === ' ') {
      if (!e.repeat) tryReplay();
      return;
    }

    keys.add(k);
  });

  window.addEventListener('keyup', (e) => keys.delete(normKey(e.key)));
  window.addEventListener('blur', () => keys.clear());

  /* ====================================================================
   *  MALLETS
   * ==================================================================== */

  function malletBounds(m, isPlayer) {
    const pad = view.wallW * 0.5 + 1.5;

    return {
      minX: court.left + m.r + pad,
      maxX: court.right - m.r - pad,
      minY: isPlayer ? court.midY + m.r : court.top + m.r + pad,
      maxY: isPlayer ? court.bottom - m.r - pad : court.midY - m.r,
    };
  }

  function moveMallet(m, isPlayer, gain, vmax, dt) {
    const b = malletBounds(m, isPlayer);

    m.tx = clamp(m.tx, b.minX, b.maxX);
    m.ty = clamp(m.ty, b.minY, b.maxY);

    let vx = (m.tx - m.x) * gain;
    let vy = (m.ty - m.y) * gain;

    const sp = Math.hypot(vx, vy);
    if (sp > vmax) {
      const k = vmax / sp;
      vx *= k;
      vy *= k;
    }

    m.x = clamp(m.x + vx * dt, b.minX, b.maxX);
    m.y = clamp(m.y + vy * dt, b.minY, b.maxY);

    // Real velocity (after clamping) is what the puck feels.
    m.vx = (m.x - m.ox) / dt;
    m.vy = (m.y - m.oy) / dt;
  }

  function applyKeys(dt) {
    if (!keys.size) return;

    const left = keys.has('arrowleft') || keys.has('a');
    const right = keys.has('arrowright') || keys.has('d');
    const up = keys.has('arrowup') || keys.has('w');
    const down = keys.has('arrowdown') || keys.has('s');

    let dx = (right ? 1 : 0) - (left ? 1 : 0);
    let dy = (down ? 1 : 0) - (up ? 1 : 0);

    if (!dx && !dy) return;

    const len = Math.hypot(dx, dy);
    const speed = 640 * view.S;

    player.tx = player.x + (dx / len) * speed * 0.12;
    player.ty = player.y + (dy / len) * speed * 0.12;
  }

  /* ====================================================================
   *  AI
   * ==================================================================== */

  function predictX(targetY) {
    if (puck.vy >= -1) return puck.x;

    const t = (targetY - puck.y) / puck.vy;
    if (t <= 0) return puck.x;

    const minX = court.left + view.wallW + puck.r;
    const maxX = court.right - view.wallW - puck.r;
    const span = maxX - minX;

    if (span <= 0) return puck.x;

    let local = (puck.x + puck.vx * t - minX) % (2 * span);
    if (local < 0) local += 2 * span;
    if (local > span) local = 2 * span - local;

    return minX + local;
  }

  function aiPlan(dt) {
    brain.think -= dt;
    if (brain.think > 0) return;

    // Reaction latency: lower difficulty thinks less often.
    brain.think = lerp(0.30, 0.08, DIFF) + rand(0, 0.12);

    const S = view.S;
    const errMax = (0.05 + (1 - DIFF) * 0.17) * court.w;
    brain.errX = rand(-1, 1) * errMax;
    brain.errY = rand(-1, 1) * errMax * 0.4;

    const homeY = court.top + court.h * 0.12;
    const speed = Math.hypot(puck.vx, puck.vy);
    const attackLimit = (330 + 300 * DIFF) * S;
    const strikeSpeed = (150 + 260 * DIFF) * S;
    const moveSpeed = (260 + 520 * DIFF) * S;

    let tx = court.cx;
    let ty = homeY;
    let vmax = moveSpeed;
    let mode = 'home';

    if (game.phase !== 'play') {
      tx = court.cx;
    } else if (puck.y < court.midY && speed < attackLimit && puck.vy > -attackLimit * 0.7) {
      // Puck is on our side and catchable: line up behind it, then strike.
      if (brain.mode !== 'strike' && brain.mode !== 'approach') {
        brain.aimX = rand(goal.left + goal.w * 0.1, goal.right - goal.w * 0.1);
      }

      let dx = brain.aimX - puck.x;
      let dy = court.bottom - puck.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;

      const contact = ai.r + puck.r;
      const bx = puck.x - dx * contact;
      const by = puck.y - dy * contact;

      if (Math.hypot(ai.x - bx, ai.y - by) > ai.r * 1.1) {
        mode = 'approach';
        tx = bx + brain.errX * 0.3;
        ty = by;
      } else {
        mode = 'strike';
        tx = puck.x + dx * ai.r * 0.8;
        ty = puck.y + dy * ai.r * 0.8;
        vmax = strikeSpeed;
      }
    } else if (puck.vy < 0) {
      // Puck is coming toward us: slide across to where it will arrive.
      mode = 'defend';
      ty = homeY + brain.errY;

      // Easier AI sometimes loses track of the puck for a moment.
      if (Math.random() < 0.3 * (1 - DIFF)) {
        tx = ai.x;
      } else {
        tx = predictX(homeY + ai.r) + brain.errX;
      }
    } else {
      // Puck is heading away: drift back toward the middle.
      tx = lerp(court.cx, puck.x, 0.35);
      ty = homeY;
    }

    brain.mode = mode;
    brain.vmax = vmax;
    ai.tx = tx;
    ai.ty = ty;
  }

  /* ====================================================================
   *  PUCK PHYSICS
   * ==================================================================== */

  function puckLimits() {
    const S = view.S;
    return { max: 760 * S, cruise: 360 * S, minHit: 150 * S, still: 70 * S };
  }

  function setPuckSpeed(s) {
    const cur = Math.hypot(puck.vx, puck.vy) || 1;
    puck.vx *= s / cur;
    puck.vy *= s / cur;
  }

  function collideMallet(m, isPlayer) {
    const dx = puck.x - m.x;
    const dy = puck.y - m.y;
    const minD = puck.r + m.r;
    const d2 = dx * dx + dy * dy;

    if (d2 >= minD * minD) return false;

    let nx;
    let ny;
    const d = Math.sqrt(d2);

    if (d < 1e-4) {
      nx = 0;
      ny = isPlayer ? -1 : 1;
    } else {
      nx = dx / d;
      ny = dy / d;
    }

    // Push the puck out of the mallet.
    puck.x = m.x + nx * minD;
    puck.y = m.y + ny * minD;

    // Only bounce if they are actually closing in on each other.
    const vn = (puck.vx - m.vx) * nx + (puck.vy - m.vy) * ny;
    if (vn >= 0) return false;

    const j = -(1 + CFG.RESTITUTION) * vn;
    puck.vx += j * nx;
    puck.vy += j * ny;

    const L = puckLimits();
    let s = Math.hypot(puck.vx, puck.vy);

    // Avoid a dead puck or one that skates sideways forever.
    if (s < L.minHit) {
      if (s < 1e-3) {
        puck.vx = nx;
        puck.vy = ny;
      }
      setPuckSpeed(L.minHit);
      s = L.minHit;
    }

    if (s > L.max) {
      setPuckSpeed(L.max);
      s = L.max;
    }

    const minVy = s * 0.16;
    if (Math.abs(puck.vy) < minVy) {
      const sign = Math.abs(puck.vy) > 1e-3 ? Math.sign(puck.vy) : (isPlayer ? -1 : 1);
      puck.vy = sign * minVy;
      puck.vx = (Math.sign(puck.vx) || (Math.random() < 0.5 ? -1 : 1)) *
        Math.sqrt(Math.max(0, s * s - puck.vy * puck.vy));
    }

    fx.hit = 1;
    game.stall = 0;
    sfx.paddle(isPlayer);

    return true;
  }

  // If the puck is jammed between a mallet and a wall, push the mallet back.
  function relieveSqueeze(m, isPlayer) {
    const dx = puck.x - m.x;
    const dy = puck.y - m.y;
    const minD = puck.r + m.r;
    const d2 = dx * dx + dy * dy;

    if (d2 >= minD * minD || d2 < 1e-6) return;

    const d = Math.sqrt(d2);
    const b = malletBounds(m, isPlayer);

    m.x = clamp(puck.x - (dx / d) * minD, b.minX, b.maxX);
    m.y = clamp(puck.y - (dy / d) * minD, b.minY, b.maxY);
  }

  function inGoalMouth(x) {
    const slack = puck.r * 0.35;
    return x >= goal.left - slack && x <= goal.right + slack;
  }

  function stepPuck(dt) {
    const L = puckLimits();

    puck.x += puck.vx * dt;
    puck.y += puck.vy * dt;

    collideMallet(ai, false);
    collideMallet(player, true);

    // Side walls.
    const minX = court.left + view.wallW * 0.5 + puck.r;
    const maxX = court.right - view.wallW * 0.5 - puck.r;

    if (puck.x < minX) {
      puck.x = minX;
      if (puck.vx < 0) {
        puck.vx = -puck.vx * CFG.WALL_BOUNCE;
        sfx.wall();
      }
    } else if (puck.x > maxX) {
      puck.x = maxX;
      if (puck.vx > 0) {
        puck.vx = -puck.vx * CFG.WALL_BOUNCE;
        sfx.wall();
      }
    }

    // End lines: only the coloured bars score. Anywhere else is a wall.
    if (puck.vy < 0 && puck.y - puck.r <= court.top) {
      if (inGoalMouth(puck.x)) {
        beginGoal('top');
        return;
      }
      puck.y = court.top + puck.r;
      puck.vy = -puck.vy * CFG.WALL_BOUNCE;
      sfx.wall();
    } else if (puck.vy > 0 && puck.y + puck.r >= court.bottom) {
      if (inGoalMouth(puck.x)) {
        beginGoal('bottom');
        return;
      }
      puck.y = court.bottom - puck.r;
      puck.vy = -puck.vy * CFG.WALL_BOUNCE;
      sfx.wall();
    }

    relieveSqueeze(ai, false);
    relieveSqueeze(player, true);

    // Speed management: cap, and let very fast pucks settle.
    const s = Math.hypot(puck.vx, puck.vy);

    if (s > L.max) {
      setPuckSpeed(L.max);
    } else if (s > L.cruise) {
      setPuckSpeed(s - (s - L.cruise) * CFG.PUCK_DAMPING * dt);
    }

    // Anti-stall: a puck sitting still gets a gentle nudge toward the middle.
    if (s < L.still) {
      game.stall += dt;

      if (game.stall > 2.2) {
        const dir = puck.y > court.midY ? -1 : 1;
        puck.vx = rand(-0.4, 0.4) * 200 * view.S;
        puck.vy = dir * 200 * view.S;
        game.stall = 0;
      }
    } else {
      game.stall = 0;
    }
  }

  /* ====================================================================
   *  SERVE / GOAL / MATCH FLOW
   * ==================================================================== */

  function announce(text) {
    statusEl.textContent = text;
  }

  /*
   * conceder: 'player' | 'ai' | null
   * The puck appears on the conceding side and moves toward the scorer.
   * null = opening serve from the centre in a random direction.
   */
  function queueServe(conceder) {
    let dirY;
    let sx = court.cx + rand(-0.16, 0.16) * court.w;
    let sy;

    if (conceder === 'player') {
      dirY = -1;
      sy = court.bottom - court.h * 0.22;
    } else if (conceder === 'ai') {
      dirY = 1;
      sy = court.top + court.h * 0.22;
    } else {
      dirY = Math.random() < 0.5 ? -1 : 1;
      sy = court.midY;
    }

    // Never spawn on top of a mallet.
    for (const m of [player, ai]) {
      if (Math.hypot(sx - m.x, sy - m.y) < m.r + puck.r + 22) {
        sx = m.x > court.cx ? court.cx - court.w * 0.14 : court.cx + court.w * 0.14;
      }
    }

    const angle = rand(-0.32, 0.32);
    const speed = 300 * view.S * rand(0.92, 1.08);

    puck.x = sx;
    puck.y = sy;
    puck.vx = 0;
    puck.vy = 0;
    puck.alpha = 0;
    puck.scale = 1;
    snap(puck);

    serve.t = 0;
    serve.vx = Math.sin(angle) * speed * 0.8;
    serve.vy = dirY * Math.cos(angle) * speed;

    game.phase = 'serve';
    game.stall = 0;
    fx.trail.length = 0;
  }

  function updateServe(dt) {
    serve.t += dt;
    puck.alpha = clamp(serve.t / (CFG.SERVE_DELAY * 0.6), 0, 1);

    if (serve.t >= CFG.SERVE_DELAY) {
      puck.alpha = 1;
      puck.vx = serve.vx;
      puck.vy = serve.vy;
      game.phase = 'play';
      fx.launch = 1;
      sfx.serve();
    }
  }

  function beginGoal(side) {
    goalAnim.side = side;
    goalAnim.t = 0;
    goalAnim.x = puck.x;
    goalAnim.y0 = puck.y;

    puck.vx = 0;
    puck.vy = 0;

    fx.flashSide = side;
    fx.flash = 1;

    game.phase = 'goal';

    // Top bar is the AI's goal, so the player scored there.
    sfx.goal(side === 'top');
  }

  function updateGoal(dt) {
    goalAnim.t += dt;

    const p = clamp(goalAnim.t / CFG.GOAL_TIME, 0, 1);
    const e = 1 - Math.pow(1 - p, 3);
    const dir = goalAnim.side === 'top' ? -1 : 1;

    puck.x = goalAnim.x;
    puck.y = goalAnim.y0 + dir * e * puck.r * 1.6;
    puck.alpha = 1 - p;
    puck.scale = 1 - 0.45 * p;

    if (p >= 1) finishGoal();
  }

  function finishGoal() {
    const humanScored = goalAnim.side === 'top';

    if (humanScored) game.playerScore += 1;
    else game.aiScore += 1;

    const score = `${game.playerScore} to ${game.aiScore}`;

    puck.alpha = 0;
    puck.scale = 1;
    snap(puck);

    if (game.playerScore >= CFG.WIN_SCORE || game.aiScore >= CFG.WIN_SCORE) {
      game.phase = 'over';
      game.winner = humanScored ? 'player' : 'ai';
      game.lock = CFG.REPLAY_LOCK;

      announce(
        (humanScored ? 'You win! ' : 'Red wins! ') +
        `Final score ${score}. Tap or press Enter to replay.`
      );
      return;
    }

    announce(`${humanScored ? 'You scored.' : 'Red scored.'} Score ${score}.`);
    queueServe(humanScored ? 'ai' : 'player');
  }

  function startGame() {
    game.playerScore = 0;
    game.aiScore = 0;
    game.winner = null;
    game.lock = 0;
    game.stall = 0;

    fx.flash = 0;
    fx.hit = 0;
    fx.launch = 0;

    brain.think = 0;
    brain.mode = 'home';

    placeMalletsHome();
    queueServe(null);

    announce(`New game. First to ${CFG.WIN_SCORE} points wins.`);
  }

  /* ====================================================================
   *  UPDATE  (fixed timestep)
   * ==================================================================== */

  function step(dt) {
    snap(puck);
    snap(player);
    snap(ai);

    applyKeys(dt);
    aiPlan(dt);

    moveMallet(player, true, 26, 1500 * view.S, dt);
    moveMallet(ai, false, 16, brain.vmax || 600 * view.S, dt);

    switch (game.phase) {
      case 'serve': updateServe(dt); break;
      case 'play': stepPuck(dt); break;
      case 'goal': updateGoal(dt); break;
      case 'over': game.lock = Math.max(0, game.lock - dt); break;
      default: break;
    }
  }

  /* ====================================================================
   *  RENDER
   * ==================================================================== */

  function text(str, x, y, size, color, align) {
    ctx.font = `700 ${size}px Arial, Helvetica, sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(str, x, y);
  }

  function drawHud() {
    const gutter = court.left;

    if (view.compact) {
      text(
        `Reach ${CFG.WIN_SCORE} points`,
        view.W / 2,
        view.insetTop + 16,
        12,
        'rgba(255,255,255,0.92)',
        'center'
      );
    } else {
      const fs = clamp(gutter * 0.15, 11, 16);
      const x = Math.max(10, gutter * 0.12);

      text('Reach', x, court.top + fs * 1.45, fs, COLORS.text);
      text(`${CFG.WIN_SCORE} points`, x, court.top + fs * 2.55, fs, COLORS.text);
    }

    const size = clamp(gutter * 0.5, 24, 56);

    text(String(game.playerScore), gutter / 2, court.midY, size, COLORS.blue, 'center');
    text(String(game.aiScore), (view.W + court.right) / 2, court.midY, size, COLORS.red, 'center');
  }

  function drawGoalFlash() {
    if (fx.flash <= 0 || !fx.flashSide) return;

    ctx.save();
    ctx.globalAlpha = clamp(fx.flash, 0, 1);
    drawGoalBar(ctx, fx.flashSide, 3);
    ctx.restore();
  }

  function drawTrail() {
    const n = fx.trail.length;

    for (let i = 0; i < n; i += 1) {
      const t = (i + 1) / (n + 1);
      const p = fx.trail[i];

      ctx.globalAlpha = t * 0.16;
      ctx.fillStyle = '#c8dcff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, puck.r * (0.55 + 0.45 * t), 0, TAU);
      ctx.fill();
    }

    ctx.globalAlpha = 1;
  }

  function drawMallet(m, color, glow, a) {
    const x = lerp(m.ox, m.x, a);
    const y = lerp(m.oy, m.y, a);

    ctx.save();
    ctx.shadowColor = glow;
    ctx.shadowBlur = 10 * view.u;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, m.r, 0, TAU);
    ctx.fill();
    ctx.restore();

    const hl = ctx.createRadialGradient(
      x - m.r * 0.3, y - m.r * 0.35, 1, x, y, m.r
    );
    hl.addColorStop(0, 'rgba(255,255,255,0.22)');
    hl.addColorStop(1, 'rgba(255,255,255,0)');

    ctx.fillStyle = hl;
    ctx.beginPath();
    ctx.arc(x, y, m.r, 0, TAU);
    ctx.fill();
  }

  function drawPuck(a) {
    if (puck.alpha <= 0.01) return;

    const x = lerp(puck.ox, puck.x, a);
    const y = lerp(puck.oy, puck.y, a);
    const r = puck.r * puck.scale;

    ctx.save();
    ctx.globalAlpha = puck.alpha;

    // Soft glow.
    const glow = ctx.createRadialGradient(x, y, 0, x, y, r * (2.7 + fx.hit * 0.8));
    glow.addColorStop(0, 'rgba(210,228,255,0.42)');
    glow.addColorStop(1, 'rgba(210,228,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, r * (2.7 + fx.hit * 0.8), 0, TAU);
    ctx.fill();

    // Spawn ring while the serve is counting down.
    if (game.phase === 'serve') {
      const p = clamp(serve.t / CFG.SERVE_DELAY, 0, 1);
      ctx.strokeStyle = 'rgba(180,210,255,0.55)';
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = (1 - p) * puck.alpha;
      ctx.beginPath();
      ctx.arc(x, y, r * (1.6 + (1 - p) * 2.4), 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = puck.alpha;
    }

    ctx.fillStyle = COLORS.puck;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();

    ctx.restore();
  }

  function drawOverlay() {
    if (game.phase !== 'over') return;

    ctx.fillStyle = 'rgba(10,28,48,0.38)';
    ctx.fillRect(0, 0, view.W, view.H);

    const big = clamp(court.w * 0.1, 24, 46);
    const small = clamp(court.w * 0.048, 13, 20);
    const playerWon = game.winner === 'player';

    text(
      playerWon ? 'You Win!' : 'Red Wins!',
      court.cx,
      court.midY - big * 0.45,
      big,
      playerWon ? COLORS.blue : COLORS.red,
      'center'
    );

    const pulse = game.lock > 0 ? 0.35 : 0.7 + 0.3 * Math.sin(fx.time * 4);

    text(
      'Tap or press Enter to replay',
      court.cx,
      court.midY + big * 0.7,
      small,
      `rgba(255,255,255,${pulse.toFixed(3)})`,
      'center'
    );
  }

  function render(a, frameDt) {
    fx.time += frameDt;
    fx.hit = Math.max(0, fx.hit - frameDt * 5);
    fx.launch = Math.max(0, fx.launch - frameDt * 4);
    fx.flash = Math.max(0, fx.flash - frameDt * 2.8);

    // Short ghost trail, only while the puck is travelling.
    if (game.phase === 'play') {
      fx.trail.push({ x: lerp(puck.ox, puck.x, a), y: lerp(puck.oy, puck.y, a) });
      if (fx.trail.length > 6) fx.trail.shift();
    } else if (fx.trail.length) {
      fx.trail.length = 0;
    }

    ctx.drawImage(bgCanvas, 0, 0, view.W, view.H);

    drawHud();
    drawGoalFlash();

    if (game.phase === 'play') drawTrail();

    drawMallet(ai, COLORS.red, 'rgba(255,22,29,0.45)', a);
    drawMallet(player, COLORS.blue, 'rgba(79,141,255,0.5)', a);
    drawPuck(a);

    drawOverlay();
  }

  /* ====================================================================
   *  LOOP
   * ==================================================================== */

  function frame(now) {
    let dt = (now - lastTime) / 1000;
    lastTime = now;

    if (!(dt > 0)) dt = 0;
    dt = Math.min(dt, CFG.MAX_FRAME);

    acc += dt;

    let steps = 0;
    while (acc >= CFG.STEP && steps < 60) {
      step(CFG.STEP);
      acc -= CFG.STEP;
      steps += 1;
    }

    if (steps >= 60) acc = 0;

    render(acc / CFG.STEP, dt);
    requestAnimationFrame(frame);
  }

  /* ====================================================================
   *  INIT
   * ==================================================================== */

  window.addEventListener('resize', scheduleLayout, { passive: true });
  window.addEventListener('orientationchange', () => setTimeout(scheduleLayout, 60), { passive: true });
  window.visualViewport?.addEventListener('resize', scheduleLayout, { passive: true });

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(scheduleLayout).observe(wrap);
  }

  document.addEventListener('visibilitychange', () => {
    lastTime = performance.now();
    acc = 0;

    if (document.hidden) keys.clear();
  });

  layout();
  startGame();

  requestAnimationFrame((t) => {
    lastTime = t;
    requestAnimationFrame(frame);
  });
})();
