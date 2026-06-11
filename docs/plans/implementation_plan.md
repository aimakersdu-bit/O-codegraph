# CodeGraph 中心化服务改造设计

将 CodeGraph 从本地 SQLite 单机模式改造为 CI 驱动 + MySQL 中心化存储 + 统一 MCP 查询服务的团队共享架构。

## 核心设计决策

| 维度 | 决策 |
|------|------|
| 存储 | **完全替换** SQLite → MySQL |
| CI 触发 | CI 端本地运行 tree-sitter **全量扫描**，上传提取结果到 Ingestion Service API |
| 数据更新策略 | **A/B 版本切换**：每行数据带 `version_id`，写入新版本后原子切换活跃指针 |
| 架构 | **分离部署**：Ingestion Service（写入）+ MCP Server（读取），共享 MySQL |
| 源码存储 | **所有符号的完整源码**（startLine→endLine）嵌入 MySQL `source_code` 字段 |
| 技术栈 | TypeScript / Node.js |
| 多版本 | 所有接口必须传递 `repo` + `branch` |

## User Review Required

> [!IMPORTANT]
> **MySQL 全文检索替代方案**：现有 CodeGraph 使用 SQLite FTS5 做符号全文搜索（`nodes_fts` 虚拟表）。MySQL 的 `FULLTEXT INDEX` 功能与 FTS5 行为有差异（无 BM25 排序、中文分词需 ngram）。设计中计划使用 MySQL `FULLTEXT INDEX` + 应用层评分来模拟，可能需要后续调优。

> [!IMPORTANT]
> **源码存储膨胀**：存储所有符号的完整源码会显著增加 MySQL 存储量。对于大型代码库（>10K 文件），一个 repo+branch 的 nodes 表可能达到数百 MB。需要评估你们的 MySQL 实例容量。

> [!WARNING]
> **CI 全量扫描耗时**：当前 CodeGraph 全量 indexAll 对大型项目可能需要数分钟。CI 每次全量扫描需要在流水线中预留足够时间。

## 已确认决策

| 问题 | 决策 |
|------|------|
| API 认证方式 | **API Key**：Ingestion Service 通过 `Authorization: Bearer <API_KEY>` 头验证，MCP Server 可选配置 |
| 版本保留策略 | **保留最近 7 个版本**：每个 repo+branch 维度保留最近 7 个 version，超出后异步清理最旧版本 |
| 历史版本查询 | **支持**：MCP 工具增加可选 `version_id` 参数，默认查活跃版本，传入具体 version_id 可查询历史数据 |
| 整体架构 | **方案 A（Monorepo 多模块）**：在现有 CodeGraph 仓库内新增 packages/，最大复用核心逻辑 |

---

## Proposed Changes

### 整体架构

```
┌──────────────┐     全量扫描结果      ┌───────────────────┐
│   CI Pipeline │ ──── HTTP POST ────▶ │  Ingestion Service │
│  (tree-sitter │     (nodes/edges/    │   (端口 3001)       │
│   全量提取)    │      code/files)     │                    │
└──────────────┘                      └────────┬───────────┘
                                               │ 写入新 version_id
                                               ▼
                                      ┌─────────────────┐
                                      │     MySQL        │
                                      │  (nodes, edges,  │
                                      │   files, versions)│
                                      └────────┬────────┘
                                               │ 读取 active version
                                               ▼
┌──────────────┐      MCP Protocol    ┌───────────────────┐
│  AI Agents   │ ◀────────────────── │   MCP Server       │
│  (Claude,    │                      │   (统一查询服务)    │
│   Cursor…)   │                      │   (端口 3000)       │
└──────────────┘                      └───────────────────┘
```

### 数据流

