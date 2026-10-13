---
tags: [raft, local-control, lifecycle]
updated_at: 2026-10-13T17:38:45+08:00
---

# 开发验证与限制

2026-10-13：manage.test.mjs 6/6，local.test.mjs 5/5，manage.container.test.mjs 1/1。真实测试使用新建隔离Docker/状态目录，入口restart、stop和无参start后保留账号、聊天、Agent、两类头像与附件、应用密钥；无远端写入。正式实例只执行status，仍健康。

Node24.11、Python3.12.4、Docker Desktop和前次已构建镜像继续使用；本次无依赖安装或镜像重建。最终独立Review/Verify均已接收且PASS，completion_claim_allowed=true。冻结版本CONTROL 9/9、REGRESSION 11/11、LIVE-LIFECYCLE 1/1，以及SHELL三个入口可执行位与语法检查通过；四组退出码均0、stderr为空，无跳过。尚无Finder人工双击证据，已通过bash真实启动器验证双击脚本参数和路径；connect交互用本地进程探针验证，不登录用户Computer或自动启动Agent。

相关：[[README]]、[[specs]]、[[design]]。

冻结摘要：`abc89d09f63a92f150833cf7c131ed80ea0ecb0d3ef21b64aa17b0e73a4ad8c0`。独立评审与验证的运行标识保留在本机证据中。原始记录由本机任务保留。此处仅回填收尾状态与证据，不修改受检实现。中央演进仍为REGISTRATION_PENDING，未同步中央。
