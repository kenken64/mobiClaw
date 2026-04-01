import { execFile } from 'child_process';
import { promisify } from 'util';
import pkg from '@devicefarmer/adbkit';
import config from '../config.js';

const { Adb } = pkg;
const execFileAsync = promisify(execFile);

let client = null;

function getAdbPath() {
  return config.adbPath || 'adb';
}

export function getClient() {
  if (!client) {
    client = Adb.createClient();
  }
  return client;
}

export async function listDevices() {
  const c = getClient();
  const devices = await c.listDevices();
  return devices.filter(d => d.type === 'device');
}

export async function getDevice(serial) {
  const c = getClient();
  const devices = await c.listDevices();
  const device = devices.find(d => d.id === serial && d.type === 'device');
  if (!device) {
    throw new Error(`Device ${serial} not found or not authorized`);
  }
  return c.getDevice(serial);
}

export function trackDevices(callback) {
  const c = getClient();
  c.trackDevices().then(tracker => {
    tracker.on('add', device => callback('add', device));
    tracker.on('remove', device => callback('remove', device));
    tracker.on('change', device => callback('change', device));
    tracker.on('end', () => console.log('[ADB] Device tracking ended'));
    tracker.on('error', err => console.error('[ADB] Tracking error:', err.message));
  }).catch(err => {
    console.error('[ADB] Failed to start device tracking:', err.message);
  });
}

/**
 * Connect to a device over WiFi/TCP.
 * @param {string} host - IP address
 * @param {number} port - Port number (default 5555)
 */
export async function connectDevice(host, port = 5555) {
  const target = `${host}:${port}`;
  console.log(`[ADB] Connecting to ${target}...`);
  const { stdout, stderr } = await execFileAsync(getAdbPath(), ['connect', target]);
  const output = (stdout + stderr).trim();
  console.log(`[ADB] Connect result: ${output}`);
  if (output.includes('connected') || output.includes('already connected')) {
    return { success: true, message: output, serial: target };
  }
  return { success: false, message: output };
}

/**
 * Pair with a device using wireless debugging (Android 11+).
 * @param {string} host - IP address
 * @param {number} port - Pairing port
 * @param {string} code - 6-digit pairing code
 */
export async function pairDevice(host, port, code) {
  const target = `${host}:${port}`;
  console.log(`[ADB] Pairing with ${target} code=${code}...`);
  return new Promise((resolve) => {
    execFile(getAdbPath(), ['pair', target, code], { timeout: 15000 }, (err, stdout, stderr) => {
      const output = (stdout + stderr).trim();
      console.log(`[ADB] Pair result: ${output}`);
      if (output.includes('Successfully paired')) {
        return resolve({ success: true, message: 'Successfully paired! Now connect using the connection port.' });
      }
      resolve({ success: false, message: output || (err ? err.message : 'Pairing failed') });
    });
  });
}

/**
 * Disconnect a device.
 * @param {string} serial - Device serial (ip:port)
 */
export async function disconnectDevice(serial) {
  const { stdout, stderr } = await execFileAsync(getAdbPath(), ['disconnect', serial]);
  const output = (stdout + stderr).trim();
  console.log(`[ADB] Disconnect result: ${output}`);
  return { success: true, message: output };
}
