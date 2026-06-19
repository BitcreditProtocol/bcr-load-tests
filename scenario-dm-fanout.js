import { LoadTestHarness } from './orchestrator.js';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs() {
    const args = process.argv.slice(2);
    const recipientsArg = args.find(a => a.startsWith('--recipients='));
    return {
        numRecipients: recipientsArg ? parseInt(recipientsArg.split('=')[1], 10) : 5,
    };
}

async function main() {
    const { numRecipients } = parseArgs();
    console.log(`DM Fan-out Test: 1 payer → ${numRecipients} recipients`);
    console.log('Note: DMs are not rate-limited per npub, so bills can be issued rapidly.');

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

        // Phase 1: Create payer
        console.log('\n=== Phase 1: Create payer ===');
        const payer = await harness.bootstrapClient('payer', 'fresh');

        // Phase 2: Create recipients
        console.log('\n=== Phase 2: Create recipients ===');
        const recipients = [];
        for (let i = 1; i <= numRecipients; i++) {
            const recipient = await harness.bootstrapClient(`recipient-${i}`, 'fresh');
            recipients.push(recipient);
        }

        // Phase 3: Register contacts (bidirectional)
        console.log('\n=== Phase 3: Register contacts ===');
        for (const recipient of recipients) {
            await harness.addContact(payer, recipient.identity.node_id, recipient.identity.name || `Recipient`);
            await harness.addContact(recipient, payer.identity.node_id, payer.identity.name || 'Payer');
        }

        // Phase 4: Start notification tracking on all recipients
        console.log('\n=== Phase 4: Start notification tracking ===');
        for (const recipient of recipients) {
            await harness.startNotificationTracking(recipient);
        }

        // Phase 5: Payer shares contact details with each recipient (DM-only)
        console.log('\n=== Phase 5: Share contact details (DM-only fan-out) ===');
        const shareStartTime = Date.now();
        const shareResults = [];
        for (let i = 0; i < numRecipients; i++) {
            const shareStart = Date.now();
            const success = await harness.shareContactDetails(payer, recipients[i].identity.node_id);
            if (success) {
                shareResults.push({
                    recipientIndex: i,
                    recipientId: recipients[i].clientId,
                    shareMs: Date.now() - shareStart,
                    sharedAt: Date.now()
                });
            }
        }
        const totalShareTime = Date.now() - shareStartTime;
        console.log(`Shared contacts with ${shareResults.length} recipients in ${totalShareTime}ms`);

        // Phase 6: Wait for notifications and measure latency
        console.log('\n=== Phase 6: Measure DM delivery latency ===');
        const maxWaitMs = 30000;
        const waitStart = Date.now();
        const recipientResults = [];

        for (let i = 0; i < recipients.length; i++) {
            const notifications = await harness.waitForNotifications(recipients[i], 1, maxWaitMs);
            const waitTime = Date.now() - waitStart;
            if (notifications.length > 0) {
                const firstNotification = notifications[0];
                const latency = firstNotification.receivedAt - shareStartTime;
                recipientResults.push({
                    recipientId: recipients[i].clientId,
                    notificationsReceived: notifications.length,
                    latencyMs: latency,
                    waitTimeMs: waitTime
                });
                console.log(`[${recipients[i].clientId}] ${notifications.length} notification(s), first at +${latency}ms`);
            } else {
                recipientResults.push({
                    recipientId: recipients[i].clientId,
                    notificationsReceived: 0,
                    latencyMs: null,
                    waitTimeMs: waitTime
                });
                console.log(`[${recipients[i].clientId}] No notifications received`);
            }
        }

        // Report
        console.log('\n=== Results ===');
        console.log(`Contact shares sent: ${shareResults.length}/${numRecipients}`);
        console.log(`Total share time: ${totalShareTime}ms`);
        console.log(`Throughput: ${(shareResults.length / (totalShareTime / 1000)).toFixed(2)} shares/sec`);

        const successful = recipientResults.filter(r => r.notificationsReceived > 0);
        if (successful.length > 0) {
            const latencies = successful.map(r => r.latencyMs);
            const min = Math.min(...latencies);
            const max = Math.max(...latencies);
            const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
            console.log(`Notifications received: ${successful.length}/${numRecipients}`);
            console.log(`Delivery latency - min: ${min}ms, max: ${max}ms, avg: ${avg}ms`);
        } else {
            console.log('No notifications received by any recipient');
        }

        // Show per-recipient breakdown
        console.log('\nPer-recipient breakdown:');
        for (const r of recipientResults) {
            const latencyStr = r.latencyMs !== null ? `${r.latencyMs}ms` : 'timeout';
            console.log(`  ${r.recipientId}: ${r.notificationsReceived} notifs, latency: ${latencyStr}`);
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
