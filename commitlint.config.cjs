// eslint-disable-next-line no-undef -- commitlint loads CommonJS configuration
module.exports = {
  defaultIgnores: false,
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'refactor', 'test', 'docs', 'chore', 'ci', 'build', 'perf'],
    ],
  },
};