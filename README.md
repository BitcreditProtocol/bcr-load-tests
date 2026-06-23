# BCR Load Test

Load testing harness for the Bitcredit E-Bill WASM client.
It uses Playwright to drive multiple headless Chromium instances,
each running the real WASM client in its own isolated browser context.

## Why Playwright?

The Bitcredit WASM module is built for browsers and relies on `tokio_with_wasm`.
Calling `spawn` outside a browser environment (for example, from Node.js directly) panics.
Running inside real Chromium contexts avoids this limitation
and gives each simulated client its own isolated IndexedDB, localStorage, and cookies.

## Repository Setup

1. Install Node dependencies:

   ```bash
   npm install
   ```

2. Install the Chromium browser for Playwright:

   ```bash
   npx playwright install chromium
   ```

3. Verify the static page loads locally:

   ```bash
   node orchestrator.js --fresh alice bob
   ```

   This should create two identities and print their `node_id`s. If it succeeds, the harness is ready.

## Target Relay and Rate Limits

By default all scenarios talk to the dev relay:

```text
wss://relay.wildcat0.clowder-dev.minibill.tech
```

Configured in `index.html` under `nostr_relays`.

Known relay limits:

- **Public block messages**: 12 per 2 minutes per npub
- **DMs and metadata**: not rate-limited
- Issuing a bill publishes up to 2 public block events for person-to-person bills, and up to 3 when companies are involved.

## Scenario Overview

| Scenario | Script | What it tests |
|---|---|---|
| **Scenario 1: DM Fan-out** | `scenario-dm-fanout.js` | One identity shares contact details with many recipients over DM; measures delivery latency |
| **Scenario 2: Public Broadcast** | `scenario-public-broadcast.js` | Multiple publishers issue bills concurrently; exercises public-block rate limits |
| **Scenario 3: Reconnect + Catch-up** | `scenario-reconnect-catchup.js` | Some clients stay online and publish bills while others are offline, then reconnect and must catch up |
| **Heavy Account Creation** | `create-heavy-account.js` | Creates a recoverable heavy account with bills, contacts, and companies |
| **Heavy Account Restore** | `scenario-restore.js` | Clears local state, recovers the heavy account from seed, and verifies sync |

## Quick Start for New Developers

Run the scenarios in this order. The first two are self-contained and fast. The heavy-account workflow creates shared state that `scenario-restore.js` consumes.

```bash
# 1. Make sure the harness can create identities
node orchestrator.js --fresh alice bob

# 2. DM fan-out (fast, no rate limits)
node scenario-dm-fanout.js --recipients=3

# 3. Public broadcast (exercises rate limits)
node scenario-public-broadcast.js --publishers=2 --duration=60

# 4. Reconnect catch-up (real offline workload)
node scenario-reconnect-catchup.js --publishers=1 --observers=1 --publish-duration=30 --offline-duration=10

# 5. Create the heavy account (slow; writes heavy-account.json)
node create-heavy-account.js --clients=4 --bills=1 --delay=0 --companies=0

# 6. Restore the heavy account
node scenario-restore.js
```

---

## Scenario 1: DM Fan-out

**What it tests**: How quickly contact-share DMs propagate from one payer to many recipients.
DMs are not rate-limited, so this runs without public-block throttling.

**How to run**:

```bash
node scenario-dm-fanout.js
```

**Options**:

| Option | Default | Description |
|---|---|---|
| `--recipients=N` | 5 | Number of recipient identities |

**Example**:

```bash
node scenario-dm-fanout.js --recipients=20
```

**What it measures**:

- Total time to share contact details with all recipients
- DM delivery latency per recipient
- Notification count and timing

**Expected output**: A report showing how many recipients received a notification and the min/max/average delivery latency.

---

## Scenario 2: Public Broadcast

**What it tests**: Multiple publisher identities issue bills concurrently to a shared recipient.
Each publisher has its own public-block rate limiter so the test stays within the relay's 12-per-2-minutes cap per npub.

**How to run**:

```bash
node scenario-public-broadcast.js
```

**Options**:

