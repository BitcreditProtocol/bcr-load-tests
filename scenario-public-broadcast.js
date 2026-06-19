import { LoadTestHarness } from './orchestrator.js';

function parseArgs() {
    const args = process.argv.slice(2);
    const publishersArg = args.find(a => a.startsWith('--publishers='));
    const durationArg = args.find(a => a.startsWith('--duration='));
    return {
        numPublishers: publishersArg ? parseInt(publishersArg.split('=')[1], 10) : 3,
        durationSec: durationArg ? parseInt(durationArg.split('=')[1], 10) : 120,
    };
}

async function main() {
    const { numPublishers, durationSec } = parseArgs();
    console.log(`Public Broadcast Test: ${numPublishers} publishers, ${durationSec}s duration`);
    console.log('Rate limit: 12 public block messages per 2 minutes per npub');

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

        // Phase 1: Create publishers with rate limits
        console.log('\n=== Phase 1: Create publishers ===');
        const publishers = [];
        for (let i = 1; i <= numPublishers; i++) {
            const pub = await harness.bootstrapClient(`publisher-${i}`, 'fresh');
            harness.setRateLimit(pub, 12, 120000);
            publishers.push(pub);
        }

        // Phase 2: Create a shared recipient for cross-registration
        console.log('\n=== Phase 2: Create shared recipient ===');
        const recipient = await harness.bootstrapClient('recipient', 'fresh');
        for (const pub of publishers) {
            await harness.addContact(pub, recipient.identity.node_id, 'Recipient');
            await harness.addContact(recipient, pub.identity.node_id, pub.identity.name || 'Pub');
        }

        // Phase 3: Emit public events at rate limit (concurrently per publisher)
        console.log('\n=== Phase 3: Emit public events ===');
        const startTime = Date.now();
        const endTime = startTime + durationSec * 1000;
        const results = [];

        const publishFor = async (pub) => {
            let localCount = 0;
            while (Date.now() < endTime) {
                const opStart = Date.now();
                const billId = await harness.issueBill(
                    pub,
                    pub.identity.node_id,
                    recipient.identity.node_id,
                    String(1000 + localCount)
                );
                const opEnd = Date.now();
                if (billId) {
                    localCount++;
                    results.push({ publisher: pub.clientId, latency: opEnd - opStart, time: opEnd });
                }
            }
            return localCount;
        };

        const eventCounts = await Promise.all(publishers.map(publishFor));
        const eventCount = eventCounts.reduce((a, b) => a + b, 0);

        // Phase 4: Report
        console.log('\n=== Results ===');
        const actualDuration = (Date.now() - startTime) / 1000;
        console.log(`Total events published: ${eventCount}`);
        console.log(`Duration: ${actualDuration.toFixed(1)}s`);
        console.log(`Throughput: ${(eventCount / actualDuration).toFixed(2)} events/sec`);
        console.log(`Per-publisher avg: ${(eventCount / numPublishers).toFixed(1)} events`);

        if (results.length > 0) {
            const latencies = results.map(r => r.latency);
            const min = Math.min(...latencies);
            const max = Math.max(...latencies);
            const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
            console.log(`Latency - min: ${min}ms, max: ${max}ms, avg: ${avg}ms`);

            // Per-publisher breakdown
            console.log('\nPer-publisher breakdown:');
            for (const pub of publishers) {
                const pubResults = results.filter(r => r.publisher === pub.clientId);
                if (pubResults.length > 0) {
                    const pubLatencies = pubResults.map(r => r.latency);
                    const pubAvg = Math.round(pubLatencies.reduce((a, b) => a + b, 0) / pubLatencies.length);
                    console.log(`  ${pub.clientId}: ${pubResults.length} events, avg latency ${pubAvg}ms`);
                } else {
                    console.log(`  ${pub.clientId}: 0 events`);
                }
            }
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
