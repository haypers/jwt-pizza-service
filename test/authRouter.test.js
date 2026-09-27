const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config.js');
const { StatusCodeError } = require('../src/endpointHelper.js');

jest.mock('../src/database/database.js', () => ({
  Role: { Diner: 'diner', Franchisee: 'franchisee', Admin: 'admin' },
  DB: {
    addUser: jest.fn(),
    getUser: jest.fn(),
    loginUser: jest.fn(),
    logoutUser: jest.fn(),
    isLoggedIn: jest.fn(),
  },
}));

const { DB } = require('../src/database/database.js');
const { authRouter, setAuthUser, setAuth } = require('../src/routes/authRouter.js');

const registeredUser = {
  id: 2,
  name: 'pizza diner',
  email: 'd@jwt.com',
  roles: [{ role: 'diner' }],
};

const adminUser = {
  id: 1,
  name: '常用名字',
  email: 'a@jwt.com',
  roles: [{ role: 'admin' }],
};

function createApp(options = {}) {
  const app = express();
  app.use(express.json());
  if (options.useSetAuthUser) {
    app.use(setAuthUser);
  }
  if ('user' in options) {
    const user = options.user;
    app.use((req, _res, next) => {
      req.user = user;
      next();
    });
  }
  app.use(authRouter);
  // Surface asyncHandler rejections. Production service does the same with statusCode.
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode ?? 500).json({ message: err.message });
  });
  return app;
}

const wrongSecret = 'definitely-not-the-service-secret';

function signedPayload(user) {
  return { ...user, iat: expect.any(Number) };
}

function tokenSignedWithWrongSecret(user = registeredUser) {
  return jwt.sign(user, wrongSecret);
}

function expectNextOnly(next) {
  expect(next).toHaveBeenCalledTimes(1);
  expect(next.mock.calls[0]).toEqual([]);
}

const app = createApp();

beforeEach(() => {
  jest.resetAllMocks();
});

