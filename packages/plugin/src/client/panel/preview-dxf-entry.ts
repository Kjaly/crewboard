import { renderDxf } from './preview-dxf.js'

declare global { interface Window { __orchRenderDxf?: typeof renderDxf } }
window.__orchRenderDxf = renderDxf
