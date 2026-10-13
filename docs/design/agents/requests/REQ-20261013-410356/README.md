---
schema_version: 2
req_id: REQ-20261013-410356
tracking_token: TRK-20261013-134420-0355
status: Implemented
title: "Raft 本地一键启动、重启和日常操作入口"
date: 2026-10-13
canonical_owner: agents
risk: Medium
specs: required
design: required
---

## 背景 (Motivation)

用户已启用本地 Raft 和每日私有备份，需要项目内的一键脚本，方便后续重启。现有低层命令要求手动填写数据目录和工具路径，GUI 终端还可能使用低于项目要求的 Node。

## 方案 (Proposal)

项目根提供 raft-local 及 macOS 双击 start-raft.command、restart-raft.command。复用既有 local.mjs、Computer 和 schedule，不重新实现部署或备份。范围与设计见 [[specs]]、[[design]]。

## 备选方案 (Alternatives)

保留低层命令用于首次部署与显式恢复。没有新增桌面应用或安装依赖；用户已有配置是运行事实来源。

## 影响与兼容性 (Impact)

默认 ~/raft-local，允许显式 state。停止与重启保留 Computer 原 managed 集合，API/RW 就绪后再恢复。恢复实例 disabled Computer 保持停止。使用备份锁互斥，不改变用户数据、密钥或每日定时配置。connect 必须显式指向本地地址和隔离 home。

## 验证 (Verification)

独立Review/Verify均已接收且PASS；冻结版本的控制入口9项、既有回归11项、真实生命周期1项全部通过，无跳过。三个可执行启动器的Shell语法和权限检查通过，正式实例只读status正常。最终记录见 [[verification]]。
