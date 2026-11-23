// 构建：先清空 lib/，再用项目内的 TypeScript 把 src/ 编译进去。
// 产物是标准 ESM（package.json 是 "type": "module"），所以 lib/ 下保持 .js 即可；
// 根目录 index.mjs 只负责加载 lib/index.js，不再改后缀、不再改写 import。

import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

rmSync(join(ROOT, 'lib'), { recursive: true, force: true })
execFileSync(process.execPath, [TSC, '-p', join(ROOT, 'tsconfig.json')], { stdio: 'inherit' })

console.log('[build] src/ → lib/ 完成')
