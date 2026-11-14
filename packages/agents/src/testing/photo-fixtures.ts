import sharp from 'sharp';

/**
 * PHOTOGRAPH-LIKE TEST SCENES, drawn locally (no download, no real person, no rights question): shaded heads with hair, eyes, brows, a nose
 * shadow and a mouth over a neck and shoulders, on a lit backdrop, then a lighting condition and sensor noise. They are NOT real photographs:
 * passing on them shows the pipeline handles the geometry and the colour range, not that detection is accurate on real-world pictures.
 */

/** Skin tones from very light to deep (approximate sRGB of lit skin). */
export const SKIN_TONES = {
  very_light: '#f3d9c6',
  light: '#e6b894',
  medium: '#c68e60',
  olive: '#a9764d',
  brown: '#8d5a34',
  dark: '#5e3a22',
  deep: '#3f2618',
} as const;
export type SkinTone = keyof typeof SKIN_TONES;

export type Lighting = 'neutral' | 'warm' | 'cool' | 'dim' | 'bright';
const LIGHT: Record<Lighting, { mul: [number, number, number]; gain: number }> = {
  neutral: { mul: [1, 1, 1], gain: 1 },
  warm: { mul: [1.12, 0.98, 0.74], gain: 1 },
  cool: { mul: [0.86, 0.97, 1.16], gain: 1 },
  dim: { mul: [1, 1, 1], gain: 0.62 },
  bright: { mul: [1, 1, 1], gain: 1.22 },
};

export interface Person {
  /** centre of the face, fractions of the picture */
  x: number;
  y: number;
  /** face height as a fraction of the picture height */
  size: number;
  tone: SkinTone;
}

export interface SceneOptions {
  width: number;
  height: number;
  people: Person[];
  lighting?: Lighting;
  /** backdrop: a calm studio wall, a busy office (shelves, windows) or an even paper background */
  backdrop?: 'studio' | 'office' | 'paper';
  seed?: number;
}

const shade = (hex: string, k: number) => {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(v * k))));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};

function personSvg(p: Person, W: number, H: number, i: number): string {
  const fh = p.size * H;
  const fw = fh * 0.74;
  const cx = p.x * W;
  const cy = p.y * H;
  const skin = SKIN_TONES[p.tone];
  const hair = ['#1c1410', '#3b2a1e', '#6b4a2b', '#2a2a2a'][i % 4];
  const shirt = ['#2c3e66', '#e8e8e8', '#4a4f57', '#8fb0d8'][i % 4];
  const g = `g${i}`;
  return [
    `<defs><radialGradient id="${g}" cx="0.45" cy="0.4" r="0.65"><stop offset="0" stop-color="${shade(skin, 1.08)}"/><stop offset="0.75" stop-color="${skin}"/><stop offset="1" stop-color="${shade(skin, 0.78)}"/></radialGradient></defs>`,
    // shoulders and neck
    `<path d="M ${cx - fw * 1.5} ${cy + fh * 3.4} Q ${cx - fw * 1.45} ${cy + fh * 1.05} ${cx} ${cy + fh * 1.0} Q ${cx + fw * 1.45} ${cy + fh * 1.05} ${cx + fw * 1.5} ${cy + fh * 3.4} Z" fill="${shirt}"/>`,
    `<rect x="${cx - fw * 0.22}" y="${cy + fh * 0.35}" width="${fw * 0.44}" height="${fh * 0.7}" fill="${shade(skin, 0.86)}"/>`,
    // hair behind, face, hair on top
    `<ellipse cx="${cx}" cy="${cy - fh * 0.08}" rx="${fw * 0.58}" ry="${fh * 0.6}" fill="${hair}"/>`,
    `<ellipse cx="${cx}" cy="${cy}" rx="${fw / 2}" ry="${fh / 2}" fill="url(#${g})"/>`,
    `<path d="M ${cx - fw * 0.52} ${cy - fh * 0.12} Q ${cx} ${cy - fh * 0.75} ${cx + fw * 0.52} ${cy - fh * 0.12} Q ${cx} ${cy - fh * 0.42} ${cx - fw * 0.52} ${cy - fh * 0.12} Z" fill="${hair}"/>`,
    // brows, eyes, nose shadow, mouth
    `<rect x="${cx - fw * 0.33}" y="${cy - fh * 0.15}" width="${fw * 0.22}" height="${fh * 0.035}" rx="2" fill="${shade(hair, 1.1)}"/>`,
    `<rect x="${cx + fw * 0.11}" y="${cy - fh * 0.15}" width="${fw * 0.22}" height="${fh * 0.035}" rx="2" fill="${shade(hair, 1.1)}"/>`,
    `<ellipse cx="${cx - fw * 0.2}" cy="${cy - fh * 0.05}" rx="${fw * 0.085}" ry="${fh * 0.035}" fill="#f2efe8"/><circle cx="${cx - fw * 0.2}" cy="${cy - fh * 0.05}" r="${fh * 0.028}" fill="#2a1d14"/>`,
    `<ellipse cx="${cx + fw * 0.2}" cy="${cy - fh * 0.05}" rx="${fw * 0.085}" ry="${fh * 0.035}" fill="#f2efe8"/><circle cx="${cx + fw * 0.2}" cy="${cy - fh * 0.05}" r="${fh * 0.028}" fill="#2a1d14"/>`,
    `<path d="M ${cx} ${cy - fh * 0.02} L ${cx - fw * 0.07} ${cy + fh * 0.14} L ${cx + fw * 0.05} ${cy + fh * 0.15}" fill="none" stroke="${shade(skin, 0.7)}" stroke-width="${Math.max(1, fh * 0.018)}"/>`,
    `<path d="M ${cx - fw * 0.17} ${cy + fh * 0.26} Q ${cx} ${cy + fh * 0.33} ${cx + fw * 0.17} ${cy + fh * 0.26}" fill="none" stroke="${shade(skin, 0.55)}" stroke-width="${Math.max(1.5, fh * 0.03)}" stroke-linecap="round"/>`,
  ].join('');
}

