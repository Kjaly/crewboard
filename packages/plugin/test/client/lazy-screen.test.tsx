// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { lazyScreen } from '../../src/client/lazy-screen.js'

const Probe = lazyScreen<{ label: string }>('probe', 'Probe')
afterEach(() => { cleanup(); delete globalThis.__orchScreenBundles?.probe })

it('shows loading, reports a failed asset, and retries the same screen', async () => {
  render(<Probe label="ready" />)
  expect(screen.getByRole('status').textContent).toContain('Loading screen')
  const first = document.head.querySelector<HTMLScriptElement>('script[src*="screen-probe"]')!
  first.dispatchEvent(new Event('error'))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Screen unavailable'))
  screen.getByRole('button', { name: 'Retry' }).click()
  await waitFor(() => expect(document.head.querySelectorAll('script[src*="screen-probe"]').length).toBe(2))
  globalThis.__orchScreenBundles ??= {}
  globalThis.__orchScreenBundles.probe = { Probe: ({ label }: { label: string }) => <strong>{label}</strong> }
  document.head.querySelectorAll<HTMLScriptElement>('script[src*="screen-probe"]')[1]!.dispatchEvent(new Event('load'))
  await waitFor(() => expect(screen.getByText('ready')).toBeTruthy())
})
