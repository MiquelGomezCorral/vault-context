import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative } from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const run = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))

let VAULT, MODE, MAX_HITS, MAX_CHARS, MIN_SCORE, DEBUG
let RG_MS, NATIVE_MS, MAX_FUZZY_DISTANCE, CACHE_TTL, CACHE_MAX
let ALLOW_DIRS, DENY_GLOBS, DENY_DIR_NAMES
let OPT_OUT, FORCE
let SHORT_TECH, VERBISH_EXCEPTIONS
let STOPWORD_LANGS
let SCORING

const cache = new Map()

function env(name, fallback) {
  return process.env[name] !== undefined ? process.env[name] : fallback
}

function loadConfig() {
  const cfgPath = join(__dirname, "vault-context.config.json")
  let cfg = {}
  try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")) } catch { /* use defaults */ }

  const v  = cfg.vault  || {}
  const md = cfg.mode   || {}
  const sr = cfg.search || {}
  const ca = cfg.cache  || {}
  const db = cfg.debug  || {}
  const kw = cfg.keywords || {}
  const pr = cfg.prompt || {}
  const sw = cfg.stopwords || {}

  VAULT       = env("OBSIDIAN_VAULT", v.path || join(homedir(), "Desktop", "Obsidian"))
  MODE        = env("VAULT_CONTEXT_MODE", md.value || "auto").toLowerCase()
  MAX_HITS    = Number(env("VAULT_CONTEXT_MAX_HITS", sr.maxHits ?? 3))
  MAX_CHARS   = Number(env("VAULT_CONTEXT_MAX_CHARS", sr.maxChars ?? 1800))
  MIN_SCORE   = Number(env("VAULT_CONTEXT_MIN_SCORE", sr.minScore ?? 5))
  RG_MS       = Number(env("VAULT_CONTEXT_RG_MS", sr.rgTimeoutMs ?? 600))
  NATIVE_MS   = Number(env("VAULT_CONTEXT_NATIVE_MS", sr.nativeTimeoutMs ?? 2000))
  MAX_FUZZY_DISTANCE = Number(env("VAULT_CONTEXT_FUZZY_DISTANCE", sr.fuzzyDistance ?? 3))
  CACHE_TTL   = Number(env("VAULT_CONTEXT_CACHE_TTL_MS", ca.ttlMs ?? 300000))
  CACHE_MAX   = Number(env("VAULT_CONTEXT_CACHE_MAX", ca.maxEntries ?? 50))
  DEBUG       = env("VAULT_CONTEXT_DEBUG", db.enabled ? "1" : "0") === "1"

  ALLOW_DIRS  = (env("VAULT_CONTEXT_ALLOW_DIRS", (sr.allowDirs || ["CODE","VIDEXT","UNI"]).join(",")))
    .split(",").map(x => x.trim()).filter(Boolean)

  DENY_GLOBS  = sr.denyGlobs || ["!.obsidian/**","!.git/**","!Images/**","!Excalidraw/**","!**/*.canvas","!**/*.excalidraw.md"]
  DENY_DIR_NAMES = new Set(sr.denyDirNames || [".obsidian",".git","Images","Excalidraw"])

  const optOutList = pr.optOut || ["no vault","sin obsidian","no obsidian","no rag","no extra context","without vault context","skip vault","skip obsidian"]
  const forceList  = pr.force || ["use vault","search obsidian","with obsidian context","usa obsidian","busca en obsidian","vault context","obsidian context"]

  OPT_OUT = new RegExp("\\b(" + optOutList.join("|").replace(/\s+/g, "\\s+") + ")\\b", "i")
  FORCE   = new RegExp("\\b(" + forceList.join("|").replace(/\s+/g, "\\s+") + ")\\b", "i")

  SHORT_TECH = kw.shortTech || []
  VERBISH_EXCEPTIONS = new Set((kw.verbishExceptions || ["staging","routing","tooling","testing","logging","training"]).map(w => w.toLowerCase()))
  STOPWORD_LANGS = sw.languages || ["en","es"]

  SCORING = cfg.scoring || {}
  SCORING.baseScore    = SCORING.baseScore ?? 3
  SCORING.forceBonus   = SCORING.forceBonus ?? 3
  SCORING.keywordMatch = SCORING.keywordMatch || { single: 2, multiWord: 3 }
  SCORING.keywordBonus = SCORING.keywordBonus || { single: 2, multiWord: 3 }
  SCORING.fuzzyMatch   = SCORING.fuzzyMatch   || { close: 3, far: 2 }
  SCORING.paths         = SCORING.paths        || [{ pattern: "code/git", score: 5 }, { pattern: "code/llms", score: 3 }, { pattern: "code/", score: 2 }, { pattern: "vidext/", score: 2 }, { pattern: "projects/", score: 1 }]
  SCORING.recency       = SCORING.recency      || [{ days: 7, score: 2 }, { days: 14, score: 1 }]
  SCORING.longLine      = SCORING.longLine     || { threshold: 260, penalty: 1 }
  SCORING.exactKeywordMatch = SCORING.exactKeywordMatch || { score: 5, keywords: ["git"] }
}

loadConfig()

