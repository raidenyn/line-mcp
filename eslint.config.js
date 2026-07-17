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
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
