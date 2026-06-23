import { LoadTestHarness } from './orchestrator.js';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs() {
    const args = process.argv.slice(2);
    const clientsArg = args.find(a => a.startsWith('--clients='));
    const publishersArg = args.find(a => a.startsWith('--publishers='));
    const observersArg = args.find(a => a.startsWith('--observers='));
    const backlogArg = args.find(a => a.startsWith('--backlog-minutes='));
    const publishDurationArg = args.find(a => a.startsWith('--publish-duration='));
    const offlineDurationArg = args.find(a => a.startsWith('--offline-duration='));
    const catchupTimeoutArg = args.find(a => a.startsWith('--catchup-timeout='));

    let numPublishers = publishersArg ? parseInt(publishersArg.split('=')[1], 10) : null;
    let numObservers = observersArg ? parseInt(observersArg.split('=')[1], 10) : null;
    let publishDurationSec = publishDurationArg ? parseInt(publishDurationArg.split('=')[1], 10) : null;
    const offlineDurationSec = offlineDurationArg ? parseInt(offlineDurationArg.split('=')[1], 10) : 10;
    const catchupTimeoutMs = catchupTimeoutArg ? parseInt(catchupTimeoutArg.split('=')[1], 10) : 120000;

    const hasExplicitPublishers = numPublishers !== null;
    const hasExplicitObservers = numObservers !== null;

    if (hasExplicitPublishers && !hasExplicitObservers) {
        numObservers = 1;
    } else if (!hasExplicitPublishers && hasExplicitObservers) {
        numPublishers = 1;
    } else if (!hasExplicitPublishers && !hasExplicitObservers) {
        if (clientsArg) {
            const numClients = parseInt(clientsArg.split('=')[1], 10);
            numPublishers = Math.ceil(numClients / 2);
            numObservers = numClients - numPublishers;
        } else {
            numPublishers = 2;
            numObservers = 2;
        }
    }

    if (publishDurationSec === null) {
        if (backlogArg) {
            const backlogMinutes = parseInt(backlogArg.split('=')[1], 10);
            publishDurationSec = backlogMinutes * 60;
        } else {
            publishDurationSec = 60;
        }
    }

    return {
        numPublishers,
        numObservers,
        publishDurationSec,
        offlineDurationSec,
        catchupTimeoutMs,
    };
}

function validateConfig(numPublishers, numObservers) {
    if (numPublishers < 1) {
        throw new Error(`At least one publisher is required, got ${numPublishers}`);
    }
    if (numObservers < 1) {
        throw new Error(`At least one observer is required, got ${numObservers}`);
    }
    const totalClients = numPublishers + numObservers;
    if (totalClients < 2) {
        throw new Error(`Total clients must be at least 2, got ${totalClients}`);
    }
}

function sumIndexedDBRecords(dbSummary) {
    let total = 0;
    for (const dbData of Object.values(dbSummary)) {
        for (const count of Object.values(dbData.stores)) {
            total += count;
        }
    }
    return total;
}

