// Builds preview/ — a review copy that runs on an in-browser stand-in database.
import { readFileSync, writeFileSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'preview');
rmSync(out, { recursive: true, force: true }); mkdirSync(out);
cpSync(join(root, 'assets'), join(out, 'assets'), { recursive: true });

const flag = '<script>window.KAIF_PREVIEW=true</script>';
const badge = (href, label) => `<a href="${href}" style="position:fixed;z-index:60;bottom:calc(14px + env(safe-area-inset-bottom,0px));left:calc(14px + env(safe-area-inset-left,0px));font:500 12px/1 'Plex Arabic',system-ui,sans-serif;background:#16110D;color:#F5EEE3;padding:9px 14px;border-radius:99px;text-decoration:none;box-shadow:0 8px 24px rgba(0,0,0,.25)">معاينة · ${label}</a>`;

// index → page content for the artifact skeleton (no doctype/html/head/body)
let idx = readFileSync(join(root, 'index.html'), 'utf8');
const head = idx.match(/<head>([\s\S]*?)<\/head>/)[1]
  .replace(/<meta charset[^>]*>\s*/, '').replace(/<meta name="viewport"[^>]*>\s*/, '')
  .replace('<title>كايف</title>', '<title>دعوة كايف للفطور</title>');
const body = idx.match(/<body[^>]*>([\s\S]*?)<\/body>/)[1]
  .replace('<script src="assets/js/config.js"></script>', flag + '\n<script src="assets/js/config.js"></script>');
writeFileSync(join(out, 'index.html'),
  head + `<script>document.documentElement.lang='ar';document.documentElement.dir='rtl';document.body&&document.body.classList.add('is-loading')</script>\n` +
  body + badge('admin.html', 'لوحة التحكم') + '\n');

// admin → its own full document
let adm = readFileSync(join(root, 'admin.html'), 'utf8')
  .replace('<script src="assets/js/config.js"></script>', flag + '\n<script src="assets/js/config.js"></script>')
  .replace('</body>', badge('index.html', 'صفحة الدعوة') + '\n</body>');
writeFileSync(join(out, 'admin.html'), adm);
console.log('preview/ built');
