---
tags: [raft, design, backup]
updated_at: 2026-10-13T15:30:00+08:00
---

# 设计

关联：[[README]]、[[specs]]、[[verification]]；部署说明：[[本地部署与私有 GitHub 备份]]。

Compose 加入固定 Redis7 镜像（无宿主端口），unless-stopped，状态目录redis/，appendonly=no、save="60 1"、dump.rdb。API 使用内网URL，并等待PG/Redis健康。redis.mjs维护两项配置：只补空/缺失值，已有密钥不变；支持Compose的等号/冒号分隔及前导空格。冲突的重复赋值或不明确的转义/插值报错。env只在本机私有文件及加密归档中存储。

backup.mjs在共享锁内确认Redis在线；严格停Computer原managed集合，并保存computer-resume.json。停API后导出PG，SAVE并停Redis，复制单一dump.rdb，清单标记版本1、镜像和rdb profile。依次恢复Redis、API、原Computer集合；清理失败不遮蔽其他恢复尝试，未完成的Computer恢复记录可由start消费。加密/上传在恢复服务之后执行。

restore验证认证归档及RDB版本/内容后才创建新目标。RDB复制到redis/再启动PG/Redis，恢复PG角色和数据，重建RW并启动应用。原server.env保留，Computer仍disabled。旧清单不含Redis时创建新实例并在restore-inventory记录legacy-no-redis-fresh-instance，启动时仅补缺少的配置。

online.mjs只读等待初次PG心跳，再以单调时钟连续采样；CLI/Redis/PG采集有进程超时，HTTP有取消期限。由绑定机器身份、Redis租约与权威PG持久pong心跳证明活跃；不依赖会独立过期的浏览器JWT，不刷新Computer的登录session，不以瞬时status代替。scope-fixture使用read-only worker源码挂载及原始worker验证器；token只经stdin，不进argv或日志。

首次正式AOF升级先SAVE并正常停止，确保当前数据进入RDB，旧AOF文件保留但新profile不读取。方案不自动修改官方云端Computer配置。中央设计演进适用但project_id未知，REGISTRATION_PENDING，不发布中央设计。

正式一键备份发现 Agent 技能绝对软链接指向共享 skills/version_7；只保存链接会遗漏目标内容。将这 1.2MB 的精确目录登记为 agent-skills 外置根，未扫描其他项目。pack 对只落在已登记根内的链接生成归档内相对目标并保存原目标映射；unpack 仍执行包内路径、内容及链接校验。restore 按根实际落点重新生成相对链接，使恢复文件使用 external/agent-skills 中的快照副本。未登记外链继续报错，Computer仍disabled。

新Redis/转换链接归档内层format2，旧reader拒绝新语义；新reader兼容format1。解包要求转换映射完整、与tar相对目标一致且真实解析仍在目标根；重绑复核父目录与目标真实路径闭包。正式验证在私有快照目录下调用生产restore(start:false)，只起隔离PG/Redis并验证技能副本，Computer disabled；验证后仅移除自身容器，保存本机恢复证据。
