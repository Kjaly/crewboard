export function compareSemver(a: string, b: string): number {
  const pa = a.trim().split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.trim().split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  return 0
}
