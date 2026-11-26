# JEVHarness 自定义预设（v2.3.1）

> 把《JEV ENGINEERING FOR CODING AGENTS》（2026 工作笔记）转化为 DeepSeek Harness 可执行插件架构的 Agent 预设。
> 通过**按会话严格隔离**的显式类型化状态账本，在每步模型生成前批量向 TypeSafe JeV 询问 Table I 六大决策与 per-chunk 可见性，并由确定性代码执行安全闸门、条件规则挂载、子目标去重/读写锁与异步 JSONL 可观测。

- 声明 id：`jevharness`
- 显示名：`JEVHarness`
- Bundle：`@local/dsh-jevharness-preset`（`v2.2.7`）
- 基础：官方 `ptc` 预设 + 零外部依赖纯 Node 20+ ESM 插件层
- 依据：《JEV ENGINEERING FOR CODING AGENTS》（Diogo Almeida / TypeSafe 设计笔记综合版）

---

## 1. 目录结构

```
jevharness-preset/
├─ package.json                  # v2.1.0 bundle 清单（含 ./client 导出 + dsh.client）与 test / bench / report 脚本
├─ cordis.patch.yml              # 预设声明、v2 persona 契约、循环/工具配置与 jevharness-ui 客户端自注册行
├─ index.js                      # 客户端 bundle 宿主半边（自注册行加载标记 _ui-root.json）
├─ client.js                     # 浏览器端实时 UI：JEV Live HUD / 显示模式 pill / 回合回执卡
├─ shared/
│  ├─ gateway.mjs                # 共享 Magpie System One 网关客户端与 .env Key mtime 缓存
│  ├─ answers.mjs                # Table I 题型构造、双峰尾风险解析、置信度分桶与旧格式兼容
│  ├─ policy.mjs                 # §IV.A 权限/PTC/脚本正文外联闸门、Table IV 路由信任矩阵、§II.A 成本公式
│  ├─ chunk-store.mjs            # §I/§V/§X 显式类型化 Chunk 账本、可见性阶梯与只读共享检索包
│  ├─ conditional-rules.mjs      # §VIII 目录 FOOTGUNS.md 与 .jev/rules/*.md 条件加载器（免疫 compaction）
│  ├─ subgoal-tracker.mjs        # §VI.A 并发路径读写锁 + §VI.B 子目标去重
│  ├─ live-bus.mjs               # 每会话内存环形事件总线（供 Web UI 实时投影，零 prompt 成本）
│  └─ telemetry.mjs              # 异步队列 JSONL 日志与离线指标汇总器（兼容旧 .md）
├─ jev-decide-tool/
│  ├─ package.json
│  └─ index.mjs                  # jev_decide 工具（复用 shared/gateway.mjs）
├─ jev-harness-loop/
│  ├─ package.json
│  └─ index.mjs                  # 主循环插件：每步决策、闸门、条件规则、live 频道与 jev_chunk_read / jev_retrieval_pack
├─ scripts/
│  └─ jev-report.mjs             # 本地观测报表 CLI + 静态 HTML 仪表盘生成器
├─ bench/
│  └─ suite.mjs                  # 4 类标准化离线回归基准套件
└─ test/                         # 81 项原生 node:test 单元测试与端到端集成测试（含 live-bus / phase3 / UI 放置 / 完整决策步流 / 回执 / 决策台数据流）
```

---

## 2. 安装 / 更新 / 本地验证

安装或更新到 DSH：

```
plugin_manager action=remove_bundle target=@local/dsh-jevharness-preset
plugin_manager action=install_bundle target=<绝对路径>\jevharness-preset
```

> 插件代码改动（`.mjs`）会被宿主进程缓存，**更新后需重启 DSH 一次**以加载新版本。涉及 `client.js` / `index.js` 等客户端 bundle 的改动，除重启外还需让 Web 前端产物重新构建（`pnpm run dev:web` 运行时会热更，否则需重建后刷新页面）才会在浏览器生效。

本地开发验证（零外部依赖，Node 20+ 即可运行）：

```bash
# 运行全部 90 项单元测试与端到端集成测试
npm test

# 运行 4 类多场景离线基准
npm run bench

# 汇总本机 ~/.dsh/jev-decisions/ 决策与拦截指标（可加 --out report.html 生成静态仪表盘）
npm run report
```

