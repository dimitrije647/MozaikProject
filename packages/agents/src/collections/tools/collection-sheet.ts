import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { renderTemplatePreview, previewSizeFor } from '../../templates/preview';
import { FORMAT_CLASSES, type FormatClass } from '../../templates/schema';
import { xmlEscape } from '../../templates/text-fit';
import { designAnchors, designBrandColors } from '../design';
import { TEMPLATE_LIBRARY } from '../../templates/library';
import { applyCollection } from '../theme';
import { getCollection, listCollections, themedTemplates } from '../registry';
import type { DesignPalette } from '../schema';

/**
 * Developer tool: PNG contact sheets of a collection drawn by the REAL renderer with the collection's tokens and a palette.
 *
 *   node --import tsx src/collections/tools/collection-sheet.ts <outDir> [--collection id] [--class square|portrait|story|landscape|banner]
 *        [--palette primary,secondary,accent,background,text] [--no-image] [--ids templateId,templateId] [--tag name]
 *
 * One sheet per collection and class; every cell is captioned with the template id and its render flags (red = something to fix).
 * Without --collection every collection is rendered. Without --class: square, story and banner.
 */

const THUMB: Record<FormatClass, number> = { square: 300, portrait: 260, story: 170, landscape: 360, banner: 560 };
const COLS: Record<FormatClass, number> = { square: 4, portrait: 4, story: 6, landscape: 3, banner: 2 };
const GAP = 14;
const CAP = 40;

async function main() {
  const rest = process.argv.slice(2);
  const o: { outDir: string; collection?: string; classes: FormatClass[]; palette?: string[]; withImage: boolean; ids?: string[]; tag?: string } = { outDir: '', classes: [], withImage: true };
  for (let i = 0; i < rest.length; i++) {
    const v = rest[i];
    if (v === '--collection') o.collection = rest[++i];
    else if (v === '--class') o.classes.push(rest[++i] as FormatClass);
    else if (v === '--palette') o.palette = (rest[++i] ?? '').split(',');
    else if (v === '--no-image') o.withImage = false;
    else if (v === '--ids') o.ids = (rest[++i] ?? '').split(',').filter(Boolean);
    else if (v === '--tag') o.tag = rest[++i];
    else if (!o.outDir) o.outDir = v;
  }
  if (!o.outDir) throw new Error('usage: collection-sheet.ts <outDir> [--collection id] [--class c] [--palette p,s,a,bg,text] [--no-image]');
  mkdirSync(o.outDir, { recursive: true });
  const classes = o.classes.length ? o.classes : (['square', 'story', 'banner'] as FormatClass[]);
  for (const c of classes) if (!(FORMAT_CLASSES as readonly string[]).includes(c)) throw new Error(`unknown class ${c}`);
  const list = o.collection ? [getCollection(o.collection)].filter((c): c is NonNullable<typeof c> => !!c) : listCollections();
  for (const col of list) {
    const p: DesignPalette = o.palette && o.palette.length === 5 ? { primary: o.palette[0], secondary: o.palette[1], accent: o.palette[2], background: o.palette[3], text: o.palette[4] } : col.defaultPalette;
    const anchors = designAnchors(p);
    // --ids renders ANY library templates with this collection's tokens (to try a new template before it is listed in the collection)
    const templates = o.ids ? TEMPLATE_LIBRARY.filter((t) => o.ids!.includes(t.id)).map((t) => applyCollection(t, col)) : themedTemplates(col);
    for (const cls of classes) {
      const items = templates.filter((t) => t.classes.includes(cls));
      if (!items.length) continue;
      const size = previewSizeFor(cls);
      const tw = THUMB[cls];
      const th = Math.round((tw * size.height) / size.width);
      const cols = Math.min(COLS[cls], items.length);
      const rows = Math.ceil(items.length / cols);
      const W = GAP + cols * (tw + GAP);
      const H = GAP + rows * (th + CAP + GAP);
      const cells: sharp.OverlayOptions[] = [];
      let captions = '';
      for (let i = 0; i < items.length; i++) {
        const t = items[i];
        const x = GAP + (i % cols) * (tw + GAP);
        const y = GAP + Math.floor(i / cols) * (th + CAP + GAP);
        const r = await renderTemplatePreview({ template: t, class: cls, palette: designBrandColors(p), anchors: { ink: anchors.ink, paper: anchors.paper }, withImage: o.withImage });
        let note: string;
        let bad = false;
        if (r.ok) {
          cells.push({ input: await sharp(r.png).resize(tw, th, { fit: 'fill' }).png().toBuffer(), left: x, top: y });
          const flags = r.flags.filter((f) => f !== 'placeholder_image');
          note = flags.length ? flags.join(' ') : 'ok';
          bad = flags.some((f) => /^(moved_into|low_contrast|text_trimmed|text_shrunk|text_hyph)/.test(f));
        } else {
          note = `${r.reason}: ${r.message}`;
          bad = true;
        }
        console.log(`${col.id.padEnd(22)} ${cls.padEnd(9)} ${t.id.padEnd(32)} ${note}`);
        const max = Math.round(tw / 5.4);
        captions += `<text x="${x}" y="${y + th + 15}" font-family="Segoe UI, Arial, sans-serif" font-size="13" font-weight="700" fill="#111827">${xmlEscape(t.id)}</text>`;
        captions += `<text x="${x}" y="${y + th + 31}" font-family="Segoe UI, Arial, sans-serif" font-size="10" fill="${bad ? '#b91c1c' : '#4b5563'}">${xmlEscape(note.length > max ? note.slice(0, max - 1) + '…' : note)}</text>`;
      }
      const bg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#d1d5db"/>${captions}</svg>`;
      const file = join(o.outDir, `${col.id}-${cls}${o.tag ? `-${o.tag}` : ''}.png`);
      await sharp(Buffer.from(bg)).composite(cells).png().toFile(file);
      console.log(`wrote ${file}`);
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
