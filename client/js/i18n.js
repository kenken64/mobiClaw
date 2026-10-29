// Translate app-owned UI text while leaving device data and conversation content intact.
(() => {
  const zh = {
    'MobiClaw - AI-Powered Phone Control': 'MobiClaw - AI 手机控制',
    'AI-Powered Android Control': 'AI 安卓手机控制',
    'Control your phone': '控制您的手机',
    'with natural language': '使用自然语言',
    'Mirror your Android screen in the browser. Give the AI a goal in plain English — it reads the screen, thinks, and acts.': '在浏览器中镜像安卓屏幕。用自然语言告诉 AI 您的目标，它会读取屏幕、思考并操作。',
    'Enter your API Key': '输入 API 密钥', 'Required for AI agent to work': 'AI 助手需要此密钥',
    'Language': '语言', 'Provider': '服务提供商', 'Google Gemini (Recommended)': 'Google Gemini（推荐）', 'Ollama (Local)': 'Ollama（本地）',
    'Ollama Base URL': 'Ollama 服务地址', 'API Key': 'API 密钥', 'Paste your API key here...': '在此粘贴 API 密钥...',
    'Show/hide key': '显示或隐藏密钥', 'Get a free key at': '获取免费密钥：', 'Get a key at': '获取密钥：',
    'Make sure Ollama is running locally:': '请确保 Ollama 已在本地运行：',
    'Model': '模型', 'Launch MobiClaw': '启动 MobiClaw', 'Saving...': '正在保存...',
    'Configuration saved! Redirecting...': '配置已保存，正在跳转...', 'Failed to save': '保存失败',
    'Your API key is saved in your browser\'s localStorage and only shared with this local server.': 'API 密钥保存在浏览器的本地存储中，并仅发送到此服务器。',
    'Screen Mirror': '屏幕镜像', 'H.264 streaming with touch control from your browser': '通过浏览器使用 H.264 画面和触控',
    'AI Agent': 'AI 助手', 'Natural language goals — the AI sees, thinks, and acts': '使用自然语言设定目标，AI 会观察、思考并操作',
    'Multi-LLM': '多模型支持', 'Gemini, GPT, Qwen, or Claude — pick the best model for you': '选择适合您的 Gemini、GPT、Qwen 或 Claude 模型',
    'Built with Claude Code —': '使用 Claude Code 构建 —',
    'gemini-2.5-flash (Fast, recommended)': 'gemini-2.5-flash（快速，推荐）', 'gemini-2.5-pro (Most capable)': 'gemini-2.5-pro（功能最强）',
    'gpt-4o (Best vision)': 'gpt-4o（视觉能力最佳）', 'gpt-5.4 (Latest)': 'gpt-5.4（最新）', 'gpt-4o-mini (Budget)': 'gpt-4o-mini（经济）',
    'Claude Opus 4.6 (Most capable)': 'Claude Opus 4.6（功能最强）', 'Claude Sonnet 4 (Recommended)': 'Claude Sonnet 4（推荐）', 'Claude Haiku 4.5 (Fast)': 'Claude Haiku 4.5（快速）',
    'qwen2.5vl:72b (Vision, recommended)': 'qwen2.5vl:72b（视觉，推荐）', 'qwen2.5vl:7b (Vision, faster)': 'qwen2.5vl:7b（视觉，较快）', 'gemma4:e4b (Local experimental)': 'gemma4:e4b（本地实验版）', 'llava:latest (Vision)': 'llava:latest（视觉）',
    '●●●●●●●●●●●●●● (key saved — enter new key to change)': '●●●●●●●●●●●●●●（已保存密钥，输入新密钥可更换）',
    'AI-powered phone control': 'AI 手机控制', 'Disconnected': '未连接', 'Connected': '已连接', 'No device': '未连接设备', 'Streaming': '正在镜像', 'Reconnecting...': '正在重新连接...',
    'Back to home': '返回主页', 'Logout (clears saved API key)': '退出（清除已保存的 API 密钥）',
    'AI Model': 'AI 模型', 'Configure': '配置', 'Loading configuration...': '正在加载配置...', 'No AI provider configured': '尚未配置 AI 服务', 'AI configuration unavailable': '无法读取 AI 配置',
    'Device': '设备', 'Select device...': '选择设备...', 'Device Info': '设备信息', 'Refresh': '刷新',
    'Stable': '稳定', 'no disconnect': '保持连接', 'Agent': '助手', 'balanced AI': '均衡 AI', 'Ultra': '极速', 'realtime': '实时', 'Fast': '快速', 'scrcpy (5s drop)': 'scrcpy（5 秒断开）',
    'Start Mirror': '开始镜像', 'Stop Mirror': '停止镜像', 'Wireless ADB': '无线 ADB', 'Step 1: Pair (one-time)': '第 1 步：配对（仅需一次）',
    'Phone: Settings > Developer > Wireless debugging > Pair device': '手机：设置 > 开发者选项 > 无线调试 > 配对设备',
    'IP address': 'IP 地址', 'Pair port': '配对端口', '6-digit code': '6 位配对码', 'Pair Device': '配对设备',
    'Step 2: Connect (IP & port from Wireless debugging screen)': '第 2 步：连接（使用无线调试页面的 IP 和端口）', 'Port': '端口', 'Connect': '连接', 'Disconnect': '断开连接',
    'Browser USB ADB': '浏览器 USB ADB', 'Chrome/Edge only. Plug in an Android phone, enable USB debugging, then approve the WebUSB and RSA prompts.': '仅支持 Chrome/Edge。连接安卓手机，启用 USB 调试，然后确认 WebUSB 和 RSA 提示。',
    'Connect USB Device': '连接 USB 设备', 'Disconnect USB Device': '断开 USB 设备', 'Controls': '控制', 'Back': '返回', 'Home': '主页', 'Recent': '最近任务', 'Volume Up': '调高音量', 'Volume Down': '调低音量', 'Vol+': '音量+', 'Vol-': '音量-', 'Power': '电源',
    'Stats': '状态', 'Mode': '模式', 'Recording': '录屏', 'Idle': '空闲', 'Ready': '就绪', 'Start': '开始', 'Stop': '停止', 'Download': '下载', 'Start mirroring to enable recording.': '开始镜像后即可录屏。',
    'Playback Lab': '回放工具', 'Recorded Runs': '录制的运行记录', 'Refresh runs': '刷新运行记录', 'No recorded runs yet': '暂无运行记录', 'Script name (optional)': '脚本名称（可选）', 'View Run': '查看运行记录', 'Save As Script': '保存为脚本',
    'Saved Scripts': '已保存的脚本', 'Refresh scripts': '刷新脚本', 'No saved scripts yet': '暂无已保存的脚本', 'Strict': '严格', 'Tolerant': '容错', 'Continue': '继续', 'Retries': '重试次数', 'Hard fails': '硬失败次数', 'Soft fails': '软失败次数', 'Use semantic fallback before raw coordinates': '使用原始坐标前先尝试语义定位', 'Replay': '回放', 'Stop Replay': '停止回放', 'Replay Results': '回放结果', 'Refresh replays': '刷新回放结果', 'No replay results yet': '暂无回放结果', 'View Replay Result': '查看回放结果', 'Runs are recorded automatically during AI execution.': 'AI 执行时会自动记录运行过程。',
    'Connect Your Android Device': '连接安卓设备', 'Follow these steps to get started': '按以下步骤开始使用', 'Enable Developer Options': '启用开发者选项', 'Settings > About Phone > tap': '设置 > 关于手机 > 连续点击', 'Build Number': '版本号', '7 times': '7 次', 'Enable USB Debugging': '启用 USB 调试', 'Settings > Developer Options > turn on': '设置 > 开发者选项 > 启用', 'USB Debugging': 'USB 调试', 'Connect via USB': '通过 USB 连接', 'Plug in your phone with a': '使用', 'data cable': '数据线', '(not charge-only). Tap': '连接手机（不能仅充电）。在提示中点击', 'Allow': '允许', 'on the USB debugging prompt.': '以允许 USB 调试。', 'Start Mirroring': '开始镜像', 'Select your device from the dropdown on the left and click': '从左侧下拉菜单选择设备，然后点击', 'Or use Wireless ADB on the left panel to connect without USB': '也可使用左侧的无线 ADB 连接，无需 USB',
    'Control your phone with natural language': '用自然语言控制手机', 'Stop agent': '停止助手', 'Clear chat': '清除聊天', 'Show help': '显示帮助', 'Tell the AI what to do...': '告诉 AI 要做什么...', 'Start mirroring to use AI agent...': '开始镜像后即可使用 AI 助手...', 'Start mirroring first': '请先开始镜像', 'Send': '发送',
    'Tell the AI what to do on your phone.': '告诉 AI 在手机上执行什么操作。', 'It reads the screen, thinks, and acts.': '它会读取屏幕、思考并操作。', 'Try:': '试试看：', 'open youtube and search for lofi music': '打开 YouTube 并搜索轻音乐', 'open settings and turn on wifi': '打开设置并开启无线网络', 'go to chrome and search weather': '打开 Chrome 并搜索天气', 'Prefix with / for direct commands: /swipe up, /help': '输入 / 开头的直接命令，例如 /swipe up、/help',
    'Brand': '品牌', 'Screen': '屏幕', 'Battery': '电池', 'Recorded Run Detail': '运行记录详情', 'Select a recorded run to inspect its steps.': '选择一条运行记录以查看步骤。', 'No step selected.': '尚未选择步骤。', 'No steps recorded.': '没有记录的步骤。', 'Replay Result Detail': '回放结果详情', 'Select a replay result to inspect live vs expected state.': '选择回放结果以比较实际与预期状态。', 'No replay steps recorded.': '没有记录的回放步骤。'
  };
  const reverse = Object.fromEntries(Object.entries(zh).map(([en, translation]) => [translation, en]));
  let language = localStorage.getItem('mobiclaw-language') === 'zh' ? 'zh' : 'en';
  const originals = new WeakMap();
  const attributeOriginals = new WeakMap();
  const attrs = ['placeholder', 'title', 'aria-label'];

  function translated(value, previous) {
    const trimmed = value.trim();
    const source = previous?.last === trimmed ? previous.source : (reverse[trimmed] || trimmed);
    return { source, last: language === 'zh' ? (zh[source] || source) : source };
  }
  function translateText(node) {
    if (!node.parentElement || node.parentElement.closest('script, style')) return;
    if (node.parentElement.closest('#chat-messages') && !node.parentElement.closest('#chat-welcome')) return;
    const value = node.nodeValue;
    if (!value.trim()) return;
    const entry = translated(value, originals.get(node));
    originals.set(node, entry);
    const result = value.replace(value.trim(), entry.last);
    if (result !== value) node.nodeValue = result;
  }
  function translateAttributes(element) {
    let entries = attributeOriginals.get(element) || {};
    for (const attr of attrs) {
      if (!element.hasAttribute(attr)) continue;
      const value = element.getAttribute(attr);
      if (!value.trim()) continue;
      const entry = translated(value, entries[attr]);
      entries[attr] = entry;
      if (entry.last !== value) element.setAttribute(attr, entry.last);
    }
    attributeOriginals.set(element, entries);
  }
  function translateTree(root) {
    if (root.nodeType === Node.TEXT_NODE) { translateText(root); return; }
    if (root.nodeType !== Node.ELEMENT_NODE || root.matches('script, style')) return;
    if (root.closest('#chat-messages') && !root.closest('#chat-welcome') && root.id !== 'chat-messages') return;
    translateAttributes(root);
    for (const child of root.childNodes) translateTree(child);
  }
  function applyLanguage() {
    document.documentElement.lang = language === 'zh' ? 'zh-Hans' : 'en';
    document.querySelectorAll('[data-language-switch]').forEach(select => { select.value = language; });
    translateTree(document.documentElement);
  }
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-language-switch]').forEach(select => {
      select.value = language;
      select.addEventListener('change', () => {
        language = select.value === 'zh' ? 'zh' : 'en';
        localStorage.setItem('mobiclaw-language', language);
        applyLanguage();
      });
    });
    applyLanguage();
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'characterData') translateText(record.target);
        else if (record.type === 'attributes') translateAttributes(record.target);
        else for (const node of record.addedNodes) translateTree(node);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: attrs });
  });
})();
