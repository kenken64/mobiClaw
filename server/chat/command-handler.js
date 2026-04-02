/**
 * Chat command handler - translates natural language prompts to ADB actions.
 * Supports built-in commands and smart pattern matching.
 */
import { getClient } from '../adb/adb-client.js';
import { getScreenResolution } from '../adb/device-info.js';

// Android keycodes
const KEYS = {
  home: 3, back: 4, recent: 187, recents: 187,
  'volume up': 24, 'vol up': 24, 'volume down': 25, 'vol down': 25,
  power: 26, enter: 66, delete: 67, backspace: 67,
  tab: 61, escape: 111, menu: 82,
  'play/pause': 85, 'media play': 126, 'media pause': 127,
  'media next': 87, 'media prev': 88,
  'brightness up': 221, 'brightness down': 220,
  camera: 27, search: 84,
};

// Common app package names
const APPS = {
  settings: 'com.android.settings',
  chrome: 'com.android.chrome',
  browser: 'com.android.chrome',
  camera: 'com.google.android.GoogleCamera',
  photos: 'com.google.android.apps.photos',
  gmail: 'com.google.android.gm',
  maps: 'com.google.android.apps.maps',
  youtube: 'com.google.android.youtube',
  play: 'com.android.vending',
  'play store': 'com.android.vending',
  phone: 'com.google.android.dialer',
  dialer: 'com.google.android.dialer',
  messages: 'com.google.android.apps.messaging',
  contacts: 'com.google.android.contacts',
  calendar: 'com.google.android.calendar',
  clock: 'com.google.android.deskclock',
  calculator: 'com.google.android.calculator',
  files: 'com.google.android.documentsui',
  'file manager': 'com.google.android.documentsui',
  spotify: 'com.spotify.music',
  twitter: 'com.twitter.android',
  x: 'com.twitter.android',
  instagram: 'com.instagram.android',
  facebook: 'com.facebook.katana',
  whatsapp: 'com.whatsapp',
  telegram: 'org.telegram.messenger',
  discord: 'com.discord',
  slack: 'com.Slack',
  tiktok: 'com.zhiliaoapp.musically',
  netflix: 'com.netflix.mediaclient',
};

export class CommandHandler {
  constructor(serial) {
    this.serial = serial;
    this.resolution = null;
  }

  async init() {
    this.resolution = await getScreenResolution(this.serial);
  }

