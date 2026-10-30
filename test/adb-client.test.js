import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

// Set before importing config, which reads ADB_PATH at module load.
process.env.ADB_PATH = '/nonexistent/mobiclaw-test-adb';
const { getClient, pairDevice, connectDevice, disconnectDevice } = await import('../server/adb/adb-client.js');

test('uses ADB_PATH for adbkit and reports a missing executable', async () => {
  assert.equal(getClient().bin, process.env.ADB_PATH);
  for (const result of [await connectDevice('127.0.0.1', 5555), await disconnectDevice('127.0.0.1:5555')]) {
    assert.equal(result.success, false);
    assert.match(result.message, /ADB executable not found.*ADB_PATH/);
  }
  // A listening port also supports installations with a pairing-port preflight.
  const listener = net.createServer(socket => socket.destroy());
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  try {
    const result = await pairDevice('127.0.0.1', listener.address().port, '123456');
    assert.equal(result.success, false);
    assert.match(result.message, /ADB executable not found.*ADB_PATH/);
  } finally {
    await new Promise(resolve => listener.close(resolve));
  }
});
