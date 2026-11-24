import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Shield, Cpu, HardDrive, Activity, RefreshCw, ShieldAlert, CheckCircle2, Terminal, Server, Lock, History, LogOut } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';

function TempChart({ history }) {
  if (!history || history.length < 2) {
    return <div className="text-xs text-slate-500 font-mono py-6 text-center">Recolectando lecturas históricas en PostgreSQL...</div>;
  }
  const w = 420;
  const h = 110;
  const maxTemp = Math.max(...history.map(p => Number(p.ssd_temp) || 0), 75);
  const minTemp = Math.min(...history.map(p => Number(p.ssd_temp) || 0), 20);
  const range = Math.max(maxTemp - minTemp, 1);

  const points = history.map((pt, idx) => {
    const x = (idx / (history.length - 1)) * (w - 20) + 10;
    const val = Number(pt.ssd_temp) || 0;
    const y = h - 15 - ((val - minTemp) / range) * (h - 30);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return (
    <div className="bg-slate-950/70 border border-slate-800 rounded-lg p-3">
      <div className="flex justify-between text-[11px] font-mono text-slate-400 mb-1">
        <span>HISTORIAL TÉRMICO REAL (PostgreSQL)</span>
        <span className="text-cyan-400">Últimas {history.length} muestras</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-28 overflow-visible">
        <line x1="10" y1={h - 15} x2={w - 10} y2={h - 15} stroke="#1e293b" strokeWidth="1" />
        <polyline fill="none" stroke="#22d3ee" strokeWidth="2.5" points={points} />
      </svg>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('uab_token') || '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');

  const [endpoints, setEndpoints] = useState([]);
  const [selected, setSelected] = useState(null);
  const [history, setHistory] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [tab, setTab] = useState('endpoints');
  const [filterLab, setFilterLab] = useState('TODOS');
  const [toast, setToast] = useState('');

  const authHeaders = useMemo(() => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  }), [token]);

  const selectedHostRef = useRef(null);
  useEffect(() => {
    selectedHostRef.current = selected?.hostname || null;
  }, [selected?.hostname]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    try {
      const res = await fetch(`${API_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) return setLoginError(data.error || 'Error al iniciar sesión');
      localStorage.setItem('uab_token', data.token);
      setToken(data.token);
    } catch {
      setLoginError('No se pudo conectar con el backend en :4000');
    }
  };

  const logout = () => {
    localStorage.removeItem('uab_token');
    setToken('');
    setEndpoints([]);
    setSelected(null);
  };

  const fetchAll = useCallback(async () => {
    if (!token) return;
    try {
      const [epRes, audRes] = await Promise.all([
        fetch(`${API_URL}/endpoints`, { headers: authHeaders }),
        fetch(`${API_URL}/audit`, { headers: authHeaders }),
      ]);
      if (epRes.status === 401 || audRes.status === 401) {
        localStorage.removeItem('uab_token');
        setToken('');
        setEndpoints([]);
        setSelected(null);
        return;
      }

      const data = await epRes.json();
      const audData = await audRes.json();
      setEndpoints(data);
      setAuditLogs(audData);

      let activeHost = selectedHostRef.current;
      if (!activeHost && data.length > 0) {
        activeHost = data[0].hostname;
        setSelected(data[0]);
      } else if (activeHost) {
        const updated = data.find(e => e.hostname === activeHost);
        if (updated) setSelected(updated);
      }

      if (activeHost) {
        const hRes = await fetch(`${API_URL}/history/${encodeURIComponent(activeHost)}`, { headers: authHeaders });
        if (hRes.ok) setHistory(await hRes.json());
      }
    } catch (e) {
      console.error('Error sincronizando con backend:', e);
    }
  }, [token, authHeaders]);

  useEffect(() => {
    if (!token) return;
    // oxlint-disable-next-line react/set-state-in-effect
    fetchAll();
    const id = setInterval(fetchAll, 2000);
    return () => clearInterval(id);
  }, [token, fetchAll]);

  const sendCommand = async (hostname, action) => {
    const res = await fetch(`${API_URL}/command/${encodeURIComponent(hostname)}`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ action }),
    });
    if (res.ok) {
      setToast(`Comando ${action} enviado y auditado en PostgreSQL para ${hostname}`);
      setTimeout(() => setToast(''), 3500);
      fetchAll();
    }
  };

  if (!token) {
    return (
      <div className="min-h-screen bg-[#090d16] text-slate-200 flex items-center justify-center p-4 font-sans">
        <form onSubmit={handleLogin} className="w-full max-w-sm bg-[#0f1623] border border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-2.5 border-b border-slate-800 pb-3">
            <Lock className="w-5 h-5 text-cyan-400" />
            <div>
              <h1 className="font-bold text-white">UAB <span className="text-cyan-400">AIOps</span> Console</h1>
              <p className="text-[11px] text-slate-400 font-mono">Acceso autenticado JWT</p>
            </div>
          </div>
          {loginError && <div className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded p-2">{loginError}</div>}
          <div>
            <label className="block text-xs font-mono text-slate-400 mb-1">Usuario</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-sm font-mono text-white"
            />
          </div>
          <div>
            <label className="block text-xs font-mono text-slate-400 mb-1">Contraseña</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-sm font-mono text-white"
            />
          </div>
          <button type="submit" className="w-full py-2.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-sm cursor-pointer">
            Iniciar Sesión
          </button>
        </form>
      </div>
    );
  }

  const filtered = filterLab === 'TODOS' ? endpoints : endpoints.filter(e => e.lab === filterLab);
  const liveCount = endpoints.filter(e => e.live).length;
  const isolatedCount = endpoints.filter(e => e.isolated).length;
  const driftCount = endpoints.filter(e => (e.drift_status || '').includes('Drift')).length;
  const avgDisk = endpoints.length
    ? Math.round(endpoints.reduce((acc, e) => acc + (Number(e.ssd_health) || 0), 0) / endpoints.length)
    : 0;

  return (
    <div className="min-h-screen bg-[#090d16] text-slate-200 font-sans p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4 mb-5">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-cyan-500/10 border border-cyan-500/30 rounded-lg">
            <Shield className="w-6 h-6 text-cyan-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight text-white">UAB <span className="text-cyan-400">AIOps</span></h1>
              <span className="text-xs px-2 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 font-mono">gRPC/mTLS Real</span>
              <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-mono">● PostgreSQL</span>
            </div>
            <p className="text-xs text-slate-400">Monitoreo y Autogestión · Universidad Adventista de Bolivia</p>
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs font-mono">
          <div className="px-3 py-1.5 rounded bg-slate-900 border border-slate-800">
            En línea: <span className="text-emerald-400 font-bold">{liveCount}/{endpoints.length}</span>
          </div>
          <div className="px-3 py-1.5 rounded bg-slate-900 border border-slate-800">
            Aislados: <span className="text-rose-400 font-bold">{isolatedCount}</span>
          </div>
          <button onClick={logout} className="px-3 py-1.5 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 flex items-center gap-1 cursor-pointer">
            <LogOut className="w-3.5 h-3.5" /> Salir
          </button>
        </div>
      </header>

      {toast && (
        <div className="mb-4 px-4 py-2.5 rounded-lg bg-cyan-500/15 border border-cyan-500/40 text-cyan-200 text-sm flex items-center gap-2">
          <Terminal className="w-4 h-4" /> {toast}
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-5">
        <button
          onClick={() => setTab('endpoints')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition cursor-pointer ${tab === 'endpoints' ? 'bg-cyan-500 text-slate-950 font-bold' : 'bg-slate-900 text-slate-300 border border-slate-800'}`}
        >
          Endpoints & Telemetría Real
        </button>
        <button
          onClick={() => setTab('audit')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition cursor-pointer flex items-center gap-1.5 ${tab === 'audit' ? 'bg-cyan-500 text-slate-950 font-bold' : 'bg-slate-900 text-slate-300 border border-slate-800'}`}
        >
          <History className="w-4 h-4" /> Auditoría de Comandos ({auditLogs.length})
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="bg-[#0f1623] border border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-400 uppercase font-mono">Nodos Registrados</div>
          <div className="text-3xl font-bold text-white mt-1">{endpoints.length} <span className="text-sm font-normal text-emerald-400">({liveCount} live)</span></div>
          <div className="text-xs text-slate-500 mt-1 font-mono">Sin datos simulados</div>
        </div>
        <div className="bg-[#0f1623] border border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-400 uppercase font-mono">Disco Libre Promedio</div>
          <div className="text-3xl font-bold text-emerald-400 mt-1">{avgDisk}%</div>
          <div className="text-xs text-slate-500 mt-1 font-mono">Lectura directa de discos</div>
        </div>
        <div className="bg-[#0f1623] border border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-400 uppercase font-mono">Drift Detectado</div>
          <div className="text-3xl font-bold text-amber-400 mt-1">{driftCount}</div>
          <div className="text-xs text-slate-500 mt-1 font-mono">Hash de archivo vigilado</div>
        </div>
        <div className="bg-[#0f1623] border border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-400 uppercase font-mono">Aislamiento Activo</div>
          <div className="text-3xl font-bold text-rose-400 mt-1">{isolatedCount}</div>
          <div className="text-xs text-slate-500 mt-1 font-mono">Reglas de firewall en endpoint</div>
        </div>
      </div>

      {tab === 'endpoints' ? (
        endpoints.length === 0 ? (
          <div className="bg-[#0f1623] border border-slate-800 rounded-xl p-10 text-center font-mono text-sm text-slate-400">
            Esperando conexión de algún agente Rust vía gRPC/mTLS en el puerto 50051...
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 bg-[#0f1623] border border-slate-800 rounded-xl p-4 overflow-x-auto">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                <div className="flex gap-2">
                  {['TODOS', 'LAB 1', 'LAB 2', 'LAB 3', 'ADM'].map(l => (
                    <button
                      key={l}
                      onClick={() => setFilterLab(l)}
                      className={`px-3 py-1 rounded text-xs font-mono cursor-pointer ${filterLab === l ? 'bg-cyan-500 text-slate-950 font-bold' : 'bg-slate-900 text-slate-400 border border-slate-800'}`}
                    >
                      {l}
                    </button>
                  ))}
                </div>
                <span className="text-xs font-mono text-emerald-400">● Streaming Activo</span>
              </div>

              <table className="w-full text-left text-sm">
                <thead className="text-xs text-slate-400 border-b border-slate-800 font-mono">
                  <tr>
                    <th className="py-2">HOST</th>
                    <th className="py-2">LAB / IP</th>
                    <th className="py-2">TEMP / DISCO</th>
                    <th className="py-2">AGENTE RUST</th>
                    <th className="py-2">ESTADO</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono text-xs">
                  {filtered.map(ep => (
                    <tr
                      key={ep.hostname}
                      onClick={() => setSelected(ep)}
                      className={`cursor-pointer transition hover:bg-slate-800/40 ${selected?.hostname === ep.hostname ? 'bg-cyan-500/10' : ''}`}
                    >
                      <td className="py-3 font-bold text-white flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${ep.live ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`} />
                        {ep.hostname}
                      </td>
                      <td className="py-3 text-slate-300">{ep.lab} · {ep.ip}</td>
                      <td className="py-3 text-cyan-300">{ep.ssd_temp}°C · {ep.ssd_health}% libre</td>
                      <td className="py-3 text-emerald-300">{ep.cpu_agent}% CPU · {Number(ep.ram_mb).toFixed(1)} MB</td>
                      <td className="py-3">
                        {ep.isolated ? (
                          <span className="px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/40">Aislado</span>
                        ) : (ep.drift_status || '').includes('Drift') ? (
                          <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">{ep.drift_status}</span>
                        ) : (
                          <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">Dorado OK</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {selected && (
              <div className="bg-[#0f1623] border border-slate-800 rounded-xl p-5 flex flex-col justify-between space-y-4">
                <div className="space-y-4">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                    <div>
                      <h2 className="text-lg font-bold text-white font-mono">{selected.hostname}</h2>
                      <p className="text-xs text-slate-400 font-mono">{selected.lab} · {selected.ip} · {selected.live ? 'ONLINE' : 'OFFLINE'}</p>
                    </div>
                    <Server className="w-5 h-5 text-cyan-400" />
                  </div>

                  <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-3">
                    <div className="text-xs text-slate-400 font-mono mb-2">CONSUMO REAL DEL AGENTE</div>
                    <div className="grid grid-cols-2 gap-3 font-mono">
                      <div>
                        <div className="text-xs text-slate-400 flex items-center gap-1"><Cpu className="w-3 h-3" /> CPU</div>
                        <div className="text-xl font-bold text-emerald-400">{selected.cpu_agent}%</div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-400 flex items-center gap-1"><Activity className="w-3 h-3" /> RAM</div>
                        <div className="text-xl font-bold text-cyan-400">{Number(selected.ram_mb).toFixed(1)} MB</div>
                      </div>
                    </div>
                  </div>

                  <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-3 font-mono text-xs space-y-1.5">
                    <div className="flex justify-between">
                      <span className="text-slate-400 flex items-center gap-1"><HardDrive className="w-3 h-3" /> Espacio Libre Disco</span>
                      <span className="text-emerald-400 font-bold">{selected.ssd_health}%</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Temperatura Sensor</span>
                      <span className="text-slate-200">{selected.ssd_temp}°C</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Integridad</span>
                      <span className="text-amber-300">{selected.drift_status}</span>
                    </div>
                  </div>

                  <TempChart history={history} />
                </div>

                <div className="space-y-2 pt-2">
                  <button
                    onClick={() => sendCommand(selected.hostname, 'RESYNC_GOLDEN')}
                    className="w-full py-2.5 px-4 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-sm flex items-center justify-center gap-2 transition cursor-pointer"
                  >
                    <RefreshCw className="w-4 h-4" /> Actualizar Línea Base Dorada
                  </button>
                  <button
                    onClick={() => sendCommand(selected.hostname, 'SELF_HEAL')}
                    className="w-full py-2 px-4 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium text-xs flex items-center justify-center gap-2 transition cursor-pointer"
                  >
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" /> Ejecutar Self-Healing
                  </button>
                  <button
                    onClick={() => sendCommand(selected.hostname, selected.isolated ? 'UNISOLATE' : 'ISOLATE')}
                    className={`w-full py-2.5 px-4 rounded-lg font-bold text-sm flex items-center justify-center gap-2 transition cursor-pointer border ${
                      selected.isolated
                        ? 'bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border-emerald-500/40'
                        : 'bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border-rose-500/40'
                    }`}
                  >
                    <ShieldAlert className="w-4 h-4" /> {selected.isolated ? 'Levantar Aislamiento' : 'Aislar Endpoint (Firewall)'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      ) : (
        <div className="bg-[#0f1623] border border-slate-800 rounded-xl p-4 overflow-x-auto">
          <h3 className="text-sm font-bold text-white font-mono mb-3">Registro de Auditoría (PostgreSQL · audit_logs)</h3>
          <table className="w-full text-left font-mono text-xs">
            <thead className="text-slate-400 border-b border-slate-800">
              <tr>
                <th className="py-2">FECHA / HORA</th>
                <th className="py-2">USUARIO</th>
                <th className="py-2">ENDPOINT</th>
                <th className="py-2">ACCIÓN</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {auditLogs.map(log => (
                <tr key={log.id}>
                  <td className="py-2.5 text-slate-400">{new Date(log.time).toLocaleString()}</td>
                  <td className="py-2.5 text-cyan-300">{log.admin_user}</td>
                  <td className="py-2.5 text-white font-bold">{log.hostname}</td>
                  <td className="py-2.5 text-amber-300">{log.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
