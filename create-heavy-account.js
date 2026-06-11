import { LoadTestHarness } from './orchestrator.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HEAVY_ACCOUNT_FILE = path.join(__dirname, 'heavy-account.json');

function parseArgs() {
    const args = process.argv.slice(2);
    const billsArg = args.find(a => a.startsWith('--bills='));
    const companiesArg = args.find(a => a.startsWith('--companies='));
    const delayArg = args.find(a => a.startsWith('--delay='));
    return {
        billsPerPair: billsArg ? parseInt(billsArg.split('=')[1], 10) : 1,
        numCompanies: companiesArg ? parseInt(companiesArg.split('=')[1], 10) : 1,
        delayMs: delayArg ? parseInt(delayArg.split('=')[1], 10) : 10000,
    };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function generateNodeId() {
    const hex = crypto.randomBytes(32).toString('hex');
    return `bitcrt02${hex}`;
}

async function main() {
    const { billsPerPair, numCompanies, delayMs } = parseArgs();

    console.log(`Configuration: ${billsPerPair} bills per pair, ${numCompanies} companies, ${delayMs}ms delay`);

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

        const bob = await harness.bootstrapClient('bob', 'fresh');
        allClients.push(bob);

        for (let i = 1; i <= 4; i++) {
            const client = await harness.bootstrapClient(`ephemeral-${i}`, 'fresh');
            allClients.push(client);
        }

        console.log('\n=== Phase 2: Cross-register contacts ===');

        for (let i = 0; i < allClients.length; i++) {
            for (let j = 0; j < allClients.length; j++) {
                if (i !== j) {
                    await harness.addContact(
                        allClients[i],
                        allClients[j].identity.node_id,
                        allClients[j].identity.name || `User${j}`
                    );
                    if (delayMs > 0) await sleep(delayMs);
                }
            }
        }

        console.log('\n=== Phase 3: Create bills between all pairs ===');

        let billCount = 0;
        for (let i = 0; i < allClients.length; i++) {
            for (let j = 0; j < allClients.length; j++) {
                if (i !== j) {
                    for (let b = 0; b < billsPerPair; b++) {
                        const billId = await harness.issueBill(
                            allClients[i],
                            allClients[i].identity.node_id,
                            allClients[j].identity.node_id,
                            String(1000 + billCount * 100)
                        );
                        if (billId) {
                            billCount++;
                            if (delayMs > 0) await sleep(delayMs);
                        }
                    }
                }
            }
        }
        console.log(`Created ${billCount} bills between clients`);

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
