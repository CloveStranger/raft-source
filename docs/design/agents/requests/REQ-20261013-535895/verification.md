---
tags: [raft, deployment, backup]
updated_at: 2026-10-13T17:38:45+08:00
---

# 验证证据与限制

2026-10-13 开发阶段测试：本地单元/归档 10/10；真实 PostgreSQL 1/1；完整应用 1/1；Computer 1.0.47 1/1；GitHub 私有库加密往返 1/1。使用新建的隔离状态目录和合成账号，未上传真实用户数据。

已构建镜像：Server sha256:7b00cfa9be19f57d8820ea36e45fba45bda565896b48e2ee6894b7e54180d6d2；Web sha256:6eafb2588433149885b3b5bb2ae8d6d6113c19bb60d64429129fa06c25c51f8c。最终验收使用这两个已构建镜像、Docker Desktop、Python3.12、Node24、已登录 gh 和本机 Computer。所有必要源依赖随候选冻结；不会在评审中重新安装依赖。

最终候选 `raft-local-backup-candidate-2` 的独立 Review/Verify 均已接收且 PASS，控制器 completion_claim_allowed=true。LOCAL 5/5、FILES 6/6、PG 1/1、APP 1/1、COMPUTER 1/1、GITHUB 1/1；六组退出码均0，stderr为空，无跳过。目录扫描错误回归与备份前独立头像/附件预期均通过。

冻结摘要：`1431930a46af1375ca45a3f440c437fb4ab0d2b1dee1aea6a7d8aeb44350ba9e`。独立评审与验证的运行标识保留在本机证据中。原始捕获由本机治理任务保留，正式文档仅转写结果；本次收尾只回填登记状态与证据摘要，未修改受检实现。用于验收的私有备份库已确认 Private，正式验收生成并恢复了合成数据的加密 Release；具体编号保留在本机证据中。中央演进状态为 REGISTRATION_PENDING，尚未发布中央。

没有官方云数据导入、跨版本恢复或 UI 人工操作证据；应用验证通过 HTTP 与真实 WebSocket。launchd 仅生成配置，未启用个人自动备份。真实用户目录须完成 coverageReviewed 清单复核。密钥不上传。

相关：[[README]]、[[specs]]、[[design]]。
