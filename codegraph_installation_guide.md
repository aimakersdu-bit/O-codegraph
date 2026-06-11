# CodeGraph v0.9.9 私有化部署与 opencode 使用配置手册

本手册用于指导团队成员如何在本地安装 CodeGraph 客户端，并通过内网私有 NPM 服务将其配置为 **opencode** 的插件与技能（Skill），实现本地离线、低能耗、智能的代码语义分析。

---

## 第一部分：通过内网私有源全局安装 CodeGraph

为了确保大家在离线或内网环境下都能顺利安装，且避免本地 Node.js 版本（如低于 v20.0.0）冲突，请在终端（Windows 的 Git Bash/CMD/PowerShell，或 macOS/Linux 的 Terminal）中执行以下命令进行全局安装：

```bash
npm install -g @colbymchenry/codegraph --registry=http://maven.qa.bx:9090/repository/bxbank_npm-group/ --ignore-engines
```

> **参数说明**：
> * `--registry=...`：指定内网私有 NPM 服务器的完整路径。
> * `--ignore-engines`：忽略本地 Node.js 运行引擎的版本检测（CodeGraph 在运行时会自动调用其内置的 Node v24，此参数可以避免本地 Node.js 版本过低时安装报错）。

安装完成后，在终端运行以下命令验证是否安装成功：
```bash
codegraph --help
```

---

## 第二部分：为 opencode 启用 CodeGraph 插件

### 1. 自动配置方式（推荐）
在终端中直接运行以下命令，CodeGraph 会自动检测并向您的 `opencode` 全局配置文件中写入插件信息：
```bash
codegraph install --target=opencode --location=global --yes
```

### 2. 手动配置方式（备用）
若自动配置失败，可以手动编辑或创建以下路径的配置文件：
* **Windows**: `%APPDATA%\opencode\opencode.jsonc` (通常是 `C:\Users\<您的用户名>\AppData\Roaming\opencode\opencode.jsonc`)
* **macOS / Linux**: `~/.config/opencode/opencode.jsonc`

在配置文件中，确保 `mcp` 段落中包含 `codegraph` 项：
```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "codegraph": {
      "type": "local",
      "command": ["codegraph", "serve", "--mcp"],
      "enabled": true
    }
  }
}
```

配置完成后，请**彻底重启**您的 `opencode` 客户端。

---

## 第三部分：为 opencode 配置 CodeGraph 技能 (Skill)

为了让 AI 智能体（Agent）理解如何规范、高效地使用 CodeGraph 本地工具，我们可以为其配置一个专属的 Skill。

### 1. 创建技能文件
在您本地存放 `opencode` 技能的目录下（通常是 `~/.gemini/config/skills/`，如果目录不存在可以手动创建），新建一个 `codegraph` 目录，并创建 `SKILL.md` 文件：

* **文件路径**: `~/.gemini/config/skills/codegraph/SKILL.md`

### 2. 写入 Skill 内容 (`SKILL.md`)
请复制以下内容写入该文件中：

```yaml
---
name: codegraph
description: 当用户提出有关代码结构、符号关系、调用链路（主调/被调）、改动影响范围（影响半径）、项目架构分析，或者需要在已安装 CodeGraph 的项目中搜索代码时，使用此技能。
---

# CodeGraph 技能指南

本技能指导 AI 智能体（Agent）如何使用 CodeGraph 进行语义代码分析、调用链路追踪以及重构影响范围分析。

## 初始化与健康检查

### 1. 检查索引就绪状态
在向 CodeGraph 发送具体查询前，需确认当前项目是否已索引：
- 运行 `codegraph_status` (MCP 工具) 或命令行 `codegraph status`。
- 如果提示项目未初始化（即项目根目录下不存在 `.codegraph/` 目录），主动向用户提议并运行以下初始化命令：
  ```bash
  codegraph init -i
  ```

### 2. 检查同步状态
- 留意工具返回结果中是否存在 `### Pending sync:` 页脚或警告横幅（`⚠️ Some files referenced below were edited since the last index sync...`）。
- 若有文件处于“挂起同步”状态，应直接使用 `view_file` 或 `Read` 工具读取该文件的最新内容以保证准确性。

---

## 工具选择与使用场景

请根据具体的交互意图选择最合适的 CodeGraph 工具：

| 查询意图 | 推荐工具 | 最佳实践 |
|---|---|---|
| **首要工作流**：“X 是如何工作的？”、架构总览、链路追踪、熟悉新业务区域 | `codegraph_explore` | **首选工具**。单次调用即可返回关联符号在文件中的源代码，通常是唯一需要调用的工具。 |
| **调用链路追踪**：“X 是如何调用到 Y 的？ / 从 X 到 Y 的调用路径” | `codegraph_explore` | 传入链路中的关键符号名称（如 `mutateElement renderScene`），它能自动追踪包括动态派发（如回调函数、React 重新渲染、JSX 子组件）在内的隐式调用。 |
| **快速定位符号**：“寻找名为 X 的定义” | `codegraph_search` | 比常规 grep 快得多。会返回符号类型、文件位置及函数签名。 |
| **追踪主调函数**：“有哪些地方调用了 X？” | `codegraph_callers` | 查找所有调用该符号的父级函数。 |
| **追踪被调函数**：“X 调用了哪些子函数？” | `codegraph_callees` | 展开该符号的所有子调用。 |
| **重构影响分析**：“修改 X 会影响到哪些地方？会破坏什么？” | `codegraph_impact` | 自动计算符号的传递依赖（爆炸半径分析），无需手动层层向上查找。 |
| **获取具体代码**：“查看 X 符号的源码（尤其是 overloaded 重载符号）” | `codegraph_node` (设置 `includeCode: true`) | 在一个调用中返回该符号名称所有重载版本的具体代码。 |
| **工程目录检索**：“X 目录下有哪些文件？” | `codegraph_files` | 速度快于普通文件系统扫描。 |

---

## 应避免的反面模式 (Anti-Patterns)

- **禁止使用 grep 重复校验**：CodeGraph 结果由底层 AST 语法树分析得出。请直接信任工具返回的结果，避免为了“双重确认”而频繁使用系统的 grep，这会浪费上下文和 Token。
- **不要循环调用 `codegraph_node`**：如果需要查看多个符号，应使用 `codegraph_explore` 将所有符号名称作为输入，在单次请求中合并返回。
- **不要让智能体自行发散查找**：遇到业务逻辑问题时直接使用 `codegraph_explore` 获取代码，避免智能体通过生成多个读文件子任务进行盲目探索。
```

---

## 第四部分：项目日常开发流程

1. **项目初始化**
   开发人员在拉取新项目或在现有项目下使用时，只需进入根目录运行一次初始化：
   ```bash
   cd /path/to/your-project
   codegraph init -i
   ```
2. **静默同步**
   日常编码过程中，CodeGraph 启动的 MCP 服务会监听本地文件变化并做增量更新，**无需手动执行 sync 操作**。
