// Génère les icônes de l'application (public/icons/*.png) sans aucune dépendance : npm run icons
// Dégradé violet -> rose avec une bulle de discussion blanche.
import fs from 'node:fs';
import zlib from 'node:zlib';

const A = [0x7c, 0x5c, 0xff];
const B = [0xff, 0x5f, 0xa2];
const mix = (t) => A.map((a, i) => a + (B[i] - a) * t);

// Distance signée à un rectangle aux coins arrondis (centre cx,cy ; demi-tailles hw,hh ; rayon r)
function sdRoundBox(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function inTriangle(px, py, [x1, y1], [x2, y2], [x3, y3]) {
  const d = (x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1);
  const a = ((x2 - px) * (y3 - py) - (x3 - px) * (y2 - py)) / d;
  const b = ((x3 - px) * (y1 - py) - (x1 - px) * (y3 - py)) / d;
  return a >= 0 && b >= 0 && a + b <= 1;
}

// scale < 1 : dessin plus petit (zone de sécurité des icônes « maskable »)
function colorAt(u, v, scale) {
  const x = 0.5 + (u - 0.5) / scale;
  const y = 0.5 + (v - 0.5) / scale;
  const bg = mix((u + v) / 2);
  const inBubble = sdRoundBox(x, y, 0.5, 0.46, 0.28, 0.18, 0.09) <= 0 || inTriangle(x, y, [0.34, 0.6], [0.32, 0.77], [0.5, 0.62]);
  if (!inBubble) return bg;
  for (const dx of [-0.1, 0, 0.1]) {
    if (Math.hypot(x - (0.5 + dx), y - 0.46) <= 0.034) return mix(0.35 + (dx + 0.1) * 1.6);
  }
  return [255, 255, 255];
}

function png(size, scale) {
  const SS = 3; // sur-échantillonnage 3x3 contre les escaliers
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = colorAt((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size, scale);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round(r / (SS * SS));
      raw[o + 1] = Math.round(g / (SS * SS));
      raw[o + 2] = Math.round(b / (SS * SS));
    }
  }
  const chunk = (type, data) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8 bits par canal
  ihdr[9] = 2; // RVB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync('public/icons', { recursive: true });
const files = {
  'icon-192.png': png(192, 1),
  'icon-512.png': png(512, 1),
  'icon-maskable-512.png': png(512, 0.78),
  'apple-touch-icon.png': png(180, 1),
};
for (const [name, buf] of Object.entries(files)) {
  fs.writeFileSync(`public/icons/${name}`, buf);
  console.log(`public/icons/${name} (${buf.length} octets)`);
}
