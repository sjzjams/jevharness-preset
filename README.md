# JEVHarness 自定义预设（v2.0.0）

> 把《JEV ENGINEERING FOR CODING AGENTS》（2026 工作笔记）转化为 DeepSeek Harness 可执行插件架构的 Agent 预设。
> 通过**按会话严格隔离**的显式类型化状态账本，在每步模型生成前批量向 TypeSafe JeV 询问 Table I 六大决策与 per-chunk 可见性，并由确定性代码执行安全闸门、条件规则挂载、子目标去重/读写锁与异步 JSONL 可观测。

- 声明 id：`jevharness`
- 显示名：`JEVHarness`
- Bundle：`@local/dsh-jevharness-preset`（`v2.0.0`）
- 基础：官方 `ptc` 预设 + 零外部依赖纯 Node 20+ ESM 插件层
- 依据：《JEV ENGINEERING FOR CODING AGENTS》（Diogo Almeida / TypeSafe 设计笔记综合版）

---

## 1. 目录结构

```
jevharness-preset/
├─ package.json                  # v2.0.0 bundle 清单与 test / bench / report 脚本
├─ cordis.patch.yml              # 预设声明、v2 persona 契约与顶层插件配置
├─ shared/
│  ├─ gateway.mjs                # 共享 Magpie System One 网关客户端与 .env Key mtime 缓存
│  ├─ answers.mjs                # Table I 题型构造、双峰尾风险解析、置信度分桶与旧格式兼容
│  ├─ policy.mjs                 # §IV.A 权限/PTC/脚本正文外联闸门、Table IV 路由信任矩阵、§II.A 成本公式
│  ├─ chunk-store.mjs            # §I/§V/§X 显式类型化 Chunk 账本、可见性阶梯与只读共享检索包
│  ├─ conditional-rules.mjs      # §VIII 目录 FOOTGUNS.md 与 .jev/rules/*.md 条件加载器（免疫 compaction）
│  ├─ subgoal-tracker.mjs        # §VI.A 并发路径读写锁 + §VI.B 子目标去重
│  └─ telemetry.mjs              # 异步队列 JSONL 日志与离线指标汇总器（兼容旧 .md）
├─ jev-decide-tool/
│  ├─ package.json
│  └─ index.mjs                  # jev_decide 工具（复用 shared/gateway.mjs）
├─ jev-harness-loop/
│  ├─ package.json
│  └─ index.mjs                  # 主循环插件：每步决策、闸门、条件规则与 jev_chunk_read / jev_retrieval_pack
├─ scripts/
│  └─ jev-report.mjs             # 本地观测报表 CLI + 静态 HTML 仪表盘生成器
├─ bench/
│  └─ suite.mjs                  # 4 类标准化离线回归基准套件
└─ test/                         # 59 项原生 node:test 单元测试与端到端集成测试
```

---

## 2. 安装 / 更新 / 本地验证

安装或更新到 DSH：

```
plugin_manager action=remove_bundle target=@local/dsh-jevharness-preset
plugin_manager action=install_bundle target=<绝对路径>\jevharness-preset
```

> 插件代码改动（`.mjs`）会被宿主进程缓存，**更新后需重启 DSH 一次**以加载新版本。

本地开发验证（零外部依赖，Node 20+ 即可运行）：

```bash
# 运行全部 59 项单元测试与端到端集成测试
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

---

## 4. 可观测与报表

- 默认异步写入 `~/.dsh/jev-decisions/<safeSessionId>.jsonl`（零同步全量读盘，记录决策、延迟、JeV Token、缓存冻结率、条件规则命中与闸门拦截事件）。
- `node scripts/jev-report.mjs --out jev-report.html` 可一键生成兼容新旧日志（`.jsonl` + 历史 `.md`）的自包含离线仪表盘。

---

## 5. 已知宿主边界（非插件层能力）

以下三项需 DSH 宿主内核未来开放对应 Hook，当前插件层已最大化逼近但无法越权接管：

1. **历史 Transcript 消息数组重装配**：插件层通过 `jev-chunks` + `jev_chunk_read` 管控增量工具输出，但无法直接改写宿主已提交的历史对话数组。
2. **主循环自动切模型**：插件层已实现 `subagent` 路由信任门控，主会话自动切换需宿主开放无重入的 step 级模型切换 API。
3. **全量内置/MCP 工具 Schema 热装卸**：`system-prompt/assemble` 仅建议保持工具目录稳定以护 KV Cache，全量工具分层卸载需宿主支持。

---

## 6. 变更记录

| 版本 | 说明 |
|---|---|
| `v2.0.1` | 修复 4 处实战缺陷：PTC 仓外写只解析写/删调用的路径实参（并对 `path.join`/模板等动态路径做保守兜底、屏蔽注释与字符串里的伪调用，消除误报）；`session/event` 不再把 `Error: JEVHarness blocked…` / `Error: JeV permissions=…` 等门控报错结果回灌成 chunk 喂给 JeV（切断报错反馈自锁），并对工具报错后的子目标锁即释放、陈旧 in_flight 设 TTL；`run_code` 按脚本正文做读写分级（只读脚本不再被 `permissions=deny` 误拦，`spawnSync/execSync/tools.pwsh` 计为非只读）；修正 `jev-chunks` 摘要 Tip 中 `jev_chunk_read` 的参数名为 `chunk_id`。新增 7 项回归单测（共 59 项）。 |
| `v2.0.0` | 对齐 `original.pdf` 全面重构：移除全局单例实现严格多会话隔离；抽离 `shared/` 七大零依赖模块；还原 Table I 题型与双峰尾风险升档；补齐 `run_code` 与脚本正文外联闸门；落地 Chunk 账本 + `jev_chunk_read` + `jev_retrieval_pack`、条件规则引擎、子目标去重与读写锁、KV Cache 文本冻结、异步 JSONL 观测、`jev-report` 报表 CLI 与 52 项自动化测试 + 4 场景基准。 |
| `v1.0.0` | 初版 MVP：基于 `ptc` 预设，提供 `jev_decide` 工具、基础每步六问注入与路径正则闸门。 |
