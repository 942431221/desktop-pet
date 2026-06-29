const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { pathToFileURL } = require('url');

let petWindow;
let panelWindow;
let store;

const allowedExtensions = new Set(['.webp', '.webm', '.mp4', '.mov', '.gif']);
const aiSourceExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const PET_WINDOW_PADDING_X = 120;
const PET_WINDOW_PADDING_Y = 260;
const IMAGE_API_BASE_URL = 'https://aiflowlink.top';
const IMAGE_MODEL = 'gpt-image-2';

const personaPresets = [
  {
    key: 'laugh',
    label: '大笑',
    motion: 'laugh',
    prompt: '生成同一角色正在开怀大笑的拟人化形象，表情夸张开心，充满活力，适合作为桌面宠物互动素材。'
  }
];

function getPaths() {
  const root = app.getPath('userData');
  return {
    root,
    assets: path.join(root, 'assets'),
    config: path.join(root, 'config.json')
  };
}

function defaultStore() {
  return {
    selectedAssetId: null,
    assets: [],
    settings: {
      size: 220,
      position: null,
      onboardingShown: false,
      idleMessageInterval: 18000,
      idleMessages: [
        '要摸摸吗？',
        '我在这里陪你工作～',
        '记得休息一下，喝点水。',
        '今天也要开心呀！'
      ],
      clickResponses: [
        '嘿嘿，被你发现啦！',
        '我来啦！',
        '再点一下试试？',
        '你最好啦！'
      ],
      buttons: [
        { id: 'feed', label: '喂食', assetId: null, motion: 'none', responses: ['好吃！', '还想要一口～', '谢谢你！'] },
        { id: 'play', label: '玩耍', assetId: null, motion: 'none', responses: ['冲呀！', '球球在哪里？', '开心到转圈！'] },
        { id: 'sleep', label: '睡觉', assetId: null, motion: 'none', responses: ['晚安呼噜～', '让我趴一会儿。', '梦里也有骨头。'] }
      ]
    }
  };
}

function ensureStorage() {
  const paths = getPaths();
  fs.mkdirSync(paths.assets, { recursive: true });
  if (!fs.existsSync(paths.config)) {
    fs.writeFileSync(paths.config, JSON.stringify(defaultStore(), null, 2), 'utf8');
  }
}

function readStore() {
  ensureStorage();
  const paths = getPaths();
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
    store = normalizeStore(parsed);
  } catch (error) {
    store = defaultStore();
    writeStore();
  }
}

