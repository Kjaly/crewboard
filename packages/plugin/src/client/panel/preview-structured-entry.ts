import { renderJson, renderMarkdown } from './preview-structured.js'

declare global { interface Window { __orchStructured?: { renderJson: typeof renderJson; renderMarkdown: typeof renderMarkdown } } }
window.__orchStructured = { renderJson, renderMarkdown }
