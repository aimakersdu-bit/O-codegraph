# CodeGraph 脚本文件夹 (scripts) 详细分析指南

本篇文档为您详细解析 `.scripts/` 目录下的所有辅助脚本、命令行用法及其在整个 CodeGraph 生命周期中的具体作用（包含**打包部署**、**语言扩展开发**与**智能体评测**三大板块）。

---

## 1. 根目录脚本：打包、安装与发布流程 (`/scripts/`)

这部分脚本主要用于 CodeGraph 的本地调试编译、面向多平台（macOS, Linux, Windows）的可执行制品打包以及 NPM 发版准备。

### 1.1 `build-bundle.sh` (跨平台自包含二进制打包)
- **用途**：
  为目标平台构建**“自包含包（Self-contained Bundle）”**。它会自动下载对应平台的官方 Node.js 运行时压缩包，将其与编译后的 App 源码及生产依赖（`dependencies`，剔除了 `devDependencies`）打包到一个归档文件内。
  - **核心设计**：由于 CodeGraph 在移除 `better-sqlite3` 转向 Node 自置的 `node:sqlite` 后，已不包含任何 Native C++ 扩展，因此您**可以在任意 OS 上交叉打包任意其他平台的制品**。
  - **特殊参数**：启动器脚本中内嵌了 `--liftoff-only` 参数，强迫 V8 引擎仅对 Tree-sitter WASM 编译使用 Liftoff 基线编译器，彻底避开 Node 22+ 优化编译器带来的 Turboshaft Zone 内存溢出崩溃问题（OOM）。
- **使用方法**：
  ```bash
  # 语法：scripts/build-bundle.sh <target> [node-version]
  # 示例：为 macOS (Apple Silicon M系列芯片) 打包 v24.16.0 运行时的包
  scripts/build-bundle.sh darwin-arm64 v24.16.0
  ```
- **输出**：生成 `release/codegraph-darwin-arm64.tar.gz` (Windows 平台输出 `.zip`)。

### 1.2 `pack-npm.sh` (NPM 薄客户端封装)
- **用途**：
  采用类似 `esbuild` 的薄包（Thin-installer）分发机制。它解压 `build-bundle.sh` 生成的所有平台归档，并将它们重组为 `@colbymchenry/codegraph-darwin-arm64` 等具体平台包。最后生成一个名为 `@colbymchenry/codegraph` 的入口包，将各平台包作为 `optionalDependencies` 引入。
- **使用方法**：
  ```bash
  # 需要先运行 build-bundle.sh 生成相关平台压缩包
  scripts/pack-npm.sh [version]
  ```

### 1.3 `npm-shim.js` (平台分发入口垫片)
- **用途**：
  这是主 NPM 包 `@colbymchenry/codegraph` 的二进制入口垫片。当用户在全局运行 `codegraph` 命令时，该 JS 垫片通过 `process.platform` 和 `process.arch` 动态识别用户的操作系统和 CPU 架构，然后直接运行匹配到的本地自包含 Node 运行时与 CLI 代码，免去了用户本地安装 Node 的繁琐和版本不一致问题。

### 1.4 `local-install.sh` (本地开发热连接调试)
- **用途**：
  在本地开发分支上对代码进行编译后，直接将其注册并软链接（`npm link`）到全局的 `codegraph` 命令中。它极方便地替换本地已安装的发布版，进行全局命令行或 MCP 插件的实机测试。
- **使用方法**：
  ```bash
  # 1. 编译当前分支并热链接到全局
  ./scripts/local-install.sh
  
  # 2. 撤销本地链接，还原回官方发布的最新 NPM 线上版本
  ./scripts/local-install.sh --undo
  ```

### 1.5 `prepare-release.mjs` & `extract-release-notes.mjs` (发版日志整理)
- **用途**：
  自动整理 `CHANGELOG.md`。`prepare-release.mjs` 会自动将 CHANGELOG.md 中的 `## [Unreleased]` 变动提档合并入指定的 `## [<version>]` 标题中，并自动补充当天的时间戳。`extract-release-notes.mjs` 则用于 GitHub Actions 工作流在发布 Release 时自动提取当前版本的 Changelog 文字进行发布。
- **使用方法**：
  ```bash
  node scripts/prepare-release.mjs [version]
  ```

---

## 2. 语言扩展开发脚本 (`/scripts/add-lang/`)

这组脚本是专为**扩展新编程语言语法支持**而设计的开发工具箱。当您需要支持一门新语言时（如 Zig、Rust 等），需要按照以下工具链配合开发：

