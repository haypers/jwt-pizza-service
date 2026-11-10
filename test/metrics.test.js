const os = require('os');
const express = require('express');
const request = require('supertest');
const config = require('../src/config.js');
const metrics = require('../src/metrics.js');

const originalFetch = global.fetch;
const originalMetricsConfig = config.metrics;
const originalNodeEnv = process.env.NODE_ENV;

const testMetricsConfig = {
  source: 'jwt-pizza-service-test',
  endpointUrl: 'https://otlp.example/otlp/v1/metrics',
  accountId: '12345',
  apiKey: 'secret-key',
};

function findMetric(payload, name) {
  return payload.resourceMetrics[0].scopeMetrics[0].metrics.find((metric) => metric.name === name);
}

function attributes(point) {
  return Object.fromEntries(point.attributes.map(({ key, value }) => [key, value.stringValue]));
}

function pointWith(metric, expected) {
  const kind = metric.sum ?? metric.gauge;
  return kind.dataPoints.find((point) => Object.entries(expected).every(([key, value]) => attributes(point)[key] === value));
}

beforeEach(() => {
  metrics.resetState();
  config.metrics = { ...testMetricsConfig };
});

afterEach(() => {
  metrics.stop();
  config.metrics = originalMetricsConfig;
  process.env.NODE_ENV = originalNodeEnv;
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('requestTracker', () => {
  function createApp() {
    const app = express();
    app.use(metrics.requestTracker);
    const api = express.Router();
    app.use('/api', api);
    api.get('/user/:userId', (req, res) => res.json({ id: req.params.userId }));
    api.put('/auth', (req, res) => res.json({}));
    app.use('*', (req, res) => res.status(404).json({ message: 'unknown endpoint' }));
    return app;
  }

  test('counts requests by method and records latency per normalized endpoint', async () => {
    const app = createApp();

    await request(app).get('/api/user/7?debug=1');
    await request(app).get('/api/user/9');
    await request(app).put('/api/auth');
    await request(app).delete('/no/such/path/12');

    const payload = metrics.buildMetrics();
    const requests = findMetric(payload, 'http_requests');
    expect(pointWith(requests, { method: 'GET' }).asInt).toBe(2);
    expect(pointWith(requests, { method: 'PUT' }).asInt).toBe(1);
    expect(pointWith(requests, { method: 'POST' }).asInt).toBe(0);
    expect(pointWith(requests, { method: 'DELETE' }).asInt).toBe(1);

    const latency = findMetric(payload, 'service_latency');
    const latencyCount = findMetric(payload, 'service_latency_count');
    expect(latency.unit).toBe('ms');
    expect(pointWith(latencyCount, { endpoint: '/api/user/:id', method: 'GET' }).asInt).toBe(2);
    expect(pointWith(latencyCount, { endpoint: '/api/auth', method: 'PUT' }).asInt).toBe(1);
    expect(pointWith(latencyCount, { endpoint: 'unknown', method: 'DELETE' }).asInt).toBe(1);
    expect(pointWith(latency, { endpoint: '/api/user/:id', method: 'GET' }).asDouble).toBeGreaterThan(0);
  });
});

describe('buildMetrics', () => {
  test('builds cumulative sums and gauges tagged with the configured source', () => {
    jest.spyOn(os, 'cpus').mockReturnValue([{}, {}]);
    jest.spyOn(os, 'loadavg').mockReturnValue([1, 0, 0]);
    jest.spyOn(os, 'totalmem').mockReturnValue(1000);
    jest.spyOn(os, 'freemem').mockReturnValue(250);

    metrics.authAttempt(true);
    metrics.authAttempt(false);
    metrics.authAttempt(false);
    metrics.pizzaPurchase(true, 120, 3, 0.015);
    metrics.pizzaPurchase(false, 80, 2, 0.01);

    const payload = metrics.buildMetrics(1700000000000);

    const auth = findMetric(payload, 'auth_attempts');
    expect(auth.sum.aggregationTemporality).toBe('AGGREGATION_TEMPORALITY_CUMULATIVE');
    expect(auth.sum.isMonotonic).toBe(true);
    expect(pointWith(auth, { status: 'success' }).asInt).toBe(1);
    expect(pointWith(auth, { status: 'failure' }).asInt).toBe(2);
    expect(pointWith(auth, { status: 'success' })).toMatchObject({
      timeUnixNano: '1700000000000000000',
      startTimeUnixNano: expect.stringMatching(/^\d+000000$/),
    });

    expect(findMetric(payload, 'cpu')).toMatchObject({ unit: '%', gauge: { dataPoints: [{ asDouble: 50 }] } });
    expect(findMetric(payload, 'memory')).toMatchObject({ unit: '%', gauge: { dataPoints: [{ asDouble: 75 }] } });
    expect(findMetric(payload, 'pizzas_sold').sum.dataPoints[0].asInt).toBe(3);
    expect(findMetric(payload, 'pizza_creation_failures').sum.dataPoints[0].asInt).toBe(1);
    expect(findMetric(payload, 'revenue').sum.dataPoints[0].asDouble).toBeCloseTo(0.015);
    expect(findMetric(payload, 'pizza_creation_latency')).toMatchObject({ unit: 'ms', sum: { dataPoints: [{ asDouble: 200 }] } });
    expect(findMetric(payload, 'pizza_creation_latency_count').sum.dataPoints[0].asInt).toBe(2);
    expect(findMetric(payload, 'service_latency')).toBeUndefined();

    const allPoints = payload.resourceMetrics[0].scopeMetrics[0].metrics.flatMap((metric) => (metric.sum ?? metric.gauge).dataPoints);
    expect(allPoints.every((point) => attributes(point).source === 'jwt-pizza-service-test')).toBe(true);
  });
});

describe('active users', () => {
  test('counts users seen in the last five minutes and drops them on logout', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    metrics.userActive(1);
    metrics.userActive(2);
    metrics.userActive(undefined);
    expect(metrics.activeUserCount(1_000_000)).toBe(2);

    metrics.userInactive(2);
    expect(metrics.activeUserCount(1_000_000)).toBe(1);

    now.mockReturnValue(1_200_000);
    metrics.userActive(3);
    expect(metrics.activeUserCount(1_000_000 + 5 * 60 * 1000 + 1)).toBe(1);
  });
});

describe('sendMetrics', () => {
  test('posts the OTLP payload with the Grafana bearer credentials', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    await metrics.sendMetrics();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe(testMetricsConfig.endpointUrl);
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({ Authorization: 'Bearer 12345:secret-key', 'Content-Type': 'application/json' });
    expect(findMetric(JSON.parse(options.body), 'http_requests')).toBeDefined();
  });

  test('logs a rejected push without throwing', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, text: jest.fn().mockResolvedValue('bad token') });

    await expect(metrics.sendMetrics()).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith('Failed to push metrics to Grafana: HTTP 401 bad token');
  });

  test('logs a network failure without throwing', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = jest.fn().mockRejectedValue(new Error('offline'));

    await expect(metrics.sendMetrics()).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith('Error pushing metrics to Grafana: offline');
  });
});

describe('start', () => {
  test('does not schedule pushes under Jest', () => {
    expect(metrics.start()).toBeNull();
  });

  test('does not schedule pushes without complete metrics config', () => {
    process.env.NODE_ENV = 'production';
    config.metrics = { ...testMetricsConfig, apiKey: '' };
    expect(metrics.start()).toBeNull();

    config.metrics = undefined;
    expect(metrics.start()).toBeNull();
  });

  test('schedules one unref-ed push timer when enabled', () => {
    process.env.NODE_ENV = 'production';

    const timer = metrics.start(10000);

    expect(timer).not.toBeNull();
    expect(timer.hasRef()).toBe(false);
    expect(metrics.start(10000)).toBeNull();
  });
});
