---
tags: [raft, local-deployment, backup, recovery]
updated_at: 2026-10-13T17:38:45+08:00
---

# 本地部署与私有 GitHub 备份

适用于此分支的单机 Raft：Web、API、PostgreSQL 16、Redis 7、RisingWave 和宿主机 Computer。Web 默认仅监听 `http://localhost:8080`。联合频道保留同一部署内的完整数据库关联；不提供跨独立实例联邦。

这不是官方云账号导入器。只有已经进入此本地实例、并在清单内的文件才会备份；官方云端的数据库、附件和凭据仍需先获得导出。外部头像链接和 S3 配置会让完整备份失败，不能把保存 URL 当作已保存图片。

## 覆盖范围

| 内容 | 备份位置 |
| --- | --- |
| 聊天、频道、联合频道、成员、Agent 配置、任务、迁移记录 | 完整 `pg_dump`，包含原 ID、序列、所有权和 ACL |
| PostgreSQL 角色与权限 | `pg_dumpall --roles-only`，随归档加密 |
| 本地上传的用户/Agent 头像、聊天附件和公开内容 | 整个 `uploads`，不限扩展名 |
| Redis 数据 | 停写后 `SAVE` 的完整 `dump.rdb`，独立校验并在 Redis 启动前装入 |
| JWT、MCP/provider 加密密钥、数据库密码、SCOPE_ATTESTATION_SECRET 等 | 原始 `server.env`，随归档加密 |
| Computer 登录、绑定、Agent MEMORY/notes/工作目录 | 指定的 `computer.home`（RAFT_HOME） |
| 外置工作目录、runtime home、未提交文件、隐藏文件、SQLite | `extraRoots` 逐项登记，整目录保存 |
| Agent 的外部技能软链接及已登记目标目录 | 链接与技能文件同时归档；恢复时指向 external 下的技能副本 |
| 文件校验、原路径、源码版本、恢复工具副本 | 加密归档内的 `manifest.json` 和 `deployment` |
| RW 的 Activity、未读数和关注线程派生表 | 从完整 PG 数据重新生成，不复用旧 CDC offset |

只排除 `RAFT_HOME/computer/run` 的临时进程标记/IPC；清单记录排除项。不会按 Git ignore 排除工作文件。未登记的外部软链接及 Git worktree 元数据会报错，避免隐性丢失。外部链接目标应登记到 extraRoots：归档将链接转换为包内安全的相对引用，并记录原目标；恢复按 external/<name> 的新落点重绑，指向备份中的副本。`.git` 指针文本中的绝对路径仍需按恢复清单复核。外置 SQLite 的使用方和编辑器应在备份窗口内停止写入。

不包含内存中的任务执行现场、操作系统钥匙串、未登记目录、仍由第三方托管的文件。vendor 登录是否仍有效取决于服务方；保存凭据不能保证其永不过期。

## 日常一键操作

已初始化的实例使用项目根的统一入口，默认读取 `~/raft-local`：

```sh
./raft-local                 # 启动，与 start 相同
./raft-local restart         # 重启服务，恢复原先运行的 Computer 工作区
./raft-local stop            # 停止 Computer 和五个服务，保留数据
./raft-local status          # 查看容器、网页地址、数据目录和备份库
./raft-local logs            # 查看最近 100 行 API 日志（含本机验证邮件）
./raft-local connect /workspace-slug  # 启动服务并连接指定本地工作区
./raft-local backup          # 立即加密备份并上传已配置的私有库
```

macOS 可在 Finder 双击项目根的 `start-raft.command` 启动，或 `restart-raft.command` 重启。脚本会选择可用的 Node 24+（支持当前 PATH 和已安装 NVM），使用已有 Python/Computer 工具路径。先打开 Docker Desktop；脚本不安装或升级依赖，也不重新初始化数据或密钥。

自定义实例用 `--state /绝对路径/数据目录` 或环境变量 `RAFT_LOCAL_STATE`。`backup` 默认使用 `~/raft-backup.key` 和 `~/raft-snapshots`，其他实例应明确传入 `--key` 和 `--snapshots`。Node 可用 `RAFT_NODE` 指定；Docker、Python、gh 继续使用已有 `RAFT_DOCKER`、`RAFT_PYTHON`、`RAFT_GH` 约定。

`--state` 的相对路径按调用命令的目录解析。

`connect` 始终使用当前 config 的 `http://localhost:<port>` 和隔离 Computer home；在浏览器完成授权后连接该工作区。恢复后 Computer 为 disabled 时，需按恢复步骤复核路径并启用配置，入口才允许连接。

显式 `stop` 原子保存版本化的原 Computer managed 集合到私有 `computer-resume.json`，下次 `start` 等 API/RW 就绪后恢复这个集合。重复 stop 保留原集合；启动失败保留待恢复文件，供修复后再次 start。Computer 原本已停止时，restart 只启动应用，不消费旧待恢复记录；成功 connect 会清除旧记录。新恢复实例的 disabled Computer 不会自动启动。生命周期核对 managed IDs 与实际 daemon 运行集合一致，并确认恢复后的集合；不一致时退出，需先检查 Computer。启动/停止/重启/连接使用现有 `.backup-lock`，遇到备份或另一个操作占用时退出，等其完成后再执行。

