import { createContext, useContext, useRef, useState } from 'react'

/** Page-local drafts; the app owns the map so changing panels does not discard them. */
export const Drafts = createContext<Map<string, string> | undefined>(undefined)

export function useDraft(key: string): [string, (text: string) => void] {
  const local = useRef(new Map<string, string>())
  const drafts = useContext(Drafts) ?? local.current
  const [, render] = useState(0)
  return [drafts.get(key) ?? '', (text) => {
    if (text) drafts.set(key, text)
    else drafts.delete(key)
    render((n) => n + 1)
  }]
}