---

## 3. v2 核心机制（对齐 original.pdf）

### 3.1 严格多会话隔离（解决 v1 串台）

- 彻底移除全局 `latest` 单例，改为 `Map<sessionId, SessionState>`。
- 仅含 `JEV_MARKERS` 的会话才会标记 `isJev = true`；普通 `standard/ptc` 或 `mnemon` 会话在 `system-prompt/assemble` 与 `tools/pre-execute` 中直接透传，不调用 JeV、不拦截、不写日志，且 `agent/disposed` 自动清理内存。

### 3.2 Table I 六大决策与 Per-Chunk 批量评分

| 决策 | 题型 | 当前执行落点 |
|---|---|---|
| `context_visibility` + `chunk_vis_<id>` | `choice`（四档） | 一次批量为最多 12 个候选 chunk 评级；写入 `jev-chunks` 索引表，隐藏项可用 `jev_chunk_read` 无损召回 |
| `cache_prefix` | `noul` + 概率 | 置信度分桶（`low/med/high`）；`reuse` 且离散签名不变时**逐字节冻结** `jev-harness` 注入文本保护 KV Cache |
| `routing` | `choice`（`frontier/cheap/background`） | 结合 §IX Table IV 信任矩阵提示子代理路由，并在 `subagent` 边界校验模型信任等级 |
| `tools` | `choice`（`targeted/full_read/search_source/execute_verify`） | 指导本步检索与验证策略 |
| `permissions` | `choice`（`allow/ask/deny`） | 与确定性规则协同在 `tools/pre-execute` 拦截，无审批模式下 `ask` 自动降级为 `deny` 并明示原因 |
| `security` | `score`（含尾概率升档） | 高危尾概率 `P(sensitive)+P(secret) >= 0.35` 自动升档至 `sensitive`，同时驱动敏感路径与路由门控 |

### 3.3 §IV.A 安全闸门与 PTC 覆盖

1. **高信号秘密路径确定性拒绝**：路径字段或 shell 命令命中 `.env`、`.ssh`、`id_rsa`、`private_key`、`api_key`、`credential`、`passwd`、`.pem`、`wxid`、`.npmrc`、`.netrc` → `deny`（不检编辑工具文件正文，避免误伤源码）。
2. **PTC `run_code` 静态检查**：检查 `args.code` 中的秘密路径访问、非 deploy 域外部网络外联（内置 `127.0.0.1 / localhost / ::1` loopback 白名单）与仓外写/删操作。仓外写检测只解析 `writeFile/appendFile/rm/rename/copyFile/mkdir` 等写删调用的**路径实参**（含 `tools.write/edit` 的路径字段），不再扫描读路径、日志文案或写数据里的路径字面量，消除误报；同时对 `run_code` 做**读写分级**：只读脚本按只读工具处理，只有真正写/删的脚本才计入 destructive。
3. **执行前深查本地脚本正文**：shell 运行工作区内脚本（`.js/.mjs/.py/.sh/.ps1`）前只读扫描前 64KB，拦截非 deploy 域外部外联。
4. **Table IV 路由信任矩阵**：支持解析 `magpie` / `magpie-responses` 等聚合网关的 `vendor/model` 前缀；`sensitive/secret` 下仅允许 first-party frontier，阻断廉价或未审查第三方模型及 `excludedVendors`。

### 3.4 §V / §VI / §VIII / §X 原生能力

- **可逆 Chunk 账本与只读工具**：新增 `jev_chunk_read(chunk_id, level, offset, limit)` 与 `jev_retrieval_pack(max_sensitivity, max_chars)`，实现「压缩从不删除」与「一次检索供多子代理/后台任务共享」。
- **条件绑定指令（§VIII）**：每步自动扫描活跃路径沿途的 `FOOTGUNS.md` / `.jev-footguns.md` 及 `.jev/rules/*.md`（支持 `paths` / `keywords` / `tools` / `always` / `priority`），每步重挂 `jev-conditional-rules`，天然免疫 compaction。
- **子目标去重与读写锁（§VI）**：`subagent` 派发前通过中英文 Jaccard 相似度拦截重复任务，并按路径执行读-读并发放行、写-写与读写冲突拦截；工具报错/完成事件丢失时释放子目标锁，陈旧 `in_flight` 自动过期，避免自锁。
- **门控报错不回灌**：`session/event` 的 `tool/result` 分支会跳过 `Error: JEVHarness blocked…` / `Error: JeV permissions=…` 这类门控拒绝结果，不再把它们作为业务 chunk 回喂给 JeV 放大负面偏置；门控事件仍单独写入 JSONL gate 日志。

