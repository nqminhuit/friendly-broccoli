# cim vendor — js-yaml 5.4.3 (browser UMD, unmodified)

- Version: 5.4.3 (official npm latest, MIT)
- Source tarball: https://registry.npmjs.org/js-yaml/-/js-yaml-5.4.3.tgz
- Tarball integrity (SRI): `sha512-yzzNtgczwgoVHNigCyKTXcQJU4Y8t/ikU4UxXW0BvrLfHTGWZhsNcOT2s/a7vn81/4KqVnNmHjaUEPlvWnNwVw==`
- Artifact: `js-yaml.umd.min.js` copied unmodified from `package/dist/browser/js-yaml.umd.min.js`
- Artifact checksum (sha256): `0a0f83f2efe2c58ef6ee47815b7597e9354c9baa5dd05f17f10ae653983256de`
- License: MIT, see `LICENSE` (copied unmodified from `package/LICENSE`)
- Upstream docs: https://nodeca.github.io/js-yaml/doc/interfaces/LoadOptions.html and Safety notes; v5 `load` uses `CORE_SCHEMA` (YAML 1.2 keeps `on` as string), `schema.withTags([mergeTag])` only for `<<` merges, `maxDepth: 50`, `maxAliases: 100`, `maxTotalMergeKeys: 10000`; no executable tags are enabled.
- No npm install, build step, CDN, or extra host permissions; loaded as a classic script before `workflow-schema.js`.
