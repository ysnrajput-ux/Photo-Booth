// ============================================================
// TEMPLATE DEFINITIONS
// Each template is a pure-data description consumed by the
// Canvas compositor in photobooth.js (renderStrip).
// Categories map directly to the customization UI.
// ============================================================

const TEMPLATE_CATEGORIES = [
  {
    key: 'minimal',
    label: 'Minimal',
    templates: [
      { id: 'minimal-white', name: 'Clean White', bg: '#FFFFFF', frameColor: '#FFFFFF', frameWidth: 14, textColor: '#1F2937', accent: '#1F2937', font: 'Nunito' },
      { id: 'minimal-black', name: 'Black', bg: '#111111', frameColor: '#111111', frameWidth: 14, textColor: '#FFFFFF', accent: '#FFFFFF', font: 'Nunito' },
      { id: 'minimal-beige', name: 'Beige', bg: '#F2E8DC', frameColor: '#F2E8DC', frameWidth: 14, textColor: '#4B3B2A', accent: '#4B3B2A', font: 'Nunito' },
    ]
  },
  {
    key: 'cute',
    label: 'Cute',
    templates: [
      { id: 'cute-pastel', name: 'Pastel Hearts', bg: '#FFE4F0', frameColor: '#FF7EB6', frameWidth: 16, textColor: '#B23A6B', accent: '#FF7EB6', font: 'Fredoka One', stickers: ['heart','sparkle'] },
      { id: 'cute-stars', name: 'Stars & Bows', bg: '#EAF3FF', frameColor: '#2563EB', frameWidth: 16, textColor: '#1E3A8A', accent: '#2563EB', font: 'Fredoka One', stickers: ['star','bow'] },
    ]
  },
  {
    key: 'romantic',
    label: 'Romantic',
    templates: [
      { id: 'romantic-pink', name: 'Love Frame', bg: '#FFF0F3', frameColor: '#E11D48', frameWidth: 18, textColor: '#881337', accent: '#E11D48', font: 'Fredoka One', stickers: ['heart','heart'] },
    ]
  },
  {
    key: 'retro',
    label: 'Retro',
    templates: [
      { id: 'retro-film', name: 'Film Strip', bg: '#1A1A1A', frameColor: '#1A1A1A', frameWidth: 20, textColor: '#F5F5F5', accent: '#FFD166', font: 'Nunito', filmHoles: true },
      { id: 'retro-polaroid', name: 'Polaroid', bg: '#FDFBF6', frameColor: '#FDFBF6', frameWidth: 26, frameBottom: 70, textColor: '#3A3A3A', accent: '#3A3A3A', font: 'Nunito' },
    ]
  },
  {
    key: 'party',
    label: 'Party',
    templates: [
      { id: 'party-confetti', name: 'Confetti', bg: '#1F2937', frameColor: '#FFD166', frameWidth: 16, textColor: '#FFD166', accent: '#FF7EB6', font: 'Fredoka One', confetti: true },
    ]
  },
  {
    key: 'seasonal',
    label: 'Seasonal',
    templates: [
      { id: 'seasonal-winter', name: 'Winter', bg: '#EAF6FB', frameColor: '#0EA5E9', frameWidth: 16, textColor: '#075985', accent: '#0EA5E9', font: 'Fredoka One', stickers: ['snowflake','snowflake'] },
      { id: 'seasonal-valentine', name: "Valentine's", bg: '#FFE9EF', frameColor: '#FB7185', frameWidth: 16, textColor: '#9F1239', accent: '#FB7185', font: 'Fredoka One', stickers: ['heart','sparkle'] },
    ]
  },
  {
    key: 'trending',
    label: 'Trending',
    templates: [
      { id: 'trending-y2k', name: 'Y2K', bg: '#E8D9FF', frameColor: '#7C3AED', frameWidth: 14, textColor: '#4C1D95', accent: '#EC4899', font: 'Fredoka One', stickers: ['sparkle','star'] },
      { id: 'trending-scrapbook', name: 'Scrapbook', bg: '#FAF3E7', frameColor: '#B45309', frameWidth: 18, textColor: '#78350F', accent: '#B45309', font: 'Nunito', tape: true },
    ]
  },
];

// Small vector sticker library — drawn as canvas paths rather than emoji so
// output looks consistent across devices/OSes and matches the "no emoji
// stickers" requirement. Each entry only needs an id; drawSticker() below
// knows how to render it centered at (cx, cy) inside a `size`-px box.
const STICKER_LIBRARY = [
  { id: 'heart', label: 'Heart' },
  { id: 'star', label: 'Star' },
  { id: 'sparkle', label: 'Sparkle' },
  { id: 'bow', label: 'Bow' },
  { id: 'snowflake', label: 'Snowflake' },
  { id: 'balloon', label: 'Balloon' },
];

