const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config.js');

jest.mock('../src/database/database.js', () => ({
  Role: { Diner: 'diner', Franchisee: 'franchisee', Admin: 'admin' },
  DB: {
    getMenu: jest.fn(),
    addMenuItem: jest.fn(),
    getOrders: jest.fn(),
    addDinerOrder: jest.fn(),
    isLoggedIn: jest.fn(),
    loginUser: jest.fn(),
    logoutUser: jest.fn(),
  },
}));

const { DB, Role } = require('../src/database/database.js');
const { setAuthUser } = require('../src/routes/authRouter.js');
const orderRouter = require('../src/routes/orderRouter.js');

const originalFetch = global.fetch;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(setAuthUser);
  app.use(orderRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode ?? 500).json({ message: err.message });
  });
  return app;
}

function signToken({ id, name, email, role }) {
  return jwt.sign({ id, name, email, roles: [{ role }] }, config.jwtSecret);
}

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

const app = createApp();

const diner = { id: 4, name: 'pizza diner', email: 'd@jwt.com', role: Role.Diner };
const franchisee = { id: 8, name: 'pizza franchisee', email: 'f@jwt.com', role: Role.Franchisee };
const admin = { id: 1, name: '常用名字', email: 'a@jwt.com', role: Role.Admin };

beforeEach(() => {
  global.fetch = jest.fn().mockRejectedValue(new Error('unexpected fetch'));
});

afterEach(() => {
  global.fetch = originalFetch;
});

function validToken(user) {
  const token = signToken(user);
  expect(jwt.verify(token, config.jwtSecret)).toMatchObject({
    id: user.id,
    email: user.email,
    roles: [{ role: user.role }],
  });
  return token;
}

function unverifiableToken(user) {
  const token = jwt.sign({ id: user.id, name: user.name, email: user.email, roles: [{ role: user.role }] }, 'not-the-server-secret');
  expect(() => jwt.verify(token, config.jwtSecret)).toThrow();
  return token;
}

async function expectSettled(mockFn, settlement) {
  expect(mockFn).toHaveBeenCalledTimes(1);
  const result = mockFn.mock.results[0];
  expect(result.type).toBe('return');
  if (settlement.resolved) {
    await expect(result.value).resolves.toEqual(settlement.resolved);
  } else {
    await expect(result.value).rejects.toBe(settlement.rejected);
  }
}

function expectAuthenticatedUser(actual, expected) {
  expect(actual).toEqual(
    expect.objectContaining({
      id: expected.id,
      name: expected.name,
      email: expected.email,
      roles: [{ role: expected.role }],
      isRole: expect.any(Function),
    })
  );
  expect(actual.isRole(expected.role)).toBe(true);
  const otherRole = expected.role === Role.Admin ? Role.Diner : Role.Admin;
  expect(actual.isRole(otherRole)).toBe(false);
}

describe('GET /menu', () => {
  const menu = [{ id: 1, title: 'Veggie', image: 'pizza1.png', price: 0.0038, description: 'A garden of delight' }];

  test('returns the menu without authentication', async () => {
    DB.getMenu.mockResolvedValue(menu);

    const res = await request(app).get('/menu');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(menu);
    expect(DB.getMenu).toHaveBeenCalledTimes(1);
    expect(DB.getMenu).toHaveBeenCalledWith();
    expect(DB.isLoggedIn).not.toHaveBeenCalled();
  });

  test('sends the error handler status and message when getMenu rejects', async () => {
    const err = new Error('menu unavailable');
    err.statusCode = 503;
    DB.getMenu.mockRejectedValue(err);

    const res = await request(app).get('/menu');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ message: 'menu unavailable' });
  });

  test('uses 500 when getMenu rejects without a status code', async () => {
    DB.getMenu.mockRejectedValue(new Error('database exploded'));

    const res = await request(app).get('/menu');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: 'database exploded' });
  });
});

