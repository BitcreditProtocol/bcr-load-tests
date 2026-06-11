# BCR Load Test

Load testing harness for the Bitcredit E-Bill WASM client using Playwright to orchestrate multiple headless browser instances.

## Why Playwright?

The WASM module is built for browsers and uses `tokio_with_wasm`, which panics when `spawn` is called outside a browser environment (e.g., Node.js). Running in real browsers avoids this limitation entirely.

Each Playwright browser context gets its own isolated IndexedDB, localStorage, and cookies — perfect for simulating independent clients.

## Setup

```bash
npm install
npx playwright install chromium
```

## Quick Start

### Create fresh accounts (default)

```bash
node orchestrator.js --fresh alice bob
```

This creates two new identities, saves their seed phrases to `accounts.json`, and stores browser state in `storage/`.

### Recover existing accounts (from seed phrase)

```bash
node orchestrator.js --recover alice bob
```

Restores identities from saved seed phrases. The identity data will be resynced from the relay.

### Restore from session state (in-session only)

```bash
node orchestrator.js --restore alice bob
```

Currently falls back to `--recover` since IndexedDB state cannot be reliably persisted across browser sessions. For in-session persistence, keep the `LoadTestHarness` running and reuse client contexts.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page that loads the WASM module and exposes `window.bcrClient` |
| `orchestrator.js` | Main harness — spawns contexts, bootstraps accounts, runs scenarios |
| `create-heavy-account.js` | Creates a heavy account (Bob + 4 clients, bills, companies) |
| `scenario-restore.js` | Restores heavy account and measures sync performance |
| `accounts.json` | Persisted account metadata (node_id, seed_phrase) |
| `heavy-account.json` | Heavy account metadata for restore testing |
| `storage/*.json` | Playwright storage states |

## Architecture

```
orchestrator.js (Node.js)
  ├─ Browser Context 1 → Page with WASM client #1 (isolated IndexedDB)
  ├─ Browser Context 2 → Page with WASM client #2 (isolated IndexedDB)
  └─ Browser Context N → Page with WASM client #N
```

## Bootstrap Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| `--fresh` | Create new identity, save seed phrase | New test session |
| `--recover` | Restore keys from seed phrase, sync from relay | Resume existing account |
| `--restore` | Attempt to restore session state (falls back to recover) | Quick resume |

## Programmatic Usage

```javascript
import { LoadTestHarness } from './orchestrator.js';

const harness = new LoadTestHarness();
await harness.start();

// Create or recover accounts
const alice = await harness.bootstrapClient('alice', 'fresh');
const bob = await harness.bootstrapClient('bob', 'recover');

// Add contacts
await harness.addContact(alice, bob.identity.node_id, 'Bob');
await harness.addContact(bob, alice.identity.node_id, 'Alice');

// Run scenarios...

// Save state before stopping
await harness.saveState('alice');
await harness.saveState('bob');

await harness.stop();
```

## Account Format (accounts.json)

```json
[
  {
    "client_id": "alice",
    "name": "alice",
    "email": "alice@test.com",
    "node_id": "bitcrt03bd77b833554c1a9469ffc5368a698bfe423d6dae0f6895807855510fef6cd0b4",
    "seed_phrase": "abandon abandon ..."
  }
]
```

## Extending

Add scenarios by calling methods on `window.bcrClient.api` via `page.evaluate()`:

```javascript
async function issueBill(from, to, amount) {
    const result = await from.page.evaluate(async ({ toNodeId, amount }) => {
        const api = window.bcrClient.api;
        // Issue bill logic here
    }, { toNodeId: to.identity.node_id, amount });
    return result;
}
```

## Load Test Scenarios

### Create Heavy Account

Builds a heavy account for restore/replication testing:

```bash
node create-heavy-account.js
```

This recovers Bob, creates 4 ephemeral clients, cross-registers contacts, creates bills between all pairs, and creates companies with bills.

Options:
- `--bills=N` — bills per client pair (default: 1)
- `--companies=N` — number of companies to create (default: 1)
- `--delay=MS` — delay between operations in ms (default: 10000)

Example with faster rate (if relay limits allow):
```bash
node create-heavy-account.js --bills=5 --companies=2 --delay=1000
```

### Restore Load Test

Measures how long it takes to restore and sync a heavy account:

```bash
node scenario-restore.js
```

This recovers Bob from seed, waits for sync, and reports:
- Recovery initialization time
- Sync time
- Number of bills/companies/contacts synced

## Notes

- Seed phrase recovery triggers a relay resync which may take time
- Browser contexts are isolated — each has its own IndexedDB
- The dev relay (`wss://relay.wildcat0.clowder-dev.minibill.tech`) is used by default
- For local relay testing, update `nostr_relays` in `index.html`
