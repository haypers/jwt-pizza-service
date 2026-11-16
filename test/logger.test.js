const express = require('express');
const request = require('supertest');
const config = require('../src/config.js');
const logger = require('../src/logger.js');

const originalFetch = global.fetch;
const originalLoggingConfig = config.logging;
const originalNodeEnv = process.env.NODE_ENV;
const originalJestWorkerId = process.env.JEST_WORKER_ID;

const testLoggingConfig = {
  source: 'jwt-pizza-service-test',
  endpointUrl: 'https://logs.example/loki/api/v1/push',
  accountId: '12345',
  apiKey: 'glc_test',
};

function enableLogging() {
  process.env.NODE_ENV = 'production';
  delete process.env.JEST_WORKER_ID;
  config.logging = { ...testLoggingConfig };
}

function parseSentLog() {
  const [, options] = global.fetch.mock.calls[0];
  const event = JSON.parse(options.body);
  const [timestamp, line] = event.streams[0].values[0];
  return { event, timestamp, data: JSON.parse(line), stream: event.streams[0].stream };
}

beforeEach(() => {
  config.logging = { ...testLoggingConfig };
  process.env.NODE_ENV = originalNodeEnv;
  if (originalJestWorkerId === undefined) {
    delete process.env.JEST_WORKER_ID;
  } else {
    process.env.JEST_WORKER_ID = originalJestWorkerId;
  }
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
});