describe('PUT /menu', () => {
  const item = {
    title: 'Student',
    description: 'No topping, no sauce, just carbs',
    image: 'pizza9.png',
    price: 0.0001,
  };

  test('returns 401 without auth', async () => {
    const res = await request(app).put('/menu').send(item);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'unauthorized' });
    expect(DB.addMenuItem).not.toHaveBeenCalled();
    expect(DB.getMenu).not.toHaveBeenCalled();
  });

  test('returns 403 for a diner and does not add the item', async () => {
    const token = validToken(diner);
    DB.isLoggedIn.mockResolvedValue(true);
    const decoded = jwt.verify(token, config.jwtSecret);

    const res = await request(app).put('/menu').set(authHeader(token)).send(item);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ message: 'unable to add menu item' });
    expect(decoded).not.toHaveProperty('isRole');
    expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
    expect(DB.addMenuItem).not.toHaveBeenCalled();
    expect(DB.getMenu).not.toHaveBeenCalled();
  });

  test('returns the same 403 for a logged-in franchisee', async () => {
    const token = validToken(franchisee);
    DB.isLoggedIn.mockResolvedValue(true);

    const res = await request(app).put('/menu').set(authHeader(token)).send(item);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ message: 'unable to add menu item' });
    expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
    expect(DB.addMenuItem).not.toHaveBeenCalled();
    expect(DB.getMenu).not.toHaveBeenCalled();
  });

  test('returns 401 when a valid token is not a logged-in session', async () => {
    const token = validToken(diner);
    DB.isLoggedIn.mockResolvedValue(false);

    const res = await request(app).put('/menu').set(authHeader(token)).send(item);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'unauthorized' });
    expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
    expect(DB.addMenuItem).not.toHaveBeenCalled();
    expect(DB.getMenu).not.toHaveBeenCalled();
  });

  test('returns 401 when a logged-in token fails verification', async () => {
    const token = unverifiableToken(admin);
    DB.isLoggedIn.mockResolvedValue(true);

    const res = await request(app).put('/menu').set(authHeader(token)).send(item);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'unauthorized' });
    expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
    expect(DB.addMenuItem).not.toHaveBeenCalled();
    expect(DB.getMenu).not.toHaveBeenCalled();
  });

  test('adds the body as admin and returns the subsequent menu', async () => {
    const token = signToken(admin);
    const menuAfter = [
      { id: 1, title: 'Veggie', image: 'pizza1.png', price: 0.0038, description: 'A garden of delight' },
      { id: 2, ...item },
    ];
    DB.isLoggedIn.mockResolvedValue(true);
    DB.addMenuItem.mockResolvedValue({ ...item, id: 2 });
    DB.getMenu.mockResolvedValue(menuAfter);

    const res = await request(app).put('/menu').set(authHeader(token)).send(item);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(menuAfter);
    expect(DB.addMenuItem).toHaveBeenCalledTimes(1);
    expect(DB.addMenuItem).toHaveBeenCalledWith(item);
    expect(DB.getMenu).toHaveBeenCalledTimes(1);
    expect(DB.getMenu).toHaveBeenCalledWith();
    expect(DB.addMenuItem.mock.invocationCallOrder[0]).toBeLessThan(DB.getMenu.mock.invocationCallOrder[0]);
    expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
  });

  test('propagates addMenuItem rejection status and message without reading the menu', async () => {
    const token = validToken(admin);
    const err = new Error('menu insert failed');
    err.statusCode = 409;
    DB.isLoggedIn.mockResolvedValue(true);
    DB.addMenuItem.mockRejectedValue(err);

    const res = await request(app).put('/menu').set(authHeader(token)).send(item);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ message: 'menu insert failed' });
    await expectSettled(DB.addMenuItem, { rejected: err });
    expect(DB.addMenuItem).toHaveBeenCalledWith(item);
    expect(DB.getMenu).not.toHaveBeenCalled();
  });

  test('propagates getMenu rejection after the item is already added', async () => {
    const token = validToken(admin);
    const savedItem = { ...item, id: 2 };
    const err = new Error('menu read failed');
    err.statusCode = 503;
    DB.isLoggedIn.mockResolvedValue(true);
    DB.addMenuItem.mockResolvedValue(savedItem);
    DB.getMenu.mockRejectedValue(err);

    const res = await request(app).put('/menu').set(authHeader(token)).send(item);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ message: 'menu read failed' });
    await expectSettled(DB.addMenuItem, { resolved: savedItem });
    expect(DB.addMenuItem).toHaveBeenCalledWith(item);
    expect(DB.getMenu).toHaveBeenCalledTimes(1);
    expect(DB.addMenuItem.mock.invocationCallOrder[0]).toBeLessThan(DB.getMenu.mock.invocationCallOrder[0]);
  });
});

