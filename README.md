# opencode-vault-context

Lightweight Obsidian context injector for opencode.

It runs `rg` over selected Markdown folders in the vault on each user message, scores the hits, and prepends a small untrusted context block only when the prompt looks suitable. If `rg` is not installed, it falls back to a small native Markdown scanner.

## Setup

```bash
export OBSIDIAN_VAULT="$HOME/Desktop/Obsidian"
```

Add the plugin to `~/.config/opencode/opencode.json`:

```json
"/Users/miquelgomezcorral/.config/opencode/plugins/vault-context/vault-context.js"
```

Restart opencode.

## Controls

- Opt out in prompt: `no vault`, `sin obsidian`, `no rag`, `no extra context`
- Force in prompt: `use vault`, `search obsidian`, `with obsidian context`, `usa obsidian`

## Env knobs

- `OBSIDIAN_VAULT`: vault path
- `VAULT_CONTEXT_MODE`: `auto` | `off` | `force`
- `VAULT_CONTEXT_MAX_HITS`: default `3`
- `VAULT_CONTEXT_MAX_CHARS`: default `1800`
- `VAULT_CONTEXT_DEBUG`: `1` logs decisions

## Verify

```bash
npm run check
```
