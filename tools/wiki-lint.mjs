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
// Files scanned for secrets / private refs / fingerprints: every tracked text
// file (the linter itself is excluded so its own pattern list does not self-match).
const SELF_REL = relative(ROOT, fileURLToPath(import.meta.url));
const TEXT_EXT = /\.(md|txt|mjs|js|cjs|json|jsonl|ya?ml|sh|toml|ini|conf|properties|env)$/i;
let trackedFiles = [];
try {
  trackedFiles = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
} catch {
  trackedFiles = [];
}
const textFiles = (trackedFiles.length ? trackedFiles : linkFiles.map(rel))
  .filter((f) => f !== SELF_REL && f !== 'package-lock.json')
  .filter((f) => TEXT_EXT.test(f) || f === '.gitignore' || f === 'Dockerfile' || f === '.env.example')
  .map((f) => resolve(ROOT, f))
  .filter(existsSync)
  .sort();

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
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key (PEM/OpenSSH)'],
  [/\bssh-(?:rsa|ed25519|dss) [A-Za-z0-9+/]{40,}/, 'SSH public key material'],
  [/\/\\.ssh\/|authorized_keys|\bid_(?:rsa|ed25519)\b/, 'SSH key path/file'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/, 'possible API key (sk-...)'],
  [/\bts-[A-Za-z0-9]{16,}\b/, 'possible TypeSafe API key (ts-...)'],
  [/\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{20,}\b/, 'possible GitHub token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'possible Slack token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'possible AWS access key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'possible Google API key'],
  [/\bBearer\s+[A-Za-z0-9._-]{20,}/, 'possible bearer token'],
  [/\b(?:api[_-]?key|access[_-]?key|secret[_-]?key|auth[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}/i, 'possible hardcoded key/token'],
  [/"(?:access_token|refresh_token|client_secret|MicrosoftAccount|XboxLive)"\s*:\s*"[^"]{8,}"/i, 'possible auth token/cache'],
  [/xuid\s*[:=]\s*\d{6,}/i, 'possible real xuid'],
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
// 8b. Private-content gate: never reference the private Proxmox wiki / host repo.
// ---------------------------------------------------------------------------
const PRIVATE_REF = [
  [/\/root\/docs\b/, 'link to the private Proxmox wiki (/root/docs)'],
  [/giaffalab-wiki/, 'reference to the private wiki repository'],
  [/machine-docs/, 'reference to the private wiki clone path'],
  [/\/root\/CLAUDE\.md|\/root\/AGENTS\.md/, 'reference to the host agent schema'],
  [/hermes-proxmox-bootstrap|hermes-stack/, 'reference to the private bootstrap/stack repo'],
];
for (const file of textFiles) {
  read(file)
    .split('\n')
    .forEach((line, i) => {
      for (const [re, label] of PRIVATE_REF) {
        if (re.test(line)) err(`private reference (${label}): ${rel(file)}:${i + 1}`);
      }
    });
}

// ---------------------------------------------------------------------------
// 8c. Environment fingerprints (public repo): warn, block the push under --strict.
// ---------------------------------------------------------------------------
const ENV_FINGERPRINTS = [
  [/\b192\.168\.[0-9]+\.[0-9]+\b/, 'private LAN IP'],
  [/\b10\.[0-9]+\.[0-9]+\.[0-9]+\b/, 'private/VPN IP'],
  [/\b151\.[0-9]+\.[0-9]+\.[0-9]+\b/, 'public WAN IP'],
  [/\b[a-z0-9-]+\.giaffalab\.win\b/i, 'private domain'],
  [/\btplinkdns\.com\b/i, 'private DDNS domain'],
  [/\bhermesadmin\b/, 'environment username'],
  [/\b(?:giaffaglione|mammino|fabio)\b/i, 'possible personal name'],
];
for (const file of textFiles) {
  read(file)
    .split('\n')
    .forEach((line, i) => {
      for (const [re, label] of ENV_FINGERPRINTS) {
        if (re.test(line)) warn(`environment fingerprint (${label}): ${rel(file)}:${i + 1}`);
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