`stop` 保留每日 launchd 配置，服务停止期间定时备份不能执行。`logs` 中的验证链接和用户信息仅供本机查看。首次部署仍使用下面的 init/build 流程；恢复继续使用 backup.mjs 的明确新目录流程。

## Computer 在线所需配置

启动入口自动补齐 `REDIS_URL=redis://redis:6379` 和 32 字节随机生成的 `SCOPE_ATTESTATION_SECRET`，写入本机私有 `server.env`。已有非空密钥保持原值（支持 Compose 等号/冒号分隔、空格和引号）；有冲突的重复配置会报错，不自行选择或轮换密钥。备份时原文件随数据加密，恢复沿用原密钥。

Redis 仅在 Compose 内网开放，使用持久目录 `redis/`、固定 Redis 7 镜像和 RDB 配置（每分钟有变更时保存，备份窗口显式 SAVE）。API 等 Redis/PG 健康后启动。Computer 服务使用自身守护机制恢复 runner；Docker 服务使用 unless-stopped。机器关机、睡眠或 Docker 未运行期间不能保证在线。

旧四服务备份没有 Redis 数据和 scope 密钥，恢复清单会明确记录 `legacy-no-redis-fresh-instance`；启动创建新 Redis 并仅补缺少的配置，不声称恢复了旧快照中不存在的数据。首次升级已运行的 AOF Redis 时，应先 SAVE 并正常停止 Redis，再重启以读取 RDB，旧文件保留供核对。

持续在线验证（只读，需 Computer 已登录并运行）：

```sh
node scripts/local/online.mjs "$HOME/raft-local" /workspace-slug 120
```

首次数据库心跳出现后才开始计时，连续至少两分钟检查本机/服务端在线、进程版本、managed 集合、连接标记、Redis owner/generation/TTL 和数据库心跳至少推进三次。观察窗口内任何断开、重连或采样超时都失败。检查直接读取绑定机器的 PG/Redis 证据，不依赖浏览器 access token 的有效期。

## 准备与启动

Docker Desktop 建议分配至少 8 GiB 内存，RW 使用其单节点默认内存配置。需要 Node 24+、Python 3.12+（仅标准库，用于文件清单与安全 tar 解包）、Docker Compose、已登录的 `gh`。无需宿主 PostgreSQL、age 或 npm 加密依赖。Computer 使用与源码匹配的 `raft-computer`，当前为 1.0.47。

以下命令从仓库根执行；示例路径均可改为自己的绝对路径。状态、密钥、快照分别放置，不放进源码库。

```sh
# macOS Docker Desktop 未在 PATH 时
export RAFT_DOCKER=/Applications/Docker.app/Contents/Resources/bin/docker

node scripts/local/local.mjs init "$HOME/raft-local" 8080
node scripts/local/local.mjs build "$HOME/raft-local"
node scripts/local/local.mjs up "$HOME/raft-local"
```

访问 `http://localhost:8080`，正常注册、验证邮箱、完成个人资料并创建工作区。没有配置邮件供应商时，上游会将测试邮件内容写入 API 日志；在本机查看验证码/链接，勿公开日志。`up` 先执行原部署迁移，再初始化 RW，最后启动 API/Web。重复启动不会清空 PG、uploads 或完整 RW catalog。不要使用开发工具 `raftdev stop` 管理此实例。

连接 Computer 时显式使用同一个 home 和本地 URL：

```sh
export RAFT_HOME="$HOME/raft-local/raft"
raft-computer setup <工作区slug> --server-url http://localhost:8080
raft-computer status --json
```

随后编辑 `raft-local/config.json`：

```json
{
  "computer": {
    "enabled": true,
    "executable": "/绝对路径/raft-computer",
    "home": "/绝对路径/raft-local/raft"
  },
  "extraRoots": [
    { "name": "agent-code", "path": "/绝对路径/实际工作目录" },
    { "name": "runtime-home", "path": "/绝对路径/该Agent使用的runtime配置目录" }
  ],
  "backupRepo": "OWNER/raft-backups",
  "coverageReviewed": true
}
```

这是字段示例，不要覆盖初始化生成的 `version/project/port/sourceRevision`。`coverageReviewed=true` 表示你已经核对所有外置目录，不会自动扫描整个用户 HOME。每个登记目录必须存在，不得互相嵌套。Agent 实际引用的外部技能目录也须逐项登记；备份不扫描整个工作区或用户 HOME。Computer 关闭时其 home 必须为空，否则备份拒绝继续，防止漏停 Agent。

## 私有仓库与第一次备份

使用独立的**私有**备份库，不能使用公开源码 fork。在 config.json 的 backupRepo 中填写自己的私有仓库名称；已存在的仓库无需重复创建。首次使用可创建带初始 README 的仓库：

```sh
gh repo create OWNER/raft-backups --private --add-readme
node scripts/local/backup.mjs keygen "$HOME/raft-backup.key"
node scripts/local/backup.mjs create "$HOME/raft-local" "$HOME/raft-backup.key" "$HOME/raft-snapshot-first"
node scripts/local/backup.mjs publish "$HOME/raft-snapshot-first" OWNER/raft-backups
```

