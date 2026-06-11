import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const STORAGE_DIR = path.join(__dirname, 'storage');

if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

function serveStatic(req, res) {
    const urlPath = req.url.split('?')[0];
    let filePath = path.join(__dirname, urlPath === '/' ? 'index.html' : urlPath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.wasm': 'application/wasm',
        '.css': 'text/css',
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        }
    });
}

function loadAccounts() {
    if (!fs.existsSync(ACCOUNTS_FILE)) {
        return [];
    }
    return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
}

function saveAccounts(accounts) {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

function getStoragePath(clientId) {
    return path.join(STORAGE_DIR, `${clientId}.json`);
}

export class LoadTestHarness {
    constructor(preferredPort = 8765) {
        this.clients = new Map();
        this.server = null;
        this.browser = null;
        this.accounts = loadAccounts();
        this.preferredPort = preferredPort;
        this.port = null;
    }

    async start() {
        this.server = http.createServer(serveStatic);

        const tryListen = (port) => new Promise((resolve, reject) => {
            this.server.once('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    resolve(false);
                } else {
                    reject(err);
                }
            });
            this.server.listen(port, () => {
                this.port = this.server.address().port;
                resolve(true);
            });
        });

        let bound = await tryListen(this.preferredPort);
        if (!bound) {
            console.log(`Port ${this.preferredPort} in use, trying random port...`);
            bound = await tryListen(0);
            if (!bound) {
                throw new Error('Failed to bind to any port');
            }
        }

        console.log(`Static server running on http://localhost:${this.port}`);

        this.browser = await chromium.launch({ headless: true });
        console.log('Browser launched');
    }

    async stop() {
        for (const client of this.clients.values()) {
            await client.context.close();
        }
        if (this.browser) {
            await this.browser.close();
        }
        if (this.server) {
            if (this.server.closeAllConnections) {
                this.server.closeAllConnections();
            }
            await new Promise((resolve) => this.server.close(resolve));
        }
        console.log('Harness stopped');
    }

    async initClient(clientId, storageState = null) {
        const contextOptions = {};
        if (storageState) {
            contextOptions.storageState = storageState;
        }

        const context = await this.browser.newContext(contextOptions);
        const page = await context.newPage();

        const cssPattern = /^(color|background|padding|margin|border|font|width|height|display|position|text|line)[^:]*:/i;
        async function cleanConsoleArgs(msg) {
            try {
                const args = await Promise.all(msg.args().map(arg => arg.jsonValue()));
                return args
                    .filter(arg => typeof arg !== 'string' || !cssPattern.test(arg))
                    .join(' ')
                    .replace(/%c/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();
            } catch {
                return msg.text();
            }
        }

        page.on('console', async msg => {
            const text = await cleanConsoleArgs(msg);
            if (msg.type() === 'error') {
                console.log(`[${clientId}] ERROR: ${text}`);
            } else if (msg.type() === 'warn') {
                console.log(`[${clientId}] WARN: ${text}`);
            }
        });

        await page.goto(`http://localhost:${this.port}/index.html?id=${clientId}`);

        await page.waitForFunction(() => {
            return window.bcrClient && (window.bcrClient.status === 'ready' || window.bcrClient.status === 'error');
        }, { timeout: 60000 });

        const status = await page.evaluate(() => window.bcrClient.status);
        if (status !== 'ready') {
            const error = await page.evaluate(() => window.bcrClient.error);
            throw new Error(`Client ${clientId} failed to initialize: ${error}`);
        }

        console.log(`Client ${clientId} ready`);
        const client = { context, page, clientId, identity: null };
        this.clients.set(clientId, client);
        return client;
    }

    async bootstrapClient(clientId, mode = 'fresh') {
        const existingAccount = this.accounts.find(a => a.client_id === clientId);

        if (mode === 'restore' || mode === 'recover') {
            if (existingAccount?.seed_phrase) {
                console.log(`[${clientId}] Recovering from seed phrase...`);
                const client = await this.initClient(clientId);
                await this.recoverIdentity(client, existingAccount.seed_phrase);
                client.identity = {
                    node_id: existingAccount.node_id,
                    name: existingAccount.name,
                };
                await this.saveState(clientId);
                return client;
            }
            console.log(`[${clientId}] No seed phrase found, falling back to fresh`);
        }

        console.log(`[${clientId}] Creating fresh identity...`);
        const client = await this.initClient(clientId);
        const identity = await this.createIdentity(client, clientId, `${clientId}@test.com`);
        client.identity = identity;

        const newAccount = {
            client_id: clientId,
            name: clientId,
            email: `${clientId}@test.com`,
            node_id: identity.node_id,
            seed_phrase: identity.seed_phrase,
        };

        const idx = this.accounts.findIndex(a => a.client_id === clientId);
        if (idx >= 0) {
            this.accounts[idx] = newAccount;
        } else {
            this.accounts.push(newAccount);
        }
        saveAccounts(this.accounts);
        await this.saveState(clientId);

        return client;
    }

    async createIdentity(client, name, email) {
        const { page, clientId } = client;
        const result = await page.evaluate(async ({ name, email }) => {
            const unwrap = (res) => {
                if (res.Error) throw new Error(res.Error.message);
                return res.Success;
            };
            try {
                const api = window.bcrClient.api;
                unwrap(await api.identity().create({
                    t: 0,
                    name: name,
                    email: email,
                    postal_address: {
                        country: "AT",
                        city: "Vienna",
                        zip: "1020",
                        address: "street 1",
                    },
                    date_of_birth: null,
                    country_of_birth: null,
                    city_of_birth: null,
                    identification_number: null,
                    profile_picture_file_upload_id: null,
                    identity_document_file_upload_id: null,
                }));
                const identity = unwrap(await api.identity().detail());
                const seed = unwrap(await api.identity().seed_backup());
                return { success: true, identity, seed };
            } catch (e) {
                return { success: false, error: e.message || String(e) };
            }
        }, { name, email });

        if (!result.success) {
            throw new Error(`[${clientId}] Failed to create identity: ${result.error}`);
        }
        console.log(`[${clientId}] Identity: ${result.identity.node_id}`);
        return { ...result.identity, seed_phrase: result.seed.seed_phrase };
    }

    async recoverIdentity(client, seedPhrase) {
        const { page, clientId } = client;
        const result = await page.evaluate(async (seedPhrase) => {
            const unwrap = (res) => {
                if (res.Error) throw new Error(res.Error.message);
                return res.Success;
            };
            try {
                const api = window.bcrClient.api;
                unwrap(await api.identity().seed_recover({ seed_phrase: seedPhrase }));
                const identity = unwrap(await api.identity().detail());
                return { success: true, identity };
            } catch (e) {
                return { success: false, error: e.message || String(e) };
            }
        }, seedPhrase);

        if (!result.success) {
            console.log(`[${clientId}] Seed recover returned error (identity may need sync): ${result.error}`);
            return { node_id: 'unknown', name: clientId };
        }
        console.log(`[${clientId}] Recovered identity: ${result.identity.node_id}`);
        return result.identity;
    }

    async addContact(client, contactNodeId, contactName) {
        const { page, clientId } = client;
        console.log(`[${clientId}] Adding contact ${contactName}...`);
        const result = await page.evaluate(async ({ nodeId, name }) => {
            const unwrap = (res) => {
                if (res.Error) throw new Error(res.Error.message);
                return res.Success;
            };
            try {
                const api = window.bcrClient.api;
                unwrap(await api.contact().create({
                    node_id: nodeId,
                    t: 0,
                    name: name,
                    email: "test@example.com",
                    postal_address: {
                        country: "AT",
                        city: "Vienna",
                        zip: null,
                        address: "Test street 1",
                    },
                    date_of_birth_or_registration: null,
                    country_of_birth_or_registration: null,
                    city_of_birth_or_registration: null,
                    identification_number: null,
                    avatar_file_upload_id: null,
                    proof_document_file_upload_id: null,
                }));
                return { success: true };
            } catch (e) {
                return { success: false, error: e.message || String(e) };
            }
        }, { nodeId: contactNodeId, name: contactName });

        if (!result.success) {
            console.log(`[${clientId}] Failed to add contact: ${result.error}`);
        } else {
            console.log(`[${clientId}] Contact added`);
        }
    }

    async listContacts(client) {
        const { page, clientId } = client;
        const result = await page.evaluate(async () => {
            const unwrap = (res) => {
                if (res.Error) throw new Error(res.Error.message);
                return res.Success;
            };
            try {
                const api = window.bcrClient.api;
                const response = unwrap(await api.contact().list());
                return { success: true, contacts: response.contacts };
            } catch (e) {
                return { success: false, error: e.message || String(e) };
            }
        });

        if (result.success) {
            console.log(`[${clientId}] Contacts:`, result.contacts.map(c => `${c.name} (${c.node_id})`).join(', ') || 'none');
            return result.contacts;
        } else {
            console.log(`[${clientId}] Failed to list contacts: ${result.error}`);
            return [];
        }
    }

    async saveState(clientId) {
        const client = this.clients.get(clientId);
        if (!client) return;
        const storagePath = getStoragePath(clientId);
        await client.context.storageState({ path: storagePath });
        console.log(`[${clientId}] Storage state saved to ${storagePath}`);
    }

    getClient(clientId) {
        return this.clients.get(clientId);
    }

    async issueBill(client, draweeNodeId, payeeNodeId, sum = "1000") {
        const { page, clientId } = client;
        const result = await page.evaluate(async ({ drawee, payee, sum }) => {
            try {
                const api = window.bcrClient.api;
                const response = await api.bill().issue({
                    t: 0,
                    country_of_issuing: "AT",
                    city_of_issuing: "Vienna",
                    issue_date: "2026-01-01",
                    maturity_date: "2026-12-31",
                    payee: payee,
                    drawee: drawee,
                    sum: sum,
                    currency: "sat",
                    country_of_payment: "AT",
                    city_of_payment: "Vienna",
                    file_upload_ids: [],
                });
                if (response.Error) {
                    return { success: false, error: response.Error.message };
                }
                return { success: true, billId: response.Success.id };
            } catch (e) {
                return { success: false, error: e.message || String(e) };
            }
        }, { drawee: draweeNodeId, payee: payeeNodeId, sum });

        if (!result.success) {
            console.log(`[${clientId}] Failed to issue bill: ${result.error}`);
            return null;
        }
        console.log(`[${clientId}] Issued bill: ${result.billId}`);
        return result.billId;
    }

    async createCompany(client, companyId, name) {
        const { page, clientId } = client;
        const result = await page.evaluate(async ({ id, name }) => {
            const unwrap = (res) => {
                if (res.Error) throw new Error(res.Error.message);
                return res.Success;
            };
            try {
                const api = window.bcrClient.api;
                unwrap(await api.company().create({
                    id: id,
                    name: name,
                    country_of_registration: "AT",
                    city_of_registration: "Vienna",
                    postal_address: {
                        country: "AT",
                        city: "Vienna",
                        zip: "1020",
                        address: "Company street 1",
                    },
                    email: "company@test.com",
                    registration_number: null,
                    registration_date: null,
                    proof_of_registration_file_upload_id: null,
                    logo_file_upload_id: null,
                    creator_email: "company@test.com",
                }));
                return { success: true };
            } catch (e) {
                return { success: false, error: e.message || String(e) };
            }
        }, { id: companyId, name });

        if (!result.success) {
            console.log(`[${clientId}] Failed to create company: ${result.error}`);
            return false;
        }
        console.log(`[${clientId}] Created company: ${name}`);
        return true;
    }

    async getBills(client) {
        const { page, clientId } = client;
        const result = await page.evaluate(async () => {
            const unwrap = (res) => {
                if (res.Error) throw new Error(res.Error.message);
                return res.Success;
            };
            try {
                const api = window.bcrClient.api;
                const response = unwrap(await api.bill().list());
                return { success: true, bills: response.bills };
            } catch (e) {
                return { success: false, error: e.message || String(e) };
            }
        });

        if (result.success) {
            console.log(`[${clientId}] Bills: ${result.bills.length}`);
            return result.bills;
        } else {
            console.log(`[${clientId}] Failed to list bills: ${result.error}`);
            return [];
        }
    }

    async getCompanies(client) {
        const { page, clientId } = client;
        const result = await page.evaluate(async () => {
            const unwrap = (res) => {
                if (res.Error) throw new Error(res.Error.message);
                return res.Success;
            };
            try {
                const api = window.bcrClient.api;
                const response = unwrap(await api.company().list());
                return { success: true, companies: response.companies };
            } catch (e) {
                return { success: false, error: e.message || String(e) };
            }
        });

        if (result.success) {
            console.log(`[${clientId}] Companies: ${result.companies.length}`);
            return result.companies;
        } else {
            console.log(`[${clientId}] Failed to list companies: ${result.error}`);
            return [];
        }
    }

    async waitForSync(client, timeoutMs = 30000) {
        const { page, clientId } = client;
        console.log(`[${clientId}] Waiting for sync...`);
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const result = await page.evaluate(async () => {
                const unwrap = (res) => {
                    if (res.Error) throw new Error(res.Error.message);
                    return res.Success;
                };
                try {
                    const api = window.bcrClient.api;
                    const identity = unwrap(await api.identity().detail());
                    return { success: true, synced: identity.node_id !== null };
                } catch (e) {
                    return { success: false, error: e.message || String(e) };
                }
            });

            if (result.success && result.synced) {
                console.log(`[${clientId}] Sync complete`);
                return true;
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        console.log(`[${clientId}] Sync timeout`);
        return false;
    }
}

function parseArgs() {
    const args = process.argv.slice(2);
    const mode = args.find(a => ['--fresh', '--recover', '--restore'].includes(a)) || '--fresh';
    const clientIds = args.filter(a => !a.startsWith('--'));
    return { mode: mode.replace('--', ''), clientIds: clientIds.length > 0 ? clientIds : ['alice', 'bob'] };
}

async function main() {
    const { mode, clientIds } = parseArgs();
    console.log(`Mode: ${mode}, Clients: ${clientIds.join(', ')}`);

    const harness = new LoadTestHarness();

    const cleanup = async () => {
        console.log('\nInterrupted, cleaning up...');
        await harness.stop();
        process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    try {
        await harness.start();

        for (const clientId of clientIds) {
            await harness.bootstrapClient(clientId, mode);
        }

        if (clientIds.length >= 2) {
            const alice = harness.getClient(clientIds[0]);
            const bob = harness.getClient(clientIds[1]);
            await harness.addContact(alice, bob.identity.node_id, bob.identity.name || 'Bob');
            await harness.addContact(bob, alice.identity.node_id, alice.identity.name || 'Alice');
        }

        for (const clientId of clientIds) {
            await harness.listContacts(harness.getClient(clientId));
        }

        console.log('Setup complete. Accounts are ready to interact.');
        for (const clientId of clientIds) {
            const client = harness.getClient(clientId);
            console.log(`${clientId}: ${client.identity.node_id}`);
        }

        for (const clientId of clientIds) {
            await harness.saveState(clientId);
        }

    } catch (err) {
        console.error('Fatal error:', err);
        process.exitCode = 1;
    } finally {
        process.off('SIGINT', cleanup);
        process.off('SIGTERM', cleanup);
        await harness.stop();
    }
}

main();