function backdropSvg(kind: NonNullable<SceneOptions['backdrop']>, W: number, H: number): string {
  if (kind === 'paper') return `<rect width="${W}" height="${H}" fill="#eceae4"/>`;
  if (kind === 'studio') return `<defs><radialGradient id="bg" cx="0.5" cy="0.35" r="0.8"><stop offset="0" stop-color="#2e4a74"/><stop offset="1" stop-color="#0f1d33"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#bg)"/>`;
  // a busy office: window panes, shelves with books, a plant
  const parts = [`<rect width="${W}" height="${H}" fill="#cfd4d6"/>`];
  for (let i = 0; i < 6; i++) parts.push(`<rect x="${W * (0.04 + i * 0.16)}" y="${H * 0.05}" width="${W * 0.13}" height="${H * 0.38}" fill="#e9f1f5" stroke="#7d8a90" stroke-width="${W * 0.006}"/>`);
  for (let r = 0; r < 3; r++) {
    parts.push(`<rect x="0" y="${H * (0.5 + r * 0.16)}" width="${W}" height="${H * 0.015}" fill="#5b4636"/>`);
    for (let b = 0; b < 40; b++) parts.push(`<rect x="${W * (b * 0.025 + 0.004)}" y="${H * (0.5 + r * 0.16 - 0.1)}" width="${W * 0.018}" height="${H * (0.06 + ((b * 7 + r * 3) % 5) * 0.008)}" fill="${['#8a3b2e', '#2f5d7c', '#d9b44a', '#3f6b3f', '#6d6d6d'][(b + r) % 5]}"/>`);
  }
  parts.push(`<ellipse cx="${W * 0.93}" cy="${H * 0.6}" rx="${W * 0.06}" ry="${H * 0.2}" fill="#3e7a3a"/>`);
  return parts.join('');
}

/** One photograph-like scene as a JPEG. */
export async function personScene(o: SceneOptions): Promise<Buffer> {
  const { width: W, height: H } = o;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${backdropSvg(o.backdrop ?? 'studio', W, H)}${o.people.map((p, i) => personSvg(p, W, H, i)).join('')}</svg>`;
  const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const L = LIGHT[o.lighting ?? 'neutral'];
  let seed = o.seed ?? 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 14;
  for (let i = 0; i < data.length; i += info.channels) {
    for (let c = 0; c < 3; c++) data[i + c] = Math.max(0, Math.min(255, Math.round(data[i + c] * L.mul[c] * L.gain + rnd())));
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).blur(0.6).jpeg({ quality: 90 }).toBuffer();
}

/** Skin-coloured surfaces WITHOUT a face (negative controls): a beige wall with a picture frame, and wood grain. */
export async function skinColouredSurfaces(W: number, H: number): Promise<{ wall: Buffer; wood: Buffer }> {
  const wall = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#d9b99b"/><rect x="${W * 0.3}" y="${H * 0.2}" width="${W * 0.4}" height="${H * 0.35}" fill="#e2c4a8" stroke="#6b5040" stroke-width="${W * 0.01}"/></svg>`;
  const stripes = Array.from({ length: 60 }, (_, i) => `<rect x="0" y="${(H / 60) * i}" width="${W}" height="${H / 120}" fill="${i % 3 ? '#a8754a' : '#b98556'}"/>`).join('');
  const wood = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#b07a4c"/>${stripes}</svg>`;
  const noisy = async (svg: string) => {
    const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let seed = 5;
    for (let i = 0; i < data.length; i++) data[i] = Math.max(0, Math.min(255, data[i] + (((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5) * 12));
    return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).jpeg({ quality: 90 }).toBuffer();
  };
  return { wall: await noisy(wall), wood: await noisy(wood) };
}

/** A flat brand graphic with an embedded wordmark (cropping it would cut the letters). */
export async function brandGraphic(W: number, H: number): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#12305a"/><polygon points="${W * 0.7},0 ${W},0 ${W},${H} ${W * 0.45},${H}" fill="#d3232a"/><rect x="${W * 0.08}" y="${H * 0.4}" width="${W * 0.6}" height="${H * 0.2}" fill="#ffffff"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** A product photograph (no people): a bottle-like object on a lit table, with noise; the product sits on the right. */
export async function productScene(W: number, H: number): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e6ebee"/><stop offset="1" stop-color="#b9c2c7"/></linearGradient><linearGradient id="p" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#1f5a76"/><stop offset="0.5" stop-color="#3b8db3"/><stop offset="1" stop-color="#174559"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#t)"/><rect x="0" y="${H * 0.72}" width="${W}" height="${H * 0.28}" fill="#8c7a66"/><rect x="${W * 0.62}" y="${H * 0.25}" width="${W * 0.2}" height="${H * 0.5}" rx="${W * 0.03}" fill="url(#p)"/><rect x="${W * 0.67}" y="${H * 0.16}" width="${W * 0.1}" height="${H * 0.1}" fill="#2a2a2a"/><rect x="${W * 0.64}" y="${H * 0.42}" width="${W * 0.16}" height="${H * 0.12}" fill="#f2c94c"/></svg>`;
  const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let seed = 3;
  for (let i = 0; i < data.length; i++) data[i] = Math.max(0, Math.min(255, data[i] + (((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5) * 16));
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).blur(0.6).jpeg({ quality: 90 }).toBuffer();
}
