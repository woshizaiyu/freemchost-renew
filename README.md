# FreeMCHost 自动续期 (Node.js + Playwright)

为 [FreeMCHost](https://freemchost.com) 提供的免费 Minecraft 服务器自动续期方案。  
通过浏览器模拟用户操作，支持账号密码登录 / 注入登录态、弹窗清理、60 小时精确续期、跨上下文验真入库并推送 Telegram 报告。

---

## 🔐 Secrets 配置说明

| 名称 | 是否必填 | 说明 | 示例 |
|---|---|---|---|
| `FREE_EMAIL` | ✅ 必需*1 | 账号邮箱（与密码配对提供时，优先自动登录） | `your@email.com` |
| `FREE_PASSWORD` | ✅ 必需*1 | 账号密码 | `***` |
| `SERVER_PAGE_URL` | ❌ 可选 | 服务器管理页完整 URL，可填多个（换行/逗号分隔） | `https://freemchost.com/app/servers/YOUR_SERVER_ID` |
| `SERVER_ID` | ❌ 可选 | 仅填写服务器 ID（UUID），自动拼接为完整路径；多个用换行/逗号分隔 | `YOUR_SERVER_ID` |
| `AUTH_STATE` | ❌ 可选 | **登录态 JSON**（Playwright `storageState()`），注入后可跳过登录；推荐用于“永久免维护”方案（回写至本 Secret） | 从浏览器导出 JSON 或 Base64 |
| `GH_TOKEN` | ❌ 可选 | GitHub Personal Access Token（classic），用于回写 `AUTH_STATE` 等 Secret | `ghp_xxx` |
| `TG_BOT_TOKEN` | ❌ 可选 | Telegram Bot Token | `123456:AAA-xxx` |
| `TG_CHAT_ID` | ❌ 可选 | 接收通知的 Chat ID（频道/群组/私聊） | `123456789` |
| `NODE_LINK` | ❌ 可选 | sing-box 节点链接（代理出网，降低封禁风险） | `vless://...` / `hy2://...` / `vmess://...` |
| `PROXY_URL` | ❌ 可选 | 直接指定代理地址（http/socks5 均可），优先级高于 sing-box | `http://127.0.0.1:1080` |

> **必读：** 二选一提供凭证：  
> - 方案 A：`FREE_EMAIL` + `FREE_PASSWORD`（每次登录表单提交，适合首次使用）  
> - 方案 B：`AUTH_STATE`（导入浏览器导出的 `storageState` JSON，前端会自动刷新 Supabase token，体验更稳）

---

## 🛠 部署步骤

1. Fork 本项目（或使用你自己的仓库）。
2. 在仓库设置 → Secrets & variables → Actions 添加上述 Secrets。
3. 在 Actions 页面启用工作流。
4. 手动触发一次运行，观察输出日志。

### 调整巡检频率

编辑 `.github/workflows/renew.yml` 中的 `cron` 字段：

```yaml
- cron: '10 2 */2 * *'   # 每 2 天巡检一次（约48h，最接近46h的cron表达）
```

---

## ⚙️ 环境变量（可调优参数）

以下值可通过 **Variables (vars)** 方式配置，或直接写入脚本：

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `RENEW_THRESHOLD_HOURS` | `46` | 剩余时长低于该值才触发续期（小时） |
| `RENEW_DURATION_LABEL` | `60 hours` | 续期时长文案，可逗号分隔多个候选（60 hours,60h,3 天） |
| `VERIFY_MIN_HOURS` | `20` | 入库验真最小增量小时（小于则判失败） |
| `API_DIRECT` | `check` | 直调预检：check=先POST查剩时再走浏览器；off=纯浏览器 |
| `SERVERFN_HASH` | 留空 | `_serverFn/<hash>`漂移时手动覆盖；直调失败看嗅探日志更新 |
| `SERVERFN_F` | `63` | 续期意图函数号（录制值63）；直调失败时可试改 |
| `TIMEZONE` | `Asia/Shanghai` | 通知时间时区 |
| `LOCALE` | `en-US` | 浏览器语言环境 |
| `BROWSER_CHANNEL` | 留空 | Chrome/Firefox/Echo 等（如有需要） |
| `NAV_TIMEOUT` | `90000` | 页面导航超时（毫秒） |
| `DRY_RUN` | `false` | 演练模式：只打印不会真正点击续期按钮 |
| `AUTO_UPDATE_STATE` | `true` | 登录成功后将最新登录态回写到 GH Secret（依赖 `GH_TOKEN`） |

---

## 🧰 本地调试

确保 Node.js >= 18 已安装：

```bash
npm install          # 安装 playwright 与依赖
node --check renew.js    # 语法校验
npm start            # 正常运行
```

常用环境变量（Windows CMD/PowerShell 示例）：

```cmd
REM 演示环境，开启 DRY_RUN 避免误点
set FREE_EMAIL=your@email.com
set FREE_PASSWORD=your_password
set SERVER_PAGE_URL=https://freemchost.com/app/servers/YOUR_SERVER_ID
set TG_BOT_TOKEN=xxxxx
set TG_CHAT_ID=xxxxx
set PROXY_URL=http://127.0.0.1:1080
set DRY_RUN=true
set HEADLESS=false
npm start
```

MacOS/Linux (Bash):

```bash
export FREE_EMAIL=your@email.com
export FREE_PASSWORD=your_password
export SERVER_PAGE_URL="https://freemchost.com/app/servers/YOUR_SERVER_ID"
export TG_BOT_TOKEN=xxxxx
export TG_CHAT_ID=xxxxx
export PROXY_URL="http://127.0.0.1:1080"
export DRY_RUN=true
export HEADLESS=false
npm start
```

---

## 📸 截图与 Artifact

GitHub Actions 会上传所有生成的 PNG 截图（7 天保留），包括：

- `server-{N}-verify.png` — 核验页面截图
- `server-{N}-error.png` — 异常场景截图
- `login-failed.png` — 登录失败截图
- `storage-state-final.json` — 最后一次会话的登录态快照

---

## 🧩 参考设计

- **wittyconan/freemchost-renew**: 弹窗清理、倒计时提取、穿透点击、跨页验真
- **AgentScribe 录制**: Manage 菜单结构 (`[id$="-trigger-manage"]`)、Renew now、Duration picker 与 confirm 按钮
- **本项目的增强**:
  - 双模登录（Cookie/Supabase token + 账密表单），支持 `AUTH_STATE` 回写 GH Secret 实现“永不过期”
  - 通用时长选择器（文本匹配 + 多候选），适配未来文案变更
  - 网络嗅探 `_serverFn/<hash>`，便于升级纯 API 模式
  - 灵活代理（sing-box + NODE_LINK + PROXY_URL）

---

## ⚠️ 免责声明

- 本程序仅供学习与研究，非盈利目的。
- 使用者应遵守所在国家/地区的法律法规及服务商条款。
- 作者不承担因滥用导致的任何后果责任。

---

## 📜 License

MIT © Original Authors
