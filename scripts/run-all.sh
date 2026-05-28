#!/usr/bin/env bash
set -euo pipefail
bash scripts/run-discovery.sh
bash scripts/run-deploy.sh
bash scripts/run-validate.sh
