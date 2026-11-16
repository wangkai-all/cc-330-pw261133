# 赛果编排台（Fictional Tournament Desk）

一个**完全虚构**的赛事积分与排名工作台：从空目录实现，用于演示"分组赛 + 加赛 + 处罚 + 申诉追溯 → 多层对赛子集排序 → 版本报告 → 网页操作"。

> 本项目中所有赛事、队伍、规则、判罚与申诉均为虚构示例，**不引用任何真实赛事规则**。规则内容全部由 `seed/season.json` 提供，全部为项目自造。界面与报告的措辞也明确标注"虚构规则"。

## 快速开始

```bash
npm start            # 启动 http://127.0.0.1:8787 （首次启动自动建库并载入种子）
npm test             # 规则引擎 22 项 + HTTP 并发/一致性 7 项（Node 内置 test runner）
npm run seed -- --reset   # 重建数据库并重新载入种子（会删除 data/tournament.db）
```

要求 Node.js ≥ 22.13（使用内置 `node:sqlite`；服务端无第三方运行时依赖，`jsdom` 仅为网页冒烟测试的开发依赖）。浏览器端为原生 HTML/CSS/JS，无构建步骤。

### 网页端冒烟测试

`tests/ui.smoke.mjs` 把真实的 `public/index.html` 装进 DOM（jsdom 仅作为开发依赖，不进入运行时依赖），
直接 `import('../public/js/app.js')` 启动与浏览器完全相同的模块，然后对着运行中的服务端逐项操作：
5 个视图渲染、排序依据抽屉、提交申诉、登记追溯裁决、情景试算与两情景对比、人工确认、历史已知视图切换，
共 56 项断言；其中"追溯裁决后历史视图不变、修订链新增追溯版本"是直接对 API 复查的。

```bash
npm run seed -- --reset                     # 测试会写库，先重置到干净种子
PORT=8799 QUIET=1 node server/index.js &    # 或在另一个终端启动
BASE_URL=http://127.0.0.1:8799 npm run test:ui
```

> jsdom 不会执行 `<script type="module">`，所以测试改为在 Node 中安装 DOM 全局对象后直接导入前端模块；
> 这与浏览器走的是同一份代码，不存在只测桩的情况。

## 需求到实现的映射

| 需求 | 实现 |
| --- | --- |
| 合并分组赛、加赛（play-in/tiebreak round）、处罚、申诉结果 | `server/standings.js`：以 `match` 为事实源，加赛以 `stage='playin'` 的比赛参与积分；`penalty` 表扣分/判负；`appeal` 通过**修订记录**影响比赛与处罚 |
| 积分相同按"规定的对赛子集"逐层比较，不只按净胜分 | 规则版本中的 `tiebreakerPlan` 为有序步骤，每步指定 `scope`（全组 / 同分区 / 对赛子集 / 跨组）与指标；见下文"排序算法" |
| 规则会换版 | `ruleset_version` 表 + `season.rule_version_id`；报告记录所用版本哈希；情景可试算"若换版" |
| 申诉有追溯生效日期 | 申诉裁决写入修订行，同时带 `recorded_at`（登记时刻）和 `effective_at`（生效时刻）；`effective_at < recorded_at` 即为追溯。历史视图只采纳"登记时不晚于生效"的修订，最终视图采纳全部已生效修订 |
| 历史已知排名与最终更正排名分开 | 每次重算为受影响分区各产 `as_known` / `final` 两条 `ranking_snapshot`；网页顶部可切换两种视图，报告并列呈现 |
| 增量维护名次 vs 重算受影响组 | `server/recompute.js`：**组边界增量、组内全量**。一次写入只影响"该比赛/处罚所属分区 + 跨组外卡池"，只重算这些分区并落两份快照；快照带 revision 水印，迟到计算不会覆盖更新的快照 |
| 并列循环 | 对赛子集内出现循环（A>B>C>A）或指标完全相同 → 该步不能打破并列，记录 `cycle.detected`/`blockedByCycle`，下一层继续；最终仍并列则同一位次并标记 `tied` |
| 跨组比较 | 只在规则显式声明 `crossGroup.enabled` 时比较不同组（如"最佳第二名"），否则明确 `cross_group_not_defined` 保留待定 |
| 无法确定晋级时明确保留待定 | `qualification`: `qualified` / `eliminated` / `pending`，`pending` 带原因码（`tie_unresolved`、`rank_tie`、`cross_group_pending`、`cross_group_tie`、`cross_group_not_defined`、`candidate_ambiguous`） |
| 赛果更正、人工确认、多个情景试算并发 | 写操作走 `BEGIN IMMEDIATE` 事务 + 单调 `revision` 乐观并发控制；旧 `baseRevision` 的更正/裁决被拒绝（409），确认被拒绝并提示当前 revision；情景试算在内存副本上执行 |
| 试算不写正式积分 | 情景 API 读取正式状态后 `structuredClone` 到内存副本中应用假设，仅追加 `scenario_run`；测试断言 `match/match_revision/penalty/penalty_revision/ranking_snapshot` 计数与 revision 均不变 |
| 真实网页、录入申诉、查看排序依据、对比情景、恢复中断 | `public/` 下单页应用 + REST API；申诉/情景草稿自动保存在 localStorage 并同步服务端 `draft`，`import_batch` 游标支持中断续跑 |
| 不引用未给出的真实赛事规则 | 规则全部来自 `seed/season.json`，字段为自定义结构；不含任何真实联赛/杯赛名称或条款 |

## 排序算法（`server/standings.js`）