  /**
   * Execute a chat command. Returns a result message.
   */
  async execute(prompt) {
    if (!this.resolution) await this.init();
    const input = prompt.trim().toLowerCase();

    // --- Press key ---
    const keyMatch = input.match(/^(?:press|hit|push)\s+(.+)$/);
    if (keyMatch) {
      const keyName = keyMatch[1].trim();
      if (KEYS[keyName] !== undefined) {
        await this._shell(`input keyevent ${KEYS[keyName]}`);
        return { action: 'key', detail: keyName, message: `Pressed ${keyName}` };
      }
      return { error: true, message: `Unknown key: "${keyName}". Available: ${Object.keys(KEYS).join(', ')}` };
    }

    // --- Shortcut: just key names ---
    if (KEYS[input] !== undefined) {
      await this._shell(`input keyevent ${KEYS[input]}`);
      return { action: 'key', detail: input, message: `Pressed ${input}` };
    }

    // --- Go home / go back ---
    if (/^(go\s+)?home$/.test(input)) {
      await this._shell('input keyevent 3');
      return { action: 'key', detail: 'home', message: 'Pressed Home' };
    }
    if (/^(go\s+)?back$/.test(input)) {
      await this._shell('input keyevent 4');
      return { action: 'key', detail: 'back', message: 'Pressed Back' };
    }

    // --- Open app ---
    const openMatch = input.match(/^(?:open|launch|start|run)\s+(.+)$/);
    if (openMatch) {
      const appName = openMatch[1].trim();
      return await this._openApp(appName);
    }

    // --- Close app ---
    const closeMatch = input.match(/^(?:close|kill|stop|force.?close)\s+(.+)$/);
    if (closeMatch) {
      const appName = closeMatch[1].trim();
      const pkg = APPS[appName];
      if (pkg) {
        await this._shell(`am force-stop ${pkg}`);
        return { action: 'close', detail: appName, message: `Closed ${appName}` };
      }
      return { error: true, message: `Unknown app: "${appName}"` };
    }

    // --- Type text ---
    const typeMatch = prompt.trim().match(/^(?:type|enter|input|write)\s+(.+)$/i);
    if (typeMatch) {
      const text = typeMatch[1];
      const escaped = text.replace(/ /g, '%s').replace(/(['"\\$`!&|;(){}])/g, '\\$1');
      await this._shell(`input text "${escaped}"`);
      return { action: 'type', detail: text, message: `Typed: "${text}"` };
    }

    // --- Tap ---
    const tapMatch = input.match(/^tap\s+(\d+)\s+(\d+)$/);
    if (tapMatch) {
      const x = parseInt(tapMatch[1]), y = parseInt(tapMatch[2]);
      await this._shell(`input tap ${x} ${y}`);
      return { action: 'tap', detail: `${x},${y}`, message: `Tapped at (${x}, ${y})` };
    }

    // Tap center / tap middle
    if (/^tap\s+(center|middle)$/.test(input)) {
      const x = Math.round(this.resolution.width / 2);
      const y = Math.round(this.resolution.height / 2);
      await this._shell(`input tap ${x} ${y}`);
      return { action: 'tap', detail: 'center', message: `Tapped center (${x}, ${y})` };
    }

    // Tap top/bottom/left/right
    const tapPosMatch = input.match(/^tap\s+(top|bottom|left|right)$/);
    if (tapPosMatch) {
      const { x, y } = this._positionToCoords(tapPosMatch[1]);
      await this._shell(`input tap ${x} ${y}`);
      return { action: 'tap', detail: tapPosMatch[1], message: `Tapped ${tapPosMatch[1]} (${x}, ${y})` };
    }

    // --- Swipe ---
    const swipeMatch = input.match(/^swipe\s+(up|down|left|right)$/);
    if (swipeMatch) {
      const { x1, y1, x2, y2 } = this._swipeCoords(swipeMatch[1]);
      await this._shell(`input swipe ${x1} ${y1} ${x2} ${y2} 300`);
      return { action: 'swipe', detail: swipeMatch[1], message: `Swiped ${swipeMatch[1]}` };
    }

    // --- Scroll ---
    const scrollMatch = input.match(/^scroll\s+(up|down)$/);
    if (scrollMatch) {
      const dir = scrollMatch[1];
      const { x1, y1, x2, y2 } = this._swipeCoords(dir);
      await this._shell(`input swipe ${x1} ${y1} ${x2} ${y2} 500`);
      return { action: 'scroll', detail: dir, message: `Scrolled ${dir}` };
    }

    // --- Screenshot ---
    if (/^(take\s+)?screenshot$/.test(input)) {
      await this._shell('screencap -p /sdcard/screenshot.png');
      return { action: 'screenshot', message: 'Screenshot saved to /sdcard/screenshot.png' };
    }

    // --- Screen on/off ---
    if (/^screen\s+on$/.test(input) || input === 'wake' || input === 'wake up') {
      await this._shell('input keyevent 224'); // WAKEUP
      return { action: 'key', detail: 'wake', message: 'Screen woke up' };
    }
    if (/^screen\s+off$/.test(input) || input === 'sleep') {
      await this._shell('input keyevent 223'); // SLEEP
      return { action: 'key', detail: 'sleep', message: 'Screen turned off' };
    }

    // --- Brightness ---
    const brightnessMatch = input.match(/^(?:set\s+)?brightness\s+(\d+)$/);
    if (brightnessMatch) {
      const level = Math.min(255, Math.max(0, parseInt(brightnessMatch[1])));
      await this._shell(`settings put system screen_brightness ${level}`);
      return { action: 'brightness', detail: level, message: `Brightness set to ${level}` };
    }

    // --- Volume ---
    if (/^volume\s+up$/.test(input)) {
      await this._shell('input keyevent 24');
      return { action: 'key', detail: 'volume up', message: 'Volume up' };
    }
    if (/^volume\s+down$/.test(input)) {
      await this._shell('input keyevent 25');
      return { action: 'key', detail: 'volume down', message: 'Volume down' };
    }
    if (/^(?:mute|volume\s+mute)$/.test(input)) {
      await this._shell('input keyevent 164');
      return { action: 'key', detail: 'mute', message: 'Toggled mute' };
    }

    // --- Rotate ---
    if (/^rotate$/.test(input) || /^rotate\s+screen$/.test(input)) {
      await this._shell('settings put system accelerometer_rotation 0');
      const current = (await this._shellOutput('settings get system user_rotation')).trim();
      const next = current === '0' ? '1' : '0';
      await this._shell(`settings put system user_rotation ${next}`);
      return { action: 'rotate', message: `Rotated to ${next === '0' ? 'portrait' : 'landscape'}` };
    }

    // --- Notification shade ---
    if (/^(open\s+)?notification(s)?$/.test(input) || input === 'pull down') {
      await this._shell('cmd statusbar expand-notifications');
      return { action: 'notification', message: 'Opened notification shade' };
    }
    if (/^(open\s+)?quick\s*settings$/.test(input)) {
      await this._shell('cmd statusbar expand-settings');
      return { action: 'quicksettings', message: 'Opened quick settings' };
    }

    // --- ADB shell passthrough ---
    const shellMatch = prompt.trim().match(/^(?:shell|adb|run)\s+(.+)$/i);
    if (shellMatch) {
      const output = await this._shellOutput(shellMatch[1]);
      return { action: 'shell', detail: shellMatch[1], message: output || '(no output)' };
    }

    // --- List installed apps ---
    if (/^list\s+apps$/.test(input) || input === 'installed apps') {
      const output = await this._shellOutput('pm list packages -3');
      const apps = output.split('\n').map(l => l.replace('package:', '').trim()).filter(Boolean).sort();
      return { action: 'list', message: `Installed apps (${apps.length}):\n${apps.join('\n')}` };
    }

    // --- Help ---
    if (input === 'help' || input === '?') {
      return {
        action: 'help',
        message: `Available commands:
- **open** [app] - Open an app (settings, chrome, youtube, etc.)
- **close** [app] - Force close an app
- **type** [text] - Type text into focused field
- **tap** [x] [y] or tap center/top/bottom
- **swipe** up/down/left/right
- **scroll** up/down
- **press** home/back/recent/power/volume up/volume down
- **screenshot** - Take a screenshot
- **notifications** - Open notification shade
- **quick settings** - Open quick settings panel
- **rotate** - Toggle screen rotation
- **brightness** [0-255] - Set brightness
- **volume up/down/mute**
- **wake** / **sleep** - Screen on/off
- **shell** [command] - Run raw ADB shell command
- **list apps** - Show installed apps
- **benchmark compare** - Run deterministic baseline vs enhanced suite
- **benchmark baseline|enhanced** - Run a single benchmark suite
- **benchmark stop** - Stop an active benchmark`
      };
    }

    return { error: true, message: `Unknown command. Type "help" for available commands.` };
  }

  async _openApp(appName) {
    // Check known apps first
    const pkg = APPS[appName];
    if (pkg) {
      await this._shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
      return { action: 'open', detail: appName, message: `Opened ${appName}` };
    }

    // Try to find by partial package name
    const output = await this._shellOutput(`pm list packages | grep -i ${appName}`);
    const packages = output.split('\n').map(l => l.replace('package:', '').trim()).filter(Boolean);

    if (packages.length === 1) {
      await this._shell(`monkey -p ${packages[0]} -c android.intent.category.LAUNCHER 1`);
      return { action: 'open', detail: packages[0], message: `Opened ${packages[0]}` };
    }
    if (packages.length > 1) {
      return { action: 'open', message: `Multiple matches:\n${packages.join('\n')}\nBe more specific.` };
    }

    return { error: true, message: `App "${appName}" not found. Try "list apps" to see installed apps.` };
  }

  _positionToCoords(position) {
    const w = this.resolution.width, h = this.resolution.height;
    switch (position) {
      case 'top': return { x: Math.round(w / 2), y: Math.round(h * 0.15) };
      case 'bottom': return { x: Math.round(w / 2), y: Math.round(h * 0.85) };
      case 'left': return { x: Math.round(w * 0.15), y: Math.round(h / 2) };
      case 'right': return { x: Math.round(w * 0.85), y: Math.round(h / 2) };
      default: return { x: Math.round(w / 2), y: Math.round(h / 2) };
    }
  }

  _swipeCoords(direction) {
    const w = this.resolution.width, h = this.resolution.height;
    const cx = Math.round(w / 2), cy = Math.round(h / 2);
    const dist = Math.round(h * 0.3);
    switch (direction) {
      case 'up': return { x1: cx, y1: cy + dist, x2: cx, y2: cy - dist };
      case 'down': return { x1: cx, y1: cy - dist, x2: cx, y2: cy + dist };
      case 'left': return { x1: cx + dist, y1: cy, x2: cx - dist, y2: cy };
      case 'right': return { x1: cx - dist, y1: cy, x2: cx + dist, y2: cy };
    }
  }

  async _shell(cmd) {
    const device = getClient().getDevice(this.serial);
    const stream = await device.shell(cmd);
    for await (const _ of stream) {}
  }

  async _shellOutput(cmd) {
    const device = getClient().getDevice(this.serial);
    const stream = await device.shell(cmd);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf-8').replace(/\r/g, '').trim();
  }
}
