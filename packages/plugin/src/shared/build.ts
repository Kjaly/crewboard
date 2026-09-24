declare const __CREWBOARD_BUILD__: string | undefined

/**
 * One id per build, shared by the host and the browser halves. dsh can reload the page (new client)
 * while its process keeps the previous host, and the two then disagree about the data they exchange.
 */
export const BUILD_ID: string = typeof __CREWBOARD_BUILD__ === 'string' ? __CREWBOARD_BUILD__ : 'dev'