const FILTER_PRESETS = [
  { id: 'none', label: 'None', css: 'none' },
  { id: 'bw', label: 'B & W', css: 'grayscale(1) contrast(1.05)' },
  { id: 'vintage', label: 'Vintage', css: 'sepia(.35) saturate(1.15) contrast(.95)' },
  { id: 'warm', label: 'Warm', css: 'saturate(1.25) sepia(.12) brightness(1.03)' },
  { id: 'cool', label: 'Cool', css: 'saturate(1.1) hue-rotate(-8deg) brightness(1.02)' },
  { id: 'soft', label: 'Soft', css: 'contrast(.92) brightness(1.05) saturate(.95)' },
];

function findFilter(id) {
  return FILTER_PRESETS.find(f => f.id === id) || FILTER_PRESETS[0];
}

function drawSticker(ctx, id, cx, cy, size, color) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = color || '#FF7EB6';
  ctx.strokeStyle = color || '#FF7EB6';
  const s = size / 2;
  switch (id) {
    case 'heart':
      ctx.beginPath();
      ctx.moveTo(0, s * 0.35);
      ctx.bezierCurveTo(s, -s * 0.6, s * 1.3, s * 0.5, 0, s);
      ctx.bezierCurveTo(-s * 1.3, s * 0.5, -s, -s * 0.6, 0, s * 0.35);
      ctx.fill();
      break;
    case 'star': {
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? s : s * 0.42;
        const a = (Math.PI / 5) * i - Math.PI / 2;
        const x = Math.cos(a) * r, y = Math.sin(a) * r;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'sparkle': {
      ctx.lineWidth = Math.max(1, s * 0.18);
      ctx.lineCap = 'round';
      [0, 90].forEach(deg => {
        ctx.save();
        ctx.rotate((deg * Math.PI) / 180);
        ctx.beginPath();
        ctx.moveTo(0, -s); ctx.lineTo(0, s);
        ctx.stroke();
        ctx.restore();
      });
      ctx.beginPath();
      ctx.moveTo(-s * 0.55, -s * 0.55); ctx.lineTo(s * 0.55, s * 0.55);
      ctx.moveTo(s * 0.55, -s * 0.55); ctx.lineTo(-s * 0.55, s * 0.55);
      ctx.lineWidth = Math.max(1, s * 0.1);
      ctx.stroke();
      break;
    }
    case 'bow':
      [-1, 1].forEach(dir => {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(dir * s, -s * 0.7, dir * s * 1.1, 0);
        ctx.quadraticCurveTo(dir * s, s * 0.7, 0, 0);
        ctx.fill();
      });
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.22, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'snowflake': {
      ctx.lineWidth = Math.max(1, s * 0.16);
      ctx.lineCap = 'round';
      for (let i = 0; i < 3; i++) {
        ctx.save();
        ctx.rotate((Math.PI / 3) * i);
        ctx.beginPath();
        ctx.moveTo(0, -s); ctx.lineTo(0, s);
        ctx.moveTo(0, -s * 0.6); ctx.lineTo(-s * 0.28, -s * 0.85);
        ctx.moveTo(0, -s * 0.6); ctx.lineTo(s * 0.28, -s * 0.85);
        ctx.moveTo(0, s * 0.6); ctx.lineTo(-s * 0.28, s * 0.85);
        ctx.moveTo(0, s * 0.6); ctx.lineTo(s * 0.28, s * 0.85);
        ctx.stroke();
        ctx.restore();
      }
      break;
    }
    case 'balloon':
      ctx.beginPath();
      ctx.ellipse(0, -s * 0.15, s * 0.7, s * 0.85, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, s * 0.68); ctx.lineTo(0, s);
      ctx.lineWidth = Math.max(1, s * 0.08);
      ctx.stroke();
      break;
    default:
      break;
  }
  ctx.restore();
}

function findTemplate(id) {
  for (const cat of TEMPLATE_CATEGORIES) {
    const t = cat.templates.find(t => t.id === id);
    if (t) return t;
  }
  return TEMPLATE_CATEGORIES[0].templates[0];
}

// ============================================================
// CANVAS COMPOSITOR
// Renders the full photo strip from captured images + template
// + customization overrides. Used for both live preview and
// final high-res export.
// ============================================================

async function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {string[]} photoDataUrls - array of data URLs (composited HOST|PARTNER already, if long distance)
 * @param {object} template
 * @param {object} customization - { bgColor, frameColor, frameWidth, title, subtitle, showDate, orientation, spacing }
 * @param {number} scale - resolution multiplier (1 = preview, 3 = export)
 */
