// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../../src/client/index.js'
import {
  ORCHESTRA_TAB_ID,
  ORCHESTRA_TAB_KIND,
  ORCHESTRA_TAB_LABEL,
  OrchestraTabBody,
  OrchestraTabTitle,
} from '../../src/client/right-pane.js'

afterEach(cleanup)

type Seat = { name: string; options: Record<string, unknown>; component: unknown }

/** Minimal slot face: records the registration and reports injected slot names. */
function fakeSlots() {
  const injected: string[] = []
  const seats: Seat[] = []
  const slots = {
    inject: (slot: string, fn: () => unknown) => {
      injected.push(slot)
      fn()
    },
    register: (options: Record<string, unknown>, component: unknown) => {
      seats.push({ name: String(options.name), options, component })
      return () => {}
    },
  }
  return { slots, injected, seats }
}

describe('right-pane tab registration', () => {
  it('registers the tab type and both keyed seats under our key', () => {
    const { slots, injected, seats } = fakeSlots()
    const definitions: Array<Record<string, unknown>> = []
    const tabs = {
      register: (definition: Record<string, unknown>) => {
        definitions.push(definition)
        return () => {}
      },
    }
    const ctx = {
      get: (n: string) => (n === 'slots' ? slots : undefined),
      inject: (deps: readonly string[], callback: (raw: unknown) => void) => {
        expect(deps).toEqual(['sidebarRightTabs'])
        callback({ sidebarRightTabs: tabs })
      },
    }

    apply(ctx)

    // Stage one: the type itself, under the kind openTab names.
    expect(definitions).toHaveLength(1)
    expect(definitions[0]).toMatchObject({ id: ORCHESTRA_TAB_ID, kind: ORCHESTRA_TAB_KIND })
    expect((definitions[0]!.title as (address: string) => string)(`sidebar://${ORCHESTRA_TAB_KIND}`)).toBe(ORCHESTRA_TAB_LABEL)

    // Stage two: body and live title, both keyed by the definition id.
    expect(injected).toContain('sidebar.right.pane.tab')
    expect(injected).toContain('sidebar.right.pane.tab.title')
    const body = seats.find((seat) => seat.name === 'sidebar.right.pane.tab')
    const title = seats.find((seat) => seat.name === 'sidebar.right.pane.tab.title')
    expect(body?.options).toMatchObject({ name: 'sidebar.right.pane.tab', key: ORCHESTRA_TAB_ID })
    expect(title?.options).toMatchObject({ name: 'sidebar.right.pane.tab.title', key: ORCHESTRA_TAB_ID })
    expect(body?.component).toBe(OrchestraTabBody)
    expect(title?.component).toBe(OrchestraTabTitle)
  })

  it('registers nothing when the right-pane registry is absent, and still boots', () => {
    const { slots, injected } = fakeSlots()
    const ctx = { get: (n: string) => (n === 'slots' ? slots : undefined) }

    expect(() => apply(ctx)).not.toThrow()
    expect(injected).toEqual(['sidebar.panellist', 'main', 'settings.section'])
  })

  it('renders the real panel and the russian chip label', () => {
    // Without slot props the body cannot learn the workspace — it says so instead of guessing.
    setLang('ru')
    render(
      <>
        <OrchestraTabBody />
        <OrchestraTabTitle />
      </>,
    )
    expect(screen.getByText(/рабочую папку чата/)).toBeTruthy()
    expect(screen.getByText('Оркестрация')).toBeTruthy()
  })
})
