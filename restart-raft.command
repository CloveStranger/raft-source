#!/bin/bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$project_root/raft-local" restart "$@"
if [[ -t 0 ]]; then
  read -r -p 'Raft 已重启，按回车关闭此窗口。' _raft_input
fi
