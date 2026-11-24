#!/usr/bin/env bash
# Emite un certificado de agente adicional firmado por la CA existente.
# Uso: ./issue-agent-cert.sh <CN> <DIRECTORIO_DESTINO>
# El CN debe coincidir con el hostname que reportará ese agente (UAB_HOST).
# Así cada equipo recibe su propio par sin regenerar toda la PKI.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CN="${1:?Uso: issue-agent-cert.sh <CN> <DIRECTORIO_DESTINO>}"
OUT="${2:?Uso: issue-agent-cert.sh <CN> <DIRECTORIO_DESTINO>}"
DAYS=825

[ -f "$DIR/ca.key" ] || { echo "Falta $DIR/ca.key (genera primero la PKI con gen-certs.sh)"; exit 1; }

mkdir -p "$OUT"
umask 077

openssl genrsa -out "$OUT/agent.key" 2048
openssl req -new -key "$OUT/agent.key" -out "$OUT/agent.csr" \
  -subj "/C=BO/ST=Cochabamba/L=Vinto/O=UAB/CN=$CN"
cat > "$OUT/agent.ext" <<EOF
subjectAltName = DNS:$CN
extendedKeyUsage = clientAuth
EOF
openssl x509 -req -in "$OUT/agent.csr" -CA "$DIR/ca.crt" -CAkey "$DIR/ca.key" \
  -CAcreateserial -out "$OUT/agent.crt" -days "$DAYS" -sha256 -extfile "$OUT/agent.ext"

cp "$DIR/ca.crt" "$OUT/ca.crt"
chmod 600 "$OUT/agent.key"
rm -f "$OUT/agent.csr" "$OUT/agent.ext" "$DIR/ca.srl"

echo "Certificado de agente emitido en $OUT (CN=$CN)"
