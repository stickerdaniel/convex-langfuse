# Publishing

The package is published to npm as `@stickerdaniel/convex-langfuse` by the
`Release` workflow (`.github/workflows/release.yml`), through npm trusted
publishing. No npm token is involved: the publish job proves its identity to npm
with a GitHub OIDC token. npm's package settings name the repository
`stickerdaniel/convex-langfuse`, the workflow `release.yml` and the environment
`npm` as the trusted publisher, with `npm publish` allowed. Until that entry
exists, the workflow cannot publish (issue #14).

Only repository admins can create, move or delete a `v*` tag, and only a `v*`
tag may deploy to the environment `npm`.

## Releasing a version

1. In a pull request, set the new version with
   `npm version <patch|minor|major> --no-git-tag-version`. The `version` script
   writes it into `src/shared/version.ts`, the OTLP scope version. Add a section
   for it at the top of `CHANGELOG.md`.
2. Merge the pull request once its checks pass.
3. Tag the merge commit and push the tag:

   ```sh
   git tag -a v0.1.2 <merge commit> -m v0.1.2
   git push origin v0.1.2
   ```

The workflow runs the tests and packs a clean build. It checks that the tag
names the package version, which must be a stable version, that the tarball
holds every file of the `exports` map and none of the excluded test files, and
that a project which installs it can load both runtime entries. Then it
publishes the tarball. A version that is already on npm is skipped. Create the
GitHub release from the changelog section afterwards.

## Checking a tarball by hand

```sh
rm -rf dist ./*.tsbuildinfo
npm pack
```

Install the `.tgz` file in another project with `npm install ./<file>.tgz`.
Remove `*.tsbuildinfo` with `dist`: a leftover build info file makes `tsc` skip
unchanged files, and the tarball misses them.
