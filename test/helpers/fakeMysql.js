
function createFakeConnection() {
  return {
    execute: jest.fn(async (sql) => {
      if (String(sql).includes('INFORMATION_SCHEMA')) {
        return [[{ SCHEMA_NAME: 'pizza' }], []];
      }
      return [[], []];
    }),
    query: jest.fn(async () => [{}, undefined]),
    end: jest.fn(async () => undefined),
    beginTransaction: jest.fn(async () => undefined),
    commit: jest.fn(async () => undefined),
    rollback: jest.fn(async () => undefined),
  };
}

module.exports = { createFakeConnection };
