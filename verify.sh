#!/usr/bin/env bash
set -eu

npm run clean
npm run verify
npm pack --dry-run
