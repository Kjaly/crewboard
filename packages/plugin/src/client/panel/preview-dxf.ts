type Entity = { type: string; values: Map<number, string[]> }
const escapeXml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

export function parseDxf(text: string): { entities: Entity[]; unsupported: Record<string, number> } {
  const lines = text.replace(/\r/g, '').split('\n')
  const entities: Entity[] = [], unsupported: Record<string, number> = {}
  let section = '', entity: Entity | undefined
  const flush = () => {
    if (!entity) return
    if (['LINE', 'LWPOLYLINE', 'POLYLINE', 'VERTEX', 'SEQEND', 'CIRCLE', 'ARC', 'TEXT', 'MTEXT'].includes(entity.type)) entities.push(entity)
    else unsupported[entity.type] = (unsupported[entity.type] ?? 0) + 1
  }
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]!.trim()), value = lines[i + 1]!.trim()
    if (code === 0) {
      flush(); entity = undefined
      if (value === 'ENDSEC') section = ''
      else if (section === 'ENTITIES' && value !== 'SECTION') entity = { type: value, values: new Map() }
    } else if (code === 2 && value === 'ENTITIES') section = 'ENTITIES'
    else if (entity) entity.values.set(code, [...(entity.values.get(code) ?? []), value])
  }
  flush()
  return { entities, unsupported }
}

export function renderDxf(text: string, notShown = 'entities not shown'): string {
  const { entities, unsupported } = parseDxf(text)
  const parts: string[] = [], xs: number[] = [], ys: number[] = []
  const val = (e: Entity, code: number, index = 0) => {
    const number = Number(e.values.get(code)?.[index] ?? 0)
    return Number.isFinite(number) ? number : 0
  }
  const point = (x: number, y: number) => { xs.push(x); ys.push(y); return x + ',' + -y }
  let poly: string[] = []
  for (const e of entities) {
    if (e.type === 'VERTEX') { poly.push(point(val(e, 10), val(e, 20))); continue }
    if (e.type === 'SEQEND') { if (poly.length) parts.push('<polyline points="' + poly.join(' ') + '"/>'); poly = []; continue }
    if (e.type === 'POLYLINE') { poly = []; continue }
    if (e.type === 'LINE') parts.push('<line x1="' + val(e, 10) + '" y1="' + -val(e, 20) + '" x2="' + val(e, 11) + '" y2="' + -val(e, 21) + '"/>'), point(val(e, 10), val(e, 20)), point(val(e, 11), val(e, 21))
    if (e.type === 'LWPOLYLINE') {
      const x = e.values.get(10) ?? []
      const points = x.map((_v, i) => point(val(e, 10, i), val(e, 20, i)))
      parts.push('<polyline points="' + points.join(' ') + '" ' + ((val(e, 70) & 1) ? 'fill="none"' : '') + '/>')
    }
    if (e.type === 'CIRCLE' || e.type === 'ARC') {
      const x = val(e, 10), y = val(e, 20), r = Math.abs(val(e, 40))
      point(x - r, y - r); point(x + r, y + r)
      if (e.type === 'CIRCLE') parts.push('<circle cx="' + x + '" cy="' + -y + '" r="' + r + '"/>')
      else {
        const start = val(e, 50) * Math.PI / 180, end = val(e, 51) * Math.PI / 180
        const a = point(x + r * Math.cos(start), y + r * Math.sin(start)), b = point(x + r * Math.cos(end), y + r * Math.sin(end))
        const large = ((val(e, 51) - val(e, 50) + 360) % 360) > 180 ? 1 : 0
        parts.push('<path d="M ' + a.replace(',', ' ') + ' A ' + r + ' ' + r + ' 0 ' + large + ' 0 ' + b.replace(',', ' ') + '"/>')
      }
    }
    if (e.type === 'TEXT' || e.type === 'MTEXT') {
      const x = val(e, 10), y = val(e, 20); point(x, y)
      parts.push('<text x="' + x + '" y="' + -y + '" font-size="' + Math.max(1, val(e, 40)) + '">' + escapeXml([...(e.values.get(1) ?? []), ...(e.values.get(3) ?? [])].join(' ')) + '</text>')
    }
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let i = 0; i < xs.length; i++) {
    minX = Math.min(minX, xs[i]!); maxX = Math.max(maxX, xs[i]!)
    minY = Math.min(minY, -ys[i]!); maxY = Math.max(maxY, -ys[i]!)
  }
  if (!xs.length) { minX = 0; maxX = 100; minY = 0; maxY = 100 }
  const list = Object.entries(unsupported).map(([name, count]) => escapeXml(name) + ' ×' + count).join(', ')
  const count = Object.values(unsupported).reduce((a, b) => a + b, 0)
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + [minX - 10, minY - 10, maxX - minX + 20, maxY - minY + 20].join(' ') + '" role="img" style="width:100%;height:400px;touch-action:none" fill="none" stroke="currentColor"><g>' + parts.join('') + '</g></svg>' + (count ? '<p>' + count + ' ' + escapeXml(notShown) + ': ' + list + '</p>' : '')
}
