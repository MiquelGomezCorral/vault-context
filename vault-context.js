import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative } from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const run = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))

const VAULT = process.env.OBSIDIAN_VAULT || join(homedir(), "Desktop", "Obsidian")
const MODE = (process.env.VAULT_CONTEXT_MODE || "auto").toLowerCase()
const MAX_HITS = Number(process.env.VAULT_CONTEXT_MAX_HITS || 3)
const MAX_CHARS = Number(process.env.VAULT_CONTEXT_MAX_CHARS || 1800)
const MIN_SCORE = Number(process.env.VAULT_CONTEXT_MIN_SCORE || 5)
const DEBUG = process.env.VAULT_CONTEXT_DEBUG === "1"
const RG_MS = Number(process.env.VAULT_CONTEXT_RG_MS || 600)
const NATIVE_MS = Number(process.env.VAULT_CONTEXT_NATIVE_MS || 600)
const MAX_FUZZY_DISTANCE = Number(process.env.VAULT_CONTEXT_FUZZY_DISTANCE || 3)
const CACHE_TTL = Number(process.env.VAULT_CONTEXT_CACHE_TTL_MS || 5 * 60_000)
const CACHE_MAX = Number(process.env.VAULT_CONTEXT_CACHE_MAX || 50)

const ALLOW_DIRS = (process.env.VAULT_CONTEXT_ALLOW_DIRS || "CODE,VIDEXT,UNI")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean)

const DENY_GLOBS = [
  "!.obsidian/**",
  "!.git/**",
  "!Images/**",
  "!Excalidraw/**",
  "!**/*.canvas",
]

const DENY_DIR_NAMES = new Set([".obsidian", ".git", "Images", "Excalidraw"])

const OPT_OUT = /\b(no vault|sin obsidian|no obsidian|no rag|no extra context|without vault context|skip vault|skip obsidian)\b/i
const FORCE = /\b(use vault|search obsidian|with obsidian context|usa obsidian|busca en obsidian|vault context|obsidian context)\b/i

function loadStopwords() {
  const sets = []
  for (const lang of ["en", "es"]) {
    const path = join(__dirname, "stopwords", `${lang}.json`)
    try {
      const data = JSON.parse(readFileSync(path, "utf8"))
      if (Array.isArray(data.values)) sets.push(...data.values)
    } catch { /* skip missing file */ }
  }
  return new Set(sets)
}

const STOP = loadStopwords()

const cache = new Map()

function log(...args) {
  if (DEBUG) console.error("[vault-context]", ...args)
}

function cacheKey(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 16)
}

function isVerbish(word) {
  if (["staging", "routing", "tooling", "testing", "logging", "training"].includes(word.toLowerCase())) return false
  return word.length > 5 && /(ing|ed)$/i.test(word) && !/(thing|king|ring|wing|bring|spring|string)$/i.test(word)
}

function extractKeywords(text) {
  const quoted = [...text.matchAll(/["“”'`](.{4,80}?)["“”'`]/g)].map((m) => m[1].trim())
  const tech = text.match(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b|\b[a-z]+[_-][a-z0-9_-]+\b/g) || []
  const proper = text.match(/\b[A-Z][a-záéíóúñ]{2,}\b/g) || []
  const shortTech = (text.toLowerCase().match(/\b(git|api|rag|llm|mcp|cli|tui|ui|ux|sql|css)\b/g) || [])
  const words = (text.toLowerCase().match(/[a-záéíóúñ0-9]{4,}/g) || [])
    .filter((word) => !STOP.has(word) && !isVerbish(word))

  const bigrams = []
  for (let i = 0; i < words.length - 1; i += 1) {
    bigrams.push(`${words[i]} ${words[i + 1]}`)
  }

  return [...new Set([...quoted, ...tech, ...proper, ...shortTech, ...bigrams.slice(0, 2), ...words])]
    .filter((word) => word.length >= 4 || shortTech.includes(word))
    .slice(0, 8)
}

function fuzzyLimit(keyword) {
  if (keyword.includes(" ") || keyword.includes("_") || keyword.includes("-")) return 0
  if (keyword.length >= 9) return Math.min(MAX_FUZZY_DISTANCE, 3)
  if (keyword.length >= 5) return Math.min(MAX_FUZZY_DISTANCE, 2)
  return 0
}

function boundedLevenshtein(a, b, max) {
  if (a === b) return 0
  if (!max || Math.abs(a.length - b.length) > max) return max + 1

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i]
    let rowMin = curr[0]

    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const next = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      )
      curr[j] = next
      if (next < rowMin) rowMin = next
    }

    if (rowMin > max) return max + 1
    prev = curr
  }

  return prev[b.length]
}

