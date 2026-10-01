(() => {
  'use strict';

  const canvas = document.getElementById('gameCanvas');
  const wrap = document.querySelector('.game-wrap');
  const status = document.getElementById('gameStatus');
  const ctx = canvas.getContext('2d');

  const GAME_RATIO = 1.31;
  const TAU = Math.PI * 2;
  const WIN_SCORE = 5;
  const START_ANGLE_MIN = -0.30;
  const START_ANGLE_MAX = 0.30;

  let W = 472;
  let H = 360;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  let running = true;
  let roundOver = false;
  let aiResetTimer = null;

  const goalAnimation = {
    active: false,
    side: null,
    progress: 0,
    duration: 0.34,
    startX: 0,
    endX: 0,
    y: 0,
    entryFlash: 0,
  };
  let lastTime = performance.now();
  let audioCtx = null;
  let audioReady = false;

  const state = {
    leftScore: 0,  // Human / blue
    rightScore: 0, // AI / red
    pulse: 0,
    flash: 0,
    servePulse: 0,
  };

  const court = {
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  };

  const player = {
    x: 0,
    y: 0,
    r: 17,
    targetX: 0,
    vx: 0,
    color: '#4f8dff',
    maxSpeed: 680,
    barY: 0,
  };

  const ai = {
    x: 0,
    y: 0,
    r: 17,
    targetX: 0,
    vx: 0,
    color: '#ff161d',
    maxSpeed: 420,
    barY: 0,
    error: 0,
    noiseTimer: 0,
    reaction: 0.80,
  };

  const puck = {
    x: 0,
    y: 0,
    r: 10,
    vx: 0,
    vy: 0,
    speed: 380,
    trail: [],
  };

  const keys = new Set();
  let pointerActive = false;

  function resize() {
    const rect = wrap.getBoundingClientRect();
    W = Math.max(320, Math.round(rect.width));
    H = Math.max(250, Math.round(rect.height));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const fieldW = W * 0.64;
    court.left = (W - fieldW) / 2;
    court.right = court.left + fieldW;
    court.top = H * 0.025;
    court.bottom = H * 0.965;

    player.r = Math.max(13, Math.min(21, W * 0.036));
    ai.r = player.r;
    puck.r = Math.max(7, Math.min(11.5, W * 0.021));

    player.y = court.bottom - H * 0.115;
    ai.y = court.top + H * 0.06;
    player.barY = court.bottom - 1;
    ai.barY = court.top + 1;

    if (!player.targetX) player.targetX = (court.left + court.right) / 2;
    if (!ai.targetX) ai.targetX = (court.left + court.right) / 2;

    player.x = clamp(player.x || player.targetX, court.left + player.r + 12, court.right - player.r - 12);
    ai.x = clamp(ai.x || ai.targetX, court.left + ai.r + 12, court.right - ai.r - 12);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function resetPuck(direction = null) {
    puck.x = W / 2;
    puck.y = H / 2;
    puck.trail = [];

    const dir = direction === null ? (Math.random() < 0.5 ? -1 : 1) : direction;
    const angle = START_ANGLE_MIN + Math.random() * (START_ANGLE_MAX - START_ANGLE_MIN);
    puck.speed = Math.max(350, Math.min(540, W * 0.84));
    puck.vx = Math.sin(angle) * puck.speed * 0.72;
    puck.vy = dir * Math.cos(angle) * puck.speed;

    // A slight horizontal bias avoids repeated identical serves.
    if (Math.abs(puck.vx) < puck.speed * 0.18) {
      puck.vx = (Math.random() < 0.5 ? -1 : 1) * puck.speed * 0.20;
    }

    // Keep every serve safely inside the two vertical court lines.
    puck.x = clamp(puck.x, court.left + puck.r + 2, court.right - puck.r - 2);
    puck.y = clamp(puck.y, court.top + puck.r + 2, court.bottom - puck.r - 2);
    state.servePulse = 1;
  }

  function resetPuckFromConcedingSide(humanScored) {
    puck.trail = [];
    puck.speed = Math.max(350, Math.min(540, W * 0.84));

    const angle = START_ANGLE_MIN + Math.random() * (START_ANGLE_MAX - START_ANGLE_MIN);
    const centreX = (court.left + court.right) / 2;
    const safeX = clamp(centreX + (Math.random() - 0.5) * (court.right - court.left) * 0.20, court.left + puck.r + 2, court.right - puck.r - 2);

    // The puck restarts in front of the side that conceded the point.
    if (humanScored) {
      puck.x = safeX;
      puck.y = clamp(ai.y + ai.r + puck.r + 12, court.top + puck.r + 2, court.bottom - puck.r - 2);
      puck.vx = Math.sin(angle) * puck.speed * 0.64;
      puck.vy = Math.abs(Math.cos(angle) * puck.speed);
    } else {
      puck.x = safeX;
      puck.y = clamp(player.y - player.r - puck.r - 12, court.top + puck.r + 2, court.bottom - puck.r - 2);
      puck.vx = Math.sin(angle) * puck.speed * 0.64;
      puck.vy = -Math.abs(Math.cos(angle) * puck.speed);
    }

    state.servePulse = 1;
  }

  function resetGame() {
    state.leftScore = 0;
    state.rightScore = 0;
    roundOver = false;
    running = true;
    goalAnimation.active = false;
    goalAnimation.side = null;
    goalAnimation.progress = 0;
    clearTimeout(aiResetTimer);
    aiResetTimer = null;
    player.targetX = (court.left + court.right) / 2;
    ai.targetX = player.targetX;
    player.x = player.targetX;
    ai.x = ai.targetX;
    resetPuck();
    status.textContent = 'Game restarted. First to five points wins.';
  }

  function ensureAudio() {
    if (audioReady) return;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      audioReady = true;
    } catch (_) {
      audioReady = false;
    }
  }

  function tone(frequency, duration, type = 'sine', volume = 0.035, endFrequency = null) {
    if (!audioReady || !audioCtx) return;
    const now = audioCtx.currentTime;
    const oscillator = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now);
    if (endFrequency !== null) {
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), now + duration);
    }

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    oscillator.connect(gain);
    gain.connect(audioCtx.destination);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }

  function playPaddleSound(isHuman) {
    tone(isHuman ? 460 : 320, 0.055, 'triangle', 0.032, isHuman ? 600 : 410);
  }

  function playWallSound() {
    tone(220, 0.035, 'square', 0.018, 180);
  }

  function playScoreSound(human) {
    if (human) {
      tone(660, 0.09, 'sine', 0.045, 920);
      window.setTimeout(() => tone(920, 0.12, 'sine', 0.045, 1180), 55);
    } else {
      tone(250, 0.12, 'sine', 0.04, 150);
      window.setTimeout(() => tone(150, 0.14, 'sine', 0.035, 100), 70);
    }
  }

  function updatePointer(clientX) {
    const rect = canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * W;
    player.targetX = clamp(x, court.left + player.r + 12, court.right - player.r - 12);
  }

  function handlePointer(event) {
    ensureAudio();
    pointerActive = true;
    updatePointer(event.clientX);
  }

  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture?.(event.pointerId);
    handlePointer(event);
  });

  canvas.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'mouse' || pointerActive || event.buttons) {
      handlePointer(event);
    }
  });

  canvas.addEventListener('pointerup', () => {
    pointerActive = false;
  });

  canvas.addEventListener('pointercancel', () => {
    pointerActive = false;
  });

  canvas.addEventListener('click', () => {
    ensureAudio();
    if (roundOver && state.leftScore >= WIN_SCORE) {
      resetGame();
    }
  });

  window.addEventListener('keydown', (event) => {
    ensureAudio();
    const relevant = ['ArrowLeft', 'ArrowRight', 'a', 'A', 'd', 'D', 'r', 'R', 'Enter', ' '];
    if (relevant.includes(event.key)) event.preventDefault();
    keys.add(event.key);

    if (roundOver && state.leftScore >= WIN_SCORE && (event.key === 'r' || event.key === 'R' || event.key === 'Enter' || event.key === ' ')) {
      resetGame();
    }
  });

  window.addEventListener('keyup', (event) => {
    keys.delete(event.key);
  });

  function updatePlayer(dt) {
    let direction = 0;
    if (keys.has('ArrowLeft') || keys.has('a') || keys.has('A')) direction -= 1;
    if (keys.has('ArrowRight') || keys.has('d') || keys.has('D')) direction += 1;

    if (direction !== 0) {
      player.targetX += direction * player.maxSpeed * dt;
      player.targetX = clamp(player.targetX, court.left + player.r + 12, court.right - player.r - 12);
    }

    const desired = player.targetX - player.x;
    const maxStep = player.maxSpeed * dt;
    const step = clamp(desired, -maxStep, maxStep);
    player.vx = dt > 0 ? step / dt : 0;
    player.x += step;
  }

  function predictPuckXAtY(targetY) {
    if (Math.abs(puck.vy) < 1 || puck.vy >= 0) return puck.x;
    const t = (targetY - puck.y) / puck.vy;
    if (t <= 0) return puck.x;

    let x = puck.x + puck.vx * t;
    const minX = court.left + ai.r + 12;
    const maxX = court.right - ai.r - 12;
    const span = maxX - minX;
    if (span <= 0) return x;

    // Reflect prediction against the court's horizontal walls.
    let local = (x - minX) % (2 * span);
    if (local < 0) local += 2 * span;
    if (local > span) local = 2 * span - local;
    return minX + local;
  }

  function updateAI(dt) {
    ai.noiseTimer -= dt;
    if (ai.noiseTimer <= 0) {
      ai.noiseTimer = 0.22 + Math.random() * 0.36;
      ai.error = (Math.random() - 0.5) * W * 0.07;
    }

    let target = (court.left + court.right) / 2;
    const puckHeadingTowardAI = puck.vy < 0;

    if (puckHeadingTowardAI) {
      const predicted = predictPuckXAtY(ai.y + ai.r * 1.1);
      target = predicted + ai.error;
    } else {
      target = lerp((court.left + court.right) / 2, puck.x, 0.18);
    }

    target = clamp(target, court.left + ai.r + 12, court.right - ai.r - 12);
    ai.targetX = target;

    const response = ai.reaction * 4.4;
    const desired = ai.targetX - ai.x;
    const maxStep = ai.maxSpeed * dt;
    const step = clamp(desired * response * dt, -maxStep, maxStep);
    ai.vx = dt > 0 ? step / dt : 0;
    ai.x += step;
  }

  function circleCollision(mallet, isHuman) {
    const dx = puck.x - mallet.x;
    const dy = puck.y - mallet.y;
    const minDistance = puck.r + mallet.r;
    const distSq = dx * dx + dy * dy;

    if (distSq > minDistance * minDistance) return false;

    const dist = Math.sqrt(distSq) || 0.0001;
    let nx = dx / dist;
    let ny = dy / dist;

    // When the puck is overlapping the mallet, push it out first.
    const overlap = minDistance - dist;
    puck.x += nx * overlap;
    puck.y += ny * overlap;

    const relativeVx = puck.vx - mallet.vx;
    const relativeVy = puck.vy;
    const relativeDot = relativeVx * nx + relativeVy * ny;

    if (relativeDot < 0) {
      puck.vx -= 2 * relativeDot * nx;
      puck.vy -= 2 * relativeDot * ny;
    } else {
      puck.vx = -puck.vx;
    }

    // Add a controlled amount of the mallet movement to the bounce.
    puck.vx += mallet.vx * 0.22;
    const speedBoost = isHuman ? 1.025 : 1.018;
    const currentSpeed = Math.hypot(puck.vx, puck.vy);
    const boosted = Math.min(780, Math.max(360, currentSpeed * speedBoost));
    const unitX = puck.vx / Math.max(currentSpeed, 0.001);
    const unitY = puck.vy / Math.max(currentSpeed, 0.001);
    puck.vx = unitX * boosted;
    puck.vy = unitY * boosted;

    // Prevent a near-flat loop from taking over the rally.
    const minVertical = boosted * 0.38;
    if (Math.abs(puck.vy) < minVertical) {
      puck.vy = Math.sign(puck.vy || (isHuman ? -1 : 1)) * minVertical;
      const horiz = Math.sqrt(Math.max(0, boosted * boosted - puck.vy * puck.vy));
      puck.vx = Math.sign(puck.vx || (Math.random() < 0.5 ? -1 : 1)) * horiz;
    }

    puck.trail = [];
    state.pulse = 1;
    playPaddleSound(isHuman);
    return true;
  }

  function scorePoint(humanScored) {
    if (roundOver) return;

    if (humanScored) state.leftScore += 1;
    else state.rightScore += 1;

    state.flash = 1;
    state.pulse = 0.75;
    playScoreSound(humanScored);

    if (humanScored && state.leftScore >= WIN_SCORE) {
      roundOver = true;
      running = false;
      status.textContent = 'Congratulations! You won the game. Press Enter, Space, R, or tap to replay.';
      return;
    }

    if (!humanScored && state.rightScore >= WIN_SCORE) {
      roundOver = true;
      running = false;
      status.textContent = 'Red Wins! The game will restart automatically.';
      aiResetTimer = window.setTimeout(() => {
        resetGame();
      }, 1250);
      return;
    }

    running = true;
    resetPuckFromConcedingSide(humanScored);
  }

  function beginGoal(side) {
    if (goalAnimation.active || roundOver) return;

    goalAnimation.active = true;
    goalAnimation.side = side;
    goalAnimation.progress = 0;
    goalAnimation.entryFlash = 1;
    goalAnimation.y = clamp(puck.y, court.top + puck.r + 4, court.bottom - puck.r - 4);
    goalAnimation.startX = side === 'left' ? court.left : court.right;

    const margin = side === 'left' ? court.left : W - court.right;
    const depth = Math.max(18, Math.min(margin * 0.72, W * 0.105));
    goalAnimation.endX = side === 'left'
      ? Math.max(puck.r * 1.25, court.left - depth)
      : Math.min(W - puck.r * 1.25, court.right + depth);

    puck.x = goalAnimation.startX;
    puck.y = goalAnimation.y;
    puck.vx = 0;
    puck.vy = 0;
    puck.trail = [];
    running = false;
    tone(side === 'left' ? 520 : 300, 0.07, 'triangle', 0.028, side === 'left' ? 740 : 190);
  }

  function updateGoalAnimation(dt) {
    if (!goalAnimation.active) return;

    goalAnimation.progress = Math.min(1, goalAnimation.progress + dt / goalAnimation.duration);
    goalAnimation.entryFlash = Math.max(0, goalAnimation.entryFlash - dt * 5.5);

    const eased = 1 - Math.pow(1 - goalAnimation.progress, 3);
    puck.x = lerp(goalAnimation.startX, goalAnimation.endX, eased);
    puck.y = goalAnimation.y;

    if (goalAnimation.progress >= 1) {
      const humanScored = goalAnimation.side === 'left';
      goalAnimation.active = false;
      goalAnimation.side = null;
      goalAnimation.progress = 0;
      scorePoint(humanScored);
    }
  }

  function update(dt) {
    state.pulse = Math.max(0, state.pulse - dt * 5.4);
    state.flash = Math.max(0, state.flash - dt * 3.7);
    state.servePulse = Math.max(0, state.servePulse - dt * 4.5);

    if (goalAnimation.active) {
      updateGoalAnimation(dt);
      return;
    }

    if (!running) return;

    updatePlayer(dt);
    updateAI(dt);

    const subSteps = 2;
    const stepDt = dt / subSteps;
    for (let step = 0; step < subSteps; step += 1) {
      puck.x += puck.vx * stepDt;
      puck.y += puck.vy * stepDt;

      // Top and bottom wall bounce.
      const minY = court.top + puck.r + 3;
      const maxY = court.bottom - puck.r - 3;
      if (puck.y < minY) {
        puck.y = minY;
        puck.vy = Math.abs(puck.vy);
        playWallSound();
      } else if (puck.y > maxY) {
        puck.y = maxY;
        puck.vy = -Math.abs(puck.vy);
        playWallSound();
      }

      // The side lines are the goal mouths. Check them before mallet collision so
      // a puck that reaches the line always enters the goal instead of bouncing back.
      if (puck.x - puck.r <= court.left && puck.vx < 0) {
        puck.x = court.left;
        beginGoal('left');
        return;
      }
      if (puck.x + puck.r >= court.right && puck.vx > 0) {
        puck.x = court.right;
        beginGoal('right');
        return;
      }

      circleCollision(ai, false);
      circleCollision(player, true);

      // Safety clamp for high-speed frames or device lag.
      puck.x = clamp(puck.x, court.left + puck.r, court.right - puck.r);
    }

    puck.trail.push({ x: puck.x, y: puck.y, life: 1 });
    if (puck.trail.length > 8) puck.trail.shift();
    for (const point of puck.trail) point.life -= dt * 4.0;
    puck.trail = puck.trail.filter((point) => point.life > 0);
  }

  function roundedRect(x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  function drawText(text, x, y, size, color, align = 'left', weight = '700') {
    ctx.font = `${weight} ${size}px Arial, Helvetica, sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
  }

  function drawBoard() {
    ctx.clearRect(0, 0, W, H);

    // Slight board gradient for a smoother version of the reference.
    const boardGradient = ctx.createLinearGradient(0, 0, 0, H);
    boardGradient.addColorStop(0, '#2c618f');
    boardGradient.addColorStop(1, '#245482');
    ctx.fillStyle = boardGradient;
    ctx.fillRect(0, 0, W, H);

    // Court boundaries.
    ctx.strokeStyle = 'rgba(255,255,255,0.88)';
    ctx.lineWidth = Math.max(1.4, W * 0.0038);
    ctx.beginPath();
    ctx.moveTo(court.left, court.top);
    ctx.lineTo(court.left, court.bottom);
    ctx.moveTo(court.right, court.top);
    ctx.lineTo(court.right, court.bottom);
    ctx.stroke();

    // Center line.
    ctx.strokeStyle = 'rgba(255,255,255,0.17)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(court.left, (court.top + court.bottom) / 2);
    ctx.lineTo(court.right, (court.top + court.bottom) / 2);
    ctx.stroke();

    // Player bars visible in the reference.
    const barWidth = (court.right - court.left) * 0.40;
    const barHeight = Math.max(2.1, H * 0.0065);
    const barX = (W - barWidth) / 2;

    ctx.save();
    ctx.shadowBlur = 7;
    ctx.shadowColor = 'rgba(255,255,255,0.22)';
    roundedRect(barX, ai.barY - barHeight / 2, barWidth, barHeight, barHeight / 2);
    ctx.fillStyle = '#ff777b';
    ctx.fill();
    roundedRect(barX, player.barY - barHeight / 2, barWidth, barHeight, barHeight / 2);
    ctx.fillStyle = '#a8c6ff';
    ctx.fill();
    ctx.restore();

    // Side scores.
    const scoreSize = Math.max(24, Math.min(38, W * 0.061));
    drawText(String(state.leftScore), W * 0.045, H * 0.50, scoreSize, '#76a2ff', 'left', '700');
    drawText(String(state.rightScore), W * 0.955, H * 0.50, scoreSize, '#ff171d', 'right', '700');

    // Top-left information.
    const small = Math.max(10, Math.min(14, W * 0.022));
    drawText('Level: 50', W * 0.025, H * 0.058, small, '#fff', 'left', '700');
    drawText('Reach', W * 0.025, H * 0.096, small, '#fff', 'left', '700');
    drawText('5 points', W * 0.025, H * 0.130, small, '#fff', 'left', '700');

    // Center label from the reference (with VS ai removed).
    // Intentionally omitted per the requested design change.
  }

  function drawMallet(mallet, mainColor, softColor, isAI) {
    ctx.save();

    const glow = ctx.createRadialGradient(mallet.x, mallet.y, mallet.r * 0.25, mallet.x, mallet.y, mallet.r * 2.2);
    glow.addColorStop(0, softColor.replace(')', ', 0.28)').replace('rgb(', 'rgba('));
    glow.addColorStop(1, softColor.replace(')', ', 0)').replace('rgb(', 'rgba('));

    // Use fixed rgba values because the supplied colors are hex strings.
    const rgba = isAI ? 'rgba(255,22,29,0.22)' : 'rgba(79,141,255,0.25)';
    const glow2 = ctx.createRadialGradient(mallet.x, mallet.y, mallet.r * 0.2, mallet.x, mallet.y, mallet.r * 2.35);
    glow2.addColorStop(0, rgba);
    glow2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow2;
    ctx.beginPath();
    ctx.arc(mallet.x, mallet.y, mallet.r * 2.35, 0, TAU);
    ctx.fill();

    ctx.shadowColor = rgba;
    ctx.shadowBlur = 13;
    ctx.fillStyle = mainColor;
    ctx.beginPath();
    ctx.arc(mallet.x, mallet.y, mallet.r, 0, TAU);
    ctx.fill();

    // Subtle highlight.
    const highlight = ctx.createRadialGradient(
      mallet.x - mallet.r * 0.34,
      mallet.y - mallet.r * 0.38,
      1,
      mallet.x,
      mallet.y,
      mallet.r
    );
    highlight.addColorStop(0, 'rgba(255,255,255,0.25)');
    highlight.addColorStop(0.42, 'rgba(255,255,255,0.04)');
    highlight.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = highlight;
    ctx.beginPath();
    ctx.arc(mallet.x, mallet.y, mallet.r, 0, TAU);
    ctx.fill();

    ctx.restore();
  }

  function drawPuck() {
    for (const point of puck.trail) {
      const alpha = Math.max(0, point.life) * 0.24;
      const radius = puck.r * (0.65 + point.life * 0.45);
      const trail = ctx.createRadialGradient(point.x, point.y, 1, point.x, point.y, radius * 2.1);
      trail.addColorStop(0, `rgba(166,201,255,${alpha})`);
      trail.addColorStop(1, 'rgba(166,201,255,0)');
      ctx.fillStyle = trail;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius * 1.6, 0, TAU);
      ctx.fill();
    }

    ctx.save();

    if (goalAnimation.active) {
      const progress = goalAnimation.progress;
      const scale = lerp(1, 0.56, Math.pow(progress, 0.8));
      const alpha = 1 - progress * 0.68;

      // Soft goal-entry glow at the line where the puck crosses into the goal.
      const ringX = goalAnimation.side === 'left' ? court.left : court.right;
      const ring = ctx.createRadialGradient(ringX, puck.y, 0, ringX, puck.y, puck.r * 3.6);
      ring.addColorStop(0, `rgba(255,255,255,${0.24 * goalAnimation.entryFlash})`);
      ring.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = ring;
      ctx.beginPath();
      ctx.arc(ringX, puck.y, puck.r * 3.6, 0, TAU);
      ctx.fill();

      // A short directional streak makes the puck visibly travel through the goal line.
      const streakLength = Math.max(16, Math.min(42, W * 0.055));
      const direction = goalAnimation.side === 'left' ? -1 : 1;
      const streak = ctx.createLinearGradient(puck.x, puck.y, puck.x - direction * streakLength, puck.y);
      streak.addColorStop(0, `rgba(255,255,255,${0.22 * alpha})`);
      streak.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = streak;
      ctx.lineWidth = puck.r * 0.9;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(puck.x, puck.y);
      ctx.lineTo(puck.x - direction * streakLength, puck.y);
      ctx.stroke();

      ctx.globalAlpha = alpha;
      ctx.translate(puck.x, puck.y);
      ctx.scale(scale, scale);
      ctx.translate(-puck.x, -puck.y);
    }

    const glow = ctx.createRadialGradient(puck.x, puck.y, 0, puck.x, puck.y, puck.r * 2.9);
    glow.addColorStop(0, 'rgba(219,233,255,0.48)');
    glow.addColorStop(1, 'rgba(219,233,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(puck.x, puck.y, puck.r * 2.9, 0, TAU);
    ctx.fill();

    ctx.shadowBlur = 10 + state.pulse * 14 + state.servePulse * 8;
    ctx.shadowColor = 'rgba(255,255,255,0.46)';
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(puck.x, puck.y, puck.r, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function drawWinOverlay() {
    if (!roundOver) return;

    const centerX = W / 2;
    const centerY = H / 2;

    ctx.save();
    ctx.fillStyle = 'rgba(13, 32, 52, 0.18)';
    ctx.fillRect(0, 0, W, H);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(0,0,0,0.12)';
    ctx.shadowBlur = 8;
    ctx.font = `700 ${Math.max(26, Math.min(40, W * 0.075))}px Arial, Helvetica, sans-serif`;

    if (state.leftScore >= WIN_SCORE) {
      ctx.fillText('Congratulations!', centerX, centerY - 8);
      ctx.shadowBlur = 0;
      ctx.font = `400 ${Math.max(14, Math.min(19, W * 0.032))}px Arial, Helvetica, sans-serif`;
      ctx.fillText('Tap or press Enter to replay.', centerX, centerY + 30);
    } else {
      ctx.fillText('Red Wins!', centerX, centerY - 8);
      ctx.shadowBlur = 0;
      ctx.font = `400 ${Math.max(13, Math.min(18, W * 0.030))}px Arial, Helvetica, sans-serif`;
      ctx.fillText('Restarting…', centerX, centerY + 28);
    }

    ctx.restore();
  }

  function draw() {
    drawBoard();
    drawMallet(ai, ai.color, '#ff9699', true);
    drawMallet(player, player.color, '#93b9ff', false);
    drawPuck();
    drawWinOverlay();
  }

  function frame(now) {
    const rawDt = (now - lastTime) / 1000;
    const dt = Math.min(rawDt, 0.035);
    lastTime = now;

    update(dt);
    draw();
    requestAnimationFrame(frame);
  }

  function init() {
    resize();
    resetGame();
    draw();
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize, { passive: true });
  window.addEventListener('orientationchange', () => setTimeout(resize, 50), { passive: true });

  init();
})();
