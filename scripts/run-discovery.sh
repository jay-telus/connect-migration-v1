#!/usr/bin/env bash
set -euo pipefail
npm run validate-profiles
npm run discover
npm run generate-cfn
