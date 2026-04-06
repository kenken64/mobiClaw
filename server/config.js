import 'dotenv/config';
import { existsSync } from 'fs';

function resolveAdbPath() {
  if (process.env.ADB_PATH && existsSync(process.env.ADB_PATH)) {
    return process.env.ADB_PATH;
  }
  // Common Windows locations
  const candidates = [
    'D:\\platform-tools\\adb.exe',
    'C:\\platform-tools\\adb.exe',
    `${process.env.LOCALAPPDATA || ''}\\Android\\Sdk\\platform-tools\\adb.exe`,
    `${process.env.ANDROID_HOME || ''}\\platform-tools\\adb.exe`,
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return 'adb'; // hope it's in PATH
}

export default {
  port: parseInt(process.env.PORT || '3000', 10),
  adbPath: resolveAdbPath(),
  // Screencap target FPS (actual FPS depends on device speed)
  targetFps: 10,
  // Scrcpy server settings
  scrcpy: {
    maxSize: parseInt(process.env.SCRCPY_MAX_SIZE || '960', 10),
    bitRate: parseInt(process.env.SCRCPY_BITRATE || '8000000', 10),
    maxFps: parseInt(process.env.SCRCPY_MAX_FPS || '30', 10),
  },
};