describe('GET /', () => {
  const orders = {
    dinerId: diner.id,
    orders: [
      {
        id: 1,
        franchiseId: 1,
        storeId: 1,
        date: '2024-06-05T05:14:40.000Z',
        items: [{ id: 1, menuId: 1, description: 'Veggie', price: 0.05 }],
      },
    ],
    page: 1,
  };

  test('returns 401 without auth', async () => {
    const res = await request(app).get('/');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'unauthorized' });
    expect(DB.getOrders).not.toHaveBeenCalled();
  });

  test('loads orders for the authenticated user when page is present', async () => {
    const token = signToken(diner);
    DB.isLoggedIn.mockResolvedValue(true);
    DB.getOrders.mockResolvedValue(orders);

    const res = await request(app).get('/').query({ page: '2' }).set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(orders);
    expect(DB.getOrders).toHaveBeenCalledTimes(1);
    const [user, page] = DB.getOrders.mock.calls[0];
    expectAuthenticatedUser(user, diner);
    expect(page).toBe('2');
    expect(jwt.verify(token, config.jwtSecret)).not.toHaveProperty('isRole');
  });

  test('passes undefined when page is absent', async () => {
    const token = signToken(diner);
    const result = { dinerId: diner.id, orders: orders.orders };
    DB.isLoggedIn.mockResolvedValue(true);
    DB.getOrders.mockResolvedValue(result);

    const res = await request(app).get('/').set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    expect(DB.getOrders).toHaveBeenCalledTimes(1);
    const [user, page] = DB.getOrders.mock.calls[0];
    expectAuthenticatedUser(user, diner);
    expect(page).toBeUndefined();
  });

  test('returns 401 when a valid token is not a logged-in session', async () => {
    const token = validToken(diner);
    DB.isLoggedIn.mockResolvedValue(false);

    const res = await request(app).get('/').query({ page: '2' }).set(authHeader(token));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'unauthorized' });
    expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
    expect(DB.getOrders).not.toHaveBeenCalled();
  });

  test('returns 401 when a logged-in token fails verification', async () => {
    const token = unverifiableToken(diner);
    DB.isLoggedIn.mockResolvedValue(true);

    const res = await request(app).get('/').set(authHeader(token));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'unauthorized' });
    expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
    expect(DB.getOrders).not.toHaveBeenCalled();
  });

  test('propagates getOrders rejection status and message', async () => {
    const token = validToken(diner);
    const err = new Error('orders unavailable');
    err.statusCode = 503;
    DB.isLoggedIn.mockResolvedValue(true);
    DB.getOrders.mockRejectedValue(err);

    const res = await request(app).get('/').query({ page: '3' }).set(authHeader(token));

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ message: 'orders unavailable' });
    await expectSettled(DB.getOrders, { rejected: err });
    const [user, page] = DB.getOrders.mock.calls[0];
    expectAuthenticatedUser(user, diner);
    expect(page).toBe('3');
  });
});