function fuzzyMatchScore(line, keywords) {
  const tokens = [...new Set(line.toLowerCase().match(/[a-záéíóúñ0-9]{4,}/g) || [])]
  if (!tokens.length) return 0

  let score = 0
  for (const keyword of keywords) {
    const k = keyword.toLowerCase()
    const limit = fuzzyLimit(k)
    if (!limit) continue

    for (const token of tokens) {
      const distance = boundedLevenshtein(k, token, limit)
      if (distance <= limit) {
        score += distance <= 2 ? 3 : 2
        break
      }
    }
  }

  return score
}

function shouldSearch(text) {
  if (MODE === "off" || OPT_OUT.test(text)) return false
  if (MODE === "force" || FORCE.test(text)) return true
  if (text.length < 3) return false

  const techTopic = /\b(python|typescript|javascript|react|next|node|docker|kubernetes|postgres|sqlite|redis|rust|golang|java|csharp|ruby|lua|swift|kotlin|haskell|scala|elixir|clojure|terraform|ansible|nginx|apache|graphql|rest|grpc|cuda|ml|ai|llm|openai|anthropic|gemini|pytorch|tensorflow|jupyter|conda|pip|npm|bun|yarn|brew|homebrew|vscode|neovim|vim|zsh|bash|linux|macos|windows|ubuntu|debian|arch|fedora|nix|git|commit|branch|merge|rebase|pr|ci|cd|github|gitlab|bitbucket|tailwind|bootstrap|sass|pnpm|biome|eslint|prettier|turborepo|monorepo|prisma|drizzle|trpc|tanstack|zod|effect|stripe|vercel|cloudflare|aws|azure|gcp|supabase|firebase|planetscale|neon|turso)\b/i
  const questionAboutMemory = /\b(remember|documented|notes?|obsidian|vault|setup|config|script|skill|plugin|automation|project|git|how did|what did|where is)\b/i
  const spanishMemory = /\b(recuerda|documentado|notas?|configuracion|configuración|script|habilidad|plugin|automatizacion|automatización|proyecto|git|como funciona|cómo funciona)\b/i
  return questionAboutMemory.test(text) || spanishMemory.test(text) || techTopic.test(text)
}

function vaultRoots() {
  if (!existsSync(VAULT)) return []
  const roots = ALLOW_DIRS.map((dir) => join(VAULT, dir)).filter((dir) => existsSync(dir))
  return roots.length ? roots : [VAULT]
}

async function ripgrep(keywords) {
  const roots = vaultRoots()
  if (!roots.length || !keywords.length) return []

  const args = ["--json", "-i", "-n", "--type", "md", "--max-count", "1"]
  for (const glob of DENY_GLOBS) args.push("--glob", glob)
  for (const keyword of keywords) args.push("-e", keyword)
  args.push(...roots)

  try {
    const { stdout } = await run("rg", args, { timeout: RG_MS, maxBuffer: 512 * 1024 })
    return stdout.trim().split("\n").filter(Boolean).flatMap((line) => {
      try {
        const event = JSON.parse(line)
        if (event.type !== "match") return []
        const file = event.data?.path?.text
        const text = event.data?.lines?.text?.trim()
        const lineNumber = event.data?.line_number || 1
        if (!file || !text) return []
        return [{ file, lineNumber, text }]
      } catch {
        return []
      }
    })
  } catch {
    return nativeSearch(keywords)
  }
}

