---
schema_version: 2
req_id: REQ-20261013-879071
tracking_token: TRK-20261013-145032-0632
status: Implemented
title: "Raft 本地 Redis、scope 签名和 Computer 持续在线恢复"
date: 2026-10-13
canonical_owner: agents
risk: High
specs: required
design: required
---

## 背景 (Motivation)

用户要求补齐 Redis 和 SCOPE_ATTESTATION_SECRET，Computer 持续在线，并纳入一键操作、每日私有备份和恢复。原部署缺 Redis 导致 replica_registration_failed；缺 scope 密钥使 HTTP scope-attestation 返回503。此前仅瞬时在线的检查不足以证明稳定连接。

## 方案 (Proposal)

增加内部 Redis 7 和持久 RDB，自动补缺失配置并保留已有签名密钥。归档完整 RDB、server.env 和既有数据库/文件；恢复在 Redis 启动前核验并装入快照。沿用原一键入口和每日任务。详见 [[specs]]、[[design]]。

## 备选方案 (Alternatives)

外部 Redis 增加部署和完整备份边界，本单机方案拒绝该覆盖。RDB 作为唯一恢复来源，避免多份 AOF 与 RDB 的加载优先级歧义。不增加容灾、增量同步或极端冲突处理。

## 影响与兼容性 (Impact)

保持本地隔离 Computer home、账号和原应用密钥。旧快照缺 Redis/scope 配置时明确标记缺失并按新配置启动，不声称不存在的数据已恢复。首次升级正式 Redis 时先 SAVE、正常停止，再以 RDB 启动，旧 AOF 保留。所有同步使用配置的私有备份库的加密 Release assets。

## 验证 (Verification)

配置/失败清理单元验证、真实 PG+Redis 和完整应用恢复、真实 Computer scope HTTP/worker 验签，以及首次启动、重启、备份和恢复后各120秒观察。正式本地工作区 另执行只读连续观察。独立 Review/Verify 均已接收且 PASS；八项冻结验收通过，正式私有快照下载和数据恢复验证成功。记录见 [[verification]]。
