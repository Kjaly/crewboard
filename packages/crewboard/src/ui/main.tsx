import { createRoot } from 'react-dom/client'
import { httpApi } from './api.js'
import { App } from './app.js'
import { initialLang, setLang } from './text.js'

setLang(initialLang())
const root = document.getElementById('root')
if (root) createRoot(root).render(<App api={httpApi()} />)
