(() => {
  const canvas = document.getElementById('heartCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: true });
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let width = 0, height = 0, dpr = 1, frame = 0;
  let pointerX = 0, pointerY = 0, targetX = 0, targetY = 0;
  const particles = [];
  const COUNT = window.innerWidth < 600 ? 800 : 1450;
  const rand = (a, b) => a + Math.random() * (b - a);

  // Fill a 2D heart silhouette, then give every point depth to create a 3D particle volume.
  function heartPoint() {
    const t = rand(0, Math.PI * 2);
    const edgeX = 16 * Math.pow(Math.sin(t), 3);
    const edgeY = 13 * Math.cos(t) - 5 * Math.cos(2*t) - 2 * Math.cos(3*t) - Math.cos(4*t);
    const fill = Math.sqrt(Math.random());
    return {
      x: edgeX * fill / 17,
      y: edgeY * fill / 17,
      z: rand(-1, 1) * (0.12 + (1 - fill) * 0.48),
      size: rand(.65, 1.65),
      phase: rand(0, Math.PI * 2),
      alpha: rand(.48, .98),
      hue: rand(335, 352)
    };
  }
  for (let i = 0; i < COUNT; i++) particles.push(heartPoint());

  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, rect.width); height = Math.max(1, rect.height);
    dpr = Math.min(window.devicePixelRatio || 1, 1.8);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(canvas);
  else window.addEventListener('resize', resize);

  const art = canvas.parentElement;
  art.addEventListener('pointermove', (event) => {
    const r = art.getBoundingClientRect();
    targetY = ((event.clientX - r.left) / r.width - .5) * .65;
    targetX = ((event.clientY - r.top) / r.height - .5) * -.48;
  }, { passive: true });
  art.addEventListener('pointerleave', () => { targetX = 0; targetY = 0; });

  function draw() {
    frame += reduceMotion ? 0 : .008;
    pointerX += (targetX - pointerX) * .035;
    pointerY += (targetY - pointerY) * .035;
    ctx.clearRect(0, 0, width, height);

    const centerX = width * .5;
    const centerY = height * .5 + 2;
    const scale = Math.min(width, height) * .37;
    const rotY = frame * .34 + pointerX;
    const rotX = -.12 + Math.sin(frame * .55) * .12 + pointerY;
    const rotZ = Math.sin(frame * .28) * .055;
    const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
    const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
    const cosZ = Math.cos(rotZ), sinZ = Math.sin(rotZ);
    const projected = [];

    for (const p of particles) {
      let x = p.x, y = -p.y, z = p.z;
      const x1 = x * cosY + z * sinY;
      const z1 = -x * sinY + z * cosY;
      const y1 = y * cosX - z1 * sinX;
      const z2 = y * sinX + z1 * cosX;
      const x2 = x1 * cosZ - y1 * sinZ;
      const y2 = x1 * sinZ + y1 * cosZ;
      const perspective = 1 / (1.65 - z2 * .34);
      const pulse = 1 + Math.sin(frame * 1.8 + p.phase) * .025;
      projected.push({
        x: centerX + x2 * scale * perspective * pulse,
        y: centerY + y2 * scale * perspective * pulse,
        z: z2,
        size: p.size * perspective,
        alpha: p.alpha * (.72 + (z2 + 1) * .12),
        hue: p.hue
      });
    }
    projected.sort((a, b) => a.z - b.z);

    // Soft ambient halo.
    const halo = ctx.createRadialGradient(centerX, centerY, 2, centerX, centerY, scale * .95);
    halo.addColorStop(0, 'rgba(239,91,145,.12)');
    halo.addColorStop(.55, 'rgba(171,45,100,.055)');
    halo.addColorStop(1, 'rgba(120,30,75,0)');
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(centerX, centerY, scale * .95, 0, Math.PI * 2); ctx.fill();

    // Orbiting specks add depth around the heart.
    for (let i = 0; i < 38; i++) {
      const a = frame * .24 + i * Math.PI * 2 / 38;
      const rx = scale * (1.12 + .045 * Math.sin(i * 2.1));
      const ry = scale * .42;
      const x = centerX + Math.cos(a) * rx;
      const y = centerY + Math.sin(a) * ry;
      ctx.beginPath(); ctx.fillStyle = `rgba(255,190,211,${.12 + .18 * (1 + Math.sin(a))})`;
      ctx.arc(x, y, i % 6 === 0 ? 1.6 : .8, 0, Math.PI * 2); ctx.fill();
    }

    for (const p of projected) {
      const depthAlpha = Math.max(.15, Math.min(1, p.alpha));
      if (p.z > .25) {
        ctx.beginPath(); ctx.fillStyle = `rgba(255,190,211,${depthAlpha * .22})`;
        ctx.arc(p.x, p.y, p.size * 3.7, 0, Math.PI * 2); ctx.fill();
      }
      ctx.beginPath();
      ctx.fillStyle = `hsla(${p.hue}, 92%, ${p.z > 0 ? 78 : 64}%, ${depthAlpha})`;
      ctx.arc(p.x, p.y, p.size * (p.z > 0 ? 1.05 : .78), 0, Math.PI * 2);
      ctx.fill();
    }

    // A few bright pinpoints make the particle surface feel crystalline.
    for (let i = 0; i < 8; i++) {
      const p = projected[(i * 173 + 71) % projected.length];
      const twinkle = .5 + .5 * Math.sin(frame * 2.7 + i * 2.4);
      ctx.beginPath(); ctx.fillStyle = `rgba(255,235,242,${twinkle * .9})`;
      ctx.arc(p.x, p.y, 1.1 + twinkle * 1.2, 0, Math.PI * 2); ctx.fill();
    }
    if (!reduceMotion) requestAnimationFrame(draw);
  }
  draw();
})();
