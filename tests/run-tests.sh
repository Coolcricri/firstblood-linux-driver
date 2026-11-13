#!/usr/bin/env bash
# Runs the automated tests (no keyboard, no network, no Electron needed).
cd "$(dirname "$0")" && node driver_test.js && node storage_test.js && node readpath_test.js && python3 build_tools_test.py
