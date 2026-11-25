# zcode-tempo

为 AI 编程工作台显示模型生成速率，并通过三击空格增强提示词。首版支持 Windows ZCode 4.0.0。

## 安装

若已安装 ByteRax ZCodeBox，先在 ZCode 中执行原版的 `/uninstall-overlay` 移除状态栏，再从「设置 → 插件」卸载原版。完全退出 ZCode 后再安装本插件。安装器会检查原版的状态栏加载入口和插件安装记录。

在项目根目录运行以下命令，把参数换成实际的 ZCode 安装目录。需要 Python 3。

```powershell
python -X utf8 scripts/install.py install --app-dir 'D:\ZCode'
```

重新打开 ZCode 后生效。可以用相同的目录参数查看安装状态或卸载。客户端升级后，先确认支持版本再重新检查。

```powershell
python -X utf8 scripts/install.py check --app-dir 'D:\ZCode'
python -X utf8 scripts/install.py remove --app-dir 'D:\ZCode'
```

安装只向 `app.asar` 的桌面入口增加本扩展的加载语句，并将运行文件放在相邻的 `resources/harness-zcode` 下。卸载移除本扩展的加载语句和运行文件。

## 使用

- 输入框工具栏在上下文图标和模型选择左侧显示 `xx tok/s`。生成中为估算，结束后为本轮均速。暂无速率时隐藏，工具等待不计入最终生成耗时。
- 输入草稿，把光标放在末尾，在 700 毫秒内独立按下三次空格。当前会话所选模型会收到草稿文本与改写指令，可能消耗该供应商额度。
- 结果返回后回填到发起增强的会话。切走时，回到原会话后再回填。`Ctrl+Z` 恢复回填前的内容，消息仍由你发送。
- 增强保留用户授权的动作和交付范围，按排查、修改、方案等任务调整改写幅度。回填前会检查可识别的命令、代码块、路径和链接。发现关键内容被改动时，保留当前草稿并沿用原有失败提示。
- 草稿包含结构化 `@` 引用或附件时，保留原稿并提示暂不支持。当前首版验证范围为本地 Windows 会话。

## 实测

实测使用 Windows ZCode 4.0.0 隔离副本与本地模拟模型服务。桌面测试覆盖速率行位置、生成中估算、生成结束均速、普通空格、三击回填、等待期间编辑、切换会话和原生 `Ctrl+Z`。安装回归检查通过重复安装、原版冲突拦截和卸载后安装包逐字节恢复。

改写质量使用实际 `GLM-5.3-Flash` 和同一批 24 条合成草稿做了版本对照。详细数据见 [增强对照结果](docs/prompt-enhancement-comparison.md)。

复现时，将一份干净的 ZCode 4.0.0 安装目录复制到 `%TEMP%\harness-zcode-4-e2e\app`，对副本运行 `install.py install`。测试需要 Node.js 22 或更新版本。运行 `node tests/zcode-fixture.cjs`，等它输出 `debugPort`。在另一终端执行 `node tests/zcode-desktop.cjs <debugPort>`。夹具会禁用临时副本的系统打开方式注册，并调整启动时的遥测等待和预装工具准备。

## 上游与许可

本项目复用 ByteRax ZCodeBox 的测速、输入框接入和模型请求代码，并扩展了模型请求模块以支持新版改写指令。上游为 [`v1.5.23`](https://github.com/ByteRax/zcode-token-usage-statusbar/releases/tag/v1.5.23)，其 [MIT 许可及版权声明](src/vendor/byte-rax-1.5.23/LICENSE) 随代码保留。项目自有代码的许可证待定。
