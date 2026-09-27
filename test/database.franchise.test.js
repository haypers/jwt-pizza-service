const { createFakeConnection } = require('./helpers/fakeMysql');

const mockConnection = createFakeConnection();

jest.mock('mysql2/promise', () => ({
  createConnection: jest.fn(async () => mockConnection),
}));

jest.mock('bcrypt', () => ({
  hash: jest.fn(async (value) => `hashed-${value}`),
  compare: jest.fn(async (value, hash) => hash === `hashed-${value}`),
}));

const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const config = require('../src/config.js');
const { StatusCodeError } = require('../src/endpointHelper.js');
const { tableCreateStatements } = require('../src/database/dbModel.js');
const { DB } = require('../src/database/database.js');

const ADMIN_SQL = `SELECT u.id, u.name, u.email FROM userRole AS ur JOIN user AS u ON u.id=ur.userId WHERE ur.objectId=? AND ur.role='franchisee'`;
const REVENUE_SQL = `SELECT s.id, s.name, COALESCE(SUM(oi.price), 0) AS totalRevenue FROM dinerOrder AS do JOIN orderItem AS oi ON do.id=oi.orderId RIGHT JOIN store AS s ON s.id=do.storeId WHERE s.franchiseId=? GROUP BY s.id`;
const STORE_SQL = `SELECT id, name FROM store WHERE franchiseId=?`;
const ROLE_ID_SQL = `SELECT objectId FROM userRole WHERE role='franchisee' AND userId=?`;
const SCHEMA_SQL = `SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?`;
const USER_INSERT_SQL = `INSERT INTO user (name, email, password) VALUES (?, ?, ?)`;
const USER_ROLE_INSERT_SQL = `INSERT INTO userRole (userId, role, objectId) VALUES (?, ?, ?)`;

function mysqlOptions() {
  return {
    host: config.db.connection.host,
    user: config.db.connection.user,
    password: config.db.connection.password,
    connectTimeout: config.db.connection.connectTimeout,
    decimalNumbers: true,
  };
}

function installDefaultConnection(connection) {
  connection.execute = jest.fn(async (sql) => {
    if (String(sql).includes('INFORMATION_SCHEMA')) {
      return [[{ SCHEMA_NAME: 'pizza' }], []];
    }
    return [[], []];
  });
  connection.query = jest.fn(async () => [{}, undefined]);
  connection.end = jest.fn(async () => undefined);
  connection.beginTransaction = jest.fn(async () => undefined);
  connection.commit = jest.fn(async () => undefined);
  connection.rollback = jest.fn(async () => undefined);
}

function franchiseListSql(limit, page) {
  return `SELECT id, name FROM franchise WHERE name LIKE ? LIMIT ${limit + 1} OFFSET ${page * limit}`;
}

function expectUseConnections(times) {
  expect(mysql.createConnection).toHaveBeenCalledTimes(times);
  expect(mysql.createConnection).toHaveBeenCalledWith(mysqlOptions());
  expect(mockConnection.query).toHaveBeenCalledTimes(times);
  for (let index = 1; index <= times; index += 1) {
    expect(mockConnection.query).toHaveBeenNthCalledWith(index, `USE ${config.db.connection.database}`);
  }
  expect(mockConnection.end).toHaveBeenCalledTimes(times);
  const lastExecute = mockConnection.execute.mock.invocationCallOrder.at(-1);
  const lastEnd = mockConnection.end.mock.invocationCallOrder.at(-1);
  expect(mockConnection.query.mock.invocationCallOrder[0]).toBeLessThan(mockConnection.execute.mock.invocationCallOrder[0]);
  expect(lastEnd).toBeGreaterThan(lastExecute);
}

function authUser(isAdmin) {
  return {
    isRole: jest.fn((role) => (isAdmin ? role === 'admin' : false)),
  };
}

function connectionForInit(exists) {
  const connection = createFakeConnection();
  connection.execute = jest.fn(async (sql) => {
    const text = String(sql);
    if (text.includes('INFORMATION_SCHEMA')) {
      return exists ? [[{ SCHEMA_NAME: 'pizza' }], []] : [[], []];
    }
    if (text.startsWith('INSERT INTO userRole')) {
      return [{ insertId: 2 }, undefined];
    }
    if (text.startsWith('INSERT INTO user')) {
      return [{ insertId: 1 }, undefined];
    }
    return [[], []];
  });
  return connection;
}

