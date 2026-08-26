# CodeGraph 用户手册 (PDF 转换版)

> **注意**: 本文档为 [CodeGraph.pdf](file:///Users/bigc/Downloads/claw/codegraph/docs/CodeGraph.pdf) 的 1:1 完整文字提取与 Markdown 转换版本，保留了原始文件的页面结构与组织形式，并以相对路径嵌入了所有的原始截图。

---

### === PAGE 1 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (1/26)

# CodeGraph

## 1. CodeGraph CLI 安装

### 1、前置环境 node > 18.x
* **下载地址**: `http://sync.qa.bx/card/api/v1/homeController/downloadFile.do?fileId=ec77b74316ca43039fc457519b52e29b`
* **配置方式**: 下载解压到本地目录，配置环境变量。`Win+R` 输入 `sysdm.cpl` 回车，在“系统属性” -> “高级” -> “环境变量”中按图示将 Node.js 的目录添加至 `Path` 即可（版本使用 v18+）。

![环境变量配置图示](images/page_1_0_X48.png)

### 2、安装 CodeGraph
在 windows cmd 窗口执行如下命令：

---

### === PAGE 2 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (2/26)

```cmd
npm set registry http://maven.qa.bx:9090/repository/bxbank_npm-group/
npx @colbymchenry/codegraph@1.1.6
```

在执行命令后，会显示交互选项，请进行如下选择：
1. **选择在哪个 Agent 中安装**：`[ 如 opencode 或 Claude Code ]` -> 按 **回车** ![操作图示](images/page_2_0_X70.png)
2. **确认是否继续**：选择 `Yes` -> 按 **回车** ![操作图示](images/page_2_1_X78.png)
3. **选择安装项目范围**：选择 `All projects` -> 按 **回车** ![操作图示](images/page_2_2_X81.png)
4. **是否自动更改配置**：选择 `Yes` -> 按 **回车** ![操作图示](images/page_2_3_X88.png)

---

### === PAGE 3 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (3/26)

5. **是否立即启动**：选择 `Yes` -> 按 **回车** ![操作图示](images/page_3_0_X93.png)
6. **是否生成配置说明**：选择 `Yes` -> 按 **回车** ![操作图示](images/page_3_1_X96.png)

![安装验证图示](images/page_3_2_X99.png)
![成功提示](images/page_3_3_X106.png)

显示 **“安装成功”**。

#### *** OpenCode 安装验证 ***
**必须验证**：`codegraph` MCP 安装成功及生成 `AGENTS.md`。

> [!IMPORTANT]
> **必须**：生成的 `AGENTS.md` 文件**必须移动到 `agents` 目录下**，如果当前项目根目录下无 `agents` 目录，需自行创建。否则在 OpenCode 中使用不会生效。
> *(原理：这样 OpenCode 主 Agent 会优先用 CodeGraph 的图谱查询，而不是盲目翻文件)*

---

### === PAGE 4 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (4/26)

#### *** 创建 git webhook 确保每次 commit 代码自动构建索引 ***
下载脚本，双击执行即可。
* 脚本名称: `setup-git-hooks.sh`
* 大小: `0.58 KB`
* 更新时间: `2026-07-01 19:29`

![Webhook下载图示](images/page_4_0_X129.png)
![Webhook执行图示](images/page_4_1_X132.png)

---

### === PAGE 5 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (5/26)

## 2. CodeGraph 如何使用？

### 1、OpenCode 中使用

#### 1) 打开项目
在 OpenCode 编辑器中打开当前需要分析的项目代码库。

![OpenCode 打开项目界面](images/page_5_0_X160.png)

---

### === PAGE 6 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (6/26)

#### 2）CodeGraph 初始化项目 + 首次建图
*(首次打开项目时，CodeGraph 会在后台自动扫描项目并建立初始图谱，输出图谱构建完成的通知)*

![首次构建图谱图示 1](images/page_6_0_X164.png)
![首次构建图谱图示 2](images/page_6_1_X174.png)

---

### === PAGE 7 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (7/26)

**\*\*\* 构建索引图谱成功 \*\*\***

![构建索引成功通知](images/page_7_0_X178.png)

#### 3）问答使用，分析项目
您可以在 OpenCode 问答框输入当前项目相关的问题。
* **示例**: 问 `ldap 如何工作的`

![输入问答提问图示](images/page_7_1_X181.png)

---

### === PAGE 8 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (8/26)

查看执行过程可以发现，OpenCode 自动调用了 `codegraph_codegraph_explore` 工具进行搜索并给出了结果。

![调用工具执行过程](images/page_8_0_X207.png)

---

### === PAGE 9 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (9/26)

*(OpenCode 返回的具体 LDAP 分析结果，包括 LdapServiceImpl.java 中具体的 LDAP Authentication 和 LDAP User Query 两部分代码和逻辑解析)*

![OpenCode 分析结果截图](images/page_9_0_X212.png)

---

### === PAGE 10 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (10/26)

### 2、Comate 中使用

#### 1) IDE 打开项目
使用集成了 Comate 插件的 IDE 打开项目代码库。

#### 2) 初始化项目 + 首次建图
在 IDE 的 Terminal (终端) 中执行以下命令进行初始化：
```bash
codegraph init
```

![Comate 终端初始化图谱](images/page_10_0_X216.png)

---

### === PAGE 11 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (11/26)

#### 3）配置 CodeGraph MCP
确保 CodeGraph MCP 的状态必须为打开状态。

![MCP 开启开关 1](images/page_11_0_X226.png)
![MCP 开启开关 2](images/page_11_1_X228.png)

---

### === PAGE 12 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (12/26)

**MCP 配置文件配置如下**:
```json
{
    "mcpServers": {
        "codegraph": {
            "type": "stdio",
            "command": "codegraph",
            "args": [
                "serve",
                "--mcp"
            ],
            "enabled": true,
            "disabled": false
        }
    }
}
```

![MCP JSON配置示例图](images/page_12_0_X242.png)

---

### === PAGE 13 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (13/26)

*(在 Comate 聊天框右上角点击 `...`（更多），在下拉菜单中选择 `MCP` 进入 MCP 配置项，确保 MCP 工具处于 Enabled 开关开启状态)*

![Comate 菜单入口选择图](images/page_13_0_X264.png)

---

### === PAGE 14 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (14/26)

#### 4）问答使用，分析项目
您可以在 Comate 问答框输入当前项目相关的问题。
* **示例**: 调用 `codegraph mcp` 查询分析 `how does ldap work`

![Comate 提问输入图](images/page_14_0_X268.png)

---

### === PAGE 15 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (15/26)

*(Comate 的问答回复结果，显示在后台调用了 MCP Tool `codegraph/codegraph_explore` 成功分析并列出了 LDAP 相关的配置类 LdapTemplateConfig 和服务实现 LdapServiceImpl 的路径与代码结构)*

![Comate 结果展示图](images/page_15_0_X278.png)

---

### === PAGE 16 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (16/26)

### 3、中心化部署 API

* **接口地址 (URL)**: `http://10.88.160.129:3001/api/explore`

![中心化 API 地址页面图](images/page_16_0_X282.png)

---

### === PAGE 17 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (17/26)

* **请求方式**: POST
* **Header**: `Content-Type: application/json`
* **请求参数 (JSON)**:
  ```json
  {
      "repo": "bxbank/MSC/msgcenter",   // 代码库标识
      "branch": "Release_251210_MSC",   // 分支名称
      "query": "sendWeixinTemplate",    // 检索词/提问
      "maxFiles": 6                     // 可选，返回最大文件数
  }
  ```
* **返回参数**:
  ```json
  {
      "content": [
          {
              "type": "text",
              "text": "## Code Context\n\n**Query:** sendWeixinTemplate\n\n### Entry Points\n..."
          }
      ]
  }
  ```
* **调用示例**:
  *(使用 Postman 发送 POST 请求至中心化 API 地址并成功返回 JSON 内容，耗时约 73ms，返回内容包含 sendWeixinTemplate 的代码调用上下树)*

![Postman API 调用演示](images/page_17_0_X330.png)

---

### === PAGE 18 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (18/26)

## 3. 使用效果

### 1、对比

| 模式 | Token 消耗 | 问答耗时 |
| :--- | :--- | :--- |
| **未使用 CodeGraph** | > 262512 | 11 分 46 秒 |
| **使用 CodeGraph** | 79326 | 4 分 58 秒 |

![对比柱状图/指标页](images/page_18_0_X360.png)

#### 1）未使用 CodeGraph
##### a. Token 构成
`28562 + 90285 + 56021 + 87644` + 中间会话压缩一次

---

### === PAGE 19 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (19/26)

中间会话压缩一次。

![会话压缩通知图 1](images/page_19_0_X364.png)
![会话压缩通知图 2](images/page_19_1_X367.png)

---

### === PAGE 20 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (20/26)

##### b. 问答耗时：
11 分 46 秒

![未使用图谱耗时展示 1](images/page_20_0_X371.png)
![未使用图谱耗时展示 2](images/page_20_1_X373.png)

---

### === PAGE 21 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (21/26)

*(未使用 CodeGraph 时，AI 引擎需要海量搜索文件并加载大量冗余上下文，导致 Token 极快超限触发会话压缩)*

![大量文件暴力搜索图示 1](images/page_21_0_X379.png)
![大量文件暴力搜索图示 2](images/page_21_1_X384.png)

---

### === PAGE 22 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (22/26)

#### 2）使用 CodeGraph
##### a. Token 数
Token 数为 `79326`。

##### b. 问答耗时：
4 分 58 秒

![使用图谱后耗时展示](images/page_22_0_X391.png)

---

### === PAGE 23 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (23/26)

*(使用 CodeGraph 后，AI 精准搜索和加载相关符号及依赖文件切片，不引入无用文件，大大节省 Token 并提升响应速度)*

![使用图谱后精准搜索文件图示 1](images/page_23_0_X399.png)
![使用图谱后精准搜索文件图示 2](images/page_23_1_X403.png)

---

### === PAGE 24 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (24/26)

## 4. Q & A

### 1、`codegraph init` 命令的作用？
`codegraph init` 会在项目根目录下创建 `.codegraph/` 目录并构建完整的本地代码依赖图谱，只需一条命令即可搞定。
在此之后，原生文件监视器（File Watcher）会在每次发生更改时自动保持索引同步，几乎不需要手动重建。
每个项目的数据都存储在项目根目录下的 `.codegraph/` 目录中，其中包含一个本地 SQLite 数据库（`codegraph.db`），所有数据和源码都不会离开您的计算机。

### 2、OpenCode 无 codegraph mcp 工具？
需检查 OpenCode 配置文件中是否有 codegraph mcp 配置，配置文件路径如下：
* **Windows**: `C:\Users\<您的用户名>\.config\opencode\opencode.json`
* **macOS/Linux**: `~/.config/opencode/opencode.json`

![OpenCode配置文件夹结构](images/page_24_0_X422.png)

**检查是否包含如下配置**:
```json
"codegraph": {
    "type": "local",
    "command": [
        "codegraph",
        "serve",
        "--mcp"
    ],
    "enabled": true
}
```

![OpenCode配置JSON编辑图示](images/page_24_1_X425.png)

---

### === PAGE 25 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (25/26)

### 3、如何进行全量重建索引？
在终端中执行以下命令：
```bash
codegraph index # full re-index
```

![全量重建索引命令](images/page_25_0_X434.png)

### 4、如何只更新发生变化的部分索引？
在终端中执行以下命令进行增量同步：
```bash
codegraph sync # incremental update of changed files
```

![增量同步索引命令](images/page_25_1_X442.png)

### 5、`codegraph status` 命令有什么用？
`codegraph status` 用来查看当前项目索引的健康状态和统计信息。执行后，会显示：
* 索引了多少个文件
* 索引了多少个符号
* 有多少条依赖/调用关系边
* 索引是否正常、有没有损坏
* 上次同步的时间

加上 `--json` 参数可以输出机器可读 of JSON 格式，方便在自动化脚本或 CI/CD 中使用：
```bash
codegraph status --json
```
**典型使用场景**: 在运行 `sync` 或 `explore` 之前，先运行 `status` 检查，确认索引是完整的且未损坏。

---

### === PAGE 26 ===

**7/1/2026**
**文件源**: `file:///data/ones/files/wiki/1782907492909269.html` (26/26)

如果状态异常（比如节点数为 0 或文件数明显不对），就该使用 `codegraph index --force` 重建索引了。

![索引状态健康检查](images/page_26_0_X469.png)
![强制重建索引说明](images/page_26_1_X471.png)
