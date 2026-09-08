# ci-cli 改造计划：直接导出到 SQLite

## 目标
- 保留当前 `ci-cli` 的本地索引能力。
- 继续先在目标项目中跑 `CodeGraph.init/open` 和 `indexAll()`。
- 不再把图数据上传到 ingestion server。
- 将 `sourceCode` 直接写入导出 SQLite 的 `nodes.source_code` 字段。
- `source_code` 只保存受限代码片段，不能通过导出库拼回完整代码库文件。
- 每个 `repo+version` 生成 1 个独立 SQLite 文件。
- `version` 由 CI 调用方显式传入，格式固定为 `YYMMDD.major.minor.build`，例如 `260827.1.0.2233`。
- 导出目录建议通过 `CODEGRAPH_OUTPUT_DIR` 配置，默认放在当前工作目录下的 `codegraph-exports/`。

## 现状
当前 `ci-cli` 的流程是：
1. 在目标项目里初始化或打开 `CodeGraph`
2. 执行全量索引
3. 从本地 `.codegraph` / SQLite 中读取 `nodes / edges / files / metadata`
4. 逐个 node 重新从源码文件切出 `sourceCode`
5. 通过 HTTP `POST /api/v1/ingest` 上传到 ingestion server

这套流程里，`sourceCode` 已经被构造出来了，只是最后落点在远端服务。

## 新方案
把最后一步改成：
1. 继续做本地索引和 `sourceCode` 切片
2. 直接写入一个导出 SQLite 文件
3. 不再调用 ingestion server

导出 SQLite 文件建议命名为：
`<repo>_<version>.db`

命名规则建议：
- 仅保留字母、数字、下划线
- 其它字符统一替换为 `_`
- 连续 `_` 合并
- 保留原始大小写

示例：
`eebank/ccs-abd-x23 + 260827.1.0.2233 -> eebank_ccs_abd_x23_260827_1_0_2233.db`

导出目录建议：
- `CODEGRAPH_OUTPUT_DIR` 指定时，写到该目录
- 未指定时，默认写到 `./codegraph-exports/`
- 每次导出都是一次全新生成，直接创建目标 `.db` 文件即可

## 关键改动点

### 1. 继续使用本地 CodeGraph 做索引
- `extractAndBuildPayload()` 的前半段保留。
- 仍然用 `CodeGraph.init/open()` 和 `indexAll()` 生成图数据。
- 继续从源码文件中按行号切出 `sourceCode`。

### 2. 新增本地 SQLite 导出层
- 新建一个 SQLite writer，把图数据直接写入导出数据库。
- `nodes` 表需要支持 `source_code` 字段。
- `sourceCode` 在这里不再是临时 payload 字段，而是最终持久化字段。
- `source_code` 不能对所有 node 无限制写入，需要做片段约束。

### 3. 去掉 ingestion server 上传
- 删除或替换 `uploadPayload()` 这条 HTTP 路径。
- 不再依赖 `CODEGRAPH_API_KEY`。
- 不再要求 `ingestionUrl`。
- 原来上传给 server 的 JSON 消息，会变成直接落库的数据。

### 4. 输出文件按 `repo+version` 固定
- 每个 `repo+version` 生成一个独立 `.db` 文件。
- `version` 不再表示 Git branch，而是 CI 产物版本号。
- `version` 示例格式：`260827.1.0.2233`。
- 每次导出都是全新生成，不依赖旧文件做增量更新。
- 由于 ci-cli 每次都在全新的代码库环境里执行，通常不会遇到历史导出文件。

### 5. 约束 source_code，避免拼回完整源码
- 只允许部分高价值 node 写入 `source_code`。
- 不给 `file`、`module`、`class`、`interface`、`struct`、`enum`、`import`、`export`、`property`、`field`、`variable` 等节点写完整源码。
- 默认只给 `function`、`method`、`route`、`component` 写片段。
- 单个 node 的 `source_code` 最多 80 行或 8 KB，超过则置空。
- 单个源码文件写入导出库的 `source_code` 总覆盖不得超过原文件的 30%，且最多 200 行。
- 同一文件内片段重叠时，优先保留更小、更具体的 callable 节点，跳过大范围或重复范围。
- 不做“截断后保存半段函数体”，超过限制时直接不保存 `source_code`，避免产生误导性代码。

