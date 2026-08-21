/**
 * The one place this package's version is written for the RUNTIME.
 *
 * Its own module rather than an import of `package.json`: a JSON import
 * resolves differently under ESM, CJS and a bundler, and `package.json` is
 * not shipped inside `dist/` — so the import that typechecks here would be
 * the one that throws in a consumer's build.
 *
 * `package.json` still owns the version npm publishes. The two are the same
 * literal in two files, so version.test.ts asserts them equal — that gate,
 * not a convention, is what stops them drifting the first time a release is
 * cut in a hurry.
 */
export const VERSION = "0.3.0";