async function renderStrip(canvas, photoDataUrls, template, customization, scale = 1) {
  const cust = customization || {};
  const orientation = cust.orientation || 'vertical';
  const layout = cust.layout || 'strip'; // 'strip' | 'grid'
  const spacing = (cust.spacing ?? 10) * scale;
  const frameWidth = (cust.frameWidth ?? template.frameWidth ?? 14) * scale;
  const frameBottom = (template.frameBottom || 0) * scale;
  const bg = cust.bgColor || template.bg;
  const frameColor = cust.frameColor || template.frameColor || bg;
  const textColor = cust.textColor || template.textColor || '#1F2937';
  const accent = template.accent || textColor;
  const font = template.font || 'Nunito';

  const photoW = 260 * scale;
  const photoH = 195 * scale; // 4:3

  const filter = findFilter(cust.filter || 'none').css;
  const images = await Promise.all(photoDataUrls.map(src => loadImage(src)));
  const n = images.length || 1;

  // Compute each photo's (x, y) plus the overall strip size. 'grid' arranges
  // photos into a 2-column grid (falls back to a single column for n<2);
  // 'strip' keeps the classic single row/column photobooth strip.
  let stripW, stripH, positions;
  if (layout === 'grid' && n >= 2) {
    const cols = 2;
    const rows = Math.ceil(n / cols);
    stripW = frameWidth * 2 + photoW * cols + spacing * (cols - 1);
    stripH = frameWidth + (photoH * rows) + (spacing * Math.max(0, rows - 1)) + frameWidth + frameBottom + (60 * scale);
    positions = images.map((_, i) => ({
      x: frameWidth + (i % cols) * (photoW + spacing),
      y: frameWidth + Math.floor(i / cols) * (photoH + spacing),
    }));
  } else if (orientation === 'vertical') {
    stripW = photoW + frameWidth * 2;
    stripH = frameWidth + (photoH * n) + (spacing * Math.max(0, n - 1)) + frameWidth + frameBottom + (60 * scale);
    positions = images.map((_, i) => ({ x: frameWidth, y: frameWidth + i * (photoH + spacing) }));
  } else {
    stripW = frameWidth + (photoW * n) + (spacing * Math.max(0, n - 1)) + frameWidth;
    stripH = photoH + frameWidth * 2 + frameBottom + (60 * scale);
    positions = images.map((_, i) => ({ x: frameWidth + i * (photoW + spacing), y: frameWidth }));
  }

  canvas.width = stripW;
  canvas.height = stripH;
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, stripW, stripH);
  // Frame band
  ctx.fillStyle = frameColor;
  ctx.fillRect(0, 0, stripW, stripH);
  ctx.fillStyle = bg;
  const innerX = frameWidth, innerY = frameWidth;
  const innerW = stripW - frameWidth * 2;
  const innerH = stripH - frameWidth * 2 - frameBottom - (60 * scale);
  ctx.fillRect(innerX, innerY, innerW, innerH + (60 * scale) + frameBottom - frameWidth);

  // Photos
  images.forEach((img, i) => {
    const { x, y } = positions[i];
    ctx.save();
    ctx.filter = filter;
    drawCover(ctx, img, x, y, photoW, photoH);
    ctx.restore();
    if (template.filmHoles) drawFilmHoles(ctx, x, y, photoW, photoH, scale);
  });

  // Decorative stickers (deterministic corners, cheap + tasteful). A
  // user-picked sticker set (customization.stickers) overrides the
  // template's default set; both are vector-drawn, never emoji.
  const activeStickers = (cust.stickers && cust.stickers.length) ? cust.stickers : template.stickers;
  if (activeStickers && activeStickers.length) {
    const stickerSize = 26 * scale;
    const positions = orientation === 'vertical'
      ? [[frameWidth * 0.6, frameWidth * 0.6], [stripW - frameWidth * 0.6, innerY + innerH - (14*scale)]]
      : [[frameWidth * 0.6, frameWidth * 0.6], [stripW - frameWidth * 0.6, frameWidth * 0.6]];
    activeStickers.slice(0, 2).forEach((id, i) => {
      const [px, py] = positions[i % positions.length];
      drawSticker(ctx, id, px, py, stickerSize, accent);
    });
  }

  if (template.tape) {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.translate(stripW / 2, frameWidth * 0.4);
    ctx.rotate(-0.05);
    ctx.fillRect(-40 * scale, -10 * scale, 80 * scale, 20 * scale);
    ctx.restore();
  }

  if (template.confetti) drawConfetti(ctx, stripW, stripH, frameWidth, scale);

  // Text block (title / subtitle / date) at bottom
  const textBlockY = stripH - (60 * scale) - frameBottom + (10 * scale);
  ctx.textAlign = 'center';
  ctx.fillStyle = textColor;
  const title = (cust.title || '').trim();
  const subtitle = (cust.subtitle || '').trim();
  const showDate = cust.showDate !== false;
  let ty = textBlockY + (22 * scale);
  if (title) {
    ctx.font = `${20 * scale}px "${font}", sans-serif`;
    ctx.fillText(title, stripW / 2, ty);
    ty += 20 * scale;
  }
  const dateStr = showDate ? new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const sub = [subtitle, dateStr].filter(Boolean).join('  •  ');
  if (sub) {
    ctx.font = `${13 * scale}px "${font}", sans-serif`;
    ctx.fillStyle = accent;
    ctx.fillText(sub, stripW / 2, ty);
  }

  return canvas;
}

