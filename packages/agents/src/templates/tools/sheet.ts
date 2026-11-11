import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { TEMPLATE_LIBRARY } from '../library';
import { PREVIEW_PALETTE, previewSizeFor, renderTemplatePreview } from '../preview';
import { FORMAT_CLASSES, validateTemplate, type FormatClass, type StyleId, type TemplateDef } from '../schema';
import { xmlEscape } from '../text-fit';

/**
 * Developer tool: writes PNG CONTACT SHEETS of template previews so authors can LOOK at their work (open the PNGs, or view them with
 * a tool that displays images).
 *
 *   node --import tsx src/templates/tools/sheet.ts <outDir> [--class square|portrait|story|landscape|banner]
 *        [--palette #hex,#hex,#hex] [--style <styleId>] [--full] [--no-image] [id ...]
 *
 * One sheet per class (several pages when there are many templates), every cell captioned with the template id and its render flags.
 * `--full` additionally writes each preview at full size as <id>-<class>.png. Without ids every template in the library is shown.
 * Previews use the template's own sample copy and a synthetic placeholder picture (never a real or generated image).
 */

const COLS: Record<FormatClass, number> = { square: 4, portrait: 4, story: 6, landscape: 3, banner: 2 };
const THUMB_W: Record<FormatClass, number> = { square: 300, portrait: 260, story: 180, landscape: 400, banner: 600 };
const CAPTION_H = 44;
const GAP = 16;
const ROWS_PER_PAGE = 3;

interface Args {
  outDir: string;
  classes: FormatClass[] | null;
  palette: string[];
  styleId?: StyleId;
  full: boolean;
  withImage: boolean;
  ids: string[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = { outDir: '', classes: null, palette: PREVIEW_PALETTE, full: false, withImage: true, ids: [] };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const v = rest[i];
    if (v === '--class') a.classes = [...(a.classes ?? []), rest[++i] as FormatClass];
    else if (v === '--palette') a.palette = (rest[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (v === '--style') a.styleId = rest[++i] as StyleId;
    else if (v === '--full') a.full = true;
    else if (v === '--no-image') a.withImage = false;
    else if (!a.outDir) a.outDir = v;
    else a.ids.push(v);
  }
  return a;
}

const tag = (palette: string[]) => (palette === PREVIEW_PALETTE ? 'default' : palette.map((p) => p.replace('#', '')).join('-'));

async function main() {
  const args = parseArgs(process.argv);
  if (!args.outDir) {
    console.error('usage: sheet.ts <outDir> [--class <class>] [--palette #hex,#hex,#hex] [--style <id>] [--full] [--no-image] [id ...]');
    process.exit(2);
  }
  for (const c of args.classes ?? []) if (!(FORMAT_CLASSES as readonly string[]).includes(c)) throw new Error(`unknown class "${c}" (${FORMAT_CLASSES.join(', ')})`);
  mkdirSync(args.outDir, { recursive: true });

  const all: readonly TemplateDef[] = TEMPLATE_LIBRARY;
  const chosen = args.ids.length ? all.filter((t) => args.ids.includes(t.id)) : all;
  for (const id of args.ids) if (!all.some((t) => t.id === id)) console.error(`! no template with id "${id}"`);
  if (!chosen.length) {
    console.error('nothing to render: the library has no matching template');
    process.exit(1);
  }
  for (const t of chosen) {
    const v = validateTemplate(t);
    if (!v.ok) for (const i of v.issues) console.error(`! ${t.id}: ${i.message}`);
  }

  const classes = args.classes ?? FORMAT_CLASSES.filter((c) => chosen.some((t) => t.classes.includes(c)));
  for (const cls of classes) {
    const list = chosen.filter((t) => t.classes.includes(cls));
    if (!list.length) continue;
    const size = previewSizeFor(cls);
    const tw = THUMB_W[cls];
    const th = Math.round((tw * size.height) / size.width);
    const cols = COLS[cls];
    const perPage = cols * ROWS_PER_PAGE;
    for (let page = 0; page * perPage < list.length; page++) {
      const items = list.slice(page * perPage, (page + 1) * perPage);
      const rows = Math.ceil(items.length / cols);
      const sheetW = GAP + cols * (tw + GAP);
      const sheetH = GAP + rows * (th + CAPTION_H + GAP);
      const cells: sharp.OverlayOptions[] = [];
      let captions = '';
      for (let i = 0; i < items.length; i++) {
        const t = items[i];
        const x = GAP + (i % cols) * (tw + GAP);
        const y = GAP + Math.floor(i / cols) * (th + CAPTION_H + GAP);
        const t0 = Date.now();
        const r = await renderTemplatePreview({ template: t, class: cls, palette: args.palette, styleId: args.styleId, withImage: args.withImage });
        const ms = Date.now() - t0;
        let note = '';
        if (r.ok) {
          const thumb = await sharp(r.png).resize(tw, th, { fit: 'fill' }).png().toBuffer();
          cells.push({ input: thumb, left: x, top: y });
          const flags = r.flags.filter((f) => f !== 'placeholder_image');
          note = flags.length ? flags.join(' ') : 'ok';
          if (args.full) writeFileSync(join(args.outDir, `${t.id}-${cls}.png`), r.png);
          console.log(`${cls.padEnd(9)} ${t.id.padEnd(34)} ${String(ms).padStart(4)} ms  ${note}`);
        } else {
          note = `${r.reason}: ${r.message}`;
          console.log(`${cls.padEnd(9)} ${t.id.padEnd(34)} FAILED ${note}`);
        }
        const bad = !r.ok || r.flags.some((f) => /^(moved_into|low_contrast|text_trimmed|text_shrunk)/.test(f));
        const idSize = tw >= 250 ? 14 : 11;
        const maxNote = Math.round(tw / (idSize >= 14 ? 6 : 5.2));
        captions += `<text x="${x}" y="${y + th + 16}" font-family="Segoe UI, Arial, sans-serif" font-size="${idSize}" font-weight="700" fill="#111827">${xmlEscape(t.id)}</text>`;
        captions += `<text x="${x}" y="${y + th + 33}" font-family="Segoe UI, Arial, sans-serif" font-size="${idSize - 3}" fill="${bad ? '#b91c1c' : '#4b5563'}">${xmlEscape(note.length > maxNote ? note.slice(0, maxNote - 1) + '…' : note)}</text>`;
      }
      const bg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetW}" height="${sheetH}"><rect width="100%" height="100%" fill="#e5e7eb"/>${captions}</svg>`;
      const file = join(args.outDir, `sheet-${cls}-${tag(args.palette)}${list.length > perPage ? `-p${page + 1}` : ''}.png`);
      // captions first (they sit below the thumbnails), thumbnails on top
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