```
CI Pipeline:
  1. git checkout target branch
  2. 运行 codegraph CLI 全量提取 (tree-sitter → nodes/edges/code)
  3. HTTP POST /api/v1/ingest { repo, branch, nodes[], edges[], files[] }

Ingestion Service:
  1. 验证 API Key（Authorization: Bearer <key>）
  2. 生成新 version_id (UUIDv7 时间有序)
  3. 批量写入 nodes/edges/files（每行带 repo, branch, version_id）
  4. 原子更新 active_versions 表指针 → 新 version_id
  5. 异步清理：保留最近 7 个版本，删除更早的版本数据

MCP Server:
  1. 收到 tool call（带 repo, branch 参数，可选 version_id）
  2. 若未传 version_id → 查 active_versions 获取当前活跃版本
     若传了 version_id → 直接使用该历史版本
  3. 所有查询 WHERE repo=? AND branch=? AND version_id=?
  4. 返回结果（source_code 直接从 MySQL 读取，不需要访问文件系统）
```

---

### 模块 1: MySQL Schema

#### [NEW] `packages/shared/schema/001_init.sql`

```sql
-- ============================================================
-- 版本管理
-- ============================================================

-- 活跃版本指针（每个 repo+branch 一条记录）
CREATE TABLE IF NOT EXISTS active_versions (
    repo        VARCHAR(255) NOT NULL,
    branch      VARCHAR(255) NOT NULL,
    version_id  VARCHAR(64)  NOT NULL,
    updated_at  BIGINT       NOT NULL,
    PRIMARY KEY (repo, branch)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 版本历史记录（保留最近 7 个版本供历史查询）
CREATE TABLE IF NOT EXISTS version_history (
    id          BIGINT        AUTO_INCREMENT PRIMARY KEY,
    repo        VARCHAR(255)  NOT NULL,
    branch      VARCHAR(255)  NOT NULL,
    version_id  VARCHAR(64)   NOT NULL,
    status      ENUM('active', 'retained', 'deleting') NOT NULL DEFAULT 'active',
    node_count  INT           DEFAULT 0,
    edge_count  INT           DEFAULT 0,
    file_count  INT           DEFAULT 0,
    created_at  BIGINT        NOT NULL,
    deleted_at  BIGINT,
    UNIQUE KEY uk_version (repo, branch, version_id),
    INDEX idx_repo_branch_status (repo, branch, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 核心表（每行带 repo + branch + version_id）
-- ============================================================

CREATE TABLE IF NOT EXISTS nodes (
    id              VARCHAR(128)  NOT NULL,
    repo            VARCHAR(255)  NOT NULL,
    branch          VARCHAR(255)  NOT NULL,
    version_id      VARCHAR(64)   NOT NULL,

    kind            VARCHAR(32)   NOT NULL,
    name            VARCHAR(512)  NOT NULL,
    qualified_name  VARCHAR(1024) NOT NULL,
    file_path       VARCHAR(1024) NOT NULL,
    language        VARCHAR(32)   NOT NULL,
    start_line      INT           NOT NULL,
    end_line        INT           NOT NULL,
    start_column    INT           NOT NULL,
    end_column      INT           NOT NULL,
    docstring       TEXT,
    signature       TEXT,
    source_code     MEDIUMTEXT,          -- ★ 核心新增：完整源码片段
    visibility      VARCHAR(16),
    is_exported     TINYINT       DEFAULT 0,
    is_async        TINYINT       DEFAULT 0,
    is_static       TINYINT       DEFAULT 0,
    is_abstract     TINYINT       DEFAULT 0,
    decorators      JSON,
    type_parameters JSON,
    updated_at      BIGINT        NOT NULL,

    PRIMARY KEY (repo, branch, version_id, id),

    INDEX idx_nodes_kind        (repo, branch, version_id, kind),
    INDEX idx_nodes_name        (repo, branch, version_id, name(128)),
    INDEX idx_nodes_qname       (repo, branch, version_id, qualified_name(256)),
    INDEX idx_nodes_file        (repo, branch, version_id, file_path(256)),
    INDEX idx_nodes_file_line   (repo, branch, version_id, file_path(256), start_line),
    INDEX idx_nodes_lower_name  (repo, branch, version_id, (LOWER(name(128)))),
    FULLTEXT INDEX ft_nodes     (name, qualified_name, docstring, signature)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS edges (
    id          BIGINT        AUTO_INCREMENT PRIMARY KEY,
    repo        VARCHAR(255)  NOT NULL,
    branch      VARCHAR(255)  NOT NULL,
    version_id  VARCHAR(64)   NOT NULL,

    source      VARCHAR(128)  NOT NULL,
    target      VARCHAR(128)  NOT NULL,
    kind        VARCHAR(32)   NOT NULL,
    metadata    JSON,
    line        INT,
    col         INT,
    provenance  VARCHAR(32),

    INDEX idx_edges_source_kind (repo, branch, version_id, source, kind),
    INDEX idx_edges_target_kind (repo, branch, version_id, target, kind),
    INDEX idx_edges_kind        (repo, branch, version_id, kind),
    INDEX idx_edges_provenance  (repo, branch, version_id, provenance)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS files (
    path          VARCHAR(1024) NOT NULL,
    repo          VARCHAR(255)  NOT NULL,
    branch        VARCHAR(255)  NOT NULL,
    version_id    VARCHAR(64)   NOT NULL,

    content_hash  VARCHAR(64)   NOT NULL,
    language      VARCHAR(32)   NOT NULL,
    size          INT           NOT NULL,
    modified_at   BIGINT        NOT NULL,
    indexed_at    BIGINT        NOT NULL,
    node_count    INT           DEFAULT 0,
    errors        JSON,

    PRIMARY KEY (repo, branch, version_id, path(256)),
    INDEX idx_files_lang     (repo, branch, version_id, language),
    INDEX idx_files_modified (repo, branch, version_id, modified_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 未解析引用（仅写入阶段临时使用，不需要跨版本查询）
CREATE TABLE IF NOT EXISTS unresolved_refs (
    id              BIGINT        AUTO_INCREMENT PRIMARY KEY,
    repo            VARCHAR(255)  NOT NULL,
    branch          VARCHAR(255)  NOT NULL,
    version_id      VARCHAR(64)   NOT NULL,

    from_node_id    VARCHAR(128)  NOT NULL,
    reference_name  VARCHAR(512)  NOT NULL,
    reference_kind  VARCHAR(32)   NOT NULL,
    line            INT           NOT NULL,
    col             INT           NOT NULL,
    candidates      JSON,
    file_path       VARCHAR(1024) NOT NULL DEFAULT '',
    language        VARCHAR(32)   NOT NULL DEFAULT 'unknown',

    INDEX idx_unresolved_from (repo, branch, version_id, from_node_id),
    INDEX idx_unresolved_name (repo, branch, version_id, reference_name(128)),
    INDEX idx_unresolved_file (repo, branch, version_id, file_path(256))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 项目元数据
CREATE TABLE IF NOT EXISTS project_metadata (
    repo        VARCHAR(255) NOT NULL,
    branch      VARCHAR(255) NOT NULL,
    version_id  VARCHAR(64)  NOT NULL,
    `key`       VARCHAR(255) NOT NULL,
    value       TEXT         NOT NULL,
    updated_at  BIGINT       NOT NULL,
    PRIMARY KEY (repo, branch, version_id, `key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Schema 版本追踪
