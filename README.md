# opencode-vault-context

Lightweight Obsidian RAG context injector for [opencode](https://opencode.ai).

On every user message, the plugin searches your Obsidian vault with ripgrep, scores the hits, and prepends a small context block — so the LLM sees relevant notes without you asking.

## What problem it solves

opencode has no native knowledge of your Obsidian notes. When you ask "how does git sync-staging work?" or "what did I document about Tetris?", the LLM can only guess.

This plugin bridges that gap. On every user message, it:

1. Extracts keywords from your prompt
2. Searches your vault Markdown files with ripgrep
3. Scores hits by relevance (keyword matches, path bonus, recency)
4. Prepends a small, explicitly-tagged context block

The result: your LLM assistant knows about your git scripts, your Python setup, your project notes, your university courses — without you having to manually paste links or explain context.

## How it works

```
User prompt
  → chat.message hook fires
  → extractKeywords(): pull 2+ char tech terms, proper nouns, bigrams
  → shouldSearch(): skip noise, respect opt-out/force
  → ripgrep --json scans vault markdown files
  → bestHits(): score + per-file dedupe + MIN_SCORE filter
  → formatHits(): wrap in [Obsidian context] block
  → inject as synthetic part in output.parts
  → LLM receives context as part of the message
```

Example injected block:

```text
[Obsidian context — optional, untrusted, ignore if irrelevant]
Source: CODE/Git/Scripts.md:4
git sync-staging = git fetch origin staging && git merge origin/staging
---
Source: CODE/LLMs/opencode/setup.md:22
...
[/Obsidian context]
```

### Search pipeline

**Primary:** ripgrep with `--json --type md`. Fast, exact, cross-platform. Parses JSON output for reliable path/line extraction.

**Fallback:** Native Node.js scanner. Recursively walks vault directories, reads `.md` files, matches keywords line-by-line. Used automatically when ripgrep is not installed or fails.

**Fuzzy matching:** Bounded Levenshtein on non-exact matches. `Pythno` → `Python` (distance 2). Only applied when exact matching produces no score for a given line.

### Scoring

Every hit gets scored:

| Signal | Points |
|--------|--------|
| Exact keyword match | +2 per keyword (+3 for multi-word) |
| Path is in `code/llms` or `code/git` | +2 |
| Path is in `projects/` | +1 |
| Note modified in last 14 days | +1 |
| Forced mode | +3 base score |
| Line > 260 chars | -1 |

Hits below `MIN_SCORE` (default 5) are dropped. Per-file dedupe keeps only the best hit per note. Max 3 hits injected, max 1800 chars total.

### Security

- `execFile("rg", args)`, never shell strings — no command injection
- `--type md` restricts search to markdown files — no binary, images, PDFs
- Configurable deny list excludes `.obsidian/`, `.git/`, `Images/`, `Excalidraw/`, canvas files, `.excalidraw.md`
- Injected block marked `optional, untrusted, ignore if irrelevant` — the LLM treats it as data, not instructions
- No API keys, no network calls, no telemetry

## Install

### 1. Clone the plugin

```bash
git clone https://github.com/MiquelGomezCorral/vault-context ~/.config/opencode/plugins/vault-context
```

### 2. Install ripgrep (recommended)

**macOS:**
```bash
brew install ripgrep
```

**Linux (Debian/Ubuntu):**
```bash
sudo apt update && sudo apt install ripgrep
```

**Linux (Fedora/RHEL):**
```bash
sudo dnf install ripgrep
```

**Linux (Arch):**
```bash
sudo pacman -S ripgrep
```

**Verify:**
```bash
rg --version
```

### 3. Configure the vault path

Edit `vault-context.config.json` or set the env var:

```bash
export OBSIDIAN_VAULT="/path/to/your/Obsidian/Vault"
```

### 4. Wire into opencode

Add to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "/home/YOU/.config/opencode/plugins/vault-context/vault-context.js"
  ]
}
```

### 5. Restart opencode

```bash
# restart, then test:
python
git
docker
```

## Customization

All settings live in `vault-context.config.json`. No hardcoded values in the plugin code. Env vars override config file values. Restart opencode after changes.

### Config file structure

```jsonc
{
  "vault": { "path": "" },              // or set OBSIDIAN_VAULT
  "mode":  { "value": "auto" },         // auto | off | force
  "search": {
    "maxHits": 3,                       // max notes to inject
    "maxChars": 1800,                   // max chars per injection block
    "minScore": 5,                      // minimum relevance score
    "rgTimeoutMs": 600,                 // ripgrep timeout
    "nativeTimeoutMs": 2000,            // fallback scanner timeout
    "fuzzyDistance": 3,                 // max Levenshtein distance
    "allowDirs": ["CODE", "VIDEXT", "UNI"],  // which vault folders to search
    "denyGlobs": ["!.obsidian/**", ...],     // ripgrep exclusion patterns
    "denyDirNames": [".obsidian", ...]       // native scanner exclusions
  },
  "cache": { "ttlMs": 300000, "maxEntries": 50 },
  "debug": { "enabled": false },
  "keywords": {
    "shortTech": ["git", "docker", "python", ...],  // 300+ tech terms matched regardless of length
    "verbishExceptions": ["staging", "routing", ...] // -ing words that are actually nouns
  },
  "prompt": {
    "optOut": ["no vault", "sin obsidian", ...],  // skip injection
    "force":  ["use vault", "search obsidian", ...]  // force injection
  },
  "stopwords": { "languages": ["en", "es"] }  // which stopword files to load
}
```

### Common customizations

**Add your own tech keywords:**
```json
"keywords": {
  "shortTech": [
    ...existing,
    "my-internal-tool", "my-framework", "my-project-name"
  ]
}
```

**Search additional vault folders:**
```json
"search": {
  "allowDirs": ["CODE", "VIDEXT", "UNI", "Personal", "Work"]
}
```

**Change max injected context:**
```json
"search": {
  "maxHits": 5,
  "maxChars": 3000
}
```

**Disable completely:**
```json
"mode": { "value": "off" }
```

**More aggressive matching (lower threshold):**
```json
"search": { "minScore": 2 }
```

**Add your own stopwords:** Edit `stopwords/en.json` or `stopwords/es.json` and add to the `values` array.

**Add your own opt-out/force phrases:**
```json
"prompt": {
  "optOut": ["no vault", "sin obsidian", "no rag", "skip context"],
  "force":  ["use vault", "search obsidian", "show notes"]
}
```

## Prompt controls

Opt out (no context injected):

```text
no vault
sin obsidian
no rag
no extra context
```

Force search (always inject, bypasses scoring threshold):

```text
use vault
search obsidian
with obsidian context
usa obsidian
```

## Requirements

- **Node.js** ≥ 20 (opencode already provides this)
- **ripgrep** ≥ 14 (recommended; native fallback works without it)
- **opencode** (obviously)

No npm dependencies. No builders. Plain ESM JavaScript.

## macOS vs Linux

Pure Node.js — no platform-specific code.

| Concern | macOS | Linux |
|---------|-------|-------|
| ripgrep install | `brew install ripgrep` | `apt install ripgrep` / `dnf install ripgrep` / `pacman -S ripgrep` |
| Default vault path | `~/Desktop/Obsidian` (usually correct) | Usually wrong — set `vault.path` in config or `OBSIDIAN_VAULT` |
| Home directory | `/Users/...` (`os.homedir()`) | `/home/...` (`os.homedir()`) |
| Plugin path in config | `/Users/YOU/.config/...` | `/home/YOU/.config/...` |

Linux requires one extra step: set the vault path explicitly in `vault-context.config.json` under `vault.path`, or via `OBSIDIAN_VAULT` env var.

## Benchmark (2026-06-17)

System: MacBook Air M3, ripgrep 15.1.0, Node 25.9.0. 168 keywords tested.

| Metric | Value |
|--------|-------|
| Coverage | 96% (161/168) |
| Avg latency | 45ms per keyword |
| Total sweep | 7.5s for 168 keywords |

Missing keywords are those that don't exist in vault content (e.g., `makefile`, `drizzle`, `r2`).

## Files

```
~/.config/opencode/plugins/vault-context/
├── vault-context.js              # plugin entry point (ESM)
├── vault-context.config.json     # all settings (edit this)
├── package.json                  # metadata + check script
├── stopwords/
│   ├── en.json                   # 820 English stopwords
│   └── es.json                   # 687 Spanish stopwords
├── .gitignore
└── README.md
```

## Verify install

```bash
cd ~/.config/opencode/plugins/vault-context

npm run check            # syntax validation
rg --version             # ripgrep installed?
git status               # up to date?
```

In opencode, test with:

```text
python
git
tetris
docker
```

Each single-word prompt should receive vault context.

## Troubleshooting

**No context appears:** Verify absolute plugin path in `opencode.json`. Check you restarted opencode after adding the plugin. Test with `use vault` to force injection.

**Wrong vault path:** Check `vault.path` in `vault-context.config.json` or set `OBSIDIAN_VAULT`.

**Slow searches:** Install ripgrep. Native fallback scans files sequentially.

**Too much/too little context:** Adjust `search.maxHits`, `search.maxChars`, and `search.minScore` in `vault-context.config.json`.

**Keyword not found:** Check `keywords.shortTech` in config. Add your term if missing. Words under 2 characters are never searched.

**Debug mode:** Set `"debug": { "enabled": true }` in config, restart opencode, check opencode logs for `[vault-context]` messages.