describe('POST / register', () => {
  test.each([
    ['name is omitted', { email: 'd@jwt.com', password: 'diner' }],
    ['email is omitted', { name: 'pizza diner', password: 'diner' }],
    ['password is omitted', { name: 'pizza diner', email: 'd@jwt.com' }],
    ['name is blank', { name: '', email: 'd@jwt.com', password: 'diner' }],
    ['email is blank', { name: 'pizza diner', email: '', password: 'diner' }],
    ['password is blank', { name: 'pizza diner', email: 'd@jwt.com', password: '' }],
    ['name is null', { name: null, email: 'd@jwt.com', password: 'diner' }],
    ['email is null', { name: 'pizza diner', email: null, password: 'diner' }],
    ['password is null', { name: 'pizza diner', email: 'd@jwt.com', password: null }],
    ['the body is empty', {}],
  ])('returns 400 when %s and does not create a user', async (_label, body) => {
    const response = await request(app).post('/').send(body);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: 'name, email, and password are required' });
    expect(DB.addUser).not.toHaveBeenCalled();
    expect(DB.loginUser).not.toHaveBeenCalled();
  });

  test('creates a diner, returns that user with a verifiable token, and records the login', async () => {
    DB.addUser.mockResolvedValue(registeredUser);

    const response = await request(app).post('/').send({
      name: 'pizza diner',
      email: 'd@jwt.com',
      password: 'diner',
    });

    expect(response.status).toBe(200);
    expect(response.body.user).toEqual(registeredUser);
    expect(response.body.token).toEqual(expect.any(String));
    expect(jwt.verify(response.body.token, config.jwtSecret)).toEqual(signedPayload(registeredUser));
    expect(DB.addUser).toHaveBeenCalledTimes(1);
    expect(DB.addUser).toHaveBeenCalledWith({
      name: 'pizza diner',
      email: 'd@jwt.com',
      password: 'diner',
      roles: [{ role: 'diner' }],
    });
    expect(DB.loginUser).toHaveBeenCalledTimes(1);
    expect(DB.loginUser).toHaveBeenCalledWith(registeredUser.id, response.body.token);
  });

  test('accepts a whitespace-only name and still registers that value', async () => {
    const created = { id: 8, name: '   ', email: 'space@jwt.com', roles: [{ role: 'diner' }] };
    DB.addUser.mockResolvedValue(created);

    const response = await request(app).post('/').send({
      name: '   ',
      email: 'space@jwt.com',
      password: 'diner',
    });

    expect(response.status).toBe(200);
    expect(response.body.user).toEqual(created);
    expect(DB.addUser).toHaveBeenCalledWith({
      name: '   ',
      email: 'space@jwt.com',
      password: 'diner',
      roles: [{ role: 'diner' }],
    });
    expect(jwt.verify(response.body.token, config.jwtSecret)).toEqual(signedPayload(created));
    expect(DB.loginUser).toHaveBeenCalledWith(created.id, response.body.token);
  });

  test('propagates a rejected addUser status and message', async () => {
    DB.addUser.mockRejectedValue(new StatusCodeError('email already exists', 409));

    const response = await request(app).post('/').send({
      name: 'pizza diner',
      email: 'd@jwt.com',
      password: 'diner',
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ message: 'email already exists' });
    expect(DB.addUser).toHaveBeenCalledTimes(1);
    expect(DB.loginUser).not.toHaveBeenCalled();
  });

  test('propagates a loginUser failure after addUser has already succeeded', async () => {
    DB.addUser.mockResolvedValue(registeredUser);
    DB.loginUser.mockRejectedValue(new StatusCodeError('auth store down', 503));

    const response = await request(app).post('/').send({
      name: 'pizza diner',
      email: 'd@jwt.com',
      password: 'diner',
    });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ message: 'auth store down' });
    expect(DB.addUser).toHaveBeenCalledTimes(1);
    expect(DB.addUser).toHaveBeenCalledWith({
      name: 'pizza diner',
      email: 'd@jwt.com',
      password: 'diner',
      roles: [{ role: 'diner' }],
    });
    expect(DB.loginUser).toHaveBeenCalledTimes(1);
    expect(DB.loginUser).toHaveBeenCalledWith(registeredUser.id, expect.any(String));
    expect(DB.addUser.mock.invocationCallOrder[0]).toBeLessThan(DB.loginUser.mock.invocationCallOrder[0]);
    expect(jwt.verify(DB.loginUser.mock.calls[0][1], config.jwtSecret)).toEqual(signedPayload(registeredUser));
    expect(DB.getUser).not.toHaveBeenCalled();
    expect(DB.logoutUser).not.toHaveBeenCalled();
    expect(DB.isLoggedIn).not.toHaveBeenCalled();
  });
});

describe('PUT / login', () => {
  test('returns the user from getUser with a token registered for that user', async () => {
    DB.getUser.mockResolvedValue(adminUser);

    const response = await request(app).put('/').send({
      email: 'a@jwt.com',
      password: 'admin',
    });

    expect(response.status).toBe(200);
    expect(response.body.user).toEqual(adminUser);
    expect(jwt.verify(response.body.token, config.jwtSecret)).toEqual(signedPayload(adminUser));
    expect(DB.getUser).toHaveBeenCalledTimes(1);
    expect(DB.getUser).toHaveBeenCalledWith('a@jwt.com', 'admin');
    expect(DB.loginUser).toHaveBeenCalledTimes(1);
    expect(DB.loginUser).toHaveBeenCalledWith(adminUser.id, response.body.token);
  });

  test('returns 404 when getUser throws unknown user', async () => {
    DB.getUser.mockRejectedValue(new StatusCodeError('unknown user', 404));

    const response = await request(app).put('/').send({
      email: 'missing@jwt.com',
      password: 'nope',
    });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: 'unknown user' });
    expect(DB.getUser).toHaveBeenCalledWith('missing@jwt.com', 'nope');
    expect(DB.loginUser).not.toHaveBeenCalled();
  });

  test('does not require email or password and still logs in when getUser resolves', async () => {
    DB.getUser.mockResolvedValue(adminUser);

    const response = await request(app).put('/').send({});

    expect(response.status).toBe(200);
    expect(response.body.user).toEqual(adminUser);
    expect(jwt.verify(response.body.token, config.jwtSecret)).toEqual(signedPayload(adminUser));
    expect(DB.getUser).toHaveBeenCalledTimes(1);
    expect(DB.getUser).toHaveBeenCalledWith(undefined, undefined);
    expect(DB.loginUser).toHaveBeenCalledTimes(1);
    expect(DB.loginUser).toHaveBeenCalledWith(adminUser.id, response.body.token);
    expect(DB.addUser).not.toHaveBeenCalled();
  });
});

