import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * `orch` and dsh run straight from the built output of the main checkout, so a build that empties the
 * output directory first leaves them without files for as long as it runs. The build writes into a fresh
 * directory next to the target instead and swaps it in whole: at every moment the target is either the
 * complete old build or the complete new one, and nothing from an older build survives the swap. A failed
 * build removes its own directory and leaves the previous output untouched.
 */
export async function buildAtomically(target, write) {
  const out = resolve(target)
  const next = await mkdtemp(join(dirname(out), `.${basename(out)}-next-`))
  try {
    // mkdtemp creates 0700; the output is read by dsh and by the published tarball like any directory.
    await chmod(next, 0o755)
    await write(next)
    await replaceDirectory(next, out)
  } finally {
    // After a swap this is the previous build; after a failure, the half-written one.
    await rm(next, { recursive: true, force: true })
  }
}

// rename(2) moves a directory onto an empty one only, so replacing a full one takes the kernel's exchange:
// renamex_np(RENAME_SWAP) on macOS, renameat2(RENAME_EXCHANGE) on Linux. Node has no binding for either;
// ctypes reaches them without a native addon.
const SWAP = `
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
a, b = (os.fsencode(p) for p in sys.argv[1:3])
if sys.platform == 'darwin':
    r = libc.renamex_np(a, b, ctypes.c_uint(2))
else:
    r = libc.renameat2(-100, a, -100, b, ctypes.c_uint(2))
if r != 0:
    sys.exit(os.strerror(ctypes.get_errno()))
`

async function replaceDirectory(next, out) {
  try {
    await rename(next, out)
    return
  } catch (error) {
    if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error
  }
  try {
    execFileSync('python3', ['-c', SWAP, next, out], { stdio: ['ignore', 'ignore', 'pipe'] })
    return
  } catch (error) {
    // Without python3 or the exchange call the build still never empties the target for its whole run;
    // only the two renames below are apart, and the note says so.
    console.warn(`${basename(out)}: atomic swap unavailable (${String(error.stderr ?? error.message).trim()}); replacing with two renames`)
  }
  const old = `${next}-old`
  await rename(out, old)
  await rename(next, out)
  await rename(old, next)
}
