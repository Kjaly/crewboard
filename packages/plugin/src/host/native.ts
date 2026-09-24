import type { Exec } from '@crewboard/core'

export type Native = {
  confirm(title: string, message: string, okLabel: string, cancelLabel?: string): Promise<boolean>
  notify(title: string, message: string): Promise<void>
}

// User-visible text travels only as argv items of the AppleScript run handler: nothing typed by a
// user or an agent is ever interpolated into the script source.
const DIALOG = [
  'on run argv',
  'set r to display dialog (item 2 of argv) with title (item 1 of argv) buttons {(item 4 of argv), (item 3 of argv)} default button (item 4 of argv) cancel button (item 4 of argv) giving up after 120',
  'return button returned of r',
  'end run',
]
const NOTIFICATION = ['on run argv', 'display notification (item 2 of argv) with title (item 1 of argv)', 'end run']
const script = (lines: string[]) => lines.flatMap((line) => ['-e', line])

export function macNative(exec: Exec, platform: NodeJS.Platform = process.platform): Native {
  if (platform !== 'darwin') {
    return { confirm: async () => false, notify: async () => {} }
  }
  return {
    async confirm(title, message, okLabel, cancelLabel = 'Cancel') {
      const r = await exec('osascript', [...script(DIALOG), title, message, okLabel, cancelLabel], { timeoutMs: 130_000 })
      return r.code === 0 && r.stdout.trim() === okLabel
    },
    async notify(title, message) {
      await exec('osascript', [...script(NOTIFICATION), title, message], { timeoutMs: 10_000 })
    },
  }
}
