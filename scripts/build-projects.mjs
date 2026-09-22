#!/usr/bin/env node
/**
 * build-projects.mjs
 *
 * Reads the Obsidian vault and emits src/data/projects.json, which is the
 * single source of truth the site renders from.
 *
 *   node scripts/build-projects.mjs
 *   node scripts/build-projects.mjs --vault "C:/Users/nickd/Obsidian/Sovrin"
 *
 * Zero dependencies — frontmatter and markdown are parsed by hand so this
 * never breaks on an npm update.
 *
 * Rules it enforces:
 *   - `public: false` notes are skipped entirely
 *   - everything under a "## Private notes" heading is stripped
 *   - a note with no orbit, or an orbit not in _ORBITS.md, is reported and skipped
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync,
         copyFileSync, statSync, rmSync } from 'fs';
import { join, dirname, resolve, extname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── args ──
const argv = process.argv.slice(2);
const vaultArg = argv.indexOf('--vault');
const VAULT = vaultArg !== -1
  ? resolve(argv[vaultArg + 1])
  : join(ROOT, 'vault');

const OUT = join(ROOT, 'src', 'data', 'projects.json');
const MEDIA_OUT = join(ROOT, 'public', 'project-media');
const PRIVATE_HEADING = /^##\s+private notes\s*$/i;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.svg']);
const BIG_FILE_KB = 600;    // warn above this — git keeps every version forever

// ── Index every image in the vault so wikilinks resolve wherever they live ──
// Obsidian stores attachments in a configurable folder, so rather than
// assume a path we just walk the vault once and index by filename.
let imageIndex = null;
function buildImageIndex(dir, depth = 0) {
  if (depth === 0) imageIndex = new Map();
  if (depth > 6) return imageIndex;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) buildImageIndex(full, depth + 1);
    else if (IMAGE_EXT.has(extname(entry.name).toLowerCase())) {
      if (!imageIndex.has(entry.name)) imageIndex.set(entry.name, full);
    }
  }
  return imageIndex;
}

const mediaWarnings = [];
let copiedCount = 0;

// Copy one image into public/project-media/<slug>/ and return its web path.
function adoptImage(name, slug) {
  const clean = String(name).replace(/^!\[\[|\]\]$/g, '').split('|')[0].trim();
  const src = imageIndex.get(clean) || imageIndex.get(basename(clean));
  if (!src) { mediaWarnings.push(`${slug}: image "${clean}" not found in vault`); return null; }

  const kb = Math.round(statSync(src).size / 1024);
  if (kb > BIG_FILE_KB) {
    mediaWarnings.push(`${slug}: ${basename(src)} is ${kb}KB — consider resizing before committing`);
  }

  const destDir = join(MEDIA_OUT, slug);
  mkdirSync(destDir, { recursive: true });
  const safe = basename(src).replace(/\s+/g, '-').toLowerCase();
  copyFileSync(src, join(destDir, safe));
  copiedCount++;
  return `/project-media/${slug}/${safe}`;
}

// Pull image embeds out of the body, in document order, with captions.
//
// Caption convention: a short line of text immediately above an embed is
// treated as that image's caption. This matches how you'd naturally write
// it in Obsidian:
//
//     initializing scan
//     ![[Pasted image 20260909032030.png]]
//
// A caption line with no image under it is reported as a warning rather
// than silently dropped, since it usually means a screenshot is missing.
function extractEmbeds(body, slug) {
  const lines = body.split(/\r?\n/);
  const out = [];
  let pendingCaption = null;
  let orphanCaptions = [];

  const isEmbed = l => /^\s*!\[\[[^\]]+?\]\]\s*$/.test(l) || /^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(l);
  const nameOf = l => {
    const w = l.match(/!\[\[([^\]]+?)\]\]/);
    if (w) return w[1].split('|')[0].trim();
    const m = l.match(/!\[[^\]]*\]\(([^)]+)\)/);
    return m ? m[1].trim() : null;
  };

  for (const line of lines) {
    const t = line.trim();

    if (isEmbed(line)) {
      const name = nameOf(line);
      if (name && IMAGE_EXT.has(extname(name).toLowerCase())) {
        out.push({ name, caption: pendingCaption });
        pendingCaption = null;
        continue;
      }
    }

    if (!t || /^#{1,6}\s/.test(t) || /^[-*]\s/.test(t)) {
      if (pendingCaption) orphanCaptions.push(pendingCaption);
      pendingCaption = null;
      continue;
    }

    // short standalone line → candidate caption for the embed below it
    if (t.length <= 90) {
      if (pendingCaption) orphanCaptions.push(pendingCaption);
      pendingCaption = t;
    } else {
      pendingCaption = null;
    }
  }
  if (pendingCaption) orphanCaptions.push(pendingCaption);

  // Only meaningful in notes that actually contain screenshots — otherwise
  // every ordinary sentence looks like an orphaned caption.
  if (out.length && orphanCaptions.length && slug) {
    const likely = orphanCaptions.filter(c => c.length <= 60 && !/[.!?]$/.test(c));
    if (likely.length) {
      mediaWarnings.push(`${slug}: caption(s) with no image beneath them — ${likely.map(c => `"${c}"`).join(', ')}`);
    }
  }
  return out;
}

// ── tiny YAML frontmatter parser ──
// Handles: strings, numbers, booleans, null/empty, and [inline, arrays].
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: raw };

  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;

    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();

    // strip trailing inline comment (but not inside quotes or urls)
    if (!/^["'\[]/.test(val)) {
      const c = val.indexOf(' #');
      if (c !== -1) val = val.slice(0, c).trim();
    }

    if (val === '') { data[key] = null; continue; }
    if (val === 'true')  { data[key] = true;  continue; }
    if (val === 'false') { data[key] = false; continue; }
    if (val === 'null')  { data[key] = null;  continue; }

    if (val.startsWith('[') && val.endsWith(']')) {
      const inner = val.slice(1, -1).trim();
      data[key] = inner
        ? inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
        : [];
      continue;
    }

    val = val.replace(/^["']|["']$/g, '');
    data[key] = /^-?\d+(\.\d+)?$/.test(val) ? Number(val) : val;
  }
  return { data, body: m[2] };
}

// ── markdown body → sections ──
function parseSections(body) {
  const lines = body.split(/\r?\n/);
  const sections = [];
  let current = null;

  for (const line of lines) {
    if (PRIVATE_HEADING.test(line)) break;      // stop at private notes

    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      if (current) sections.push(current);
      current = { heading: h[1], lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push(current);

  return sections.map(s => {
    const checklist = [];
    const prose = [];

    const isEmbedLine = l => /!\[\[[^\]]+?\]\]/.test(l) || /!\[[^\]]*\]\([^)]+\)/.test(l);
    // A short line directly above an embed is that image's caption — it
    // belongs to the gallery, not the prose.
    const captionIdx = new Set();
    s.lines.forEach((l, i) => {
      if (!isEmbedLine(l)) return;
      for (let k = i - 1; k >= 0; k--) {
        const prev = s.lines[k].trim();
        if (!prev) continue;
        if (isEmbedLine(s.lines[k])) break;
        if (prev.length <= 90 && !/^#{1,6}\s/.test(prev) && !/^[-*]\s/.test(prev)) captionIdx.add(k);
        break;
      }
    });

    for (let li = 0; li < s.lines.length; li++) {
      const line = s.lines[li];
      if (captionIdx.has(li)) continue;
      const box = line.match(/^\s*-\s+\[([ xX])\]\s+(.*)$/);
      if (box) { checklist.push({ done: box[1].toLowerCase() === 'x', text: box[2].trim() }); }
      else {
        // drop image embeds from prose — they're collected into the gallery
        const cleaned = line.replace(/!\[\[[^\]]+?\]\]/g, '').replace(/!\[[^\]]*\]\([^)]+\)/g, '').trim();
        if (cleaned) prose.push(cleaned);
      }
    }

    const out = { heading: s.heading };
    if (prose.length) out.body = prose.join(' ');
    if (checklist.length) out.checklist = checklist;
    return out;
  }).filter(s => s.body || s.checklist);
}

// ── orbit config from _ORBITS.md ──
function loadOrbits() {
  const p = join(VAULT, '_ORBITS.md');
  if (!existsSync(p)) throw new Error(`Missing orbit config: ${p}`);

  const rows = readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .filter(l => /^\|/.test(l) && !/^\|\s*-+/.test(l))
    .map(l => l.split('|').slice(1, -1).map(c => c.trim()));

  if (!rows.length) throw new Error('No table rows found in _ORBITS.md');

  const header = rows.shift().map(h => h.toLowerCase());
  const col = n => header.indexOf(n);

  return rows
    .filter(r => r[col('orbit')] && /^\d+$/.test(r[col('orbit')]))
    .map(r => ({
      id: Number(r[col('orbit')]),
      name: r[col('name')],
      short: r[col('short')],
      blurb: r[col('blurb')],
      color: r[col('color')],
      radius: Number(r[col('radius')]),
      projects: [],
    }));
}

// ── main ──
function build() {
  const orbits = loadOrbits();
  const byId = new Map(orbits.map(o => [o.id, o]));

  // Index vault images, and clear previously-copied media so deleted
  // images don't linger in the repo forever.
  buildImageIndex(VAULT);
  if (existsSync(MEDIA_OUT)) rmSync(MEDIA_OUT, { recursive: true, force: true });

  const dir = join(VAULT, 'projects');
  if (!existsSync(dir)) throw new Error(`Missing projects folder: ${dir}`);

  const files = readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('_'));
  const warnings = [];
  let skipped = 0;

  for (const file of files) {
    const raw = readFileSync(join(dir, file), 'utf8');
    const { data, body } = parseFrontmatter(raw);

    if (data.public === false) { skipped++; continue; }

    if (!data.title) { warnings.push(`${file}: no title, skipped`); continue; }

    const orbit = byId.get(Number(data.orbit));
    if (!orbit) { warnings.push(`${file}: orbit "${data.orbit}" not in _ORBITS.md, skipped`); continue; }

    const slug = data.slug || file.replace(/\.md$/, '');

    // Public body only — anything under "## Private notes" is already cut,
    // so private screenshots stay private.
    const publicBody = body.split(/^##\s+private notes\s*$/im)[0];

    // hero image: explicit `image:` frontmatter, else the first embed found
    const embeds = extractEmbeds(publicBody, slug);
    const heroName = data.image || (embeds[0] && embeds[0].name) || null;
    const hero = heroName ? adoptImage(heroName, slug) : null;
    const heroEmbed = embeds.find(e => e.name === heroName);
    const heroCaption = heroEmbed ? heroEmbed.caption : null;

    // gallery: explicit `gallery:` entries first, then body embeds in order
    const fromFrontmatter = (Array.isArray(data.gallery) ? data.gallery : [])
      .map(n => ({ name: n, caption: null }));
    const seen = new Set(heroName ? [heroName] : []);
    const gallery = [...fromFrontmatter, ...embeds]
      .filter(e => { if (seen.has(e.name)) return false; seen.add(e.name); return true; })
      .map(e => { const src = adoptImage(e.name, slug); return src ? { src, caption: e.caption || null } : null; })
      .filter(Boolean);

    orbit.projects.push({
      slug,
      title: data.title,
      image: hero,
      imageCaption: heroCaption,
      gallery,
      type: data.type || null,
      status: data.status || 'in-progress',
      size: data.size ?? 7,
      featured: data.featured === true,
      tagline: data.tagline || null,
      tags: data.tags || [],
      url: data.url || null,
      repo: data.repo || null,
      stat: data.stat || null,
      statLabel: data.stat_label || null,
      sections: parseSections(body),
    });
  }

  // featured first, then alphabetical — stable output so git diffs stay small
  orbits.forEach(o => o.projects.sort((a, b) =>
    (b.featured - a.featured) || a.title.localeCompare(b.title)
  ));

  const payload = {
    _comment: 'GENERATED FILE — do not edit by hand. Run `npm run build:projects` to regenerate from the Obsidian vault.',
    generated: new Date().toISOString(),
    orbits,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  // ── report ──
  const total = orbits.reduce((n, o) => n + o.projects.length, 0);
  console.log(`\n  vault:  ${VAULT}`);
  console.log(`  output: ${OUT}\n`);
  orbits.forEach(o => {
    console.log(`  0${o.id} ${o.name.padEnd(20)} ${String(o.projects.length).padStart(2)} project(s)`);
  });
  console.log(`\n  ${total} published, ${skipped} kept private`);
  console.log(`  ${copiedCount} image(s) copied to public/project-media/\n`);
  warnings.push(...mediaWarnings);
  if (warnings.length) {
    console.log('  warnings:');
    warnings.forEach(w => console.log(`    ! ${w}`));
    console.log('');
  }
}

try {
  build();
} catch (err) {
  console.error(`\n  build failed: ${err.message}\n`);
  process.exit(1);
}
