#!/bin/bash
exec "/usr/sbin/node" "/home/wegerer/.pi/agent/extensions/pi-annotate/chrome-extension/native/host.cjs" "$@"
