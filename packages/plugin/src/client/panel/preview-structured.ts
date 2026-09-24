// DOM-only renderers: every file value goes through textContent, so raw HTML is inert.
function append(parent: Element, tag: string, text: string, className?: string): HTMLElement {
  const node = document.createElement(tag)
  node.textContent = text
  if (className) node.className = className
  parent.append(node)
  return node
}

function inline(parent: Element, text: string): void {
  const tokens = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g
  let start = 0
  for (const match of text.matchAll(tokens)) {
    parent.append(document.createTextNode(text.slice(start, match.index)))
    if (match[2]) append(parent, 'strong', match[2])
    else if (match[3]) append(parent, 'code', match[3])
    else if (match[4] && match[5]) {
      const link = /^(https?:\/\/|\/[^/])/.test(match[5]) ? append(parent, 'a', match[4]) : append(parent, 'span', match[4])
      if (link instanceof HTMLAnchorElement) { link.href = match[5]; link.rel = 'noopener noreferrer'; link.target = '_blank' }
    }
    start = match.index! + match[0].length
  }
  parent.append(document.createTextNode(text.slice(start)))
}

export function renderMarkdown(root: Element, text: string): void {
  root.replaceChildren()
  let fence = false
  let code: HTMLElement | undefined
  const lists: HTMLElement[] = []
  for (const line of text.split('\n')) {
    const item = /^(\s*)[-*]\s+(.+)$/.exec(line)
    if (!item) lists.length = 0
    if (line.startsWith('```')) { fence = !fence; code = fence ? append(root, 'pre', '', 'orc-preview-fence') : undefined; continue }
    if (fence) { if (code) code.textContent += line + '\n'; continue }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) { inline(append(root, 'h' + heading[1]!.length, '', 'orc-preview-heading'), heading[2]!); continue }
    if (item) {
      const depth = Math.floor(item[1]!.length / 2)
      while (lists.length > depth + 1) lists.pop()
      while (lists.length <= depth) {
        const parent: Element = lists.length ? lists.at(-1)!.lastElementChild ?? lists.at(-1)! : root
        lists.push(append(parent, 'ul', '', 'orc-preview-list'))
      }
      inline(append(lists.at(-1)!, 'li', ''), item[2]!)
      continue
    }
    inline(append(root, 'p', ''), line || '\u00a0')
  }
}

function jsonNode(root: Element, value: unknown, name?: string): void {
  if (value && typeof value === 'object') {
    const details = document.createElement('details')
    details.open = true
    append(details, 'summary', (name ? name + ' ' : '') + (Array.isArray(value) ? '[' + value.length + ']' : '{' + Object.keys(value).length + '}'))
    const children = append(details, 'div', '', 'orc-preview-tree')
    for (const [key, child] of Object.entries(value)) jsonNode(children, child, key)
    root.append(details)
  } else append(root, 'div', (name ? name + ': ' : '') + JSON.stringify(value))
}

export function renderJson(root: Element, text: string): void {
  root.replaceChildren()
  try { jsonNode(root, JSON.parse(text)) }
  catch (error) { append(root, 'p', String(error), 'orc-meta'); append(root, 'pre', text.slice(0, 200 * 1024), 'orc-code') }
}
