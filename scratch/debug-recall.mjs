import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Load CodeGraph modules
const idx = await import(pathToFileURL(resolve('dist/index.js')).href);
const CodeGraph = idx.default?.default ?? idx.default ?? idx.CodeGraph;

const repoPath = '/Users/bigc/Downloads/jvm-sandbox-master';
const query = 'sandbox active';

console.log(`=== 调试 CodeGraph 智能召回流程 ===`);
console.log(`项目路径: ${repoPath}`);
console.log(`查询词: "${query}"\n`);

// 1. 初始化并建立数据库连接
const cg = CodeGraph.openSync(repoPath);

// 2. 步骤一：使用 ContextBuilder 的混合召回算法定位相关子图
console.log('--- [步骤 1] 运行 ContextBuilder.findRelevantContext() 混合检索与图扩散 ---');
const contextBuilder = cg.contextBuilder;
const subgraph = await contextBuilder.findRelevantContext(query, {
  searchLimit: 3,
  traversalDepth: 1,
  maxNodes: 20,
  minScore: 0.3
});

console.log(`\n混合检索匹配到的种子节点 (Roots/Entry Points): ${subgraph.roots.length} 个`);
subgraph.roots.forEach((id, idx) => {
  const node = subgraph.nodes.get(id);
  if (node) {
    console.log(`  [种子 #${idx + 1}] Kind: ${node.kind.padEnd(10)} | Name: ${node.name}`);
    console.log(`          QualifiedName: ${node.qualifiedName}`);
    console.log(`          FilePath: ${node.filePath}:${node.startLine}`);
  }
});

// 3. 步骤二：审查扩散出的子图关联节点和依赖边
console.log('\n--- [步骤 2] 审查 1-Hop 展开后的图关联节点与依赖边 ---');
console.log(`子图规模: 节点共 ${subgraph.nodes.size} 个，关系边共 ${subgraph.edges.length} 条`);

console.log('\n  关系边 (Edges) 详情:');
subgraph.edges.forEach((edge, idx) => {
  const sourceNode = subgraph.nodes.get(edge.source) || { name: '未知' };
  const targetNode = subgraph.nodes.get(edge.target) || { name: '未知' };
  console.log(`    边 #${idx + 1}: ${sourceNode.name} ➔ [${edge.kind}] ➔ ${targetNode.name} (行 ${edge.line || '无'})`);
});

console.log('\n  关联节点 (Nodes) 详情 (部分):');
Array.from(subgraph.nodes.values()).slice(0, 10).forEach((node, idx) => {
  const isRoot = subgraph.roots.includes(node.id) ? ' [种子]' : '';
  console.log(`    节点 #${idx + 1}:${isRoot} [${node.kind.padEnd(8)}] ${node.qualifiedName} (${node.filePath}:${node.startLine})`);
});
if (subgraph.nodes.size > 10) {
  console.log(`    ... 还有 ${subgraph.nodes.size - 10} 个节点未全部列出`);
}
console.log('');

// 4. 步骤三：源码片段切片与还原 (Source Slicing)
console.log('--- [步骤 3] 从物理文件中截取并召回源码片段 (Source Slicing) ---');
const codeBlocks = await contextBuilder.extractCodeBlocks(subgraph, 3, 1000);

console.log(`成功从物理文件中裁剪出 ${codeBlocks.length} 个代码片段:\n`);
codeBlocks.forEach((block, idx) => {
  console.log(`====== 代码片段 #${idx + 1} (${block.node.name}) ======`);
  console.log(`文件: ${block.filePath}:${block.startLine}-${block.endLine}`);
  console.log(`--------------------------------------------------`);
  console.log(block.content);
  console.log(`==================================================\n`);
});

// 关闭数据库连接
try {
  cg.close?.();
  cg.closeSync?.();
} catch (e) {}
