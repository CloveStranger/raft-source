---
tags: [raft, specification, redis]
updated_at: 2026-10-13T17:38:45+08:00
---

# 验收规格

需求：[[README]]；实现：[[design]]；证据：[[verification]]。

| ID | 结果 |
| --- | --- |
| UNITS | 配置补齐不轮换密钥；quoted empty/重复配置正确处理；导出失败恢复原服务；连接中断/重连/停滞心跳不能被误判通过；既有加密、文件、入口、调度契约通过 |
| PG-REDIS-RECOVERY | PG角色、关系、序列、ACL及头像/附件/工作文件/原env恢复；Redis字符串/队列/hash/二进制原值恢复；声明有RDB但缺失或无效时，在目标创建前失败；旧归档显式记录新Redis |
| APP-RECOVERY | 真实账号登录、用户/Agent头像、聊天、附件和Agent配置经加密恢复后可用 |
| LIFECYCLE-ONLINE | 真实 Computer 首次启动及一键重启后各持续120秒在线，原 active集合恢复、inactive绑定保持停止，数据保留 |
| COMPUTER-RECOVERY | 实际 Machine HTTP attestation由真实worker验签；备份后和恢复后各持续120秒在线；同一个签名密钥与Redis值恢复；工作文件逐字节校验 |
| REGISTERED-LINKS | 已登记的跨根技能链接及原文件同包；恢复指向 external 下副本，源文件后来改变不影响恢复内容；未登记链接与逃逸映射拒绝 |
| PRIVATE-ROUNDTRIP | 正式私有快照下载认证解密，以start:false恢复PG/Redis/文件，技能副本可读，Computer disabled，测试容器仅清理自身 |
| FORMAL-ONLINE | 正式本地工作区 在现有隔离home以1.0.47持续在线120秒，只读验证，无个人数据输出 |

每个在线窗口等待首次PG心跳后开始，检查同一服务/runner PID、连接标记时间、Redis owner/generation不变、TTL正值、PG/Redis心跳新鲜且各至少推进三次，managed集合等于运行集合。窗口内不重试、重置或忽略错误。关机、睡眠与Docker关闭不属于持续运行条件。