CREATE TABLE IF NOT EXISTS schema_versions (
    version     INT PRIMARY KEY,
    applied_at  BIGINT NOT NULL,
    description TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

---

### 模块 2: MySQL Adapter

#### [NEW] `packages/shared/mysql-adapter.ts`

替换现有 [sqlite-adapter.ts](file:///Users/bigc/Downloads/claw/codegraph/src/db/sqlite-adapter.ts)，实现一个兼容的 `MysqlDatabase` 接口。

**关键设计**：
- 使用 `mysql2/promise` 连接池
- 实现与现有 `SqliteDatabase` 接口对齐的 `prepare` / `run` / `get` / `all` 方法
- 所有查询自动注入 `repo`, `branch`, `version_id` 三元组（通过 `QueryContext`）
- 事务支持使用 MySQL 的 `START TRANSACTION` / `COMMIT` / `ROLLBACK`

```typescript
// 核心接口
interface QueryContext {
  repo: string;
  branch: string;
  versionId: string;
}

interface MysqlDatabase {
  execute(sql: string, params?: any[]): Promise<any>;
  query(sql: string, params?: any[]): Promise<any[]>;
  transaction<T>(fn: (conn: MysqlConnection) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

---

### 模块 3: Ingestion Service

#### [NEW] `packages/ingestion-server/`

HTTP 服务，接收 CI 上传的全量提取结果，写入 MySQL。

**API 设计**：

```
POST /api/v1/ingest
Content-Type: application/json

{
  "repo":   "org/my-project",
  "branch": "main",
  "nodes":  [ { id, kind, name, qualifiedName, filePath, language,
                startLine, endLine, startColumn, endColumn,
                docstring, signature, sourceCode, visibility,
                isExported, isAsync, isStatic, isAbstract,
                decorators, typeParameters, updatedAt } ],
  "edges":  [ { source, target, kind, metadata, line, col, provenance } ],
  "files":  [ { path, contentHash, language, size, modifiedAt, indexedAt, nodeCount, errors } ],
  "metadata": { "key": "value" }   // 可选：框架信息等
}

Response 200:
{
  "versionId": "01J5...",
  "nodesWritten": 1234,
  "edgesWritten": 5678,
  "filesWritten": 100,
  "durationMs": 3200
}
```

**认证**：

所有写入 API 需要 `Authorization: Bearer <API_KEY>` 请求头。API Key 通过环境变量 `CODEGRAPH_API_KEY` 配置在 Ingestion Service 端。

**写入流程**：

```
1. 验证 API Key
2. 生成 version_id = UUIDv7 (时间有序，方便清理)
3. INSERT INTO version_history (repo, branch, version_id, status, created_at)
4. START TRANSACTION
5. 批量 INSERT nodes（每 500 条一批，附带 repo/branch/version_id）
6. 批量 INSERT edges（同上）
7. 批量 INSERT files（同上）
8. INSERT project_metadata
9. COMMIT
10. UPDATE active_versions SET version_id=?, updated_at=NOW()
    WHERE repo=? AND branch=?
    (如果不存在则 INSERT)
11. UPDATE version_history SET status='retained'
    WHERE repo=? AND branch=? AND version_id != 新版本
12. 异步清理：查询 version_history 中该 repo+branch 的记录，
    按 created_at DESC 排序，保留前 7 条，
    将第 8 条及以后的 status 改为 'deleting'，
    然后 DELETE 对应 version_id 的 nodes/edges/files/unresolved_refs，
    最后删除 version_history 记录
```

> [!TIP]
> 步骤 10 在事务外执行，这样即使写入事务很长，读取侧仍然指向旧的稳定版本。只有全部写入成功后才切换指针，实现原子切换。

**其他 API**：

```
GET  /api/v1/versions?repo=xxx&branch=yyy     → 查看版本列表（最近 7 个）
GET  /api/v1/versions/:versionId/stats         → 查看指定版本的统计信息
DELETE /api/v1/versions/:versionId             → 手动清理指定版本
GET  /api/v1/health                            → 健康检查
```

---

### 模块 4: CI 端 CLI

#### [MODIFY] 复用现有 CodeGraph 提取逻辑

CI 端运行一个轻量 CLI，复用现有的 `ExtractionOrchestrator` + `ReferenceResolver` 逻辑：

```bash
# CI Pipeline 示例
codegraph-ci extract \
  --repo "org/my-project" \
  --branch "$GIT_BRANCH" \
  --ingestion-url "http://ingestion-service:3001" \
  --api-key "$CODEGRAPH_API_KEY"
```

**流程**：
1. 在 CI 工作目录运行 tree-sitter 全量提取（复用 `ExtractionOrchestrator.indexAll()`）
2. 运行引用解析（复用 `ReferenceResolver`）
3. 读取每个符号的源码片段（`fs.readFileSync` + `startLine→endLine`）
4. 将 nodes（含 sourceCode）、edges、files 打包为 JSON
5. HTTP POST 到 Ingestion Service

#### [NEW] `packages/ci-cli/index.ts`

```typescript
// 伪代码
async function main() {
  const { repo, branch, ingestionUrl, apiKey } = parseArgs();

  // 复用现有 CodeGraph 提取
  // 但不写 SQLite，而是收集到内存
  await initGrammars();
  const result = await orchestrator.indexAll();
  const resolved = await resolver.resolveAndPersist();

  // 读取源码片段
  for (const node of allNodes) {
    node.sourceCode = readSourceCode(node.filePath, node.startLine, node.endLine);
  }

  // 上传
  await fetch(`${ingestionUrl}/api/v1/ingest`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ repo, branch, nodes, edges, files })
  });
}
```

---

### 模块 5: 统一 MCP Server

#### [NEW] `packages/mcp-server/`

统一的 MCP 查询服务，从 MySQL 读取图数据 + 源码。

**与现有 MCP Server 的关键差异**：

| 现有 | 改造后 |
|------|--------|
| 每个项目一个进程 | 单进程服务多个 repo/branch |
| `projectPath` 参数 | `repo` + `branch` 参数 |
| 读源码用 `fs.readFileSync` | 读源码从 MySQL `source_code` 字段 |
| SQLite FTS5 搜索 | MySQL FULLTEXT + 应用层评分 |
| FileWatcher 实时同步 | 无（CI 全量更新，A/B 切换） |

**MCP 工具改造**：

所有工具的 `inputSchema` 新增参数：

```typescript
const repoProperty = {
  type: 'string',
  description: '代码仓库标识，例如 "org/my-project"',
};
const branchProperty = {
  type: 'string',
  description: '分支名，例如 "main"、"feature/xxx"',
};
const versionIdProperty = {
  type: 'string',
  description: '可选：指定查询的版本 ID。不传则使用当前活跃版本。传入具体 version_id 可查询历史版本数据（最近保留 7 个版本）。',
};
```

所有工具的 `required` 数组加入 `['repo', 'branch']`，`version_id` 为可选参数。

**工具列表**：
- `codegraph_explore` — 主工具，返回源码（从 MySQL `source_code` 读取）
- `codegraph_search` — 符号搜索（MySQL FULLTEXT）
- `codegraph_node` — 单符号详情
- `codegraph_callers` / `codegraph_callees` — 调用关系
- `codegraph_impact` — 影响分析
- `codegraph_status` — 索引状态
- `codegraph_files` — 文件树
- `codegraph_versions` — ★ 新增：列出当前 repo+branch 的可用版本（最近 7 个）

**ToolHandler 改造**：
- 移除 `this.cg: CodeGraph` 单实例，改为每次请求根据 `repo` + `branch` + 可选 `version_id` 查 MySQL
- 若未传 `version_id`，自动从 `active_versions` 查当前活跃版本
- 若传了 `version_id`，先校验该版本在 `version_history` 中存在且 `status != 'deleting'`
- 移除 `projectCache`、`FileWatcher`、`catchUpGate` 等本地状态
- `getCode()` 从 `SELECT source_code FROM nodes WHERE ...` 读取，不走文件系统

**搜索引擎改造**：

现有的 [queries.ts](file:///Users/bigc/Downloads/claw/codegraph/src/db/queries.ts) 中的 `searchNodes()` 方法（L737-L783）使用了 SQLite FTS5。MySQL 版本需要：

```sql
-- FTS5 的 prefix 搜索 → MySQL FULLTEXT IN BOOLEAN MODE
SELECT *, MATCH(name, qualified_name, docstring, signature)
  AGAINST ('+searchTerm*' IN BOOLEAN MODE) AS relevance
