/**
 * «Open dsh settings» (wo1). Crewboard's settings are one section of dsh's Settings dialog, and dsh gives a
 * section no way to switch to another; its navigation lists every section as a button, Models first by
 * dsh's order. This presses the Models entry when it can be found and says so, else the caller shows the path.
 */
const MODELS_LABEL = /^(models|\u043c\u043e\u0434\u0435\u043b\u0438|\u6a21\u578b)$/i

export function openDshModels(from: Document = document): boolean {
  const buttons = [...from.querySelectorAll<HTMLButtonElement>('[role="dialog"] nav button')]
  const models = buttons.find((button) => MODELS_LABEL.test(button.textContent?.trim() ?? ''))
  if (!models) return false
  models.click()
  return true
}