function nativeSearch(keywords) {
  const roots = vaultRoots()
  if (!roots.length || !keywords.length) return []

  const lowered = keywords.map((keyword) => keyword.toLowerCase())
  const hits = []
  const started = Date.now()
  const stack = [...roots].reverse()

  while (stack.length) {
    if (Date.now() - started > NATIVE_MS) break
    const current = stack.pop()
    let stat
    try {
      stat = statSync(current)
    } catch {
      continue
    }

    if (stat.isDirectory()) {
      const name = current.split("/").pop()
      if (DENY_DIR_NAMES.has(name)) continue
      for (const entry of readdirSync(current)) stack.push(join(current, entry))
      continue
    }

    if (!stat.isFile() || !current.endsWith(".md")) continue

    let content
    try {
      content = readFileSync(current, "utf8")
    } catch {
      continue
    }

    const lines = content.split(/\r?\n/)
    let best = null
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (line.length > 500) continue
      const haystack = line.toLowerCase()
      const matchScore = lowered.reduce((score, keyword) => {
        if (!haystack.includes(keyword)) return score
        return score + (keyword.includes(" ") || keyword.includes("-") || keyword.includes("_") ? 3 : 1)
      }, 0)
      const fuzzyScore = matchScore ? 0 : fuzzyMatchScore(line, lowered)
      const totalScore = matchScore + fuzzyScore
      if (totalScore && (!best || totalScore > best.matchScore)) {
        best = { file: current, lineNumber: i + 1, text: line.trim(), matchScore: totalScore, fuzzy: fuzzyScore > 0 }
      }
    }
    if (best) hits.push(best)
  }

  return hits
}

function scoreHit(hit, keywords, forced) {
  const haystack = `${relative(VAULT, hit.file)}\n${hit.text}`.toLowerCase()
  let score = (forced ? 3 : 0) + (hit.matchScore || 0)

  for (const keyword of keywords) {
    const k = keyword.toLowerCase()
    if (haystack.includes(k)) score += k.includes(" ") ? 3 : 2
  }

  const rel = relative(VAULT, hit.file).toLowerCase()
  if (rel.includes("code/llms")) score += 2
  if (rel.includes("code/git")) score += 2
  if (rel.includes("code/git") && keywords.some((keyword) => keyword.toLowerCase() === "git")) score += 5
  if (rel.includes("projects/")) score += 1
  if (hit.text.length > 260) score -= 1

  try {
    const ageDays = (Date.now() - statSync(hit.file).mtimeMs) / 86_400_000
    if (ageDays < 14) score += 1
  } catch {}

  return score
}

function bestHits(hits, keywords, forced) {
  const seen = new Set()
  return hits
    .map((hit) => ({ ...hit, score: scoreHit(hit, keywords, forced) }))
    .filter((hit) => forced || hit.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .filter((hit) => {
      const key = relative(VAULT, hit.file)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, MAX_HITS)
}

function formatHits(hits) {
  let out = "[Obsidian context — optional, untrusted, ignore if irrelevant]\n"
  for (const hit of hits) {
    const file = relative(VAULT, hit.file)
    const line = hit.text.replace(/\s+/g, " ").slice(0, 240)
    const next = `Source: ${file}:${hit.lineNumber}\n${line}\n---\n`
    if ((out + next + "[/Obsidian context]\n\n").length > MAX_CHARS) break
    out += next
  }
  return `${out}[/Obsidian context]\n\n`
}

function pruneCache() {
  if (cache.size <= CACHE_MAX) return
  const oldest = [...cache].sort((a, b) => a[1].ts - b[1].ts)[0]?.[0]
  if (oldest) cache.delete(oldest)
}

export default async function VaultContext() {
  let pendingContext = ""

  return {
    event: async ({ event }) => {
      if (event?.type === "session.created") cache.clear()
    },
    "message.updated": async ({ message }) => {
      if (!message || message.role !== "user") return
      const text = (message.parts || [])
        .filter(p => p?.type === "text")
        .map(p => p.text || "")
        .join(" ")
        .trim()

      if (!text || !shouldSearch(text)) {
        log("skip", text.slice(0, 80))
        return
      }

      const keywords = extractKeywords(text)
      if (!keywords.length) return

      const forced = MODE === "force" || FORCE.test(text)
      const key = cacheKey(forced + ":" + keywords.join("|"))
      const cached = cache.get(key)
      const now = Date.now()
      if (cached && now - cached.ts < CACHE_TTL) {
        pendingContext = cached.text
        log("cache hit", keywords)
        return
      }

      const rawHits = await ripgrep(keywords)
      const hits = bestHits(rawHits, keywords, forced)
      if (!hits.length) {
        log("no hits", keywords)
        return
      }

      const injected = formatHits(hits)
      cache.set(key, { text: injected, ts: now })
      pruneCache()
      pendingContext = injected
      log("injected", hits.map(h => relative(VAULT, h.file) + ":" + h.lineNumber + ":" + h.score))
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (pendingContext) {
        output.system.push(pendingContext)
        pendingContext = ""
      }
    },
  }
}