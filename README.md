# UAB-AIOps

Plataforma de **monitoreo y autogestión AIOps** para los laboratorios de la Universidad Adventista de Bolivia (UAB).

Un agente nativo recolecta telemetría real de cada PC, la envía cifrada por **gRPC con mTLS** al orquestador central, que la guarda en **PostgreSQL** y permite a los administradores ver el estado en un **dashboard web** y ejecutar acciones remotas (auto-reparación, resincronización y cuarentena de red).

---

## Tabla de contenido

1. [¿Qué es UAB-AIOps?](#1-qué-es-uab-aiops)
2. [Características](#2-características)
3. [Arquitectura](#3-arquitectura)
4. [Estructura del repositorio](#4-estructura-del-repositorio)
5. [Requisitos](#5-requisitos)
6. [Inicio rápido (5 minutos)](#6-inicio-rápido-5-minutos)
7. [Configuración del servidor (.env)](#7-configuración-del-servidor-env)
8. [Certificados (mTLS)](#8-certificados-mtls)
9. [Despliegue con equipos reales](#9-despliegue-con-equipos-reales)
10. [Uso del dashboard](#10-uso-del-dashboard)
11. [Comandos remotos](#11-comandos-remotos)
12. [API REST](#12-api-rest)
13. [Base de datos](#13-base-de-datos)
14. [Compilar el agente y el .exe](#14-compilar-el-agente-y-el-exe)
15. [Variables de entorno](#15-variables-de-entorno)
16. [Solución de problemas](#16-solución-de-problemas)
17. [Seguridad](#17-seguridad)
18. [Mantenimiento y operación](#18-mantenimiento-y-operación)
19. [Limitaciones conocidas](#19-limitaciones-conocidas)
20. [Preguntas frecuentes](#20-preguntas-frecuentes)

---

## 1. ¿Qué es UAB-AIOps?

Es un sistema cliente-servidor para administrar los equipos de los laboratorios:

- **Agente (`agent-rust/`)**: programa nativo en Rust para Windows 10/11 y Linux. Lee métricas reales del equipo, vigila un archivo crítico (drift) y obedece comandos del servidor (incluida la cuarentena de red).
- **Orquestador (`orchestrator/`)**: servidor central. Expone gRPC/mTLS para los agentes y una API REST con JWT para el dashboard. Mantiene la cola de comandos y escribe en PostgreSQL.
- **Dashboard (`dashboard/`)**: interfaz web (React + Vite) para ver nodos, histórico, auditoría y lanzar comandos.

El agente **siempre inicia la conexión** hacia el servidor. Por eso el servidor no necesita conocer ni configurar la IP de cada equipo: los identifica por el `CN` de su certificado.

---

## 2. Características

- Telemetría real: CPU y RAM del proceso del agente, temperatura del primer sensor térmico, % de disco libre, estado de drift.
- **mTLS** obligatorio con validación de certificado de cliente y de que el `CN` coincida con el hostname reportado (anti-suplantación).
- Autenticación del dashboard con **JWT** y rate-limit en el login.
- Comandos remotos con **cola de entrega** (se ejecutan en el siguiente sondeo del agente, aunque estuviera desconectado).
- **Cuarentena de red reversible**:
  - Linux: cadenas dedicadas `UAB_AIOPS_OUT`/`UAB_AIOPS_IN` (no destruye reglas existentes).
  - Windows: guarda y restaura los perfiles de firewall vía PowerShell.
- Auditoría de todas las acciones administrativas en PostgreSQL.
- Dashboard con histórico térmico, filtros por laboratorio y estado en vivo.
- Contenedores con healthchecks y despliegue reproducido con Docker Compose.

---

## 3. Arquitectura

```
                         ┌──────────────────────────────────────────┐
                         │                 SERVIDOR                 │
                         │                                          │
  Agente Windows/Linux   │   Orchestrator (Node.js)                 │
  ┌───────────────┐      │   ┌────────────────────────────┐         │
  │ uab_agent.exe │─────▶│   │ gRPC/mTLS  :50051          │         │
  │ (Rust)        │ TLS  │   │ + cola de comandos         │         │
  │               │◀─────│   └────────────┬───────────────┘         │
  │ telemetría    │      │                │ SQL                     │
  │ cada 3 s      │      │                ▼                         │
  └───────────────┘      │   ┌────────────────────────────┐         │
                         │   │ PostgreSQL 16  :5432       │         │
  Navegador              │   └────────────────────────────┘         │
  ┌───────────────┐      │                ▲                         │
  │ Dashboard     │─────▶│   API REST/JWT  :4000                    │
  │ React (nginx) │      │                                          │
  └───────────────┘      └──────────────────────────────────────────┘
```

**Flujo de un comando** (`ISOLATE`, `UNISOLATE`, `SELF_HEAL`, `RESYNC_GOLDEN`):

1. El administrador pulsa la acción en el dashboard.
2. La API valida el JWT y la acción permitida, la registra en `audit_logs` y la deja en la cola del nodo.
3. En el siguiente sondeo (≤3 s) el agente recibe el comando y lo aplica.
4. El resultado se refleja en la siguiente telemetría.

El RPC se llama `StreamTelemetry` pero hoy es **unary con polling** cada 3 s (no streaming continuo). Un nodo se marca `offline` si pasan más de 10 s sin telemetría.

---

## 4. Estructura del repositorio

```
uab-aiops/
├── agent-rust/                 # Agente nativo (Rust)
│   ├── src/main.rs             # Telemetría, drift, firewall, mTLS
│   ├── build.rs                # Compila el .proto
│   ├── Cargo.toml
│   └── install-windows.ps1     # Instalador para PCs Windows (SYSTEM)
├── orchestrator/               # Servidor central
│   ├── server.js               # gRPC + API REST + JWT + PostgreSQL
│   ├── package.json
│   └── Dockerfile
├── dashboard/                  # Frontend React + Vite (servido por nginx)
│   ├── src/App.jsx
│   ├── nginx.conf
│   └── Dockerfile
├── proto/
│   └── telemetry.proto         # Contrato gRPC compartido
├── db/
│   └── init.sql                # Esquema (se aplica en volumen nuevo)
├── certs/                      # PKI (las claves privadas NO se versionan)
│   ├── gen-certs.sh            # Genera CA + servidor + 1 agente
│   └── issue-agent-cert.sh     # Emite cert para un equipo nuevo
├── dist/
│   └── uab_agent.exe           # Binario Windows ya compilado (no versionado)
├── docker-compose.yml          # Pila por defecto (solo localhost)
├── docker-compose.lan.yml      # Override para acceso desde la LAN
├── .env.example                # Plantilla de configuración
└── README.md
```

---

## 5. Requisitos

**Servidor:**

- Docker + Docker Compose v2.
- Puerto **50051/TCP** accesible desde los equipos de los laboratorios.
- Puertos **4000** y **5173** solo si necesitas ver el dashboard desde otra máquina (por defecto quedan en `127.0.0.1`).

**Máquinas de laboratorio:**

- Windows 10/11 x64 o Linux.
- `uab_agent.exe` (incluido en `dist/`) o compilado por ti.
- Un certificado de agente emitido por la CA del proyecto.

**Desarrollo/compilación:**

- Rust 1.75+ (probado con 1.100).
- Node.js 20+ (solo si compilas el dashboard fuera de Docker).

---

## 6. Inicio rápido (5 minutos)

```bash
# 1. Clona y entra al proyecto
git clone <URL_DEL_REPO> uab-aiops
cd uab-aiops

# 2. Crea el archivo de entorno y cambia los secretos
cp .env.example .env
$EDITOR .env

# 3. Genera la PKI (CA + servidor + un agente de ejemplo)
./certs/gen-certs.sh MI-PC-LAB01 172.17.34.113

# 4. Levanta la pila
docker compose up -d --build

# 5. Comprueba que todo está sano
docker compose ps
curl -s http://localhost:4000/api/health    # {"ok":true}
```

- Dashboard: <http://localhost:5173>
- Usuario/contraseña: los de `ADMIN_USER` / `ADMIN_PASS` en tu `.env`.

Para probar el agente en la misma máquina del servidor (Linux):

```bash
cd agent-rust
cargo build --release
UAB_SERVER=127.0.0.1 \
UAB_HOST=MI-PC-LAB01 \
UAB_LAB="LAB 1" \
UAB_CERTS=../certs \
./target/release/uab_agent
```

En unos segundos el nodo aparece en el dashboard.

---

## 7. Configuración del servidor (.env)

Copia `.env.example` a `.env`. **Nunca** subas `.env` al repositorio.

| Variable | Descripción |
| --- | --- |
| `DB_HOST` | Host de PostgreSQL (en Compose: `db`). |
| `DB_PORT` | Puerto de PostgreSQL (`5432`). |
| `DB_USER` | Usuario de la base de datos. |
| `DB_PASSWORD` | Contraseña de la base de datos. |
| `DB_NAME` | Nombre de la base de datos (`uab_telemetry`). |
| `JWT_SECRET` | Secreto de firma de los tokens JWT. **Obligatorio**, largo y aleatorio. |
| `ADMIN_USER` | Usuario administrador del dashboard. **Obligatorio**. |
| `ADMIN_PASS` | Contraseña del administrador. **Obligatorio**. |
| `CORS_ORIGIN` | Origen permitido para la API (por defecto `http://localhost:5173`). |
| `ENFORCE_CERT_HOSTNAME` | `true` (defecto): exige que el CN del certificado coincida con el hostname. |
| `VITE_API_URL` | URL de la API que usará el navegador. Solo necesaria para acceso LAN. |

Genera secretos fuertes, por ejemplo:

```bash
openssl rand -hex 32
```

> Si falta `JWT_SECRET`, `ADMIN_USER` o `ADMIN_PASS`, el orquestador **se niega a arrancar**.

---

## 8. Certificados (mTLS)

### 8.1 Cómo funciona

- Existe una **CA propia** del proyecto (`ca.crt` / `ca.key`).
- El **servidor** usa `server.crt` / `server.key`.
- Cada **equipo** tiene su propio `agent.crt` / `agent.key`, firmado por la misma CA.
- El servidor exige certificado de cliente (`createSsl(..., checkClientCertificate=true)`).
- Además, el `CN` del certificado del agente **debe coincidir** con el `hostname` que reporta. Si no, se rechaza con `PermissionDenied`.

### 8.2 Generar la PKI inicial

```bash
./certs/gen-certs.sh <AGENT_CN> [IP_EXTRA_DEL_SERVIDOR]
# Ejemplo:
./certs/gen-certs.sh PC-LAB01-C07 172.17.34.113
```

Genera:

- `ca.crt`, `ca.key` (¡guarda `ca.key` en un lugar seguro y nunca la subas!).
- `server.crt`, `server.key` (CN `localhost`, SAN `localhost` + `127.0.0.1` + IP extra).
- `agent.crt`, `agent.key` (CN = `<AGENT_CN>`).

### 8.3 Emitir un certificado para un equipo nuevo

No hace falta regenerar la CA. Con la CA existente:

```bash
./certs/issue-agent-cert.sh PC-LAB02-C03 /tmp/certs-PC-LAB02-C03
```

Eso crea en el directorio destino: `ca.crt`, `agent.crt`, `agent.key`. Cópialos a ese equipo.

> **Regla de oro:** el `CN` debe ser exactamente el hostname del equipo (`$env:COMPUTERNAME` en Windows, `hostname` en Linux), o el valor que pongas en `UAB_HOST`.

### 8.4 Rotación

Si sospechas que una clave se filtró:

```bash
./certs/gen-certs.sh NUEVO-CN 172.17.34.113   # nueva CA y certificados
docker compose restart orchestrator
# Vuelve a emitir y desplegar los certs de cada agente
```

Las claves antiguas dejan de ser válidas al cambiar la CA.

### 8.5 Nunca versionar

`.gitignore` excluye `certs/*.key`, `certs/**/*.key`, `agente-windows/` y `*.exe`.
Si alguna clave privada llegó a commitearse, **rótala** y purga el historial:

```bash
git filter-repo --path agente-windows --invert-paths   # o BFG Repo-Cleaner
```

---

## 9. Despliegue con equipos reales

### 9.1 Preparar el servidor

1. `docker compose up -d --build` y verifica que todo esté *healthy*:

   ```bash
   docker compose ps
   ```

2. Abre el puerto gRPC en el firewall del servidor (por ahí entran los agentes):

   ```bash
   # firewalld (Fedora/RHEL)
   sudo firewall-cmd --add-port=50051/tcp --permanent && sudo firewall-cmd --reload
   # ufw (Debian/Ubuntu)
   sudo ufw allow 50051/tcp
   ```

3. Anota la IP del servidor:

   ```bash
   ip -4 addr show | grep inet
   ```

### 9.2 Acceso al dashboard desde otros equipos

Por defecto, el dashboard (5173) y la API (4000) quedan atados a `127.0.0.1`, que es lo más seguro. Tienes dos opciones:

**Opción A — Túnel SSH (recomendado, no expone nada):**

```bash
ssh -L 5173:127.0.0.1:5173 usuario@IP_DEL_SERVIDOR
# Luego abre http://localhost:5173 en tu equipo
```

**Opción B — Exponer en la LAN:**

1. En `.env` ajusta:

   ```ini
   CORS_ORIGIN=http://IP_DEL_SERVIDOR:5173
   VITE_API_URL=http://IP_DEL_SERVIDOR:4000/api
   ```

2. Levanta con el override:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.lan.yml up -d --build
   ```

3. Abre `http://IP_DEL_SERVIDOR:5173`.

> `VITE_API_URL` se "hornea" al compilar el frontend; si cambias la IP, reconstruye el dashboard (`--build`).

### 9.3 Agente en Windows (recomendado)

1. Emite su certificado (en el servidor) con el hostname real del PC:

   ```bash
   ./certs/issue-agent-cert.sh PC-LAB01-C07 /tmp/certs-PC-LAB01-C07
   ```

2. Copia al PC:
   - `dist/uab_agent.exe`
   - la carpeta de certificados (`ca.crt`, `agent.crt`, `agent.key`)
   - `agent-rust/install-windows.ps1`

3. Abre **PowerShell como Administrador** en la carpeta donde están los archivos:

   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass -Force
   .\install-windows.ps1 -ServerIp 172.17.34.113 -CertsDir C:\ruta\certs-PC-LAB01-C07 -Lab "LAB 1"
   ```

   El script:
   - Instala todo en `C:\Program Files\UAB-AIOps\`.
   - Configura las variables de entorno a nivel de máquina.
   - Registra una tarea al arranque que corre **como SYSTEM** (necesario para que la cuarentena de firewall funcione).
   - Escribe el log en `C:\Program Files\UAB-AIOps\agent.log`.

4. Verifica en el dashboard que aparece el equipo.

Para desinstalar:

```powershell
.\install-windows.ps1 -ServerIp x -CertsDir x -Uninstall
```

### 9.4 Agente en Windows (manual)

Si prefieres no usar el instalador, define las variables y ejecuta el `.exe`:

```powershell
$env:UAB_SERVER   = "172.17.34.113"
$env:UAB_HOST     = $env:COMPUTERNAME    # debe coincidir con el CN del certificado
$env:UAB_LAB      = "LAB 1"
$env:UAB_CERTS    = "C:\ruta\certs"
$env:UAB_TLS_DOMAIN = "localhost"        # déjalo así salvo que uses DNS propio

.\uab_agent.exe
```

> Para que `ISOLATE`/`UNISOLATE` toquen el firewall, ejecuta la consola **como Administrador**.

### 9.5 Agente en Linux (systemd)

```ini
# /etc/systemd/system/uab-agent.service
[Unit]
Description=UAB-AIOps Agent
After=network-online.target
Wants=network-online.target

[Service]
Environment=UAB_SERVER=172.17.34.113
Environment=UAB_HOST=pc-lab01-c07
Environment=UAB_LAB=LAB 1
Environment=UAB_CERTS=/etc/uab-aiops/certs
ExecStart=/usr/local/bin/uab_agent
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now uab-agent
journalctl -u uab-agent -f
```

`User=root` es necesario para las reglas de `iptables` de la cuarentena.

---

## 10. Uso del dashboard

1. Inicia sesión con `ADMIN_USER` / `ADMIN_PASS`.
2. **Endpoints & Telemetría**: lista de nodos con hostname, lab/IP, temperatura, disco libre, CPU/RAM del agente y estado.
   - Filtra por laboratorio con los botones `TODOS`, `LAB 1`, `LAB 2`, `LAB 3`, `ADM`.
   - Pulsa un nodo para ver el detalle y el **historial térmico** (últimas 30 muestras de PostgreSQL).
3. **Botones de acción** (por nodo seleccionado):
   - **Actualizar Línea Base Dorada** (`RESYNC_GOLDEN`).
   - **Ejecutar Self-Healing** (`SELF_HEAL`).
   - **Aislar / Levantar Aislamiento** (`ISOLATE` / `UNISOLATE`).
4. **Auditoría de Comandos**: últimas 20 acciones con usuario, equipo y fecha.
5. **Salir**: borra el token del navegador.

Estados posibles de un nodo:

| Estado | Significado |
| --- | --- |
| `●` verde | Recibiendo telemetría (<10 s). |
| `●` rojo | Sin telemetría (>10 s). |
| `Dorado OK` | El archivo vigilado coincide con el hash de referencia. |
| `Drift detectado...` | El archivo vigilado cambió. |
| `Aislado` | El administrador activó la cuarentena para ese nodo. |

> El dashboard se refresca automáticamente cada 2 segundos.

---

## 11. Comandos remotos

| Comando | Efecto |
| --- | --- |
| `SELF_HEAL` | Vuelve a fijar como línea base el hash **actual** del archivo vigilado. |
| `RESYNC_GOLDEN` | Igual que `SELF_HEAL` en la versión actual: fija el hash actual como dorado. |
| `ISOLATE` | Aplica cuarentena de firewall: bloquea el tráfico dejando solo gRPC al servidor. Requiere privilegios. |
| `UNISOLATE` | Levanta la cuarentena restaurando la configuración previa. |

Detalles de implementación:

- **Linux**: crea las cadenas `UAB_AIOPS_OUT` y `UAB_AIOPS_IN`, permite `lo`, conexiones establecidas y `TCP/<server>:50051`, y hace `DROP` del resto. `UNISOLATE` elimina **solo** esas cadenas (no borra tus reglas). Si no hay root o `iptables`, informa que no pudo aplicarse.
- **Windows**: guarda los perfiles de firewall en `%ProgramData%\UAB_AIOps\fw_state.txt`, pone `DefaultInboundAction`/`DefaultOutboundAction` en `Block` y crea una regla `UAB_AIOps_Allow` para `TCP 50051` hacia el servidor. `UNISOLATE` restaura los perfiles guardados y elimina la regla.

> Enviar `ISOLATE` a un agente que no corre como administrador/root **no aplica** la cuarentena (verás el aviso en el log del agente).

---

## 12. API REST

Base: `http://IP_DEL_SERVIDOR:4000/api`

| Método | Ruta | Auth | Descripción |
| --- | --- | --- | --- |
| `POST` | `/login` | No | Devuelve `{ token, username }` (rate-limited). |
| `GET` | `/health` | No | Healthcheck (comprueba la DB). |
| `GET` | `/endpoints` | JWT | Nodos con telemetría en memoria. |
| `GET` | `/history/:hostname` | JWT | Últimas 30 muestras del nodo. |
| `GET` | `/audit` | JWT | Últimas 20 acciones auditadas. |
| `POST` | `/command/:hostname` | JWT | Encola un comando permitido. |

Ejemplos:

```bash
# Login
TOKEN=$(curl -s -X POST http://localhost:4000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"TU_PASSWORD"}' | jq -r .token)

# Nodos
curl -s http://localhost:4000/api/endpoints -H "Authorization: Bearer $TOKEN" | jq

# Enviar comando
curl -s -X POST http://localhost:4000/api/command/PC-LAB01-C07 \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"action":"SELF_HEAL"}' | jq

# Auditoría
curl -s http://localhost:4000/api/audit -H "Authorization: Bearer $TOKEN" | jq
```

Códigos habituales: `401` sin token/ inválido, `400` acción no permitida, `404` nodo desconocido, `429` demasiados intentos de login, `503` DB no disponible.

---

## 13. Base de datos

Motor: **PostgreSQL 16**. Esquema en `db/init.sql`:

- `telemetry(id, time, hostname, lab, ip, cpu_agent, ram_mb, ssd_health, ssd_temp, whea_errors, drift_status, isolated)`
  con índices por `(hostname, time)` y `time`.
- `audit_logs(id, time, admin_user, hostname, action)` con índice por `time`.

El archivo se monta en `/docker-entrypoint-initdb.d/` y **solo se ejecuta al crear el volumen por primera vez**. Si ya tienes datos, aplícalo a mano:

```bash
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < db/init.sql
```

Es idempotente (`CREATE TABLE IF NOT EXISTS`).

Acceso manual:

```bash
docker compose exec db psql -U uab_admin -d uab_telemetry
```

---

## 14. Compilar el agente y el .exe

### 14.1 Linux

```bash
cd agent-rust
cargo build --release
# Binario: target/release/uab_agent
```

### 14.2 Windows (.exe)

Hay dos formas:

**A) Compilación cruzada desde Linux (la usada para `dist/uab_agent.exe`):**

Requisitos: `rustup target add x86_64-pc-windows-gnu` y `mingw-w64-gcc` instalado.

```bash
cd agent-rust
cargo build --release --target x86_64-pc-windows-gnu
mkdir -p ../dist
cp target/x86_64-pc-windows-gnu/release/uab_agent.exe ../dist/uab_agent.exe
```

El resultado es un `.exe` **autocontenido** (PE32+ x86-64); no requiere DLLs de MinGW, solo las DLLs del sistema de Windows 10/11.

**B) Compilación nativa en Windows:**

Instala Rust (rustup) en Windows y ejecuta `cargo build --release` dentro de `agent-rust\`.

### 14.3 Binario entregado

- Ruta: **`dist/uab_agent.exe`**
- Tipo: PE32+ ejecutable Windows 5.02 (consola), x86-64.
- Tamaño: ~9.4 MB.
- SHA-256 del build actual:

  ```
  ab7de3ffb23685a28becc77c31921c61cdffd783b852b83e81e3850f1c1cdd35
  ```

> El hash cambia cada vez que recompilas. `*.exe` está en `.gitignore`: para distribuir el binario usa **GitHub Releases** o cópialo manualmente a cada PC, no lo commitees.

---

## 15. Variables de entorno

### Agente

| Variable | Por defecto | Descripción |
| --- | --- | --- |
| `UAB_SERVER` | `127.0.0.1` | IP/host del orquestador. |
| `UAB_HOST` | hostname del sistema | Hostname a reportar. **Debe coincidir con el CN del certificado.** |
| `UAB_LAB` | `LAB 1` | Etiqueta de laboratorio. |
| `UAB_CERTS` | `../certs` | Directorio con `ca.crt`, `agent.crt`, `agent.key`. |
| `UAB_TLS_DOMAIN` | `localhost` | Nombre validado en el certificado del servidor. |

### Orquestador

Ver [sección 7](#7-configuración-del-servidor-env). Además:

| Variable | Por defecto | Descripción |
| --- | --- | --- |
| `CERTS_DIR` | `/certs` (o `../certs`) | Directorio de la PKI dentro del contenedor. |
| `PROTO_PATH` | `/proto/telemetry.proto` | Ruta del contrato gRPC. |
| `ENFORCE_CERT_HOSTNAME` | `true` | Validación CN ↔ hostname. |

---

## 16. Solución de problemas

| Síntoma | Causa probable | Solución |
| --- | --- | --- |
| `PermissionDenied: El CN del certificado no coincide...` | `UAB_HOST` ≠ CN del certificado. | Usa el hostname correcto o emite un cert con ese CN. |
| `[FATAL] No se pudieron leer los certificados` | Falta la PKI o el montaje `/certs`. | Ejecuta `gen-certs.sh` y revisa el volumen en Compose. |
| `[FATAL] Variables obligatorias...` | Faltan `JWT_SECRET`/`ADMIN_USER`/`ADMIN_PASS`. | Complétalas en `.env`. |
| El nodo no aparece en el dashboard | Agente caído, IP/puerto mal, firewall del servidor. | Revisa el log del agente y abre `50051/tcp`. |
| Nodo en rojo (`offline`) | >10 s sin telemetría. | Revisa que el agente siga corriendo y con red. |
| `ISOLATE` no bloquea nada (Linux) | Sin root o sin `iptables`. | Corre como root/systemd. El log avisa si no pudo. |
| `ISOLATE` no bloquea nada (Windows) | Proceso sin privilegios. | Ejecuta como Administrador/SYSTEM (`install-windows.ps1`). |
| Error al insertar telemetría | Tabla inexistente. | Aplica `db/init.sql` (sección 13). |
| Dashboard sin datos desde otro PC | API en `localhost`/CORS. | Usa túnel SSH o el override LAN con `VITE_API_URL` y `CORS_ORIGIN`. |
| Login devuelve `429` | Rate-limit (10 intentos / 5 min). | Espera o reinicia el orquestador. |
| `address already in use` | Puerto ocupado. | Libera 4000/5001/5432/5173 o cambia el mapeo. |
| Certificados caducados | Vida de 825 días. | Regenera la PKI y redespliega. |

Logs útiles:

```bash
docker compose logs -f orchestrator
docker compose logs -f db
docker compose logs -f dashboard
```

En Windows: `Get-Content "C:\Program Files\UAB-AIOps\agent.log" -Wait`.

Comprobar TLS manualmente:

```bash
openssl x509 -in certs/server.crt -noout -subject -dates -ext subjectAltName
openssl x509 -in certs/agent.crt  -noout -subject -issuer -dates
```

---

## 17. Seguridad

- **mTLS obligatorio**: sin certificado de cliente válido no hay telemetría.
- **Anti-suplantación**: el `CN` debe igualar el `hostname` (`ENFORCE_CERT_HOSTNAME=true`).
- **Sin credenciales por defecto**: el frontend ya no trae usuario/contraseña; el servidor aborta si faltan secretos.
- **JWT** de 8 h y **rate-limit** de login (10 intentos / 5 min por IP).
- **Auditoría** de comandos en PostgreSQL.
- **Cuarentena reversible**: no borra reglas ajenas (Linux) ni deja el firewall a medias (Windows).
- **Claves privadas** fuera de git; rotación documentada.
- Por defecto, API y dashboard escuchan **solo en `127.0.0.1`**; expón en LAN de forma consciente.

Recomendaciones adicionales:

- El JWT se guarda en `localStorage`; si el dashboard se expone en red, usa **HTTPS** (reverse proxy con TLS) para evitar intercepción.
- Ejecuta el agente con la **mínima** cuenta con privilegios suficientes (root/SYSTEM solo si necesitas cuarentena).
- Rota `JWT_SECRET` y las contraseñas periódicamente.
- Purga del historial de git cualquier clave que se haya colado.

---

## 18. Mantenimiento y operación

**Backups de la base de datos:**

```bash
docker compose exec -T db pg_dump -U uab_admin uab_telemetry > backup_$(date +%F).sql
```

**Actualizar imágenes tras cambios de código:**

```bash
docker compose up -d --build
```

**Aplicar cambios de certificados:**

```bash
docker compose restart orchestrator   # relee /certs al arrancar
```

**Retención de datos:** no hay purga automática; `telemetry` crece de forma indefinida.
Programa una limpieza (ejemplo, conservar 30 días):

```sql
DELETE FROM telemetry WHERE time < now() - interval '30 days';
```

Puedes añadirla a un cron del host:

```bash
0 3 * * * docker compose -f /ruta/uab-aiops/docker-compose.yml exec -T db \
  psql -U uab_admin -d uab_telemetry -c "DELETE FROM telemetry WHERE time < now() - interval '30 days';"
```

**Reiniciar desde cero (borra datos):**

```bash
docker compose down -v
docker compose up -d --build
```

---

## 19. Limitaciones conocidas

- `ssd_health` es en realidad el **% de espacio libre** del disco principal (no salud SMART).
- `ssd_temp` es la **primera lectura térmica disponible**, no necesariamente del SSD.
- `whea_errors` se reporta como `0` (leer el log WHEA requiere privilegios y no está implementado).
- `SELF_HEAL` y `RESYNC_GOLDEN` hacen lo mismo hoy: fijar el hash actual como línea base.
- El RPC `StreamTelemetry` es unary con polling cada 3 s, no streaming continuo.
- La cuarentena de Windows usa PowerShell (`Get/Set-NetFirewallProfile`); probada por compilación, requiere validación en hardware real.
- Sin retención automática de telemetría.
- El dashboard no incluye TLS propio; para exposición pública usa un proxy inverso.

---

## 20. Preguntas frecuentes

**¿Necesito la IP de cada equipo en el servidor?**
No. Los agentes inician la conexión y se identifican por el `CN` de su certificado. Solo necesitas abrir el 50051 en el servidor.

**¿Puedo tener varios agentes con la misma IP?**
Sí. Cada uno debe tener su propio certificado/hostname; se gestionan por separado (útil para pruebas en un mismo host).

**¿Qué pasa si un agente está apagado cuando envío un comando?**
El comando queda en cola y se entrega en su siguiente sondeo, cuando vuelva.

**¿Cómo doy de alta un laboratorio nuevo?**
Usa una etiqueta nueva en `UAB_LAB` al instalar el agente; aparecerá en los filtros del dashboard.

**¿Puedo usar nombres DNS en vez de IPs?**
Sí. Define `UAB_SERVER` con el nombre, `UAB_TLS_DOMAIN` con ese nombre y asegúrate de que el SAN del certificado del servidor lo incluya.

**¿Dónde están los logs del agente en Windows?**
En `C:\Program Files\UAB-AIOps\agent.log` si usaste `install-windows.ps1`.

**¿Cómo cambio la contraseña del dashboard?**
Edita `ADMIN_PASS` en `.env` y ejecuta `docker compose up -d orchestrator`.

---

## Licencia

Proyecto interno de la Universidad Adventista de Bolivia. Define aquí la licencia si vas a publicarlo.
