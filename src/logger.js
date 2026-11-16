const { AsyncLocalStorage } = require('async_hooks');
const config = require('./config.js');

const SENSITIVE_KEY = /password|token|jwt|apikey|api_key|authorization|secret/i;
const BEARER_TOKEN = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_TOKEN = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

class Logger {
  constructor() {
    this.als = new AsyncLocalStorage();
  }

  requestContext = (req, res, next) => {
    const user = req.user ? { id: req.user.id, email: req.user.email } : null;
    this.als.run({ user }, () => next());
  };

  httpLogger = (req, res, next) => {
    const send = res.send;
    res.send = (resBody) => {
      const logData = {
        authorized: !!req.headers.authorization,
        path: req.originalUrl,
        method: req.method,
        statusCode: res.statusCode,
        user: this.currentUser(),
        reqBody: req.body,
        resBody: this.parseMaybeJson(resBody),
      };
      this.log(this.statusToLogLevel(res.statusCode), 'http', logData);
      res.send = send;
      return res.send(resBody);
    };
    next();
  };

  dbLogger(sql, params) {
    this.log('info', 'db', {
      user: this.currentUser(),
      sql,
      params: this.maskDbParams(sql, params ?? []),
    });
  }

  maskDbParams(sql, params) {
    if (!Array.isArray(params)) {
      return this.sanitizeValue(params);
    }
    const valuesMatch = sql.match(/\(([^)]*)\)\s*VALUES\s*\(/i);
    if (valuesMatch) {
      const cols = valuesMatch[1].split(',').map((col) => col.trim().replace(/[`"]/g, ''));
      return params.map((param, index) => (SENSITIVE_KEY.test(cols[index] || '') ? '*****' : this.sanitizeValue(param)));
    }
    return params.map((param) => (typeof param === 'string' && /^\$2[aby]?\$/.test(param) ? '*****' : this.sanitizeValue(param)));
  }

  factoryLogger(reqBody, resBody, statusCode) {
    this.log(this.statusToLogLevel(statusCode), 'factory', {
      user: this.currentUser(),
      statusCode,
      reqBody,
      resBody,
    });
  }

  unhandledErrorLogger(err, req) {
    const error = err instanceof Error ? err : new Error(String(err));
    this.log('error', 'unhandledError', {
      message: error.message,
      stack: error.stack,
      path: req?.originalUrl,
      method: req?.method,
      user: this.currentUser() ?? (req?.user ? { id: req.user.id, email: req.user.email } : null),
    });
  }

  log(level, type, logData) {
    if (!this.isEnabled()) {
      return;
    }

    const labels = { component: config.logging.source, level, type };
    const values = [this.nowString(), this.sanitize(logData)];
    this.sendLogToGrafana({ streams: [{ stream: labels, values: [values] }] });
  }

  currentUser() {
    return this.als.getStore()?.user ?? null;
  }

  isEnabled() {
    const logging = config.logging;
    return (
      process.env.NODE_ENV !== 'test' &&
      !process.env.JEST_WORKER_ID &&
      Boolean(logging?.source && logging?.endpointUrl && logging?.accountId && logging?.apiKey)
    );
  }

  statusToLogLevel(statusCode) {
    if (statusCode >= 500) return 'error';
    if (statusCode >= 400) return 'warn';
    return 'info';
  }

  nowString() {
    return `${Date.now()}000000`;
  }

  parseMaybeJson(value) {
    if (typeof value !== 'string') {
      return value;
    }
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  sanitize(logData) {
    return JSON.stringify(this.sanitizeValue(logData));
  }

  sanitizeValue(value) {
    if (Array.isArray(value)) {
      return value.map((entry) => this.sanitizeValue(entry));
    }
    if (value && typeof value === 'object') {
      const sanitized = {};
      for (const [key, entry] of Object.entries(value)) {
        sanitized[key] = SENSITIVE_KEY.test(key) ? '*****' : this.sanitizeValue(entry);
      }
      return sanitized;
    }
    if (typeof value === 'string') {
      return this.sanitizeString(value);
    }
    return value;
  }

  sanitizeString(value) {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        return JSON.stringify(this.sanitizeValue(JSON.parse(value)));
      } catch {
        // Fall through and mask tokens in the raw string.
      }
    }
    return value.replace(BEARER_TOKEN, 'Bearer *****').replace(JWT_TOKEN, '*****');
  }

  sendLogToGrafana(event) {
    const logging = config.logging;
    if (!logging?.endpointUrl) {
      return;
    }

    fetch(logging.endpointUrl, {
      method: 'POST',
      body: JSON.stringify(event),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${logging.accountId}:${logging.apiKey}`,
      },
    })
      .then((res) => {
        if (!res.ok) {
          console.log('Failed to send log to Grafana');
        }
      })
      .catch((err) => {
        console.log('Error sending log to Grafana', err.message);
      });
  }
}

module.exports = new Logger();