### 3.5 实时 Web UI 投影（v2.1.0 新增，v2.2.0 扩展）

- **零成本旁路**：`jev-harness-loop` 把同一份每步决策（六维行、延迟、缓存冻结、拦截、估算省下 token、Chunk 阶梯、规则命中）写入 `shared/live-bus.mjs` 内存环形缓冲（每会话最多 400 事件、120s 活跃 TTL），并向宿主会话追加 log-only 事件 `jev/decision` / `jev/gate`；**只走 UI 旁路、不进模型 prompt，KV Cache 前缀完全不受影响**，全部 fail-open。
- **跨进程通道**：桌面 Web 下自建 `/api` 与 `connection.rpc` 频道均不可达（405/404，见决策记录 `dbc70c44` / `7a1c00fb`）。正解是宿主 `session.append` 只读日志事件 + 客户端 `ctx.uiConversation.events.register` 注册 Conversation Node：事件随会话流下发、可回放、跨会话持久化。
- **四处 UI 槽位**（不侵入宿主既有布局）：
  - `conversation.input.dock` → 「JEV 实时介入」常驻条，贴在对话区最下面（composer 上方），随对话增长始终可见；
  - `conversation.chat.node` → 仅在 `turn/end` 后渲染「✅ JEV 治理回执」卡（六维行、拦截盾牌、KV 复用率与省约 token 估算），锚点在流尾不再跑到顶部；
  - `conversation.session.header.utilities` → 呼吸灯「JEV Live」HUD（步号 / 拦截计数），点击打开右侧深度决策台；
  - `conversation.input.left` → 「JEV 六维」显示模式 pill（点击循环 live / compact / showcase）；
  - `sidebar.right.pane.tab` → 右侧专属「JEV 决策台」tab（v2.2.0）。
- **三种显示模式**：`实时 / 精简 / 演示`，持久化于 `localStorage`，由输入药丸循环切换。
- **自注册机制**：`package.json` 的 `exports["./client"]` 与 `dsh.client`（`platform=web`，`inject` 含 `@deepseek-ai/dsh-client-ui-sidebar-right`）让 `client.js` 进入浏览器 bundle；`cordis.patch.yml` 末尾 `jevharness-ui` 自插入行让包根 `index.js` 被实例化。`index.js` 写 `~/.dsh/jev-decisions/_ui-root.json` 自检标记。
- **会话级门控**：四处 UI 槽位只在已开始的 JEVHarness 会话显式显示。`jev/decision` / `jev/gate` / `jev/receipt` 事件携带 `sessionId`；客户端用槽位会话 id、空白会话标记与 JeV 事件态过滤，新建对话或非 JEV 会话不渲染。
- **全轮次汇总**：客户端按会话维护逐轮账本（决策数 / 拦截数 / KV 复用 / 估算省 token）；实时卡与回执卡显示每轮一行 + 全会话合计，深度决策台新增「逐轮汇总」分区，并给出节省比例（省下 token ÷ 可见性阶梯理论全量 token），切换会话即清空重算。

### 3.6 深度决策台（v2.2.0 新增 · H 分期 Phase 3）

- **右侧面板**：按官方两段式契约注册——`ctx.sidebarRightTabs.register({ id: '@local/dsh-jevharness-preset/sidebar', kind: 'jev-harness-decisions', keepMounted: true, guide })` + `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, Body)`；引导页提供「JEV 决策台」入口胶囊，顶栏 HUD 点击直接 `openTab(kind)` 打开。
- **Chunk 可见性阶梯**：每步把 `chunkStore.listMetadata` 的紧凑投影（id / kind / source / sensitivity / visibility / chars / lines，**不含 chunk 原文**）随 `jev/decision` 下发，面板按 `hide / short_summary / long_summary / full` 四档绘制分段条、计数与逐 chunk 列表。
- **条件规则命中列表**：同事件携带本步实际挂载的 `FOOTGUNS.md` / `.jev/rules/*.md` 命中（id / name / source / reason），面板列出规则名、来源与命中原因；无命中时显示空态。
- **零 prompt 成本**：以上字段只进 UI 旁路事件，不进 `system-prompt/assemble`，不破坏冻结的 KV Cache 前缀。