`kind` 含义简表：

| kind | 含义 | 示例 |
|---|---|---|
| `function` | 函数 | `function sum(a, b) {}` |
| `method` | 方法 | `class A { run() {} }` |
| `route` | 路由定义，通常是框架识别出的请求入口 | `app.get('/users', handler)` |
| `component` | 组件，常见于前端或框架视图单元 | `export default defineComponent(...)` |
| `class` | 类 | `class UserService {}` |
| `interface` | 接口 | `interface UserDTO {}` |
| `struct` | 结构体 | `struct User {}` |
| `trait` | Rust trait / 抽象能力定义 | `trait Readable {}` |
| `protocol` | 协议 / 接口式约定 | `protocol FooDelegate {}` |
| `enum` | 枚举类型 | `enum Status {}` |
| `enum_member` | 枚举成员 | `ACTIVE` |
| `field` | 成员字段 | `private name: string;` |
| `property` | 属性 | `get fullName() {}` |
| `variable` | 变量 | `const token = ...` |
| `constant` | 常量 | `const MAX_SIZE = 100` |
| `parameter` | 参数 | `function f(userId) {}` 里的 `userId` |
| `type_alias` | 类型别名 | `type ID = string \| number` |
| `namespace` | 命名空间 / 包作用域 | `namespace com.example {}` |
| `module` | 模块 | `export { Foo } from './foo'` 所属模块 |
| `file` | 文件节点 | `src/app.ts` |
| `import` | 导入引用 | `import { x } from './x'` |
| `export` | 导出项 | `export const x = 1` |

这些阈值的配置来源：

- CLI 参数：`packages/ci-cli/src/index.ts`
  - `--max-node-source-lines`
  - `--max-node-source-bytes`
  - `--max-file-source-lines`
  - `--max-file-source-coverage`
- 环境变量：`packages/ci-cli/src/config.ts`
  - `CODEGRAPH_MAX_NODE_SOURCE_LINES`
  - `CODEGRAPH_MAX_NODE_SOURCE_BYTES`
  - `CODEGRAPH_MAX_FILE_SOURCE_LINES`
  - `CODEGRAPH_MAX_FILE_SOURCE_COVERAGE`
- 默认值：`packages/ci-cli/src/config.ts`

### 6. 为什么要这样约束
- `source_code` 的目标是帮助理解关键实现，不是把整个源码仓库再存一遍。
- 如果给所有 node 都存完整源码，多个片段叠加后可能接近复原原文件，失去“片段”设计的意义。
- 限制 node 类型和覆盖率，可以控制导出库体积，避免 CI 产物过大。
- 只保留高价值 callable 节点，能让导出库更像“可检索的代码索引”，而不是“源码镜像”。

## 需要改的文件

### `packages/ci-cli/src/extractor.ts`
- 保留索引和 `sourceCode` 组装逻辑。
- 把返回值从“上传 payload”改成“导出用图数据”。
- 让导出层接手后续写库动作。

### `packages/ci-cli/src/uploader.ts`
- 目前这里负责 HTTP 上传。
- 建议重构为 SQLite 导出器，或者新建 `sqlite-exporter.ts` 并让这里退出职责。
- 原有 `IngestionPayload` 可以改成导出内部结构，保留 `sourceCode` 字段。

### `packages/ci-cli/src/index.ts`
- 移除 ingestion server 相关参数、鉴权和上传调用。
- 增加输出目录、repo、version 的解析和校验。
- 将原 `--branch` 参数替换为 `--version <version>`。
- 校验 `version` 格式，建议正则为 `^\d{6}\.\d+\.\d+\.\d+$`。

### `packages/ci-cli/package.json`
- 去掉不再需要的 ingestion server 依赖。
- 如果导出层需要额外 SQLite 运行时，再补对应依赖。

### 新增导出层文件
- `packages/ci-cli/src/sqlite-exporter.ts`
- `packages/ci-cli/src/export-db.ts`
- `packages/ci-cli/src/db-name.ts`

