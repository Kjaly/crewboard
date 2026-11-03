/** Error messages cross into the journal and lead inbox: remove credentials before bounding their length. */
export function failureText(text: string): string {
  return text
    .replace(/\bBearer\s+[^\s"'`,;]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[a-z0-9_-]+/gi, '[redacted]')
    .replace(/\b((?:[a-z_][a-z0-9_]*)?KEY\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
    .slice(0, 500)
}