function drawCover(ctx, img, x, y, w, h, flip) {
  const ir = img.width / img.height;
  const tr = w / h;
  let sx, sy, sw, sh;
  if (ir > tr) {
    sh = img.height;
    sw = sh * tr;
    sx = (img.width - sw) / 2;
    sy = 0;
  } else {
    sw = img.width;
    sh = sw / tr;
    sx = 0;
    sy = (img.height - sh) / 2;
  }
  if (flip) {
    // Horizontally mirror just this tile, in place, without disturbing the
    // (x, y, w, h) box it's meant to land in — used so a long-distance
    // participant's own slice can match their mirrored self-preview
    // without touching the stored file or the other person's tile.
    ctx.save();
    ctx.translate(x + w, y);
    ctx.scale(-1, 1);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    ctx.restore();
  } else {
    ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  }
}

// Deterministic confetti dots scattered across the frame border (never the
// photos themselves), for the "Party" template. Fixed pattern (not random)
// so the live preview doesn't jitter every re-render.
const CONFETTI_SEED = [
  [0.08, 0.05], [0.22, 0.14], [0.4, 0.04], [0.62, 0.12], [0.8, 0.05], [0.93, 0.15],
  [0.1, 0.9], [0.28, 0.96], [0.5, 0.88], [0.7, 0.95], [0.88, 0.9], [0.95, 0.7],
  [0.04, 0.4], [0.04, 0.65], [0.96, 0.4], [0.96, 0.6],
];
const CONFETTI_COLORS = ['#FF7EB6', '#FFD166', '#2563EB', '#22C55E'];
function drawConfetti(ctx, stripW, stripH, frameWidth, scale) {
  ctx.save();
  CONFETTI_SEED.forEach(([fx, fy], i) => {
    const x = fx * stripW, y = fy * stripH;
    // Skip anything that would land over the inner photo area.
    if (x > frameWidth * 0.9 && x < stripW - frameWidth * 0.9 && y > frameWidth * 0.9 && y < stripH - frameWidth * 0.9) return;
    ctx.fillStyle = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(((i * 47) % 360) * Math.PI / 180);
    ctx.fillRect(-3 * scale, -2 * scale, 6 * scale, 4 * scale);
    ctx.restore();
  });
  ctx.restore();
}

function drawFilmHoles(ctx, x, y, w, h, scale) {
  const holeR = 4 * scale;
  const count = 6;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  for (let i = 0; i < count; i++) {
    const hy = y + (h / count) * (i + 0.5);
    ctx.beginPath();
    ctx.arc(x + 6 * scale, hy, holeR, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x + w - 6 * scale, hy, holeR, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Compose two camera captures (host + partner) side by side into one image
// for long-distance mode. flipHost/flipPartner mirror that person's own
// half — pass entry.images.host_mirrored / .partner_mirrored (set at
// capture time based on which camera each person was using) so the
// exported/strip image matches what each person actually saw in their own
// mirrored preview a moment before the shutter, not the raw unmirrored
// camera frame that's stored for everyone else's correctness.
async function composeSideBySide(hostDataUrl, partnerDataUrl, flipHost, flipPartner) {
  const [hostImg, partnerImg] = await Promise.all([loadImage(hostDataUrl), loadImage(partnerDataUrl)]);
  const tileW = 300, tileH = 400;
  const canvas = document.createElement('canvas');
  canvas.width = tileW * 2;
  canvas.height = tileH;
  const ctx = canvas.getContext('2d');
  drawCover(ctx, hostImg, 0, 0, tileW, tileH, flipHost);
  drawCover(ctx, partnerImg, tileW, 0, tileW, tileH, flipPartner);
  return canvas.toDataURL('image/jpeg', 0.9);
}

// Used for the rare fallback where only ONE side of a photo ever arrived by
// session end (see onSessionCompleteLD) — no second tile to compose against,
// but that lone image still needs the same "match their own mirrored
// preview" treatment if it was a mirrored capture.
async function maybeMirrorImage(dataUrl, flip) {
  if (!flip) return dataUrl;
  const img = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.92);
}