function loadStopwords() {
  const sets = []
  for (const lang of STOPWORD_LANGS) {
    const path = join(__dirname, "stopwords", `${lang}.json`)
    try {
      const data = JSON.parse(readFileSync(path, "utf8"))
      if (Array.isArray(data.values)) sets.push(...data.values)
    } catch { /* skip missing file */ }
  }
  return new Set(sets)
}

const STOP = loadStopwords()

function log(...args) {
  if (DEBUG) console.error("[vault-context]", ...args)
}

function cacheKey(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 16)
}

function isVerbish(word) {
  if (VERBISH_EXCEPTIONS.has(word.toLowerCase())) return false
  return word.length > 5 && /(ing|ed)$/i.test(word) && !/(thing|king|ring|wing|bring|spring|string)$/i.test(word)
}

const SHORT_TECH_RE = new RegExp("\\b(" + SHORT_TECH.join("|") + ")\\b", "gi")

function extractKeywords(text) {
  const quoted = [...text.matchAll(/["""'`](.{4,80}?)["""'`]/g)].map((m) => m[1].trim())
  const tech = text.match(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b|\b[a-z]+[_-][a-z0-9_-]+\b/g) || []
  const proper = text.match(/\b[A-Z][a-záéíóúñ]{2,}\b/g) || []
  const shortTech = (text.toLowerCase().match(SHORT_TECH_RE) || []).map(w => w.toLowerCase())
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
        score += distance <= 2 ? SCORING.fuzzyMatch.close : SCORING.fuzzyMatch.far
        break
      }
    }
  }

  return score
}

function shouldSearch(text) {
  if (MODE === "off" || OPT_OUT.test(text)) return false
  if (MODE === "force" || FORCE.test(text)) return true
  if (text.length < 2) return false

  const keywords = extractKeywords(text)
  return keywords.length > 0
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

  log("rg command:", "rg", args.join(" "))

  try {
    const { stdout, stderr } = await run("rg", args, { timeout: RG_MS, maxBuffer: 512 * 1024 })
    if (stderr) log("rg stderr:", stderr)
    log("rg stdout length:", stdout.length)
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
  } catch (err) {
    log("rg error:", err.message)
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
    let st
    try {
      st = statSync(current)
    } catch {
      continue
    }

    if (st.isDirectory()) {
      const name = current.split("/").pop()
      if (DENY_DIR_NAMES.has(name)) continue
      for (const entry of readdirSync(current)) stack.push(join(current, entry))
      continue
    }

    if (!st.isFile() || !current.endsWith(".md")) continue

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
        return score + (keyword.includes(" ") || keyword.includes("-") || keyword.includes("_") ? SCORING.keywordMatch.multiWord : SCORING.keywordMatch.single)
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
  let score = (forced ? SCORING.forceBonus : 0) + (hit.matchScore || SCORING.baseScore)

  for (const keyword of keywords) {
    const k = keyword.toLowerCase()
    if (haystack.includes(k)) score += k.includes(" ") ? SCORING.keywordBonus.multiWord : SCORING.keywordBonus.single
  }

  const rel = relative(VAULT, hit.file).toLowerCase()
  for (const entry of SCORING.paths) {
    if (rel.includes(entry.pattern)) { score += entry.score; break }
  }

  if (SCORING.exactKeywordMatch.keywords.some(kw => keywords.some(k => k.toLowerCase() === kw.toLowerCase()))) {
    for (const ekw of SCORING.exactKeywordMatch.keywords) {
      if (rel.includes(ekw.toLowerCase())) { score += SCORING.exactKeywordMatch.score; break }
    }
  }

  if (SCORING.longLine.penalty && hit.text.length > SCORING.longLine.threshold) score -= SCORING.longLine.penalty

  try {
    const ageDays = (Date.now() - statSync(hit.file).mtimeMs) / 86_400_000
    for (const tier of (SCORING.recency || [])) {
      if (ageDays <= tier.days) { score += tier.score; break }
    }
  } catch {}

  return score
}

function bestHits(hits, keywords, forced) {
  const seen = new Set()
  const scored = hits.map((hit) => ({ ...hit, score: scoreHit(hit, keywords, forced) }))
  log("scored hits:", scored.map(h => `${relative(VAULT, h.file)}:${h.lineNumber}:${h.score}`))
  return scored
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
  return {
    event: async ({ event }) => {
      if (event?.type === "session.created") cache.clear()
    },
    "chat.message": async (input, output) => {
      const textParts = output.parts.filter(p => p?.type === "text")
      const text = textParts.map(p => p.text || "").join(" ").trim()

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
        output.parts.unshift({
          id: "prt_vault-context-" + Date.now(),
          sessionID: input.sessionID,
          messageID: output.message.id,
          type: "text",
          text: cached.text,
          synthetic: true,
        })
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
      output.parts.unshift({
        id: "prt_vault-context-" + Date.now(),
        sessionID: input.sessionID,
        messageID: output.message.id,
        type: "text",
        text: injected,
        synthetic: true,
      })
      log("injected", hits.map(h => relative(VAULT, h.file) + ":" + h.lineNumber + ":" + h.score))
    },
  }
}
