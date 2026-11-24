#!/usr/bin/env bash
# Genera una PKI limpia para UAB-AIOps: CA, certificado de servidor y de agente.
# Uso: ./gen-certs.sh [AGENT_CN] [SERVER_IP_EXTRA]
#   AGENT_CN         Nombre (CN) del certificado de agente. Debe coincidir con el
#                    hostname que reporta el agente (UAB_HOST).
#   SERVER_IP_EXTRA  IP adicional a incluir en el SAN del servidor.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_CN="${1:-agent-01}"
SERVER_IP_EXTRA="${2:-}"
DAYS=825

cd "$DIR"
umask 077

rm -f ca.key ca.crt ca.srl server.key server.crt server.csr server.ext \
      agent.key agent.crt agent.csr agent.ext ca.cnf

openssl genrsa -out ca.key 4096
openssl req -x509 -new -nodes -key ca.key -sha256 -days "$DAYS" -out ca.crt \
  -subj "/C=BO/ST=Cochabamba/L=Vinto/O=UAB/OU=Sistemas/CN=UAB-AIOps-CA"

SAN="DNS:localhost, IP:127.0.0.1"
if [ -n "$SERVER_IP_EXTRA" ]; then
  SAN="$SAN, IP:$SERVER_IP_EXTRA"
fi

openssl genrsa -out server.key 2048
openssl req -new -key server.key -out server.csr \
  -subj "/C=BO/ST=Cochabamba/L=Vinto/O=UAB/CN=localhost"
cat > server.ext <<EOF
subjectAltName = $SAN
extendedKeyUsage = serverAuth
EOF
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days "$DAYS" -sha256 -extfile server.ext

openssl genrsa -out agent.key 2048
openssl req -new -key agent.key -out agent.csr \
  -subj "/C=BO/ST=Cochabamba/L=Vinto/O=UAB/CN=$AGENT_CN"
cat > agent.ext <<EOF
subjectAltName = DNS:$AGENT_CN
extendedKeyUsage = clientAuth
EOF
openssl x509 -req -in agent.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out agent.crt -days "$DAYS" -sha256 -extfile agent.ext

chmod 600 ./*.key
rm -f server.csr server.ext agent.csr agent.ext ca.srl

echo "PKI generada en $DIR"
echo "  CA:     ca.crt"
echo "  Server: server.crt (CN=localhost, SAN=$SAN)"
echo "  Agente: agent.crt (CN=$AGENT_CN)"
