const { createFakeConnection } = require('./helpers/fakeMysql');
const mockConnection = createFakeConnection();
const connection = mockConnection;

jest.mock('mysql2/promise', () => ({
  createConnection: jest.fn(async () => mockConnection),
}));

jest.mock('bcrypt', () => ({
  hash: jest.fn(async (value) => `hashed-${value}`),
  compare: jest.fn(async (value, hash) => hash === `hashed-${value}`),
}));

const bcrypt = require('bcrypt');
const { StatusCodeError } = require('../src/endpointHelper.js');
const { Role, DB } = require('../src/database/database.js');

const INSERT_USER = 'INSERT INTO user (name, email, password) VALUES (?, ?, ?)';
const INSERT_USER_ROLE = 'INSERT INTO userRole (userId, role, objectId) VALUES (?, ?, ?)';
const SELECT_USER = 'SELECT * FROM user WHERE email=?';
const SELECT_ROLES = 'SELECT * FROM userRole WHERE userId=?';
const SELECT_FRANCHISE_ID = 'SELECT id FROM franchise WHERE name=?';
const INSERT_AUTH = 'INSERT INTO auth (token, userId) VALUES (?, ?) ON DUPLICATE KEY UPDATE token=token';
const SELECT_AUTH = 'SELECT userId FROM auth WHERE token=?';
const DELETE_AUTH = 'DELETE FROM auth WHERE token=?';

function resetConnection() {
  connection.execute = jest.fn(async (sql) => {
    if (String(sql).includes('INFORMATION_SCHEMA')) {
      return [[{ SCHEMA_NAME: 'pizza' }], []];
    }
    return [[], []];
  });
  connection.query = jest.fn(async () => [{}, undefined]);
  connection.end = jest.fn(async () => undefined);
}

function userRow(overrides = {}) {
  return {
    id: 4,
    name: 'Ada',
    email: 'ada@jwt.com',
    password: 'hashed-secret',
    ...overrides,
  };
}

beforeAll(async () => {
  await DB.initialized;
});

beforeEach(async () => {
  await DB.initialized;
  resetConnection();
  bcrypt.hash.mockImplementation(async (value) => `hashed-${value}`);
  bcrypt.compare.mockImplementation(async (value, hash) => hash === `hashed-${value}`);
});

