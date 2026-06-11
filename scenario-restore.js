import { LoadTestHarness } from './orchestrator.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HEAVY_ACCOUNT_FILE = path.join(__dirname, 'heavy-account.json');

function loadHeavyAccount() {
    if (!fs.existsSync(HEAVY_ACCOUNT_FILE)) {
        console.error('Heavy account not found. Run: node create-heavy-account.js');
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(HEAVY_ACCOUNT_FILE, 'utf8'));
}

async function main() {
    const heavyAccount = loadHeavyAccount();
    console.log(`Restore test for ${heavyAccount.client_id}`);
    console.log(`Expected: ${heavyAccount.num_bills} bills, ${heavyAccount.num_contacts} contacts`);
    console.log(`Account created: ${heavyAccount.created_at}`);
    console.log('');

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

        console.log('=== Phase 1: Recover heavy account from seed ===');
        const startRecover = Date.now();
        const bob = await harness.bootstrapClient('bob', 'recover');
        const recoverMs = Date.now() - startRecover;
        console.log(`Recovery initiated in ${recoverMs}ms (sync continues in background)`);
        console.log('');

        console.log('=== Phase 2: Wait for sync ===');
        const startSync = Date.now();
        const synced = await harness.waitForSync(bob, 120000);
        const syncMs = Date.now() - startSync;

        if (!synced) {
            console.log('Sync timed out after 120s');
        } else {
            console.log(`Sync completed in ${syncMs}ms`);
        }
        console.log('');

        console.log('=== Phase 3: Verify state ===');
        const bills = await harness.getBills(bob);
        const companies = await harness.getCompanies(bob);
        const contacts = await harness.listContacts(bob);

        console.log('');
        console.log('=== Results ===');
        console.log(`Recovery init time: ${recoverMs}ms`);
        console.log(`Sync time: ${syncMs}ms`);
        console.log(`Bills synced: ${bills.length} / ${heavyAccount.num_bills}`);
        console.log(`Companies synced: ${companies.length}`);
        console.log(`Contacts synced: ${contacts ? contacts.length : '?'}`);

        if (bills.length === heavyAccount.num_bills) {
            console.log('All bills synced successfully');
        } else {
            console.log(`WARNING: Expected ${heavyAccount.num_bills} bills, got ${bills.length}`);
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

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