describe('DELETE / logout', () => {
  test('returns 401 when no user is attached and does not consult or delete a bearer token', async () => {
    const token = jwt.sign(registeredUser, config.jwtSecret);
    const response = await request(app).delete('/').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ message: 'unauthorized' });
    expect(DB.isLoggedIn).not.toHaveBeenCalled();
    expect(DB.logoutUser).not.toHaveBeenCalled();
  });

  test('returns 401 when setAuthUser sees no authorization header and does not touch the auth store', async () => {
    const guarded = createApp({ useSetAuthUser: true });

    const response = await request(guarded).delete('/');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ message: 'unauthorized' });
    expect(DB.isLoggedIn).not.toHaveBeenCalled();
    expect(DB.logoutUser).not.toHaveBeenCalled();
  });

  test('logs out the bearer token when req.user is set', async () => {
    const token = jwt.sign(registeredUser, config.jwtSecret);
    const authed = createApp({ user: registeredUser });

    const response = await request(authed).delete('/').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: 'logout successful' });
    expect(DB.logoutUser).toHaveBeenCalledTimes(1);
    expect(DB.logoutUser).toHaveBeenCalledWith(token);
  });

  test('reports success without calling logoutUser when req.user is set but no token is sent', async () => {
    const authed = createApp({ user: registeredUser });

    const response = await request(authed).delete('/');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: 'logout successful' });
    expect(DB.logoutUser).not.toHaveBeenCalled();
  });

  test('reports success without calling logoutUser when the header is Bearer with no token', async () => {
    const authed = createApp({ user: registeredUser });

    const response = await request(authed).delete('/').set('Authorization', 'Bearer');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: 'logout successful' });
    expect(DB.logoutUser).not.toHaveBeenCalled();
  });

  test('deletes the second header segment even when the scheme is not Bearer', async () => {
    const token = jwt.sign(registeredUser, config.jwtSecret);
    const authed = createApp({ user: registeredUser });

    const response = await request(authed).delete('/').set('Authorization', `Basic ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: 'logout successful' });
    expect(DB.logoutUser).toHaveBeenCalledTimes(1);
    expect(DB.logoutUser).toHaveBeenCalledWith(token);
  });

  test('propagates a logoutUser rejection', async () => {
    const token = jwt.sign(registeredUser, config.jwtSecret);
    const authed = createApp({ user: registeredUser });
    DB.logoutUser.mockRejectedValue(new StatusCodeError('auth store down', 503));

    const response = await request(authed).delete('/').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ message: 'auth store down' });
    expect(DB.logoutUser).toHaveBeenCalledWith(token);
  });

  test('rejects a token signed with the wrong secret when setAuthUser is mounted, even if isLoggedIn is true', async () => {
    const token = tokenSignedWithWrongSecret();
    DB.isLoggedIn.mockResolvedValue(true);
    const guarded = createApp({ useSetAuthUser: true });

    const response = await request(guarded).delete('/').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ message: 'unauthorized' });
    expect(DB.isLoggedIn).toHaveBeenCalledTimes(1);
    expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
    expect(DB.logoutUser).not.toHaveBeenCalled();
  });

  test('logs out the second segment of a non-bearer header after setAuthUser accepts it', async () => {
    const token = jwt.sign(registeredUser, config.jwtSecret);
    DB.isLoggedIn.mockResolvedValue(true);
    const guarded = createApp({ useSetAuthUser: true });

    const response = await request(guarded).delete('/').set('Authorization', `Basic ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: 'logout successful' });
    expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
    expect(DB.logoutUser).toHaveBeenCalledTimes(1);
    expect(DB.logoutUser).toHaveBeenCalledWith(token);
  });
});

