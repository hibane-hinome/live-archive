// live-archive 的 Vite 配置。
//
// 分工：Python（tools/gen_data.py）负责一切数据与资源产出，Vite 只负责
// dev server 和把 site/ 打成 dist/。构建前自动跑 Python，因此单独执行
// `npx vite build` 也能得到完整产物；CI 没有本地数据库时 Python 会沿用
// 仓库里已入库的 site/data/subs。
//
// 产物形态必须和旧的 tools/build.py 保持一致：assets/app.js、assets/style.css、
// assets/data.js、brand/、audio/、subs/、download/、.nojekyll，
// 版本号统一挂在 data / app / style 三个 URL 上。
import { defineConfig } from 'vite'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.dirname(fileURLToPath(import.meta.url))
const siteDir = path.join(repoRoot, 'site')
const buildDir = path.join(repoRoot, '.build')
const outDir = path.join(repoRoot, 'dist')
const manifestPath = path.join(buildDir, 'manifest.json')

let pythonCmd = null

/** 找 Python：环境变量 → Windows 安装路径 → py / python3 / python。 */
function resolvePython() {
  if (pythonCmd) return pythonCmd
  const candidates = []
  if (process.env.PYTHON) candidates.push(process.env.PYTHON)
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python312', 'python.exe'))
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python313', 'python.exe'))
  }
  candidates.push('py', 'python3', 'python')

  for (const cmd of candidates) {
    try {
      execFileSync(cmd, ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'], {
        stdio: 'ignore',
      })
      pythonCmd = cmd
      return cmd
    } catch {
      // 换下一个候选
    }
  }
  throw new Error('[live-archive] 找不到 Python 3.11+，tools/gen_data.py 无法执行')
}

/** 跑 Python 数据产出，返回 manifest（版本号 + 页面信息）。 */
function generate() {
  const args = [path.join(repoRoot, 'tools', 'gen_data.py'), '--out', buildDir]
  if (process.env.LIVE_ARCHIVE_CONFIG) args.push('--config', process.env.LIVE_ARCHIVE_CONFIG)
  try {
    execFileSync(resolvePython(), args, { cwd: repoRoot, stdio: 'inherit' })
  } catch (err) {
    throw new Error('[live-archive] 数据产出失败，见上面的 Python 输出')
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
}

function archivePlugin() {
  let manifest = { version: '', profile: {} }
  let isBuild = false

  return {
    name: 'live-archive',

    // 在 Vite 初始化 publicDir 之前把 .build/ 准备好，dev 与 build 共用同一份数据
    config() {
      manifest = generate()
    },

    configResolved(config) {
      isBuild = config.command === 'build'
    },

    // dev 下改 site/data 里的 JSON 时重新产数据并整页刷新（不动 subs，避免自触发）
    configureServer(server) {
      const dataDir = path.join(siteDir, 'data')
      server.watcher.add(dataDir)
      let timer = null
      let busy = false
      const onChange = (file) => {
        const rel = path.relative(dataDir, file).replace(/\\/g, '/')
        if (!rel || rel.startsWith('subs/') || !rel.endsWith('.json')) return
        if (busy) return
        clearTimeout(timer)
        timer = setTimeout(() => {
          busy = true
          try {
            manifest = generate()
            server.ws.send({ type: 'full-reload' })
            server.config.logger.info('[live-archive] 数据已更新，页面已重新加载', { timestamp: true })
          } catch (err) {
            server.config.logger.error(String(err && err.message ? err.message : err))
          } finally {
            setTimeout(() => { busy = false }, 600)
          }
        }, 400)
      }
      server.watcher.on('change', onChange)
      server.watcher.on('add', onChange)
      server.watcher.on('unlink', onChange)
    },

    transformIndexHtml: {
      order: 'post',
      handler(html) {
        html = html
          .replace(/\{\{TITLE\}\}/g, manifest.profile.title || '')
          .replace(/\{\{DESC\}\}/g, manifest.profile.desc || '')
          .replace(/\{\{STREAMER\}\}/g, manifest.profile.streamer || '')
        return html
      },
    },

    closeBundle() {
      if (!isBuild) return
      // HTML 里的资源 URL 是 Vite 在 generateBundle 阶段才写的，必须等产物落盘后再收尾
      const indexPath = path.join(outDir, 'index.html')
      let html = fs.readFileSync(indexPath, 'utf8')
      // 版本号统一挂在 data / app / style 三个 URL 上；内容不变就不换版本
      html = html.replace(/((?:src|href)="[^"]*assets\/(?:app\.js|style\.css|data\.js))(?=")/g,
        `$1?v=${manifest.version}`)
      // Vite 在 base './' 下写成 ./assets/…，线上一直是不带 ./ 的相对路径
      html = html.replace(/((?:src|href)=")\.\//g, '$1')
      // 同源部署用不到 crossorigin，去掉以保持与旧产物一致
      html = html.replace(/ crossorigin/g, '')
      fs.writeFileSync(indexPath, html)
      // GitHub Pages 不需要 Jekyll；旧 build.py 也一直写这个空文件
      fs.writeFileSync(path.join(outDir, '.nojekyll'), '')
    },
  }
}

export default defineConfig({
  root: siteDir,
  // 站点挂在 /live-archive/ 子路径下，相对 base 让产物在任意挂载点都能跑
  base: './',
  publicDir: path.join(buildDir, 'public'),
  server: { port: 8799, strictPort: true },
  build: {
    outDir,
    emptyOutDir: true,
    // 不做内联：图片在小体积时也会被 Vite 塞成 data URI，产物形态就和旧版不一样了
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        // 不按内容改名：版本号由上面统一注入，产物路径与旧 build.py 保持一致
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames(info) {
          const name = (info.names && info.names[0]) || info.name || ''
          if (name.endsWith('.css')) return 'assets/style.css'
          if (/\.(webp|png|jpe?g|gif|svg|ico)$/i.test(name)) return 'brand/[name][extname]'
          return 'assets/[name][extname]'
        },
      },
    },
  },
  plugins: [archivePlugin()],
})