务必另存一份 `raft-backup.key` 到离线安全位置。密钥不进入备份；丢失后仅凭 GitHub 无法恢复。不要把密钥放在任何备份根内。

备份先确认 Redis 在线与目录覆盖，停止 Computer 原 managed 集合及 API，保留 PG 运行。导出数据库后对 Redis 执行 SAVE，停止 Redis 并复制 dump.rdb，再归档文件。按 Redis → API → 原 Computer 集合恢复运行；失败也尝试恢复服务，Computer 待恢复记录保留供一键 start 使用。加密和上传在服务恢复后执行。采用随机 nonce 的 AES-256-GCM，头部一并认证，再分为最多 1 GiB 的块。私有仓库检查在创建和发布 Release 前分别执行。

含 Redis 或转换链接的新归档使用内层格式 2，旧恢复工具会明确拒绝；当前工具兼容旧格式 1。外层加密与分片格式保持。

GitHub 保存的是**加密 Release assets**，不把聊天和附件提交进 Git 历史。普通 `git clone` 不下载这些附件。所有块上传并核对长度后才发布 Release；失败留在 draft，不覆盖、不删除历史快照。每份都是完整快照。

## 自动备份

先确认一次本地恢复，再配置 `backupRepo`。下面生成每日一次的 macOS launchd 配置，默认不启用：

```sh
node scripts/local/schedule.mjs render "$HOME/raft-local" "$HOME/raft-backup.key" "$HOME/raft-snapshots" "$HOME/local.raft.backup.plist"
# 查看生成的绝对路径、PATH 和私有库配置后，再手动启用
launchctl bootstrap "gui/$(id -u)" "$HOME/local.raft.backup.plist"
```

Linux 可将 `node /绝对路径/raft-source/scripts/local/schedule.mjs run STATE KEY OUTPUT_BASE` 加入用户自己的定时任务；使用可找到 docker、python3、gh 的 PATH。机器睡眠/关机时不会实时同步；恢复点是最后一次完整发布的快照。查看状态目录下的 `backup.log`。没有自动保留期清理。

## 恢复到新目录

`source-version.json` 固定此部署方案的上游源码基线；升级上游时须同时更新此文件并重新验收，不用于跨版本恢复。使用快照记录的同一源码版本、PostgreSQL 16和相同 API 地址。先停止旧实例，避免端口冲突和两个 Computer 同时执行任务。准备好独立密钥：

```sh
node scripts/local/local.mjs stop "$HOME/raft-local"
node scripts/local/backup.mjs download OWNER/raft-backups backup-具体时间与随机后缀 "$HOME/downloaded-snapshot"
node scripts/local/backup.mjs restore "$HOME/downloaded-snapshot" "$HOME/raft-backup.key" "$HOME/raft-recovered"
```

下载目录和恢复目录必须尚不存在。恢复按顺序校验分片、认证解密、检查归档路径与文件哈希，检查 Redis RDB 格式并装入新目录，再启动独立空 PG/Redis、恢复角色与数据库、重建 RW、启动 Web/API。不会把 dump 导入已有数据库，也不先执行迁移/seed。

恢复后的目录：

- `uploads/`：头像与附件原始字节。
- `raft/`：Computer 和 Agent 持久数据。
- `external/<name>/`：登记的外置目录。
- `server.env`：原应用密钥，含 scope 签名密钥，保持已加密配置可解密。
- `redis/dump.rdb`：Redis 完整快照；恢复使用 RDB，不会被旧 AOF 文件覆盖。
- `restore-inventory.json`：原目录、文件哈希及原 Computer 运行集合。
- `recovery/`：数据库原件及当时的工具副本，权限受限，勿加入 Git。

Computer 默认保持停止，避免恢复时自动执行任务。核对 `restore-inventory.json` 的原路径；运行时配置和 `.git` 指针中的绝对路径不会盲目改写。将外置数据放回原路径，或明确调整 Agent 工作路径及运行时配置；确认 executable、home 和 coverage 后，再启动原先需要运行的工作区：

```sh
export RAFT_HOME="$HOME/raft-recovered/raft"
raft-computer start <原先运行的工作区slug>
```

不要无参数启动全部已绑定工作区。若进程被强行终止导致 `.backup-lock` 残留，先确认没有备份和写入进程，再手动处理该锁；工具不会猜测和删除锁。

## 验证

```sh
node --test scripts/local/local.test.mjs scripts/local/backup.test.mjs scripts/local/redis.test.mjs scripts/local/online.test.mjs
RAFT_DOCKER=/Applications/Docker.app/Contents/Resources/bin/docker node --test scripts/local/backup.postgres.test.mjs
```

完整应用、真实 Computer 和远端私有库往返分别由 `backup.container.test.mjs`、`backup.computer.test.mjs`、`backup.github.test.mjs` 覆盖。它们需要各自的真实环境；缺配置会明确失败，不以跳过代替通过。测试只允许使用隔离状态目录、合成账号和独立测试库。
