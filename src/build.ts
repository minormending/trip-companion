/**
 * Which build this is, as the user would read it out.
 *
 * The same rule orchard-map and restroom-map use, and deliberately the same
 * wording: a count renders as a version, and anything else — a git-less build
 * from a tarball — is shown as-is so it cannot be mistaken for one. A wrong
 * version is worse than an obviously missing one when the whole point is
 * reading it out when something looks wrong.
 *
 * Copied rather than imported from `@minormending/map-kit`, which exports this
 * exact function. Its root entry also pulls in a React hook, and this app has
 * no React: importing two lines would put the library in the bundle and in the
 * build script's module graph. The package has no subpath export for it.
 */
export const buildLabel = (buildId: string): string =>
  /^\d+$/.test(buildId) ? `v${buildId}` : buildId
