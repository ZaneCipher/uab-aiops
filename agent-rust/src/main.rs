use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::process::Command;
use std::time::Duration;
use sysinfo::{Components, Disks, Pid, ProcessesToUpdate, System};
use tonic::transport::{Certificate, Channel, ClientTlsConfig, Identity};

pub mod uab_aiops {
    tonic::include_proto!("uab_aiops");
}

use uab_aiops::telemetry_service_client::TelemetryServiceClient;
use uab_aiops::TelemetryData;

fn compute_file_hash(path: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    match std::fs::read(path) {
        Ok(bytes) => { bytes.hash(&mut hasher); hasher.finish() }
        Err(_) => 0,
    }
}

fn local_ip_for(server_ip: &str) -> String {
    use std::net::UdpSocket;
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| {
            socket.connect((server_ip, 50051))?;
            socket.local_addr()
        })
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|_| "0.0.0.0".to_string())
}

#[cfg(target_os = "linux")]
fn iptables(args: &[&str]) -> bool {
    Command::new("iptables")
        .arg("-w")
        .args(args)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn chain_exists(chain: &str) -> bool {
    iptables(&["-n", "-L", chain])
}

#[cfg(target_os = "linux")]
fn ensure_chain(chain: &str) {
    if chain_exists(chain) {
        iptables(&["-F", chain]);
    } else {
        iptables(&["-N", chain]);
    }
}

#[cfg(target_os = "linux")]
fn hook_chain(parent: &str, chain: &str) {
    if !iptables(&["-C", parent, "-j", chain]) {
        iptables(&["-I", parent, "1", "-j", chain]);
    }
}

#[cfg(target_os = "linux")]
fn unhook_chain(parent: &str, chain: &str) {
    if iptables(&["-C", parent, "-j", chain]) {
        iptables(&["-D", parent, "-j", chain]);
    }
    iptables(&["-F", chain]);
    iptables(&["-X", chain]);
}

#[cfg(target_os = "windows")]
fn run_powershell(script: &str) {
    match Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script])
        .output()
    {
        Ok(out) if !out.status.success() => {
            eprintln!("[FW] PowerShell devolvió error: {}", String::from_utf8_lossy(&out.stderr));
        }
        Err(e) => eprintln!("[FW] No se pudo ejecutar PowerShell: {}", e),
        _ => {}
    }
}

