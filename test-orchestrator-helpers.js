import { LoadTestHarness } from './orchestrator.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function main() {
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

    const client = await harness.bootstrapClient('helper-smoke', 'fresh');

    const billIds = await harness.getBillIds(client);
    assert(Array.isArray(billIds), 'getBillIds should return an array');
    assert(billIds.length === 0, `getBillIds should be empty on fresh client, got ${billIds.length}`);
    console.log('getBillIds: OK (empty)');

    const baseline = await harness.takeStateSnapshot(client, 'baseline');
    assert(baseline.label === 'baseline', 'snapshot label should match');
    assert(Array.isArray(baseline.billIds), 'snapshot billIds should be an array');
    assert(baseline.takenAt > 0, 'snapshot takenAt should be set');
    assert(client.snapshots.length === 1, 'snapshot should be stored on client.snapshots');
    console.log('takeStateSnapshot: OK');

    const dbSummary = await harness.getIndexedDBSummary(client);
    assert(typeof dbSummary === 'object', 'getIndexedDBSummary should return an object');
    const dbNames = Object.keys(dbSummary);
    assert(dbNames.length >= 1, `expected at least one database, got ${dbNames.length}`);
    for (const dbName of dbNames) {
      const db = dbSummary[dbName];
      assert(typeof db.version === 'number', `db ${dbName} should have a version`);
      assert(typeof db.stores === 'object', `db ${dbName} should have stores`);
      assert(Object.keys(db.stores).length >= 1, `db ${dbName} should have at least one store`);
    }
    console.log('getIndexedDBSummary: OK');

    const exportData = await harness.exportIndexedDB(client);
    assert(typeof exportData === 'object', 'exportIndexedDB should return an object');
    assert(Object.keys(exportData).length >= 1, 'exportIndexedDB should return at least one database');
    console.log('exportIndexedDB: OK');

    await harness.setNetworkEnabled(client, false);
    await harness.setNetworkEnabled(client, true);
    console.log('setNetworkEnabled: OK');

    console.log('\nPASS');
  } catch (err) {
    console.error('\nFAIL:', err);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', cleanup);
    process.off('SIGTERM', cleanup);
    await harness.stop();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