function loadIsolatedDatabase(createConnection) {
  mysql.createConnection.mockReset();
  mysql.createConnection.mockImplementation(createConnection);
  let exported;
  jest.isolateModules(() => {
    exported = require('../src/database/database.js');
  });
  return exported.DB;
}

async function flushPromises() {
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function withConsole(run) {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await run({ log, error });
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

function schemaStatements() {
  return [`CREATE DATABASE IF NOT EXISTS ${config.db.connection.database}`, `USE ${config.db.connection.database}`, ...tableCreateStatements];
}

beforeAll(async () => {
  await DB.initialized;
});

beforeEach(() => {
  installDefaultConnection(mockConnection);
  mysql.createConnection.mockReset();
  mysql.createConnection.mockImplementation(async () => mockConnection);
});

describe('query', () => {
  test('returns the first element of the execute tuple', async () => {
    const rows = [{ id: 1, name: 'Pie' }];
    mockConnection.execute.mockResolvedValueOnce([rows, []]);
    await expect(DB.query(mockConnection, 'SELECT id, name FROM franchise', undefined)).resolves.toBe(rows);

    const packet = { insertId: 4 };
    mockConnection.execute.mockResolvedValueOnce([packet, undefined]);
    await expect(DB.query(mockConnection, 'INSERT INTO franchise (name) VALUES (?)', ['Pie'])).resolves.toBe(packet);
    expect(mockConnection.execute).toHaveBeenNthCalledWith(1, 'SELECT id, name FROM franchise', undefined);
    expect(mockConnection.execute).toHaveBeenNthCalledWith(2, 'INSERT INTO franchise (name) VALUES (?)', ['Pie']);
  });
});

describe('connections', () => {
  test('_getConnection passes pool settings and skips USE when setUse is false', async () => {
    const connection = await DB._getConnection(false);
    expect(connection).toBe(mockConnection);
    expect(mysql.createConnection).toHaveBeenCalledTimes(1);
    expect(mysql.createConnection).toHaveBeenCalledWith(mysqlOptions());
    expect(mockConnection.query).not.toHaveBeenCalled();
  });

  test('_getConnection selects the database when setUse is true', async () => {
    const connection = await DB._getConnection();
    expect(connection).toBe(mockConnection);
    expect(mysql.createConnection).toHaveBeenCalledWith(mysqlOptions());
    expect(mockConnection.query).toHaveBeenCalledTimes(1);
    expect(mockConnection.query).toHaveBeenCalledWith(`USE ${config.db.connection.database}`);
  });

  test('getConnection stays pending until initializeDatabase resolves, then selects the database', async () => {
    const connection = connectionForInit(true);
    let releaseInit;
    await withConsole(async () => {
      const db = loadIsolatedDatabase(() => {
        if (!releaseInit) {
          return new Promise((resolve) => {
            releaseInit = resolve;
          });
        }
        return Promise.resolve(connection);
      });

      let settled = false;
      const pending = db.getConnection().then((value) => {
        settled = true;
        return value;
      });

      expect(mysql.createConnection).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      await flushPromises();
      expect(mysql.createConnection).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      releaseInit(connection);
      await expect(pending).resolves.toBe(connection);

      expect(settled).toBe(true);
      expect(mysql.createConnection).toHaveBeenCalledTimes(2);
      expect(mysql.createConnection).toHaveBeenNthCalledWith(1, mysqlOptions());
      expect(mysql.createConnection).toHaveBeenNthCalledWith(2, mysqlOptions());
      expect(connection.query).toHaveBeenLastCalledWith(`USE ${config.db.connection.database}`);
      expect(connection.end.mock.invocationCallOrder[0]).toBeLessThan(connection.query.mock.invocationCallOrder.at(-1));
    });
  });
});

describe('createFranchise', () => {
  test('resolves each admin, inserts the franchise, and grants franchisee roles', async () => {
    const franchise = {
      name: 'Pizza Pocket',
      admins: [{ email: 'a@jwt.com' }, { email: 'b@jwt.com' }],
    };
    mockConnection.execute
      .mockResolvedValueOnce([[{ id: 11, name: 'Ada' }], []])
      .mockResolvedValueOnce([[{ id: 12, name: 'Bea' }], []])
      .mockResolvedValueOnce([{ insertId: 4 }, undefined])
      .mockResolvedValueOnce([{ insertId: 100 }, undefined])
      .mockResolvedValueOnce([{ insertId: 101 }, undefined]);

    const result = await DB.createFranchise(franchise);

    expect(result).toBe(franchise);
    expect(franchise).toEqual({
      id: 4,
      name: 'Pizza Pocket',
      admins: [
        { email: 'a@jwt.com', id: 11, name: 'Ada' },
        { email: 'b@jwt.com', id: 12, name: 'Bea' },
      ],
    });
    expect(mockConnection.execute).toHaveBeenNthCalledWith(1, 'SELECT id, name FROM user WHERE email=?', ['a@jwt.com']);
    expect(mockConnection.execute).toHaveBeenNthCalledWith(2, 'SELECT id, name FROM user WHERE email=?', ['b@jwt.com']);
    expect(mockConnection.execute).toHaveBeenNthCalledWith(3, 'INSERT INTO franchise (name) VALUES (?)', ['Pizza Pocket']);
    expect(mockConnection.execute).toHaveBeenNthCalledWith(4, USER_ROLE_INSERT_SQL, [11, 'franchisee', 4]);
    expect(mockConnection.execute).toHaveBeenNthCalledWith(5, USER_ROLE_INSERT_SQL, [12, 'franchisee', 4]);
    expectUseConnections(1);
  });

  test('throws 404 for an unknown admin and still ends the connection', async () => {
    const franchise = {
      name: 'Missing Admin',
      admins: [{ email: 'known@jwt.com' }, { email: 'missing@jwt.com' }],
    };
    mockConnection.execute.mockResolvedValueOnce([[{ id: 3, name: 'Known' }], []]).mockResolvedValueOnce([[], []]);

    let caught;
    try {
      await DB.createFranchise(franchise);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(StatusCodeError);
    expect(caught).toMatchObject({
      message: 'unknown user for franchise admin missing@jwt.com provided',
      statusCode: 404,
    });
    expect(franchise.admins[0]).toEqual({ email: 'known@jwt.com', id: 3, name: 'Known' });
    expect(franchise.admins[1]).toEqual({ email: 'missing@jwt.com' });
    expect(franchise.id).toBeUndefined();
    expect(mockConnection.execute).toHaveBeenCalledTimes(2);
    expect(mockConnection.execute).toHaveBeenNthCalledWith(1, 'SELECT id, name FROM user WHERE email=?', ['known@jwt.com']);
    expect(mockConnection.execute).toHaveBeenNthCalledWith(2, 'SELECT id, name FROM user WHERE email=?', ['missing@jwt.com']);
    expectUseConnections(1);
  });
});

describe('deleteFranchise', () => {
  test('deletes stores, userRole by objectId only, and the franchise in one transaction', async () => {
    await DB.deleteFranchise(9);

    expect(mockConnection.execute.mock.calls).toEqual([
      ['DELETE FROM store WHERE franchiseId=?', [9]],
      ['DELETE FROM userRole WHERE objectId=?', [9]],
      ['DELETE FROM franchise WHERE id=?', [9]],
    ]);
    expect(mockConnection.beginTransaction).toHaveBeenCalledTimes(1);
    expect(mockConnection.commit).toHaveBeenCalledTimes(1);
    expect(mockConnection.rollback).not.toHaveBeenCalled();
    expect(mockConnection.beginTransaction.mock.invocationCallOrder[0]).toBeLessThan(mockConnection.execute.mock.invocationCallOrder[0]);
    expect(mockConnection.commit.mock.invocationCallOrder[0]).toBeGreaterThan(mockConnection.execute.mock.invocationCallOrder[2]);
    expect(mockConnection.end.mock.invocationCallOrder[0]).toBeGreaterThan(mockConnection.commit.mock.invocationCallOrder[0]);
    expectUseConnections(1);
  });

  test('rolls back and throws 500 when a delete rejects, and still ends the connection', async () => {
    mockConnection.execute.mockResolvedValueOnce([[], []]).mockRejectedValueOnce(new Error('delete failed'));

    let caught;
    try {
      await DB.deleteFranchise(9);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(StatusCodeError);
    expect(caught).toMatchObject({
      message: 'unable to delete franchise',
      statusCode: 500,
    });
    expect(mockConnection.execute.mock.calls).toEqual([
      ['DELETE FROM store WHERE franchiseId=?', [9]],
      ['DELETE FROM userRole WHERE objectId=?', [9]],
    ]);
    expect(mockConnection.beginTransaction).toHaveBeenCalledTimes(1);
    expect(mockConnection.commit).not.toHaveBeenCalled();
    expect(mockConnection.rollback).toHaveBeenCalledTimes(1);
    expect(mockConnection.rollback.mock.invocationCallOrder[0]).toBeGreaterThan(mockConnection.execute.mock.invocationCallOrder[1]);
    expect(mockConnection.end.mock.invocationCallOrder[0]).toBeGreaterThan(mockConnection.rollback.mock.invocationCallOrder[0]);
    expectUseConnections(1);
  });
});

describe('getFranchises', () => {
  test('pages admins with the default filter and drops the extra row', async () => {
    const source = Array.from({ length: 11 }, (_, index) => ({ id: index + 1, name: `F${index + 1}` }));
    const listSql = franchiseListSql(10, 0);
    const user = authUser(true);
    mockConnection.execute.mockImplementation(async (sql, params) => {
      if (sql === listSql) {
        return [source, []];
      }
      if (sql === ADMIN_SQL) {
        const id = params[0];
        return [[{ id, name: `Admin ${id}`, email: `a${id}@jwt.com` }], []];
      }
      if (sql === REVENUE_SQL) {
        const id = params[0];
        return [[{ id, name: `Store ${id}`, totalRevenue: id }], []];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const [franchises, more] = await DB.getFranchises(user);

    expect(more).toBe(true);
    expect(franchises).toHaveLength(10);
    expect(franchises).not.toBe(source);
    expect(franchises[0]).toBe(source[0]);
    expect(franchises.map((franchise) => franchise.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(source[10]).toEqual({ id: 11, name: 'F11' });
    expect(franchises[0].admins).toEqual([{ id: 1, name: 'Admin 1', email: 'a1@jwt.com' }]);
    expect(franchises[0].stores).toEqual([{ id: 1, name: 'Store 1', totalRevenue: 1 }]);
    expect(franchises[9].admins).toEqual([{ id: 10, name: 'Admin 10', email: 'a10@jwt.com' }]);
    expect(franchises[9].stores).toEqual([{ id: 10, name: 'Store 10', totalRevenue: 10 }]);
    expect(mockConnection.execute.mock.calls[0]).toEqual([listSql, ['%']]);
    for (let index = 0; index < 10; index += 1) {
      expect(mockConnection.execute.mock.calls[1 + index * 2]).toEqual([ADMIN_SQL, [index + 1]]);
      expect(mockConnection.execute.mock.calls[2 + index * 2]).toEqual([REVENUE_SQL, [index + 1]]);
    }
    expect(mockConnection.execute).toHaveBeenCalledTimes(21);
    expect(mockConnection.execute.mock.calls.some(([sql]) => sql === STORE_SQL)).toBe(false);
    expect(user.isRole).toHaveBeenCalledTimes(10);
    expect(user.isRole).toHaveBeenCalledWith('admin');
    expectUseConnections(11);
  });

  test('applies a pizza* filter and loads stores for a non-admin without getFranchise', async () => {
    const franchises = [
      { id: 21, name: 'pizza-north' },
      { id: 22, name: 'pizza-south' },
      { id: 23, name: 'pizza-east' },
      { id: 24, name: 'pizza-west' },
      { id: 25, name: 'pizza-central' },
    ];
    const user = authUser(false);
    mockConnection.execute.mockImplementation(async (sql, params) => {
      if (sql === franchiseListSql(5, 2)) {
        return [franchises, []];
      }
      if (sql === STORE_SQL) {
        return [[{ id: params[0] + 100, name: `counter-${params[0]}` }], []];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const [page, more] = await DB.getFranchises(user, 2, 5, 'pizza*');

    expect(more).toBe(false);
    expect(page).toBe(franchises);
    expect(page.map((franchise) => franchise.stores)).toEqual([
      [{ id: 121, name: 'counter-21' }],
      [{ id: 122, name: 'counter-22' }],
      [{ id: 123, name: 'counter-23' }],
      [{ id: 124, name: 'counter-24' }],
      [{ id: 125, name: 'counter-25' }],
    ]);
    expect(mockConnection.execute.mock.calls[0]).toEqual([franchiseListSql(5, 2), ['pizza%']]);
    expect(mockConnection.execute.mock.calls.slice(1)).toEqual(franchises.map((franchise) => [STORE_SQL, [franchise.id]]));
    expect(user.isRole).toHaveBeenCalledTimes(5);
    expect(user.isRole).toHaveBeenCalledWith('admin');
    expectUseConnections(1);
  });

  async function expectAnonymousStoreBranch(authUser) {
    const rows = [
      { id: 7, name: 'Bare' },
      { id: 8, name: 'Other' },
    ];
    mockConnection.execute.mockImplementation(async (sql, params) => {
      if (sql === franchiseListSql(10, 0)) {
        return [rows.map((row) => ({ ...row })), []];
      }
      if (sql === STORE_SQL) {
        return [[{ id: params[0] + 100, name: `counter-${params[0]}` }], []];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const [franchises, more] = await DB.getFranchises(authUser);

    expect(more).toBe(false);
    expect(franchises).toEqual([
      { id: 7, name: 'Bare', stores: [{ id: 107, name: 'counter-7' }] },
      { id: 8, name: 'Other', stores: [{ id: 108, name: 'counter-8' }] },
    ]);
    expect(franchises.map((franchise) => Object.hasOwn(franchise, 'admins'))).toEqual([false, false]);
    expect(mockConnection.execute.mock.calls).toEqual([
      [franchiseListSql(10, 0), ['%']],
      [STORE_SQL, [7]],
      [STORE_SQL, [8]],
    ]);
    expectUseConnections(1);
  }

  test('null authUser uses the non-admin store branch', async () => {
    await expectAnonymousStoreBranch(null);
  });

  test('undefined authUser uses the non-admin store branch', async () => {
    await expectAnonymousStoreBranch(undefined);
  });

  test('replaces every asterisk in the name filter', async () => {
    const rows = [];
    mockConnection.execute.mockResolvedValueOnce([rows, []]);
    const user = authUser(false);

    await expect(DB.getFranchises(user, undefined, undefined, '*pizza*')).resolves.toEqual([rows, false]);

    expect(mockConnection.execute).toHaveBeenCalledTimes(1);
    expect(mockConnection.execute).toHaveBeenCalledWith(franchiseListSql(10, 0), ['%pizza%']);
    expect(user.isRole).not.toHaveBeenCalled();
    expectUseConnections(1);
  });
});

describe('getUserFranchises', () => {
  test('returns an empty list when the user has no franchisee roles', async () => {
    mockConnection.execute.mockResolvedValueOnce([[], []]);

    await expect(DB.getUserFranchises(42)).resolves.toEqual([]);

    expect(mockConnection.execute).toHaveBeenCalledTimes(1);
    expect(mockConnection.execute).toHaveBeenCalledWith(ROLE_ID_SQL, [42]);
    expectUseConnections(1);
  });

  test('loads franchises for an unsanitized list of two ids and fills each one', async () => {
    const listed = [
      { id: 3, name: 'North' },
      { id: 8, name: 'South' },
    ];
    mockConnection.execute.mockImplementation(async (sql, params) => {
      if (sql === ROLE_ID_SQL) {
        return [[{ objectId: 3 }, { objectId: 8 }], []];
      }
      if (sql === 'SELECT id, name FROM franchise WHERE id in (3,8)') {
        return [listed, []];
      }
      if (sql === ADMIN_SQL) {
        return [[{ id: 1, name: 'Ada', email: 'a@jwt.com' }], []];
      }
      if (sql === REVENUE_SQL) {
        return [[{ id: params[0], name: `Store ${params[0]}`, totalRevenue: 0 }], []];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const result = await DB.getUserFranchises(42);

    expect(result).toBe(listed);
    expect(mockConnection.execute.mock.calls[0]).toEqual([ROLE_ID_SQL, [42]]);
    expect(mockConnection.execute.mock.calls[1]).toEqual(['SELECT id, name FROM franchise WHERE id in (3,8)', undefined]);
    expect(mockConnection.execute.mock.calls[2]).toEqual([ADMIN_SQL, [3]]);
    expect(mockConnection.execute.mock.calls[3]).toEqual([REVENUE_SQL, [3]]);
    expect(mockConnection.execute.mock.calls[4]).toEqual([ADMIN_SQL, [8]]);
    expect(mockConnection.execute.mock.calls[5]).toEqual([REVENUE_SQL, [8]]);
    expect(result[0].admins).toEqual([{ id: 1, name: 'Ada', email: 'a@jwt.com' }]);
    expect(result[0].stores).toEqual([{ id: 3, name: 'Store 3', totalRevenue: 0 }]);
    expect(result[1].admins).toEqual([{ id: 1, name: 'Ada', email: 'a@jwt.com' }]);
    expect(result[1].stores).toEqual([{ id: 8, name: 'Store 8', totalRevenue: 0 }]);
    expectUseConnections(3);
  });
});

describe('getFranchise', () => {
  test('fills admins and stores on the same object and ends the connection', async () => {
    const franchise = { id: 5, name: 'Pie' };
    const admins = [{ id: 1, name: 'Ada', email: 'a@jwt.com' }];
    const stores = [{ id: 9, name: 'Downtown', totalRevenue: 12.5 }];
    mockConnection.execute.mockResolvedValueOnce([admins, []]).mockResolvedValueOnce([stores, []]);

    await expect(DB.getFranchise(franchise)).resolves.toBe(franchise);

    expect(franchise.admins).toBe(admins);
    expect(franchise.stores).toBe(stores);
    expect(mockConnection.execute).toHaveBeenNthCalledWith(1, ADMIN_SQL, [5]);
    expect(mockConnection.execute).toHaveBeenNthCalledWith(2, REVENUE_SQL, [5]);
    expectUseConnections(1);
  });
});

describe('createStore', () => {
  test('inserts the store and returns its id, franchise, and name', async () => {
    const store = { name: 'Downtown' };
    mockConnection.execute.mockResolvedValueOnce([{ insertId: 4 }, undefined]);

    await expect(DB.createStore(15, store)).resolves.toEqual({ id: 4, franchiseId: 15, name: 'Downtown' });

    expect(store).toEqual({ name: 'Downtown' });
    expect(mockConnection.execute).toHaveBeenCalledWith('INSERT INTO store (franchiseId, name) VALUES (?, ?)', [15, 'Downtown']);
    expectUseConnections(1);
  });
});

describe('deleteStore', () => {
  test('deletes by franchise id and store id and ends the connection', async () => {
    await expect(DB.deleteStore(15, 4)).resolves.toBeUndefined();

    expect(mockConnection.execute).toHaveBeenCalledWith('DELETE FROM store WHERE franchiseId=? AND id=?', [15, 4]);
    expectUseConnections(1);
  });
});

describe('checkDatabaseExists', () => {
  test('is true when INFORMATION_SCHEMA returns a schema row', async () => {
    mockConnection.execute.mockResolvedValueOnce([[{ SCHEMA_NAME: 'pizza' }], []]);

    await expect(DB.checkDatabaseExists(mockConnection)).resolves.toBe(true);

    expect(mockConnection.execute).toHaveBeenCalledWith(SCHEMA_SQL, [config.db.connection.database]);
    expect(mysql.createConnection).not.toHaveBeenCalled();
  });

  test('is false when INFORMATION_SCHEMA returns no rows', async () => {
    mockConnection.execute.mockResolvedValueOnce([[], []]);

    await expect(DB.checkDatabaseExists(mockConnection)).resolves.toBe(false);

    expect(mockConnection.execute).toHaveBeenCalledWith(SCHEMA_SQL, [config.db.connection.database]);
  });
});

describe('initializeDatabase', () => {
  test('applies the schema and does not add the default admin when the database exists', async () => {
    const connection = connectionForInit(true);
    await withConsole(async ({ log, error }) => {
      const db = loadIsolatedDatabase(async () => connection);
      expect(db).not.toBe(DB);

      await db.initialized;
      await flushPromises();

      expect(connection.execute).toHaveBeenCalledWith(SCHEMA_SQL, [config.db.connection.database]);
      expect(connection.query.mock.calls.map(([sql]) => sql)).toEqual(schemaStatements());
      expect(mysql.createConnection.mock.calls).toEqual([[mysqlOptions()]]);
      expect(connection.end).toHaveBeenCalledTimes(1);
      expect(bcrypt.hash).not.toHaveBeenCalled();
      expect(connection.execute.mock.calls.some(([sql]) => String(sql).includes('INSERT'))).toBe(false);
      expect(log).toHaveBeenCalledWith('Database exists');
      expect(log).not.toHaveBeenCalledWith('Successfully created database');
      expect(error).not.toHaveBeenCalled();
    });
  });

  test('invokes addUser with the default admin and does not finish that insert before init resolves', async () => {
    const connection = connectionForInit(false);
    const defaultAdmin = {
      name: '常用名字',
      email: 'a@jwt.com',
      password: 'admin',
      roles: [{ role: 'admin' }],
    };
    await withConsole(async ({ log, error }) => {
      const db = loadIsolatedDatabase(async () => connection);
      const addUser = jest.spyOn(db, 'addUser');
      try {
        let startedAdmin;
        let executeSqlWhenInitResolved;
        let queriesWhenInitResolved;
        let hashCallsWhenInitResolved;
        let connectionCountWhenInitResolved;
        let endCountWhenInitResolved;
        const initialized = db.initialized.then(() => {
          startedAdmin = addUser.mock.calls.map((call) => call[0]);
          executeSqlWhenInitResolved = connection.execute.mock.calls.map(([sql]) => sql);
          queriesWhenInitResolved = connection.query.mock.calls.map(([sql]) => sql);
          hashCallsWhenInitResolved = bcrypt.hash.mock.calls.length;
          connectionCountWhenInitResolved = mysql.createConnection.mock.calls.length;
          endCountWhenInitResolved = connection.end.mock.calls.length;
        });

        await expect(initialized).resolves.toBeUndefined();
        expect(startedAdmin).toEqual([defaultAdmin]);
        expect(executeSqlWhenInitResolved).toEqual([SCHEMA_SQL]);
        expect(queriesWhenInitResolved).toEqual(schemaStatements());
        expect(hashCallsWhenInitResolved).toBe(0);
        expect(connectionCountWhenInitResolved).toBe(1);
        expect(endCountWhenInitResolved).toBe(1);

        await addUser.mock.results[0].value;

        expect(addUser).toHaveBeenCalledTimes(1);
        expect(addUser).toHaveBeenCalledWith(defaultAdmin);
        expect(bcrypt.hash.mock.calls).toEqual([['admin', 10]]);
        expect(connection.execute.mock.calls).toEqual([
          [SCHEMA_SQL, [config.db.connection.database]],
          [USER_INSERT_SQL, ['常用名字', 'a@jwt.com', 'hashed-admin']],
          [USER_ROLE_INSERT_SQL, [1, 'admin', 0]],
        ]);
        expect(connection.query.mock.calls.map(([sql]) => sql)).toEqual([...schemaStatements(), `USE ${config.db.connection.database}`]);
        expect(mysql.createConnection.mock.calls).toEqual([[mysqlOptions()], [mysqlOptions()]]);
        expect(connection.end).toHaveBeenCalledTimes(2);
        expect(log).toHaveBeenCalledWith('Database does not exist, creating it');
        expect(log).toHaveBeenCalledWith('Successfully created database');
        expect(error).not.toHaveBeenCalled();
      } finally {
        addUser.mockRestore();
      }
    });
  });

  test('logs and does not throw when createConnection rejects', async () => {
    await withConsole(async ({ log, error }) => {
      const db = loadIsolatedDatabase(async () => {
        throw new Error('connect failed');
      });

      await expect(db.initialized).resolves.toBeUndefined();

      expect(mysql.createConnection).toHaveBeenCalledTimes(1);
      expect(mysql.createConnection).toHaveBeenCalledWith(mysqlOptions());
      expect(log).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        JSON.stringify({
          message: 'Error initializing database',
          exception: 'connect failed',
          connection: config.db.connection,
        }),
      );
    });
  });
});