fn execute_firewall(action: &str, server_ip: &str) {
    #[cfg(target_os = "windows")]
    {
        let program_data = std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into());
        let state_dir = format!("{}\\UAB_AIOps", program_data);
        let state_file = format!("{}\\fw_state.txt", state_dir);

        if action == "ISOLATE" {
            let script = format!(
                "New-Item -ItemType Directory -Force -Path '{dir}' | Out-Null; \
                 if (-not (Test-Path '{state}')) {{ Get-NetFirewallProfile | ForEach-Object {{ \"$($_.Name)=$($_.DefaultInboundAction),$($_.DefaultOutboundAction)\" }} | Set-Content '{state}' }}; \
                 Get-NetFirewallProfile | Set-NetFirewallProfile -DefaultInboundAction Block -DefaultOutboundAction Block; \
                 Remove-NetFirewallRule -DisplayName 'UAB_AIOps_Allow' -ErrorAction SilentlyContinue; \
                 New-NetFirewallRule -DisplayName 'UAB_AIOps_Allow' -Direction Outbound -Action Allow -Protocol TCP -RemoteAddress '{ip}' -RemotePort 50051 | Out-Null",
                dir = state_dir, state = state_file, ip = server_ip
            );
            run_powershell(&script);
            println!(">>> [FIREWALL WINDOWS] Cuarentena aplicada. Solo gRPC hacia {} permitido.", server_ip);
        } else if action == "UNISOLATE" {
            let script = format!(
                "if (Test-Path '{state}') {{ Get-Content '{state}' | ForEach-Object {{ $p,$a = $_ -split '='; $i,$o = $a -split ','; Set-NetFirewallProfile -Name $p -DefaultInboundAction $i -DefaultOutboundAction $o }}; Remove-Item '{state}' }}; \
                 Remove-NetFirewallRule -DisplayName 'UAB_AIOps_Allow' -ErrorAction SilentlyContinue",
                state = state_file
            );
            run_powershell(&script);
            println!(">>> [FIREWALL WINDOWS] Cuarentena levantada (perfiles restaurados).");
        }
    }
    #[cfg(target_os = "linux")]
    {
        if action == "ISOLATE" {
            ensure_chain("UAB_AIOPS_OUT");
            ensure_chain("UAB_AIOPS_IN");
            iptables(&["-A", "UAB_AIOPS_OUT", "-o", "lo", "-j", "ACCEPT"]);
            iptables(&["-A", "UAB_AIOPS_OUT", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"]);
            iptables(&["-A", "UAB_AIOPS_OUT", "-d", server_ip, "-p", "tcp", "--dport", "50051", "-j", "ACCEPT"]);
            iptables(&["-A", "UAB_AIOPS_OUT", "-j", "DROP"]);
            iptables(&["-A", "UAB_AIOPS_IN", "-i", "lo", "-j", "ACCEPT"]);
            iptables(&["-A", "UAB_AIOPS_IN", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"]);
            iptables(&["-A", "UAB_AIOPS_IN", "-j", "DROP"]);
            if chain_exists("UAB_AIOPS_OUT") {
                hook_chain("OUTPUT", "UAB_AIOPS_OUT");
                hook_chain("INPUT", "UAB_AIOPS_IN");
                println!(">>> [FIREWALL LINUX] Cuarentena aplicada (cadenas UAB_AIOPS_*).");
            } else {
                eprintln!(">>> [FIREWALL LINUX] No se pudo aplicar la cuarentena (¿root o iptables ausente?).");
            }
        } else if action == "UNISOLATE" {
            unhook_chain("OUTPUT", "UAB_AIOPS_OUT");
            unhook_chain("INPUT", "UAB_AIOPS_IN");
            println!(">>> [FIREWALL LINUX] Cuarentena levantada (solo cadenas UAB_AIOPS_*).");
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let server_ip = std::env::var("UAB_SERVER").unwrap_or_else(|_| "127.0.0.1".into());
    let hostname = std::env::var("UAB_HOST").unwrap_or_else(|_| System::host_name().unwrap_or_else(|| "PC-REAL".into()));
    let lab = std::env::var("UAB_LAB").unwrap_or_else(|_| "LAB 1".into());
    let cert_dir = std::env::var("UAB_CERTS").unwrap_or_else(|_| "../certs".into());
    let tls_domain = std::env::var("UAB_TLS_DOMAIN").unwrap_or_else(|_| "localhost".into());

    let ca_cert = std::fs::read(format!("{}/ca.crt", cert_dir))?;
    let client_cert = std::fs::read(format!("{}/agent.crt", cert_dir))?;
    let client_key = std::fs::read(format!("{}/agent.key", cert_dir))?;

    let tls = ClientTlsConfig::new()
        .domain_name(tls_domain.clone())
        .ca_certificate(Certificate::from_pem(ca_cert))
        .identity(Identity::from_pem(client_cert, client_key));

    let endpoint = format!("https://{}:50051", server_ip);
    let channel = Channel::from_shared(endpoint.clone())?.tls_config(tls)?.connect().await?;
    let mut client = TelemetryServiceClient::new(channel);

    let local_ip = local_ip_for(&server_ip);

    let mut sys = System::new_all();
    let mut components = Components::new_with_refreshed_list();
    let mut disks = Disks::new_with_refreshed_list();
    let pid = Pid::from_u32(std::process::id());

    sys.refresh_processes(ProcessesToUpdate::Some(&[pid]));
    std::thread::sleep(Duration::from_millis(500));
    sys.refresh_processes(ProcessesToUpdate::Some(&[pid]));

    // Archivo crítico vigilado para Drift real
    #[cfg(target_os = "windows")]
    let watch_file = r"C:\Windows\System32\drivers\etc\hosts";
    #[cfg(not(target_os = "windows"))]
    let watch_file = "/etc/hosts";

    let mut golden_hash = compute_file_hash(watch_file);
    println!("[Agente Real Rust v2.0] {} conectado a {} | Hash Dorado ({}): {:x}", hostname, endpoint, watch_file, golden_hash);

    loop {
        sys.refresh_processes(ProcessesToUpdate::Some(&[pid]));
        components.refresh();
        disks.refresh();

        let (cpu_usage, ram_mb) = if let Some(proc) = sys.process(pid) {
            (proc.cpu_usage(), (proc.memory() as f32) / 1024.0 / 1024.0)
        } else {
            (0.0, 0.0)
        };

        // Temperatura real del primer sensor térmico disponible
        let real_temp = components.iter()
            .map(|c| c.temperature())
            .next()
            .unwrap_or(0.0) as i32;

        // Salud/Capacidad libre real del disco principal (%)
        let real_disk_free_pct = disks.iter().next().map(|d| {
            if d.total_space() > 0 {
                ((d.available_space() as f64 / d.total_space() as f64) * 100.0) as i32
            } else { 0 }
        }).unwrap_or(0);

        // Verificación real de Drift
        let current_hash = compute_file_hash(watch_file);
        let drift_status = if current_hash == golden_hash {
            "Dorado OK".to_string()
        } else {
            format!("Drift detectado en {}", watch_file)
        };

        let request = tonic::Request::new(TelemetryData {
            hostname: hostname.clone(),
            lab: lab.clone(),
            ip: local_ip.clone(),
            cpu_agent: (cpu_usage * 100.0).round() / 100.0,
            ram_mb: (ram_mb * 10.0).round() / 10.0,
            ssd_health: real_disk_free_pct,
            ssd_temp: real_temp,
            whea_errors: 0,
            drift_status: drift_status.clone(),
        });

        match client.stream_telemetry(request).await {
            Ok(resp) => {
                let cmd = resp.into_inner();
                match cmd.action.as_str() {
                    "ISOLATE" | "UNISOLATE" => execute_firewall(&cmd.action, &server_ip),
                    "RESYNC_GOLDEN" | "SELF_HEAL" => {
                        golden_hash = compute_file_hash(watch_file);
                        println!(">>> [SELF-HEALING] Nueva línea base dorada fijada: {:x}", golden_hash);
                    }
                    _ => println!("[Real] {} | CPU: {:.2}% | RAM: {:.1} MB | Temp: {}°C | Disco Libre: {}% | {}", hostname, cpu_usage, ram_mb, real_temp, real_disk_free_pct, drift_status),
                }
            }
            Err(e) => eprintln!("[Error gRPC] {}", e),
        }

        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}