afterEach(() => {
  config.logging = originalLoggingConfig;
  process.env.NODE_ENV = originalNodeEnv;
  if (originalJestWorkerId === undefined) {
    delete process.env.JEST_WORKER_ID;
  } else {
    process.env.JEST_WORKER_ID = originalJestWorkerId;
  }
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('sanitize', () => {
  test('masks nested sensitive keys and tokens inside JSON strings', () => {
    const sanitized = JSON.parse(
      logger.sanitize({
        password: 'plain',
        nested: { apiKey: 'k', authorization: 'Bearer abc', token: 't' },
        jwt: 'header.payload.sig',
        api_key: 'also-secret',
        secret: 'nope',
        safe: 'ok',
        blob: JSON.stringify({ password: 'hidden', name: 'diner' }),
        authHeader: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
        freeText: 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123 end',
      })
    );

    expect(sanitized.password).toBe('*****');
    expect(sanitized.nested).toEqual({ apiKey: '*****', authorization: '*****', token: '*****' });
    expect(sanitized.jwt).toBe('*****');
    expect(sanitized.api_key).toBe('*****');
    expect(sanitized.secret).toBe('*****');
    expect(sanitized.safe).toBe('ok');
    expect(JSON.parse(sanitized.blob)).toEqual({ password: '*****', name: 'diner' });
    expect(sanitized.authHeader).toBe('Bearer *****');
    expect(sanitized.freeText).toContain('*****');
    expect(sanitized.freeText).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });
});

describe('statusToLogLevel', () => {
  test('maps status codes to info, warn, and error', () => {
    expect(logger.statusToLogLevel(200)).toBe('info');
    expect(logger.statusToLogLevel(399)).toBe('info');
    expect(logger.statusToLogLevel(400)).toBe('warn');
    expect(logger.statusToLogLevel(404)).toBe('warn');
    expect(logger.statusToLogLevel(500)).toBe('error');
    expect(logger.statusToLogLevel(503)).toBe('error');
  });
});

describe('disabled logging', () => {
  test('does not call fetch under Jest', () => {
    logger.log('info', 'http', { path: '/x' });
    logger.dbLogger('SELECT 1', []);
    logger.factoryLogger({}, {}, 200);
    logger.unhandledErrorLogger(new Error('boom'));

    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('does not call fetch when logging config is incomplete', () => {
    enableLogging();
    config.logging = { ...testLoggingConfig, apiKey: '' };

    logger.log('info', 'http', { path: '/x' });

    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('sendLogToGrafana', () => {
  test('posts Loki streams with bearer credentials and sanitized bodies', () => {
    enableLogging();

    logger.log('info', 'http', {
      method: 'POST',
      path: '/api/auth',
      statusCode: 200,
      user: { id: 1, email: 'd@jwt.com' },
      reqBody: { email: 'd@jwt.com', password: 'diner' },
      resBody: { user: { id: 1 }, token: 'raw-jwt' },
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe(testLoggingConfig.endpointUrl);
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer 12345:glc_test',
    });

    const { event, data, stream, timestamp } = parseSentLog();
    expect(event.streams).toHaveLength(1);
    expect(stream).toEqual({ component: 'jwt-pizza-service-test', level: 'info', type: 'http' });
    expect(timestamp).toMatch(/^\d+000000$/);
    expect(data.reqBody.password).toBe('*****');
    expect(data.resBody.token).toBe('*****');
    expect(data.user).toEqual({ id: 1, email: 'd@jwt.com' });
  });

  test('swallows rejected fetches without throwing', () => {
    enableLogging();
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    global.fetch = jest.fn().mockRejectedValue(new Error('timeout'));

    expect(() => logger.log('error', 'unhandledError', { message: 'x' })).not.toThrow();

    return new Promise((resolve) => setImmediate(resolve)).then(() => {
      expect(log).toHaveBeenCalledWith('Error sending log to Grafana', 'timeout');
    });
  });

  test('logs a failed Grafana response without throwing', () => {
    enableLogging();
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });

    expect(() => logger.log('warn', 'http', { statusCode: 400 })).not.toThrow();

    return new Promise((resolve) => setImmediate(resolve)).then(() => {
      expect(log).toHaveBeenCalledWith('Failed to send log to Grafana');
    });
  });
});

describe('helpers', () => {
  test('dbLogger and factoryLogger include the AsyncLocalStorage user', () => {
    enableLogging();

    logger.als.run({ user: { id: 9, email: 'a@jwt.com' } }, () => {
      logger.dbLogger('INSERT INTO user (name, email, password) VALUES (?, ?, ?)', ['Ada', 'a@jwt.com', 'hash']);
      logger.factoryLogger({ order: { id: 1 } }, { jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig', reportUrl: 'https://x' }, 201);
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const dbLine = JSON.parse(JSON.parse(global.fetch.mock.calls[0][1].body).streams[0].values[0][1]);
    const factoryLine = JSON.parse(JSON.parse(global.fetch.mock.calls[1][1].body).streams[0].values[0][1]);

    expect(dbLine).toMatchObject({
      user: { id: 9, email: 'a@jwt.com' },
      sql: 'INSERT INTO user (name, email, password) VALUES (?, ?, ?)',
      params: ['Ada', 'a@jwt.com', '*****'],
    });
    expect(factoryLine.user).toEqual({ id: 9, email: 'a@jwt.com' });
    expect(factoryLine.resBody.jwt).toBe('*****');
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).streams[0].stream).toMatchObject({
      type: 'factory',
      level: 'info',
    });
  });

  test('unhandledErrorLogger records message, stack, and request context', () => {
    enableLogging();
    const err = new Error('kaboom');
    const req = { originalUrl: '/api/order', method: 'POST', user: { id: 3, email: 'c@jwt.com' } };

    logger.unhandledErrorLogger(err, req);

    const { data, stream } = parseSentLog();
    expect(stream).toEqual({ component: 'jwt-pizza-service-test', level: 'error', type: 'unhandledError' });
    expect(data).toMatchObject({
      message: 'kaboom',
      path: '/api/order',
      method: 'POST',
      user: { id: 3, email: 'c@jwt.com' },
    });
    expect(data.stack).toContain('kaboom');
  });

  test('httpLogger wraps responses and includes sanitized bodies', async () => {
    enableLogging();
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: 2, email: 'b@jwt.com' };
      next();
    });
    app.use(logger.requestContext);
    app.use(logger.httpLogger);
    app.post('/login', (req, res) => {
      res.status(200).send({ token: 'super-secret-jwt', user: { id: 2 } });
    });

    await request(app).post('/login').set('Authorization', 'Bearer abc').send({ email: 'b@jwt.com', password: 'x' });

    // Allow the fire-and-forget fetch microtask to run.
    await new Promise((resolve) => setImmediate(resolve));

    expect(global.fetch).toHaveBeenCalled();
    const { data, stream } = parseSentLog();
    expect(stream.type).toBe('http');
    expect(data).toMatchObject({
      method: 'POST',
      path: '/login',
      statusCode: 200,
      authorized: true,
      user: { id: 2, email: 'b@jwt.com' },
      reqBody: { email: 'b@jwt.com', password: '*****' },
      resBody: { token: '*****', user: { id: 2 } },
    });
  });
});
