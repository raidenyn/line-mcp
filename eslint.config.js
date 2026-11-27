// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef -- eslint.config.js is CommonJS; require/module aren't declared as globals for this file
const js = require('@eslint/js');
// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef -- eslint.config.js is CommonJS; require/module aren't declared as globals for this file
const tseslint = require('typescript-eslint');

// eslint-disable-next-line no-undef -- module is not declared as a global for this file
module.exports = tseslint.config(
  {
    ignores: [
      '**/dist/**',
      'node_modules/**',
      'package/**',
      // Vendored/generated JS run outside the TS project (npm lifecycle
      // scripts, extracted third-party sandboxes) — not part of this repo's
      // authored TypeScript source, so it's excluded from the same-rules
      // linting the rest of the workspace gets.
      'packages/line-client/assets/ltsm/ltsmSandbox.js',
      'packages/line-client/scripts/vendor-happy-dom.js',
      // Agent harness tools copied from the published catalog: never edited in
      // this repo (their `check` in CI fails on any change), so they cannot be
      // fixed to its lint rules.
      '.agents/harness/**',
    ],
  },
  js.configs.recommended,
  // Untyped rules stay on for everything else (JS config, scripts, tests).
  // A typed project for tests would need a lint-only tsconfig per package
  // (the build tsconfigs exclude *.test.ts) plus one for the root tests.
  // Keeping them untyped holds lint at ~6.5 s instead of ~19 s, at the cost of
  // no type-aware floating-promise checks in tests.
  ...tseslint.configs.recommended,
  {
    files: ['packages/*/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        // eslint-disable-next-line no-undef -- eslint.config.js is CommonJS; __dirname is the repo root, which projectService needs as the tsconfig search start
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // Explicit even though recommendedTypeChecked already enables both:
      // these are the async-safety rules this config exists to guarantee.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
