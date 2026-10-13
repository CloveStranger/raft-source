---
tags: [raft, local-control, lifecycle]
updated_at: 2026-10-13T13:59:16+08:00
---

# 用户行为与验收

- ENTRY：无参默认start，支持start/restart/stop/status/logs/connect SLUG/backup；默认当前用户既有状态目录，可传 --state。
- LIFECYCLE：restart恢复原Computer集合；stop后start同样恢复；重复stop不丢集合；启动失败不消费待恢复记录；恢复disabled不自动执行Agent。
- ISOLATION：操作与备份使用同一锁；connect使用当前port、本地origin和配置的隔离home，不连接官方云。
- LAUNCHER：从任意cwd及带空格的项目路径执行，参数保持原样。Node24+来自PATH或已安装NVM，显式RAFT_NODE不满足版本时报错。Mac提供双击启动/重启入口。
- DATA：真实Docker隔离实例通过入口重启、stop及无参start后，原账号登录、消息整行、Agent、头像附件字节和原应用密钥均保留。

不修改个人服务用于测试；不自动安装/升级Docker、Node或Computer；Docker Desktop须先运行。CLI及bash入口可验证，不将Finder人工点击包装为已观察证据。相关：[[README]]、[[design]]、[[verification]]。
