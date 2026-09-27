const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['coverage/**', 'node_modules/**', 'src/config.js'],
  },
  {
    files: ['src/**/*.js', 'test/**/*.js', '*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: globals.jest,
    },
  },
];
