import { getClient } from '../adb/adb-client.js';

export async function executeDeviceAction({ serial, resolution, inputHandler, decision }) {
  const startedAt = Date.now();
  const transport = inputHandler ? 'input-handler' : 'adb';
  const device = getClient().getDevice(serial);
  const width = resolution?.width || 1;
  const height = resolution?.height || 1;

  switch (decision.action) {
    case 'tap': {
      const [x, y] = decision.coordinates || [0, 0];
      if (inputHandler?.tap) {
        await Promise.resolve(inputHandler.tap(x / width, y / height));
        await sleep(50);
      } else {
        await shell(device, `input tap ${x} ${y}`);
      }
      break;
    }
    case 'type': {
      if (inputHandler?.text) {
        await Promise.resolve(inputHandler.text(decision.text || ''));
      } else {
        const text = (decision.text || '').replace(/ /g, '%s').replace(/(['"\\$`!&|;(){}])/g, '\\$1');
        await shell(device, `input text "${text}"`);
      }
      break;
    }
    case 'swipe': {
      const dir = decision.direction || 'up';
      const cx = Math.round(width / 2);
      const cy = Math.round(height / 2);
      const d = Math.round(height * 0.3);
      const dirMap = {
        up: { x1: cx, y1: cy + d, x2: cx, y2: cy - d },
        down: { x1: cx, y1: cy - d, x2: cx, y2: cy + d },
        left: { x1: cx + d, y1: cy, x2: cx - d, y2: cy },
        right: { x1: cx - d, y1: cy, x2: cx + d, y2: cy },
      };
      const swipe = dirMap[dir] || dirMap.up;
      if (inputHandler?.swipe) {
        await Promise.resolve(inputHandler.swipe(swipe.x1 / width, swipe.y1 / height, swipe.x2 / width, swipe.y2 / height, 300));
        await sleep(350);
      } else {
        await shell(device, `input swipe ${swipe.x1} ${swipe.y1} ${swipe.x2} ${swipe.y2} 300`);
      }
      break;
    }
    case 'drag': {
      const [x1, y1] = decision.coordinates || [0, 0];
      const [x2, y2] = decision.endCoordinates || decision.coordinates || [0, 0];
      if (inputHandler?.swipe) {
        await Promise.resolve(inputHandler.swipe(x1 / width, y1 / height, x2 / width, y2 / height, 200));
        await sleep(250);
      } else {
        await shell(device, `input swipe ${x1} ${y1} ${x2} ${y2} 200`);
      }
      break;
    }
    case 'press': {
      const keys = { home: 3, back: 4, recent: 187, enter: 66, delete: 67 };
      const keycode = keys[decision.key] || 3;
      if (inputHandler?.key) {
        await Promise.resolve(inputHandler.key(keycode));
      } else {
        await shell(device, `input keyevent ${keycode}`);
      }
      break;
    }
    case 'launch': {
      const pkg = decision.package || '';
      await shell(device, `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
      break;
    }
    case 'wait': {
      await sleep(1500);
      break;
    }
    default:
      throw new Error(`Unsupported action: ${decision.action}`);
  }

  return {
    ok: true,
    transport,
    durationMs: Date.now() - startedAt,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
  };
}

async function shell(device, cmd) {
  const stream = await device.shell(cmd);
  for await (const _ of stream) {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}