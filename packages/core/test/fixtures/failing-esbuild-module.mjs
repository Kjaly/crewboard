import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

let calls = 0

export async function build({ outfile }) {
  calls += 1
  if (calls > 1) throw new Error('injected build failure')
  await mkdir(dirname(outfile), { recursive: true })
  await writeFile(outfile, 'half-written')
}

export async function transform(code) {
  return { code }
}
