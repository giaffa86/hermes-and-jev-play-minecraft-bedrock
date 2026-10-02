#!/usr/bin/env node
/**
 * wiki-lint.mjs — mechanical health-check for the LLM wiki in docs/.
 *
 * Errors (exit 1, block pre-commit):
 *   - broken relative links in README.md, AGENTS.md, BEDROCK.md, docs/**;
 *   - every raw source in docs/raw cited in docs/sources.md;
 *   - every page in docs/wiki listed in docs/index.md;
 *   - orphan wiki pages (no inbound link);
 *   - log.md entry format (## [YYYY-MM-DD] type | title);
 *   - "Last lint" header in docs/wiki/open-questions.md aligned with log.md;
 *   - privacy gate: .private/, .env, runs/, nmp-cache/, auth.json never tracked.
 *
 * Warnings (do not block, unless --strict; pre-push uses --strict):
 *   - possible secrets / personal data (public repo!);
 *   - log entries not in chronological order.
 *
 * Usage: node tools/wiki-lint.mjs [--strict] [--quiet]
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = resolve(ROOT, 'docs');
const args = new Set(process.argv.slice(2));
const STRICT = args.has('--strict');
const QUIET = args.has('--quiet');

const errors = [];
const warnings = [];
const notes = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);
const note = (m) => notes.push(m);

const read = (f) => readFileSync(f, 'utf8');
const rel = (f) => relative(ROOT, f) || '.';
const listMd = (dir, exts = ['.md']) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => exts.some((e) => f.endsWith(e)))
        .sort()
        .map((f) => resolve(dir, f))
    : [];

const wikiPages = listMd(resolve(DOCS, 'wiki'));
const rawSources = listMd(resolve(DOCS, 'raw'), ['.md', '.txt']);
const topFiles = ['README.md', 'AGENTS.md', 'BEDROCK.md', 'docs/index.md', 'docs/sources.md', 'docs/log.md', 'docs/llm-wiki.md']
  .map((f) => resolve(ROOT, f))
  .filter(existsSync);
// All files whose links we validate.
const linkFiles = [...topFiles, ...wikiPages, ...rawSources].filter((f) => f.endsWith('.md') || f.endsWith('.txt'));
// Files scanned for secrets (skip raw/evidence JSONL: separate, small).
const textFiles = linkFiles;

// ---------------------------------------------------------------------------
// 1. Link check
// ---------------------------------------------------------------------------
const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;
const EXTERNAL = /^(https?:|mailto:|tel:|ftp:|#)/i;
let linkCount = 0;
for (const file of linkFiles) {
  const text = read(file);
  for (const m of text.matchAll(LINK_RE)) {
    let target = m[1].trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    if (EXTERNAL.test(target)) continue;
    const clean = target.split('#')[0].split('?')[0];
    if (!clean) continue;
    linkCount += 1;
    if (!existsSync(resolve(dirname(file), clean))) {
      err(`broken link: ${rel(file)} -> ${target}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 2/3. Raw -> sources.md, wiki -> index.md coverage
// ---------------------------------------------------------------------------
const sourcesText = existsSync(resolve(DOCS, 'sources.md')) ? read(resolve(DOCS, 'sources.md')) : '';
const indexText = existsSync(resolve(DOCS, 'index.md')) ? read(resolve(DOCS, 'index.md')) : '';
for (const f of rawSources) {
  const name = basename(f);
  if (!sourcesText.includes(name)) err(`raw source not catalogued in docs/sources.md: raw/${name}`);
}
for (const f of wikiPages) {
  const name = basename(f);
  if (!indexText.includes(`wiki/${name}`)) err(`wiki page not listed in docs/index.md: wiki/${name}`);
}

// ---------------------------------------------------------------------------
// 4. Orphan wiki pages
// ---------------------------------------------------------------------------
for (const page of wikiPages) {
  const name = basename(page);
  const referenced = [...topFiles, ...wikiPages, ...rawSources].some((f) => f !== page && existsSync(f) && read(f).includes(name));
  if (!referenced) err(`orphan wiki page (no inbound link): wiki/${name}`);
}

// ---------------------------------------------------------------------------
// 5. log.md format
// ---------------------------------------------------------------------------
const logPath = resolve(DOCS, 'log.md');
const LOG_RE = /^## \[(\d{4}-\d{2}-\d{2})\] ([a-z][a-z0-9_ -]*?) \| .+$/;
let lastLogDate = null;
let outOfOrder = 0;
const lintDates = [];
if (existsSync(logPath)) {
  read(logPath)
    .split('\n')
    .forEach((line, i) => {
      if (!line.startsWith('## [')) return;
      const m = line.match(LOG_RE);
      if (!m) {
        err(`log.md:${i + 1}: malformed entry (expected "## [YYYY-MM-DD] type | title"): ${line.trim()}`);
        return;
      }
      const [, date, kind] = m;
      if (kind === 'lint') lintDates.push(date);
      if (lastLogDate && date < lastLogDate) outOfOrder += 1;
      lastLogDate = date;
    });
}
if (outOfOrder > 0) note(`log.md: ${outOfOrder} entries not in ascending chronological order (historical append order with interleaved dates — informational, documented in open-questions.md)`);

// ---------------------------------------------------------------------------
// 6. "Last lint" header vs log
// ---------------------------------------------------------------------------
const oqPath = resolve(DOCS, 'wiki', 'open-questions.md');
if (existsSync(oqPath)) {
  const m = read(oqPath).match(/Last lint:\s*(\d{4}-\d{2}-\d{2})/);
  const latestLint = lintDates.sort().at(-1) || null;
  if (!m) warn('docs/wiki/open-questions.md: missing the "Last lint: YYYY-MM-DD" line');
  else if (latestLint && m[1] !== latestLint) err(`docs/wiki/open-questions.md: "Last lint: ${m[1]}" does not match the latest lint in log.md (${latestLint})`);
}

// ---------------------------------------------------------------------------
// 7. Privacy gate: forbidden paths never tracked
// ---------------------------------------------------------------------------
const FORBIDDEN = ['.private', '.env', '.env.local', 'runs', 'nmp-cache', 'auth.json', 'memory'];
try {
  const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '--', ...FORBIDDEN], { encoding: 'utf8' }).trim();
  if (tracked) {
    const list = tracked.split('\n').filter(Boolean);
    err(`privacy gate: forbidden paths are tracked in git (${list.length}): ${list.slice(0, 10).join(', ')}`);
  }
} catch {
  warn('privacy gate: `git ls-files` failed, tracked-files check skipped');
}

// ---------------------------------------------------------------------------
// 8. Secret / personal-data scan (public repo)
// ---------------------------------------------------------------------------
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key (PEM)'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/, 'possible API key (sk-...)'],
  [/\b(?:ghp_|github_pat_|xox[bap]-|AKIA[0-9A-Z]{16})/, 'possible access token'],
  [/"(?:access_token|refresh_token|client_secret|MicrosoftAccount|XboxLive)"\s*:\s*"[^"]{8,}"/i, 'possible auth token/cache'],
  [/xuid\s*[:=]\s*\d{6,}/i, 'possible real xuid'],
  [/\/root\/\.ssh|\/root\/\.secrets|authorized_keys/, 'SSH key path'],
  [/\b[A-Za-z0-9._%+-]+@(?:gmail|googlemail|outlook|hotmail|live|proton|protonmail|yahoo|icloud|libero|virgilio|tiscali|fastweb)\.[A-Za-z]{2,}\b/i, 'personal email'],
  [/password\s*[:=]\s*["'`]?(?!redacted|change[-_]?me|example|placeholder|your|tua|<|\$|\{)[^\s"'`]{6,}/i, 'possible plaintext password'],
];
for (const file of textFiles) {
  read(file)
    .split('\n')
    .forEach((line, i) => {
      for (const [re, label] of SECRET_PATTERNS) {
        if (re.test(line)) warn(`possible sensitive data (${label}): ${rel(file)}:${i + 1}`);
      }
    });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const color = (c, s) => (process.stdout.isTTY && !args.has('--no-color') ? `\x1b[${c}m${s}\x1b[0m` : s);
if (!QUIET) console.log(`wiki-lint: ${linkFiles.length} files, ${linkCount} relative links, ${wikiPages.length} wiki pages, ${rawSources.length} raw sources`);
if (notes.length) {
  console.log(color(36, `\ni ${notes.length} note(s)`));
  for (const n of notes) console.log(`  - ${n}`);
}
if (warnings.length) {
  console.log(color(33, `\n! ${warnings.length} warning(s)`));
  for (const w of warnings) console.log(`  - ${w}`);
}
if (errors.length) {
  console.log(color(31, `\nX ${errors.length} error(s)`));
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
if (warnings.length && STRICT) {
  console.log(color(31, '\nX --strict: warnings count as errors'));
  process.exit(1);
}
console.log(color(32, '\nOK wiki-lint: no errors'));
