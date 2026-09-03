# MCP Streamable HTTP + API 收敛改造方案

## 1. 目标

把当前 `mcp-server` 的能力收敛到标准 `StreamableHTTP`，同时保留现有查询能力，形成三层入口：

- `stdio`：本地 MCP
- `streamable-http-stateless`：标准 HTTP MCP，无需 `sessionId`
- `/api/*`：可选保留的便捷 REST 包装层

核心原则：

- 业务逻辑只实现一次
- MCP 工具和 `/api/*` 共用同一套执行层
- 不再依赖 `sessionId` 做查询态管理

## 2. 能力收敛方式

现有 `/api/*` 接口建议映射为 MCP tools：

| 现有接口 | 建议 tool |
|---|---|
| `/api/search` | `codegraph_search` |
| `/api/explore` | `codegraph_explore` |
| `/api/node` | `codegraph_node` |
| `/api/callers` | `codegraph_callers` |
| `/api/callees` | `codegraph_callees` |
| `/api/impact` | `codegraph_impact` |
| `/api/files` | `codegraph_files` |
| `/api/status` | `codegraph_status` |
| `/api/versions` | `codegraph_versions` |

## 3. 文件及改造清单

### `packages/mcp-server/src/index.ts`

改造重点：

- 拆出 `createMcpServer()`，避免 server 作为文件级单例
- 新增 `MCP_MODE=streamable-http-stateless`
- 新增 `/mcp` 标准入口
- 保留现有 `stdio`
- 保留现有 `sse` 兼容模式
- `/api/*` 如保留，只作为薄包装层

建议结构：

```ts
createMcpServer()
createApiRoutes()
startByMode()
```

### `packages/mcp-server/src/tool-handler.ts`

改造重点：

- 保持工具执行主逻辑不变
- 所有工具都只走 `handler.execute(name, args)`
- 避免 `/api/*` 和 MCP tool 出现两套实现

### `packages/mcp-server/src/tools.ts`

改造重点：

- 保持 tool schema 统一维护
- 让 `/mcp` 与 `/api/*` 共享同一组能力定义

### `packages/mcp-server/src/sqlite-query.ts`

改造重点：

- 保持数据库定位逻辑不变
- 让 `streamable-http-stateless` 与现有模式共用同一查库方式

### 可选新增 `packages/mcp-server/src/http-api.ts`

用途：

- 把 `/api/*` 路由单独抽出
- 只做参数校验和 `handler.execute(...)` 转发
- 降低 `index.ts` 复杂度

### 可选新增 `packages/mcp-server/src/mcp-app.ts`

用途：

- 专门放 `createMcpServer()`
- 统一注册 `ListToolsRequestSchema` / `CallToolRequestSchema`
- 方便 `stdio`、`sse`、`streamable-http-stateless` 共用

## 4. Streamable HTTP 方案

实际采用模式：

```ts
new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
  enableJsonResponse: false,
})
```

含义：

- 不生成 `sessionId`
- 不维护会话状态
- 不需要 `/messages`
- 每个请求独立处理
- 使用 SSE 事件流返回 MCP 消息

标准入口：

```text
POST /mcp
```

## 5. 已完成改造及当前机制

### 5.1 MCP Server 创建方式

文件：`packages/mcp-server/src/index.ts`

- 新增 `createMcpServer()`，每个无状态 HTTP 请求创建独立的 MCP `Server` 和 `StreamableHTTPServerTransport`。
- 保留 `stdio` 模式。
- 保留旧的 `sse` 模式，兼容 `/sse`、`/messages`、`/mcp/messages`。
- 新增 `MCP_MODE=streamable-http-stateless` 模式。
- 标准 MCP 入口为 `POST /mcp`。
- MCP Server 声明 `tools` 和 `logging` 能力。

### 5.2 工具调用方式

文件：`packages/mcp-server/src/tool-handler.ts`

