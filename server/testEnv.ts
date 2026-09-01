/**
 * Skip guards for the integration tests in `server/`.
 *
 * Those tests talk to a real MySQL database and real provider APIs. When the
 * credential they need is absent the correct outcome is *skipped*, not failed —
 * a red suite on an unconfigured machine hides real regressions. `.env` is
 * loaded by `vitest.setup.ts` before any of this is read.
 */

/** Names of the given variables that are unset or empty. */
export function missingEnv(...names: string[]): string[] {
  return names.filter(name => {
    const value = process.env[name];
    return !value || value.trim().length === 0;
  });
}

/** True when at least one of `names` is unset — pass to `describe.skipIf`. */
export function unconfigured(...names: string[]): boolean {
  return missingEnv(...names).length > 0;
}

/** Human-readable list for the suite title, e.g. "needs DATABASE_URL". */
export function needs(...names: string[]): string {
  return `needs ${names.join(" + ")}`;
}
