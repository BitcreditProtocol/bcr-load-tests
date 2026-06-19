import { LoadTestHarness } from './orchestrator.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HEAVY_ACCOUNT_FILE = path.join(__dirname, 'heavy-account.json');
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

function parseArgs() {
    const args = process.argv.slice(2);
    const billsArg = args.find(a => a.startsWith('--bills='));
    const companiesArg = args.find(a => a.startsWith('--companies='));
    const delayArg = args.find(a => a.startsWith('--delay='));
    const clientsArg = args.find(a => a.startsWith('--clients='));
    const bobOnlyArg = args.find(a => a.startsWith('--bob-only='));
    return {
        billsPerPair: billsArg ? parseInt(billsArg.split('=')[1], 10) : 1,
        numCompanies: companiesArg ? parseInt(companiesArg.split('=')[1], 10) : 1,
        delayMs: delayArg ? parseInt(delayArg.split('=')[1], 10) : 10000,
        numClients: clientsArg ? parseInt(clientsArg.split('=')[1], 10) : 4,
        bobOnly: bobOnlyArg ? bobOnlyArg.split('=')[1] === 'true' : true,
    };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function generateNodeId() {
    const hex = crypto.randomBytes(32).toString('hex');
    return `bitcrt02${hex}`;
}

function saveAccountEntry(clientId, nodeId, seedPhrase) {
    let accounts = [];
    if (fs.existsSync(ACCOUNTS_FILE)) {
        accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    }
    const idx = accounts.findIndex(a => a.client_id === clientId);
    const entry = {
        client_id: clientId,
        name: clientId,
        node_id: nodeId,
        seed_phrase: seedPhrase,
    };
    if (idx >= 0) {
        accounts[idx] = entry;
    } else {
        accounts.push(entry);
    }
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

async function main() {
    const { billsPerPair, numCompanies, delayMs, numClients, bobOnly } = parseArgs();

    console.log(`Configuration: ${numClients} clients, ${billsPerPair} bills per pair, ${numCompanies} companies, ${delayMs}ms delay, all-to-bob: ${bobOnly}`);

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

        const allClients = [];

        console.log('\n=== Phase 1: Initialize all clients ===');

        let existingHeavy = null;
        if (fs.existsSync(HEAVY_ACCOUNT_FILE)) {
            existingHeavy = JSON.parse(fs.readFileSync(HEAVY_ACCOUNT_FILE, 'utf8'));
        }

        let bob;
        if (existingHeavy?.seed_phrase) {
            console.log(`[bob] Recovering existing heavy account identity (expected node_id: ${existingHeavy.node_id})`);
            bob = await harness.initClient('bob');
            const recovered = await harness.recoverIdentity(bob, existingHeavy.seed_phrase);
            if (recovered.node_id !== existingHeavy.node_id) {
                throw new Error(`Recovered node_id ${recovered.node_id} does not match heavy-account.json ${existingHeavy.node_id}`);
            }
            bob.identity = {
                node_id: existingHeavy.node_id,
                name: 'bob',
                seed_phrase: existingHeavy.seed_phrase,
            };
            console.log(`[bob] Recovered identity: ${recovered.node_id}`);
        } else {
            console.log('[bob] Creating fresh identity');
            bob = await harness.bootstrapClient('bob', 'fresh');
        }
        allClients.push(bob);

        for (let i = 1; i < numClients; i++) {
            const client = await harness.bootstrapClient(`ephemeral-${i}`, 'fresh');
            allClients.push(client);
        }

        console.log('\n=== Phase 2: Cross-register contacts via contact shares ===');

        for (const client of allClients) {
            await harness.startNotificationTracking(client);
        }

        console.log('Sharing contact details...');
        for (let r = 0; r < numClients - 1; r++) {
            const roundPromises = [];
            for (let i = 0; i < numClients; i++) {
                const sender = allClients[i];
                const targetIndex = (i + 1 + r) % numClients;
                if (targetIndex === i) continue;
                const recipient = allClients[targetIndex];
                roundPromises.push(harness.shareContactDetails(sender, recipient.identity.node_id));
            }
            await Promise.all(roundPromises);
            console.log(`Contact share round ${r + 1}/${numClients - 1} complete`);
        }

        console.log('Waiting for contact share notifications...');
        for (const client of allClients) {
            await harness.waitForNotifications(client, numClients - 1, 60000);
        }

        console.log('Approving pending contact shares...');
        for (const client of allClients) {
            await harness.approveAllPendingContactShares(client);
        }

        console.log('\n=== Phase 3: Create bills ===');

        let billCount = 0;
        if (bobOnly) {
            console.log('All-to-bob mode: each ephemeral issues bills to bob');
            for (let b = 0; b < billsPerPair; b++) {
                const roundStart = Date.now();
                let successful = 0;
                const roundPromises = [];
                for (let i = 1; i < numClients; i++) {
                    roundPromises.push((async () => {
                        const billId = await harness.issueBill(
                            allClients[i],
                            allClients[i].identity.node_id,
                            bob.identity.node_id,
                            String(1000 + (b * (numClients - 1) + (i - 1)) * 100)
                        );
                        return billId;
                    })());
                }
                const results = await Promise.all(roundPromises);
                successful = results.filter(Boolean).length;
                billCount += successful;
                const roundDuration = Date.now() - roundStart;
                console.log(`Round ${b + 1}/${billsPerPair}: ${successful}/${roundPromises.length} bills in ${roundDuration}ms (total: ${billCount})`);

                if (delayMs > 0) await sleep(delayMs);
            }
        } else {
            const rounds = (numClients - 1) * billsPerPair;
            for (let r = 0; r < rounds; r++) {
                const roundStart = Date.now();
                let successful = 0;

                const roundPromises = [];
                for (let i = 0; i < numClients; i++) {
                    const drawer = allClients[i];
                    const payeeIndex = (i + 1 + Math.floor(r / billsPerPair)) % numClients;
                    if (payeeIndex === i) continue;
                    const payee = allClients[payeeIndex];
                    roundPromises.push((async () => {
                        const billId = await harness.issueBill(
                            drawer,
                            drawer.identity.node_id,
                            payee.identity.node_id,
                            String(1000 + (r * numClients + i) * 100)
                        );
                        return billId;
                    })());
                }

                const results = await Promise.all(roundPromises);
                successful = results.filter(Boolean).length;
                billCount += successful;
                const roundDuration = Date.now() - roundStart;
                console.log(`Round ${r + 1}/${rounds}: ${successful}/${roundPromises.length} bills in ${roundDuration}ms (total: ${billCount})`);

                if (delayMs > 0) await sleep(delayMs);
            }
        }
        console.log(`Created ${billCount} bills`);

        console.log('\n=== Phase 4: Create companies ===');

        for (let c = 0; c < numCompanies; c++) {
            const companyId = generateNodeId();
            const companyName = `BobCorp${c + 1}`;
            const created = await harness.createCompany(bob, companyId, companyName);

            if (created) {
                for (let i = 1; i < allClients.length; i++) {
                    const billId = await harness.issueBill(
                        bob,
                        bob.identity.node_id,
                        companyId,
                        String(5000 + c * 1000 + i * 100)
                    );
                    if (billId) {
                        billCount++;
                        if (delayMs > 0) await sleep(delayMs);
                    }
                }
            }
        }

        console.log(`Total bills created: ${billCount}`);

        console.log('\n=== Phase 5: Save heavy account state ===');

        const heavyAccount = {
            client_id: 'bob',
            node_id: bob.identity.node_id,
            seed_phrase: bob.identity.seed_phrase,
            num_bills: billCount,
            num_contacts: allClients.length - 1,
            num_companies: numCompanies,
            created_at: new Date().toISOString(),
        };
        fs.writeFileSync(HEAVY_ACCOUNT_FILE, JSON.stringify(heavyAccount, null, 2));
        saveAccountEntry('bob', heavyAccount.node_id, heavyAccount.seed_phrase);
        console.log(`Heavy account state saved to ${HEAVY_ACCOUNT_FILE}`);

        for (const clientId of harness.clients.keys()) {
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

    console.log('\nDone. Bob is now a heavy account ready for restore/load testing.');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
