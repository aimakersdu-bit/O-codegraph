# ingestion-server 改造计划：从 MySQL 写入服务改为 SQLite 只读查询服务

## 目标
- `ingestion-server` 不再接收 `ci-cli` 的 HTTP 上报数据。
- 删除 `POST /api/v1/ingest` 上传入口，不做兼容保留。
- 不再连接 MySQL，不再执行 MySQL migration。
- `ci-cli` 生成的 SQLite 文件通过 scp 放到 `ingestion-server` 所在机器的执行目录下。
- 查询接口根据 `repo + version` 找到对应 `.db` 文件，再从 SQLite 查询 codegraph 数据并返回。
- `version` 由外部 CI 产物版本号传入，格式固定为 `YYMMDD.major.minor.build`，例如 `260827.1.0.2233`。

## 当前现状
当前 `ingestion-server` 的核心流程是：
1. 启动时创建 MySQL 连接池。
2. 启动时执行 MySQL migration。
3. 注册 `/api/v1/ingest` 接收 `ci-cli` 上传。
4. `WriterService` 将上传数据写入 MySQL。
5. `VersionCleaner` 负责清理历史版本。
6. `/api/v1/versions` 和 `/api/v1/versions/:versionId/stats` 从 MySQL 查询。

当前相关文件：
- `packages/ingestion-server/src/index.ts`
- `packages/ingestion-server/src/routes/ingest.ts`
- `packages/ingestion-server/src/routes/versions.ts`
- `packages/ingestion-server/src/routes/health.ts`
- `packages/ingestion-server/src/services/writer.ts`
- `packages/ingestion-server/src/services/cleaner.ts`
- `packages/shared/src/mysql-adapter.ts`
- `packages/shared/src/schema/001_init.sql`
- `packages/shared/src/queries.ts`

## 改造后机制

### 1. SQLite 文件放置规则
`ci-cli` 生成的 `.db` 文件由外部流程通过 scp 放到 server 机器。

建议目录结构：

```text
<INGESTION_DB_ROOT>/
  <safe_repo>/
    <safe_repo>_<safe_version>.db
```

示例：

```text
./codegraph-dbs/
  eebank_ccs_abd_x23/
    eebank_ccs_abd_x23_260827_1_0_2233.db
```

规则：
- `INGESTION_DB_ROOT` 通过环境变量配置。
- 未配置时默认使用服务执行目录下的 `codegraph-dbs/`。
- `repo` 和 `version` 必须和 `ci-cli` 使用同一套归一化规则。
- `version` 格式建议校验为 `^\d{6}\.\d+\.\d+\.\d+$`。
- 非字母数字字符统一替换为 `_`。
- `version` 中的 `.` 写入文件名时替换为 `_`。
- 查询时只允许在 `INGESTION_DB_ROOT` 内查找文件，禁止路径穿越。

### 2. 查询流程
接口收到查询参数后：
1. 读取 `repo` 和 `version`。
2. 计算 repo 目录名。
3. 计算 db 文件名。
4. 检查 `.db` 文件是否存在。
5. 用只读 SQLite 连接打开该文件。
6. 查询 `nodes / edges / files / project_metadata / export_metadata`。
7. 返回现有接口需要的数据结构。

### 3. 上传入口处理
不再保留上传兼容：
- 删除 `/api/v1/ingest` 路由注册。
- 删除或废弃 `routes/ingest.ts`。
- 删除或废弃 `services/writer.ts`。
- 删除或废弃 `services/cleaner.ts`。
- 删除 ingestion server 对 `CODEGRAPH_API_KEY` 的强依赖。

### 4. 版本语义调整
原来版本来自 MySQL 的 `version_history`。

新方案下，一个 `repo+version` 对应一个导出 SQLite 文件，本质上是该版本的当前快照。

建议：
- `/api/v1/versions?repo=x&version=y` 返回该 SQLite 文件的当前快照信息。
- 当前快照信息从 `export_metadata` 表读取。
- `version` 是外部版本号，例如 `260827.1.0.2233`。
- `version_id` 仍可作为库内单次导出的内部唯一标识，但不再用于文件定位。

### 5. stats 查询
`/api/v1/versions/:version/stats?repo=x` 或保持旧路径名 `/api/v1/versions/:versionId/stats?repo=x&version=y` 时改为：
1. 根据 `repo+version` 找到 SQLite 文件。
2. 查询当前 SQLite 文件中的统计信息。
3. 如果路径参数仍叫 `versionId`，它实际承载外部 `version`，需要和 query/body 中的 `version` 保持一致。
4. 如果库内有 `export_metadata.version_id`，它只作为内部导出批次标识，不替代外部 `version`。

统计查询包括：
- node 总数
- edge 总数
- file 总数
- 按 node kind 聚合
- 按 edge kind 聚合
- 按 file language 聚合

### 6. mcp-server 同步改造
`mcp-server` 也不能再查 MySQL，需要和 `ingestion-server` 共用同一套 `repo+version -> SQLite 文件` 定位规则。

建议改造点：
- `packages/mcp-server/src/index.ts`
  - 去掉 MySQL 连接池初始化
  - 改为初始化 SQLite locator / registry
- `packages/mcp-server/src/tool-handler.ts`
  - 根据 `repo + version` 打开对应 SQLite
  - `codegraph_search / node / callers / callees / impact / explore / files / status / versions` 都改为读 SQLite
