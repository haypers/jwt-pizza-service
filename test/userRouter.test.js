const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const config = require('../src/config.js');

jest.mock('../src/database/database.js', () => ({
  Role: { Diner: 'diner', Franchisee: 'franchisee', Admin: 'admin' },
  DB: {
    addUser: jest.fn(),
    getUser: jest.fn(),
    updateUser: jest.fn(),
    loginUser: jest.fn(),
    logoutUser: jest.fn(),
    isLoggedIn: jest.fn(),
  },
}));

const { DB } = require('../src/database/database.js');
const { setAuthUser } = require('../src/routes/authRouter.js');
const userRouter = require('../src/routes/userRouter.js');

const diner = {
  id: 2,
  name: 'pizza diner',
  email: 'd@jwt.com',
  roles: [{ role: 'diner' }],
};

const admin = {
  id: 1,
  name: '常用名字',
  email: 'a@jwt.com',
  roles: [{ role: 'admin' }],
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(setAuthUser);
  app.use('/api/user', userRouter);
  app.use((err, req, res, next) => {
    res.status(err.statusCode ?? 500).json({ message: err.message });
  });
  return app;
}

function signUser(user) {
  return jwt.sign(user, config.jwtSecret);
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

function tokenPayload(user) {
  return { ...user, iat: expect.any(Number) };
}

function expectNoUserDbAccess() {
  expect(DB.addUser).not.toHaveBeenCalled();
  expect(DB.getUser).not.toHaveBeenCalled();
  expect(DB.updateUser).not.toHaveBeenCalled();
  expect(DB.loginUser).not.toHaveBeenCalled();
  expect(DB.logoutUser).not.toHaveBeenCalled();
}

describe('userRouter', () => {
  let app;

  beforeEach(() => {
    DB.addUser.mockReset();
    DB.getUser.mockReset();
    DB.updateUser.mockReset();
    DB.loginUser.mockReset();
    DB.logoutUser.mockReset();
    DB.isLoggedIn.mockReset();
    app = createApp();
  });

  describe('GET /api/user/me', () => {
    test('returns 401 unauthorized when no token is sent', async () => {
      const response = await request(app).get('/api/user/me');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ message: 'unauthorized' });
      expect(DB.isLoggedIn).not.toHaveBeenCalled();
      expectNoUserDbAccess();
    });

    test('returns 401 when the token is not a logged-in session', async () => {
      DB.isLoggedIn.mockResolvedValue(false);
      const token = signUser(diner);

      const response = await request(app).get('/api/user/me').set(bearer(token));

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ message: 'unauthorized' });
      expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
      expectNoUserDbAccess();
    });

    test('returns the authenticated user identity from a valid logged-in token', async () => {
      DB.isLoggedIn.mockResolvedValue(true);
      const token = signUser(diner);

      const response = await request(app).get('/api/user/me').set(bearer(token));

      expect(response.status).toBe(200);
      expect(response.body).toEqual(jwt.verify(token, config.jwtSecret));
      expect(DB.isLoggedIn).toHaveBeenCalledTimes(1);
      expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
      expectNoUserDbAccess();
    });
  });

  describe('PUT /api/user/:userId', () => {
    test('returns 401 and does not call updateUser when no token is sent', async () => {
      const response = await request(app)
        .put(`/api/user/${diner.id}`)
        .send({ name: 'updated diner', email: 'updated@jwt.com', password: 'new-secret' });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ message: 'unauthorized' });
      expect(DB.isLoggedIn).not.toHaveBeenCalled();
      expect(DB.updateUser).not.toHaveBeenCalled();
      expect(DB.loginUser).not.toHaveBeenCalled();
    });

    test('returns 401 and does not call updateUser when the session is logged out', async () => {
      DB.isLoggedIn.mockResolvedValue(false);
      const token = signUser(diner);

      const response = await request(app)
        .put(`/api/user/${diner.id}`)
        .set(bearer(token))
        .send({ name: 'updated diner', email: 'updated@jwt.com', password: 'new-secret' });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ message: 'unauthorized' });
      expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
      expect(DB.updateUser).not.toHaveBeenCalled();
      expect(DB.loginUser).not.toHaveBeenCalled();
    });

    test('updates the caller and signs the token for the user updateUser returns', async () => {
      const updatedUser = {
        id: 50,
        name: 'updated diner',
        email: 'updated@jwt.com',
        roles: [{ role: 'diner' }],
      };
      DB.isLoggedIn.mockResolvedValue(true);
      DB.updateUser.mockResolvedValue(updatedUser);
      DB.loginUser.mockResolvedValue(undefined);
      const token = signUser(diner);
      const body = { name: 'updated diner', email: 'updated@jwt.com', password: 'new-secret' };

      const response = await request(app).put(`/api/user/${diner.id}`).set(bearer(token)).send(body);

      expect(response.status).toBe(200);
      expect(response.body.user).toEqual(updatedUser);
      expect(DB.updateUser).toHaveBeenCalledTimes(1);
      expect(DB.updateUser).toHaveBeenCalledWith(diner.id, body.name, body.email, body.password);
      expect(DB.updateUser.mock.calls[0][0]).not.toBe(updatedUser.id);
      expect(jwt.verify(response.body.token, config.jwtSecret)).toEqual(tokenPayload(updatedUser));
      expect(DB.loginUser).toHaveBeenCalledTimes(1);
      expect(DB.loginUser).toHaveBeenCalledWith(updatedUser.id, response.body.token);
      expect(DB.loginUser.mock.calls[0][0]).not.toBe(diner.id);
    });

    test('gives an admin a token and login for the updated user, not the admin', async () => {
      const updatedUser = {
        id: 77,
        name: 'renamed diner',
        email: 'renamed@jwt.com',
        roles: [{ role: 'diner' }],
      };
      DB.isLoggedIn.mockResolvedValue(true);
      DB.updateUser.mockResolvedValue(updatedUser);
      DB.loginUser.mockResolvedValue(undefined);
      const token = signUser(admin);
      const body = { name: 'renamed diner', email: 'renamed@jwt.com', password: 'changed' };

      const response = await request(app).put(`/api/user/${diner.id}`).set(bearer(token)).send(body);

      expect(response.status).toBe(200);
      expect(response.body.user).toEqual(updatedUser);
      expect(DB.updateUser).toHaveBeenCalledTimes(1);
      expect(DB.updateUser).toHaveBeenCalledWith(diner.id, body.name, body.email, body.password);
      expect(DB.updateUser.mock.calls[0][0]).not.toBe(admin.id);
      expect(DB.updateUser.mock.calls[0][0]).not.toBe(updatedUser.id);

      expect(jwt.verify(response.body.token, config.jwtSecret)).toEqual(tokenPayload(updatedUser));
      expect(DB.loginUser).toHaveBeenCalledTimes(1);
      expect(DB.loginUser).toHaveBeenCalledWith(updatedUser.id, response.body.token);
      expect(DB.loginUser.mock.calls[0][0]).not.toBe(admin.id);
      expect(DB.loginUser.mock.calls[0][0]).not.toBe(diner.id);
    });

    test('passes NaN to updateUser when an admin sends a non-numeric user id', async () => {
      const updatedUser = {
        id: 77,
        name: 'renamed diner',
        email: 'renamed@jwt.com',
        roles: [{ role: 'diner' }],
      };
      DB.isLoggedIn.mockResolvedValue(true);
      DB.updateUser.mockResolvedValue(updatedUser);
      DB.loginUser.mockResolvedValue(undefined);
      const token = signUser(admin);
      const body = { name: 'renamed diner', email: 'renamed@jwt.com', password: 'changed' };

      const response = await request(app).put('/api/user/abc').set(bearer(token)).send(body);

      expect(response.status).toBe(200);
      expect(DB.updateUser).toHaveBeenCalledTimes(1);
      const [userId, name, email, password] = DB.updateUser.mock.calls[0];
      expect(userId).toBeNaN();
      expect(name).toBe(body.name);
      expect(email).toBe(body.email);
      expect(password).toBe(body.password);
      expect(DB.loginUser).toHaveBeenCalledWith(updatedUser.id, response.body.token);
      expect(jwt.verify(response.body.token, config.jwtSecret)).toEqual(tokenPayload(updatedUser));
    });

    test('returns 403 and does not call updateUser when a non-admin sends a non-numeric user id', async () => {
      DB.isLoggedIn.mockResolvedValue(true);
      const token = signUser(diner);

      const response = await request(app)
        .put('/api/user/abc')
        .set(bearer(token))
        .send({ name: 'nope', email: 'nope@jwt.com', password: 'nope' });

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ message: 'unauthorized' });
      expect(DB.updateUser).not.toHaveBeenCalled();
      expect(DB.loginUser).not.toHaveBeenCalled();
    });

    test.each([
      ['name is omitted', { email: 'kept@jwt.com', password: 'secret' }, undefined, 'kept@jwt.com', 'secret'],
      ['email is omitted', { name: 'kept name', password: 'secret' }, 'kept name', undefined, 'secret'],
      ['password is omitted', { name: 'kept name', email: 'kept@jwt.com' }, 'kept name', 'kept@jwt.com', undefined],
      ['name, email, and password are omitted', {}, undefined, undefined, undefined],
    ])(
      'does not validate the body when %s and still sends those values to updateUser',
      async (_label, body, name, email, password) => {
        const updatedUser = {
          id: 50,
          name: 'from-db',
          email: 'from-db@jwt.com',
          roles: [{ role: 'diner' }],
        };
        DB.isLoggedIn.mockResolvedValue(true);
        DB.updateUser.mockResolvedValue(updatedUser);
        DB.loginUser.mockResolvedValue(undefined);
        const token = signUser(diner);

        const response = await request(app).put(`/api/user/${diner.id}`).set(bearer(token)).send(body);

        expect(response.status).toBe(200);
        expect(response.body.user).toEqual(updatedUser);
        expect(DB.updateUser).toHaveBeenCalledTimes(1);
        expect(DB.updateUser).toHaveBeenCalledWith(diner.id, name, email, password);
        expect(DB.loginUser).toHaveBeenCalledWith(updatedUser.id, response.body.token);
      }
    );

    test('returns 403 unauthorized when a non-admin updates a different user', async () => {
      DB.isLoggedIn.mockResolvedValue(true);
      const token = signUser(diner);
      const otherUserId = 99;

      const response = await request(app)
        .put(`/api/user/${otherUserId}`)
        .set(bearer(token))
        .send({ name: 'nope', email: 'nope@jwt.com', password: 'nope' });

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ message: 'unauthorized' });
      expect(DB.updateUser).not.toHaveBeenCalled();
      expect(DB.loginUser).not.toHaveBeenCalled();
    });

    test('propagates status and message when DB.updateUser rejects', async () => {
      const dbError = new Error('email already used');
      dbError.statusCode = 409;
      DB.isLoggedIn.mockResolvedValue(true);
      DB.updateUser.mockRejectedValue(dbError);
      const token = signUser(diner);

      const response = await request(app)
        .put(`/api/user/${diner.id}`)
        .set(bearer(token))
        .send({ name: diner.name, email: 'taken@jwt.com', password: 'secret' });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ message: 'email already used' });
      expect(DB.updateUser).toHaveBeenCalledWith(diner.id, diner.name, 'taken@jwt.com', 'secret');
      expect(DB.loginUser).not.toHaveBeenCalled();
    });

    test('uses 500 when a rejected update has no statusCode', async () => {
      DB.isLoggedIn.mockResolvedValue(true);
      DB.updateUser.mockRejectedValue(new Error('connection lost'));
      const token = signUser(diner);

      const response = await request(app)
        .put(`/api/user/${diner.id}`)
        .set(bearer(token))
        .send({ name: 'n', email: 'e@jwt.com', password: 'p' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ message: 'connection lost' });
      expect(DB.updateUser).toHaveBeenCalledWith(diner.id, 'n', 'e@jwt.com', 'p');
      expect(DB.loginUser).not.toHaveBeenCalled();
    });

    test('returns the loginUser error after updateUser has already succeeded', async () => {
      const updatedUser = {
        id: 50,
        name: 'updated diner',
        email: 'updated@jwt.com',
        roles: [{ role: 'diner' }],
      };
      const loginError = new Error('session store down');
      loginError.statusCode = 503;
      DB.isLoggedIn.mockResolvedValue(true);
      DB.updateUser.mockResolvedValue(updatedUser);
      DB.loginUser.mockRejectedValue(loginError);
      const token = signUser(diner);
      const body = { name: 'updated diner', email: 'updated@jwt.com', password: 'new-secret' };

      const response = await request(app).put(`/api/user/${diner.id}`).set(bearer(token)).send(body);

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ message: 'session store down' });
      expect(DB.updateUser).toHaveBeenCalledTimes(1);
      expect(DB.updateUser).toHaveBeenCalledWith(diner.id, body.name, body.email, body.password);
      expect(DB.loginUser).toHaveBeenCalledTimes(1);
      const [storedUserId, storedToken] = DB.loginUser.mock.calls[0];
      expect(storedUserId).toBe(updatedUser.id);
      expect(jwt.verify(storedToken, config.jwtSecret)).toEqual(tokenPayload(updatedUser));
      expect(DB.updateUser.mock.invocationCallOrder[0]).toBeLessThan(DB.loginUser.mock.invocationCallOrder[0]);
    });
  });

  describe('DELETE /api/user/:userId', () => {
    test('returns the not-implemented stub and does not touch user records', async () => {
      DB.isLoggedIn.mockResolvedValue(true);
      const token = signUser(diner);

      const response = await request(app).delete(`/api/user/${diner.id}`).set(bearer(token));

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: 'not implemented' });
      expect(DB.isLoggedIn).toHaveBeenCalledTimes(1);
      expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
      expectNoUserDbAccess();
    });

    test('returns 401 unauthorized without auth and does not touch the database', async () => {
      const response = await request(app).delete('/api/user/2');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ message: 'unauthorized' });
      expect(DB.isLoggedIn).not.toHaveBeenCalled();
      expectNoUserDbAccess();
    });
  });

  describe('GET /api/user', () => {
    test('returns the empty not-implemented list and does not touch user records', async () => {
      DB.isLoggedIn.mockResolvedValue(true);
      const token = signUser(admin);

      const response = await request(app).get('/api/user').set(bearer(token));

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: 'not implemented', users: [], more: false });
      expect(DB.isLoggedIn).toHaveBeenCalledTimes(1);
      expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
      expectNoUserDbAccess();
    });

    test('returns 401 unauthorized without auth and does not touch the database', async () => {
      const response = await request(app).get('/api/user');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ message: 'unauthorized' });
      expect(DB.isLoggedIn).not.toHaveBeenCalled();
      expectNoUserDbAccess();
    });
  });
});
