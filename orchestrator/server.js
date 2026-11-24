const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';
const ENFORCE_CERT_HOSTNAME = (process.env.ENFORCE_CERT_HOSTNAME || 'true') !== 'false';

if (!JWT_SECRET || !ADMIN_USER || !ADMIN_PASS) {
  console.error('[FATAL] Variables obligatorias no definidas: JWT_SECRET, ADMIN_USER, ADMIN_PASS.');
  process.exit(1);
}

const pool = new Pool({
  user: process.env.DB_USER || 'uab_admin',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'uab_telemetry',
  password: process.env.DB_PASSWORD || 'uab_aiops_secure_password',
  port: Number(process.env.DB_PORT || 5432),
});
pool.on('error', (err) => console.error('[DB] Error en conexión inactiva:', err.message));

const pendingCommands = Object.create(null);
const endpoints = Object.create(null);

const CERTS_DIR = process.env.CERTS_DIR || (fs.existsSync('/certs/ca.crt') ? '/certs' : path.join(__dirname, '../certs'));
const PROTO_PATH = process.env.PROTO_PATH || (fs.existsSync('/proto/telemetry.proto') ? '/proto/telemetry.proto' : path.join(__dirname, '../proto/telemetry.proto'));

const packageDef = protoLoader.loadSync(PROTO_PATH, { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
const proto = grpc.loadPackageDefinition(packageDef).uab_aiops;

const HOSTNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

function certCNFromPeer(call) {
  try {
    const socket = call?.call?.stream?.session?.socket;
    if (socket && typeof socket.getPeerCertificate === 'function') {
      const cert = socket.getPeerCertificate();
      return (cert && cert.subject && cert.subject.CN) || null;
    }
  } catch {
    /* fall through */
  }
  const match = /CN=([^,]+)/i.exec(call?.getPeer?.() || '');
  return match ? match[1].trim() : null;
}

async function streamTelemetry(call, callback) {
  const d = call.request;

  if (!HOSTNAME_RE.test(d.hostname || '')) {
    return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'hostname inválido' });
  }

  if (ENFORCE_CERT_HOSTNAME) {
    const cn = certCNFromPeer(call);
    if (!cn || cn.toLowerCase() !== d.hostname.toLowerCase()) {
      console.warn(`[mTLS] Rechazado: CN=${cn} intentó reportar hostname=${d.hostname}`);
      return callback({ code: grpc.status.PERMISSION_DENIED, message: 'El CN del certificado no coincide con el hostname reportado' });
    }
  }

  const isIsolated = endpoints[d.hostname]?.isolated || false;
  endpoints[d.hostname] = {
    ...d,
    isolated: isIsolated,
    live: true,
    last_seen: new Date().toISOString(),
  };

  try {
    await pool.query(
      'INSERT INTO telemetry (hostname, lab, ip, cpu_agent, ram_mb, ssd_health, ssd_temp, whea_errors, drift_status, isolated) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [d.hostname, d.lab, d.ip, d.cpu_agent, d.ram_mb, d.ssd_health, d.ssd_temp, d.whea_errors, d.drift_status, isIsolated]
    );
  } catch (err) {
    console.error('[DB] Error insertando telemetría:', err.message);
  }

  const cmd = pendingCommands[d.hostname] || { action: 'NONE', message: 'OK' };
  delete pendingCommands[d.hostname];
  callback(null, cmd);
}

setInterval(() => {
  const now = Date.now();
  for (const host of Object.keys(endpoints)) {
    if (now - new Date(endpoints[host].last_seen).getTime() > 10000) {
      endpoints[host].live = false;
    }
  }
}, 5000);

let rootCert;
let keyCertPairs;
try {
  rootCert = fs.readFileSync(path.join(CERTS_DIR, 'ca.crt'));
  keyCertPairs = [{
    private_key: fs.readFileSync(path.join(CERTS_DIR, 'server.key')),
    cert_chain: fs.readFileSync(path.join(CERTS_DIR, 'server.crt')),
  }];
} catch (err) {
  console.error(`[FATAL] No se pudieron leer los certificados en ${CERTS_DIR}: ${err.message}`);
  process.exit(1);
}

const grpcServer = new grpc.Server();
grpcServer.addService(proto.TelemetryService.service, { StreamTelemetry: streamTelemetry });

const creds = grpc.ServerCredentials.createSsl(rootCert, keyCertPairs, true);
grpcServer.bindAsync('0.0.0.0:50051', creds, (err, port) => {
  if (err) {
    console.error('[FATAL] No se pudo iniciar gRPC:', err.message);
    process.exit(1);
  }
  console.log('[gRPC/mTLS] Orquestador escuchando en puerto ' + port);
});

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '64kb' }));

const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX = 10;

function loginRateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, start: now };
  if (now - entry.start > LOGIN_WINDOW_MS) {
    entry.count = 0;
    entry.start = now;
  }
  entry.count += 1;
  loginAttempts.set(ip, entry);
  return entry.count > LOGIN_MAX;
}

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.post('/api/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (loginRateLimited(ip)) {
    return res.status(429).json({ error: 'Demasiados intentos. Intenta más tarde.' });
  }
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = jwt.sign({ username, role: 'ADMIN_TI' }, JWT_SECRET, { expiresIn: '8h' });
    return res.json({ token, username });
  }
  res.status(401).json({ error: 'Credenciales inválidas' });
});

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = jwt.verify(auth.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token expirado o inválido' });
  }
}

app.get('/api/endpoints', authMiddleware, (_req, res) => res.json(Object.values(endpoints)));

app.get('/api/history/:hostname', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT time, cpu_agent, ram_mb, ssd_health, ssd_temp FROM telemetry WHERE hostname = $1 ORDER BY time DESC LIMIT 30',
      [req.params.hostname]
    );
    res.json(rows.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/audit', authMiddleware, async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM audit_logs ORDER BY time DESC LIMIT 20');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const ALLOWED_ACTIONS = ['ISOLATE', 'UNISOLATE', 'SELF_HEAL', 'RESYNC_GOLDEN'];

app.post('/api/command/:hostname', authMiddleware, async (req, res) => {
  const { hostname } = req.params;
  const { action } = req.body || {};
  if (!endpoints[hostname]) return res.status(404).json({ error: 'Nodo no encontrado' });
  if (!ALLOWED_ACTIONS.includes(action)) return res.status(400).json({ error: 'Acción no permitida' });

  endpoints[hostname].isolated = action === 'ISOLATE';

  try {
    await pool.query(
      'INSERT INTO audit_logs (admin_user, hostname, action) VALUES ($1, $2, $3)',
      [req.user.username, hostname, action]
    );
  } catch (err) {
    console.error('[DB] Error registrando auditoría:', err.message);
  }

  pendingCommands[hostname] = { action, message: 'Comando ' + action + ' despachado por ' + req.user.username };
  console.log('[AIOps] ' + req.user.username + ' ejecutó ' + action + ' en ' + hostname);
  res.json({ ok: true, endpoint: endpoints[hostname] });
});

const httpServer = app.listen(4000, () => console.log('[API REST + JWT] Backend activo en http://localhost:4000'));

function shutdown(signal) {
  console.log(`[Shutdown] ${signal} recibido, cerrando...`);
  grpcServer.tryShutdown(() => {});
  httpServer.close(() => {});
  pool.end().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
