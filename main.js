import fs from 'fs';
import fsp from 'fs/promises';
import { consola } from 'consola';
import { Mutex } from 'async-mutex';
import { request, ProxyAgent } from 'undici';

// Fix for "Named export 'prompt' not found. The requested module 'enquirer' is a CommonJS module"
// https://github.com/enquirer/enquirer/issues/439
import Enquirer from 'enquirer';
const enquirer = new Enquirer();

console.clear()
process.title = 'Discord Promo Checker - @Socket'

class Utility {
    static readFileAsArray(dir) {
        const maxLines = 16777216;
        const dataSet = new Set();

        if(!fs.existsSync(dir)) return []
        
        const stream = fs.createReadStream(dir, { encoding: 'utf-8' });

        return new Promise(async (resolve) => {
            stream.on('data', (chunk) => {
                const lines = chunk.split('\n').filter((a) => a.trim() != '' && a.trim() != '\n').map((a) => a.trim());
                for(const line of lines) {
                    if(dataSet.size >= maxLines) {
                        stream.destroy()
                        break
                    }

                    try{
                        dataSet.add(line)
                    }catch{}
                }
            })

            stream.on('end', () => {
                resolve(
                    Array.from(dataSet)
                )
            })
        })
    }

    static createProxyAgent(proxyUrl) {
        if(!proxyUrl.startsWith('http'))
            proxyUrl = `http://${proxyUrl}`

        const parsed = new URL(proxyUrl)

        let opts = { uri: proxyUrl }

        if(parsed.username && parsed.password)
            opts.auth = Buffer.from(`${parsed.username}:${parsed.password}`).toString('base64')
        
        return new ProxyAgent(opts)
    }
}

class InputManager {
    constructor(array, opts = {}) {
        this.array = array
        
        if(opts.formatSlug)
            this.array = this.array.map((x) => x.includes('/') ? x.split('/')[x.match(/\//g).length] : x)
        
        if(opts.cleanStrings)
            this.array = this.array.map((x) => x.replace(/[^a-zA-Z0-9]/g, '').trim())

        this.opts = opts

        this.index = 0
    }

    get() {
        if (!this.opts.loop && this.index >= this.array.length) {
            return null;
        }
        return this.array[
            this.opts.loop ? this.index++ % this.array.length : this.index++
        ];
    }
}

class OutputManager {
    constructor(dir, opts = {}) {
        this.dir = dir
        this.opts = opts

        fs.writeFileSync(this.dir, '')

        this.mutex = new Mutex()
    }

    write = (line) => new Promise(async(resolve) => {
        const release = await this.mutex.acquire();

        if(this.prefix)
            line = this.prefix + line

        try{
            await fsp.appendFile(this.dir, line + '\n')
        }finally{
            release()
        }

        resolve()
    })
}

const proxies = await Utility.readFileAsArray('proxies.txt');
consola.info(`Loaded ${proxies.length} proxies`)

const promos = await Utility.readFileAsArray('promos.txt');
consola.info(`Loaded ${promos.length} promos`)

const ProxyInputManager = new InputManager(proxies, { loop: true })
const PromoInputManager = new InputManager(promos, { formatSlug: true, cleanStrings: true })

const threeMonthPromoManager = new OutputManager('./output/3month.txt', { prefix: 'https://promos.discord.gg/' })
const OneMonthPromoManager = new OutputManager('./output/1month.txt', { prefix: 'https://promos.discord.gg/' })
const InvalidPromoManager = new OutputManager('./output/invalid.txt', { prefix: 'https://promos.discord.gg/' })
const UsedPromoManager = new OutputManager('./output/used.txt', { prefix: 'https://promos.discord.gg/' })

const getPromoResponse = (proxy, code) => new Promise(async(resolve) => {
    const retries = 3
    const requestTimeout = 5000
    const failTimeout = 2000

    const agent = Utility.createProxyAgent(proxy)

    let fails = []

    for(let i = 0; i < retries; i++) {
        try{
            const req = await request(`https://discord.com/api/v9/entitlements/gift-codes/${code}`, {
                headersTimeout: requestTimeout,
                bodyTimeout: requestTimeout,
                dispatcher: agent
            })
            
            try{
                var body = await req.body.json()
            }catch{
                throw new Error('Failed to parse response. Most likely proxy error or cloudflare rate limit.')
            }

            return resolve(body)
        }catch(e) {
            fails.push(e)
            await new Promise((resolve) => setTimeout(resolve, failTimeout))
        }
    }

    resolve({ e: `All of total ${retries} have failed: ${fails.join(', ')}` })
})

const counters = {
    total: 0,
    month3: 0,
    month1: 0,
    invalid: 0,
    used: 0
}

const Thread = async(id) => {
    while(true) {
        const proxy = ProxyInputManager.get()
        const promo = PromoInputManager.get()
        if(!promo) {
            consola.info(`Thread ${id} has ran out of promos`)
            break
        }

        const result = await getPromoResponse(proxy, promo)
        let done = false

        switch(result?.message) {
            case 'Unknown Gift Code':
                counters.invalid += 1
                consola.fail(`[${id}] Invalid promo code: https://promos.discord.gg/${promo} - ${counters.total + 1}/${PromoInputManager.array.length}`)
                await InvalidPromoManager.write(promo)
                done = true
                break
            case 'The resource is being rate limited.':
                PromoInputManager.array.push(promo)
                done = true
                break
        }

        if(result?.uses != result?.max_uses) {
            const promoType = result?.promotion?.inbound_header_text?.includes('3 months') ? 3 : 1
            const logType = promoType == 3 ? threeMonthPromoManager : OneMonthPromoManager
            counters[`month${promoType}`] += 1
            consola.success(`[${id}] ${promoType} Month promo code: https://promos.discord.gg/${promo} - ${counters.total + 1}/${PromoInputManager.array.length}`)
            await logType.write(promo)
            done = true

        }

        if(result?.uses && result?.uses == result?.max_uses) {
            counters.used += 1
            consola.fail(`[${id}] Used promo: https://promos.discord.gg/${promo} - ${counters.total + 1}/${PromoInputManager.array.length}`)
            await UsedPromoManager.write(promo)
            done = true
        }

        // If the response is unknown, log it. Ugly but works
        if(!done) {
            consola.error(`[${id}] Unknown response: https://promos.discord.gg/${promo} - ${counters.total + 1}/${PromoInputManager.array.length}`)
        }

        counters.total += 1
    }
}

let threadsAmount = (await enquirer.prompt({
    type: 'input',
    name: 'threads',
    message: 'How many threads do you want to run?',
    initial: 1
})).threads

if(threadsAmount > promos.length) {
    threadsAmount = promos.length
    consola.warn(`Threads amount is higher than promos amount. Setting threads amount to ${threadsAmount}`)
}

for(let i = 0; i < parseInt(threadsAmount); i++) {
    Thread(i + 1)
}