- `tools/list` 返回统一的 `tools` 定义。
- `tools/call` 继续通过 `ToolHandler.execute(name, args)` 执行业务逻辑。
- `codegraph_search`、`codegraph_explore`、`codegraph_node`、`codegraph_callers`、`codegraph_callees`、`codegraph_impact`、`codegraph_files`、`codegraph_status`、`codegraph_versions` 均复用同一执行层。
- 查询数据源为对应的 SQLite 文件，不再通过 MySQL 查询。

### 5.3 流式返回机制

当前流式返回的是 MCP 消息，不是把最终 `content[].text` 拆成多个文本片段。

返回头：

```http
Content-Type: text/event-stream
Transfer-Encoding: chunked
```

事件格式：

```text
event: message
data: {JSON-RPC消息}
```

一次 `tools/call` 的事件顺序通常为：

1. `notifications/progress`：打开数据库。
2. `notifications/progress`：开始查询。
3. `notifications/message`：输出查询阶段日志。
4. `notifications/progress`：返回候选节点数量。
5. `notifications/progress`：返回图遍历进度。
6. `notifications/progress`：返回源码收集进度。
7. `notifications/progress`：格式化结果并完成。
8. 最后返回一次 `tools/call` 的 JSON-RPC `result`。

进度通知只有在请求携带 `_meta.progressToken` 时才会发送，例如：

```json
{
  "_meta": {
    "progressToken": "request-1"
  }
}
```

最终结果仍然是标准 MCP 工具结果：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "## Code Context\\n..."
      }
    ]
  }
}
```

### 5.4 `codegraph_explore` 的结果边界

`codegraph_explore` 当前返回的是经过格式化的 Markdown 上下文，不是数据库中全部节点和边的原始结构：

- 入口节点返回在 `Entry Points`。
- 关联节点最多展示 10 个。
- 源码块数量由 `maxFiles` 控制。
- 最终 `content[].text` 一次性返回。
- SSE 只负责分段发送进度和日志消息，不会自动把 Markdown 正文拆成多个 `content` 消息。

因此，当前 SSE 不会改变查询结果的业务范围；如果查询结果看起来不完整，应检查搜索限制、遍历方向、源码字段是否为空，以及 `codegraph_explore` 的格式化规则，而不是优先判断 SSE 丢数据。

## 6. 实际验证结果

截至 2026-08-28，已验证：

- `npm run build --workspace=@codegraph/mcp-server` 编译通过。
- `npm run build --workspace=@codegraph/ingestion-server` 编译通过。
- `POST /mcp` 可以完成 `initialize`。
- `tools/list` 可以返回全部工具定义。
- `tools/call` 可以调用 `codegraph_status` 和 `codegraph_explore`。
- 响应头为 `text/event-stream`。
- `codegraph_explore` 能先返回多条进度事件，最后返回完整 JSON-RPC 工具结果。
- 无状态模式不依赖 `sessionId`。

## 7. 推荐实现顺序

1. 抽出 `createMcpServer()`
2. 新增 `streamable-http-stateless` 模式
3. 接入 `POST /mcp`
4. 保留 `/api/*` 薄包装层
5. 补测试并验证结果一致

## 8. 验收标准

- `MCP_MODE=streamable-http-stateless` 可启动
- `POST /mcp` 可完成 `initialize`
- `tools/list` 可返回全部工具
- `tools/call` 可调用 `codegraph_explore`
- 不需要 `sessionId`
- `/api/*` 和 MCP tools 返回一致
- `stdio` 和 `sse` 不受影响

## 9. 风险点

- 部分 MCP 客户端可能更偏好 stateful session
- 如果直接删 `/api/*`，调试成本会升高
- 若入口层不拆分，容易出现重复逻辑

## 10. 建议最终形态

```text
业务能力只实现一次
  -> ToolHandler

协议入口三种
  -> stdio
  -> streamable-http-stateless
  -> sse(兼容)

REST 便捷层
  -> 可选保留 /api/*
```