| Option | Default | Description |
|---|---|---|
| `--publishers=N` | 3 | Number of concurrent publishers |
| `--duration=SECONDS` | 120 | How long each publisher keeps issuing bills |

**Example**:

```bash
node scenario-public-broadcast.js --publishers=5 --duration=300
```

**What it measures**:

- Total events published
- Throughput (events per second)
- Per-publisher event count and average latency

**Expected output**: Total events, duration, throughput, and a per-publisher breakdown.

---

## Scenario 3: Reconnect + Catch-up

**What it tests**: Some clients stay online and publish bills while others are disconnected from the network. After the offline clients reconnect, the scenario measures how long each one takes to fetch the exact bill IDs it missed.

**How to run**:

```bash
node scenario-reconnect-catchup.js
```

**Options**:

| Option | Default | Description |
|---|---|---|
| `--publishers=N` | 2 | Number of clients that stay online and issue bills |
| `--observers=N` | 2 | Number of clients that disconnect and must catch up |
| `--publish-duration=N` | 60 | Seconds to publish bills while observers are offline |
| `--offline-duration=N` | 10 | Seconds observers stay offline before reconnecting |
| `--catchup-timeout=N` | 120000 | Max milliseconds to wait for each observer to catch up |
| `--clients=N` | 4 | Backward-compatible total clients (`publishers = ceil(N/2)`) |
| `--backlog-minutes=N` | - | Backward-compatible; sets publish-duration to `N * 60` seconds |

**Examples**:

```bash
# Recommended usage
node scenario-reconnect-catchup.js --publishers=2 --observers=2 --publish-duration=60 --offline-duration=15

# Backward-compatible (total clients, backlog minutes)
node scenario-reconnect-catchup.js --clients=4 --backlog-minutes=2

# Quick smoke test
node scenario-reconnect-catchup.js --publishers=1 --observers=1 --publish-duration=30 --offline-duration=10 --catchup-timeout=60000

# Higher load
node scenario-reconnect-catchup.js --publishers=5 --observers=5 --publish-duration=300 --offline-duration=60 --catchup-timeout=300000
```

**What it measures**:

- Total unique bills issued while observers are offline
- Publish throughput (events per second)
- Per-observer missed-bill count
- Reconnect time
- Per-observer catch-up/sync time
- IndexedDB growth after reconnect
- Whether all observers caught up (`allCaughtUp`)

**Expected output**: A report with `allCaughtUp: true`, per-observer missed counts, catch-up times, and IndexedDB deltas.

---

## Heavy Account Workflow

The heavy account is the recoverable state used by `scenario-restore.js`.
It is stored in `heavy-account.json` and also reflected in `accounts.json`.

### Create the Heavy Account

**What it tests**: Creates a recoverable account with a known number of bills, contacts, and companies so that restore performance can be measured.

**How to run**:

```bash
node create-heavy-account.js
```

**Defaults**:

- 4 clients total (Bob + 3 ephemerals)
- Each ephemeral issues bills to Bob
- 1 bill per ephemeral
- 10 second delay between rounds
- 1 company
- `--bob-only=true`

**Common options**:

```bash
# 10 ephemerals, 5 bills each, no delay, no companies
node create-heavy-account.js --clients=10 --bills=5 --delay=0 --companies=0
```

| Option | Default | Description |
|---|---|---|
| `--clients=N` | 4 | Total clients (Bob + ephemerals) |
| `--bills=N` | 1 | Bills each ephemeral issues to Bob per round |
| `--delay=MS` | 10000 | Milliseconds to wait between rounds |
| `--companies=N` | 1 | Companies Bob creates after bills |
| `--bob-only=true\|false` | true | If true, every ephemeral issues bills to Bob |

The command writes:

- `heavy-account.json` — canonical state for restore tests
- `accounts.json` — Bob's account entry
- `storage/*.json` — Playwright storage states

**Warning**: Re-running `create-heavy-account.js` overwrites `heavy-account.json`
and replaces the heavy account on the relay.
Do not re-run it if you want to keep an existing heavy account for restore tests.

