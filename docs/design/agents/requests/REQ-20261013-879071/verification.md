---
tags: [raft, verification, evidence]
updated_at: 2026-10-13T17:38:45+08:00
---

# 验证记录

关联：[[README]]、[[specs]]、[[design]]。

开发阶段曾保持 PARTIAL。最终候选 5 已取得独立 Review/Verify 接收且 PASS，completion_claim_allowed=true；历史候选与原始控制器记录保留于 .tmp/redis-online/。

已定位的前序缺口：瞬时serverConnected不能证明持久连接。隔离观察器起点PG心跳为null而后续正常推进，Date.parse(null)产生NaN导致误判；修订为先等首个持久心跳，再执行连续窗口，保留至少三次推进要求。

正式实例已增加Redis/scope配置；RDB升级先SAVE、保留旧AOF再重启，server.env哈希不变。旧备份的历史PASS不作为本REQ持续在线验收证据。个人恢复只验证解密清单，不自动启动第二个Computer。独立演进状态为REGISTRATION_PENDING，尚未中央同步。

当前候选2修复R1（Compose冒号配置不应被当作缺少密钥），实际Compose config回归探针通过。另修复个人观察工具的JWT过期干扰：只读绑定Machine的PG/Redis证据。候选1原始Review报告及capture保留（Web工具事件重复id导致REJECTED，不作为有效PASS）。

候选2Review已接收，确认R1关闭，发现R2（BOM首行密钥漏识别）。候选3修复BOM/Unicode空格，增加真实Compose配置和空BOM重复启动断言；原报告保留。

候选3Review PASS后，正式一键备份发现现有Agent技能外链未登记，导出被正确拒绝，原服务经finally恢复。这是实际数据覆盖缺口（R3），不是可忽略的极端同步情况。补登记精确技能根并增加安全跨根归档/恢复重绑，原路径和原文件保持不变；候选3的运行证据保留，当前功能修订另冻结候选4。

候选4Review发现R3-1/R3-2中等缺陷：映射全缺失会被忽略，私人验证失败路径清理不完整。候选5增加缺映射拒绝、精准自有项目cleanup和cleanup后成功证据，针对性反例通过，保留原报告。

## 最终验收

八项正式控制器命令均退出0，无跳过：UNITS 35项；PG-REDIS-RECOVERY、APP-RECOVERY、LIFECYCLE-ONLINE、COMPUTER-RECOVERY各1项；REGISTERED-LINKS 3项；PRIVATE-ROUNDTRIP及FORMAL-ONLINE成功。真实启动、重启、备份后、恢复后各完整观察120秒；正式实例在私有往返后再次观察120秒在线。

正式快照已发布到配置的私有备份库，内层format2；具体编号保留在本机证据中。下载认证解密、原env哈希、Redis RDB和真实数据恢复通过；765个清单条目，29个恢复技能链接使用恢复副本。恢复Computer禁用，隔离容器清理成功后才保存证据。原Computer保持在本地工作区运行；每日launchd interval86400仍启用。

冻结摘要：`de004df4af299188600b4cc4b065d1c7c0c52eb3a278cd40cd29c759bc9dcbce`。独立评审与验证的运行标识保留在本机证据中。R1/R2/R3-1/R3-2均由独立角色确认关闭。最终状态及报告：.tmp/redis-online/final-status.json、final-report.md。

限制：Node24.11而仓库pin24.21，复用原构建镜像与Computer1.0.47；不保证关机、睡眠或Docker关闭期间在线，不包含未登记外置数据/系统钥匙串；官方云端迁移仍暂停。中央设计演进REGISTRATION_PENDING，project_id尚未确定，未同步/发布中央。本次仅回填收尾证据，不修改已冻结实现。
