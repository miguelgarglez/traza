// Display-time redaction. Source text is never altered; patterns are replaced
// with woven patches at render time.

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/g },
  { name: 'openai key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'stripe key', re: /\b[sr]k_(live|test)_[A-Za-z0-9]{12,}\b/g },
  { name: 'supabase service', re: /\bsbp_[a-f0-9]{20,}\b/g },
  { name: 'supabase key', re: /\bsb_(publishable|secret)_[A-Za-z0-9_-]{16,}\b/g },
  { name: 'vercel key', re: /\bvck_[A-Za-z0-9]{20,}\b/g },
  { name: 'github pat', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g },
  { name: 'github fine pat', re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g },
  { name: 'slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'generic bearer', re: /\b((?:bearer|token|api[_-]?key|secret|password)\s*[=:]\s*["']?)[A-Za-z0-9_\-\.]{24,}["']?/gi },
]

export function redactText(text: string): { text: string; hits: { name: string }[] } {
  const hits: { name: string }[] = []
  let out = text
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0
    out = out.replace(re, (_m, g1) => {
      hits.push({ name })
      // For key=value matches keep the "key=" prefix so context survives.
      const keep = name === 'generic bearer' && g1 ? g1 : ''
      return `${keep}⟪${name}⟫`
    })
  }
  return { text: out, hits }
}

export function countSecrets(text: string): number {
  let n = 0
  for (const { re } of PATTERNS) {
    re.lastIndex = 0
    n += (text.match(re) || []).length
    re.lastIndex = 0
  }
  return n
}