### Restore the Heavy Account

**What it tests**: Clears local state, recovers the heavy account from its seed phrase, and verifies that bills, contacts, and companies sync from the relay.

**Prerequisite**: `create-heavy-account.js` must have been run at least once so `heavy-account.json` exists.

**How to run**:

```bash
node scenario-restore.js
```

This performs the following steps:

1. Loads `heavy-account.json`.
2. Starts a fresh browser context for Bob and clears its IndexedDB.
3. Calls `seed_recover` with Bob's seed phrase.
4. Reloads the page in the same context so the recovered identity is bootstrapped.
5. Polls the recovered identity.
6. Waits for bills, companies, and contacts to sync from the relay, approving pending contact shares as they arrive.
7. Prints recovery time, sync time, and final counts.

**Timeouts**:

- Identity polling: 60 seconds
- Full sync wait: 10 minutes
- No-progress early stop: 2 minutes

**Example output**:

```text
Restore test for bob
Expected: 180 bills, 9 contacts, 0 companies
...
=== Results ===
Recovery init time: 12345ms
Sync time: 134215ms
Bills synced: 180 / 180
Companies synced: 0 / 0
Contacts synced: 9 / 9
All bills synced successfully
```

---

## npm Scripts

Convenience scripts are defined in `package.json`:

```bash
npm start                    # node orchestrator.js
npm run serve                # static file server on port 8080
npm run test:single          # node test-single.js
npm run test:reconnect       # quick reconnect-catchup smoke test
```

## File Reference

| File | Purpose |
|---|---|
| `index.html` | WASM client page; configures relay, esplora, and job-runner delays |
| `orchestrator.js` | Core harness: browser/context management, identity helpers, rate limiter, bill/contact helpers, catch-up observation helpers |
| `create-heavy-account.js` | Builds the recoverable heavy account |
| `scenario-restore.js` | Recovers the heavy account and verifies full sync |
| `scenario-dm-fanout.js` | DM fan-out load test |
| `scenario-public-broadcast.js` | Public event broadcast load test |
| `scenario-reconnect-catchup.js` | Disconnect/reconnect catch-up test |
| `test-orchestrator-helpers.js` | Smoke test for the catch-up observation helpers |
| `accounts.json` | Persisted account metadata (node_id, seed_phrase) |
| `heavy-account.json` | Canonical heavy-account state for restore tests |
| `storage/*.json` | Playwright storage states |

## Isolation Between Scenarios

- Each Playwright browser context has its own IndexedDB, so clients do not share local state.
- `scenario-restore.js` clears Bob's IndexedDB before recovering,
  so it starts from a clean slate.
- The load scenarios (`scenario-dm-fanout.js`, `scenario-public-broadcast.js`,
  `scenario-reconnect-catchup.js`) create fresh identities.
  They do not touch the heavy account.
- Only `create-heavy-account.js` modifies `heavy-account.json` and the corresponding heavy-account state on the relay.

## Customizing the Relay

Edit `index.html`:

```javascript
nostr_relays: ["wss://relay.wildcat0.clowder-dev.minibill.tech"],
```

Replace the URL with your own relay.
If you change rate limits, update the limiter parameters in the scenario scripts or in `orchestrator.js`.
Use `setRateLimit(client, maxEvents, windowMs)` to adjust the limiter.

## Troubleshooting

- **WASM initialization timeout**: Make sure `npm install` completed and `npx playwright install chromium` was run.
- **Rate-limit errors during bill creation**: Increase `--delay` or reduce `--bills` in `create-heavy-account.js`.
- **Restore times out with fewer bills than expected**: The relay may be pruning or throttling large fetches.
  Try a smaller heavy account first (`--clients=4 --bills=1`).
- **Contacts stay at 0 after restore**: Contact-share DMs may not have arrived yet.
  `scenario-restore.js` approves pending shares continuously during the sync loop.
- **Catch-up reports `allCaughtUp: false`**: Increase `--catchup-timeout` or reduce `--publish-duration` / `--publishers`. The relay may be slow or rate-limiting publishers.