1. **基础积分**：每个 `group` 内按 `match`（`status='final'` 且已生效）累计 `points`，再叠加 `penalty`（`point_deduction`、`forfeit`）。处罚以"修订链"表达：`penalty_revision` 保留每次变更与 `effective_at`。
2. **分层排序**：`tiebreakerPlan.steps` 是有序数组。每一步：
   - `scope: 'all'`：整个组（含不同小组编号）内比较；
   - `scope: 'same_section'`：仅同一 `section`（如 A 组内）；
   - `scope: 'head_to_head'`：只在**当前并列集合**内、且是这些队伍之间已完赛的比赛构成的对赛子集里比较（`subset` 参数可限定 `stage`，如只算分组赛、或"分组赛+加赛"）；
   - `scope: 'cross_group'`：跨组比较，需规则显式允许；输出 `cross_group` 证据。
   - 指标：`points`、`goal_diff`、`goals_for`、`wins`、`disciplinary`（红黄牌折算）、`draw_lots`（规则声明的确定性种子）。
3. **循环检测**：对赛子集比较时，若并列集合内出现非传递的胜负关系（A 胜 B、B 胜 C、C 胜 A）且该步指标仍无法区分，标记 `cycle.detected=true`、`blockedByCycle=true` 并停止在该步排序（不臆造顺序），进入下一步；记录 `cycle.path` 作为证据。
4. **待定**：所有步骤耗尽仍并列 → 组内同一位次（`rank` 相同，`tied=true`）；若并列跨越晋级线 → 相关队伍 `qualification='pending'`，原因 `rank_tie`；若该步本身无解，原因 `tie_unresolved`。
5. **跨组名额**（如"最佳小组第二"）需要 `crossGroup.enabled`；缺少该声明时名额 `pending`，原因 `cross_group_not_defined`；候选人不唯一时 `candidate_ambiguous`；在跨组步骤上仍并列时 `cross_group_tie`。系统从不在规则无法区分时指定晋级者。

排序证据以 `trace` 结构返回/落库：每步的输入集合、指标值、产生的分组（`buckets`）、是否 `cycle`/`unresolved`。网页"排序依据"面板渲染该 trace。

## 版本与时间线

- `ruleset_version`：不可变版本行（`id, season, label, valid_from, definition_json, content_hash, supersedes_id`）。赛季引用一个版本；换版后旧版本仍可查、可用于情景试算。
- 修订的 `recorded_at` / `effective_at`：基础 `match`/`penalty` 行永不覆盖，更正只追加 `match_revision`/`penalty_revision`。因此同一数据库可以同时产出：
  - **历史已知排名**（`as_known`）：只采纳 `recorded_at <= effective_at` 的修订，即裁决登记时已公知的结果；
  - **最终更正排名**（`final`）：采纳全部 `effective_at` 已到的修订，含追溯裁决。
- 报告（`GET /api/report`，由 `server/http.js` 汇总）输出两套排名、规则版本、差异、申诉链与每条修订的生效边界。

## 并发与一致性

- 所有正式写操作（赛果录入/更正、处罚、申诉登记与裁决）在 `BEGIN IMMEDIATE` 事务内校验客户端 `If-Match`/`X-Base-Revision`/`body.baseRevision`；不匹配返回 `409 stale_revision`（附 `currentRevision`），旧结果无法覆盖新裁决。
- 幂等：每个写请求可带 `requestId`（或 `x-request-id`），重放直接返回首次结果并标记 `replayed: true`，不会重复记账。
- `confirmation` 记录"人工确认"动作：确认绑定当时的 revision 与快照哈希，**不冻结计算也不递增 revision**；任何后续正式写入都会使它过期（网页横幅提示需重新确认）。
- 情景试算（`POST /api/scenarios`）在 `structuredClone` 出的内存状态上应用假设赛果/换版规则，只追加 `scenario_run` 并留审计；测试断言正式表与 revision 完全不变，两个情景可并存并对比。

## 断点恢复

- 前端把未提交的申诉/情景表单写入 localStorage（带 `savedAt`），并同步 `PUT /api/drafts/:key`；刷新后自动回填。
- 服务端写请求的 `request_id` 幂等键让网络重试安全。
- 批量导入以 `import_batch` 记录游标，`POST /api/imports/:id/apply` 每次应用一条，中断后从游标继续；已完成的批次再次调用返回 `alreadyComplete`，不会重复录入。

## 目录

```
server/          引擎、HTTP、SQLite
  db.js           模式、revision 计数器、事务
  state.js        按 asOf/historical 重放修订链得到状态
  rules.js        规则版本、校验、派生的试算变体
  standings.js    排序引擎（分层对赛子集、循环、跨组、待定）
  recompute.js    受影响分区闭包与双视图快照
  appeals.js      申诉链、时间线、裁决写入
  scenarios.js    情景（内存副本，只写 scenario_run）
  writes.js       赛果/处罚/申诉/确认的正式写入
  http.js         路由、静态文件、并发契约
  seed.js         虚构种子装载
  index.js        启动入口
public/          单页网页（index.html / styles.css / js/）
seed/            虚构规则与赛果（season.json）
tests/           engine.test.js（引擎）、api.test.js（HTTP 契约）、ui.smoke.mjs（网页）
scripts/         seed.js CLI
```

## 虚构声明

种子中的队伍名如"北岸汽笛""纸鸢联"等、规则名如"复核赛程手册 v1/v2"均为虚构；任何与现实赛事相似之处纯属巧合。项目不实现、不复述任何真实赛事的规则条款。