FROM nodes
WHERE repo=? AND branch=? AND version_id=?
  AND MATCH(name, qualified_name, docstring, signature)
  AGAINST ('+searchTerm*' IN BOOLEAN MODE)
ORDER BY relevance DESC
LIMIT ?;

-- FTS5 回退的 LIKE 搜索 → MySQL LIKE（保持不变）
SELECT * FROM nodes
WHERE repo=? AND branch=? AND version_id=?
  AND name LIKE ?
LIMIT ?;
```

应用层的评分逻辑（`nameMatchBonus`、`kindBonus`、`scorePathRelevance`、多词交叉提升等）保持不变，这些在 [context/index.ts](file:///Users/bigc/Downloads/claw/codegraph/src/context/index.ts) 和 [search/query-utils.ts](file:///Users/bigc/Downloads/claw/codegraph/src/search/query-utils.ts) 中实现，与存储无关。

---

### 模块 6: 共享查询层重构

#### [MODIFY] `packages/shared/queries.ts`

从现有 [queries.ts](file:///Users/bigc/Downloads/claw/codegraph/src/db/queries.ts) 重构，核心变更：

1. **所有 SQL 语句加上 `repo`, `branch`, `version_id` 过滤**
2. **移除 SQLite 特有语法**（如 `INSERT OR REPLACE` → MySQL `INSERT ... ON DUPLICATE KEY UPDATE`）
3. **`SqliteDatabase` → `MysqlDatabase`**（prepared statement 用 `?` 占位符，MySQL 原生支持）
4. **新增 `getCode()` 方法**：从 `source_code` 字段读取，替代文件系统读取

```typescript
interface QueryContext {
  repo: string;
  branch: string;
  versionId: string;  // 来自 active_versions 或用户指定的历史版本
}

