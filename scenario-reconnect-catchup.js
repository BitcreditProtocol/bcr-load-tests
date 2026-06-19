import { LoadTestHarness } from './orchestrator.js';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs() {
    const args = process.argv.slice(2);
    const clientsArg = args.find(a => a.startsWith('--clients='));
    const backlogArg = args.find(a => a.startsWith('--backlog-minutes='));
    return {
        numClients: clientsArg ? parseInt(clientsArg.split('=')[1], 10) : 3,
        backlogMinutes: backlogArg ? parseInt(backlogArg.split('=')[1], 10) : 5,
    };
}

async function main() {
    const { numClients, backlogMinutes } = parseArgs();
    console.log(`Reconnect + Catch-up Test: ${numClients} clients, ${backlogMinutes}min backlog`);

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
        for (let i = 1; i <= numClients; i++) {
            const client = await harness.bootstrapClient(`client-${i}`, 'fresh');
            harness.setRateLimit(client, 12, 120000);
            clients.push(client);
        }

        // Cross-register contacts so bills can be issued between any pair
        console.log('\n=== Phase 2: Cross-register contacts ===');
        for (let i = 0; i < clients.length; i++) {
            for (let j = 0; j < clients.length; j++) {
                if (i !== j) {
                    await harness.addContact(clients[i], clients[j].identity.node_id, clients[j].identity.name || `Client${j}`);
                }
            }
        }

        // Phase 3: Build backlog by having clients issue bills at rate limit
        console.log(`\n=== Phase 3: Build backlog for ${backlogMinutes} minutes ===`);
        const backlogStart = Date.now();
        const backlogEnd = backlogStart + backlogMinutes * 60 * 1000;
        let eventCount = 0;

        while (Date.now() < backlogEnd) {
            for (const client of clients) {
                const targets = clients.filter(c => c.identity.node_id !== client.identity.node_id);
                const target = targets[Math.floor(Math.random() * targets.length)];
                const billId = await harness.issueBill(
                    client,
                    client.identity.node_id,
                    target.identity.node_id,
                    String(1000 + eventCount)
                );
                if (billId) eventCount++;
            }
        }

        const backlogDuration = (Date.now() - backlogStart) / 1000;
        console.log(`Backlog built: ${eventCount} events in ${backlogDuration.toFixed(1)}s`);
        console.log(`Throughput: ${(eventCount / backlogDuration).toFixed(2)} events/sec`);

        // Capture per-client bill counts before disconnect
        console.log('\n=== Phase 4: Capture pre-disconnect state ===');
        const preDisconnectCounts = [];
        for (const client of clients) {
            const bills = await harness.getBills(client);
            preDisconnectCounts.push({ clientId: client.clientId, count: bills.length });
            console.log(`[${client.clientId}] ${bills.length} bills before disconnect`);
        }

        // Phase 5: Disconnect all clients
        console.log('\n=== Phase 5: Disconnect all clients ===');
        for (const client of clients) {
            await harness.disconnectClient(client);
        }
        await sleep(5000);
        console.log('All clients disconnected');

        // Phase 6: Reconnect all clients simultaneously
        console.log('\n=== Phase 6: Reconnect all clients simultaneously ===');
        const reconnectStart = Date.now();
        await Promise.all(clients.map(client => harness.reconnectClient(client)));
        const reconnectDuration = Date.now() - reconnectStart;
        console.log(`All clients reconnected in ${reconnectDuration}ms`);

        // Phase 7: Measure catch-up time
        console.log('\n=== Phase 7: Measure catch-up ===');
        const syncResults = await Promise.all(
            clients.map(async (client, index) => {
                const expectedCount = preDisconnectCounts[index].count;
                const syncStart = Date.now();
                const synced = await harness.waitForBillsSync(client, expectedCount, 120000);
                const syncMs = Date.now() - syncStart;
                return { clientId: client.clientId, synced, syncMs, expectedCount };
            })
        );

        const totalTime = Date.now() - reconnectStart;

        // Report
        console.log('\n=== Results ===');
        console.log(`Events in backlog: ${eventCount}`);
        console.log(`Disconnect duration: 5s (simulated)`);
        console.log(`Reconnect time: ${reconnectDuration}ms`);
        console.log(`Total reconnect + sync time: ${totalTime}ms`);
        console.log('\nPer-client catch-up:');
        for (const result of syncResults) {
            const status = result.synced ? 'OK' : 'TIMEOUT';
            console.log(`  [${result.clientId}] ${status} - ${result.syncMs}ms (expected ${result.expectedCount} bills)`);
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