function normalizeStore(value) {
  const fallback = defaultStore();
  const normalized = {
    ...fallback,
    ...value,
    settings: {
      ...fallback.settings,
      ...(value && value.settings ? value.settings : {})
    }
  };

  normalized.assets = Array.isArray(normalized.assets) ? normalized.assets : [];
  normalized.settings.buttons = Array.isArray(normalized.settings.buttons) ? normalized.settings.buttons : fallback.settings.buttons;
  normalized.settings.buttons = normalized.settings.buttons.map((button) => ({
    id: button.id || `btn-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    label: button.label || '互动',
    assetId: normalized.assets.some((asset) => asset.id === button.assetId) ? button.assetId : null,
    motion: button.motion || 'none',
    responses: Array.isArray(button.responses) ? button.responses : []
  }));
  normalized.settings.idleMessages = Array.isArray(normalized.settings.idleMessages) ? normalized.settings.idleMessages : fallback.settings.idleMessages;
  normalized.settings.clickResponses = Array.isArray(normalized.settings.clickResponses) ? normalized.settings.clickResponses : fallback.settings.clickResponses;
  return normalized;
}

function writeStore() {
  const paths = getPaths();
  fs.writeFileSync(paths.config, JSON.stringify(store, null, 2), 'utf8');
}

function fileUrl(fileName) {
  if (!fileName) return null;
  return pathToFileURL(path.join(getPaths().assets, fileName)).toString();
}

function safeFileBase(value) {
  return (value || 'asset').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 50) || 'asset';
}

function createMultipartBody(fields, files) {
  const boundary = `----DesktopPet${Date.now()}${Math.random().toString(16).slice(2)}`;
  const chunks = [];

  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
    chunks.push(Buffer.from(String(value)));
    chunks.push(Buffer.from('\r\n'));
  }

  for (const file of files) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${file.name}"; filename="${file.fileName}"\r\n`));
    chunks.push(Buffer.from(`Content-Type: ${file.contentType}\r\n\r\n`));
    chunks.push(file.buffer);
    chunks.push(Buffer.from('\r\n'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(chunks) };
}

function requestImageEdit({ apiKey, sourcePath, prompt }) {
  const endpoint = new URL('/v1/images/edits', IMAGE_API_BASE_URL);
  const ext = path.extname(sourcePath).toLowerCase();
  const contentType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const { boundary, body } = createMultipartBody(
    {
      model: IMAGE_MODEL,
      prompt,
      background: 'transparent',
      output_format: 'png',
      size: '1024x1024'
    },
    [
      {
        name: 'image',
        fileName: path.basename(sourcePath),
        contentType,
        buffer: fs.readFileSync(sourcePath)
      }
    ]
  );

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        method: 'POST',
        hostname: endpoint.hostname,
        path: endpoint.pathname,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', async () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let payload;
          try {
            payload = JSON.parse(text);
          } catch (error) {
            reject(new Error(`图片生成接口返回无法解析：${text.slice(0, 180)}`));
            return;
          }

          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(payload.error ? payload.error.message : `图片生成失败：HTTP ${response.statusCode}`));
            return;
          }

          const item = payload.data && payload.data[0];
          if (item && item.b64_json) {
            resolve(Buffer.from(item.b64_json, 'base64'));
            return;
          }

          if (item && item.url) {
            try {
              const imageResponse = await fetch(item.url);
              const arrayBuffer = await imageResponse.arrayBuffer();
              resolve(Buffer.from(arrayBuffer));
            } catch (error) {
              reject(new Error(`下载生成图片失败：${error.message}`));
            }
            return;
          }

          reject(new Error('图片生成接口没有返回图片数据'));
        });
      }
    );

    request.on('error', (error) => reject(error));
    request.write(body);
    request.end();
  });
}