describe('setAuthUser', () => {
  test('leaves req.user unset and calls next when Authorization is missing', async () => {
    const req = { headers: {} };
    const next = jest.fn();

    await setAuthUser(req, {}, next);

    expect(req.user).toBeUndefined();
    expect(DB.isLoggedIn).not.toHaveBeenCalled();
    expectNextOnly(next);
  });

  test('does not set req.user when the bearer token is not logged in', async () => {
    const token = jwt.sign(registeredUser, config.jwtSecret);
    const req = { headers: { authorization: `Bearer ${token}` } };
    const next = jest.fn();
    DB.isLoggedIn.mockResolvedValue(false);

    await setAuthUser(req, {}, next);

    expect(req.user).toBeUndefined();
    expect(DB.isLoggedIn).toHaveBeenCalledTimes(1);
    expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
    expectNextOnly(next);
  });

  test('keeps a pre-set req.user when the bearer token is not logged in', async () => {
    const token = jwt.sign(registeredUser, config.jwtSecret);
    const existing = { id: 99, roles: [{ role: 'admin' }] };
    const req = { headers: { authorization: `Bearer ${token}` }, user: existing };
    const next = jest.fn();
    DB.isLoggedIn.mockResolvedValue(false);

    await setAuthUser(req, {}, next);

    expect(req.user).toBe(existing);
    expect(DB.isLoggedIn).toHaveBeenCalledTimes(1);
    expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
    expectNextOnly(next);
  });

  test('keeps a pre-set req.user when isLoggedIn is false even if the token would fail verification', async () => {
    const token = tokenSignedWithWrongSecret();
    const existing = { id: 99, roles: [{ role: 'admin' }] };
    const req = { headers: { authorization: `Bearer ${token}` }, user: existing };
    const next = jest.fn();
    DB.isLoggedIn.mockResolvedValue(false);

    await setAuthUser(req, {}, next);

    expect(req.user).toBe(existing);
    expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
    expectNextOnly(next);
  });

  test('treats a Bearer header with no second segment as no token', async () => {
    const existing = { id: 99, roles: [{ role: 'admin' }] };
    const req = { headers: { authorization: 'Bearer' }, user: existing };
    const next = jest.fn();
    DB.isLoggedIn.mockResolvedValue(true);

    await setAuthUser(req, {}, next);

    expect(req.user).toBe(existing);
    expect(DB.isLoggedIn).not.toHaveBeenCalled();
    expectNextOnly(next);
  });

  test('ignores an authorization value that has no space', async () => {
    const token = jwt.sign(registeredUser, config.jwtSecret);
    const existing = { id: 99, roles: [{ role: 'admin' }] };
    const req = { headers: { authorization: token }, user: existing };
    const next = jest.fn();
    DB.isLoggedIn.mockResolvedValue(true);

    await setAuthUser(req, {}, next);

    expect(req.user).toBe(existing);
    expect(DB.isLoggedIn).not.toHaveBeenCalled();
    expectNextOnly(next);
  });

  test('verifies the second segment and ignores a non-bearer scheme', async () => {
    const token = jwt.sign(registeredUser, config.jwtSecret);
    const req = { headers: { authorization: `Basic ${token}` } };
    const next = jest.fn();
    DB.isLoggedIn.mockResolvedValue(true);

    await setAuthUser(req, {}, next);

    expect(req.user).toMatchObject(registeredUser);
    expect(req.user.iat).toEqual(expect.any(Number));
    expect(req.user.isRole('diner')).toBe(true);
    expect(DB.isLoggedIn).toHaveBeenCalledTimes(1);
    expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
    expectNextOnly(next);
  });

  test('still verifies a non-bearer token and clears req.user when the signature is wrong', async () => {
    const token = tokenSignedWithWrongSecret();
    const existing = { id: 3, roles: [{ role: 'admin' }] };
    const req = { headers: { authorization: `Basic ${token}` }, user: existing };
    const next = jest.fn();
    DB.isLoggedIn.mockResolvedValue(true);

    await setAuthUser(req, {}, next);

    expect(req.user).toBeNull();
    expect(DB.isLoggedIn).toHaveBeenCalledTimes(1);
    expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
    expectNextOnly(next);
  });

  test('sets req.user from a logged-in token and exposes isRole', async () => {
    const payload = {
      id: 7,
      name: 'Ada',
      email: 'ada@jwt.com',
      roles: [{ role: 'diner' }, { role: 'franchisee', objectId: 4 }],
    };
    const token = jwt.sign(payload, config.jwtSecret);
    const req = { headers: { authorization: `Bearer ${token}` } };
    const next = jest.fn();
    DB.isLoggedIn.mockResolvedValue(true);

    await setAuthUser(req, {}, next);

    expect(req.user).toMatchObject(payload);
    expect(req.user.iat).toEqual(expect.any(Number));
    expect(req.user.isRole('diner')).toBe(true);
    expect(req.user.isRole('franchisee')).toBe(true);
    expect(req.user.isRole('admin')).toBe(false);
    expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
    expectNextOnly(next);
  });

  test('isRole throws TypeError when a logged-in token has no roles array', async () => {
    const token = jwt.sign({ id: 7, email: 'ada@jwt.com' }, config.jwtSecret);
    const req = { headers: { authorization: `Bearer ${token}` } };
    const next = jest.fn();
    DB.isLoggedIn.mockResolvedValue(true);

    await setAuthUser(req, {}, next);

    expect(req.user).toMatchObject({ id: 7, email: 'ada@jwt.com' });
    expect(req.user.roles).toBeUndefined();
    expect(typeof req.user.isRole).toBe('function');
    expectNextOnly(next);
    expect(() => req.user.isRole('diner')).toThrow(TypeError);
    expect(() => req.user.isRole('diner')).toThrow("Cannot read properties of undefined (reading 'find')");
  });

  test('sets req.user to null when a logged-in token was signed with the wrong secret', async () => {
    const token = tokenSignedWithWrongSecret();
    const req = {
      headers: { authorization: `Bearer ${token}` },
      user: { id: 1, roles: [{ role: 'admin' }] },
    };
    const next = jest.fn();
    DB.isLoggedIn.mockResolvedValue(true);

    await setAuthUser(req, {}, next);

    expect(req.user).toBeNull();
    expect(DB.isLoggedIn).toHaveBeenCalledTimes(1);
    expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
    expectNextOnly(next);
  });
});

