#!/usr/bin/env bash
CLIENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$CLIENT_DIR"
"$CLIENT_DIR/.venv/bin/python" -m mac_client.apply