- `packages/mcp-server/src/graph.ts`
  - 保持图遍历逻辑，但数据源从 MySQL 查询改为 SQLite 查询
- `packages/mcp-server/src/context.ts`
  - 保持上下文构建逻辑，但依赖新的 SQLite 查询层

`mcp-server` 的查询接口返回结构尽量不变，差异主要来自：
- 版本历史语义变成 `repo+version` 当前快照
- 搜索排序可能从 MySQL FULLTEXT 改成 SQLite FTS
- `source_code` 只保留受限片段

## 需要改的文件

### `packages/ingestion-server/src/index.ts`
- 移除 MySQL 初始化。
- 移除 MySQL migration。
- 移除 `/api/v1/ingest` 路由注册。
- 初始化 SQLite 文件定位服务。
- 注册只读查询路由。

### `packages/ingestion-server/src/routes/ingest.ts`
- 不再需要。
- 可以删除文件，或保留但不再注册。

### `packages/ingestion-server/src/routes/versions.ts`
- 查询来源从 MySQL 改为 SQLite 文件。
- `repo+version` 用于定位 `.db` 文件。
- 返回结构尽量保持现有接口兼容。

### `packages/ingestion-server/src/routes/health.ts`
- 不再检查 MySQL 连接。
- 改为检查 `INGESTION_DB_ROOT` 是否存在、是否可读。

### `packages/ingestion-server/src/services/writer.ts`
- 不再需要。
- 原先写 MySQL 的逻辑全部废弃。

### `packages/ingestion-server/src/services/cleaner.ts`
- 不再需要。
- 历史版本清理逻辑废弃，因为 server 不再负责写入和版本保留。

### 新增 `packages/ingestion-server/src/services/sqlite-locator.ts`
- 根据 `repo+version` 计算 db 路径。
- 校验路径安全。
- 判断文件是否存在。
- 返回只读 SQLite 连接或路径。

### 新增 `packages/ingestion-server/src/services/sqlite-query.ts`
- 封装对导出 SQLite 的查询。
- 查询 `nodes / edges / files / project_metadata / export_metadata`。
- 对外返回原接口需要的结果。

## 导出 SQLite 需要满足的最小表结构
`ingestion-server` 查询依赖这些表：

```text
nodes
edges
files
project_metadata
export_metadata
```

`nodes` 表必须包含：

```text
id
kind
name
qualified_name
file_path
language
start_line
end_line
start_column
end_column
docstring
signature
visibility
is_exported
is_async
is_static
is_abstract
decorators
type_parameters
updated_at
source_code
```

如果需要搜索能力，建议导出库包含：

```text
nodes_fts
```

否则查询服务只能使用普通索引或 `LIKE`。

## 可行性评估
可行性：高。

原因：
- server 不再写数据，只读 SQLite，复杂度比 MySQL 写入链路低。
- `ci-cli` 已经计划负责生成完整 SQLite 文件。
- 查询时只需要根据 `repo+version` 定位文件，然后执行本地 SQL。
- 不需要维护 MySQL 连接池、migration、写入事务、历史清理。

实现难度：中。

主要难点：
- 文件命名规则必须和 `ci-cli` 完全一致。
- 查询接口返回结构需要和原接口保持一致。
- SQLite schema 必须满足 server 查询需求。
- scp 文件传输完成前不能被 server 读到半成品。

## 风险评估

### 1. repo/version 文件名不一致
`ci-cli` 生成文件名，`ingestion-server` 负责查找文件。
两边必须共用同一套命名规则，否则会找不到 db。

`mcp-server` 也必须使用同一套规则，否则两个服务会读到不同的文件路径。

### 2. scp 期间读到未完成文件
虽然 scp 逻辑不需要开发，但运维流程要约束：
- 不要让查询请求读取正在传输中的 `.db`。
- 最好由外部流程保证文件传输完成后再对外提供查询。

### 3. SQLite WAL 文件风险
`ci-cli` 导出完成后必须关闭连接并确保数据落入主 `.db` 文件。
server 侧应只依赖单个 `.db` 文件，不依赖 `.db-wal` 或 `.db-shm`。

### 4. 版本接口语义变化
原来是 MySQL 多版本历史。
现在是 `repo+version` 当前快照。
如果外部仍然传 `versionId`，需要明确它是旧接口路径名，实际值应等于外部 `version`。

### 5. source_code 不一定存在
`ci-cli` 会对 `source_code` 做片段约束。
server 查询时不能假设每个 node 都有 `source_code`。

`mcp-server` 同样要容忍 `source_code` 为空，只在存在时返回源码片段。

### 6. 查询服务变成文件依赖
server 的可用性依赖 scp 后的文件是否存在、路径是否正确、SQLite 是否完整。
需要对缺失文件、损坏文件返回清晰错误。

## 验收标准
- 不再启动 MySQL。
- 不再需要 `MYSQL_*` 环境变量。
- 不再注册 `/api/v1/ingest`。
- 没有 `ci-cli` 上传入口兼容逻辑。
- 给定 `repo+version` 能找到对应 SQLite 文件。
- 找不到 SQLite 文件时返回明确的 404。
- `/api/v1/health` 能检查 SQLite 根目录。
- `/api/v1/versions?repo=x&version=260827.1.0.2233` 能返回当前快照信息。
- `/api/v1/versions/:versionId/stats?repo=x&version=260827.1.0.2233` 能返回统计信息。
- 查询能读取 `nodes.source_code`，但不要求每个 node 都有 `source_code`。