```
[ 新增语言 WASM ] 
       │
       ▼
1. check-grammar.mjs (验证 WASM 堆是否健康、是否会导致多进程内存溢出)
       │
       ▼ (PASS)
2. dump-ast.mjs (倾倒样本 AST，统计符号节点类型词频)
       │
       ▼ (编写 src/extraction/languages/ 规则文件)
3. verify-extraction.mjs (扫描目标测试项目，断言符号抽取密度，验证效果)
```

### 2.1 `check-grammar.mjs` (Tree-sitter WASM 稳定性校验)
- **用途**：
  在为新语言编写提取规则前，验证该语言的 tree-sitter WASM 包在系统的 `web-tree-sitter` 运行时下是否健康。它会在多语言共存的环境下对一个合法样本进行多次重复解析，防止因 ABI 版本不兼容发生静默的 WASM 堆内存损坏（如 Lua 语法包旧版 ABI 13 在多文件解析时导致依赖关系静默丢失的问题）。
- **使用方法**：
  ```bash
  # 语法：node check-grammar.mjs <语言/WASM路径> <合法的测试源码样本> [迭代测试次数]
  node scripts/add-lang/check-grammar.mjs python test.py 50
  ```

### 2.2 `dump-ast.mjs` (AST 结构与词频转储 - 🌟 扩展语言核心工具)
- **用途**：
  将传入的示例文件解析为缩进的 AST named 节点树，并在底部输出所有 Named 节点的**“词频统计表”**。这对于开发者编写新语言配置非常重要：通过词频表，你可以一眼看清这门语言中哪些节点是函数（如 `function_definition`）、类（如 `class_declaration`）或导入，从而填充到 `LanguageExtractor` 的配置数组中。
- **使用方法**：
  ```bash
  # 语法：node dump-ast.mjs <语言/WASM路径> <测试源码样本> [--depth=限制深度]
  node scripts/add-lang/dump-ast.mjs rust sample.rs --depth=5
  ```

### 2.3 `verify-extraction.mjs` (抽取效果端到端验证)
- **用途**：
  在您编写完语言的提取规则并重新编译后，该工具会自动扫描一个使用该语言的真实代码库，读取 `codegraph status` 的 JSON 汇总，检查提取出的符号密度（符号总数与文件数的占比、依赖边占比）。如果关键符号提取数为 0，则直接以非零状态码退出，便于在 CI/CD 中作为冒烟测试运行。
- **使用方法**：
  ```bash
  node scripts/add-lang/verify-extraction.mjs /path/to/test-repo rust
  ```

---

## 3. 智能体评测与性能基准脚本 (`/scripts/agent-eval/`)

本目录下的脚本构建了 CodeGraph 内部的 **图增强 RAG 评测矩阵（Agent Evaluation Matrix）**，用于评估不同大模型在不同召回策略（Arms A/B 组）下的代码探索和定位能力。

### 3.1 评测基准与 A/B 测试原理
评测程序会在以下 6 个典型技术栈的代码仓库中（需预先克隆至本地），通过提问复杂的架构路径问题（如：“Trace the controller to the service”），来比对 AI 智能体的召回精度：
- `flutter-samples` (Dart/Flutter 跨端)
- `aspnet-realworld` (C#/.NET)
- `spring-mall` (Java/Spring 典型电商)
- `vapor-spi` (Swift/Vapor 服务端)
- `excalidraw` (TypeScript/React 前端复杂画布)
- `spring-halo` (Java 博客系统)

### 3.2 核心评测脚本
- **`arms-matrix.sh` & `arms-F.sh`**：
  控制脚本。用于循环在各个测试项目上执行指定策略组（如 Arm B 传统图召回 vs Arm F 注入函数体/方法链的图增强召回），运行指定次数并保存 Agent 对话和探索 Session。
- **`run-arms.sh`**：
  底层的单次评测运行驱动器。拉起 AI 客户端并在后台注入指定的 CodeGraph MCP 工具和环境变量。
- **`parse-arms.mjs` / `parse-session.mjs`**：
  分析器。用于对评测结束后产生的会话日志执行静态审计，提取 AI 找对故障代码的准确率、Token 消费量、以及单次排查产生的 LLM API 成本。
- **`probe-context.mjs` / `probe-node.mjs`**：
  调试探测器。用于在评测运行期间，模拟大模型向数据库查询某个具体 Node 的上下文输出，以便排查召回噪声。
