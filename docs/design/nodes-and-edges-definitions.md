# CodeGraph 图概念定义：点 (Nodes) 与边 (Edges)

本篇设计与概念文档详细定义了 CodeGraph 图谱中的**点（Nodes）**与**边（Edges）**分类，并提供了其在多种不同编程语言环境下的具体代码映射示例，作为核心图提取与解析模块的参考指南。

---

## 1. 什么是点 (Nodes / 符号节点)

在 CodeGraph 的设计中，**点 (Node)** 代表代码库中具备物理或逻辑边界的**具体实体或声明 (Entity / Symbol)**。在底层的 SQLite `nodes` 表中，每一行记录都代表一个唯一的点。

系统支持以下 **22 种点类型**，涵盖文件组织、类型系统、执行控制以及前端组件等维度：

### 1.1 点类型分类与定义对照表

| 节点类型 (`kind`) | 物理含义 / 概念解释 | 示例代码与语言 |
| :--- | :--- | :--- |
| **`file`** | 磁盘上的物理源代码文件本身。 | `src/controllers/user.ts` (TS), `User.java` (Java) |
| **`namespace`** | 文件之上的逻辑划分空间 / 包名。 | `package com.shopping.mall` (Java) |
| **`module`** | 模块声明范围。 | `module Auth` (Ruby), `mod db` (Rust) |
| **`class`** | 面向对象编程中的类定义。 | `class UserService {}` (Java/TS) |
| **`struct`** | 结构体声明。 | `type DB struct {}` (Go), `struct Config {}` (Rust) |
| **`interface`** | 接口协议。 | `interface Repository` (Java/TS) |
| **`protocol`** | 协议声明（多见于 Swift/ObjC）。 | `@protocol Delegate` (ObjC), `protocol Segue` (Swift) |
| **`trait`** | 行为特征声明（Rust 专用类型）。 | `trait Render { fn draw(&self); }` (Rust) |
| **`enum`** | 枚举结构定义。 | `enum Direction { Up, Down }` (TS/Rust) |
| **`enum_member`** | 枚举中的具体名值项。 | `Up` 属于 `enum Direction` 的 enum_member。 |
| **`type_alias`** | 类型别名定义。 | `type UserID = string;` (TS) |
| **`function`** | 独立于类/结构体之外的全局或自由函数。 | `function calculateSum(a, b)` (JS), `def main():` (Py) |
| **`method`** | 类、接口、结构体或 Trait 内部的成员函数。 | `public void save()` (Java), `func (db *DB) Close()` (Go) |
| **`field`** | 类或结构体的成员变量属性字段。 | `private String username;` (Java) |
| **`property`** | 附带特殊读取/写入控制符（如 getter/setter）的属性。 | `public string Name { get; set; }` (C#) |
| **`variable`** | 可变的全局或局部变量。 | `let activeCount = 0;` (TS), `var index = 1` (Kotlin) |
| **`constant`** | 不可变常量。 | `const MAX_CONNECTIONS = 10;` (JS), `pub const LIMIT: u32 = 5;` (Rust) |
| **`parameter`** | 函数或方法的入参声明。 | `verify(User user)` 中的 `user` 节点。 |
| **`import`** | 导入外部依赖或模块的语句。 | `import { useState } from 'react';` (JS/TS) |
| **`export`** | 公开暴露自身符号的导出语句。 | `export default class App {}` (TS) |
| **`component`** | 前端框架中的特定 UI 组件。 | `Header.svelte` (Svelte), `Button.vue` (Vue) |
| **`route`** | 服务端或前端声明的 URL 路由端点。 | `router.get('/users', handler)` (JS/Express) |

---

## 2. 什么是边 (Edges / 关系边)

在 CodeGraph 中，**边 (Edge)** 代表符号节点之间存在的**物理包含或语义依赖关联 (Relationship / Dependency)**。在底层的 SQLite `edges` 表中，每一条记录均含有 `source` (起点 Node ID) ➔ `target` (终点 Node ID) 的单向指针。

系统定义了以下 **12 种边类型**：

### 2.1 物理层级关系
- **`contains` (物理嵌套/包含)**：
  - **概念**：描述代码元素之间的物理父子嵌套结构（如文件包含类，类包含方法）。
  - **示例**：`file ➔ contains ➔ class`；`class ➔ contains ➔ method`；`enum ➔ contains ➔ enum_member`。

### 2.2 语义与依赖关系
- **`calls` (调用)**：
  - **概念**：指示一个可执行单元（方法或函数）在运行期发起了对另一个可执行单元的调用。
  - **示例**：`Controller.login() ➔ calls ➔ AuthService.verify()`。
- **`references` (普通引用/依赖)**：
  - **概念**：泛指一个符号读取了另一个符号（如函数内使用常量）或者将某种类型作为依赖导入。
  - **示例**：`method ➔ references ➔ constant`。
- **`imports` (跨文件导入)**：
  - **概念**：文件之间显式的导入关系纽带。
  - **示例**：`fileA.ts ➔ imports ➔ fileB.ts`。
- **`exports` (导出暴露)**：
  - **概念**：文件与其向外公开的内部符号点之间的映射关联。
  - **示例**：`index.ts ➔ exports ➔ helperFunction`。

### 2.3 面向对象与继承关系
- **`extends` (类/接口继承)**：
  - **概念**：子类继承基类，或者子接口继承父接口。
  - **示例**：`CatClass ➔ extends ➔ AnimalClass`。
- **`implements` (类接口实现)**：
  - **概念**：类实现了对应的接口、Trait或 Protocol。
  - **示例**：`MysqlRepository ➔ implements ➔ IRepository`。
- **`overrides` (多态重写)**：
  - **概念**：子类重写覆盖了父类定义的相同签名方法。
  - **示例**：`Child.draw() ➔ overrides ➔ Parent.draw()`。

### 2.4 实例化与关联关系
- **`instantiates` (对象创建)**：
  - **概念**：在某个执行域中通过 `new` 表达式或语言特有的类名调用，创建了某个类的实例。
  - **示例**：`method ➔ instantiates ➔ ClassA`（代表在 `method` 执行中执行了 `new ClassA()` 或 Python 的 `ClassA()`）。
- **`type_of` (类型定义声明)**：
  - **概念**：指示变量或方法入参指向具体的类型节点。
  - **示例**：`parameter: user ➔ type_of ➔ class: User`。
- **`returns` (返回类型关联)**：
  - **概念**：方法或函数返回的数据归属于特定的接口、类或结构体。
  - **示例**：`method ➔ returns ➔ interface: Result`。
- **`decorates` (装饰器注解应用)**：
  - **概念**：注解或装饰器作用于特定的符号声明之上。
  - **示例**：`annotation: @Service ➔ decorates ➔ class: UserServiceImpl`。
