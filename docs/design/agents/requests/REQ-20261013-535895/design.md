---
tags: [raft, deployment, backup]
updated_at: 2026-10-13T12:40:00+08:00
---

# 设计交接

入口为 scripts/local/local.mjs、backup.mjs、schedule.mjs。Compose 使用上游 Server/Web Dockerfile，PG16 与固定 RW 镜像；仅 Web 监听 localhost。RW 复用上游纯 SQL 构建器和原 SQL 依赖。

备份保存全部数据库、角色、uploads、Computer home、显式 extraRoots、server.env 和恢复工具。覆盖检查通过后停止 Computer 与 API；导出数据库并制作哈希清单归档，恢复原运行集合后再加密及上传。Python3.12 标准库处理 tar 路径/链接；Node 内置 AES-256-GCM 认证头和内容，随机 nonce，密钥独立保存。每块最多1GiB；Release 先 draft，资产齐全后发布，上传前后确认私有，不覆盖或清理历史。

恢复先校验、解密、逐文件验证，再复制到不存在的目标，恢复角色和空 PG，重建 RW。Computer 的路径不自动改写，也不自动启动。外部 SQLite/编辑器等写入由使用者暂停。源码基线 source-version.json 是同版本恢复约束，升级需重新验证。

真实 CLI 使用 serverSlug 启动，通过状态映射原 managedServerIds；macOS IPC 测试使用短隔离路径。恢复清单保留原路径供人工复核。防御仅覆盖数据完整性、凭据私有性、路径及已知上游约束，不实现并发多机合并或自动重试/清理。

中央演进适用但项目稳定身份尚待登记（REGISTRATION_PENDING），未向中央发布。相关：[[README]]、[[specs]]、[[verification]]。
