# 我做了一个开源的“人生驾驶舱”：安排今天，记录投入，看见一周的积累

同时推进几个项目，容易遇到三个问题：今天先做哪件事、时间花在哪里、连续做了几天到底留下了什么。

于是做了人生驾驶舱，一个本地运行的 Windows 工作台。现在把它整理成 MIT 开源项目，发布第一个公开 Beta，想找一些写作者、独立开发者和自由职业者试用。

它的主要流程很简单：

1. 为项目写下今天要推进的任务。
2. 开始计时，工作结束后暂停保存，点完成。
3. 按项目回顾实际投入和记录的成果，再安排下一周。

任务完成、时间和成果分别记录。点完成不用先提交证明，也不会自动产生“完成了多少成果”的数字。

![人生驾驶舱首页，内容均为示例数据](https://raw.githubusercontent.com/jsfgmkg95d-source/life-cockpit/main/docs/images/today.jpg)

核心功能离线可用，数据保存在本地 SQLite，无需注册。提供手动备份、JSON 导出和恢复。AI 是可选项，当前使用 OpenAI API，主动启用后会发送记录摘要。

普通用户下载 Windows x64 完整 ZIP，全部解压后双击“人生驾驶舱.exe”即可，不需要安装开发工具。

- 项目与源码：https://github.com/jsfgmkg95d-source/life-cockpit
- Windows Beta：https://github.com/jsfgmkg95d-source/life-cockpit/releases/tag/v0.14.0-beta.1
- 上手指南：https://github.com/jsfgmkg95d-source/life-cockpit/blob/main/docs/quickstart.md

目前界面主要为中文，还没有云同步、多人协作和其他系统安装包。Beta 也需要继续打磨，升级前建议先备份。

最想了解的是：你能否独立完成第一次记录，哪一步让你犹豫，以及连用几天后回顾是否有用。欢迎在评论或 GitHub Issue 提具体问题；请不要上传自己的账本和敏感信息。