describe('POST /', () => {
  const orderReq = {
    franchiseId: 1,
    storeId: 1,
    items: [{ menuId: 1, description: 'Veggie', price: 0.05 }],
  };
  const savedOrder = {
    id: 42,
    franchiseId: 1,
    storeId: 1,
    date: '2024-06-05T05:14:40.000Z',
    items: [{ id: 9, menuId: 1, description: 'Veggie', price: 0.05 }],
  };

  function mockFactory({ ok, status = ok ? 200 : 500, body }) {
    const json = jest.fn().mockResolvedValue(body);
    global.fetch = jest.fn().mockResolvedValue({ ok, status, json });
    return json;
  }

  test('returns 401 without auth', async () => {
    const res = await request(app).post('/').send(orderReq);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'unauthorized' });
    expect(DB.isLoggedIn).not.toHaveBeenCalled();
    expect(DB.addDinerOrder).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns 401 when a valid token is not a logged-in session', async () => {
    const token = validToken(diner);
    DB.isLoggedIn.mockResolvedValue(false);

    const res = await request(app).post('/').set(authHeader(token)).send(orderReq);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'unauthorized' });
    expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
    expect(DB.addDinerOrder).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns 401 when a logged-in token fails verification', async () => {
    const token = unverifiableToken(diner);
    DB.isLoggedIn.mockResolvedValue(true);

    const res = await request(app).post('/').set(authHeader(token)).send(orderReq);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'unauthorized' });
    expect(DB.isLoggedIn).toHaveBeenCalledWith(token);
    expect(DB.addDinerOrder).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('saves the order and returns the factory report when fulfillment succeeds', async () => {
    const token = signToken(diner);
    const reportUrl = 'https://pizza-factory.cs329.click/report/42';
    const factoryJwt = 'factory-jwt-42';
    DB.isLoggedIn.mockResolvedValue(true);
    DB.addDinerOrder.mockResolvedValue(savedOrder);
    const json = mockFactory({ ok: true, body: { reportUrl, jwt: factoryJwt, extra: 'ignored' } });

    const res = await request(app).post('/').set(authHeader(token)).send(orderReq);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      order: savedOrder,
      followLinkToEndChaos: reportUrl,
      jwt: factoryJwt,
    });
    await expectSettled(DB.addDinerOrder, { resolved: savedOrder });
    const [user, body] = DB.addDinerOrder.mock.calls[0];
    expectAuthenticatedUser(user, diner);
    expect(body).toEqual(orderReq);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe(`${config.factory.url}/api/order`);
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({
      'Content-Type': 'application/json',
      authorization: `Bearer ${config.factory.apiKey}`,
    });
    expect(JSON.parse(options.body)).toEqual({
      diner: { id: diner.id, name: diner.name, email: diner.email },
      order: savedOrder,
    });
    expect(json).toHaveBeenCalledWith();
    expect(DB.addDinerOrder.mock.invocationCallOrder[0]).toBeLessThan(global.fetch.mock.invocationCallOrder[0]);
  });

  test('forces HTTP 500 with followLinkToEndChaos when the factory is not ok and leaves the saved order in place', async () => {
    const token = validToken(diner);
    const reportUrl = 'https://pizza-factory.cs329.click/chaos/42';
    const factoryStatus = 422;
    DB.isLoggedIn.mockResolvedValue(true);
    DB.addDinerOrder.mockResolvedValue(savedOrder);
    const json = mockFactory({ ok: false, status: factoryStatus, body: { reportUrl, jwt: 'should-not-leak', order: orderReq } });

    const res = await request(app).post('/').set(authHeader(token)).send(orderReq);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      message: 'Failed to fulfill order at factory',
      followLinkToEndChaos: reportUrl,
    });
    await expectSettled(DB.addDinerOrder, { resolved: savedOrder });
    const [user, body] = DB.addDinerOrder.mock.calls[0];
    expectAuthenticatedUser(user, diner);
    expect(body).toEqual(orderReq);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(DB.addDinerOrder.mock.invocationCallOrder[0]).toBeLessThan(global.fetch.mock.invocationCallOrder[0]);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe(`${config.factory.url}/api/order`);
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({
      'Content-Type': 'application/json',
      authorization: `Bearer ${config.factory.apiKey}`,
    });
    expect(JSON.parse(options.body)).toEqual({
      diner: { id: diner.id, name: diner.name, email: diner.email },
      order: savedOrder,
    });
    expect(json).toHaveBeenCalledWith();
  });

  test('propagates addDinerOrder failures and does not call the factory', async () => {
    const token = validToken(diner);
    const err = new Error('order insert failed');
    err.statusCode = 409;
    DB.isLoggedIn.mockResolvedValue(true);
    DB.addDinerOrder.mockRejectedValue(err);

    const res = await request(app).post('/').set(authHeader(token)).send(orderReq);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ message: 'order insert failed' });
    await expectSettled(DB.addDinerOrder, { rejected: err });
    const [user, body] = DB.addDinerOrder.mock.calls[0];
    expectAuthenticatedUser(user, diner);
    expect(body).toEqual(orderReq);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('propagates fetch failures after the order is saved and does not roll it back', async () => {
    const token = validToken(diner);
    const err = new Error('factory unreachable');
    err.statusCode = 502;
    DB.isLoggedIn.mockResolvedValue(true);
    DB.addDinerOrder.mockResolvedValue(savedOrder);
    global.fetch = jest.fn().mockRejectedValue(err);

    const res = await request(app).post('/').set(authHeader(token)).send(orderReq);

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ message: 'factory unreachable' });
    await expectSettled(DB.addDinerOrder, { resolved: savedOrder });
    const [user, body] = DB.addDinerOrder.mock.calls[0];
    expectAuthenticatedUser(user, diner);
    expect(body).toEqual(orderReq);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(DB.addDinerOrder.mock.invocationCallOrder[0]).toBeLessThan(global.fetch.mock.invocationCallOrder[0]);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe(`${config.factory.url}/api/order`);
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({
      'Content-Type': 'application/json',
      authorization: `Bearer ${config.factory.apiKey}`,
    });
    expect(JSON.parse(options.body)).toEqual({
      diner: { id: diner.id, name: diner.name, email: diner.email },
      order: savedOrder,
    });
  });

  test('propagates response.json rejection after the order is saved', async () => {
    const token = validToken(diner);
    const err = new Error('factory body unreadable');
    err.statusCode = 502;
    DB.isLoggedIn.mockResolvedValue(true);
    DB.addDinerOrder.mockResolvedValue(savedOrder);
    const json = jest.fn().mockRejectedValue(err);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 422, json });

    const res = await request(app).post('/').set(authHeader(token)).send(orderReq);

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ message: 'factory body unreadable' });
    await expectSettled(DB.addDinerOrder, { resolved: savedOrder });
    const [user, body] = DB.addDinerOrder.mock.calls[0];
    expectAuthenticatedUser(user, diner);
    expect(body).toEqual(orderReq);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(DB.addDinerOrder.mock.invocationCallOrder[0]).toBeLessThan(global.fetch.mock.invocationCallOrder[0]);
    expect(global.fetch.mock.invocationCallOrder[0]).toBeLessThan(json.mock.invocationCallOrder[0]);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe(`${config.factory.url}/api/order`);
    expect(JSON.parse(options.body)).toEqual({
      diner: { id: diner.id, name: diner.name, email: diner.email },
      order: savedOrder,
    });
    expect(json).toHaveBeenCalledWith();
  });
});
