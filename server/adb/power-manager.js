import { getClient } from './adb-client.js';

const wakeLocks = new Map();

async function shellOutput(serial, cmd) {
  const device = getClient().getDevice(serial);
  const stream = await device.shell(cmd);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r/g, '').trim();
}

async function readSetting(serial, namespace, key) {
  try {
    const value = await shellOutput(serial, `settings get ${namespace} ${key}`);
    return value || 'null';
  } catch {
    return 'null';
  }
}

async function writeSetting(serial, namespace, key, value) {
  if (value === null || value === undefined || value === 'null') {
    await shellOutput(serial, `settings delete ${namespace} ${key}`).catch(() => {});
    return;
  }
  await shellOutput(serial, `settings put ${namespace} ${key} ${value}`).catch(() => {});
}

export async function acquireMirrorWakeLock(serial) {
  const existing = wakeLocks.get(serial);
  if (existing) {
    existing.count += 1;
    return;
  }

  const previous = {
    screenOffTimeout: await readSetting(serial, 'system', 'screen_off_timeout'),
    stayOnWhilePluggedIn: await readSetting(serial, 'global', 'stay_on_while_plugged_in'),
  };

  wakeLocks.set(serial, { count: 1, previous });

  await Promise.allSettled([
    writeSetting(serial, 'system', 'screen_off_timeout', '2147483647'),
    writeSetting(serial, 'global', 'stay_on_while_plugged_in', '7'),
    shellOutput(serial, 'svc power stayon true'),
    shellOutput(serial, 'input keyevent KEYCODE_WAKEUP'),
  ]);
}

export async function releaseMirrorWakeLock(serial) {
  const existing = wakeLocks.get(serial);
  if (!existing) return;

  existing.count -= 1;
  if (existing.count > 0) return;

  wakeLocks.delete(serial);
  const { previous } = existing;

  await Promise.allSettled([
    writeSetting(serial, 'system', 'screen_off_timeout', previous.screenOffTimeout),
    writeSetting(serial, 'global', 'stay_on_while_plugged_in', previous.stayOnWhilePluggedIn),
    shellOutput(serial, 'svc power stayon false'),
  ]);
}