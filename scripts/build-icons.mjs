// Rasterize assets/brand/*.svg with the repo's Electron.
// Run: node_modules/.bin/electron scripts/build-icons.mjs
import { app, BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

app.disableHardwareAcceleration()
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const brand = path.join(root, 'assets/brand')
const build = path.join(root, 'build')
const sizes = [16, 32, 64, 128, 256, 512, 1024]
const variants = ['relay-icon', 'relay-icon-light', 'relay-icon-mono', 'relay-icon-outline', 'relay-mark-small', 'relay-mark', 'relay-logo']
// sizes <= 32 use the simplified mark (thicker strokes, fewer traces)
const srcFor = (s) => path.join(brand, s <= 32 ? 'relay-mark-small.svg' : 'relay-icon.svg')

let win
async function shot(html, w, h) {
  const tmp = path.join(os.tmpdir(), `relay-icons-${process.pid}-${w}x${h}.html`)
  fs.writeFileSync(tmp, html)
  win ??= new BrowserWindow({ show: false, frame: false, transparent: true, useContentSize: true, width: w, height: h })
  win.setContentSize(w, h)
  await win.loadFile(tmp)
  await new Promise((r) => setTimeout(r, 200))
  let img = await win.webContents.capturePage()
  if (img.getSize().width !== w) img = img.resize({ width: w, height: h, quality: 'best' })
  fs.unlinkSync(tmp)
  return img.toPNG()
}

const css = 'html,body{margin:0;background:transparent;overflow:hidden}img{display:block}'
const raster = (svg, s) => shot(`<style>${css}</style><img src="file://${svg}" width="${s}" height="${s}">`, s, s)

app.whenReady().then(async () => {
  const png = {}
  fs.mkdirSync(path.join(build, 'icons'), { recursive: true })
  for (const s of sizes) {
    png[s] = await raster(srcFor(s), s)
    fs.writeFileSync(path.join(build, 'icons', `relay-icon-${s}.png`), png[s])
  }
  // iconset: name -> pixel size
  const set = path.join(build, 'icon.iconset')
  fs.rmSync(set, { recursive: true, force: true })
  fs.mkdirSync(set)
  for (const b of [16, 32, 128, 256, 512]) {
    fs.writeFileSync(path.join(set, `icon_${b}x${b}.png`), png[b])
    fs.writeFileSync(path.join(set, `icon_${b}x${b}@2x.png`), png[b * 2])
  }
  if (process.platform === 'darwin') execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(build, 'icon.icns')])
  fs.writeFileSync(path.join(build, 'icon.png'), png[1024])
  fs.writeFileSync(path.join(brand, 'favicon.png'), png[64])

  // contact sheet: every variant at 512/128/32/16 on dark + light
  const img = (v, s) => v === 'relay-mark'
    ? `<div class="m" style="width:${s}px;height:${s}px">${fs.readFileSync(path.join(brand, v + '.svg'), 'utf8').replace(/ width="1024" height="1024"/, ' width="100%" height="100%"')}</div>`
    : `<img src="file://${path.join(brand, (v === 'relay-icon' && s <= 32 ? 'relay-mark-small' : v) + '.svg')}" width="${s}" height="${s}">`
  const panel = (cls) => `<div class="p ${cls}">${variants.map((v) => `<div class="r">${[512, 128, 32, 16].map((s) => img(v, s)).join('')}<b>${v}</b></div>`).join('')}</div>`
  const w = 2 * (512 + 128 + 32 + 16 + 3 * 40 + 40 + 200)
  const html = `<style>body{margin:0;display:flex}.p{padding:30px 20px;display:flex;flex-direction:column;gap:20px}.d{background:#08090b;color:#fff}.l{background:#f4f4f6;color:#17181d}.r{display:flex;align-items:flex-end;gap:40px}.m svg{display:block}b{font:600 20px sans-serif;opacity:.7;align-self:flex-start}</style>${panel('d')}${panel('l')}`
  const h = 60 + variants.length * 532
  const sheet = await shot(html, w, h)
  fs.writeFileSync(path.join(brand, 'preview.png'), sheet)
  app.quit()
}).catch((e) => { console.error(e); app.exit(1) })
