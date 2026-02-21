// ==UserScript==
// @name         Discord AI 自动翻译及回复助手
// @namespace    https://local.discord.ai.tools
// @version      0.1.6
// @description  Floating Discord translator/replier with context, cache, and OpenAI-compatible API support.
// @author       You
// @match        https://discord.com/channels/*
// @match        https://ptb.discord.com/channels/*
// @match        https://canary.discord.com/channels/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const SETTINGS_KEY = 'ai_translator_settings_v1';
  const CACHE_KEY = 'ai_translator_cache_v1';
  const CACHE_SAVE_DEBOUNCE_MS = 1200;
  const TRANSLATION_CLASS = 'tm-ai-translator-line';
  const PANEL_ID = 'tm-ai-translator-panel';

  const PROVIDER_PRESETS = {
    openai: {
      apiEndpoint: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-4o-mini',
    },
    deepseek: {
      apiEndpoint: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-chat',
    },
    custom: {
      apiEndpoint: '',
      model: '',
    },
  };

  const REPLY_PROMPT_PRESETS = [
    {
      id: 'random',
      label: '随机风格（每次生成变化）',
      instruction: '',
    },
    {
      id: 'friendly_brief',
      label: '友好简短',
      instruction: 'Friendly and casual tone. Keep it short: 1-2 concise sentences.',
    },
    {
      id: 'warm_supportive',
      label: '温暖支持',
      instruction: 'Empathetic and supportive tone. Acknowledge feelings before giving suggestion.',
    },
    {
      id: 'playful_light',
      label: '轻松俏皮',
      instruction: 'Light and playful tone with mild humor. Keep it natural, not exaggerated.',
    },
    {
      id: 'professional_clear',
      label: '专业清晰',
      instruction: 'Calm professional tone. Clear wording, polite, and to the point.',
    },
    {
      id: 'curious_followup',
      label: '追问引导',
      instruction: 'Use a curious tone and end with one short follow-up question.',
    },
    {
      id: 'action_oriented',
      label: '行动建议',
      instruction: 'Give practical next-step advice with one concrete suggestion.',
    },
    {
      id: 'confident_direct',
      label: '自信直接',
      instruction: 'Direct and confident tone. No fluff, no overexplaining.',
    },
    {
      id: 'thoughtful_detail',
      label: '细节走心',
      instruction: 'Thoughtful tone. Reference one concrete detail from context to avoid generic wording.',
    },
  ];

  const DEFAULT_SETTINGS = {
    enabled: true,
    autoTranslate: true,
    targetLanguage: '简体中文',
    contextSize: 6,
    provider: 'openai',
    apiEndpoint: PROVIDER_PRESETS.openai.apiEndpoint,
    apiKey: '',
    model: PROVIDER_PRESETS.openai.model,
    temperature: 0.2,
    requestIntervalMs: 900,
    maxCacheEntries: 1000,
    replyPresetId: 'random',
    replyExtraInstruction: '',
    systemPromptTranslate:
      'You are a precise conversation translator. Use context to disambiguate meaning, keep names/mentions/emoji, and return only translated message text. Do not include speaker names, labels, or bracket tags like [name].',
    systemPromptReply:
      'You are an assistant that writes natural Discord replies based on conversation context. Keep tone consistent with context.',
  };

  let settings = loadSettings();
  let cache = loadCache(settings.maxCacheEntries);
  let observer = null;
  let queue = Promise.resolve();
  let lastRequestAt = 0;
  let cacheSaveTimer = null;
  let lastLocation = window.location.href;
  let lastReplyPresetId = '';

  const pendingTranslationKeys = new Set();

  const ui = {
    panel: null,
    status: null,
    replyInput: null,
    replyOutput: null,
    form: {},
  };

  init();

  function init() {
    injectStyles();
    createPanel();
    bindPanelEvents();
    syncFormFromSettings();

    startObserver();
    processVisibleMessages(60);

    setInterval(() => {
      if (window.location.href !== lastLocation) {
        lastLocation = window.location.href;
        setStatus('频道已切换，正在扫描可见消息...');
        processVisibleMessages(60);
      }
    }, 1200);

    setStatus('已就绪。');
  }

  function loadSettings() {
    const raw = GM_getValue(SETTINGS_KEY, null);
    let parsed = null;

    if (raw && typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        parsed = null;
      }
    } else if (raw && typeof raw === 'object') {
      parsed = raw;
    }

    return {
      ...DEFAULT_SETTINGS,
      ...(parsed || {}),
    };
  }

  function saveSettings() {
    GM_setValue(SETTINGS_KEY, JSON.stringify(settings));
  }

  function loadCache(maxEntries) {
    const raw = GM_getValue(CACHE_KEY, null);
    let obj = {};

    if (raw && typeof raw === 'string') {
      try {
        obj = JSON.parse(raw) || {};
      } catch (error) {
        obj = {};
      }
    } else if (raw && typeof raw === 'object') {
      obj = raw;
    }

    const map = new Map(Object.entries(obj));
    while (map.size > maxEntries) {
      const oldestKey = map.keys().next().value;
      map.delete(oldestKey);
    }

    return map;
  }

  function persistCacheSoon() {
    if (cacheSaveTimer) {
      clearTimeout(cacheSaveTimer);
    }
    cacheSaveTimer = setTimeout(() => {
      cacheSaveTimer = null;
      const obj = Object.fromEntries(cache.entries());
      GM_setValue(CACHE_KEY, JSON.stringify(obj));
    }, CACHE_SAVE_DEBOUNCE_MS);
  }

  function resetCache() {
    cache.clear();
    GM_setValue(CACHE_KEY, JSON.stringify({}));
    setStatus('翻译缓存已清空。');
  }

  function setStatus(msg, isError) {
    if (!ui.status) {
      return;
    }
    ui.status.textContent = msg;
    ui.status.classList.toggle('error', Boolean(isError));
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        top: 88px;
        right: 18px;
        width: 340px;
        max-height: 80vh;
        overflow: auto;
        background: rgba(21, 24, 31, 0.96);
        color: #f2f4f8;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 12px;
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        box-shadow: 0 12px 35px rgba(0, 0, 0, 0.35);
      }
      #${PANEL_ID}.collapsed .tm-body {
        display: none;
      }
      #${PANEL_ID} .tm-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.03);
        cursor: move;
      }
      #${PANEL_ID} .tm-title {
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.2px;
      }
      #${PANEL_ID} .tm-controls {
        display: flex;
        gap: 6px;
      }
      #${PANEL_ID} .tm-btn {
        border: 1px solid rgba(255, 255, 255, 0.2);
        background: rgba(255, 255, 255, 0.06);
        color: #f2f4f8;
        border-radius: 7px;
        padding: 4px 8px;
        font-size: 12px;
        cursor: pointer;
      }
      #${PANEL_ID} .tm-btn:hover {
        background: rgba(255, 255, 255, 0.12);
      }
      #${PANEL_ID} .tm-body {
        padding: 10px 12px 12px;
      }
      #${PANEL_ID} .tm-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-bottom: 10px;
      }
      #${PANEL_ID} label {
        display: block;
        font-size: 12px;
        margin-bottom: 4px;
        color: rgba(255, 255, 255, 0.9);
      }
      #${PANEL_ID} .tm-field {
        margin-bottom: 8px;
      }
      #${PANEL_ID} input,
      #${PANEL_ID} select,
      #${PANEL_ID} textarea {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid rgba(255, 255, 255, 0.2);
        background: rgba(0, 0, 0, 0.24);
        color: #f5f6f7;
        border-radius: 8px;
        padding: 7px 8px;
        font-size: 12px;
      }
      #${PANEL_ID} textarea {
        min-height: 72px;
        resize: vertical;
      }
      #${PANEL_ID} .tm-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }
      #${PANEL_ID} .tm-row input[type='checkbox'] {
        width: auto;
      }
      #${PANEL_ID} .tm-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-top: 8px;
      }
      #${PANEL_ID} .tm-status {
        margin-top: 8px;
        font-size: 11px;
        line-height: 1.4;
        color: rgba(255, 255, 255, 0.78);
      }
      #${PANEL_ID} .tm-status.error {
        color: #ff8d8d;
      }
      .${TRANSLATION_CLASS} {
        margin-top: 4px;
        padding: 5px 7px;
        border-left: 2px solid var(--brand-500, #5865f2);
        background: rgba(88, 101, 242, 0.10);
        background: color-mix(in srgb, var(--brand-500, #5865f2) 12%, transparent);
        border-radius: 0 6px 6px 0;
        color: var(--text-normal, #1f2328);
        font-size: 12px;
        line-height: 1.45;
        white-space: pre-wrap;
      }
    `;
    document.head.appendChild(style);
  }

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="tm-header">
        <div class="tm-title">Discord AI 翻译与回复器</div>
        <div class="tm-controls">
          <button class="tm-btn" data-action="collapse">_</button>
        </div>
      </div>
      <div class="tm-body">
        <div class="tm-row">
          <label><input type="checkbox" id="tm-enabled"> 启用</label>
          <label><input type="checkbox" id="tm-auto"> 自动翻译</label>
        </div>

        <div class="tm-grid">
          <div class="tm-field">
            <label for="tm-lang">目标语言</label>
            <input id="tm-lang" type="text" placeholder="简体中文">
          </div>
          <div class="tm-field">
            <label for="tm-context">上下文条数</label>
            <input id="tm-context" type="number" min="1" max="20">
          </div>
        </div>

        <div class="tm-grid">
          <div class="tm-field">
            <label for="tm-provider">服务商</label>
            <select id="tm-provider">
              <option value="openai">OpenAI</option>
              <option value="deepseek">DeepSeek</option>
              <option value="custom">自定义</option>
            </select>
          </div>
          <div class="tm-field">
            <label for="tm-model">模型</label>
            <input id="tm-model" type="text" placeholder="gpt-4o-mini">
          </div>
        </div>

        <div class="tm-field">
          <label for="tm-endpoint">Chat Completion 接口地址</label>
          <input id="tm-endpoint" type="text" placeholder="https://api.openai.com/v1/chat/completions">
        </div>
        <div class="tm-field">
          <label for="tm-key">API Key</label>
          <input id="tm-key" type="password" placeholder="sk-...">
        </div>

        <div class="tm-grid">
          <div class="tm-field">
            <label for="tm-temperature">温度参数</label>
            <input id="tm-temperature" type="number" min="0" max="2" step="0.1">
          </div>
          <div class="tm-field">
            <label for="tm-interval">请求间隔(ms)</label>
            <input id="tm-interval" type="number" min="100" max="5000" step="100">
          </div>
        </div>

        <div class="tm-field">
          <label for="tm-reply-preset">预设提示词</label>
          <select id="tm-reply-preset">
            ${renderReplyPresetOptions()}
          </select>
        </div>

        <div class="tm-field">
          <label for="tm-reply-input">回复要求（可选）</label>
          <textarea id="tm-reply-input" placeholder="例如：语气友好、简短一点"></textarea>
        </div>
        <div class="tm-field">
          <label for="tm-reply-output">AI 回复输出</label>
          <textarea id="tm-reply-output" placeholder="生成的回复会显示在这里"></textarea>
        </div>

        <div class="tm-actions">
          <button class="tm-btn" data-action="save">保存设置</button>
          <button class="tm-btn" data-action="scan">翻译可见消息</button>
          <button class="tm-btn" data-action="reply">生成回复</button>
          <button class="tm-btn" data-action="insert">写入输入框</button>
          <button class="tm-btn" data-action="clear">清空缓存</button>
        </div>
        <div class="tm-status" id="tm-status">初始化中...</div>
      </div>
    `;
    document.body.appendChild(panel);

    ui.panel = panel;
    ui.status = panel.querySelector('#tm-status');
    ui.replyInput = panel.querySelector('#tm-reply-input');
    ui.replyOutput = panel.querySelector('#tm-reply-output');
    ui.form = {
      enabled: panel.querySelector('#tm-enabled'),
      autoTranslate: panel.querySelector('#tm-auto'),
      targetLanguage: panel.querySelector('#tm-lang'),
      contextSize: panel.querySelector('#tm-context'),
      provider: panel.querySelector('#tm-provider'),
      model: panel.querySelector('#tm-model'),
      apiEndpoint: panel.querySelector('#tm-endpoint'),
      apiKey: panel.querySelector('#tm-key'),
      temperature: panel.querySelector('#tm-temperature'),
      requestIntervalMs: panel.querySelector('#tm-interval'),
      replyPreset: panel.querySelector('#tm-reply-preset'),
    };

    makeDraggable(panel, panel.querySelector('.tm-header'));
  }

  function bindPanelEvents() {
    ui.panel.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) {
        return;
      }

      const action = button.getAttribute('data-action');

      if (action === 'collapse') {
        ui.panel.classList.toggle('collapsed');
        return;
      }

      if (action === 'save') {
        syncSettingsFromForm();
        saveSettings();
        setStatus('设置已保存。');
        return;
      }

      if (action === 'scan') {
        syncSettingsFromForm();
        saveSettings();
        processVisibleMessages(100, true);
        setStatus('已开始手动扫描。');
        return;
      }

      if (action === 'reply') {
        syncSettingsFromForm();
        saveSettings();
        await generateReplyFromContext();
        return;
      }

      if (action === 'insert') {
        insertReplyToComposer();
        return;
      }

      if (action === 'clear') {
        resetCache();
      }
    });

    ui.form.provider.addEventListener('change', () => {
      const provider = ui.form.provider.value;
      const preset = PROVIDER_PRESETS[provider];
      if (!preset) {
        return;
      }
      if (provider === 'custom') {
        return;
      }
      ui.form.apiEndpoint.value = preset.apiEndpoint;
      ui.form.model.value = preset.model;
    });
  }

  function syncFormFromSettings() {
    ui.form.enabled.checked = Boolean(settings.enabled);
    ui.form.autoTranslate.checked = Boolean(settings.autoTranslate);
    ui.form.targetLanguage.value = settings.targetLanguage || '';
    ui.form.contextSize.value = String(settings.contextSize || DEFAULT_SETTINGS.contextSize);
    ui.form.provider.value = settings.provider || 'openai';
    ui.form.model.value = settings.model || '';
    ui.form.apiEndpoint.value = settings.apiEndpoint || '';
    ui.form.apiKey.value = settings.apiKey || '';
    ui.form.temperature.value = String(settings.temperature);
    ui.form.requestIntervalMs.value = String(settings.requestIntervalMs);
    ui.form.replyPreset.value = settings.replyPresetId || 'random';
    ui.replyInput.value = settings.replyExtraInstruction || '';
  }

  function syncSettingsFromForm() {
    settings.enabled = ui.form.enabled.checked;
    settings.autoTranslate = ui.form.autoTranslate.checked;
    settings.targetLanguage = (ui.form.targetLanguage.value || DEFAULT_SETTINGS.targetLanguage).trim();
    settings.contextSize = clampNumber(ui.form.contextSize.value, 1, 20, DEFAULT_SETTINGS.contextSize);
    settings.provider = ui.form.provider.value;
    settings.model = (ui.form.model.value || '').trim();
    settings.apiEndpoint = (ui.form.apiEndpoint.value || '').trim();
    settings.apiKey = ui.form.apiKey.value.trim();
    settings.temperature = clampNumber(ui.form.temperature.value, 0, 2, DEFAULT_SETTINGS.temperature);
    settings.requestIntervalMs = clampNumber(ui.form.requestIntervalMs.value, 100, 5000, DEFAULT_SETTINGS.requestIntervalMs);
    settings.replyPresetId = ui.form.replyPreset.value || 'random';
    settings.replyExtraInstruction = sanitizeText(ui.replyInput.value || '');

    cache = trimCacheToLimit(cache, settings.maxCacheEntries);
    persistCacheSoon();
  }

  function clampNumber(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, num));
  }

  function trimCacheToLimit(map, maxEntries) {
    while (map.size > maxEntries) {
      const key = map.keys().next().value;
      map.delete(key);
    }
    return map;
  }

  function startObserver() {
    if (observer) {
      observer.disconnect();
    }

    observer = new MutationObserver((mutations) => {
      if (!settings.enabled || !settings.autoTranslate) {
        return;
      }

      const candidates = new Set();

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) {
            continue;
          }

          if (isMessageNode(node)) {
            candidates.add(node);
          }

          node.querySelectorAll?.('[id^="chat-messages-"]').forEach((el) => {
            if (isMessageNode(el)) {
              candidates.add(el);
            }
          });
        }
      }

      if (!candidates.size) {
        return;
      }

      for (const messageNode of candidates) {
        scheduleTranslateForNode(messageNode);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function isMessageNode(node) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }
    const id = node.id || '';
    return /^chat-messages-\d+-\d+$/.test(id);
  }

  function getMessageNodes() {
    return Array.from(document.querySelectorAll('[id^="chat-messages-"]')).filter((node) => isMessageNode(node));
  }

  function processVisibleMessages(limit, force) {
    const shouldForce = Boolean(force);
    if (!settings.enabled || (!settings.autoTranslate && !shouldForce)) {
      return;
    }

    const all = getMessageNodes();
    const subset = all.slice(-Math.max(1, limit));

    for (const node of subset) {
      scheduleTranslateForNode(node);
    }
  }

  function scheduleTranslateForNode(node) {
    const meta = readMessageMeta(node);
    if (!meta || !meta.text) {
      return;
    }

    const key = buildCacheKey(meta.channelId, meta.messageId, settings.targetLanguage, settings.model);

    if (node.querySelector(`.${TRANSLATION_CLASS}`)) {
      return;
    }

    const cached = getFromCache(key);
    if (cached) {
      attachTranslation(node, cached, true);
      return;
    }

    if (pendingTranslationKeys.has(key)) {
      return;
    }

    pendingTranslationKeys.add(key);
    enqueue(async () => {
      try {
        const contextMessages = collectContextForNode(node, settings.contextSize);
        const translated = await translateWithContext(meta, contextMessages);
        if (!translated) {
          return;
        }

        setCache(key, translated);
        attachTranslation(node, translated, false);
      } catch (error) {
        setStatus(`翻译失败：${error.message}`, true);
      } finally {
        pendingTranslationKeys.delete(key);
      }
    });
  }

  function enqueue(task) {
    queue = queue
      .then(async () => {
        await waitForRateLimit();
        await task();
      })
      .catch((error) => {
        setStatus(`队列异常：${error.message}`, true);
      });

    return queue;
  }

  async function waitForRateLimit() {
    const now = Date.now();
    const waitMs = settings.requestIntervalMs - (now - lastRequestAt);
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    lastRequestAt = Date.now();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function readMessageMeta(node) {
    if (!node || !isMessageNode(node)) {
      return null;
    }

    const idMatch = (node.id || '').match(/^chat-messages-(\d+)-(\d+)$/);
    if (!idMatch) {
      return null;
    }

    const channelId = idMatch[1];
    const messageId = idMatch[2];
    const text = extractMessageText(node);

    if (!text) {
      return null;
    }

    const author = extractAuthor(node) || 'Unknown';

    return {
      node,
      channelId,
      messageId,
      author,
      text,
    };
  }

  function extractAuthor(node) {
    const selectors = [
      'h3 [id^="message-username-"]',
      'h3 span[class*="username"]',
      'span[class*="username"]',
      'a[class*="username"]',
    ];

    for (const selector of selectors) {
      const el = node.querySelector(selector);
      if (el && el.textContent) {
        const v = el.textContent.trim();
        if (v) {
          return v;
        }
      }
    }

    return '';
  }

  function extractMessageText(node) {
    const direct = node.querySelector('[id^="message-content-"]');
    if (direct && direct.innerText && direct.innerText.trim()) {
      return sanitizeText(direct.innerText);
    }

    const markup = node.querySelector('[class*="markup"]');
    if (markup && markup.innerText && markup.innerText.trim()) {
      return sanitizeText(markup.innerText);
    }

    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode(textNode) {
        if (!textNode || !textNode.nodeValue) {
          return NodeFilter.FILTER_REJECT;
        }
        const value = textNode.nodeValue.trim();
        if (!value) {
          return NodeFilter.FILTER_REJECT;
        }
        const parent = textNode.parentElement;
        if (!parent) {
          return NodeFilter.FILTER_ACCEPT;
        }
        if (parent.closest(`.${TRANSLATION_CLASS}`)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const parts = [];
    while (walker.nextNode()) {
      const value = walker.currentNode.nodeValue.trim();
      if (value) {
        parts.push(value);
      }
    }

    return sanitizeText(parts.join(' '));
  }

  function sanitizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeTranslationText(text, author) {
    const original = sanitizeText(text);
    let cleaned = original;

    // Remove fenced code blocks if model accidentally wraps output.
    cleaned = cleaned.replace(/^```(?:\w+)?\s*([\s\S]*?)\s*```$/u, '$1').trim();

    // Remove common leading labels or bracket tags.
    cleaned = cleaned.replace(/^(?:translation|translated text|译文|翻译)\s*[:：]\s*/iu, '');
    cleaned = cleaned.replace(/^(?:\[[^\]\r\n]{1,40}\]\s*)+/u, '');

    if (author) {
      const escapedAuthor = escapeRegExp(author.trim());
      if (escapedAuthor) {
        cleaned = cleaned.replace(new RegExp(`^${escapedAuthor}\\s*[:：-]\\s*`, 'iu'), '');
        cleaned = cleaned.replace(new RegExp(`^\\[${escapedAuthor}\\]\\s*`, 'iu'), '');
      }
    }

    cleaned = sanitizeText(cleaned);
    return cleaned || original;
  }

  function escapeRegExp(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function collectContextForNode(targetNode, maxCount) {
    const nodes = getMessageNodes();
    const idx = nodes.findIndex((node) => node.id === targetNode.id);
    if (idx < 0) {
      return [];
    }

    const start = Math.max(0, idx - Math.max(1, maxCount));
    const context = [];

    for (let i = start; i < idx; i += 1) {
      const meta = readMessageMeta(nodes[i]);
      if (!meta || !meta.text) {
        continue;
      }
      context.push({
        author: meta.author,
        text: truncate(meta.text, 300),
      });
    }

    return context;
  }

  function collectLatestContext(maxCount) {
    const nodes = getMessageNodes();
    const context = [];

    for (let i = Math.max(0, nodes.length - maxCount); i < nodes.length; i += 1) {
      const meta = readMessageMeta(nodes[i]);
      if (!meta || !meta.text) {
        continue;
      }
      context.push({
        author: meta.author,
        text: truncate(meta.text, 360),
      });
    }

    return context;
  }

  function truncate(text, limit) {
    const value = String(text || '');
    if (value.length <= limit) {
      return value;
    }
    return value.slice(0, limit) + '...';
  }

  async function translateWithContext(message, contextMessages) {
    const contextText = contextMessages.length
      ? contextMessages.map((msg, idx) => `${idx + 1}. [${msg.author}] ${msg.text}`).join('\n')
      : '(No prior context)';

    const userPrompt = [
      `目标语言：${settings.targetLanguage}`,
      '对话上下文：',
      contextText,
      '待翻译内容：',
      message.text,
      '只返回译文，不要解释，不要加说话人、括号标签、语言标签。',
    ].join('\n');

    setStatus(`正在翻译消息 ${message.messageId} ...`);

    const content = await requestChatCompletion([
      {
        role: 'system',
        content: settings.systemPromptTranslate,
      },
      {
        role: 'user',
        content: userPrompt,
      },
    ]);

    setStatus(`消息 ${message.messageId} 翻译完成。`);
    return normalizeTranslationText(content, message.author);
  }

  async function generateReplyFromContext() {
    try {
      if (!settings.apiEndpoint || !settings.model) {
        setStatus('请先配置接口地址和模型。', true);
        return;
      }

      const context = collectLatestContext(Math.max(2, settings.contextSize));
      if (!context.length) {
        setStatus('未找到可见消息上下文。', true);
        return;
      }

      const instruction = sanitizeText(settings.replyExtraInstruction || ui.replyInput.value || '');
      const preset = resolveReplyPreset(settings.replyPresetId);
      const contextText = context.map((msg, idx) => `${idx + 1}. [${msg.author}] ${msg.text}`).join('\n');
      const variationToken = Math.random().toString(36).slice(2, 8);

      const userPrompt = [
        'Generate one Discord reply from this context.',
        `Style preset: ${preset.label}`,
        `Style guidance: ${preset.instruction}`,
        'Avoid repetitive templates and vary wording/sentence openings.',
        `Variation token: ${variationToken} (do not output this token).`,
        'Context:',
        contextText,
        instruction ? `Extra instruction: ${instruction}` : '',
        'Output only reply text.',
      ]
        .filter(Boolean)
        .join('\n');

      setStatus('正在生成回复...');
      await waitForRateLimit();
      const reply = await requestChatCompletion([
        {
          role: 'system',
          content: settings.systemPromptReply,
        },
        {
          role: 'user',
          content: userPrompt,
        },
      ]);

      ui.replyOutput.value = sanitizeText(reply);
      setStatus(`回复已生成（${preset.label}）。`);
    } catch (error) {
      setStatus(`生成回复失败：${error.message}`, true);
    }
  }

  function renderReplyPresetOptions() {
    return REPLY_PROMPT_PRESETS.map((preset) => `<option value="${preset.id}">${preset.label}</option>`).join('');
  }

  function resolveReplyPreset(presetId) {
    const pool = REPLY_PROMPT_PRESETS.filter((preset) => preset.id !== 'random');
    const fallback = pool[0] || {
      id: 'fallback',
      label: '默认',
      instruction: 'Write a natural Discord reply aligned with the context.',
    };
    const normalizedId = String(presetId || 'random').trim().toLowerCase();

    if (normalizedId === 'random') {
      let candidates = pool;
      if (lastReplyPresetId) {
        const withoutLast = pool.filter((preset) => preset.id !== lastReplyPresetId);
        if (withoutLast.length) {
          candidates = withoutLast;
        }
      }
      const picked = candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : fallback;
      lastReplyPresetId = picked.id;
      return picked;
    }

    const fixed = pool.find((preset) => preset.id === normalizedId) || fallback;
    lastReplyPresetId = fixed.id;
    return fixed;
  }

  async function requestChatCompletion(messages) {
    if (!settings.apiEndpoint || !settings.model) {
      throw new Error('缺少接口地址或模型');
    }

    const body = {
      model: settings.model,
      messages,
      temperature: settings.temperature,
      stream: false,
    };

    const headers = {
      'Content-Type': 'application/json',
    };

    if (settings.apiKey) {
      headers.Authorization = `Bearer ${settings.apiKey}`;
    }

    const response = await gmRequest({
      method: 'POST',
      url: settings.apiEndpoint,
      headers,
      data: JSON.stringify(body),
      timeout: 60000,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status}: ${response.responseText?.slice(0, 200) || 'unknown error'}`);
    }

    let payload = null;
    try {
      payload = JSON.parse(response.responseText);
    } catch (error) {
      throw new Error('接口返回的 JSON 无效');
    }

    const text = extractCompletionText(payload);
    if (!text) {
      throw new Error('模型返回为空');
    }

    return text;
  }

  function extractCompletionText(payload) {
    if (!payload || typeof payload !== 'object') {
      return '';
    }

    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;

    if (choice?.message?.content) {
      if (typeof choice.message.content === 'string') {
        return choice.message.content;
      }

      if (Array.isArray(choice.message.content)) {
        return choice.message.content
          .map((item) => {
            if (typeof item === 'string') {
              return item;
            }
            return item?.text || '';
          })
          .join('');
      }
    }

    if (typeof payload.output_text === 'string') {
      return payload.output_text;
    }

    return '';
  }

  function gmRequest(options) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        ...options,
        onload: (response) => resolve(response),
        onerror: () => reject(new Error('网络错误')),
        ontimeout: () => reject(new Error('请求超时')),
      });
    });
  }

  function attachTranslation(node, translatedText, fromCache) {
    const contentHost = node.querySelector('[id^="message-content-"]')?.parentElement || node;

    if (contentHost.querySelector(`.${TRANSLATION_CLASS}`)) {
      return;
    }

    const line = document.createElement('div');
    line.className = TRANSLATION_CLASS;
    line.textContent = normalizeTranslationText(translatedText);

    contentHost.appendChild(line);

    if (fromCache) {
      setStatus('已应用缓存翻译。');
    }
  }

  function buildCacheKey(channelId, messageId, language, model) {
    return `${channelId}:${messageId}:${language}:${model}`;
  }

  function getFromCache(key) {
    if (!cache.has(key)) {
      return '';
    }

    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    return value;
  }

  function setCache(key, value) {
    if (cache.has(key)) {
      cache.delete(key);
    }

    cache.set(key, value);
    trimCacheToLimit(cache, settings.maxCacheEntries);
    persistCacheSoon();
  }

  function insertReplyToComposer() {
    const text = sanitizeText(ui.replyOutput.value || '');
    if (!text) {
      setStatus('回复输出为空。', true);
      return;
    }

    const editor = findComposerEditor();
    if (!editor) {
      setStatus('未找到 Discord 输入框。', true);
      return;
    }

    try {
      editor.focus();
      selectEditorContents(editor);

      let inserted = tryPasteIntoEditor(editor, text);
      if (!inserted) {
        inserted = tryExecInsertText(editor, text);
      }

      if (!inserted && !editorContainsText(editor, text)) {
        throw new Error('写入失败');
      }

      setStatus('回复已写入输入框，可直接编辑和发送。');
    } catch (error) {
      setStatus('写入失败，请手动复制输出框内容。', true);
    }
  }

  function findComposerEditor() {
    const selectors = [
      'form div[role="textbox"][data-slate-editor="true"]',
      'div[class*="channelTextArea"] div[role="textbox"][data-slate-editor="true"]',
      'div[role="textbox"][data-slate-editor="true"]',
    ];

    const unique = new Set();
    const candidates = [];

    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        if (unique.has(node)) {
          continue;
        }
        unique.add(node);
        candidates.push(node);
      }
    }

    const visible = candidates.find((node) => isElementVisible(node));
    return visible || candidates[0] || null;
  }

  function isElementVisible(node) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }

    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function selectEditorContents(editor) {
    const selection = window.getSelection();
    if (!selection) {
      return;
    }

    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function tryPasteIntoEditor(editor, text) {
    try {
      if (typeof DataTransfer === 'undefined' || typeof ClipboardEvent === 'undefined') {
        return false;
      }

      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', text);

      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      });

      editor.dispatchEvent(pasteEvent);
      return editorContainsText(editor, text);
    } catch (error) {
      return false;
    }
  }

  function tryExecInsertText(editor, text) {
    if (!document.queryCommandSupported || !document.queryCommandSupported('insertText')) {
      return false;
    }

    const inserted = document.execCommand('insertText', false, text);
    return Boolean(inserted) || editorContainsText(editor, text);
  }

  function editorContainsText(editor, text) {
    const target = sanitizeText(text);
    if (!target) {
      return false;
    }

    const current = sanitizeText(editor.innerText || editor.textContent || '');
    return current.includes(target);
  }

  function makeDraggable(panel, handle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    handle.addEventListener('mousedown', (event) => {
      if (event.target.closest('button, input, select, textarea, label')) {
        return;
      }

      dragging = true;
      startX = event.clientX;
      startY = event.clientY;

      const rect = panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      panel.style.right = 'auto';
      panel.style.left = `${startLeft}px`;
      panel.style.top = `${startTop}px`;
      event.preventDefault();
    });

    document.addEventListener('mousemove', (event) => {
      if (!dragging) {
        return;
      }

      const dx = event.clientX - startX;
      const dy = event.clientY - startY;

      panel.style.left = `${Math.max(0, startLeft + dx)}px`;
      panel.style.top = `${Math.max(0, startTop + dy)}px`;
    });

    document.addEventListener('mouseup', () => {
      dragging = false;
    });
  }
})();