class QueryBuilder {
  constructor(
    private db: MysqlDatabase,
    private ctx: QueryContext
  ) {}

  // 解析版本：未指定 version_id 时自动查活跃版本
  static async resolveContext(
    db: MysqlDatabase,
    repo: string,
    branch: string,
    versionId?: string
  ): Promise<QueryContext> {
    if (versionId) {
      // 校验历史版本存在且未在删除中
      const [row] = await db.query(
        'SELECT version_id FROM version_history WHERE repo=? AND branch=? AND version_id=? AND status != ?',
        [repo, branch, versionId, 'deleting']
      );
      if (!row) throw new Error(`Version ${versionId} not found or being deleted`);
      return { repo, branch, versionId };
    }
    // 查活跃版本
    const [row] = await db.query(
      'SELECT version_id FROM active_versions WHERE repo=? AND branch=?',
      [repo, branch]
    );
    if (!row) throw new Error(`No active version for ${repo}@${branch}`);
    return { repo, branch, versionId: row.version_id };
  }

  // 所有查询自动注入上下文
  async getNodeById(id: string): Promise<Node | null> {
    const [row] = await this.db.query(
      'SELECT * FROM nodes WHERE repo=? AND branch=? AND version_id=? AND id=?',
      [this.ctx.repo, this.ctx.branch, this.ctx.versionId, id]
    );
    return row ? rowToNode(row) : null;
  }

