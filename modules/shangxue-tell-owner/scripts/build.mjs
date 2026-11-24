// package.json 是模块配置的唯一来源；每次构建生成 module.json，并删掉 PR.md。

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT = join(ROOT, 'lib')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const manifest = {
  id: pkg.name,
  name: pkg.displayName || pkg.name,
  version: pkg.version,
  description: pkg.description,
  category: pkg.category,
  tags: pkg.tags || [],
  platforms: pkg.platforms || ['qq'],
  author: pkg.author,
  license: pkg.license,
  api: pkg.api,
  minPluginVersion: pkg.minPluginVersion,
  requires: pkg.requires || [],
  capabilities: pkg.capabilities || [],
  ...(pkg.panel ? { panel: pkg.panel } : {}),
  ...(pkg.build ? { build: pkg.build } : {}),
}

for (const key of ['category', 'author', 'api', 'minPluginVersion']) {
  if (manifest[key] === undefined || manifest[key] === '') throw new Error(`package.json 缺 ${key}`)
}
writeFileSync(join(ROOT, 'module.json'), JSON.stringify(manifest, null, 2) + '\n')
rmSync(join(ROOT, 'PR.md'), { force: true })

rmSync(OUT, { recursive: true, force: true })
execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(ROOT, 'tsconfig.json')], { stdio: 'inherit' })

if (existsSync(join(ROOT, 'panel.js'))) copyFileSync(join(ROOT, 'panel.js'), join(OUT, 'panel.js'))
writeFileSync(join(OUT, 'index.mjs'), "export * from './index.js'\nexport { default } from './index.js'\n")
writeFileSync(join(OUT, 'package.json'), JSON.stringify({ type: 'module', private: true }, null, 2) + '\n')

console.log('[build] module.json 已从 package.json 同步；src/ → lib/ 完成')
