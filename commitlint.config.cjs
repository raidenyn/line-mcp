// eslint-disable-next-line no-undef -- commitlint loads CommonJS configuration
module.exports = {
  defaultIgnores: false,
  // GitHub's "Update branch" and Git's own merge commits are generated, not
  // authored, so they are exempt from the message policy.
  ignores: [(message) => /^Merge (branch|pull request|remote-tracking branch)\b/.test(message)],
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'refactor', 'test', 'docs', 'chore', 'ci', 'build', 'perf'],
    ],
  },
};
