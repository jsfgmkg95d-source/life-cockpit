# 人生驾驶舱 · Life Cockpit

**把今天的行动，变成看得见的积累。**

面向独立创作者的开源 Windows 工作台：安排今天的任务，记录实际投入，回顾一周留下的成果。核心功能离线可用，数据保存在本机，无需注册。

**[下载 Windows 版](https://github.com/jsfgmkg95d-source/life-cockpit/releases/tag/v0.14.0-beta.1)** · **[三步上手](docs/quickstart.md)** · **[反馈问题](https://github.com/jsfgmkg95d-source/life-cockpit/issues/new/choose)** · [English](README.en.md)

Windows x64 · 免费开源 · MIT · Beta

<!-- Screenshot assets below contain synthetic demonstration data only. -->
![人生驾驶舱：今天的任务与计时。图中均为示例数据。](docs/images/today.jpg)

## 它能帮你做什么

| 你想弄清楚 | 在驾驶舱里这样做 |
| --- | --- |
| 事情很多，今天从哪里开始？ | 收集待办，选出今天要推进的任务，写下下一步。 |
| 忙了一天，时间花在哪里？ | 为任务计时，分别记录计划时间与实际投入。 |
| 连续做了几天，留下了什么？ | 按项目查看记录的投入与成果，为下一周安排提供依据。 |

适合同时推进多个项目的写作者、独立开发者和自由职业者。任务、计时和回顾可以直接使用；项目指标和在线 AI 按需配置。

## 开始使用

1. 在 [Release 页面](https://github.com/jsfgmkg95d-source/life-cockpit/releases/tag/v0.14.0-beta.1) 下载 **Windows x64 完整 ZIP**，解压整个文件夹。不要下载页面底部的 `Source code` 作为安装包。
2. 双击 **人生驾驶舱.exe**，建立自己的工作台。也可以先体验合成示例。
3. 创建一项今天要做的事，开始计时；暂停保存后点“完成”，再到回顾页查看记录。

普通用户无需安装 Node.js，也不需要 API Key。详细步骤、关闭程序、备份和更新方法见 [上手指南](docs/quickstart.md)。

## 功能与边界

- **今天与计划：** 收集事项、安排今日任务、完成与撤销、从今日计划移除。
- **专注计时：** 为任务记录实际用时，支持桌面小组件。
- **项目与回顾：** 保存项目档案、成果记录与历史，查看已有记录的变化。
- **本地数据：** SQLite 保存，手动备份、JSON 导出和整份账本恢复。
- **可选 AI：** 不配置也能使用核心功能。当前在线报告使用 OpenAI API，主动启用后会发送项目与记录摘要，详见 [隐私说明](docs/privacy.md)。

任务完成、实际用时和成果是独立记录。点“完成”不会自动生成成果；投入时长也不代表质量、收入或能力。图中的历史和数字均为演示数据，不是产品效果承诺。

当前发布 Windows x64 Beta，界面主要为中文。尚不提供云同步、多人协作或官方 macOS / Linux / 手机安装包。自动更新尚未提供，升级前请先备份。

## 开发者

需要 Node.js **24.16 或更新的 24.x**、npm。桌面发行包需要在 Windows x64 构建。

```powershell
git clone https://github.com/jsfgmkg95d-source/life-cockpit.git
cd life-cockpit
npm ci
npm run dev:server
```

另开一个终端执行 `npm run dev`，打开该命令显示的本机地址。

```powershell
npm test
npm run build
npm run desktop:build
```

测试请使用独立的 `PCOS_DATA_DIR`，不要连接日常使用的账本。源码中的内部字段名保留历史兼容性，产品名为 Life Cockpit。

## 一起改进

[报告问题](https://github.com/jsfgmkg95d-source/life-cockpit/issues/new/choose)时，请写清版本、Windows 版本、操作步骤、预期与实际结果。截图请先遮挡私人项目名、路径和密钥，不要上传账本或备份。

欢迎改进首次使用、无障碍、文档与稳定性。开始较大改动前请先开 Issue 讨论；参见 [贡献指南](CONTRIBUTING.md) 和 [路线图](docs/roadmap.md)。

代码采用 [MIT License](LICENSE)。第三方组件与资源遵守各自许可，见 [第三方声明](THIRD_PARTY_NOTICES.md)。