---

### 3.7 会话事件持久化契约（v2.2.8 新增 · 防「重启后打不开」）

宿主 `@deepseek-ai/dsh-session` 的事件词表是**封闭**的：读取时会逐条校验 `KNOWN_SESSION_EVENT_TYPES`，未知类型**只有带 `ignorable:true` 才会被跳过**，否则整份日志被拒绝解释（`SessionFormatUnsupportedError`）。实时 `session.append(type,data)` **无法**设置 `ignorable`，所以插件绝不能往里塞新类型。

正确做法（本插件已改）：用宿主唯一支持的 `appendPluginRecord(session, 'plugin:jev-harness/<name>', data)`，它自动打上 `ignorable:true` 并入 `plugin:` 命名空间，读写都兼容。UI 仍是普通会话事件，前端 `jevKindOf()` 同时识别旧 `jev/*` 与新 `plugin:jev-harness/*`。

历史坏日志修复：`pnpm run repair-logs`（或 `node scripts/repair-jev-session-logs.mjs --dry-run` 先看）。插件启动 3s 后也会后台自愈一次（`_ui-repair.json` 记录结果），对历史 `jev/*` 事件无损改标、自动备份并原子替换，跳过正在写入的文件。


## 4. 可观测与报表

- **报表主数据源 = 会话日志**（`~/.dsh/sessions/**/session.v*.jsonl.zstd`）：决策数、轮数、六维分布、闸门、缓存冻结率、**省 token（按 chunk 去重估算）** 全部从会话事件统计，和卡片/决策台一致。
- telemetry（`~/.dsh/jev-decisions/<id>.jsonl`）只作为 **LLM 调用审计**，报表从中借用真实每调用 token 用量（复用步不花钱，故 0 计入是对的）。
- `node scripts/jev-report.mjs` 默认读会话日志；`--sessions <dir>` / `--telemetry <dir>` 可改路径；`--source telemetry` 退回旧版纯 telemetry 统计；`--out jev-report.html` 生成自包含仪表盘，`--json` 输出原始结构。

## 5. 已知宿主边界（非插件层能力）

以下三项需 DSH 宿主内核未来开放对应 Hook，当前插件层已最大化逼近但无法越权接管：

1. **历史 Transcript 消息数组重装配**：插件层通过 `jev-chunks` + `jev_chunk_read` 管控增量工具输出，但无法直接改写宿主已提交的历史对话数组。
2. **主循环自动切模型**：插件层已实现 `subagent` 路由信任门控，主会话自动切换需宿主开放无重入的 step 级模型切换 API。
3. **全量内置/MCP 工具 Schema 热装卸**：`system-prompt/assemble` 仅建议保持工具目录稳定以护 KV Cache，全量工具分层卸载需宿主支持。

---

## 6. 实测对比：JEVHarness vs PTC

> 2026-11-24 · 同模型 `auto/deepseek-v4.1-flash`（reasoning=high，maxTokens=131072）· 同工作区 · 同一只读任务：glob 全部 `.md`，取最大的 3 个，读前 20 行，出「文件名 / 总行数 / 首个 # 标题」表。

数据来源：会话转写 `~/.dsh/sessions/…/session.v4.jsonl.zstd`（多帧 zstd + JSONL）；JEV 决策 `~/.dsh/jev-decisions/session-f00a72f3-….jsonl`。会话 ID：JEVHarness `session-f00a72f3-b608-4116-b2c3-14b669355e42`，PTC `session-0cdd2e2e-9894-4e32-ab06-de8b441207cb`。

### 6.1 严格对比

