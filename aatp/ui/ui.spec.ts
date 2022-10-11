import { test, expect, Page, BrowserContext } from '@playwright/test'
import { Client } from 'ssh2'
import * as fs from 'fs'
import waitPort from 'wait-port'


const local = process.env.LOCALDEV !== undefined,
      url = local?"http://localhost:3000":"http://terminal7"

test.describe('terminal 7session', ()  => {

    const sleep = (ms) => { return new Promise(r => setTimeout(r, ms)) }
    const connectGate = async () => {
        const btns = page.locator('#gates button')
        await page.screenshot({ path: `/result/0.png` })
        await expect(btns).toHaveCount(2)
        await btns.first().dispatchEvent('pointerdown')
        await sleep(50)
        await btns.first().dispatchEvent('pointerup')
    }

    let page: Page,
        context: BrowserContext

    async function getTWRBuffer() {
        return await page.evaluate(() => {
            const t = window.terminal7.map.t0
            const b = t.buffer.active
            let ret = ""
            for (let i = 0; i < b.length; i++) {
                const line = b.getLine(i).translateToString()
                ret += line
            }
            return ret
        })
    }
    test.beforeAll(async ({ browser }) => {
        context = await browser.newContext()
        page = await context.newPage()
        page.on('console', (msg) => console.log('console log:', msg.text()))
        page.on('pageerror', (err: Error) => console.log('PAGEERROR', err.message))
        await waitPort({host:'terminal7', port:80})
        const response = await page.goto(url)
        await expect(response.ok(), `got error ${response.status()}`).toBeTruthy()
        await page.evaluate(async () => {
            window.terminal7.notify = (msg: string) => console.log("NOTIFY: "+msg)
            localStorage.setItem("CapacitorStorage.dotfile","")
            localStorage.setItem("CapacitorStorage.gates", JSON.stringify(
                [{"id":0,
                  "addr":"webexec",
                  "name":"foo",
                  "windows":[],
                  "store":true,
                  "tryWebexec": true,
                }]
            ))
        })
        // first page session for just for storing the dotfiles
        await page.reload({waitUntil: "networkidle"})
        const fp = await page.evaluate(async () => {
            window.terminal7.notify = (msg: string) => console.log("NOTIFY: "+msg)
            return await window.terminal7.getFingerprint()
        })
        fs.writeFileSync('/webexec_config/authorized_fingerprints', fp + '\n')
        // add terminal7 initializtion and globblas
        await waitPort({host:'webexec', port:7777})

    })

    test('connect to gate see help page and hide it', async () => {
        connectGate()
        const help  = page.locator('#help-gate')
        await expect(help).toBeVisible()
        await help.click()
        await expect(help).toBeHidden()
    })
    test('pane is visible and session is open', async () => {
        await expect(page.locator('.pane')).toHaveCount(1)
        await sleep(500)
        const paneState = await page.evaluate(() => {
            const pane = window.terminal7.activeG.activeW.activeP
            return pane.d.readyState
        })
        expect(paneState).toEqual("open")
    })
    test('a pane can be reseted', async () => {
        await page.reload({waitUntil: "networkidle"})
        await page.evaluate(async () => {
            window.notifications = []
            window.terminal7.notify = (m) => window.notifications.push(m)
        })
        connectGate()
        await sleep(500)
        await page.screenshot({ path: `/result/2.png` })
        await page.locator('.tabbar .reset').click()
        await sleep(100)
        await page.keyboard.press('Enter')
        await expect(page.locator('#t0')).toBeHidden()
        await sleep(100)
        await expect(page.locator('.pane')).toHaveCount(1)
        await expect(page.locator('.windows-container')).toBeVisible()

        expect(await getTWRBuffer()).toMatch(/foo.*: Connected\s+$/)
    })
    test('how a gate handles disconnect', async() => {
        let sshC, stream
        try {
            sshC = await new Promise((resolve, reject) => {
                const conn = new Client()
                conn.on('error', e => reject(e))
                conn.on('ready', () => resolve(conn))
                conn.connect({
                  host: 'webexec',
                  port: 22,
                  username: 'runner',
                  password: 'webexec'
                })
            })
        } catch(e) { expect(e).toBeNull() }
        // log key SSH events
        sshC.on('error', e => console.log("ssh error", e))
        sshC.on('close', e => {
            console.log("ssh closed", e)
        })
        sshC.on('end', e => console.log("ssh ended", e))
        sshC.on('keyboard-interactive', e => console.log("ssh interaction", e))
        // shorten the net timeout for a shorter run time
        await page.evaluate(async () => window.terminal7.conf.net.timeout = 1000)
        try {
            stream = await new Promise((resolve, reject) => {
                sshC.exec("webexec stop", { }, async (err, s) => {
                    if (err)
                        reject(err)
                    else 
                        resolve(s)
                })
            })
        } catch(e) { expect(e).toBeNull() }
        try {
            await new Promise<void>((resolve, reject) => {
                stream.on('close', (code, signal) => {
                    console.log(`closed with ${signal}`)
                    sshC.end()
                    reject()
                }).on('data', async (data) => {
                    const b = new Buffer.from(data)
                    const s = b.toString()
                    expect(s).toMatch("SIGINT")
                    resolve()
                })
            })
        } catch(e) { expect(e).toBeNull() }
        // TODO: sleep and verify TWR came up while the windows-container
        // remained visible
        await page.screenshot({ path: `/result/3.png` })
        await sleep(12000)
        await expect(page.locator('#t0')).toBeVisible()
        const twr = await getTWRBuffer()
        expect(twr).toMatch(/Reconnect\s+Close\s*$/)
        await page.screenshot({ path: `/result/5.png` })
    })
})
