// Checks in a tight loop that every given file exists until the stop file appears, then prints how many
// rounds it made and how many found a file missing. Runs as its own process so a build can run meanwhile.
import { existsSync } from 'node:fs'

const [stop, ...files] = process.argv.slice(2)
let rounds = 0
let misses = 0
process.stdout.write('ready\n')
while (!existsSync(stop)) {
  rounds += 1
  if (!files.every((file) => existsSync(file))) misses += 1
}
process.stdout.write(`${JSON.stringify({ rounds, misses })}\n`)
