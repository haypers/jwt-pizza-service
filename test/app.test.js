const request = require('supertest');

jest.mock('../src/database/database.js', () => ({
  Role: { Diner: 'diner', Franchisee: 'franchisee', Admin: 'admin' },
  DB: {
    addUser: jest.fn(),
    getUser: jest.fn(),
    updateUser: jest.fn(),
    loginUser: jest.fn(),
    logoutUser: jest.fn(),
    isLoggedIn: jest.fn(),
    getMenu: jest.fn(),
    addMenuItem: jest.fn(),
    getOrders: jest.fn(),
    addDinerOrder: jest.fn(),
    getFranchises: jest.fn(),
    getUserFranchises: jest.fn(),
    getFranchise: jest.fn(),
    createFranchise: jest.fn(),
    deleteFranchise: jest.fn(),
    createStore: jest.fn(),
    deleteStore: jest.fn(),
  },
}));

const app = require('../src/service.js');
const version = require('../src/version.json');
const config = require('../src/config.js');
const { DB } = require('../src/database/database.js');
const { authRouter } = require('../src/routes/authRouter.js');
const userRouter = require('../src/routes/userRouter.js');
const orderRouter = require('../src/routes/orderRouter.js');
const franchiseRouter = require('../src/routes/franchiseRouter.js');
const { asyncHandler, StatusCodeError } = require('../src/endpointHelper.js');
const { Role } = require('../src/model/model.js');
const { tableCreateStatements } = require('../src/database/dbModel.js');

const originalArgv = process.argv;

function createRes() {
  return {
    statusCode: null,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
  };
}