| 指标 | PTC 模式 | JEVHarness 模式 |
|---|---|---|
| 墙钟耗时（任务到达→turn/end） | 91.0 s | **52.0 s** |
| turn 时长（turn/start→end） | 93.0 s | 54.3 s |
| 步数（step/start） | 11 | **6** |
| 助手消息数 | 11 | 6 |
| 顶层工具调用 | 10 × run_code | 5 × run_code |
| 内部工具派发（按名） | glob×2, read×3, skill×2, present×1, mnemon×1 | glob×1, pwsh×3, write×1, skill×1, present×1, mnemon×1 |
| JeV 决策注入次数 | 0 | **6**（每步 1 次） |
| 闸门拦截 | 0 | 0 |
| 答案正确性 | 正确 | 正确 |
| 答案长度 | 473 字符 | 489 字符 |

### 6.2 token 用量

| 项目 | PTC | JEVHarness |
|---|---|---|
| 新鲜输入 input | 15,991 | 18,516 |
| 输出 output | 4,788 | 3,013 |
| 缓存读取 cacheRead | 833,920 | 455,040 |
| 累计处理 total | 854,699 | **476,569** |
| JeV 决策器额外 | 0 | 13,468（in 11,550 / out 1,918） |
| 合计（主 + 决策器） | **854,699** | 490,037 |

### 6.3 口径与结论

- 墙钟取「任务消息到达 → turn/end」；若按「会话创建 → 结束」计：JEV 206 s、PTC 109 s——JEV 会话创建后空闲约 154 s 才收到任务，该口径不可比。
- JEV 决策开销实测：6 次决策合计延迟 4.17 s、13,468 tokens；但整轮总处理量比 PTC 低约 44%（少 5 步 / 5 次顶层调用）。
- 两会话都受 answer-me-with-html 规则各写入 1 个 HTML 页（JEV→`.tmp/answers/…`，PTC→`~/.answer-me-with-html/…`），源文件均未改动。
- 闸门：JEV 决策日志中 gate 记录为 0（决策均 `permissions=allow`）；PTC 无闸门机制，同样 0。转写中出现的 `JEVHarness blocked` / `permissions=deny` 字样来自 agent 读取本仓库源码，非真实拦截。
- 结论：该只读小任务上 JEV 的批量化执行路径更快、更省（总处理量约 -44%），代价是每步一次决策的固定开销；两者最终答案一致且正确。

### 6.4 JEVHarness 模式的优势

分两层看：**实测层**是同任务更快更省，**结构层**是把"每步怎么决策、能不能动手"从靠模型自觉变成显式、可审计、可回滚的治理。速度是副产品，可控才是核心。

**实测优势**（同模型 / 同工作区 / 同一只读任务）

| 指标 | PTC | JEVHarness | 变化 |
|---|---|---|---|
| 墙钟耗时 | 91.0 s | **52.0 s** | ≈ -43% |
| 步数 | 11 | **6** | -5 |
| 顶层工具调用 | 10 | 5 | -5 |
| 累计处理 token | 854,699 | **476,569** | ≈ -44% |
| 逐步骤决策记录 | 0 | **6** | 每步可见 |
| 答案正确性 | 正确 | 正确 | 持平 |

**结构性优势**（普通 PTC 没有）

| 能力 | 作用 |
|---|---|
| 每步可审计 | 决策落 JSONL：决策线、延迟、JeV token、缓存冻结率、闸门事件 |
| 可逆上下文 | Chunk 账本 + `jev_chunk_read` 无损召回 + `jev_retrieval_pack` 一次检索多子代理共享，"压缩从不删除" |
| 确定性安全闸门 | 秘密路径拒绝、`run_code` 静态查外联/仓外写、脚本正文扫描、Table IV 路由信任矩阵；无审批时 ask→deny |
| KV Cache 保护 | `reuse` 且签名稳定时逐字节冻结注入文本 |
| 条件规则 | 每步重挂 `FOOTGUNS.md` / `.jev/rules/*`，天然免疫 compaction |
| 并发治理 | 子目标去重 + 路径读写锁，防重复派发与写冲突 |
| 隔离与健壮 | 严格多会话隔离；门控报错不回灌，避免负面反馈自锁 |
| 实时可见 | 每步决策旁路投影到 HUD / 回执卡 / 深度决策台，不进模型 prompt |

**代价与边界**：每步一次 JeV 决策有固定开销（实测 6 次合计 4.17 s、13,468 tokens，新鲜输入略高）。小任务上收益主要来自少步数批量化；审计、闸门、账本这些结构优势在只读小任务里用不上。多步长链路、追责复盘、秘密或外部网络操作才真正拉开差距。一句话：**它买的不是"更快"，是"可控、可查、可回退"**。

