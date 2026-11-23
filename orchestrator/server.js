const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'uab_aiops_super_secret_key_2026';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'uab2026';
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

const pool = new Pool({
  user: process.env.DB_USER || 'uab_admin',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'uab_telemetry',
  password: process.env.DB_PASSWORD || 'uab_aiops_secure_password',
  port: Number(process.env.DB_PORT || 5432),
});

const pendingCommands = {};
const endpoints = {};

const CERTS_DIR = process.env.CERTS_DIR || (fs.existsSync('/certs/ca.crt') ? '/certs' : path.join(__dirname, '../certs'));
const PROTO_PATH = process.env.PROTO_PATH || (fs.existsSync('/proto/telemetry.proto') ? '/proto/telemetry.proto' : path.join(__dirname, '../proto/telemetry.proto'));

const packageDef = protoLoader.loadSync(PROTO_PATH, { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
const proto = grpc.loadPackageDefinition(packageDef).uab_aiops;

async function streamTelemetry(call, callback) {
  const d = call.request;
  const isIsolated = endpoints[d.hostname]?.isolated || false;

  endpoints[d.hostname] = {
    ...d,
    isolated: isIsolated,
    drift_status: isIsolated ? 'Aislamiento Activo' : d.drift_status,
    live: true,
    last_seen: new Date().toISOString()
  };

  try {
    await pool.query(
      'INSERT INTO telemetry (time, hostname, lab, ip, cpu_agent, ram_mb, ssd_health, ssd_temp, whea_errors, drift_status, isolated) VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [d.hostname, d.lab, d.ip, d.cpu_agent, d.ram_mb, d.ssd_health, d.ssd_temp, d.whea_errors, d.drift_status, isIsolated]
    );
  } catch (err) {
    console.error('Error DB:', err);
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

const grpcServer = new grpc.Server();
grpcServer.addService(proto.TelemetryService.service, { StreamTelemetry: streamTelemetry });

const rootCert = fs.readFileSync(path.join(CERTS_DIR, 'ca.crt'));
const keyCertPairs = [{
  private_key: fs.readFileSync(path.join(CERTS_DIR, 'server.key')),
  cert_chain: fs.readFileSync(path.join(CERTS_DIR, 'server.crt')),
}];
const creds = grpc.ServerCredentials.createSsl(rootCert, keyCertPairs, true);

grpcServer.bindAsync('0.0.0.0:50051', creds, (err, port) => {
  if (err) throw err;
  console.log('[gRPC/mTLS] Orquestador Real escuchando en puerto ' + port);
});

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
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

app.get('/api/endpoints', authMiddleware, (req, res) => res.json(Object.values(endpoints)));

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

app.get('/api/audit', authMiddleware, async (req, res) => {
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
  const { action } = req.body;
  if (endpoints[hostname] === undefined) return res.status(404).json({ error: 'Nodo no encontrado' });
  if (!ALLOWED_ACTIONS.includes(action)) return res.status(400).json({ error: 'Acción no permitida' });

  if (action === 'ISOLATE') {
    endpoints[hostname].isolated = true;
    endpoints[hostname].drift_status = 'Aislamiento Activo';
  } else if (['UNISOLATE', 'SELF_HEAL', 'RESYNC_GOLDEN'].includes(action)) {
    endpoints[hostname].isolated = false;
    endpoints[hostname].drift_status = 'Dorado OK';
  }

  await pool.query(
    'INSERT INTO audit_logs (admin_user, hostname, action) VALUES ($1, $2, $3)',
    [req.user.username, hostname, action]
  );

  pendingCommands[hostname] = { action, message: 'Comando ' + action + ' despachado por ' + req.user.username };
  console.log('[AIOps] ' + req.user.username + ' ejecutó ' + action + ' en ' + hostname);
  res.json({ ok: true, endpoint: endpoints[hostname] });
});

app.listen(4000, () => console.log('[API REST + JWT] Backend activo en http://localhost:4000'));