  // ★ 新增：直接从 DB 读取源码
  async getNodeSourceCode(id: string): Promise<string | null> {
    const [row] = await this.db.query(
      'SELECT source_code FROM nodes WHERE repo=? AND branch=? AND version_id=? AND id=?',
      [this.ctx.repo, this.ctx.branch, this.ctx.versionId, id]
    );
    return row?.source_code ?? null;
  }

  // ★ 新增：列出可用的历史版本
  async listVersions(): Promise<Array<{ versionId: string; status: string; createdAt: number }>> {
    return this.db.query(
      'SELECT version_id, status, created_at FROM version_history WHERE repo=? AND branch=? AND status != ? ORDER BY created_at DESC LIMIT 7',
      [this.ctx.repo, this.ctx.branch, 'deleting']
    );
  }
}
```

---

### 项目结构总览

```
codegraph/
├── src/                          # 现有核心（保持基本不变）
│   ├── extraction/               # tree-sitter 提取（CI CLI 复用）
│   ├── resolution/               # 引用解析（CI CLI 复用）
│   ├── search/                   # 搜索评分逻辑（MCP Server 复用）
│   ├── graph/                    # 图遍历逻辑（MCP Server 复用）
│   ├── context/                  # 上下文构建（MCP Server 复用，改用 DB 读源码）
│   └── types.ts                  # 类型定义（共享）
│
├── packages/
│   ├── shared/
│   │   ├── schema/
│   │   │   └── 001_init.sql      # MySQL DDL
│   │   ├── mysql-adapter.ts      # MySQL 连接池 + 查询接口
│   │   ├── queries.ts            # 重构的查询层（带 repo/branch/version_id）
│   │   └── types.ts              # QueryContext 等共享类型
│   │
│   ├── ingestion-server/
│   │   ├── index.ts              # Express/Fastify HTTP server
│   │   ├── routes/
│   │   │   ├── ingest.ts         # POST /api/v1/ingest
│   │   │   ├── versions.ts       # GET/DELETE /api/v1/versions
│   │   │   └── health.ts         # GET /api/v1/health
│   │   ├── services/
│   │   │   ├── writer.ts         # 批量写入 + A/B 切换
│   │   │   └── cleaner.ts        # 旧版本异步清理
│   │   └── Dockerfile
│   │
│   ├── mcp-server/
│   │   ├── index.ts              # MCP Server 入口
│   │   ├── tools.ts              # 改造后的 MCP 工具定义
│   │   ├── tool-handler.ts       # 改造后的工具执行器
│   │   └── Dockerfile
│   │
│   └── ci-cli/
│       ├── index.ts              # CLI 入口
│       ├── extractor.ts          # 调用现有 extraction + resolution
│       ├── uploader.ts           # HTTP POST 到 Ingestion Service
│       └── package.json
│
├── docker-compose.yml            # MySQL + Ingestion + MCP 一键启动
└── package.json                  # monorepo (workspaces)
```

---

## Verification Plan

### Automated Tests

```bash
# 1. 共享查询层单元测试（用 testcontainers-mysql 或内存 MySQL）
npm run test -w packages/shared