describe('addUser', () => {
  test('hashes a diner password at cost 10, inserts user and userRole, and strips the password', async () => {
    const user = {
      name: 'Ada',
      email: 'ada@jwt.com',
      password: 'secret',
      roles: [{ role: Role.Diner }],
    };
    connection.execute
      .mockResolvedValueOnce([{ insertId: 7 }, undefined])
      .mockResolvedValueOnce([{ insertId: 1 }, undefined]);

    const result = await DB.addUser(user);

    expect(bcrypt.hash).toHaveBeenCalledTimes(1);
    expect(bcrypt.hash).toHaveBeenCalledWith('secret', 10);
    expect(connection.query).toHaveBeenCalledWith('USE pizza');
    expect(connection.execute).toHaveBeenCalledTimes(2);
    expect(connection.execute).toHaveBeenNthCalledWith(1, INSERT_USER, ['Ada', 'ada@jwt.com', 'hashed-secret']);
    expect(connection.execute).toHaveBeenNthCalledWith(2, INSERT_USER_ROLE, [7, Role.Diner, 0]);
    expect(result).toEqual({
      name: 'Ada',
      email: 'ada@jwt.com',
      roles: [{ role: Role.Diner }],
      id: 7,
      password: undefined,
    });
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  test('looks up a franchisee franchise id and stores it on userRole', async () => {
    const user = {
      name: 'Fran',
      email: 'fran@jwt.com',
      password: 'pw',
      roles: [{ role: Role.Franchisee, object: 'Pizza Planet' }],
    };
    connection.execute
      .mockResolvedValueOnce([{ insertId: 9 }, undefined])
      .mockResolvedValueOnce([[{ id: 15 }], []])
      .mockResolvedValueOnce([{ insertId: 1 }, undefined]);

    const result = await DB.addUser(user);

    expect(bcrypt.hash).toHaveBeenCalledWith('pw', 10);
    expect(connection.execute).toHaveBeenCalledTimes(3);
    expect(connection.execute).toHaveBeenNthCalledWith(1, INSERT_USER, ['Fran', 'fran@jwt.com', 'hashed-pw']);
    expect(connection.execute).toHaveBeenNthCalledWith(2, SELECT_FRANCHISE_ID, ['Pizza Planet']);
    expect(connection.execute).toHaveBeenNthCalledWith(3, INSERT_USER_ROLE, [9, Role.Franchisee, 15]);
    expect(result).toEqual({
      name: 'Fran',
      email: 'fran@jwt.com',
      roles: [{ role: Role.Franchisee, object: 'Pizza Planet' }],
      id: 9,
      password: undefined,
    });
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  test('inserts a diner role and then a franchisee role, in that order', async () => {
    const user = {
      name: 'Ada',
      email: 'ada@jwt.com',
      password: 'secret',
      roles: [
        { role: Role.Diner },
        { role: Role.Franchisee, object: 'Pizza Planet' },
      ],
    };
    connection.execute
      .mockResolvedValueOnce([{ insertId: 7 }, undefined])
      .mockResolvedValueOnce([{ insertId: 1 }, undefined])
      .mockResolvedValueOnce([[{ id: 15 }], []])
      .mockResolvedValueOnce([{ insertId: 2 }, undefined]);

    const result = await DB.addUser(user);

    expect(bcrypt.hash).toHaveBeenCalledWith('secret', 10);
    expect(connection.execute).toHaveBeenCalledTimes(4);
    expect(connection.execute).toHaveBeenNthCalledWith(1, INSERT_USER, ['Ada', 'ada@jwt.com', 'hashed-secret']);
    expect(connection.execute).toHaveBeenNthCalledWith(2, INSERT_USER_ROLE, [7, Role.Diner, 0]);
    expect(connection.execute).toHaveBeenNthCalledWith(3, SELECT_FRANCHISE_ID, ['Pizza Planet']);
    expect(connection.execute).toHaveBeenNthCalledWith(4, INSERT_USER_ROLE, [7, Role.Franchisee, 15]);
    expect(result).toEqual({
      name: 'Ada',
      email: 'ada@jwt.com',
      roles: [
        { role: Role.Diner },
        { role: Role.Franchisee, object: 'Pizza Planet' },
      ],
      id: 7,
      password: undefined,
    });
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  test('propagates getID Error when the franchise name is missing and still ends the connection', async () => {
    const user = {
      name: 'Fran',
      email: 'fran@jwt.com',
      password: 'pw',
      roles: [{ role: Role.Franchisee, object: 'Missing' }],
    };
    connection.execute
      .mockResolvedValueOnce([{ insertId: 9 }, undefined])
      .mockResolvedValueOnce([[], []]);

    await expect(DB.addUser(user)).rejects.toThrow('No ID found');

    expect(connection.execute).toHaveBeenCalledTimes(2);
    expect(connection.execute).toHaveBeenNthCalledWith(1, INSERT_USER, ['Fran', 'fran@jwt.com', 'hashed-pw']);
    expect(connection.execute).toHaveBeenNthCalledWith(2, SELECT_FRANCHISE_ID, ['Missing']);
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  test('ends the connection when the user insert fails', async () => {
    const failure = new Error('user insert failed');
    connection.execute.mockRejectedValueOnce(failure);
    const user = {
      name: 'Ada',
      email: 'ada@jwt.com',
      password: 'secret',
      roles: [{ role: Role.Diner }],
    };

    await expect(DB.addUser(user)).rejects.toBe(failure);

    expect(bcrypt.hash).toHaveBeenCalledWith('secret', 10);
    expect(connection.execute).toHaveBeenCalledTimes(1);
    expect(connection.execute).toHaveBeenCalledWith(INSERT_USER, ['Ada', 'ada@jwt.com', 'hashed-secret']);
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  test('ends the connection when the role insert fails', async () => {
    const failure = new Error('role insert failed');
    connection.execute
      .mockResolvedValueOnce([{ insertId: 7 }, undefined])
      .mockRejectedValueOnce(failure);
    const user = {
      name: 'Ada',
      email: 'ada@jwt.com',
      password: 'secret',
      roles: [{ role: Role.Diner }],
    };

    await expect(DB.addUser(user)).rejects.toBe(failure);

    expect(connection.execute).toHaveBeenCalledTimes(2);
    expect(connection.execute).toHaveBeenNthCalledWith(1, INSERT_USER, ['Ada', 'ada@jwt.com', 'hashed-secret']);
    expect(connection.execute).toHaveBeenNthCalledWith(2, INSERT_USER_ROLE, [7, Role.Diner, 0]);
    expect(connection.end).toHaveBeenCalledTimes(1);
  });
});

describe('getUser', () => {
  test('maps objectId 0 to undefined, keeps a non-zero objectId, and strips the password', async () => {
    connection.execute
      .mockResolvedValueOnce([[userRow()], []])
      .mockResolvedValueOnce([[
        { userId: 4, role: Role.Diner, objectId: 0 },
        { userId: 4, role: Role.Franchisee, objectId: 15 },
      ], []]);

    const result = await DB.getUser('ada@jwt.com', 'secret');

    expect(bcrypt.compare).toHaveBeenCalledTimes(1);
    expect(bcrypt.compare).toHaveBeenCalledWith('secret', 'hashed-secret');
    expect(bcrypt.hash).not.toHaveBeenCalled();
    expect(connection.execute).toHaveBeenNthCalledWith(1, SELECT_USER, ['ada@jwt.com']);
    expect(connection.execute).toHaveBeenNthCalledWith(2, SELECT_ROLES, [4]);
    expect(result).toEqual({
      id: 4,
      name: 'Ada',
      email: 'ada@jwt.com',
      password: undefined,
      roles: [
        { objectId: undefined, role: Role.Diner },
        { objectId: 15, role: Role.Franchisee },
      ],
    });
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  test('throws StatusCodeError 404 when the email is unknown', async () => {
    connection.execute.mockResolvedValueOnce([[], []]);

    const error = await DB.getUser('nobody@jwt.com', 'secret').catch((err) => err);

    expect(error).toBeInstanceOf(StatusCodeError);
    expect(error).toMatchObject({ message: 'unknown user', statusCode: 404 });
    expect(bcrypt.compare).not.toHaveBeenCalled();
    expect(connection.execute).toHaveBeenCalledTimes(1);
    expect(connection.execute).toHaveBeenCalledWith(SELECT_USER, ['nobody@jwt.com']);
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  test('throws StatusCodeError 404 when the password does not match', async () => {
    connection.execute.mockResolvedValueOnce([[userRow()], []]);

    const error = await DB.getUser('ada@jwt.com', 'wrong').catch((err) => err);

    expect(error).toBeInstanceOf(StatusCodeError);
    expect(error).toMatchObject({ message: 'unknown user', statusCode: 404 });
    expect(bcrypt.compare).toHaveBeenCalledWith('wrong', 'hashed-secret');
    expect(connection.execute).toHaveBeenCalledTimes(1);
    expect(connection.execute).toHaveBeenCalledWith(SELECT_USER, ['ada@jwt.com']);
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  test.each([undefined, '', null])(
    'does not compare a falsy password (%p) and still returns the user',
    async (password) => {
      connection.execute
        .mockResolvedValueOnce([[userRow()], []])
        .mockResolvedValueOnce([[{ userId: 4, role: Role.Diner, objectId: 0 }], []]);

      const result = await DB.getUser('ada@jwt.com', password);

      expect(bcrypt.compare).not.toHaveBeenCalled();
      expect(connection.execute).toHaveBeenNthCalledWith(1, SELECT_USER, ['ada@jwt.com']);
      expect(connection.execute).toHaveBeenNthCalledWith(2, SELECT_ROLES, [4]);
      expect(result).toEqual({
        id: 4,
        name: 'Ada',
        email: 'ada@jwt.com',
        password: undefined,
        roles: [{ objectId: undefined, role: Role.Diner }],
      });
      expect(connection.end).toHaveBeenCalledTimes(1);
    },
  );
});

describe('updateUser', () => {
  function queueReload(row = userRow()) {
    connection.execute
      .mockResolvedValueOnce([[row], []])
      .mockResolvedValueOnce([[{ userId: row.id, role: Role.Diner, objectId: 0 }], []]);
  }

  test('name-only update concatenates SQL and reloads getUser with an undefined email', async () => {
    connection.execute.mockResolvedValueOnce([{ affectedRows: 1 }, undefined]);
    queueReload();

    const result = await DB.updateUser(42, 'Ada', undefined, undefined);

    expect(bcrypt.hash).not.toHaveBeenCalled();
    expect(bcrypt.compare).not.toHaveBeenCalled();
    expect(connection.execute).toHaveBeenCalledTimes(3);
    expect(connection.execute).toHaveBeenNthCalledWith(1, "UPDATE user SET name='Ada' WHERE id=42", undefined);
    expect(connection.execute).toHaveBeenNthCalledWith(2, SELECT_USER, [undefined]);
    expect(connection.execute).toHaveBeenNthCalledWith(3, SELECT_ROLES, [4]);
    expect(result).toEqual({
      id: 4,
      name: 'Ada',
      email: 'ada@jwt.com',
      password: undefined,
      roles: [{ objectId: undefined, role: Role.Diner }],
    });
    expect(connection.end).toHaveBeenCalledTimes(2);
  });

  test('updates only the email by concatenating it into SQL, then reloads via getUser', async () => {
    connection.execute.mockResolvedValueOnce([{ affectedRows: 1 }, undefined]);
    queueReload(userRow({ email: 'new@jwt.com' }));

    const result = await DB.updateUser(42, undefined, 'new@jwt.com', undefined);

    expect(bcrypt.hash).not.toHaveBeenCalled();
    expect(bcrypt.compare).not.toHaveBeenCalled();
    expect(connection.execute).toHaveBeenCalledTimes(3);
    expect(connection.execute).toHaveBeenNthCalledWith(1, "UPDATE user SET email='new@jwt.com' WHERE id=42", undefined);
    expect(connection.execute).toHaveBeenNthCalledWith(2, SELECT_USER, ['new@jwt.com']);
    expect(connection.execute).toHaveBeenNthCalledWith(3, SELECT_ROLES, [4]);
    expect(result).toEqual({
      id: 4,
      name: 'Ada',
      email: 'new@jwt.com',
      password: undefined,
      roles: [{ objectId: undefined, role: Role.Diner }],
    });
    expect(connection.end).toHaveBeenCalledTimes(2);
  });

  test('hashes a password-only update at cost 10 and concatenates the hash into SQL', async () => {
    connection.execute.mockResolvedValueOnce([{ affectedRows: 1 }, undefined]);
    queueReload(userRow({ password: 'hashed-secret' }));

    const result = await DB.updateUser(42, undefined, undefined, 'secret');

    expect(bcrypt.hash).toHaveBeenCalledWith('secret', 10);
    expect(bcrypt.compare).toHaveBeenCalledWith('secret', 'hashed-secret');
    expect(connection.execute).toHaveBeenCalledTimes(3);
    expect(connection.execute).toHaveBeenNthCalledWith(
      1,
      "UPDATE user SET password='hashed-secret' WHERE id=42",
      undefined,
    );
    expect(connection.execute).toHaveBeenNthCalledWith(2, SELECT_USER, [undefined]);
    expect(connection.execute).toHaveBeenNthCalledWith(3, SELECT_ROLES, [4]);
    expect(result).toEqual({
      id: 4,
      name: 'Ada',
      email: 'ada@jwt.com',
      password: undefined,
      roles: [{ objectId: undefined, role: Role.Diner }],
    });
    expect(connection.end).toHaveBeenCalledTimes(2);
  });

  test('concatenates password, email, and name in that order, with the numeric id in WHERE', async () => {
    connection.execute.mockResolvedValueOnce([{ affectedRows: 1 }, undefined]);
    queueReload(userRow({ name: 'New Name', email: 'new@jwt.com', password: 'hashed-secret' }));

    const result = await DB.updateUser(42, 'New Name', 'new@jwt.com', 'secret');

    expect(bcrypt.hash).toHaveBeenCalledWith('secret', 10);
    expect(connection.execute).toHaveBeenCalledTimes(3);
    expect(connection.execute).toHaveBeenNthCalledWith(
      1,
      "UPDATE user SET password='hashed-secret', email='new@jwt.com', name='New Name' WHERE id=42",
      undefined,
    );
    expect(connection.execute).toHaveBeenNthCalledWith(2, SELECT_USER, ['new@jwt.com']);
    expect(bcrypt.compare).toHaveBeenCalledWith('secret', 'hashed-secret');
    expect(result).toEqual({
      id: 4,
      name: 'New Name',
      email: 'new@jwt.com',
      password: undefined,
      roles: [{ objectId: undefined, role: Role.Diner }],
    });
    expect(connection.end).toHaveBeenCalledTimes(2);
  });

  test('skips UPDATE when no fields are provided and still calls getUser', async () => {
    queueReload();

    const result = await DB.updateUser(42, undefined, undefined, undefined);

    expect(bcrypt.hash).not.toHaveBeenCalled();
    expect(bcrypt.compare).not.toHaveBeenCalled();
    expect(connection.execute).toHaveBeenCalledTimes(2);
    expect(connection.execute).toHaveBeenNthCalledWith(1, SELECT_USER, [undefined]);
    expect(connection.execute).toHaveBeenNthCalledWith(2, SELECT_ROLES, [4]);
    expect(result).toEqual({
      id: 4,
      name: 'Ada',
      email: 'ada@jwt.com',
      password: undefined,
      roles: [{ objectId: undefined, role: Role.Diner }],
    });
    expect(connection.end).toHaveBeenCalledTimes(2);
  });

  test('keeps quote characters inside the concatenated SQL text', async () => {
    connection.execute.mockResolvedValueOnce([{ affectedRows: 1 }, undefined]);
    queueReload();

    await DB.updateUser(7, "O'Brien", "a'b@jwt.com", undefined);

    expect(connection.execute).toHaveBeenCalledTimes(3);
    expect(connection.execute).toHaveBeenNthCalledWith(
      1,
      "UPDATE user SET email='a'b@jwt.com', name='O'Brien' WHERE id=7",
      undefined,
    );
    expect(connection.execute).toHaveBeenNthCalledWith(2, SELECT_USER, ["a'b@jwt.com"]);
    expect(connection.execute).toHaveBeenNthCalledWith(3, SELECT_ROLES, [4]);
    expect(connection.end).toHaveBeenCalledTimes(2);
  });
});

describe('auth tokens', () => {
  test('getTokenSignature returns the third segment, or empty when there are fewer than three', () => {
    expect(DB.getTokenSignature('header.payload.signature')).toBe('signature');
    expect(DB.getTokenSignature('header.payload.signature.extra')).toBe('signature');
    expect(DB.getTokenSignature('header.payload')).toBe('');
    expect(DB.getTokenSignature('header')).toBe('');
    expect(DB.getTokenSignature('')).toBe('');
    expect(connection.execute).not.toHaveBeenCalled();
  });

  test('loginUser stores the token signature, not the full token', async () => {
    connection.execute.mockResolvedValueOnce([{ affectedRows: 1 }, undefined]);

    await DB.loginUser(3, 'header.payload.signature');

    expect(connection.execute).toHaveBeenCalledTimes(1);
    expect(connection.execute).toHaveBeenCalledWith(INSERT_AUTH, ['signature', 3]);
    expect(connection.query).toHaveBeenCalledWith('USE pizza');
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  test('loginUser stores an empty signature when the token has fewer than three segments', async () => {
    await DB.loginUser(3, 'not-a-jwt');

    expect(connection.execute).toHaveBeenCalledTimes(1);
    expect(connection.execute).toHaveBeenCalledWith(INSERT_AUTH, ['', 3]);
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  test('isLoggedIn is true when a row exists for the signature', async () => {
    connection.execute.mockResolvedValueOnce([[{ userId: 3 }], []]);

    await expect(DB.isLoggedIn('header.payload.signature')).resolves.toBe(true);

    expect(connection.execute).toHaveBeenCalledTimes(1);
    expect(connection.execute).toHaveBeenCalledWith(SELECT_AUTH, ['signature']);
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  test('isLoggedIn is false when no auth row exists', async () => {
    connection.execute.mockResolvedValueOnce([[], []]);

    await expect(DB.isLoggedIn('header.payload.signature')).resolves.toBe(false);

    expect(connection.execute).toHaveBeenCalledTimes(1);
    expect(connection.execute).toHaveBeenCalledWith(SELECT_AUTH, ['signature']);
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  test('isLoggedIn looks up an empty signature for a short token', async () => {
    connection.execute.mockResolvedValueOnce([[], []]);

    await expect(DB.isLoggedIn('only.two')).resolves.toBe(false);

    expect(connection.execute).toHaveBeenCalledTimes(1);
    expect(connection.execute).toHaveBeenCalledWith(SELECT_AUTH, ['']);
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  test('logoutUser deletes auth by signature', async () => {
    connection.execute.mockResolvedValueOnce([{ affectedRows: 1 }, undefined]);

    await DB.logoutUser('header.payload.signature');

    expect(connection.execute).toHaveBeenCalledTimes(1);
    expect(connection.execute).toHaveBeenCalledWith(DELETE_AUTH, ['signature']);
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  test('logoutUser deletes an empty signature when the token has fewer than three segments', async () => {
    await DB.logoutUser('only.two');

    expect(connection.execute).toHaveBeenCalledTimes(1);
    expect(connection.execute).toHaveBeenCalledWith(DELETE_AUTH, ['']);
    expect(connection.end).toHaveBeenCalledTimes(1);
  });
});