describe('authenticateToken', () => {
  test('responds 401 and does not call next when req.user is missing', () => {
    const req = {};
    const res = {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      send(body) {
        this.body = body;
        return this;
      },
    };
    const next = jest.fn();

    authRouter.authenticateToken(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: 'unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  test('responds 401 when req.user is null', () => {
    const req = { user: null };
    const res = {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      send(body) {
        this.body = body;
        return this;
      },
    };
    const next = jest.fn();

    authRouter.authenticateToken(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: 'unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next and does not respond when req.user is present', () => {
    const req = { user: registeredUser };
    const res = {
      status: jest.fn(),
      send: jest.fn(),
    };
    const next = jest.fn();

    authRouter.authenticateToken(req, res, next);

    expectNextOnly(next);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });
});

describe('setAuth', () => {
  test('signs the user with the service secret and registers that token', async () => {
    const user = {
      id: 9,
      name: 'Sam',
      email: 'sam@jwt.com',
      roles: [{ role: 'franchisee', objectId: 3 }],
    };

    const token = await setAuth(user);

    expect(token).toEqual(expect.any(String));
    expect(jwt.verify(token, config.jwtSecret)).toEqual(signedPayload(user));
    expect(DB.loginUser).toHaveBeenCalledTimes(1);
    expect(DB.loginUser).toHaveBeenCalledWith(user.id, token);
  });
});
