#!/usr/bin/env bash
set -euo pipefail
npm run deploy-base
npm run migrate-data-tables
npm run map
npm run patch-flows
npm run deploy-flows
npm run map
npm run migrate-users
npm run map
npm run migrate-qc
npm run optional-services
