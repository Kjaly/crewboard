// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetNotifySettings } from '../../src/client/attention.js'
import { setLang } from '../../src/client/i18n.js'
import { NotifySettings } from '../../src/client/notify-settings.js'

function defineNotification(permission: NotificationPermission, onChange?: () => NotificationPermission): { requests: number } {
  const state = { requests: 0 }
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    writable: true,
    value: {
      get permission() {
        return permission
      },
      async requestPermission() {
        state.requests++
        permission = onChange ? onChange() : permission
        return permission
      },
    },
  })
  return state
}

beforeEach(() => {
  setLang('ru')
  localStorage.clear()
  resetNotifySettings()
})

afterEach(() => {
  cleanup()
  resetNotifySettings()
  delete (globalThis as { Notification?: unknown }).Notification
})

describe('notification settings control', () => {
  it('shows the current permission and asks only from the explicit button', async () => {
    const user = userEvent.setup()
    const notification = defineNotification('default', () => 'granted')
    render(<NotifySettings />)
    expect(screen.getByRole('radiogroup', { name: 'Уведомления' })).toBeTruthy()
    expect(screen.getByText('Разрешение: не запрошено')).toBeTruthy()
    expect(notification.requests).toBe(0)

    await user.click(screen.getByRole('radio', { name: 'В браузере' }))
    const allow = screen.getByRole('button', { name: 'Разрешить уведомления в браузере' })
    expect(notification.requests).toBe(0)

    await user.click(allow)
    expect(notification.requests).toBe(1)
    expect(screen.queryByRole('button', { name: 'Разрешить уведомления в браузере' })).toBeNull()
    expect(screen.getByText('Разрешение: разрешено')).toBeTruthy()
  })

  it('explains a denial instead of offering another ask', () => {
    defineNotification('denied')
    resetNotifySettings()
    render(<NotifySettings />)
    expect(screen.getByText(/Уведомления заблокированы/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Разрешить уведомления в браузере' })).toBeNull()
  })

  it('says when the browser cannot notify at all', () => {
    // No Notification global at all: the control must still render and explain itself.
    render(<NotifySettings />)
    expect(screen.getByText(/не поддерживается браузером/)).toBeTruthy()
  })
})
