# opencode-vault-context

Lightweight Obsidian RAG context injector for [opencode](https://opencode.ai).

On every user message, the plugin searches your Obsidian vault with ripgrep, scores the hits, and prepends a small context block — so the LLM sees relevant notes without you asking.

## How it works

```
User prompt
  → chat.message hook
  → keyword extraction (300+ tech terms, 2+ chars)
  → rg --json over vault markdown files
  → scoring + per-file dedupe
  → inject [Obsidian context] block
  → LLM
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

## Install

### 1. Clone the plugin

```bash
git clone https://github.com/MiquelGomezCorral/vault-context ~/.config/opencode/plugins/vault-context
```

### 2. Install ripgrep (recommended)

The plugin uses ripgrep as its primary search engine. Without it, a native Node.js fallback scanner runs — slower and with lower coverage. ripgrep is strongly recommended.

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

**Linux (openSUSE):**

```bash
sudo zypper install ripgrep
```

**Verify:**

```bash
rg --version   # should show ripgrep 14+
```

### 3. Configure the vault path

The plugin defaults to `~/Desktop/Obsidian`. If your vault is elsewhere, set the env var:

```bash
export OBSIDIAN_VAULT="/path/to/your/Obsidian/Vault"
```

On Linux, this is almost always needed — the default `~/Desktop/Obsidian` may not exist (the desktop folder name varies by locale and desktop environment).

Add it to your shell profile:

```bash
# ~/.zshrc or ~/.bashrc
export OBSIDIAN_VAULT="$HOME/Documents/Obsidian"
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

Use an absolute path. On macOS: `/Users/YOU/.config/...`. On Linux: `/home/YOU/.config/...`.

### 5. Restart opencode

```bash
# restart opencode, then test with:
python
git
docker
```

Each single-word prompt should receive relevant vault context.

## Requirements

- **Node.js** ≥ 20 (opencode already provides this)
- **ripgrep** ≥ 14 (recommended; native fallback works without it)
- **opencode** (obviously)

No npm dependencies. No builders. Plain ESM JavaScript.

## macOS vs Linux

The plugin is pure Node.js — no native binaries, no platform-specific code.

| Concern | macOS | Linux |
|---------|-------|-------|
| ripgrep install | `brew install ripgrep` | `apt install ripgrep` / `dnf install ripgrep` / `pacman -S ripgrep` |
| Default vault path | `~/Desktop/Obsidian` (usually correct) | Usually wrong — set `OBSIDIAN_VAULT` explicitly |
| File paths | Works | Works (Node `path` module handles separators) |
| Home directory | `/Users/...` (resolved by `os.homedir()`) | `/home/...` (resolved by `os.homedir()`) |
| Shell | zsh (works) | bash/zsh/fish (all work) |

The only Linux-specific step is setting `OBSIDIAN_VAULT`. The default path assumes a macOS-style `~/Desktop/Obsidian` layout, which is unlikely on Linux.

## Configuration

All knobs via environment variables:

```bash
# Required if vault is not at ~/Desktop/Obsidian
export OBSIDIAN_VAULT="$HOME/path/to/vault"

# Mode: auto (default, searches when keywords found), off, force
export VAULT_CONTEXT_MODE="auto"

# Max context injections per prompt (default 3)
export VAULT_CONTEXT_MAX_HITS="3"

# Max chars per injection block (default 1800)
export VAULT_CONTEXT_MAX_CHARS="1800"

# Min score to include a result (default 5)
export VAULT_CONTEXT_MIN_SCORE="5"

# Directories inside vault to search (comma-separated, default CODE,VIDEXT,UNI)
export VAULT_CONTEXT_ALLOW_DIRS="CODE,VIDEXT,UNI"

# Ripgrep timeout in ms (default 600)
export VAULT_CONTEXT_RG_MS="600"

# Native fallback timeout in ms (default 2000)
export VAULT_CONTEXT_NATIVE_MS="2000"

# Max Levenshtein distance for typo matching (default 3)
export VAULT_CONTEXT_FUZZY_DISTANCE="3"

# Enable debug logging (set to 1)
export VAULT_CONTEXT_DEBUG="0"
```

## Prompt controls

Opt out (no context injected):

```text
no vault
sin obsidian
no rag
no extra context
no obsidian
```

Force search (always inject, bypasses scoring threshold):

```text
use vault
search obsidian
with obsidian context
usa obsidian
```

## Search features

- **Lexical, not semantic** — matches words, not concepts. `Python` finds literal `Python` in text.
- **Typo-tolerant** — `Pythno` can match `Python` via bounded Levenshtein (distance 2–3).
- **1503 stopwords** — English + Spanish, from stopwords-iso (CC BY-SA 4.0), loaded at startup from `stopwords/en.json` and `stopwords/es.json`.
- **300+ shortTech terms** — common tech keywords matching 2+ characters (`go`, `js`, `py`, `sh`, `git`, `npm`, `docker`, `kubernetes`, `postgres`, ...).
- **Per-file dedupe** — max one hit per file.
- **5-min LRU cache** — repeat prompts are free.
- **Fails open** — if search fails or returns nothing, no context is injected. The prompt passes through unchanged.

## Benchmark (2026-06-17)

System: MacBook Air M3, ripgrep 15.1.0, Node 25.9.0.

168 keywords tested against a real vault. Coverage: found / total.

| Metric | Value |
|--------|-------|
| Coverage | 96% (161/168) |
| Avg latency | 45ms per keyword |
| Total sweep | 7.5s for 168 keywords |

Missing keywords are those that don't exist in the vault content (e.g., `makefile`, `drizzle`, `r2`).

## Verify install

```bash
cd ~/.config/opencode/plugins/vault-context

# Syntax check
npm run check

# ripgrep installed?
rg --version

# Git status
git status
```

In opencode, test with single-word prompts:

```text
python
git
tetris
```

Each should receive vault context. To verify the hook is loaded, check that `python` returns notes about your Python setup/docs.

## Troubleshooting

**No context appears:** Ensure the plugin path in `opencode.json` is absolute and the file exists. Check you restarted opencode after adding the plugin.

**Wrong vault path:** Set `OBSIDIAN_VAULT` explicitly. The default `~/Desktop/Obsidian` works on macOS but rarely on Linux.

**Slow searches on Linux:** Install ripgrep. The native fallback scans files sequentially and times out at 2000ms. With ripgrep, searches complete in <50ms.

**No matches for my keywords:** Keywords under 2 characters are skipped. Very long keywords (>9 chars) may hit scoring thresholds. Add `use vault` to your prompt to force injection and bypass scoring.

**Permission errors reading vault:** opencode runs as your user. If files are readable in your terminal, the plugin can read them.