---

## 7. 变更记录

| 版本 | 说明 |
|---|---|
| `v2.3.1` | 报表数据源改为**会话日志**（与卡片/决策台同源）：`jev-report` 现在统计决策数=66（原 telemetry 仅 32，因只记真实 LLM 调用且去重）、轮数、六维分布、闸门、冻结率、省 token（chunk 去重估算）；telemetry 仅提供每调用 token 用量。新增 `shared/session-report.mjs`、`--sessions/--telemetry/--source` 参数，`--dir` 保留为旧 telemetry 兼容。测试 92→94。 |
| `v2.3.0` | 修复「已是多轮但卡片/决策台仍显示 1 轮」：① 上一版把事件改走 `appendPluginRecord` 后，`import('@deepseek-ai/dsh-session')` 在 link: 安装下解析失败（`_ui-append.json: no host appendPluginRecord`），导致重启后不再写入任何 decision —— 改为优先从 `process.resourcesPath/app.asar/...` 的宿主模块路径导入（同一实例），失败再回退裸包名；② 轮数改取宿主权威 turn 索引（`turn/start.data.turn`），并按 turn/start、turn/end 计轮，某轮无决策也能正确显示；③ 历史日志可用 `repair-logs` 修正被进程内计数器重置写错的 turn 号。测试 90→92 全绿。 |
| `v2.2.9` | 修复「省 tokens」口径与单位：① `fmtTok()` 增加 M/B 档（≥1000k 不再显示 1000.0k，1.026M 显示 1.03M）；② `savedTokens` 改为**按 chunk 高水位去重**——同一 chunk 跨步只计一次增量，不再每步重复累加。实测旧口径虚高约 12–16 倍（e86f7ea1：0.80M→修正 0.06M；261270eb：1.03M→0.045M）。测试 90 项全绿。 |
| `v2.2.8` | **彻底修复「重启后会话打不开」反复问题**：根因是 jev-harness-loop 早期用 `session.append('jev/decision'\|'jev/gate'\|'jev/receipt', …)` 写入宿主不认识的新事件类型且未带 `ignorable:true`，宿主读取器 `validateStoredEvents()` 会因此拒绝解释整份日志。改为走宿主唯一支持的 `appendPluginRecord(session, 'plugin:jev-harness/*', data)` 通道（自动 `ignorable:true`）；客户端同时识别新旧两种类型。新增 `shared/session-log-repair.mjs` + `scripts/repair-jev-session-logs.mjs`（`pnpm run repair-logs`），并在插件启动时后台自愈：把历史 `jev/*` 事件无损改标为 `plugin:jev-harness/*`（自动备份、原子替换、跳过在用文件）。测试 87 → 90 项全绿。 |
| `v2.2.7` | 实时卡与治理回执改为全会话视角：逐轮决策 / 拦截 / KV 复用 / 估算省 token 一行呈现，末尾合计并计算节省比例；深度决策台新增「逐轮汇总」分区，合计指标与品牌水印同步为累计值；切换会话清空逐轮账本。新增 3 项回归测试（共 87 项，86 通过 / 1 既有 HTTP 超时用例取消）。 |
| `v2.2.6` | 卡片改为 head / body / footer 三段结构：头部与指标底固定，只让决策行区域滚动。测试 81 → 82 项全绿。 |
| `v2.2.5` | 卡片逐步流改为渲染全部决策与拦截行，沿用 220px 卡片高度，超出内部滚动；深度决策台新增「实时决策数据流」分区，列出本回合全部决策与拦截（180px 内部滚动）。测试 80 → 81 项全绿。 |
| `v2.2.4` | 决策台布局按 design-taste 规则改为色阶分区（去细线），并新增命中规则举例（paths/keywords/tools/always 各有中文示例）；按 diagram-design 产出 `jev-data-flow.html`（Data Flow 类型，自定义 JEV 皮肤，self_check 与 geometry 双门通过）并在决策台内嵌同款五段数据流。测试 78 → 80 项全绿。 |
| `v2.2.3` | 深度决策台改用与实时卡一致的 `jev-card` 视觉体系（卡片头 / 脉动点 / tag / 指标条 / 盾牌 / 品牌水印）；内容改为中文解释：六维决策逐项说明、Chunk 四档的通俗含义、规则命中原因与空态文案。测试 77 → 78 项全绿。 |
| `v2.2.2` | 实时卡改为逐步流：只渲染最新一步决策与最新拦截，卡片 `max-height:220px` 超限滚动，不再铺满界面；新增 4s 空闲防抖 `settleNow`，无宿主 `turn/end` 时也会在底部切换为「JEV 治理回执」。测试 74 → 77 项全绿。 |
| `v2.2.1` | UI 放置优化：实时介入卡从对话流顶部锚点改到 `conversation.input.dock` 底部常驻条（`jev-dock-sticky`），live Definition 的 `buildViewNode` 返回 null 不再在顶部渲染；新增独立 `receiptDefinition`，按 `turn/end`（及宿主 fallback `jev/receipt`）在流尾锚定「✅ JEV 治理回执」卡。测试 71 → 74 项全绿。 |
| `v2.2.0` | H 分期 Phase 3 深度决策台：按官方两段式契约注册右侧 `sidebarRightTabs` 专属「JEV 决策台」tab（引导页入口 + HUD 点击 `openTab`）；`jev/decision` 旁路事件新增 `chunkLadder`（四档可见性阶梯紧凑投影，不含原文）与 `ruleHits`（条件规则命中），面板可视化分段条、逐 chunk 列表与规则命中列表。README §3.5 同步修正为实际的 `session.append` + Conversation Node 通道（非旧 RPC 轮询）。`package.json` 注入 `@deepseek-ai/dsh-client-ui-sidebar-right`，版本升至 2.2.0；新增 `test/phase3.test.mjs`，测试 67 → 71 项全绿。 |
| `v2.1.0` | 新增实时 Web UI 投影：`shared/live-bus.mjs` 每会话内存环形事件总线 + `connection.rpc` 的 `jev:harness:live` 频道（`hello/probe/since/snapshot`）；`client.js` 渲染「JEV Live」HUD、六维显示模式 pill 与回合回执卡（实时/精简/演示三档，持久化 `localStorage`）。数据只走 UI 旁路、不进 prompt，KV Cache 前缀不受影响，全部 fail-open。`package.json` 增补 `exports["./client"]` 与 `dsh.client`（`platform=web`），`cordis.patch.yml` 末尾新增 `jevharness-ui` 自插入行使 `index.js` / `client.js` 真正进入 bundle；新增 `_ui-diag.json` / `_ui-root.json` / `_client-hello.json` 三段式 UI 自检标记。测试由 59 增至 67 项（新增 `test/live-bus.test.mjs`）。 |
| `v2.0.1` | 修复 4 处实战缺陷：PTC 仓外写只解析写/删调用的路径实参（并对 `path.join`/模板等动态路径做保守兜底、屏蔽注释与字符串里的伪调用，消除误报）；`session/event` 不再把 `Error: JEVHarness blocked…` / `Error: JeV permissions=…` 等门控报错结果回灌成 chunk 喂给 JeV（切断报错反馈自锁），并对工具报错后的子目标锁即释放、陈旧 in_flight 设 TTL；`run_code` 按脚本正文做读写分级（只读脚本不再被 `permissions=deny` 误拦，`spawnSync/execSync/tools.pwsh` 计为非只读）；修正 `jev-chunks` 摘要 Tip 中 `jev_chunk_read` 的参数名为 `chunk_id`。新增 7 项回归单测（共 59 项）。 |
| `v2.0.0` | 对齐 `original.pdf` 全面重构：移除全局单例实现严格多会话隔离；抽离 `shared/` 七大零依赖模块；还原 Table I 题型与双峰尾风险升档；补齐 `run_code` 与脚本正文外联闸门；落地 Chunk 账本 + `jev_chunk_read` + `jev_retrieval_pack`、条件规则引擎、子目标去重与读写锁、KV Cache 文本冻结、异步 JSONL 观测、`jev-report` 报表 CLI 与 52 项自动化测试 + 4 场景基准。 |
| `v1.0.0` | 初版 MVP：基于 `ptc` 预设，提供 `jev_decide` 工具、基础每步六问注入与路径正则闸门。 |
