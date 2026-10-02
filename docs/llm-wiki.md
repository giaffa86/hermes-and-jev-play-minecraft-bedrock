# LLM Wiki — manifest

This `docs/` directory is an **LLM wiki**, following the pattern described in
[Karpathy's `llm-wiki.md`](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).
The principle: instead of retrieving raw documents at query time, an LLM
**incrementally builds and maintains** a persistent, interlinked layer of
Markdown that sits between the reader and the raw sources. Knowledge is compiled
once and kept current, not re-derived on every question.

## The three layers

1. **Raw sources** (`docs/raw/`, plus `BEDROCK.md` at the repo root and the
   private `.private/` runbooks) — the source of truth. Immutable: the LLM reads
   them but never edits them here.
2. **The wiki** (`docs/wiki/`) — LLM-generated synthesis pages: overviews, concept
   pages, comparisons. The LLM owns this layer entirely.
3. **The schema** — this file plus [`AGENTS.md`](../AGENTS.md). It tells a future
   agent how the wiki is structured and what workflows to follow.

## Directory layout

```
docs/
├── llm-wiki.md      # this manifest (the schema)
├── index.md         # catalog of wiki pages (content-oriented)
├── log.md           # append-only chronological log (ingest/query/lint)
├── sources.md       # catalog of raw sources
├── raw/             # immutable raw sources (BEDROCK.md lives at the repo root)
│   ├── SURVIVAL-INTELLIGENCE.md
│   ├── REPRODUCTION-REPORT.md
│   └── evidence/
└── wiki/            # LLM-generated synthesis layer
    ├── overview.md
    ├── headless-client.md
    ├── survival-intelligence.md
    ├── reproduction.md
    └── open-questions.md
```

## Conventions

- **Language: English.** All wiki pages and raw sources are written in English.
- **Self-contained pages.** Each page states its topic, cites its sources with
  relative links, and cross-links related pages. No orphan pages: every page is
  reachable from `index.md`.
- **Sources are immutable.** Never rewrite a raw source just to add a link;
  synthesize and link from the wiki layer instead.
- **Deterministic facts win.** When the code and a prose claim disagree, the code
  (or the raw source) is the truth; flag the contradiction in `open-questions.md`.

## Workflows

### Ingest

When a new source is added (a report, a new capability, a runbook):

1. read the source;
2. write or update the relevant `wiki/` page(s);
3. update `index.md` and `sources.md`;
4. append an entry to `log.md`.

### Query

Before answering a question about the project, read `docs/index.md`, then the
relevant `wiki/` pages, then drill into `raw/` only if needed. Good answers
(found comparisons, analyses, clarifications) are filed back into `wiki/`.

### Lint

Periodically health-check the wiki: look for contradictions between pages, stale
claims superseded by newer sources, orphan pages, concepts mentioned but lacking a
page, missing cross-references. Record findings in `wiki/open-questions.md` and
append a `lint` entry to `log.md`.

## Indexing and logging

- **`index.md`** is content-oriented: one line per page with a summary and its
  main sources. Read it first.
- **`log.md`** is chronological and append-only. Every entry starts with a
  parseable prefix: `## [YYYY-MM-DD] <type> | <title>` (e.g.
  `## [2026-10-02] ingest | Bedrock action status`). `grep "^## \[" log.md | tail`
  shows recent activity.
