// 插件入口：只负责加载编译产物。
// TS 源码在 src/，构建输出在 lib/；package.json 的 "type": "module" 让 lib/*.js 本身就是 ESM。
export * from './lib/index.js'
export { default } from './lib/index.js'
