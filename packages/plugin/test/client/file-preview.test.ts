// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { parseDelimited, previewKind } from '../../src/client/panel/file-preview.js'
import { parseDxf, renderDxf } from '../../src/client/panel/preview-dxf.js'
import { renderJson, renderMarkdown } from '../../src/client/panel/preview-structured.js'

describe('file preview', () => {
  it('selects previewers by extension', () => {
    expect(previewKind('shot.PNG')).toBe('image')
    expect(previewKind('drawing.dxf')).toBe('dxf')
    expect(previewKind('report.html')).toBe('html')
    expect(previewKind('script.ts')).toBe('diff')
  })
  it('parses quoted CSV and TSV fields', () => {
    expect(parseDelimited('name,note\n"A,B","said ""hi"""\n', ',')).toEqual([['name', 'note'], ['A,B', 'said "hi"']])
    expect(parseDelimited('a\tb\n1\t2', '\t')).toEqual([['a', 'b'], ['1', '2']])
  })
  it('renders supported DXF entities and counts unsupported ones', () => {
    const entity = (type: string, pairs: Array<[number, string]>) => ['0', type, ...pairs.flatMap(([code, value]) => [String(code), value])].join('\n')
    const dxf = ['0', 'SECTION', '2', 'ENTITIES',
      entity('LINE', [[10, '0'], [20, '0'], [11, '10'], [21, '10']]),
      entity('LWPOLYLINE', [[10, '0'], [20, '0'], [10, '10'], [20, '10']]),
      entity('POLYLINE', []), entity('VERTEX', [[10, '1'], [20, '2']]), entity('SEQEND', []),
      entity('CIRCLE', [[10, '5'], [20, '5'], [40, '2']]),
      entity('ARC', [[10, '5'], [20, '5'], [40, '2'], [50, '0'], [51, '90']]),
      entity('TEXT', [[10, '1'], [20, '1'], [1, 'label']]),
      entity('MTEXT', [[10, '1'], [20, '1'], [1, 'multi']]),
      entity('SPLINE', []), '0', 'ENDSEC'].join('\n')
    expect(parseDxf(dxf).unsupported).toEqual({ SPLINE: 1 })
    const svg = renderDxf(dxf)
    for (const tag of ['<line', '<polyline', '<circle', '<path', '<text']) expect(svg).toContain(tag)
    expect(svg).toContain('1 entities not shown: SPLINE ×1')
  })
  it('renders markdown and JSON without activating raw HTML', () => {
    const root = document.createElement('div')
    renderMarkdown(root, '# Heading\n<script>alert(1)</script>\n```mermaid\ngraph TD\n```')
    expect(root.querySelector('script')).toBeNull()
    expect(root.textContent).toContain('graph TD')
    renderJson(root, '{"name":"<img src=x>"}')
    expect(root.querySelector('img')).toBeNull()
    expect(root.textContent).toContain('<img src=x>')
    renderJson(root, '{bad')
    expect(root.textContent).toContain('SyntaxError')
  })
  it('renders inline code in list items and indents nested items', () => {
    const root = document.createElement('div')
    renderMarkdown(root, '- Run `pnpm test`\n  - Check `status`')
    expect([...root.querySelectorAll('li code')].map((node) => node.textContent)).toEqual(['pnpm test', 'status'])
    expect(root.querySelector('ul > li > ul > li code')?.textContent).toBe('status')
    expect(root.textContent).not.toContain('`')
  })
})
