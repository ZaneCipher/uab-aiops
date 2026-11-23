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

fn execute_firewall(action: &str, server_ip: &str) {
    #[cfg(target_os = "windows")]
    {
        if action == "ISOLATE" {
            let _ = Command::new("netsh").args(["advfirewall", "set", "allprofiles", "firewallpolicy", "blockinbound,blockoutbound"]).output();
            let _ = Command::new("netsh").args(["advfirewall", "firewall", "add", "rule", "name=UAB_AIOps_Allow", "dir=out", "action=allow", "protocol=TCP", &format!("remoteip={}", server_ip), "remoteport=50051"]).output();
            println!(">>> [FIREWALL WINDOWS] Cuarentena aplicada. Solo tráfico gRPC hacia {} permitido.", server_ip);
        } else if action == "UNISOLATE" {
            let _ = Command::new("netsh").args(["advfirewall", "set", "allprofiles", "firewallpolicy", "blockinbound,allowoutbound"]).output();
            let _ = Command::new("netsh").args(["advfirewall", "firewall", "delete", "rule", "name=UAB_AIOps_Allow"]).output();
            println!(">>> [FIREWALL WINDOWS] Cuarentena levantada.");
        }
    }
    #[cfg(target_os = "linux")]
    {
        if action == "ISOLATE" {
            let _ = Command::new("iptables").args(["-A", "OUTPUT", "-d", server_ip, "-p", "tcp", "--dport", "50051", "-j", "ACCEPT"]).output();
            let _ = Command::new("iptables").args(["-A", "OUTPUT", "-d", "127.0.0.1", "-j", "ACCEPT"]).output();
            let _ = Command::new("iptables").args(["-P", "OUTPUT", "DROP"]).output();
            println!(">>> [FIREWALL LINUX] Cuarentena aplicada (requiere root para aplicar reglas iptables).");
        } else if action == "UNISOLATE" {
            let _ = Command::new("iptables").args(["-P", "OUTPUT", "ACCEPT"]).output();
            let _ = Command::new("iptables").args(["-F", "OUTPUT"]).output();
            println!(">>> [FIREWALL LINUX] Cuarentena levantada.");
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let server_ip = std::env::var("UAB_SERVER").unwrap_or_else(|_| "127.0.0.1".into());
    let hostname = std::env::var("UAB_HOST").unwrap_or_else(|_| System::host_name().unwrap_or_else(|| "PC-REAL".into()));
    let lab = std::env::var("UAB_LAB").unwrap_or_else(|_| "LAB 1".into());
    let cert_dir = std::env::var("UAB_CERTS").unwrap_or_else(|_| "../certs".into());

    let ca_cert = std::fs::read(format!("{}/ca.crt", cert_dir))?;
    let client_cert = std::fs::read(format!("{}/agent.crt", cert_dir))?;
    let client_key = std::fs::read(format!("{}/agent.key", cert_dir))?;

    let tls = ClientTlsConfig::new()
        .domain_name("localhost")
        .ca_certificate(Certificate::from_pem(ca_cert))
        .identity(Identity::from_pem(client_cert, client_key));

    let endpoint = format!("https://{}:50051", server_ip);
    let channel = Channel::from_shared(endpoint.clone())?.tls_config(tls)?.connect().await?;
    let mut client = TelemetryServiceClient::new(channel);

    let mut sys = System::new_all();
    let mut components = Components::new_with_refreshed_list();
    let mut disks = Disks::new_with_refreshed_list();
    let pid = Pid::from_u32(std::process::id());

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
            ip: server_ip.clone(),
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
