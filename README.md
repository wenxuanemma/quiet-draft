# Quiet Draft

一个低调的、文档风格的 AI 写作 Chrome 扩展。打开新标签页看到的是一个类似 Google Docs 的简洁编辑界面，实际上可以在里面直接跟 AI 对话生成内容。

## 功能

- **新标签页 = 写作界面**：白底、衬线字体、页边距，看起来就是在写文档
- **就地生成**：正文里单独起一行，以 `>` 开头写提示词，光标停在那一行按 `Ctrl/Cmd + Enter`，AI 生成内容会直接替换成正文
- **本地持久化**：文档内容、标题、设置都存在浏览器本地（`chrome.storage.local`），不上传到任何服务器
- **Panic Mode**：`Ctrl+Shift+Space`（Mac: `Cmd+Shift+Space`）瞬间柔和切换成可自定义的伪装文字，再按一次切回真实内容；也可以设置成切换标签页时自动触发

## 安装步骤

1. 克隆本仓库到本地：
   ```
   git clone <repo-url>
   ```
2. 打开 Chrome，地址栏输入 `chrome://extensions`
3. 右上角打开「开发者模式」
4. 点「加载已解压的扩展程序」，选中克隆下来的项目文件夹
5. 打开一个新标签页，应该能看到编辑界面

## 配置 API Key

点界面右上角的 `⋯` 打开设置：

- **模型**：选择 Claude（Anthropic）或 OpenAI
- **API Key**：填入你自己的 key
  - Claude: 在 [platform.claude.com](https://platform.claude.com) → Settings → API Keys 生成
  - OpenAI: 在 [platform.openai.com](https://platform.openai.com/api-keys) 生成
- **模型名称**：留空则用默认值（`claude-sonnet-5` 或 `gpt-4o`）

**注意：每个使用者需要用自己的 API Key**，不要共用同一个 key —— 一是费用会算在 key 的持有者账上，二是 key 明文分享存在泄露风险。Key 只会存在你自己浏览器的本地存储里，不会同步给其他人或上传到任何地方。

## 更新到最新版本

```
git pull
```

然后回到 `chrome://extensions`，找到这个扩展卡片，点右下角的刷新图标。已经打开的新标签页需要关掉重开才会加载最新代码。

## 项目结构

```
quietdoc/
├── manifest.json      # 扩展配置：权限、快捷键、新标签页覆盖
├── background.js      # 后台 service worker：接收全局快捷键
├── newtab.html         # 主界面
├── app.js              # 前端逻辑：编辑器、AI 调用、Panic Mode
├── style.css           # 样式
└── icons/              # 扩展图标
```

## 已知限制

- 目前只支持单文档（没有多文档管理/历史记录）
- AI 调用是浏览器直连 Anthropic/OpenAI API，没有中间代理，也就没有额外的密钥保护层
- Panic Mode 的"自动触发"基于标签页失焦，不是真正的屏幕共享检测（浏览器扩展目前拿不到这个信号），所以会有一些误触发
