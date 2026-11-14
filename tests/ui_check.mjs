/**
 * Headless UI check for the Board lab panel.
 *
 * Requires Playwright with Chromium (not part of the workspace toolchain):
 *   mkdir -p .uitest && cd .uitest && npm init -y && npm i playwright
 *   npx playwright install chromium
 *
 * Run against a harness instance that has the plugin enabled:
 *   node tests/ui_check.mjs "http://127.0.0.1:3080/?token=<token>"
 *
 * It opens the panel, triggers the UART failure path and a build, prints the
 * log, and writes final-panel.png next to the working directory.
 */
import { chromium } from 'playwright'
const url = process.argv[2]
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
await page.goto(url, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(2500)
await page.keyboard.press('Escape'); await page.waitForTimeout(300)
for (const name of ['Закрыть', 'Начать', 'Позже']) {
  const b = page.getByRole('button', { name, exact: true })
  if (await b.count()) await b.first().click({ force: true }).catch(() => {})
}
await page.keyboard.press('Escape'); await page.waitForTimeout(500)
await page.getByRole('button', { name: 'Лаборатория плат' }).click({ force: true })
await page.waitForTimeout(1200)

// UART with no port must surface a clear error in the log.
await page.getByRole('button', { name: 'Читать UART', exact: true }).click({ force: true })
await page.waitForTimeout(2500)
console.log('after uart:', (await page.locator('pre').innerText()).slice(-220))

// Build through the UI.
await page.getByRole('button', { name: 'Собрать', exact: true }).click({ force: true })
await page.waitForTimeout(9000)
console.log('after build:', (await page.locator('pre').innerText()).slice(0, 260))
await page.screenshot({ path: 'final-panel.png' })
console.log('errors:', errors.slice(0, 5).join('\n') || 'none')
await browser.close()
