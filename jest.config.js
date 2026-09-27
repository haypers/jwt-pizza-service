/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.js'],
  collectCoverageFrom: ['src/**/*.js', '!src/config.js'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'json-summary', 'lcov'],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  clearMocks: true,
};
