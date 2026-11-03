// The bundlers inline these files as text: esbuild through scripts/build.mjs, Vite/Vitest through `?raw`.
declare module '*.svg?raw' {
  const content: string
  export default content
}
