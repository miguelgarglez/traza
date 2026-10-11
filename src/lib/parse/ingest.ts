import type { Session, SourceFile, Weave } from '../model.ts'
import { sniff, type Format } from './sniff.ts'
import { parseAtif } from './atif.ts'
import { parseDevinNodes, type DevinSessionMeta } from './devin.ts'
import { parseCodexRollout } from './codex.ts'
import { parseCursorMessages, type CursorMeta } from './cursor.ts'
import { countSecrets } from '../redact.ts'

export interface DroppedFile {
  path: string
  text: string
}

interface ManifestEntry {
  agent?: string
  id?: string
  title?: string
  cwd?: string
}

function dir(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

function allText(s: Session): string {
  const parts: string[] = []
  for (const t of s.threads)
    for (const st of t.steps) {
      if (st.title) parts.push(st.title)
      if (st.body) parts.push(st.body)
      if (st.thinking) parts.push(st.thinking)
      for (const c of st.calls ?? []) {
        if (c.args) parts.push(c.args)
        if (c.result) parts.push(c.result)
      }
    }
  return parts.join('\n')
}

export function ingest(files: DroppedFile[]): Weave {
  const sniffed = files.map((f) => ({ ...f, format: sniff(f.path, f.text) as Format }))
  const byPath = new Map(sniffed.map((f) => [f.path, f]))
  const sessions: Session[] = []
  const out: SourceFile[] = []
  const consumed = new Set<string>()
  let manifestTitles = new Map<string, ManifestEntry>()

  // First pass: manifests give us titles.
  for (const f of sniffed) {
    if (f.format !== 'manifest') continue
    consumed.add(f.path)
    try {
      const m = JSON.parse(f.text) as { sessions?: ManifestEntry[] }
      manifestTitles = new Map((m.sessions ?? []).map((s) => [String(s.id ?? ''), s]))
      out.push({ path: f.path, format: 'manifest', ok: true, note: `${m.sessions?.length ?? 0} sessions indexed` })
    } catch {
      out.push({ path: f.path, format: 'manifest', ok: false, note: 'could not read the manifest' })
    }
  }

  const metaFor = (p: string, name: string): Record<string, unknown> | undefined => {
    const sib = byPath.get(`${dir(p)}/${name}`) ?? byPath.get(name)
    if (!sib) return undefined
    consumed.add(sib.path)
    try {
      return JSON.parse(sib.text) as Record<string, unknown>
    } catch {
      return undefined
    }
  }

  const applyTitle = (s: Session) => {
    const rawId = s.id.replace(/^\w+-/, '')
    const hit = manifestTitles.get(rawId) ?? manifestTitles.get(s.id)
    if (hit?.title) s.title = hit.title
    if (hit?.cwd && !s.cwd) s.cwd = hit.cwd
  }

  for (const f of sniffed) {
    if (consumed.has(f.path)) continue
    try {
      switch (f.format) {
        case 'atif': {
          const s = parseAtif(f.path, f.text)
          sessions.push(s)
          out.push({ path: f.path, format: f.format, ok: true })
          break
        }
        case 'devin-nodes': {
          const meta = metaFor(f.path, 'session.json') as DevinSessionMeta | undefined
          const { session } = parseDevinNodes(f.path, f.text, meta)
          applyTitle(session)
          if (meta) session.files.push(`${dir(f.path)}/session.json`)
          sessions.push(session)
          out.push({ path: f.path, format: f.format, ok: true })
          break
        }
        case 'codex-rollout': {
          const s = parseCodexRollout(f.path, f.text)
          applyTitle(s)
          sessions.push(s)
          out.push({ path: f.path, format: f.format, ok: true })
          break
        }
        case 'cursor-messages': {
          const meta = metaFor(f.path, 'meta.json') as CursorMeta | undefined
          const s = parseCursorMessages(f.path, f.text, meta)
          applyTitle(s)
          if (meta) sessionFiles(s, f.path, 'meta.json')
          sessions.push(s)
          out.push({ path: f.path, format: f.format, ok: true })
          break
        }
        case 'sqlite':
          out.push({ path: f.path, format: f.format, ok: false, note: "sqlite store — can't weave raw databases yet; decode it with lab-sessions-export first" })
          break
        case 'devin-session':
        case 'cursor-meta':
          out.push({ path: f.path, format: f.format, ok: true, note: 'metadata — woven into its sibling file if present' })
          break
        default:
          out.push({ path: f.path, format: 'scrap', ok: false, note: "this file isn't thread — nothing in it looks like a session" })
      }
    } catch (e) {
      out.push({ path: f.path, format: f.format, ok: false, note: `tore while reading: ${(e as Error).message.slice(0, 120)}` })
    }
    consumed.add(f.path)
  }

  sessions.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity))

  const stats = { sessions: sessions.length, steps: 0, calls: 0, tokIn: 0, tokOut: 0, costUsd: 0, redactions: 0, branches: 0 }
  for (const s of sessions) {
    stats.redactions += countSecrets(allText(s))
    for (const t of s.threads) {
      if (t.kind === 'branch') stats.branches++
      for (const st of t.steps) {
        stats.steps++
        stats.calls += st.calls?.length ?? 0
        stats.tokIn += st.tokens?.input ?? 0
        stats.tokOut += st.tokens?.output ?? 0
        stats.costUsd += st.tokens?.costUsd ?? 0
      }
    }
  }
  if (!stats.costUsd) delete (stats as { costUsd?: number }).costUsd
  return { sessions, files: out, stats }
}

function sessionFiles(s: Session, p: string, name: string) {
  const d = dir(p)
  const fp = d ? `${d}/${name}` : name
  if (!s.files.includes(fp)) s.files.push(fp)
}
