# ingestion-server 与 mcp-server 说明

## 1. 角色划分

### ingestion-server
面向普通 HTTP 调用方的查询服务。

当前职责：
- 读取服务器上的 SQLite 图数据文件
- 按 `repo + version` 查找对应数据库
- 提供版本、健康检查等 HTTP API
- 不再接收 `ci-cli` 上报
- 不再依赖 MySQL

### mcp-server
面向 MCP 客户端和 AI 工具的查询服务。

当前职责：
- 读取同一批 SQLite 图数据文件
- 暴露 MCP tools，例如：
  - `codegraph_search`
  - `codegraph_explore`
  - `codegraph_node`
  - `codegraph_callers`
  - `codegraph_callees`
  - `codegraph_impact`
  - `codegraph_files`
  - `codegraph_versions`
- 支持 `stdio` 和 `sse` 两种启动模式

## 2. 数据来源

两者都不再查 MySQL，统一读取本地磁盘上的 SQLite 文件。

默认目录：

```text
<CODEGRAPH_DB_ROOT>/<repo目录>/<repo>_<version>.db
```

如果没有设置 `CODEGRAPH_DB_ROOT`，默认使用：

```text
./codegraph-dbs
```

## 3. 调用关系

```text
ci-cli
  -> 生成 SQLite db 文件
  -> 放到服务器目录

ingestion-server
  -> 普通 HTTP 查询

mcp-server
  -> MCP 工具查询
```

## 4. 启动方式

### ingestion-server

```bash
CODEGRAPH_DB_ROOT=./codegraph-dbs \
PORT=3000 \
npm start -w packages/ingestion-server
```

### mcp-server

#### stdio 模式

```bash
CODEGRAPH_DB_ROOT=./codegraph-dbs \
npm start -w packages/mcp-server
```

#### sse 模式

```bash
CODEGRAPH_DB_ROOT=./codegraph-dbs \
MCP_MODE=sse \
MCP_PORT=3001 \
npm start -w packages/mcp-server
```

## 5. 简单区别

- `ingestion-server` 更像通用查询 API
- `mcp-server` 更像给 IDE / Agent 用的工具层
- 两者底层读的是同一套 SQLite 图数据

