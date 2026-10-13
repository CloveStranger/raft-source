---
tags: [raft, local-control, lifecycle]
updated_at: 2026-10-13T13:59:16+08:00
---

# 设计与边界依据

raft-local仅处理工具路径、Node版本与cwd，exec到scripts/local/manage.mjs。两个.command为薄入口，调用start/restart；交互终端保留完成提示。manage使用parseArgs，配置仍由common.load唯一读取。startApp、stopComputer/resumeComputer、schedule.run继续持有实际部署、Computer和备份逻辑。

生命周期写入computer-resume.json（0600），原子保存版本1的停止前managed集合。仅运行集合非空的原服务状态写入，重复停止不覆盖。start等startApp完成再恢复并删除记录，失败保留；disabled不恢复。restart针对当次运行集合，不消费原已停止状态的旧记录；connect成功清除旧意图。Computer严格集合检查只用于新生命周期，备份仍沿用原契约。所有生命周期写入共用现有.backup-lock，不改变备份算法。持久化数据、uploads、env和每日任务保留。

[DEFENSE-EVIDENCE]：Node最低24来自项目TS加载与已确认系统Node22/Homebrew23的GUI约束，NVM选择使用已安装版本而非下载；原集合和disabled规则继承既有Computer与恢复契约；锁继承已启用每日备份的数据一致性要求；CLI严格动作/参数与slug来自setup公共接口，使用argv+shell:false及继承stdio，保持真实浏览器授权交互。没有新增自动清理、跨机器同步或自动重试。

中央演进继续适用，但稳定project_id未知，REGISTRATION_PENDING；不写中央。相关：[[README]]、[[specs]]、[[verification]]。
