---
schema_version: 2
req_id: REQ-20261013-535895
tracking_token: TRK-20261013-113601-4906
status: Implemented
title: "Raft 本地部署和私有 GitHub 加密备份恢复"
date: 2026-10-13
canonical_owner: agents
risk: High
specs: required
design: required
---

## 背景 (Motivation)

用户需要本地使用 Raft，并通过私有 GitHub 库保存头像、聊天、附件、Agent 配置和工作文件，能够在新目录恢复。用户授权构建镜像、隔离测试以及创建 OWNER/raft-backups 私有库并上传合成测试数据。

## 方案 (Proposal)

Compose 四服务、宿主 Computer、完整数据库及文件清单、AES-256-GCM 加密和私有 Release 分片。操作见 [部署手册](../../../../../deploy/local/README.md)，稳定范围见 [[specs]]，设计见 [[design]]。

## 备选方案 (Alternatives)

不采用将聊天和二进制附件提交到 Git 的方案；全量加密快照实现更简单。RisingWave 从 PostgreSQL 重建，避免恢复失效 CDC 游标。官方云导出不是本任务的实现范围。

## 影响与兼容性 (Impact)

备份会短暂停止 API 和 Computer；恢复必须使用新目录及相同源码基线。工作目录需显式登记。恢复后 Computer 保持停止，复核绝对路径后手动启动。密钥另存，外部 URL 或未登记目录不能声称完整覆盖。

## 验证 (Verification)

独立 Review 与 Verify 均已接收且 PASS；冻结候选的六组验收共 15 项测试通过，无失败或跳过。覆盖本地配置、完整文件归档、真实 PostgreSQL、四服务应用、Computer 1.0.47 和私有 GitHub 加密往返恢复。最终证据及限制见 [[verification]]。
