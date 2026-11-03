# MCP Connector · `@local/dsh-mcp-connector`

DSH 插件：在 Cordis 运行时内实现一个 **MCP Client 能力 Seam**，把独立进程或远程端点里的外部 MCP 服务器工具，动态映射到 DSH 的工具运行时。设置里的「MCP Connector」分区提供服务器注册表的增删改查、连接测试、状态诊断与 JSON 导入导出。

插件显示名固定为英文 `MCP Connector`（由包名 `@local/dsh-mcp-connector` 派生，与 DSH 自身插件命名一致），正文文案仍按界面语言本地化。

全部能力以标准 MCP 协议通信，不替换原生对话入口，不引入第二套工具调用方式：发现的工具直接长成 `mcp__<serverName>__<toolName>`，对模型与既有工具调用链完全透明。

| 需求 | 落地 |
|---|---|
| 符合 Cordis 插件模型 | 函数形态具名导出 `name` / `inject` / `apply` / `Config`；一切资源走 `ctx.effect` 的 disposer 链 |
| 配置面分离 | 部署策略在 Cordis `Config`（改动即 HMR 重挂）；每台服务器的连接参数在**运行时注册表**（增删改只换一条连接，插件不重挂） |
| MCP 协议合规 | JSON-RPC 2.0、`initialize` 握手、能力协商、会话生命周期、`tools/list` 分页、`tools/call` 三类错误分流、`_meta` 透传 |
| 双传输 | stdio（换行分隔 JSON-RPC，stderr 独立捕获）+ Streamable HTTP（`Accept`/`Mcp-Session-Id`/`MCP-Protocol-Version`），并对旧版 HTTP+SSE 做**协商降级** |
| 工具面映射 | `ctx.tools.register` 注册 `mcp__<server>__<tool>`，公共名归一化与官方 `@deepseek-ai/dsh-mcp-client` 完全一致（含截断 + 身份哈希） |
| 运行时 CRUD | 添加 / 编辑 / 删除 / 启用禁用 / 单条重试 / 工具刷新，全部返回操作回执 |
| JSON 兼容 | 导入 `{"mcpServers":{…}}`、`{"servers":{…}}`、裸 map、单条对象、对象数组；导出三种结构；**先校验后写**，失败逐条报因、不部分写入 |
| 连接测试 | 草稿参数在临时连接中完成 `initialize` + `tools/list` 后立即释放，独立超时，不写库、不动运行时、不触发 `tools/call` |
| 状态机 | `draft / connecting / initializing / ready / degraded / reconnecting / error / disabled`，`ctx.emit` 广播，状态不落盘 |
| 结构化诊断 | `{code, phase, message, detail}`，覆盖配置 / 传输 / 协议 / 会话 / 调用五域；展示前对 `env`、`headers`、stderr 脱敏 |
| 可观测性 | 同源健康端点 `GET /dsh-mcp-connector/health`，连接成功率、工具调用计数、运行时长、重连次数 |

## 安装

把本目录作为 bundle 装进 profile：`package.json` 增加 `link:` 依赖、`dsh.profile.bundles` 增加 `@local/dsh-mcp-connector`，然后 `pnpm install`。宿主下次启动时按 `cordis.patch.yml` 挂载一行 Host 插件；`package.json` 的 `dsh.client` 让 Web 端加载 Client 半边。

```yaml
# cordis.patch.yml（本 bundle 自带）
- insert:
    - id: dsh-mcp-connector
      name: '@local/dsh-mcp-connector'
      config:
        enabled: true
        defaultTimeoutMs: 30000
        probeTimeoutMs: 10000
        toolCallTimeoutMs: 60000
        allowedTransports: [stdio, streamable-http]
        registry: { enabled: true, persist: true, dataDir: '' }
        reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 }
```

## 使用

**设置 → MCP Connector**（顶层设置分区，与「常规」「模型」并列）。页面分四块：

