import { type RefObject, useLayoutEffect, useRef } from 'react'

/** Mobile panels share a focus boundary; desktop panels keep their usual behaviour. */
export function useModal(ref: RefObject<HTMLElement>, active: boolean, onClose: () => void) {
  const close = useRef(onClose)
  close.current = onClose
  useLayoutEffect(() => {
    const panel = ref.current
    if (!active || !panel) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const inert: Array<{ el: HTMLElement; had: boolean }> = []
    for (let child: HTMLElement = panel; child.parentElement; child = child.parentElement) {
      for (const sibling of child.parentElement.children) {
        if (!(sibling instanceof HTMLElement) || sibling === child || sibling.matches('.scrim, [role="status"]')) continue
        inert.push({ el: sibling, had: sibling.hasAttribute('inert') })
        sibling.setAttribute('inert', '')
      }
    }
    const focusable = () => Array.from(panel.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [tabindex]')).filter((el) =>
      el.tabIndex >= 0 && !el.matches(':disabled') && !el.closest('[inert], [hidden]') && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden',
    )
    const keydown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close.current()
      }
      if (e.key !== 'Tab') return
      const items = focusable()
      const first = items[0] ?? panel
      const last = items.at(-1) ?? panel
      if (!panel.contains(document.activeElement) || (e.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      }
    }
    ;(focusable()[0] ?? panel).focus()
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('keydown', keydown)
      for (const { el, had } of inert) if (!had) el.removeAttribute('inert')
      // React restores the pre-commit focus after layout cleanup; return it once that commit is over.
      queueMicrotask(() => {
        if (opener?.isConnected && !opener.closest('[inert]')) opener.focus()
      })
    }
  }, [active, ref])
}
