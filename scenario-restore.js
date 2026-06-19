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
  console.log(`Expected: ${heavyAccount.num_bills} bills, ${heavyAccount.num_contacts} contacts, ${heavyAccount.num_companies} companies`);
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

    console.log(`Expected node_id: ${heavyAccount.node_id}`);
    console.log(`Seed phrase words: ${heavyAccount.seed_phrase?.split(' ')?.length || 0}`);

    const accountsPath = path.join(__dirname, 'accounts.json');
    let accounts = [];
    if (fs.existsSync(accountsPath)) {
      accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
    }
    const existingIdx = accounts.findIndex(a => a.client_id === heavyAccount.client_id);
    const accountEntry = {
      client_id: heavyAccount.client_id,
      name: heavyAccount.client_id,
      node_id: heavyAccount.node_id,
      seed_phrase: heavyAccount.seed_phrase,
    };
    if (existingIdx >= 0) {
      accounts[existingIdx] = accountEntry;
    } else {
      accounts.push(accountEntry);
    }
    fs.writeFileSync(accountsPath, JSON.stringify(accounts, null, 2));

    const bob = await harness.initClient('bob');
    await harness.clearIndexedDB(bob);
    const recovered = await harness.recoverIdentity(bob, heavyAccount.seed_phrase);
    console.log(`Recovered node_id: ${recovered.node_id}`);
    if (recovered.node_id !== heavyAccount.node_id) {
      throw new Error(`Recovered node_id ${recovered.node_id} does not match heavy-account.json ${heavyAccount.node_id}`);
    }
    bob.identity = {
      node_id: heavyAccount.node_id,
      name: heavyAccount.client_id,
    };
    const recoverMs = Date.now() - startRecover;
    console.log(`Recovery initiated in ${recoverMs}ms (sync continues in background)`);
    console.log('');

    console.log('=== Phase 2: Wait for full state sync ===');
    const startSync = Date.now();
    const syncTimeoutMs = 600000;
    const pollIntervalMs = 5000;

        let lastBills = -1;
        let lastCompanies = -1;
        let lastContacts = -1;
        let noProgressSince = Date.now();
        const noProgressTimeoutMs = 120000;
        let approvalAttempts = 0;

        let syncComplete = false;
        while (Date.now() - startSync < syncTimeoutMs) {
            const bills = await harness.getBills(bob);
            const companies = await harness.getCompanies(bob);
            const contacts = await harness.listContacts(bob);

            // Approve pending contact shares as they arrive in the background
            if (approvalAttempts % 3 === 0) {
                await harness.approveAllPendingContactShares(bob, true);
            }
            approvalAttempts++;

            const billsDone = bills.length >= heavyAccount.num_bills;
            const contactsDone = contacts.length >= heavyAccount.num_contacts;
            const companiesDone = companies.length >= heavyAccount.num_companies;

            const elapsed = Date.now() - startSync;
            console.log(`[${elapsed}ms] Bills: ${bills.length}/${heavyAccount.num_bills}, Companies: ${companies.length}/${heavyAccount.num_companies}, Contacts: ${contacts.length}/${heavyAccount.num_contacts}`);

            if (billsDone && contactsDone && companiesDone) {
                syncComplete = true;
                break;
            }

            const progress = bills.length > lastBills || companies.length > lastCompanies || contacts.length > lastContacts;
            if (progress) {
                lastBills = bills.length;
                lastCompanies = companies.length;
                lastContacts = contacts.length;
                noProgressSince = Date.now();
            } else if (Date.now() - noProgressSince > noProgressTimeoutMs) {
                console.log(`No progress for ${noProgressTimeoutMs}ms, stopping sync wait`);
                break;
            }

            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }

        const syncMs = Date.now() - startSync;

        if (!syncComplete) {
            console.log(`Sync timed out after ${syncMs}ms`);
        } else {
            console.log(`Sync completed in ${syncMs}ms`);
        }
        console.log('');

        console.log('=== Phase 3: Approve pending contact shares ===');
        await new Promise(r => setTimeout(r, 5000));
        const approvedContacts = await harness.approveAllPendingContactShares(bob);
        console.log(`Approved ${approvedContacts} pending contact shares`);
        console.log('');

    console.log('=== Phase 4: Verify state ===');
    const bills = await harness.getBills(bob);
    const companies = await harness.getCompanies(bob);
    const contacts = await harness.listContacts(bob);

    console.log('');
    console.log('=== Results ===');
    console.log(`Recovery init time: ${recoverMs}ms`);
    console.log(`Sync time: ${syncMs}ms`);
    console.log(`Bills synced: ${bills.length} / ${heavyAccount.num_bills}`);
    console.log(`Companies synced: ${companies.length} / ${heavyAccount.num_companies}`);
    console.log(`Contacts synced: ${contacts ? contacts.length : '?'} / ${heavyAccount.num_contacts}`);

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