1. **概览**：服务器数、就绪数、工具数、调用数，以及当前部署策略（传输白名单、超时、注册表位置）。
2. **工具栏**：搜索框（按名称 / 地址 / 命令 / 工具名过滤，Esc 或 × 清空）、刷新、导入 JSON、导出 JSON、添加 MCP。
3. **服务器列表**：每行是状态徽标 + 服务器名 + 工具数 + 传输与端点 + 最近成功时间 + 最近错误摘要。行内只常驻两个高频动作 —— **测试连接**、**编辑**；重试 / 启用停用 / 删除收进 `⋯` 溢出菜单，删除仍需二次确认。点服务器名展开详情（配置、工具、凭据状态、诊断），可一键复制工具名 / 配置 / 诊断 JSON。
4. **添加 / 编辑弹窗**：模态卡片，带「表单」（`表单` / `JSON` 双标签）：

   - **表单**：MCP 名称（命名空间，创建后不可改）、传输类型、超时时间（毫秒，可选）、服务地址（HTTP）或命令 / 参数 / 环境变量 / 工作目录（stdio）、请求头行列表；每个字段有内联校验，错误就显示在控件下方而不是只给一条汇总；
   - **请求头行**：`+ 添加 Header` 新增一行（Header 名称 / 值 / 删除）；令牌填入后点钥匙图标即写入 DSH 凭据库，单元格变为 `${credential:REF}` 的掩码，旁边的重置换按钮可清空重填。非敏感头直接写字面值即可；
   - **JSON**：直接编辑该服务器的 JSON（`{"<serverName>": {…}}` 或裸配置），切回表单会应用能解析的内容；非法 JSON 就地报错且不覆盖草稿；
   - **底部**：添加 MCP（编辑时为「保存 MCP」）/ 测试连接 / 取消；Esc 关闭，关闭后焦点回到触发按钮。测试结果与保存后的真实挂载结果分别展示——测试不通过不阻止保存（部分服务器依赖编辑机上不存在的环境）。

界面细节遵循设置页既有规范：全部使用语义主题令牌（浅/深色自动适配）、结构图标为 16px 矢量（不用 emoji）、图标按钮 28×28 触控目标、加载时显示骨架行、`prefers-reduced-motion` 下关闭动画。

