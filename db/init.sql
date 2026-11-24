-- Esquema de UAB-AIOps. Idempotente: seguro de ejecutar varias veces.
CREATE TABLE IF NOT EXISTS telemetry (
    id           SERIAL PRIMARY KEY,
    time         TIMESTAMPTZ DEFAULT now(),
    hostname     TEXT,
    lab          TEXT,
    ip           TEXT,
    cpu_agent    DOUBLE PRECISION,
    ram_mb       DOUBLE PRECISION,
    ssd_health   INTEGER,
    ssd_temp     INTEGER,
    whea_errors  INTEGER,
    drift_status TEXT,
    isolated     BOOLEAN DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_telemetry_hostname_time ON telemetry (hostname, time DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_time ON telemetry (time DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
    id         SERIAL PRIMARY KEY,
    time       TIMESTAMPTZ DEFAULT now(),
    admin_user TEXT NOT NULL,
    hostname   TEXT NOT NULL,
    action     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs (time DESC);