function upsertPersonaButton(label, assetId, motion = 'none') {
  const existing = store.settings.buttons.find((button) => button.label === label);
  const responses = {
    吃饭: ['好吃！', '再来一口～', '谢谢投喂！'],
    睡觉: ['困困了～', '让我睡一会儿。', '晚安。'],
    大笑: ['哈哈哈！', '太开心啦！', '笑到停不下来。'],
    淘气: ['嘿嘿，被发现了！', '才不是我干的～', '逗你玩！']
  };

  if (existing) {
    existing.assetId = assetId;
    existing.motion = motion;
    return;
  }

  store.settings.buttons.push({
    id: `btn-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    label,
    assetId,
    motion,
    responses: responses[label] || [`${label}！`]
  });
}

function publicState() {
  return {
    ...store,
    assets: store.assets.map((asset) => ({
      ...asset,
      url: fileUrl(asset.fileName),
      exists: fs.existsSync(path.join(getPaths().assets, asset.fileName))
    }))
  };
}

function broadcastState() {
  const state = publicState();
  for (const win of [petWindow, panelWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('state-changed', state);
    }
  }
}

function petWindowBounds(size) {
  const petSize = Math.max(80, Math.min(520, Number(size) || 220));
  return {
    width: Math.max(200, petSize + PET_WINDOW_PADDING_X),
    height: Math.max(320, petSize + PET_WINDOW_PADDING_Y)
  };
}

function clampPosition(position, bounds) {
  if (!position) return null;
  const display = screen.getDisplayNearestPoint(position);
  const area = display.workArea;
  const maxX = Math.max(area.x, area.x + area.width - bounds.width);
  const maxY = Math.max(area.y, area.y + area.height - bounds.height);
  return {
    x: Math.min(Math.max(position.x, area.x), maxX),
    y: Math.min(Math.max(position.y, area.y), maxY)
  };
}

function createPetWindow() {
  const size = Number(store.settings.size) || 220;
  const bounds = petWindowBounds(size);
  const position = clampPosition(store.settings.position, bounds);
  petWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: position ? position.x : undefined,
    y: position ? position.y : undefined,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  petWindow.setAlwaysOnTop(true, 'screen-saver');
  petWindow.loadFile(path.join(__dirname, 'pet.html'));
  petWindow.on('closed', () => {
    petWindow = null;
  });
}

function createPanelWindow() {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.show();
    panelWindow.focus();
    return;
  }

  panelWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 860,
    minHeight: 620,
    title: '桌面宠物控制面板',
    backgroundColor: '#f6f3ef',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  panelWindow.loadFile(path.join(__dirname, 'panel.html'));
  panelWindow.on('closed', () => {
    panelWindow = null;
  });
}

function resizePetWindow(size) {
  if (!petWindow || petWindow.isDestroyed()) return;
  const bounds = petWindowBounds(size);
  const [x, y] = petWindow.getPosition();
  const position = clampPosition({ x, y }, bounds);
  petWindow.setBounds({ ...bounds, ...(position || {}) });
}

function installIpc() {
  ipcMain.handle('get-state', () => publicState());

  ipcMain.handle('open-panel', () => {
    createPanelWindow();
    return true;
  });

  ipcMain.handle('show-assets-folder', async () => {
    ensureStorage();
    await shell.openPath(getPaths().assets);
    return true;
  });

  ipcMain.handle('generate-persona-assets', async (_event, options = {}) => {
    const apiKey = String(options.apiKey || process.env.OPENAI_API_KEY || '').trim();
    if (!apiKey) {
      throw new Error('请先填写 OpenAI API Key，或设置 OPENAI_API_KEY 环境变量。');
    }

    const result = await dialog.showOpenDialog(panelWindow || petWindow, {
      title: '选择用于拟人化的形象图片',
      properties: ['openFile'],
      filters: [{ name: '形象图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    });

    if (result.canceled || result.filePaths.length === 0) return publicState();

    const sourcePath = result.filePaths[0];
    const ext = path.extname(sourcePath).toLowerCase();
    if (!aiSourceExtensions.has(ext)) {
      throw new Error('请选择 png、jpg、jpeg 或 webp 图片。');
    }

    const paths = getPaths();
    const sourceName = safeFileBase(path.basename(sourcePath, ext));
    const generatedAssets = [];
    const stylePrompt = String(options.stylePrompt || '').trim();

    for (const preset of personaPresets) {
      const prompt = [
        '请基于用户上传的形象图片，生成同一个角色的拟人化桌面宠物素材。',
        '保留原形象最明显的颜色、轮廓、五官或标志性特征，不要变成完全不同的角色。',
        '单个完整角色，全身或近全身，主体居中，四周留白充足，适合透明悬浮桌宠窗口展示。',
        '输出必须是透明背景 PNG，背景区域必须为 Alpha 透明通道。',
        '只保留角色本体，不要任何背景、不要纯色底、不要白底、不要渐变底、不要场景、不要地面、不要阴影底板、不要文字、不要水印。',
        '请像抠图贴纸一样处理：角色边缘干净，角色外所有像素透明。',
        '风格可爱、干净、轻量。',
        preset.prompt,
        stylePrompt ? `额外风格要求：${stylePrompt}` : ''
      ].filter(Boolean).join('\n');

      const imageBuffer = await requestImageEdit({ apiKey, sourcePath, prompt });
      const id = `${Date.now()}-${preset.key}-${Math.random().toString(16).slice(2)}`;
      const fileName = `${id}-${sourceName}-${preset.key}.png`;
      fs.writeFileSync(path.join(paths.assets, fileName), imageBuffer);

      const asset = {
        id,
        name: `${sourceName}-${preset.label}.png`,
        fileName,
        type: 'image',
        ext: '.png',
        createdAt: new Date().toISOString(),
        generated: true,
        personaAction: preset.key
      };
      store.assets.unshift(asset);
      upsertPersonaButton(preset.label, id, preset.motion);
      generatedAssets.push(asset);

      if (!store.selectedAssetId) {
        store.selectedAssetId = id;
      }
    }

    writeStore();
    broadcastState();
    return { ...publicState(), generatedCount: generatedAssets.length };
  });

  ipcMain.handle('upload-assets', async () => {
    const result = await dialog.showOpenDialog(panelWindow || petWindow, {
      title: '选择宠物素材',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '宠物素材', extensions: ['webp', 'webm', 'mp4', 'mov', 'gif'] }]
    });

    if (result.canceled || result.filePaths.length === 0) return publicState();

    const paths = getPaths();
    const imported = [];
    for (const source of result.filePaths) {
      const ext = path.extname(source).toLowerCase();
      if (!allowedExtensions.has(ext)) continue;

      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const safeBase = path.basename(source, ext).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 50) || 'asset';
      const fileName = `${id}-${safeBase}${ext}`;
      fs.copyFileSync(source, path.join(paths.assets, fileName));

      const asset = {
        id,
        name: path.basename(source),
        fileName,
        type: ['.webm', '.mp4', '.mov'].includes(ext) ? 'video' : 'image',
        ext,
        createdAt: new Date().toISOString()
      };
      store.assets.unshift(asset);
      imported.push(asset);
    }

    if (imported.length > 0 && !store.selectedAssetId) {
      store.selectedAssetId = imported[0].id;
    }
    writeStore();
    broadcastState();
    return publicState();
  });

  ipcMain.handle('select-asset', (_event, id) => {
    if (id === null || store.assets.some((asset) => asset.id === id)) {
      store.selectedAssetId = id;
      writeStore();
      broadcastState();
    }
    return publicState();
  });

  ipcMain.handle('delete-asset', (_event, id) => {
    const asset = store.assets.find((item) => item.id === id);
    if (!asset) return publicState();

    const target = path.join(getPaths().assets, asset.fileName);
    if (fs.existsSync(target)) fs.unlinkSync(target);
    store.assets = store.assets.filter((item) => item.id !== id);
    store.settings.buttons = store.settings.buttons.map((button) => ({
      ...button,
      assetId: button.assetId === id ? null : button.assetId
    }));
    if (store.selectedAssetId === id) {
      store.selectedAssetId = store.assets[0] ? store.assets[0].id : null;
    }
    writeStore();
    broadcastState();
    return publicState();
  });

  ipcMain.handle('save-settings', (_event, nextSettings) => {
    store.settings = normalizeStore({ settings: { ...store.settings, ...nextSettings } }).settings;
    store.settings.size = Math.max(80, Math.min(520, Number(store.settings.size) || 220));
    writeStore();
    resizePetWindow(store.settings.size);
    broadcastState();
    return publicState();
  });

  ipcMain.handle('pet-drag', (_event, delta) => {
    if (!petWindow || petWindow.isDestroyed()) return false;
    const [x, y] = petWindow.getPosition();
    petWindow.setPosition(Math.round(x + delta.dx), Math.round(y + delta.dy));
    return true;
  });

  ipcMain.handle('save-pet-position', () => {
    if (!petWindow || petWindow.isDestroyed()) return false;
    const [x, y] = petWindow.getPosition();
    store.settings.position = { x, y };
    writeStore();
    broadcastState();
    return true;
  });

  ipcMain.handle('mark-onboarding-shown', () => {
    store.settings.onboardingShown = true;
    writeStore();
    broadcastState();
    return publicState();
  });
}

app.whenReady().then(() => {
  readStore();
  installIpc();
  createPetWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createPetWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
