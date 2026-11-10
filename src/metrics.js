const os = require('os');
const config = require('./config.js');

const SEND_INTERVAL_MS = 10000;
const ACTIVE_USER_WINDOW_MS = 5 * 60 * 1000;
const CUMULATIVE = 'AGGREGATION_TEMPORALITY_CUMULATIVE';

const startTimeUnixNano = toUnixNano(Date.now());

let state;
let timer = null;

function resetState() {
  state = {
    requests: { GET: 0, PUT: 0, POST: 0, DELETE: 0 },
    authAttempts: { success: 0, failure: 0 },
    activeUsers: new Map(),
    pizzasSold: 0,
    pizzaCreationFailures: 0,
    revenue: 0,
    pizzaLatency: { sum: 0, count: 0 },
    serviceLatency: new Map(),
  };
}
resetState();

function requestTracker(req, res, next) {
  const method = req.method;
  state.requests[method] = (state.requests[method] ?? 0) + 1;

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
    const endpoint = endpointOf(req, res);
    const key = `${method} ${endpoint}`;
    const entry = state.serviceLatency.get(key) ?? { method, endpoint, sum: 0, count: 0 };
    entry.sum += latencyMs;
    entry.count += 1;
    state.serviceLatency.set(key, entry);
  });
  next();
}

// Unmatched 404s collapse to one label so scanners cannot create unbounded series.
function endpointOf(req, res) {
  if (!req.route && res.statusCode === 404) {
    return 'unknown';
  }
  const path = req.originalUrl.split('?')[0].replace(/\/\d+(?=\/|$)/g, '/:id');
  return path.replace(/\/+$/, '') || '/';
}

function authAttempt(success) {
  state.authAttempts[success ? 'success' : 'failure'] += 1;
}

function userActive(userId) {
  if (userId !== undefined && userId !== null) {
    state.activeUsers.set(userId, Date.now());
  }
}

function userInactive(userId) {
  state.activeUsers.delete(userId);
}

function activeUserCount(now = Date.now()) {
  for (const [userId, lastSeen] of state.activeUsers) {
    if (now - lastSeen > ACTIVE_USER_WINDOW_MS) {
      state.activeUsers.delete(userId);
    }
  }
  return state.activeUsers.size;
}

function pizzaPurchase(success, latencyMs, pizzaCount, price) {
  state.pizzaLatency.sum += latencyMs;
  state.pizzaLatency.count += 1;
  if (success) {
    state.pizzasSold += pizzaCount;
    state.revenue += price;
  } else {
    state.pizzaCreationFailures += 1;
  }
}

function cpuUsagePercent() {
  const cpuCount = os.cpus().length || 1;
  return round((os.loadavg()[0] / cpuCount) * 100);
}

function memoryUsagePercent() {
  const total = os.totalmem();
  return round(((total - os.freemem()) / total) * 100);
}

function buildMetrics(now = Date.now()) {
  const timeUnixNano = toUnixNano(now);
  const gaugePoint = (value, isDouble, attributes = {}) => ({
    [isDouble ? 'asDouble' : 'asInt']: value,
    timeUnixNano,
    attributes: toAttributes({ source: config.metrics?.source ?? 'jwt-pizza-service', ...attributes }),
  });
  const point = (value, isDouble, attributes) => ({ ...gaugePoint(value, isDouble, attributes), startTimeUnixNano });

  const metrics = [
    sum(
      'http_requests',
      undefined,
      Object.entries(state.requests).map(([method, count]) => point(count, false, { method }))
    ),
    gauge('active_users', undefined, [gaugePoint(activeUserCount(now), false)]),
    sum(
      'auth_attempts',
      undefined,
      Object.entries(state.authAttempts).map(([status, count]) => point(count, false, { status }))
    ),
    gauge('cpu', '%', [gaugePoint(cpuUsagePercent(), true)]),
    gauge('memory', '%', [gaugePoint(memoryUsagePercent(), true)]),
    sum('pizzas_sold', undefined, [point(state.pizzasSold, false)]),
    sum('pizza_creation_failures', undefined, [point(state.pizzaCreationFailures, false)]),
    sum('revenue', undefined, [point(state.revenue, true)]),
    sum('pizza_creation_latency', 'ms', [point(state.pizzaLatency.sum, true)]),
    sum('pizza_creation_latency_count', undefined, [point(state.pizzaLatency.count, false)]),
  ];

  if (state.serviceLatency.size > 0) {
    const entries = [...state.serviceLatency.values()];
    metrics.push(
      sum(
        'service_latency',
        'ms',
        entries.map((e) => point(e.sum, true, { endpoint: e.endpoint, method: e.method }))
      ),
      sum(
        'service_latency_count',
        undefined,
        entries.map((e) => point(e.count, false, { endpoint: e.endpoint, method: e.method }))
      )
    );
  }

  return { resourceMetrics: [{ scopeMetrics: [{ metrics }] }] };
}

function sum(name, unit, dataPoints) {
  return withUnit({ name, sum: { dataPoints, aggregationTemporality: CUMULATIVE, isMonotonic: true } }, unit);
}

function gauge(name, unit, dataPoints) {
  return withUnit({ name, gauge: { dataPoints } }, unit);
}

function withUnit(metric, unit) {
  return unit ? { ...metric, unit } : metric;
}

function toAttributes(attributes) {
  return Object.entries(attributes).map(([key, value]) => ({ key, value: { stringValue: String(value) } }));
}

function toUnixNano(ms) {
  return `${ms}000000`;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function isEnabled() {
  const settings = config.metrics;
  return process.env.NODE_ENV !== 'test' && Boolean(settings?.endpointUrl && settings?.accountId && settings?.apiKey);
}

async function sendMetrics() {
  try {
    const { endpointUrl, accountId, apiKey } = config.metrics;
    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accountId}:${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildMetrics()),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(`Failed to push metrics to Grafana: HTTP ${response.status} ${detail}`);
    }
  } catch (err) {
    console.error(`Error pushing metrics to Grafana: ${err.message}`);
  }
}

function start(intervalMs = SEND_INTERVAL_MS) {
  if (timer || !isEnabled()) {
    return null;
  }
  timer = setInterval(sendMetrics, intervalMs);
  timer.unref();
  return timer;
}

function stop() {
  clearInterval(timer);
  timer = null;
}

start();

module.exports = {
  requestTracker,
  authAttempt,
  userActive,
  userInactive,
  pizzaPurchase,
  activeUserCount,
  buildMetrics,
  sendMetrics,
  start,
  stop,
  resetState,
};
