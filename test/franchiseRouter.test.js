const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const config = require('../src/config.js');

jest.mock('../src/database/database.js', () => ({
  Role: { Diner: 'diner', Franchisee: 'franchisee', Admin: 'admin' },
  DB: {
    getFranchises: jest.fn(),
    getUserFranchises: jest.fn(),
    getFranchise: jest.fn(),
    createFranchise: jest.fn(),
    deleteFranchise: jest.fn(),
    createStore: jest.fn(),
    deleteStore: jest.fn(),
    isLoggedIn: jest.fn(),
    loginUser: jest.fn(),
    logoutUser: jest.fn(),
  },
}));

const { DB, Role } = require('../src/database/database.js');
const { setAuthUser } = require('../src/routes/authRouter.js');
const franchiseRouter = require('../src/routes/franchiseRouter.js');

const diner = {
  id: 2,
  name: 'pizza diner',
  email: 'd@jwt.com',
  roles: [{ role: Role.Diner }],
};

const admin = {
  id: 1,
  name: '常用名字',
  email: 'a@jwt.com',
  roles: [{ role: Role.Admin }],
};

const franchisee = {
  id: 4,
  name: 'pizza franchisee',
  email: 'f@jwt.com',
  roles: [{ role: Role.Franchisee }],
};

const otherFranchisee = {
  id: 5,
  name: 'other franchisee',
  email: 'o@jwt.com',
  roles: [{ role: Role.Franchisee }],
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(setAuthUser);
  app.use(franchiseRouter);
  app.use((err, _req, res, _next) => {
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

function login(user) {
  const token = signUser(user);
  DB.isLoggedIn.mockResolvedValue(true);
  return token;
}

function rejection(message, statusCode) {
  const error = new Error(message);
  if (statusCode !== undefined) {
    error.statusCode = statusCode;
  }
  return error;
}

function expectSameAuthUser(actualUser, token) {
  const verified = jwt.verify(token, config.jwtSecret);
  const { isRole, ...payload } = actualUser;
  expect(payload).toEqual(verified);
  expect(typeof isRole).toBe('function');
  expect(isRole(Role.Diner)).toBe(verified.roles.some((entry) => entry.role === Role.Diner));
  expect(isRole(Role.Franchisee)).toBe(verified.roles.some((entry) => entry.role === Role.Franchisee));
  expect(isRole(Role.Admin)).toBe(verified.roles.some((entry) => entry.role === Role.Admin));
  expect(isRole('missing')).toBe(false);
}

function franchiseRecord(overrides = {}) {
  return {
    id: 1,
    name: 'pizzaPocket',
    admins: [{ id: franchisee.id, name: franchisee.name, email: franchisee.email }],
    stores: [{ id: 1, name: 'SLC', totalRevenue: 0 }],
    ...overrides,
  };
}

describe('franchiseRouter', () => {
  let app;

  beforeEach(() => {
    DB.getFranchises.mockReset();
    DB.getUserFranchises.mockReset();
    DB.getFranchise.mockReset();
    DB.createFranchise.mockReset();
    DB.deleteFranchise.mockReset();
    DB.createStore.mockReset();
    DB.deleteStore.mockReset();
    DB.isLoggedIn.mockReset();
    DB.loginUser.mockReset();
    DB.logoutUser.mockReset();
    app = createApp();
  });

  describe('GET /', () => {
    test('lists franchises without auth and passes query values through as strings', async () => {
      const franchises = [franchiseRecord()];
      DB.getFranchises.mockResolvedValue([franchises, true]);

      const response = await request(app).get('/?page=0&limit=10&name=*');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ franchises, more: true });
      expect(DB.getFranchises).toHaveBeenCalledTimes(1);
      expect(DB.getFranchises).toHaveBeenCalledWith(undefined, '0', '10', '*');
      expect(DB.isLoggedIn).not.toHaveBeenCalled();
      expect(DB.getUserFranchises).not.toHaveBeenCalled();
    });

    test('passes a logged-in caller and decoded query strings to getFranchises', async () => {
      const franchises = [franchiseRecord({ id: 3, name: 'slice' })];
      DB.getFranchises.mockResolvedValue([franchises, false]);
      const token = login(admin);

      const response = await request(app).get('/?page=1&limit=3&name=pizza%20Pocket').set(bearer(token));

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ franchises, more: false });
      expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
      const [authUser, page, limit, name] = DB.getFranchises.mock.calls[0];
      expectSameAuthUser(authUser, token);
      expect(page).toBe('1');
      expect(limit).toBe('3');
      expect(name).toBe('pizza Pocket');
    });

    test('passes undefined page, limit, and name when the query string is omitted', async () => {
      DB.getFranchises.mockResolvedValue([[], false]);

      const response = await request(app).get('/');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ franchises: [], more: false });
      expect(DB.getFranchises).toHaveBeenCalledWith(undefined, undefined, undefined, undefined);
    });

    test('passes empty query strings through unchanged', async () => {
      DB.getFranchises.mockResolvedValue([[], true]);

      const response = await request(app).get('/?page=&limit=&name=');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ franchises: [], more: true });
      expect(DB.getFranchises).toHaveBeenCalledWith(undefined, '', '', '');
    });

    test('still lists franchises when a bearer token is not a logged-in session', async () => {
      DB.isLoggedIn.mockResolvedValue(false);
      DB.getFranchises.mockResolvedValue([[], false]);
      const token = signUser(diner);

      const response = await request(app).get('/?page=2&limit=5&name=slice').set(bearer(token));

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ franchises: [], more: false });
      expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
      expect(DB.getFranchises).toHaveBeenCalledWith(undefined, '2', '5', 'slice');
    });

    test('passes a null user when the token is logged in but cannot be verified', async () => {
      DB.isLoggedIn.mockResolvedValue(true);
      DB.getFranchises.mockResolvedValue([[], false]);
      const token = jwt.sign(diner, 'wrong-secret');

      const response = await request(app).get('/?page=4&limit=1&name=pie').set(bearer(token));

      expect(response.status).toBe(200);
      expect(DB.getFranchises).toHaveBeenCalledWith(null, '4', '1', 'pie');
    });

    test('returns the rejected getFranchises status and message', async () => {
      DB.getFranchises.mockRejectedValue(rejection('franchise list failed', 503));

      const response = await request(app).get('/?page=0&limit=10&name=*');

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ message: 'franchise list failed' });
    });

    test('returns 500 when getFranchises rejects without a status code', async () => {
      DB.getFranchises.mockRejectedValue(rejection('database unavailable'));

      const response = await request(app).get('/');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ message: 'database unavailable' });
    });
  });

  describe('GET /:userId', () => {
    const listed = [franchiseRecord({ id: 2 })];

    test('returns 401 when no token is sent', async () => {
      const response = await request(app).get(`/${diner.id}`);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ message: 'unauthorized' });
      expect(DB.getUserFranchises).not.toHaveBeenCalled();
      expect(DB.isLoggedIn).not.toHaveBeenCalled();
    });

    test('returns 401 when the token is not a logged-in session', async () => {
      DB.isLoggedIn.mockResolvedValue(false);
      const token = signUser(diner);

      const response = await request(app).get(`/${diner.id}`).set(bearer(token));

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ message: 'unauthorized' });
      expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
      expect(DB.getUserFranchises).not.toHaveBeenCalled();
    });

    test('returns 401 when a logged-in token fails verification', async () => {
      DB.isLoggedIn.mockResolvedValue(true);
      const token = jwt.sign(diner, 'wrong-secret');

      const response = await request(app).get(`/${diner.id}`).set(bearer(token));

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ message: 'unauthorized' });
      expect(DB.getUserFranchises).not.toHaveBeenCalled();
    });

    test('returns the caller franchises when the user id matches', async () => {
      DB.getUserFranchises.mockResolvedValue(listed);
      const token = login(diner);

      const response = await request(app).get(`/${diner.id}`).set(bearer(token));

      expect(response.status).toBe(200);
      expect(response.body).toEqual(listed);
      expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
      expect(DB.getUserFranchises).toHaveBeenCalledTimes(1);
      expect(DB.getUserFranchises).toHaveBeenCalledWith(diner.id);
    });

    test('coerces the userId param with Number before the ownership check', async () => {
      DB.getUserFranchises.mockResolvedValue(listed);
      const token = login(franchisee);

      const response = await request(app).get('/04').set(bearer(token));

      expect(response.status).toBe(200);
      expect(response.body).toEqual(listed);
      expect(DB.getUserFranchises).toHaveBeenCalledWith(4);
    });

    test('lets an admin list another user franchises', async () => {
      DB.getUserFranchises.mockResolvedValue(listed);
      const token = login(admin);

      const response = await request(app).get(`/${franchisee.id}`).set(bearer(token));

      expect(response.status).toBe(200);
      expect(response.body).toEqual(listed);
      expect(DB.getUserFranchises).toHaveBeenCalledWith(franchisee.id);
    });

    test('lets a user who also has the admin role list another user', async () => {
      const mixed = {
        id: 8,
        name: 'mixed',
        email: 'm@jwt.com',
        roles: [{ role: Role.Diner }, { role: Role.Admin }],
      };
      DB.getUserFranchises.mockResolvedValue(listed);
      const token = login(mixed);

      const response = await request(app).get(`/${diner.id}`).set(bearer(token));

      expect(response.status).toBe(200);
      expect(response.body).toEqual(listed);
      expect(DB.getUserFranchises).toHaveBeenCalledWith(diner.id);
    });

    test('returns an empty list when a non-owner non-admin asks for someone else and does not 403', async () => {
      const token = login(diner);

      const response = await request(app).get(`/${franchisee.id}`).set(bearer(token));

      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
      expect(DB.getUserFranchises).not.toHaveBeenCalled();
    });

    test('returns the rejected getUserFranchises status and message', async () => {
      DB.getUserFranchises.mockRejectedValue(rejection('user franchise lookup failed', 404));
      const token = login(admin);

      const response = await request(app).get(`/${diner.id}`).set(bearer(token));

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ message: 'user franchise lookup failed' });
    });
  });

  describe('POST /', () => {
    const body = { name: 'pizzaPocket', admins: [{ email: 'f@jwt.com' }] };
    const created = {
      id: 1,
      name: 'pizzaPocket',
      admins: [{ email: 'f@jwt.com', id: 4, name: 'pizza franchisee' }],
    };

    test('returns 401 when no token is sent', async () => {
      const response = await request(app).post('/').send(body);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ message: 'unauthorized' });
      expect(DB.createFranchise).not.toHaveBeenCalled();
      expect(DB.isLoggedIn).not.toHaveBeenCalled();
    });

    test('returns 401 when the token is not a logged-in session', async () => {
      DB.isLoggedIn.mockResolvedValue(false);
      const token = signUser(admin);

      const response = await request(app).post('/').set(bearer(token)).send(body);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ message: 'unauthorized' });
      expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
      expect(DB.createFranchise).not.toHaveBeenCalled();
    });

    test('returns 401 when a logged-in token fails verification', async () => {
      DB.isLoggedIn.mockResolvedValue(true);
      const token = jwt.sign(admin, 'wrong-secret');

      const response = await request(app).post('/').set(bearer(token)).send(body);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ message: 'unauthorized' });
      expect(DB.createFranchise).not.toHaveBeenCalled();
    });

    test('returns 403 when a non-admin creates a franchise', async () => {
      const token = login(diner);

      const response = await request(app).post('/').set(bearer(token)).send(body);

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ message: 'unable to create a franchise' });
      expect(DB.createFranchise).not.toHaveBeenCalled();
    });

    test('throws when the token has no roles property and the route calls isRole', async () => {
      const token = login({ id: 9, name: 'no roles', email: 'n@jwt.com' });

      const response = await request(app).post('/').set(bearer(token)).send(body);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ message: "Cannot read properties of undefined (reading 'find')" });
      expect(DB.createFranchise).not.toHaveBeenCalled();
    });

    test('creates a franchise for an admin and sends the database result', async () => {
      DB.createFranchise.mockResolvedValue(created);
      const token = login(admin);

      const response = await request(app).post('/').set(bearer(token)).send(body);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(created);
      expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
      expect(DB.createFranchise).toHaveBeenCalledTimes(1);
      expect(DB.createFranchise).toHaveBeenCalledWith(body);
    });

    test('returns the rejected createFranchise status and message', async () => {
      DB.createFranchise.mockRejectedValue(rejection('unknown user for franchise admin f@jwt.com provided', 404));
      const token = login(admin);

      const response = await request(app).post('/').set(bearer(token)).send(body);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ message: 'unknown user for franchise admin f@jwt.com provided' });
    });

    test('returns 500 when createFranchise rejects without a status code', async () => {
      DB.createFranchise.mockRejectedValue(rejection('insert failed'));
      const token = login(admin);

      const response = await request(app).post('/').set(bearer(token)).send(body);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ message: 'insert failed' });
    });
  });

  describe('DELETE /:franchiseId', () => {
    // Current behavior: this route does not call authenticateToken. Adding it
    // would turn the anonymous request into 401 and skip deleteFranchise.
    test('lets an anonymous caller delete a franchise because the route does not authenticate', async () => {
      DB.deleteFranchise.mockResolvedValue(undefined);

      const response = await request(app).delete('/1');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: 'franchise deleted' });
      expect(DB.deleteFranchise).toHaveBeenCalledTimes(1);
      expect(DB.deleteFranchise).toHaveBeenCalledWith(1);
      expect(DB.isLoggedIn).not.toHaveBeenCalled();
      expect(DB.getFranchise).not.toHaveBeenCalled();
    });

    test('still deletes when a bearer token is present but not a logged-in session', async () => {
      DB.isLoggedIn.mockResolvedValue(false);
      DB.deleteFranchise.mockResolvedValue(undefined);
      const token = signUser(diner);

      const response = await request(app).delete('/9').set(bearer(token));

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: 'franchise deleted' });
      expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
      expect(DB.deleteFranchise).toHaveBeenCalledTimes(1);
      expect(DB.deleteFranchise).toHaveBeenCalledWith(9);
      expect(DB.getFranchise).not.toHaveBeenCalled();
    });

    test('passes the franchise id through Number', async () => {
      DB.deleteFranchise.mockResolvedValue(undefined);

      const response = await request(app).delete('/08');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: 'franchise deleted' });
      expect(DB.deleteFranchise).toHaveBeenCalledWith(8);
    });

    test('passes NaN to deleteFranchise when franchiseId is not numeric', async () => {
      DB.deleteFranchise.mockResolvedValue(undefined);

      const response = await request(app).delete('/nope');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: 'franchise deleted' });
      expect(DB.deleteFranchise).toHaveBeenCalledTimes(1);
      expect(DB.deleteFranchise.mock.calls[0][0]).toBeNaN();
      expect(DB.isLoggedIn).not.toHaveBeenCalled();
    });

    test('returns the rejected deleteFranchise status and message', async () => {
      DB.deleteFranchise.mockRejectedValue(rejection('unable to delete franchise', 500));

      const response = await request(app).delete('/1');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ message: 'unable to delete franchise' });
    });

    test('returns a non-500 status when deleteFranchise rejects with one', async () => {
      DB.deleteFranchise.mockRejectedValue(rejection('franchise is locked', 409));

      const response = await request(app).delete('/2');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ message: 'franchise is locked' });
    });
  });

  describe('POST /:franchiseId/store', () => {
    const body = { franchiseId: 1, name: 'SLC' };
    const createdStore = { id: 1, name: 'SLC', totalRevenue: 0 };

    test('returns 401 when no token is sent', async () => {
      const response = await request(app).post('/1/store').send(body);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ message: 'unauthorized' });
      expect(DB.getFranchise).not.toHaveBeenCalled();
      expect(DB.createStore).not.toHaveBeenCalled();
      expect(DB.isLoggedIn).not.toHaveBeenCalled();
    });

    test('returns 401 when the token is not a logged-in session', async () => {
      DB.isLoggedIn.mockResolvedValue(false);
      const token = signUser(admin);

      const response = await request(app).post('/1/store').set(bearer(token)).send(body);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ message: 'unauthorized' });
      expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
      expect(DB.getFranchise).not.toHaveBeenCalled();
      expect(DB.createStore).not.toHaveBeenCalled();
    });

    test('returns 401 when a logged-in token fails verification', async () => {
      DB.isLoggedIn.mockResolvedValue(true);
      const token = jwt.sign(admin, 'wrong-secret');

      const response = await request(app).post('/1/store').set(bearer(token)).send(body);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ message: 'unauthorized' });
      expect(DB.getFranchise).not.toHaveBeenCalled();
      expect(DB.createStore).not.toHaveBeenCalled();
    });

    test('returns 403 when the franchise does not exist', async () => {
      DB.getFranchise.mockResolvedValue(null);
      const token = login(admin);

      const response = await request(app).post('/1/store').set(bearer(token)).send(body);

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ message: 'unable to create a store' });
      expect(DB.getFranchise).toHaveBeenCalledTimes(1);
      expect(DB.getFranchise).toHaveBeenCalledWith({ id: 1 });
      expect(DB.createStore).not.toHaveBeenCalled();
    });

    test('returns 403 when the caller is not an admin and is not in franchise.admins', async () => {
      DB.getFranchise.mockResolvedValue(franchiseRecord());
      const token = login(otherFranchisee);

      const response = await request(app).post('/1/store').set(bearer(token)).send(body);

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ message: 'unable to create a store' });
      expect(DB.getFranchise).toHaveBeenCalledWith({ id: 1 });
      expect(DB.createStore).not.toHaveBeenCalled();
    });

    test('throws when a non-admin creates a store and franchise.admins is missing', async () => {
      DB.getFranchise.mockResolvedValue(franchiseRecord({ admins: undefined }));
      const token = login(diner);

      const response = await request(app).post('/1/store').set(bearer(token)).send(body);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ message: "Cannot read properties of undefined (reading 'some')" });
      expect(DB.getFranchise).toHaveBeenCalledWith({ id: 1 });
      expect(DB.createStore).not.toHaveBeenCalled();
    });

    test('throws when a non-admin creates a store and franchise.admins is not an array', async () => {
      DB.getFranchise.mockResolvedValue(franchiseRecord({ admins: { id: diner.id } }));
      const token = login(franchisee);

      const response = await request(app).post('/1/store').set(bearer(token)).send(body);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ message: 'franchise.admins.some is not a function' });
      expect(DB.createStore).not.toHaveBeenCalled();
    });

    test('lets an admin create a store without being listed in franchise.admins', async () => {
      const franchise = franchiseRecord();
      DB.getFranchise.mockResolvedValue(franchise);
      DB.createStore.mockResolvedValue(createdStore);
      const token = login(admin);

      const response = await request(app).post('/1/store').set(bearer(token)).send(body);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(createdStore);
      expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
      expect(DB.getFranchise).toHaveBeenCalledWith({ id: 1 });
      expect(DB.createStore).toHaveBeenCalledTimes(1);
      expect(DB.createStore).toHaveBeenCalledWith(franchise.id, body);
    });

    test('lets a non-admin create a store when their id is in franchise.admins', async () => {
      const franchise = franchiseRecord({
        admins: [{ id: diner.id, name: diner.name, email: diner.email }],
      });
      DB.getFranchise.mockResolvedValue(franchise);
      DB.createStore.mockResolvedValue(createdStore);
      const token = login(diner);

      const response = await request(app).post('/1/store').set(bearer(token)).send(body);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(createdStore);
      expect(DB.createStore).toHaveBeenCalledWith(franchise.id, body);
    });

    test('calls createStore with franchise.id from the loaded record', async () => {
      const franchise = franchiseRecord({ id: 99 });
      const storeBody = { name: 'SLC' };
      DB.getFranchise.mockResolvedValue(franchise);
      DB.createStore.mockResolvedValue({ id: 5, franchiseId: 99, name: 'SLC' });
      const token = login(admin);

      const response = await request(app).post('/12/store').set(bearer(token)).send(storeBody);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ id: 5, franchiseId: 99, name: 'SLC' });
      expect(DB.getFranchise).toHaveBeenCalledWith({ id: 12 });
      expect(DB.createStore).toHaveBeenCalledWith(99, storeBody);
    });

    test('coerces the franchiseId param before loading the franchise', async () => {
      const franchise = franchiseRecord({ id: 12 });
      DB.getFranchise.mockResolvedValue(franchise);
      DB.createStore.mockResolvedValue(createdStore);
      const token = login(admin);

      const response = await request(app).post('/012/store').set(bearer(token)).send({ name: 'SLC' });

      expect(response.status).toBe(200);
      expect(DB.getFranchise).toHaveBeenCalledWith({ id: 12 });
      expect(DB.createStore).toHaveBeenCalledWith(12, { name: 'SLC' });
    });

    test('passes NaN to getFranchise when franchiseId is not numeric', async () => {
      const franchise = franchiseRecord({ id: 99 });
      DB.getFranchise.mockResolvedValue(franchise);
      DB.createStore.mockResolvedValue(createdStore);
      const token = login(admin);

      const response = await request(app).post('/nope/store').set(bearer(token)).send({ name: 'SLC' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(createdStore);
      expect(DB.getFranchise.mock.calls[0][0].id).toBeNaN();
      expect(DB.createStore).toHaveBeenCalledWith(99, { name: 'SLC' });
    });

    test('returns the rejected getFranchise status and message', async () => {
      DB.getFranchise.mockRejectedValue(rejection('franchise lookup failed', 502));
      const token = login(admin);

      const response = await request(app).post('/1/store').set(bearer(token)).send(body);

      expect(response.status).toBe(502);
      expect(response.body).toEqual({ message: 'franchise lookup failed' });
      expect(DB.createStore).not.toHaveBeenCalled();
    });

    test('returns the rejected createStore status and message', async () => {
      DB.getFranchise.mockResolvedValue(franchiseRecord());
      DB.createStore.mockRejectedValue(rejection('store insert failed', 409));
      const token = login(franchisee);

      const response = await request(app).post('/1/store').set(bearer(token)).send(body);

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ message: 'store insert failed' });
    });

    test('returns 500 when createStore rejects without a status code', async () => {
      DB.getFranchise.mockResolvedValue(franchiseRecord());
      DB.createStore.mockRejectedValue(rejection('store insert failed'));
      const token = login(admin);

      const response = await request(app).post('/1/store').set(bearer(token)).send(body);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ message: 'store insert failed' });
    });
  });

  describe('DELETE /:franchiseId/store/:storeId', () => {
    test('returns 401 when no token is sent', async () => {
      const response = await request(app).delete('/1/store/1');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ message: 'unauthorized' });
      expect(DB.getFranchise).not.toHaveBeenCalled();
      expect(DB.deleteStore).not.toHaveBeenCalled();
      expect(DB.isLoggedIn).not.toHaveBeenCalled();
    });

    test('returns 401 when the token is not a logged-in session', async () => {
      DB.isLoggedIn.mockResolvedValue(false);
      const token = signUser(franchisee);

      const response = await request(app).delete('/1/store/1').set(bearer(token));

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ message: 'unauthorized' });
      expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
      expect(DB.getFranchise).not.toHaveBeenCalled();
      expect(DB.deleteStore).not.toHaveBeenCalled();
    });

    test('returns 401 when a logged-in token fails verification', async () => {
      DB.isLoggedIn.mockResolvedValue(true);
      const token = jwt.sign(admin, 'wrong-secret');

      const response = await request(app).delete('/1/store/1').set(bearer(token));

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ message: 'unauthorized' });
      expect(DB.deleteStore).not.toHaveBeenCalled();
    });

    test('returns 403 when the franchise does not exist', async () => {
      DB.getFranchise.mockResolvedValue(null);
      const token = login(admin);

      const response = await request(app).delete('/1/store/4').set(bearer(token));

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ message: 'unable to delete a store' });
      expect(DB.getFranchise).toHaveBeenCalledWith({ id: 1 });
      expect(DB.deleteStore).not.toHaveBeenCalled();
    });

    test('returns 403 when the caller is not an admin and is not in franchise.admins', async () => {
      DB.getFranchise.mockResolvedValue(franchiseRecord());
      const token = login(otherFranchisee);

      const response = await request(app).delete('/1/store/4').set(bearer(token));

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ message: 'unable to delete a store' });
      expect(DB.getFranchise).toHaveBeenCalledWith({ id: 1 });
      expect(DB.deleteStore).not.toHaveBeenCalled();
    });

    test('throws when a non-admin deletes a store and franchise.admins is missing', async () => {
      DB.getFranchise.mockResolvedValue(franchiseRecord({ admins: undefined }));
      const token = login(diner);

      const response = await request(app).delete('/1/store/4').set(bearer(token));

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ message: "Cannot read properties of undefined (reading 'some')" });
      expect(DB.deleteStore).not.toHaveBeenCalled();
    });

    test('throws when a non-admin deletes a store and franchise.admins is not an array', async () => {
      DB.getFranchise.mockResolvedValue(franchiseRecord({ admins: { id: franchisee.id } }));
      const token = login(franchisee);

      const response = await request(app).delete('/1/store/4').set(bearer(token));

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ message: 'franchise.admins.some is not a function' });
      expect(DB.deleteStore).not.toHaveBeenCalled();
    });

    test('lets an admin delete a store without being listed in franchise.admins', async () => {
      DB.getFranchise.mockResolvedValue(franchiseRecord({ id: 99 }));
      DB.deleteStore.mockResolvedValue(undefined);
      const token = login(admin);

      const response = await request(app).delete('/12/store/34').set(bearer(token));

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: 'store deleted' });
      expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
      expect(DB.getFranchise).toHaveBeenCalledWith({ id: 12 });
      expect(DB.deleteStore).toHaveBeenCalledTimes(1);
      expect(DB.deleteStore).toHaveBeenCalledWith(12, 34);
      expect(DB.deleteFranchise).not.toHaveBeenCalled();
    });

    test('lets a non-admin delete a store when their id is in franchise.admins', async () => {
      DB.getFranchise.mockResolvedValue(
        franchiseRecord({
          admins: [{ id: diner.id, name: diner.name, email: diner.email }],
        })
      );
      DB.deleteStore.mockResolvedValue(undefined);
      const token = login(diner);

      const response = await request(app).delete('/1/store/4').set(bearer(token));

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: 'store deleted' });
      expect(DB.deleteStore).toHaveBeenCalledWith(1, 4);
    });

    test('coerces franchiseId and storeId with Number', async () => {
      DB.getFranchise.mockResolvedValue(franchiseRecord({ id: 12 }));
      DB.deleteStore.mockResolvedValue(undefined);
      const token = login(admin);

      const response = await request(app).delete('/012/store/03').set(bearer(token));

      expect(response.status).toBe(200);
      expect(DB.getFranchise).toHaveBeenCalledWith({ id: 12 });
      expect(DB.deleteStore).toHaveBeenCalledWith(12, 3);
    });

    test('passes NaN franchiseId and storeId to deleteStore when they are not numeric', async () => {
      DB.getFranchise.mockResolvedValue(franchiseRecord({ id: 99 }));
      DB.deleteStore.mockResolvedValue(undefined);
      const token = login(admin);

      const response = await request(app).delete('/nope/store/nope').set(bearer(token));

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: 'store deleted' });
      expect(DB.getFranchise.mock.calls[0][0].id).toBeNaN();
      const [franchiseId, storeId] = DB.deleteStore.mock.calls[0];
      expect(franchiseId).toBeNaN();
      expect(storeId).toBeNaN();
    });

    test('returns the rejected getFranchise status and message', async () => {
      DB.getFranchise.mockRejectedValue(rejection('franchise lookup failed', 502));
      const token = login(franchisee);

      const response = await request(app).delete('/1/store/4').set(bearer(token));

      expect(response.status).toBe(502);
      expect(response.body).toEqual({ message: 'franchise lookup failed' });
      expect(DB.deleteStore).not.toHaveBeenCalled();
    });

    test('returns the rejected deleteStore status and message', async () => {
      DB.getFranchise.mockResolvedValue(franchiseRecord());
      DB.deleteStore.mockRejectedValue(rejection('store delete failed', 409));
      const token = login(admin);

      const response = await request(app).delete('/1/store/4').set(bearer(token));

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ message: 'store delete failed' });
    });

    test('returns 500 when deleteStore rejects without a status code', async () => {
      DB.getFranchise.mockResolvedValue(franchiseRecord());
      DB.deleteStore.mockRejectedValue(rejection('store delete failed'));
      const token = login(franchisee);

      const response = await request(app).delete('/1/store/4').set(bearer(token));

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ message: 'store delete failed' });
    });
  });
});