function blockProcessExit() {
  return jest.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit:${code}`);
  });
}

function mountTrailingMiddleware(middleware) {
  app.use(middleware);
  return function removeTrailingMiddleware() {
    const stack = app._router && app._router.stack;
    if (!stack) return;
    const index = stack.findIndex((layer) => layer.handle === middleware);
    if (index !== -1) stack.splice(index, 1);
  };
}

afterEach(() => {
  process.argv = originalArgv;
  jest.dontMock('../src/service.js');
  jest.restoreAllMocks();
  Object.values(DB).forEach((fn) => {
    if (typeof fn?.mockReset === 'function') fn.mockReset();
  });
});

describe('HTTP shell', () => {
  test('GET / returns the welcome message and version from version.json', async () => {
    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({
      message: 'welcome to JWT Pizza',
      version: version.version,
    });
  });

  test('GET /api/docs returns version, every router doc in order, and factory/db config', async () => {
    const res = await request(app).get('/api/docs');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({
      version: version.version,
      endpoints: [...authRouter.docs, ...userRouter.docs, ...orderRouter.docs, ...franchiseRouter.docs],
      config: { factory: config.factory.url, db: config.db.connection.host },
    });
  });

  test('unknown paths return 404 with the unknown endpoint message', async () => {
    const cases = [
      () => request(app).get('/no/such/path'),
      () => request(app).post('/api/does-not-exist'),
      () => request(app).put('/'),
    ];

    for (const send of cases) {
      const res = await send();
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual({ message: 'unknown endpoint' });
    }
  });

  test('CORS uses the Origin header when present', async () => {
    const res = await request(app).get('/').set('Origin', 'https://pizza.example');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://pizza.example');
    expect(res.headers['access-control-allow-methods']).toBe('GET, POST, PUT, DELETE');
    expect(res.headers['access-control-allow-headers']).toBe('Content-Type, Authorization');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  test('CORS falls back to * when Origin is absent', async () => {
    const res = await request(app).get('/api/missing');

    expect(res.status).toBe(404);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toBe('GET, POST, PUT, DELETE');
    expect(res.headers['access-control-allow-headers']).toBe('Content-Type, Authorization');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  test('error handler writes status, message, and stack, then calls next', async () => {
    const err = new StatusCodeError('menu unavailable', 503);
    DB.getMenu.mockRejectedValue(err);
    const afterError = [];
    const removeProbe = mountTrailingMiddleware((req, res, next) => {
      afterError.push({ headersSent: res.headersSent, statusCode: res.statusCode });
      next();
    });

    try {
      const res = await request(app).get('/api/order/menu');

      expect(res.status).toBe(503);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual({ message: 'menu unavailable', stack: err.stack });
      expect(afterError).toEqual([{ headersSent: true, statusCode: 503 }]);
    } finally {
      removeProbe();
    }
  });

  test('error handler uses 500 when the rejection has no statusCode', async () => {
    const err = new Error('database offline');
    DB.getMenu.mockRejectedValue(err);

    const res = await request(app).get('/api/order/menu');

    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ message: 'database offline', stack: err.stack });
  });

  test('error handler ignores err.status when statusCode is absent', async () => {
    const err = new Error('teapot');
    err.status = 418;
    DB.getMenu.mockRejectedValue(err);

    const res = await request(app).get('/api/order/menu');

    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ message: 'teapot', stack: err.stack });
  });

  test('invalid JSON reaches the error handler with the parser statusCode', async () => {
    const res = await request(app).post('/api/auth').set('Content-Type', 'application/json').send('{');

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({
      message: "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
      stack: expect.stringContaining("SyntaxError: Expected property name or '}' in JSON at position 1 (line 1 column 2)"),
    });
  });
});

describe('endpointHelper', () => {
  test('StatusCodeError sets message and statusCode', () => {
    const err = new StatusCodeError('unable to add menu item', 403);

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(StatusCodeError);
    expect(err.message).toBe('unable to add menu item');
    expect(err.statusCode).toBe(403);

    const omitted = new StatusCodeError('missing code');
    expect(omitted.message).toBe('missing code');
    expect(omitted.statusCode).toBeUndefined();
  });

  test('asyncHandler writes the response when the handler resolves', async () => {
    const handler = asyncHandler(async (req, res) => {
      res.status(201).json({ echo: req.body.item });
    });
    const res = createRes();
    const next = jest.fn();

    await expect(handler({ body: { item: 'veggie' } }, res, next)).resolves.toBeUndefined();

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ echo: 'veggie' });
    expect(next).not.toHaveBeenCalled();
  });

  test('asyncHandler forwards a rejected handler to next', async () => {
    const err = new StatusCodeError('nope', 409);
    const handler = asyncHandler(async () => {
      throw err;
    });
    const res = createRes();
    const next = jest.fn();

    await expect(handler({}, res, next)).resolves.toBeUndefined();

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.statusCode).toBeNull();
    expect(res.body).toBeUndefined();
  });

  test('asyncHandler forwards a returned rejection to next', async () => {
    const err = new Error('returned rejection');
    const handler = asyncHandler(() => Promise.reject(err));
    const res = createRes();
    const next = jest.fn();

    await expect(handler({}, res, next)).resolves.toBeUndefined();

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.statusCode).toBeNull();
    expect(res.body).toBeUndefined();
  });

  test('a synchronous throw escapes asyncHandler and does not call next', () => {
    const err = new Error('sync failure');
    const req = { method: 'GET' };
    const res = createRes();
    const next = jest.fn();
    const handler = asyncHandler((receivedReq, receivedRes, receivedNext) => {
      expect(receivedReq).toBe(req);
      expect(receivedRes).toBe(res);
      expect(receivedNext).toBe(next);
      throw err;
    });
    let returned = 'did-not-return';

    expect(() => {
      returned = handler(req, res, next);
    }).toThrow(err);

    expect(returned).toBe('did-not-return');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBeNull();
    expect(res.body).toBeUndefined();
  });
});

describe('Role', () => {
  test('defines diner, franchisee, and admin', () => {
    expect(Role).toEqual({
      Diner: 'diner',
      Franchisee: 'franchisee',
      Admin: 'admin',
    });
  });
});

describe('tableCreateStatements', () => {
  test('creates auth, user, menu, franchise, store, userRole, dinerOrder, and orderItem', () => {
    expect(tableCreateStatements).toEqual([
      `CREATE TABLE IF NOT EXISTS auth (
    token VARCHAR(512) PRIMARY KEY,
    userId INT NOT NULL
  )`,
      `CREATE TABLE IF NOT EXISTS user (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    password VARCHAR(255) NOT NULL
  )`,
      `CREATE TABLE IF NOT EXISTS menu (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    image VARCHAR(1024) NOT NULL,
    price DECIMAL(10, 8) NOT NULL,
    description TEXT NOT NULL
  )`,
      `CREATE TABLE IF NOT EXISTS franchise (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE
  )`,
      `CREATE TABLE IF NOT EXISTS store (
    id INT AUTO_INCREMENT PRIMARY KEY,
    franchiseId INT NOT NULL,
    name VARCHAR(255) NOT NULL,
    FOREIGN KEY (franchiseId) REFERENCES franchise(id)
  )`,
      `CREATE TABLE IF NOT EXISTS userRole (
    id INT AUTO_INCREMENT PRIMARY KEY,
    userId INT NOT NULL,
    role VARCHAR(255) NOT NULL,
    objectId INT NOT NULL,
    FOREIGN KEY (userId) REFERENCES user(id),
    INDEX (objectId)
  )`,
      `CREATE TABLE IF NOT EXISTS dinerOrder (
    id INT AUTO_INCREMENT PRIMARY KEY,
    dinerId INT NOT NULL,
    franchiseId INT NOT NULL,
    storeId INT NOT NULL,
    date DATETIME NOT NULL,
    INDEX (dinerId),
    INDEX (franchiseId),
    INDEX (storeId)
  )`,
      `CREATE TABLE IF NOT EXISTS orderItem (
    id INT AUTO_INCREMENT PRIMARY KEY,
    orderId INT NOT NULL,
    menuId INT NOT NULL,
    description VARCHAR(255) NOT NULL,
    price DECIMAL(10, 8) NOT NULL,
    FOREIGN KEY (orderId) REFERENCES dinerOrder(id),
    INDEX (menuId)
  )`,
    ]);
  });
});

describe('index.js', () => {
  function loadIndex() {
    const listen = jest.fn();
    jest.doMock('../src/service.js', () => ({ listen }));
    jest.isolateModules(() => {
      require('../src/index.js');
    });
    return listen;
  }

  test('listens on port 3000 when no port argument is given', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    process.argv = ['node', 'index.js'];

    const listen = loadIndex();

    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith(3000, expect.any(Function));
    expect(typeof listen.mock.calls[0][0]).toBe('number');
    expect(log).not.toHaveBeenCalled();

    listen.mock.calls[0][1]();

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('Server started on port 3000');
  });

  test('listens on the port from process.argv', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    process.argv = ['node', 'index.js', '4050'];

    const listen = loadIndex();

    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith('4050', expect.any(Function));
    expect(typeof listen.mock.calls[0][0]).toBe('string');

    listen.mock.calls[0][1]();

    expect(log).toHaveBeenCalledWith('Server started on port 4050');
  });
});

describe('init.js', () => {
  test.each([
    [['node', 'init.js']],
    [['node', 'init.js', 'Ada']],
    [['node', 'init.js', 'Ada', 'ada@jwt.com']],
  ])('prints usage and exits when argv is %j', (argv) => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const exit = blockProcessExit();
    process.argv = argv;
    let addUser;

    expect(() => {
      jest.isolateModules(() => {
        addUser = require('../src/database/database.js').DB.addUser;
        require('../src/init.js');
      });
    }).toThrow('process.exit:1');

    expect(log).toHaveBeenCalledWith('Usage: node init.js <name> <email> <password>');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(addUser).not.toHaveBeenCalled();
  });

  test('creates an admin from name, email, and password and logs the result', async () => {
    const created = { id: 7, name: 'Ada', email: 'ada@jwt.com', roles: [{ role: Role.Admin }] };
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const exit = blockProcessExit();
    process.argv = ['node', 'init.js', 'Ada', 'ada@jwt.com', 'analytical'];
    let addUser;

    jest.isolateModules(() => {
      addUser = require('../src/database/database.js').DB.addUser;
      addUser.mockResolvedValue(created);
      require('../src/init.js');
    });

    expect(exit).not.toHaveBeenCalled();
    expect(addUser).toHaveBeenCalledTimes(1);
    expect(addUser).toHaveBeenCalledWith({
      name: 'Ada',
      email: 'ada@jwt.com',
      password: 'analytical',
      roles: [{ role: Role.Admin }],
    });

    await addUser.mock.results[0].value;
    await Promise.resolve();

    expect(log).toHaveBeenCalledWith('created user: ', created);
  });
});