一个 stdio 例子：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/work"]
    }
  }
}
```

一个 HTTP 例子：

```json
{
  "mcpServers": {
    "notes": {
      "type": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${NOTES_TOKEN}" }
    }
  }
}
```

## 协议实现

### 传输

- **stdio**：`command` 先按 `PATH` / `PATHEXT` 解析成绝对路径（`ENOENT` → `COMMAND_NOT_FOUND`，不可执行 → `COMMAND_NOT_EXECUTABLE`），再启动子进程；stdout 按行做 JSON-RPC 分帧，stderr 进有界环形缓冲供诊断；关闭时先 `SIGTERM`，宽限期后 `SIGKILL`，并等待退出事实。Windows 的 `.cmd` / `.bat` shim 走 `cmd.exe /c`。环境按 subprocess seam 同一规则清洗（丢弃凭据形状的变量与全部 `DSH_*`），再合并用户声明的 `env`。
- **Streamable HTTP**：每个消息 `POST` 到单端点，`Accept: application/json, text/event-stream`；响应可以是 JSON 或短 SSE 流；`Mcp-Session-Id` 从响应头捕获并在后续请求回传，`MCP-Protocol-Version` 跟随协商结果。
- **HTTP + SSE 旧传输**：长连接 `GET` 等 `endpoint` 事件，`POST` 到该地址，回包走流。可通过 `type: "sse"` 显式选择，也在流式端点返回 404/405 时作为降级路径使用。

### 版本协商

客户端声明自己支持的最新修订（`2026-06-18` → `2024-11-05`），服务器返回它选定的一版；`revisionProfile()` 把协商结果映射到两种会话语义：

- 2025 系列 → `sessioned`：服务器可下发 `Mcp-Session-Id`，丢失视为会话故障；
- 2026 及以后 → `stateless`：请求自足，没有会话 id 是正常情况。

返回未知但格式合法的修订时，连接仍建立但标记 `degraded` 并在备注里说明；格式非法则直接 `PROTOCOL_INCOMPATIBLE`。能力协商结果里没有 `tools` 时，连接可用、工具列表为空，同样标记 `degraded`。

### 错误分流

| 类别 | 处理 |
|---|---|
| 协议错误 | JSON-RPC `error` 按码分流：`-32601` → `METHOD_NOT_FOUND`、`-32602` → `INVALID_PARAMS`，其余 `PROTOCOL_ERROR` |
| 工具业务错误 | `tools/call` 返回 `isError: true` → 抛 `TOOL_ERROR`，携带文本，模型看到的是失败调用 |
| 传输失败 | 子进程退出、stdout 非 JSON-RPC 帧、DNS/TCP/TLS、HTTP 401/403、404、5xx、SSE 中断，各有独立 code 与 `phase` |

诊断对象形如：

```json
{
  "code": "HTTP_AUTH",
  "phase": "transport",
  "message": "鉴权失败（HTTP 401）：检查 headers 中的凭据",
  "detail": { "status": 401, "url": "https://…" }
}
```

`phase` 取 `config / transport / handshake / capabilities / tools / session / call`，UI 直接按阶段定位故障域。

## 数据与状态

- 注册表落在 `<DSH_HOME>/mcp-connector/registry.json`（可用 `registry.dataDir` 覆盖），单文件、带 `version`、原子写（临时文件 + rename）。损坏的文件不删除，另存 `registry.corrupt-<ts>.json` 供人工恢复。
- 记录形如 `{ id, serverName, disabled, config, source, createdAt, updatedAt }`；`serverName` 是工具名前缀，生命周期内不可变，改名走「删除后重建」。
- **状态是运行期产物**，不写盘：`lastSuccessAt`、`lastError`、重连计数、调用计数都在内存里，重载即重新探测。
- 默认不做心跳；`probeIntervalMs > 0` 可开启周期探测。断线按指数退避重连（`reconnect`），次数用尽后停在 `error` 并要求手动重试。

## 凭据与密钥

令牌不进注册表。任何 `headers` 或 `env` 的值都可以写成引用：

```json
{
  "type": "streamable-http",
  "url": "https://example.com/mcp",
  "headers": { "x-api-key": "${credential:EXAMPLE_TOKEN}" }
}
```

- 落盘、导出、界面展示、诊断都是以 `${credential:EXAMPLE_TOKEN}` 这个占位符出现，**不是明文**；
- 每次连接/探测时才解析：先问 DSH 凭据服务（`ctx.credentials.resolve`），再退回同名环境变量；
- 轮换令牌只改凭据，连接下一次重连或「测试连接」即生效，**不改配置文件、不重启**；
- 引用解析不到时返回结构化诊断 `CREDENTIAL_MISSING`（`phase: config`），列出缺哪些引用，而不是一个莫名的 401；
- 部署没有凭据服务时 `CREDENTIAL_UNAVAILABLE`，提示改用同名环境变量。

存凭据两条路：

| 方式 | 操作 |
|---|---|
| 设置页「鉴权」行 | 左选头名（`modao-token` / `Authorization` / `X-Api-Key` / `X-Auth-Token`，固定库不可自由输入）→ 右填令牌（掩码，可「显示/隐藏」）→ **存入凭据并应用**。保存即写入凭据库，同时把该请求头替换成 `${credential:MCP_<服务器>_<头名>}` 并热更新连接。保存后输入框消失，只显示「已绑定 …」与配置状态——值已离开前端，无法回看。 |
| 环境变量 | 直接设置同名变量后重启宿主（宿主启动时继承环境） |

鉴权行只接管**一个**请求头；租户、版本、`mcp-protocol-version` 这类非敏感头仍写在「其他请求头」多行编辑区里，两者互不影响（同一份文本，鉴权行按行定位）。想换头名或换成明文，点「更换」会移除该行，之后可重新输入。

快照里每个服务器会带 `credentialRefs`，接口 `GET /dsh-mcp-connector/api` 的 `credentials` 字段给出每个引用的 `configured` 与 `source`（`credentials` / `environment` / `missing`），详情页据此显示「已配置 / 未配置」。

## 导入导出

导入接受四种结构（含 VS Code 的 `{"servers": {…}}`），字段方言做归一化：

- 传输：`type` / `transport` / `kind` / `protocol`，值兼容 `stdio` / `local` / `http` / `streamable-http` / `sse` 等拼写；省略时按 `command` 或 `url` 推断；
- stdio：`command` / `cmd` / `executable`，`args` / `arguments` / `argv`（数组或一行带引号的命令串），`env` / `environment` / `envVars`，`cwd`；
- HTTP：`url` / `endpoint` / `baseUrl`，`headers` / `httpHeaders`。

`serverName` 必须匹配 `[A-Za-z0-9_-]{1,32}`；导入内重复、与现有条目冲突都会逐条报错。**只要有任意一行未通过校验，本次一条都不写入**，返回 `rejected[]` 让界面逐行展示。

写入方式两种：`merge` 按名字 upsert；`replace` 全量覆盖——新增、更新、删除在一次写入里原子完成。导出支持 `{"mcpServers": {…}}`（默认）、裸 map、对象数组。

## 可观测性

| 端点 | 内容 |
|---|---|
| `GET /dsh-mcp-connector/api` | 完整快照：部署策略、每台服务器的状态/诊断/工具/统计 |
| `POST /dsh-mcp-connector/api` | `{ action, payload }`，动作：`addServer` `updateServer` `removeServer` `setDisabled` `retryServer` `refreshServer` `testConnection` `importJson` `exportJson` `health` |
| `GET /dsh-mcp-connector/health` | 健康摘要：`ok`、各状态计数、工具数、调用数/失败数、运行时长 |
| `GET /dsh-mcp-connector/config` | 部署策略（传输白名单、超时、注册表位置） |

## 生命周期

加载即注册，卸载即清理，没有独立 start/stop：

- 注册表运行时在一个 `ctx.effect` 里创建，其 disposer 依次清定时器、关连接、逆序注销每一代工具；
- 每代工具注册的 disposer 由 `ctx.tools.register` 返回并保管，断线、换版本、删除、禁用都会逆序执行；
- 每条连接的关闭都会等待子进程退出事实（stdio）或流取消（HTTP），不留孤儿进程；
- 事件通过 `ctx.emit('mcp-connector/state' | '/added' | '/removed' | '/tools')` 广播，页面另以 3 秒轮询同源 API 作为主通道。

## 设计说明与取舍

**为什么不直接包一层官方 `@deepseek-ai/dsh-mcp-client`？**
本插件的 Host 半边从 profile 目录加载，而官方包只存在于应用自身的 `app.asar` 依赖树里，profile 侧没有可解析的路径；把它声明成依赖会把 Cordis / dsh-tools 的副本一起拉进来，造成双份运行时身份。因此传输、握手与工具桥接在本插件内自实现，并通过 `lib/connection.js` 的 provider 接缝保持可替换：若将来 profile 能解析官方包，只需替换 `createTransport` / `registerServerTools` 两处实现，Registry、状态机、UI 与 API 完全不动。

**配置为什么拆两层？**
`Config` 是部署策略，改动需要 HMR 重挂；服务器连接参数是运维动作，天天变。若把服务器放进 `Config`，每次加一个 server 都会重挂整个插件并重建所有连接。因此注册表独立成运行时状态，只有它变化时受影响的单条连接被替换。这也意味着 YAML 不是服务器配置的第二真源——注册表就是唯一真源，避免存储态与运行态漂移。

**为什么 JSON Schema 镜像？**
`Config` 以 Standard Schema v1 暴露 `~standard.validate`（Cordis 用它解析行配置），同时提供 `Config.schema` 供设置表单与静态目录工具读取，无需执行插件代码。

**为什么页面是顶层设置分区？**
它管理的是外部服务器连接，属于运维台而不是某个内置插件的配置页；挂进「内置插件」页的 tab 会让它在设置导航里几乎不可发现。因此注册 `settings.section`（与已安装的外观插件同一槽位、同一 shape），设置侧栏直接出现「MCP 连接器」。

**管理 API 为什么用 `ctx.inject(['webServer'])`？**
`webServer` 是同层的兄弟服务，可能在插件行激活之后才就绪。只在 `apply` 时 `ctx.get('webServer')` 一次，会在这个顺序下静默丢掉整条管理 API（表现为设置页能开但读不到任何服务器）。`ctx.inject` 会在服务出现时挂载、在提供方消失时自动释放，两种激活顺序都成立。

## 测试

```bash
node tests/host.test.mjs     # 37 项：协议、传输、错误域、CRUD、导入导出、凭据引用、持久化、清理
node tests/api.test.mjs      # 12 项：设置页所用的同源管理 API（快照、动作、守卫、凭据、导入失败信封）
node tests/client.test.mjs   # 11 项：迷你 React 运行时里驱动设置页，验证每次交互打到正确端点
```

`host.test.mjs` 真实启动一个 stdio MCP 服务器（`tests/echo-server.mjs`）与若干 HTTP 端点，覆盖成功路径与 `COMMAND_NOT_FOUND` / `CWD_MISSING` / `NETWORK_TCP` / `HTTP_AUTH` / `HTTP_NOT_FOUND` / `HTTP_SERVER_ERROR` / 工具业务错误等失败路径，并断言快照里不会出现任何凭据字面量。`api.test.mjs` 把真实的 `registerApi` 挂到假 webServer 上，按页面的调用方式走一遍 `GET /api`、各动作、`404/405/400` 守卫与导入拒绝信封。

## 已知限制

- 不实现 MCP 的 `resources` / `prompts` / `sampling` 桥接，只映射工具面（`tools/list` 与 `tools/call`）；服务器声明的其他能力在详情页可见但不注册。
- 任务式工具（`execution.taskSupport = "required"`）不在支持范围，调用时会明确报错。
- 传输实现依赖 Node 的 `fetch` 与 `child_process`；没有走 `ctx.subprocess`，因为 subprocess seam 自己的约定就是「拥有自身 spawn 的传输（SDK 客户端、MCP）应绕开本服务」，本插件沿用同一套环境清洗规则保持策略单一。
- 单进程内 `serverName` 唯一；同一台服务器要在多个 Agent 预设里复用时，需要不同的 `serverName`。