async function main() {
    const { numPublishers, numObservers, publishDurationSec, offlineDurationSec, catchupTimeoutMs } = parseArgs();
    validateConfig(numPublishers, numObservers);
    const totalClients = numPublishers + numObservers;

    console.log(`Reconnect + Catch-up Test: ${numPublishers} publishers, ${numObservers} observers`);
    console.log(`Publish duration: ${publishDurationSec}s, Offline duration: ${offlineDurationSec}s, Catch-up timeout: ${catchupTimeoutMs}ms`);

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

        // Phase 1: Create clients
        console.log('\n=== Phase 1: Create clients ===');
        const clients = [];
        for (let i = 1; i <= totalClients; i++) {
            const client = await harness.bootstrapClient(`client-${i}`, 'fresh');
            clients.push(client);
        }

        // Phase 2: Cross-register contacts
        console.log('\n=== Phase 2: Cross-register contacts ===');
        for (const client of clients) {
            await harness.startNotificationTracking(client);
        }

        for (let r = 0; r < totalClients - 1; r++) {
            const roundPromises = [];
            for (let i = 0; i < totalClients; i++) {
                const sender = clients[i];
                const targetIndex = (i + 1 + r) % totalClients;
                if (targetIndex === i) continue;
                const recipient = clients[targetIndex];
                roundPromises.push(harness.shareContactDetails(sender, recipient.identity.node_id));
            }
            await Promise.all(roundPromises);
            console.log(`Contact share round ${r + 1}/${totalClients - 1} complete`);
        }

        console.log('Waiting for contact share notifications...');
        for (const client of clients) {
            await harness.waitForNotifications(client, totalClients - 1, 60000);
        }

        console.log('Approving pending contact shares...');
        for (const client of clients) {
            await harness.approveAllPendingContactShares(client);
        }

        // Phase 3: Split roles
        console.log('\n=== Phase 3: Split roles ===');
        const publishers = clients.slice(0, numPublishers);
        const observers = clients.slice(numPublishers);
        for (const pub of publishers) {
            harness.setRateLimit(pub, 12, 120000);
        }
        console.log(`Publishers: ${publishers.map(c => c.clientId).join(', ')}`);
        console.log(`Observers: ${observers.map(c => c.clientId).join(', ')}`);

        // Phase 4: Baseline snapshot
        console.log('\n=== Phase 4: Capture baseline snapshot ===');
        for (const observer of observers) {
            await harness.takeStateSnapshot(observer, 'baseline');
        }

        // Phase 5: Disconnect observers
        console.log('\n=== Phase 5: Disconnect observers ===');
        for (const observer of observers) {
            await harness.setNetworkEnabled(observer, false);
        }
        console.log(`Observers offline, waiting ${offlineDurationSec}s...`);
        await sleep(offlineDurationSec * 1000);

        // Phase 6: Publish while observers are offline
        console.log('\n=== Phase 6: Publish while observers are offline ===');
        const issuedIdsByObserver = new Map();
        for (const observer of observers) {
            issuedIdsByObserver.set(observer.identity.node_id, []);
        }

        const publishStart = Date.now();
        const publishEnd = publishStart + publishDurationSec * 1000;
        const uniqueBillIds = new Set();
        let totalIssued = 0;

        while (Date.now() < publishEnd) {
            for (const pub of publishers) {
                const observer = observers[Math.floor(Math.random() * observers.length)];
                const sum = String(1000 + totalIssued);
                const billId = await harness.issueBill(
                    pub,
                    pub.identity.node_id,
                    observer.identity.node_id,
                    sum
                );
                if (billId) {
                    issuedIdsByObserver.get(observer.identity.node_id).push(billId);
                    uniqueBillIds.add(billId);
                    totalIssued++;
                }
            }
        }

        const publishDurationMs = Date.now() - publishStart;
        const publishDurationSecActual = publishDurationMs / 1000;
        console.log(`Published ${totalIssued} bills (${uniqueBillIds.size} unique) in ${publishDurationSecActual.toFixed(1)}s`);
        console.log(`Throughput: ${(uniqueBillIds.size / publishDurationSecActual).toFixed(2)} bills/sec`);

        // Phase 7: Wait for relay persistence
        console.log('\n=== Phase 7: Wait for relay persistence ===');
        await sleep(3000);
        console.log('Relay persistence wait complete');

        // Phase 8: Validate baseline
        console.log('\n=== Phase 8: Validate baseline snapshots ===');
        for (const observer of observers) {
            const baselineSnapshot = observer.snapshots.find(s => s.label === 'baseline');
            if (!baselineSnapshot) {
                throw new Error(`Missing baseline snapshot for ${observer.clientId}`);
            }
            const baselineSet = new Set(baselineSnapshot.billIds);
            const issuedToObserver = issuedIdsByObserver.get(observer.identity.node_id);
            const foundInBaseline = issuedToObserver.filter(id => baselineSet.has(id));
            if (foundInBaseline.length > 0) {
                throw new Error(`Baseline snapshot for ${observer.clientId} contains ${foundInBaseline.length} bill ID(s) issued while offline: ${foundInBaseline.join(', ')}`);
            }
            console.log(`[${observer.clientId}] Baseline valid: ${baselineSnapshot.billIds.length} bills, ${issuedToObserver.length} missed`);
        }

        // Phase 9: Reconnect observers
        console.log('\n=== Phase 9: Reconnect observers ===');
        const reconnectStart = Date.now();
        await Promise.all(observers.map(observer => harness.setNetworkEnabled(observer, true)));
        const reconnectTimeMs = Date.now() - reconnectStart;
        console.log(`All observers reconnected in ${reconnectTimeMs}ms`);

        // Phase 10: Measure catch-up
        console.log('\n=== Phase 10: Measure catch-up ===');
        const syncResults = [];
        for (const observer of observers) {
            const issuedIds = issuedIdsByObserver.get(observer.identity.node_id);
            const result = await harness.waitForBillIds(observer, issuedIds, catchupTimeoutMs);
            syncResults.push({
                clientId: observer.clientId,
                nodeId: observer.identity.node_id,
                missedCount: issuedIds.length,
                ...result,
            });
        }

        // Phase 11: Post-sync snapshot
        console.log('\n=== Phase 11: Capture post-sync snapshot ===');
        for (const observer of observers) {
            await harness.takeStateSnapshot(observer, 'post-sync');
        }

        // Phase 12: Report
        console.log('\n=== Results ===');
        const allCaughtUp = syncResults.every(r => r.synced);
        const totalReconnectSyncMs = Math.max(...syncResults.map(r => r.syncMs)) + reconnectTimeMs;

        console.log(`Publishers: ${numPublishers}`);
        console.log(`Observers: ${numObservers}`);
        console.log(`Total unique bills issued: ${uniqueBillIds.size}`);
        console.log(`Publish duration: ${publishDurationSecActual.toFixed(1)}s`);
        console.log(`Publish throughput: ${(uniqueBillIds.size / publishDurationSecActual).toFixed(2)} bills/sec`);
        console.log(`Offline duration: ${offlineDurationSec}s`);
        console.log(`Reconnect time: ${reconnectTimeMs}ms`);
        console.log(`Total reconnect + sync time: ${totalReconnectSyncMs}ms`);
        console.log(`allCaughtUp: ${allCaughtUp}`);

        console.log('\nPer-observer catch-up:');
        for (const result of syncResults) {
            const baselineSnapshot = observers.find(o => o.clientId === result.clientId)?.snapshots.find(s => s.label === 'baseline');
            const postSyncSnapshot = observers.find(o => o.clientId === result.clientId)?.snapshots.find(s => s.label === 'post-sync');
            const baselineCount = baselineSnapshot ? baselineSnapshot.billIds.length : 0;
            const baselineRecords = baselineSnapshot ? sumIndexedDBRecords(baselineSnapshot.dbSummary) : 0;
            const postSyncRecords = postSyncSnapshot ? sumIndexedDBRecords(postSyncSnapshot.dbSummary) : 0;
            const recordDelta = postSyncRecords - baselineRecords;
            const status = result.synced ? 'OK' : 'TIMEOUT';
            console.log(`  [${result.clientId}] ${status} - baseline: ${baselineCount}, missed: ${result.missedCount}, synced: ${result.synced}, catch-up: ${result.syncMs}ms, IndexedDB delta: ${recordDelta}`);
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
