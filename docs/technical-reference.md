# CoreLatex 技术参考

首次部署、设置管理员账号和恢复备份可参阅[安装与管理员指南](installation-and-admin.md)。日常编辑、编译和 CoreAgent 操作见[用户手册](README.md)。

## 本地开发与验证

在 Linux 上准备基础依赖并进入含 `.nvmrc` 的源码根目录。`npm ci` 按两个子项目的锁文件安装依赖。 [Linux 依赖](installation-and-admin.md#直接在-linux-上运行)

~~~bash
nvm install
nvm use
npm --prefix server ci
npm --prefix web ci
npm run dev
~~~

默认前端在 <http://127.0.0.1:5173>，后端在 <http://127.0.0.1:3333>。Vite 将 `/api` 与 `/collab` 代理到后端。后端更换端口时，在启动开发进程前同步设置 `PORT` 和前端的 `API_TARGET`。 [开发脚本](../scripts/dev.js) · [Vite 配置](../web/vite.config.js)

~~~bash
npm test
npm run smoke
~~~

`npm test` 运行后端的 Node.js 测试和前端的 Vitest 测试。`npm run smoke` 在临时数据目录启动真实服务，使用系统 TeX 的 XeLaTeX 编译，并验证 PDF、SyncTeX、版本和审阅等接口。需要保留冒烟用的数据目录时，可运行 `npm run smoke -- --keep`。 [冒烟脚本](../scripts/smoke.js)

用于生产时，执行 `npm run build` 生成 `web/dist/`，再用 `npm start` 启动由后端统一托管的应用。Docker 镜像和 `.nvmrc` 都固定 Node.js 24.19.0。镜像会换用随源码提供的 Linux x86-64 SQLite 扩展以避开已观察到的原生扩展析构崩溃。升级 Node 或 `better-sqlite3` 时，应一起验证依赖锁文件、目标环境中的扩展和应用运行，并更新 Docker 构建使用的二进制。 [Dockerfile](../Dockerfile)

## 运行配置

| 变量 | 裸机默认值 | Compose 中的行为 |
| --- | --- | --- |
| `PORT` | `3333` | 容器内设为 `3333`。修改对外端口时调整端口映射左侧。 |
| `HOST` | `127.0.0.1` | 容器内设为 `0.0.0.0`，由宿主端口映射控制访问。 |
| `CORELATEX_DATA_DIR` | 源码根目录的 `data/` | `/data`，默认从宿主机的 `./data` 绑定挂载。 |
| `CORELATEX_SEARXNG_URL` | 空 | 读取同名 Compose 插值，默认留空。 |
| `TZ` | 继承系统环境 | `Asia/Shanghai`。 |

裸机部署在进程启动环境或进程管理器中设置变量。Compose 的 `.env` 用于插值，服务实际收到的变量由 Compose 的 `environment` 等配置决定。单个数据目录由一个 CoreLatex 服务进程使用。 [服务配置](../server/src/config.js) · [Compose 配置](../docker-compose.yml)

### 联网搜索后端

如已搭建 SearXNG，请启用其 JSON 搜索响应，并在 Compose 项目的 `.env` 中设置服务地址。以下示例假定应用容器所在的网络可以解析并访问 `searxng`。

~~~dotenv
CORELATEX_SEARXNG_URL=http://searxng:8080
~~~

也可在 Compose 覆盖文件的 `services.corelatex.environment` 中直接设置。容器内的 `127.0.0.1` 指向应用容器自己。修改 Compose 环境后，在维护窗口重建应用容器以载入新值。 [维护发布](installation-and-admin.md#升级与恢复)

CoreAgent 优先使用已配置的搜索服务，必要时尝试公共搜索，并显示实际来源与备用原因。查询中的 arXiv 编号或 DOI 优先按明确标识匹配，避免把查询回显或泛词匹配当作论文结果。检索摘要用来定位出处，核实正文时应打开原文。SearXNG 可以使用管理员预配置的私网地址，CoreAgent 的普通网页读取仍受独立的网络访问控制。 [搜索实现](../server/src/services/webService.js)

## 数据目录和 TeX 运行环境

| 路径 | 内容 |
| --- | --- |
| `corelatex.db` | SQLite 数据库，保存账号、项目和模型配置、版本选择、统计等。 |
| `secret.key` | 登录令牌签名密钥。 |
| `projects/`、`skills/` | 项目工作文件和技能。 |
| `runtime/texlive/<year>/` | 受管 TeX Live 和追加的宏包。 |
| `runtime/fonts/`、`runtime/fonts.conf` | 共享字体及 fontconfig 配置。 |
| `runtime/fontconfig-cache/`、`runtime/matplotlib/` | 应用启动的 LaTeX 和 Python 绘图进程使用的缓存。 |
| `runtime/jobs/`、`runtime/revision` | 安装记录及编译核验使用的环境变更标记。 |

备份和迁移使用整个数据目录，也应保留管理员额外挂载的外部 TeX 安装。版本、宏包和字体安装在 Linux 上使用 `flock` 协调。应用在启动 TeX、技能脚本和绘图进程时传入共享字体配置，安装字体后会刷新缓存。希望外部启动的 Python 使用同样的字体时，需要传入相同的 fontconfig 配置。 [运行环境实现](../server/src/services/runtimeEnvironment.js)

新项目默认使用 TeX Live 2024。管理员可以在「运行环境」管理 2022–2026 年度，或启用已有的编译器目录。旧项目可继续使用「系统 TeX Live（兼容）」。历史年度安装源使用与所选年份对应的冻结仓库。选择的版本不可用或年份不符时，编译会报告对应错误。 [TeX Live 安装步骤](installation-and-admin.md#安装-tex-live宏包与字体)

CoreAgent 的 `inspect_runtime_resources` 可以检查字体和 TeX 环境。拥有项目编辑权限的启用账号可以通过 `install_tex_packages` 为受管年度安装宏包，或通过 `install_font` 安装项目内的字体、从公开 HTTPS 下载字体，下载时可指定 SHA-256。支持 TTF、OTF、TTC，单个文件最多 30 MB。管理员可通过「运行环境」直接管理共享字体、宏包和镜像。 [工具实现](../server/src/services/agent/tools.js) · [运行环境测试](../server/test/runtime-resources.test.js)

字体或宏包变更后需要重新编译。相同的编译输入与所选环境可以继续使用现有编译核验。正式及预览编译启动后按实际运行时长扣减配额。在队列中取消的任务消耗零秒额度。

## 维护门禁和正常停机

执行备份或升级时，使用[安装与管理员指南](installation-and-admin.md#进入维护并备份)中的命令顺序。维护协议要求运行中的 `/api/health` 返回 `maintenanceProtocol: 1`。升级自更早的版本时，用入口隔离覆盖维护窗口，并由运维确认协作已保存和后台任务已结束。

裸机部署用应用的 Node 环境和数据目录运行 `node scripts/maintenance.js status`。Docker 部署在应用容器内执行同一脚本。`status` 读取当前门禁、未结束的智能体运行与编译租约。`acquire` 与任务接纳使用同一 SQLite 写事务，已有运行、等待回答、取消中的智能体任务或编译租约时，先让这些任务结束再试。门禁生效后，新任务会收到尚未启动的提示，编辑器保留输入及附件，重复请求仍可读取原任务。 [维护脚本](../scripts/maintenance.js) · [维护协议实现](../server/src/services/maintenance.js)

`acquire`、`renew`、`release` 使用同一个 `--owner-file`。凭据生成后使用 `0600` 权限，门禁默认 15 分钟。Git、发布日志和共享备份应排除该凭据。`SIGTERM` 等到后台任务结束，再保存协作内容并关闭连接。若协作保存失败，服务保留内存并重试。确认服务正常退出、备份通过校验后再替换镜像，启动并确认健康后解除门禁，随后验证登录、编辑和编译。 [服务关闭流程](../server/src/index.js)

## 编辑器、草稿和统计

- 项目信息提供词数、标题、图表和数学公式等指标。可以用项目标签在同一页面切换，也可通过「另开标签页」、Ctrl/Cmd + 点击或鼠标中键打开独立标签。切换项目会保留各自的编辑器、PDF 与 CoreAgent 状态。关闭工作区后，已启动的服务端 AI 任务仍可在原项目中查看或停止。并行编译的容量取决于宿主机资源及配额。
- 实时协作使用 Yjs。普通断线重连补送本地修改。服务器需要重建协作文档时，浏览器先为尚未确认的文本保存恢复稿，再接收新基线。文件重命名前会等待协作保存。 [协作与恢复操作](editing-and-compilation.md#处理断线与本地恢复稿)
- 正式文件的修改在编辑工具报告成功前写入检查点。隔离预览编译使用磁盘基线和当前暂存稿，生成的 PDF 对应该草稿。异常退出后，同一用户在原项目、原会话接续时可恢复未应用的检查点。提案的应用和放弃绑定审阅时的版本。冲突旧稿可下载后与现有内容核对。 [改稿与恢复操作](coreagent-and-usage.md#中断冲突与误改)
- 聊天记录和统计独立保存。清空会话后仍可查询已记录的模型、工具和 Skill 用量。工具调用计入 `tool_usage`。 [用量口径](coreagent-and-usage.md#读懂用量指标)

## 模型和多智能体工作流程

新增模型默认提供 `low`、`medium`、`high`、`xhigh` 四个思考强度档位。可按供应商能力增删档位，包括 `max` 或自定义值。全部移除后使用模型默认调用行为。CoreAgent 按已选模型展示档位，并按账号和浏览器保留选择。 [配置模型](coreagent-and-usage.md#配置模型)

同一会话换用不同模型时，下一轮请求先由新模型整理已有历史。容量较小的模型可以分段汇总，成功后才更新摘要。失败或取消时保留原有记录和接续位置。仅调整思考强度时继续使用同一模型的历史。已有会话首次升级时会建立模型记录并整理历史，空会话直接开始。 [会话上下文实现](../server/src/services/agent/context.js)

### 子智能体的模型设置

在「设置 → 智能体设置」开启多智能体协作后，可按账号为子智能体设置模型和思考强度，从下一轮开始使用。默认跟随本轮主模型。指定独立模型时，用该模型所属供应商的连接、上下文窗口、最大输出、温度和图像能力。思考强度选自动时，跟随主模型继承本轮档位，独立模型使用自身默认档位。

分析、查证、审阅和验证子任务分别记录输入、输出和缓存用量。子任务从实际开始执行起有十分钟调查时间，随后进入「正在汇报」，完成已开始的请求或工具后汇报结果、依据和剩余事项。单次请求使用相应模型的容量和超时设置，上下文会做整理。模型服务拒绝大请求时，子任务尝试用精简证据汇报。旧部署使用的 `CORELATEX_SPECIALIST_TOKEN_BUDGET` 可以移除。 [子任务执行实现](../server/src/services/agent/specialistAgent.js)

### 子智能体并行编辑

将协作档位设为「深入 · 允许并行编辑」后，主智能体可调用 `run_parallel_edits`。每批接受 2–4 个任务，最多同时执行 2 个。每项有 `id`、`task` 和 `scope`。范围用项目相对路径，或指定现有文件的一基闭区间 `startLine` 至 `endLine`。新文件使用整文件范围。提交前先读取现有目标文件，确保同一文件内的分派范围互不重叠。

各编辑子智能体从同一父草稿快照取得独立暂存区。收齐报告后，主智能体检查范围、父草稿版本和协作文件，再统一合并到待审草稿。若失败或冲突，工作过程会给出已保留的独立草稿位置。合并后的修改进入同一套审阅与编译验证。 [并行编辑实现](../server/src/services/agent/parallelEdits.js)

### 审阅、验证与交付

子智能体审阅聚焦本轮改动引入的事实错误、与正文或明确要求的冲突。要求修正时需要给出具体位置和依据。纯资料查询可以直接核验资料，文稿审阅和编译验证分别处理适用的任务。相同输入和范围可以沿用仍有效的子任务结果，草稿变更后需要核对更新的内容。

需要审阅或编译的任务先完成相关核查，再按「修改需确认后应用」的设置保存提案或应用修改，最后显示交付说明。若任务取消、权限失效、核验受阻或保存失败，交付说明会报告实际进展以及可恢复的草稿。 [工作流程说明](orchestration-runtime.md) · [文件核验机制](orchestration-file-freshness.md)

## 源码目录

| 目录或文件 | 用途 |
| --- | --- |
| `server/` | Express API、SQLite、Yjs 协作、LaTeX 编译和 CoreAgent。 |
| `web/` | Vue 3、Vite、CodeMirror 6 和 PDF.js 前端。 |
| `scripts/` | 开发、冒烟和部署维护脚本。 |
| `docker/`、`Dockerfile` | 运行镜像定义、SQLite 原生扩展和额外 TeX 文件。 |
| `docker-compose.yml` | 端口、持久化数据卷、健康检查与重启策略。 |
| `docs/` | 用户手册、安装指南和开发参考。 |

界面设计参考了 Overleaf 的交互思路，代码为独立实现。
