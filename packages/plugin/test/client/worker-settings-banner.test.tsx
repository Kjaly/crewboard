// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLang } from '../../src/client/i18n.js'
import { WorkerSettingsBanner } from '../../src/client/worker-settings-banner.js'

beforeEach(() => setLang('en'))
afterEach(() => cleanup())

it('names the classes that fell back to defaults and opens worker settings', () => {
  const open = vi.fn()
  render(<WorkerSettingsBanner issue={{ code: 'incomplete', classes: ['code', 'review'], path: '/h/.config/crewboard/profiles.json' }} onOpenSettings={open} />)
  const alert = screen.getByRole('alert')
  expect(alert.textContent).toContain('Code ready to build, Review')
  expect(alert.textContent).toContain('profiles.json')
  fireEvent.click(screen.getByRole('button', { name: 'Open worker settings' }))
  expect(open).toHaveBeenCalledOnce()
})

it('says an unreadable file is damaged, in Russian too, and renders nothing without an issue', () => {
  setLang('ru')
  const { rerender } = render(<WorkerSettingsBanner issue={{ code: 'unreadable', detail: 'Unexpected token' }} onOpenSettings={() => {}} />)
  expect(screen.getByRole('alert').textContent).toContain('Настройки воркеров повреждены')
  expect(screen.getByRole('alert').textContent).toContain('Unexpected token')
  rerender(<WorkerSettingsBanner issue={undefined} onOpenSettings={() => {}} />)
  expect(screen.queryByRole('alert')).toBeNull()
})
