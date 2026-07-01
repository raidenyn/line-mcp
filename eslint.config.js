// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef -- eslint.config.js is CommonJS; require/module aren't declared as globals for this file
const js = require('@eslint/js');
// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef -- eslint.config.js is CommonJS; require/module aren't declared as globals for this file
const tseslint = require('typescript-eslint');

// eslint-disable-next-line no-undef -- module is not declared as a global for this file
module.exports = tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'package/**', 'src/ltsm/ltsmSandbox.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