## SQLite 表与字段
导出库的 `nodes` 表需要包含：
- `id`
- `kind`
- `name`
- `qualified_name`
- `file_path`
- `language`
- `start_line`
- `end_line`
- `start_column`
- `end_column`
- `docstring`
- `signature`
- `visibility`
- `is_exported`
- `is_async`
- `is_static`
- `is_abstract`
- `decorators`
- `type_parameters`
- `updated_at`
- `source_code`

`source_code` 字段写入规则：
- 允许为空
- 不是每个 node 都必须有值
- 只保存受限片段
- 不保证覆盖完整文件
- 不作为源码归档使用

其余表至少保留：
- `edges`
- `files`
- `project_metadata`

建议再加：
- `schema_versions`
- `export_metadata`

`export_metadata` 可记录：
- `repo`
- `version`
- `generated_at`
- `source_project_root`
- `codegraph_version`

如果后续要做历史版本，再加：
- `version_history`
- `active_versions`

## 可行性评估
**可行性：高**
- `sourceCode` 在 `ci-cli` 里本来就已经构造出来了。
- 删除上传动作后，主链路会更短。
- 本地写 SQLite 比 HTTP 上传更少依赖，失败面更小。

**实现难度：中**
- 主要工作不是抽取，而是把“导出库 schema + 写入逻辑 + 文件命名”接好。

## 风险评估

### 1. SQLite 表结构不匹配
当前目标项目的本地 SQLite schema 里，`nodes` 表没有 `source_code` 字段。
所以导出层不能直接复用当前本地 `.codegraph` 数据库，必须单独设计导出 schema。

### 2. 文件名冲突与路径安全
`repo+version` 直接拼文件名容易撞名或引入非法字符。
需要统一做归一化和路径清洗。
`version` 中的 `.` 统一替换为 `_`，避免不同平台或工具对文件名解析不一致。

### 3. 运行环境默认是干净的
ci-cli 每次执行都在全新的代码库环境下进行，通常不会存在历史导出的 `.db` 文件。
这意味着可以按“直接新建文件”的方式设计，不需要覆盖旧文件的复杂逻辑。

### 4. 数据体积增长
`source_code` 会显著增加导出库体积。
如果项目很大，磁盘占用会比只存结构图高很多。

缓解方式：
- 限制 node 类型
- 限制单 node 行数和字符数
- 限制单文件覆盖率
- 对超限 node 只保留结构信息，不写 `source_code`

### 5. 运行时兼容性
如果导出层使用 Node SQLite 能力，需要确认运行环境支持对应版本。
否则需要选一个稳定的 SQLite 运行时方案。

### 7. 失去远端 ingestion 服务
去掉 HTTP 上报后，后续如果还需要集中查询、同步或审计，要再补新的消费方式。

### 8. 当前上报消息结构变化
原来发给 ingestion server 的消息体是：
- `repo`
- `version`
- `nodes`
- `edges`
- `files`
- `metadata`

其中每个 node 还会附带：
- `sourceCode`

现在这组消息不再走 HTTP，而是直接写进导出 SQLite。

### 9. source_code 可能拼回完整文件
如果给所有 node 都保存完整源码片段，多个片段叠加后可能接近完整文件。
这是本方案需要主动避免的风险。
第一版必须实现片段预算：
- 节点类型白名单
- 单节点最大 80 行 / 8 KB
- 单文件最大 30% 覆盖率 / 200 行
- 重叠片段去重

## 建议的落地顺序
1. 先确认导出 SQLite 的 schema。
2. 再把 `ci-cli` 的输出从 HTTP 上传改成本地写库。
3. 接着做文件名规则和原子落盘。
4. 最后补测试，验证 `source_code` 是否真正进入导出库。

## 验收标准
- 不再调用 ingestion server。
- 导出目录里能生成 `<repo>_<version>.db`。
- 示例文件名：`eebank_ccs_abd_x23_260827_1_0_2233.db`。
- 导出库中的 `nodes.source_code` 有值。
- `nodes.source_code` 不覆盖完整源码文件。
- 单文件 source 片段覆盖率不超过 30% 或 200 行。
- 同一 `repo+version` 重跑会重新生成同名 `.db` 文件。
- 导出文件可被 SQLite 工具正常打开和查询。
- 正常场景下不依赖历史导出文件。