# 2. Ingestion Service 集成测试
#    - POST 一组 fixture 数据 → 验证 MySQL 中数据正确
#    - 连续 POST 两次 → 验证 A/B 切换和旧版本清理
npm run test -w packages/ingestion-server

# 3. MCP Server 集成测试
#    - 预装 fixture 数据 → 调用各 MCP tool → 验证返回结果
#    - 验证 source_code 返回正确的代码片段
npm run test -w packages/mcp-server

# 4. CI CLI 端到端测试
#    - 对一个小型测试项目运行 extract → 验证上传成功
npm run test -w packages/ci-cli
```

### Manual Verification

1. **docker-compose up** 启动 MySQL + Ingestion + MCP
2. 对 CodeGraph 自身代码库运行 `codegraph-ci extract`
3. 用 MCP Inspector 或 Claude Desktop 连接 MCP Server，验证：
   - `codegraph_explore` 返回正确的源码片段
   - `codegraph_search` 搜索功能正常
   - `codegraph_node` 返回详细信息 + 源码
   - 切换 `branch` 参数后查询到不同版本的数据
   - `codegraph_versions` 列出可用的历史版本
   - 传入历史 `version_id` 后可查询旧版本图数据
4. 再次运行 `codegraph-ci extract` → 验证 A/B 切换，旧版本数据保留
5. 连续运行 8 次 `codegraph-ci extract` → 验证第 8 次后最早的版本被自动清理（只保留 7 个）
