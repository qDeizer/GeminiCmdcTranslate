/**
 * @file dashboard.mjs
 * @description Single-Page Dashboard UI for Command Code Bridge Configuration & Model Discovery.
 * 
 * DESIGN INVARIANTS:
 * 1. Zero External Dependencies: Pure HTML/CSS/vanilla JS served by Node.js stdlib.
 * 2. Visual Fidelity: Matches user mockup with Top Bar (API key + check, manual model add),
 *    two side-by-side sections for Claude & ChatGPT/Codex with direct launch buttons,
 *    and interactive Effort Mapping modal drawer with dynamic model-aware mapping.
 * 3. Real-time Model Discovery & Manual Entitlement: Queries Command Code upstream
 *    entitlements and allows manual model additions with persistence.
 * 4. Disk Persistence: Saves full configuration, per-model effortMap, and custom levels to config.json.
 */

export function getDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Gemini1 · Command Code Native Bridge Dashboard</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #131b2e;
      --card-inner: #1a233a;
      --border: #263352;
      --border-focus: #3b82f6;
      --text: #e2e8f0;
      --text-dim: #94a3b8;
      --text-bright: #ffffff;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --accent: #8b5cf6;
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      line-height: 1.5;
      padding: 24px;
      max-width: 1440px;
      margin: 0 auto;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 20px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .logo-badge {
      background: linear-gradient(135deg, #3b82f6, #8b5cf6);
      color: #fff;
      font-weight: 700;
      font-size: 13px;
      padding: 6px 12px;
      border-radius: 6px;
      letter-spacing: 0.5px;
    }
    h1 {
      font-size: 18px;
      color: var(--text-bright);
      font-weight: 600;
    }
    .header-status {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      padding: 5px 12px;
      border-radius: 20px;
      font-weight: 500;
      background: var(--card-bg);
      border: 1px solid var(--border);
      color: var(--text-dim);
    }
    .badge-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
    }

    /* TOP BAR MATCHING USER MOCKUP */
    .top-bar-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px 20px;
      margin-bottom: 24px;
    }
    .top-bar-grid {
      display: grid;
      grid-template-columns: 1.4fr 1.1fr auto;
      gap: 16px;
      align-items: end;
    }
    @media (max-width: 960px) {
      .top-bar-grid {
        grid-template-columns: 1fr;
      }
    }
    .field-label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-dim);
      margin-bottom: 6px;
    }
    .input-group {
      display: flex;
      gap: 8px;
      width: 100%;
    }
    input[type="text"], input[type="password"], select {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text-bright);
      padding: 10px 14px;
      border-radius: 6px;
      font-size: 13px;
      font-family: inherit;
      width: 100%;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    input:focus, select:focus {
      border-color: var(--border-focus);
      box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
    }
    button {
      background: var(--card-inner);
      border: 1px solid var(--border);
      color: var(--text-bright);
      padding: 10px 16px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.15s;
      white-space: nowrap;
    }
    button:hover {
      background: #253352;
      border-color: #3b82f6;
    }
    button.btn-primary {
      background: #2563eb;
      border-color: #3b82f6;
      color: #ffffff;
    }
    button.btn-primary:hover {
      background: #1d4ed8;
    }
    button.btn-success {
      background: #059669;
      border-color: #10b981;
      color: #ffffff;
    }
    button.btn-success:hover {
      background: #047857;
    }
    button.btn-effort {
      background: #1e1b4b;
      border: 1px solid #6366f1;
      color: #c7d2fe;
      padding: 6px 12px;
      font-size: 12px;
      border-radius: 4px;
    }
    button.btn-effort:hover {
      background: #312e81;
    }
    button.btn-effort.has-custom {
      background: #312e81;
      border-color: #a5b4fc;
      color: #ffffff;
      font-weight: 700;
    }
    button.btn-danger {
      color: var(--danger);
      background: transparent;
      border: 1px solid transparent;
      padding: 6px 10px;
      border-radius: 4px;
    }
    button.btn-danger:hover {
      background: rgba(239, 68, 68, 0.15);
      border-color: var(--danger);
    }

    /* TWO COLUMNS: CLAUDE (LEFT) & CHATGPT (RIGHT) */
    .sections-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      margin-bottom: 24px;
    }
    @media (max-width: 1024px) {
      .sections-grid {
        grid-template-columns: 1fr;
      }
    }
    .panel {
      background: var(--card-bg);
      border: 2px solid var(--border);
      border-radius: 10px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
    }
    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }
    .panel-title {
      font-size: 22px;
      font-weight: 800;
      color: var(--text-bright);
      text-transform: lowercase;
      letter-spacing: -0.5px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .panel-badge {
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 10px;
      background: rgba(59, 130, 246, 0.15);
      color: #93c5fd;
      font-weight: 500;
      text-transform: uppercase;
    }
    .table-container {
      flex: 1;
      margin-bottom: 16px;
    }
    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0 8px;
    }
    th {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-dim);
      padding: 4px 8px;
      text-align: left;
    }
    td {
      padding: 6px 8px;
      background: var(--card-inner);
      vertical-align: middle;
    }
    tr td:first-child {
      border-top-left-radius: 6px;
      border-bottom-left-radius: 6px;
    }
    tr td:last-child {
      border-top-right-radius: 6px;
      border-bottom-right-radius: 6px;
    }
    .row-alias {
      font-family: var(--font-mono);
      font-weight: 600;
    }
    .actions-cell {
      display: flex;
      align-items: center;
      gap: 6px;
      justify-content: flex-end;
    }

    /* EFFORT MODAL MATCHING SCREENSHOT EXACTLY */
    .modal-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(4px);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 20px;
    }
    .modal-card {
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 10px;
      width: 100%;
      max-width: 720px;
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.85);
      overflow: hidden;
      animation: modalFade 0.2s ease-out;
      max-height: 90vh;
      display: flex;
      flex-direction: column;
    }
    @keyframes modalFade {
      from { opacity: 0; transform: translateY(-10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .modal-header {
      background: #0b0f19;
      padding: 16px 20px;
      border-bottom: 1px solid #1e293b;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .modal-title {
      font-size: 15px;
      font-weight: 600;
      color: #f1f5f9;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .modal-body {
      padding: 20px;
      overflow-y: auto;
      flex: 1;
    }
    .effort-model-banner {
      background: #1e293b;
      border-radius: 6px;
      padding: 10px 14px;
      margin-bottom: 16px;
      font-size: 12px;
      color: #cbd5e1;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }
    .supported-pill {
      background: rgba(16, 185, 129, 0.15);
      color: #6ee7b7;
      padding: 2px 8px;
      border-radius: 4px;
      font-family: var(--font-mono);
      font-size: 11px;
    }
    .effort-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px 24px;
      margin-bottom: 20px;
    }
    @media (max-width: 600px) {
      .effort-grid {
        grid-template-columns: 1fr;
      }
    }
    .effort-item {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .effort-item label {
      font-size: 12px;
      color: #94a3b8;
      font-weight: 500;
    }
    .effort-select {
      background: #090d16;
      border: 1px solid #263352;
      color: #e2e8f0;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 13px;
    }
    .custom-effort-section {
      background: #0b1120;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 14px;
      margin-top: 10px;
    }
    .custom-effort-title {
      font-size: 12px;
      font-weight: 600;
      color: #93c5fd;
      margin-bottom: 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .custom-row {
      display: grid;
      grid-template-columns: 1fr 1fr auto;
      gap: 10px;
      align-items: center;
      margin-bottom: 8px;
    }
    .modal-footer {
      background: #0b0f19;
      padding: 14px 20px;
      border-top: 1px solid #1e293b;
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }

    /* TOAST */
    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #10b981;
      color: #ffffff;
      padding: 12px 20px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
      display: none;
      z-index: 2000;
      animation: fadeIn 0.3s;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .quickstart-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px 20px;
      margin-top: 24px;
    }
    .code-block {
      background: #060910;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 14px;
      font-family: var(--font-mono);
      font-size: 12px;
      color: #86efac;
      margin-top: 6px;
      overflow-x: auto;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="logo-badge">GEMINI1</div>
      <div>
        <h1>Command Code Native Bridge Dashboard</h1>
        <div style="font-size: 12px; color: var(--text-dim);">CLI 1.54.0 Protocol Gateway · Claude Desktop / Code CLI & ChatGPT Codex</div>
      </div>
    </div>
    <div class="header-status">
      <div class="badge">
        <div class="badge-dot"></div>
        <span id="server-status-text">Bridge Ready (127.0.0.1:8741)</span>
      </div>
      <div class="badge" id="models-count-badge">
        <span id="models-count-text">Katalog Hazır</span>
      </div>
    </div>
  </header>

  <!-- TOP BAR MATCHING MOCKUP: [ API KEY ] [ CHECK ] ... [ MANUEL MODEL EKLE ] [ + ] -->
  <div class="top-bar-card">
    <div class="top-bar-grid">
      <!-- Left: API Key + Check Button -->
      <div>
        <label class="field-label" for="apiKey">API key</label>
        <div class="input-group">
          <input type="password" id="apiKey" placeholder="user_... veya cc_..." autocomplete="off">
          <button type="button" id="toggleKeyBtn">Göster</button>
          <button type="button" class="btn-primary" id="discover-btn">check</button>
        </div>
      </div>

      <!-- Right: Manuel Model Ekle Input + Button -->
      <div>
        <label class="field-label" for="manualModelInput">manuel model ekle</label>
        <div class="input-group">
          <input type="text" id="manualModelInput" placeholder="örn: deepseek/deepseek-v4.1-flash">
          <button type="button" class="btn-primary" id="addManualModelBtn" title="manuel model ekle">+</button>
        </div>
      </div>

      <!-- Save Button -->
      <div>
        <button type="button" class="btn-success" id="saveTopBtn" style="height: 42px; width: 100%;">
          Ayarları Kaydet
        </button>
      </div>
    </div>
    <div id="discoveryStatus" style="font-size: 12px; color: var(--text-dim); margin-top: 10px;">
      API key girip <strong>check</strong> butonuna tıklayarak upstream modelleri doğrulayın veya manuel model ekleyin.
    </div>
  </div>

  <!-- SECTIONS: CLAUDE (LEFT) & CHATGPT (RIGHT) SIDE-BY-SIDE -->
  <div class="sections-grid">
    <!-- LEFT PANEL: CLAUDE -->
    <div class="panel">
      <div class="panel-header">
        <div class="panel-title">
          <span>claude</span>
          <span class="panel-badge">Anthropic Messages</span>
        </div>
        <button type="button" class="btn-primary" id="launchClaudeBtn" title="Claude Code'u yeni terminal penceresinde başlat">
          &#9658; Başlat
        </button>
      </div>

      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th style="width: 34%;">İstemci Model (Alias)</th>
              <th style="width: 44%;">Command Code Modeli</th>
              <th style="width: 22%; text-align: right;">İşlemler</th>
            </tr>
          </thead>
          <tbody id="claudeRowsTbody">
            <!-- Populated dynamically -->
          </tbody>
        </table>
      </div>

      <div>
        <button type="button" id="addClaudeRowBtn">+ Model Ekle</button>
      </div>
    </div>

    <!-- RIGHT PANEL: CHATGPT / CODEX -->
    <div class="panel">
      <div class="panel-header">
        <div class="panel-title">
          <span>chatgpt</span>
          <span class="panel-badge">Codex / Responses</span>
        </div>
        <button type="button" class="btn-primary" id="launchCodexBtn" title="Codex'i yeni terminal penceresinde başlat">
          &#9658; Başlat
        </button>
      </div>

      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th style="width: 34%;">İstemci Model (Alias)</th>
              <th style="width: 44%;">Command Code Modeli</th>
              <th style="width: 22%; text-align: right;">İşlemler</th>
            </tr>
          </thead>
          <tbody id="codexRowsTbody">
            <!-- Populated dynamically -->
          </tbody>
        </table>
      </div>

      <div>
        <button type="button" id="addCodexRowBtn">+ Model Ekle</button>
      </div>
    </div>
  </div>

  <!-- QUICKSTART CARDS -->
  <div class="quickstart-card">
    <div style="font-size: 14px; font-weight: 600; color: var(--text-bright); margin-bottom: 8px;">
      İstemci Bağlantı Ayarları
    </div>
    <p style="font-size: 12px; color: var(--text-dim); margin-bottom: 12px;">
      [Başlat] butonuna bastığınızda terminal otomatik açılır. Dilerseniz manuel olarak da şu değişkenlerle çalıştırabilirsiniz:
    </p>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
      <div>
        <span class="field-label">Claude Code CLI</span>
        <div class="code-block">set ANTHROPIC_BASE_URL=http://127.0.0.1:8741
claude</div>
      </div>
      <div>
        <span class="field-label">ChatGPT Codex / OpenAI API</span>
        <div class="code-block">set OPENAI_BASE_URL=http://127.0.0.1:8741/v1
codex</div>
      </div>
    </div>
  </div>

  <!-- EFFORT MAPPING MODAL (MATCHES MOCKUP SCREENSHOT) -->
  <div id="effortModal" class="modal-overlay">
    <div class="modal-card">
      <div class="modal-header">
        <div class="modal-title">
          <span>&#9660; İstemci effort &rarr; Command Code effort</span>
          <span id="effortModalSubTitle" style="font-size: 12px; color: #93c5fd; font-weight: normal;"></span>
        </div>
        <button type="button" class="btn-danger" id="closeEffortModalBtn" style="font-size: 18px; padding: 0 6px;">&times;</button>
      </div>

      <div class="modal-body">
        <div class="effort-model-banner">
          <div>
            Hedef Model: <strong id="modalTargetModelName" style="color: #fff;">deepseek/deepseek-v4.1-flash</strong>
          </div>
          <div id="modalSupportedEffortsContainer">
            Desteklenen: <span class="supported-pill" id="modalSupportedEffortsPill">low, high, max</span>
          </div>
        </div>

        <p style="font-size: 12px; color: #94a3b8; margin-bottom: 16px;">
          İstemciden gelen effort seviyesini Command Code üzerinde desteklenen seviyeye manuel olarak eşleyin:
        </p>

        <!-- 8-ITEM GRID MATCHING EXACT MOCKUP SCREENSHOT -->
        <div class="effort-grid">
          <!-- Sol Sütun (Left Column) -->
          <div style="display: flex; flex-direction: column; gap: 14px;">
            <div class="effort-item">
              <label for="effort_unspecified">Effort gelmezse</label>
              <select id="effort_unspecified" class="effort-select">
                <!-- Populated dynamically -->
              </select>
            </div>

            <div class="effort-item">
              <label for="effort_minimal">minimal</label>
              <select id="effort_minimal" class="effort-select">
                <!-- Populated dynamically -->
              </select>
            </div>

            <div class="effort-item">
              <label for="effort_medium">medium</label>
              <select id="effort_medium" class="effort-select">
                <!-- Populated dynamically -->
              </select>
            </div>

            <div class="effort-item">
              <label for="effort_xhigh">xhigh</label>
              <select id="effort_xhigh" class="effort-select">
                <!-- Populated dynamically -->
              </select>
            </div>
          </div>

          <!-- Sağ Sütun (Right Column) -->
          <div style="display: flex; flex-direction: column; gap: 14px;">
            <div class="effort-item">
              <label for="effort_none">none</label>
              <select id="effort_none" class="effort-select">
                <!-- Populated dynamically -->
              </select>
            </div>

            <div class="effort-item">
              <label for="effort_low">low</label>
              <select id="effort_low" class="effort-select">
                <!-- Populated dynamically -->
              </select>
            </div>

            <div class="effort-item">
              <label for="effort_high">high</label>
              <select id="effort_high" class="effort-select">
                <!-- Populated dynamically -->
              </select>
            </div>

            <div class="effort-item">
              <label for="effort_max">max</label>
              <select id="effort_max" class="effort-select">
                <!-- Populated dynamically -->
              </select>
            </div>
          </div>
        </div>

        <!-- CUSTOM CLIENT EFFORT LEVELS (E.G. ULTRACODE, CUSTOM BUDGETS) -->
        <div class="custom-effort-section">
          <div class="custom-effort-title">
            <span>Özel İstemci Effort Seviyeleri (örn: ultracode, custom)</span>
          </div>
          <div id="customEffortRowsContainer">
            <!-- Dynamic custom rows -->
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 10px; align-items: center; margin-top: 10px;">
            <input type="text" id="newCustomEffortKey" placeholder="İstemci effort adı (örn: ultracode)" style="padding: 8px 12px; font-size: 12px;">
            <select id="newCustomEffortVal" class="effort-select">
              <!-- Options populated dynamically -->
            </select>
            <button type="button" class="btn-primary" id="addCustomEffortBtn" style="padding: 8px 12px; font-size: 12px;">+ Seviye Ekle</button>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button type="button" id="cancelEffortModalBtn">Vazgeç</button>
        <button type="button" class="btn-primary" id="applyEffortModalBtn">Eşlemeyi Uygula</button>
      </div>
    </div>
  </div>

  <div id="toast" class="toast">Ayar kaydedildi!</div>

  <script>
    let currentConfig = {};
    let availableModels = [];
    let activeEffortRow = null;
    let currentModalCustomMap = {};

    // Elements
    const apiKeyInput = document.getElementById('apiKey');
    const toggleKeyBtn = document.getElementById('toggleKeyBtn');
    const checkBtn = document.getElementById('discover-btn');
    const manualModelInput = document.getElementById('manualModelInput');
    const addManualModelBtn = document.getElementById('addManualModelBtn');
    const saveTopBtn = document.getElementById('saveTopBtn');
    const discoveryStatus = document.getElementById('discoveryStatus');
    const modelsCountText = document.getElementById('models-count-text');

    const claudeRowsTbody = document.getElementById('claudeRowsTbody');
    const codexRowsTbody = document.getElementById('codexRowsTbody');
    const addClaudeRowBtn = document.getElementById('addClaudeRowBtn');
    const addCodexRowBtn = document.getElementById('addCodexRowBtn');
    const launchClaudeBtn = document.getElementById('launchClaudeBtn');
    const launchCodexBtn = document.getElementById('launchCodexBtn');

    // Effort Modal Elements
    const effortModal = document.getElementById('effortModal');
    const effortModalSubTitle = document.getElementById('effortModalSubTitle');
    const modalTargetModelName = document.getElementById('modalTargetModelName');
    const modalSupportedEffortsPill = document.getElementById('modalSupportedEffortsPill');
    const closeEffortModalBtn = document.getElementById('closeEffortModalBtn');
    const cancelEffortModalBtn = document.getElementById('cancelEffortModalBtn');
    const applyEffortModalBtn = document.getElementById('applyEffortModalBtn');
    const customEffortRowsContainer = document.getElementById('customEffortRowsContainer');
    const newCustomEffortKey = document.getElementById('newCustomEffortKey');
    const newCustomEffortVal = document.getElementById('newCustomEffortVal');
    const addCustomEffortBtn = document.getElementById('addCustomEffortBtn');
    const toast = document.getElementById('toast');

    function showToast(msg, isError = false) {
      toast.textContent = msg;
      toast.style.background = isError ? '#ef4444' : '#10b981';
      toast.style.display = 'block';
      setTimeout(() => { toast.style.display = 'none'; }, 3500);
    }

    toggleKeyBtn.addEventListener('click', () => {
      if (apiKeyInput.type === 'password') {
        apiKeyInput.type = 'text';
        toggleKeyBtn.textContent = 'Gizle';
      } else {
        apiKeyInput.type = 'password';
        toggleKeyBtn.textContent = 'Göster';
      }
    });

    // Manuel Model Ekle
    addManualModelBtn.addEventListener('click', async () => {
      const modelName = manualModelInput.value.trim();
      if (!modelName) {
        showToast('Lütfen bir model adı yazın.', true);
        return;
      }
      if (!availableModels.some(m => m.id === modelName)) {
        availableModels.unshift({
          id: modelName,
          name: modelName,
          efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          maxOutputTokens: 64000,
          supportsReasoning: true
        });
        updateAllSelects();
        showToast('Model eklendi: ' + modelName);
        manualModelInput.value = '';
        await saveAllConfig();
      } else {
        showToast('Model zaten listede mevcut.', true);
        manualModelInput.value = '';
      }
    });

    // Check & Discover Models
    checkBtn.addEventListener('click', () => {
      const key = apiKeyInput.value.trim();
      loadModels(key);
    });

    // Launch Claude
    launchClaudeBtn.addEventListener('click', async () => {
      launchClaudeBtn.disabled = true;
      launchClaudeBtn.textContent = 'Başlatılıyor...';
      try {
        const res = await fetch('/api/launch/claude', { method: 'POST' });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast('Claude Code terminal penceresinde başlatıldı!');
        } else {
          showToast('Başlatma hatası: ' + (data.error || 'Bilinmeyen hata'), true);
        }
      } catch (err) {
        showToast('Bağlantı hatası: ' + err.message, true);
      } finally {
        launchClaudeBtn.disabled = false;
        launchClaudeBtn.innerHTML = '&#9658; Başlat';
      }
    });

    // Launch Codex
    launchCodexBtn.addEventListener('click', async () => {
      launchCodexBtn.disabled = true;
      launchCodexBtn.textContent = 'Başlatılıyor...';
      try {
        const res = await fetch('/api/launch/codex', { method: 'POST' });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast('Codex terminal penceresinde başlatıldı!');
        } else {
          showToast('Başlatma hatası: ' + (data.error || 'Bilinmeyen hata'), true);
        }
      } catch (err) {
        showToast('Bağlantı hatası: ' + err.message, true);
      } finally {
        launchCodexBtn.disabled = false;
        launchCodexBtn.innerHTML = '&#9658; Başlat';
      }
    });

    // Load Configuration
    async function loadConfig() {
      try {
        const res = await fetch('/api/config');
        if (res.ok) {
          currentConfig = await res.json();
          if (currentConfig.apiKey) {
            apiKeyInput.value = currentConfig.apiKey;
          }
          renderTables();
        }
      } catch (err) {
        console.error('Config load error:', err);
      }
    }

    // Load Models from Upstream or Catalog
    async function loadModels(key) {
      discoveryStatus.textContent = 'Command Code modelleri kontrol ediliyor...';
      discoveryStatus.style.color = 'var(--primary)';
      try {
        const url = key ? '/api/upstream-models?apiKey=' + encodeURIComponent(key) : '/api/upstream-models';
        const res = await fetch(url);
        const data = await res.json();
        if (data.models && data.models.length > 0) {
          availableModels = data.models;
          const isLive = data.source === 'upstream';
          modelsCountText.textContent = availableModels.length + ' Model (' + (isLive ? 'Live API' : 'Katalog') + ')';
          discoveryStatus.textContent = isLive
            ? 'Command Code API doğrulandı! ' + availableModels.length + ' aktif model bulundu.'
            : 'Yerel katalog yüklendi (' + availableModels.length + ' Command Code modeli hazır).';
          discoveryStatus.style.color = isLive ? 'var(--success)' : 'var(--warning)';
          updateAllSelects();
        }
      } catch (err) {
        discoveryStatus.textContent = 'Model sorgulama hatası: ' + err.message;
        discoveryStatus.style.color = 'var(--danger)';
      }
    }

    function updateAllSelects() {
      document.querySelectorAll('.row-target').forEach(sel => {
        const currentVal = sel.value;
        const options = availableModels.map(m => {
          const selected = m.id === currentVal ? 'selected' : '';
          return '<option value="' + m.id + '" ' + selected + '>' + m.id + '</option>';
        }).join('');
        if (currentVal && !availableModels.some(m => m.id === currentVal)) {
          sel.innerHTML = '<option value="' + currentVal + '" selected>' + currentVal + '</option>' + options;
        } else {
          sel.innerHTML = options;
        }
      });
    }

    function createRow(category, alias = '', targetModel = 'deepseek/deepseek-v4.1-flash', effortMap = null) {
      const tr = document.createElement('tr');
      tr.dataset.category = category;
      tr.dataset.effortMap = JSON.stringify(effortMap || {
        unspecified: 'omit',
        none: 'reject',
        minimal: 'low',
        low: 'low',
        medium: 'high',
        high: 'high',
        xhigh: 'max',
        max: 'max'
      });

      const options = availableModels.map(m => {
        const selected = m.id === targetModel ? 'selected' : '';
        return '<option value="' + m.id + '" ' + selected + '>' + m.id + '</option>';
      }).join('');

      const hasCustom = Boolean(effortMap);

      tr.innerHTML = \`
        <td><input type="text" class="row-alias" value="\${alias}" placeholder="örn: \${category === 'claude' ? 'Opus-6' : 'luna'}"></td>
        <td>
          <select class="row-target">
            \${options || '<option value="' + targetModel + '">' + targetModel + '</option>'}
          </select>
        </td>
        <td>
          <div class="actions-cell">
            <button type="button" class="btn-effort \${hasCustom ? 'has-custom' : ''}">effort</button>
            <button type="button" class="btn-danger row-delete" title="Sil">&times;</button>
          </div>
        </td>
      \`;

      // Effort Button Click
      tr.querySelector('.btn-effort').addEventListener('click', () => {
        openEffortModal(tr);
      });

      // Delete Button Click
      tr.querySelector('.row-delete').addEventListener('click', () => {
        tr.remove();
        saveAllConfig();
      });

      return tr;
    }

    function renderTables() {
      claudeRowsTbody.innerHTML = '';
      codexRowsTbody.innerHTML = '';

      const models = currentConfig.models || {};
      const entries = Object.entries(models);

      let hasClaude = false;
      let hasCodex = false;

      entries.forEach(([alias, cfg]) => {
        if (alias === 'default') return; // internal fallback
        const cat = cfg.clientCategory || (alias.toLowerCase().includes('gpt') || alias.toLowerCase().includes('luna') || alias.toLowerCase().includes('terra') || alias.toLowerCase().includes('sol') || alias.toLowerCase().includes('codex') ? 'codex' : 'claude');
        if (cat === 'claude') {
          claudeRowsTbody.appendChild(createRow('claude', alias, cfg.upstream, cfg.effortMap));
          hasClaude = true;
        } else {
          codexRowsTbody.appendChild(createRow('codex', alias, cfg.upstream, cfg.effortMap));
          hasCodex = true;
        }
      });

      // Mock rows from user drawing if table empty
      if (!hasClaude) {
        claudeRowsTbody.appendChild(createRow('claude', 'Opus-6', 'deepseek/deepseek-v4.1-flash'));
        claudeRowsTbody.appendChild(createRow('claude', 'soonet-5', 'deepseek/deepseek-v4.1-flash'));
        claudeRowsTbody.appendChild(createRow('claude', 'fable5', 'z-ai/glm-5.3-flash'));
      }

      if (!hasCodex) {
        codexRowsTbody.appendChild(createRow('codex', 'luna', 'deepseek/deepseek-v4.1-flash'));
        codexRowsTbody.appendChild(createRow('codex', 'Terra', 'deepseek/deepseek-v4.1-flash'));
        codexRowsTbody.appendChild(createRow('codex', 'SoL', 'z-ai/glm-5.3-flash'));
      }
    }

    addClaudeRowBtn.addEventListener('click', () => {
      claudeRowsTbody.appendChild(createRow('claude', 'model-' + (claudeRowsTbody.children.length + 1), 'deepseek/deepseek-v4.1-flash'));
    });

    addCodexRowBtn.addEventListener('click', () => {
      codexRowsTbody.appendChild(createRow('codex', 'model-' + (codexRowsTbody.children.length + 1), 'deepseek/deepseek-v4.1-flash'));
    });

    // Generate option elements for an effort dropdown based on target model capabilities
    function buildEffortOptionsHtml(selectedValue, supportedEfforts = ['low', 'high', 'max']) {
      const allEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
      let html = '';
      html += '<option value="omit" ' + (selectedValue === 'omit' ? 'selected' : '') + '>Gönderme (model varsayılanı)</option>';
      html += '<option value="reject" ' + (selectedValue === 'reject' ? 'selected' : '') + '>Reddet (422)</option>';

      if (supportedEfforts && supportedEfforts.length > 0) {
        html += '<optgroup label="Modelin Desteklediği Seviyeler">';
        supportedEfforts.forEach(eff => {
          html += '<option value="' + eff + '" ' + (selectedValue === eff ? 'selected' : '') + '>' + eff + ' (destekli)</option>';
        });
        html += '</optgroup>';

        const otherEfforts = allEfforts.filter(e => !supportedEfforts.includes(e));
        if (otherEfforts.length > 0) {
          html += '<optgroup label="Diğer Standart Seviyeler">';
          otherEfforts.forEach(eff => {
            html += '<option value="' + eff + '" ' + (selectedValue === eff ? 'selected' : '') + '>' + eff + '</option>';
          });
          html += '</optgroup>';
        }
      } else {
        html += '<optgroup label="Standart Seviyeler">';
        allEfforts.forEach(eff => {
          html += '<option value="' + eff + '" ' + (selectedValue === eff ? 'selected' : '') + '>' + eff + '</option>';
        });
        html += '</optgroup>';
      }

      if (selectedValue && selectedValue !== 'omit' && selectedValue !== 'reject' && !allEfforts.includes(selectedValue)) {
        html += '<option value="' + selectedValue + '" selected>' + selectedValue + '</option>';
      }
      return html;
    }

    function renderCustomEffortRows(supportedEfforts) {
      customEffortRowsContainer.innerHTML = '';
      const entries = Object.entries(currentModalCustomMap);
      if (entries.length === 0) {
        customEffortRowsContainer.innerHTML = '<div style="font-size: 11px; color: #64748b; font-style: italic; margin-bottom: 8px;">Henüz özel effort seviyesi eklenmedi.</div>';
        return;
      }
      entries.forEach(([key, val]) => {
        const div = document.createElement('div');
        div.className = 'custom-row';
        div.innerHTML = \`
          <div style="font-size: 12px; font-family: var(--font-mono); color: #f1f5f9;">\${key}</div>
          <div>
            <select class="effort-select custom-row-val" data-key="\${key}">
              \${buildEffortOptionsHtml(val, supportedEfforts)}
            </select>
          </div>
          <div>
            <button type="button" class="btn-danger custom-row-del" title="Sil">&times;</button>
          </div>
        \`;
        div.querySelector('.custom-row-val').addEventListener('change', (e) => {
          currentModalCustomMap[key] = e.target.value;
        });
        div.querySelector('.custom-row-del').addEventListener('click', () => {
          delete currentModalCustomMap[key];
          renderCustomEffortRows(supportedEfforts);
        });
        customEffortRowsContainer.appendChild(div);
      });
    }

    // Effort Modal Logic
    function openEffortModal(rowTr) {
      activeEffortRow = rowTr;
      const category = rowTr.dataset.category || 'claude';
      const alias = rowTr.querySelector('.row-alias').value.trim() || 'Model';
      const targetModel = rowTr.querySelector('.row-target').value.trim();

      const modelInfo = availableModels.find(m => m.id === targetModel) || {
        efforts: targetModel.includes('deepseek') || targetModel.includes('glm') ? ['low', 'high', 'max'] : ['low', 'medium', 'high', 'xhigh']
      };
      const supportedEfforts = modelInfo.efforts || ['low', 'high', 'max'];

      effortModalSubTitle.textContent = '(' + (category === 'claude' ? 'Claude' : 'ChatGPT') + ': ' + alias + ')';
      modalTargetModelName.textContent = targetModel;
      modalSupportedEffortsPill.textContent = supportedEfforts.length > 0 ? supportedEfforts.join(', ') : 'Desteklenmiyor (sadece omit)';

      let currentMap = {};
      try {
        currentMap = JSON.parse(rowTr.dataset.effortMap || '{}');
      } catch {}

      // Populate standard 8 items with model-aware options
      const standardKeys = ['unspecified', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
      document.getElementById('effort_unspecified').innerHTML = buildEffortOptionsHtml(currentMap.unspecified || 'omit', supportedEfforts);
      document.getElementById('effort_none').innerHTML = buildEffortOptionsHtml(currentMap.none || 'reject', supportedEfforts);
      document.getElementById('effort_minimal').innerHTML = buildEffortOptionsHtml(currentMap.minimal || 'low', supportedEfforts);
      document.getElementById('effort_low').innerHTML = buildEffortOptionsHtml(currentMap.low || 'low', supportedEfforts);
      document.getElementById('effort_medium').innerHTML = buildEffortOptionsHtml(currentMap.medium || 'high', supportedEfforts);
      document.getElementById('effort_high').innerHTML = buildEffortOptionsHtml(currentMap.high || 'high', supportedEfforts);
      document.getElementById('effort_xhigh').innerHTML = buildEffortOptionsHtml(currentMap.xhigh || 'max', supportedEfforts);
      document.getElementById('effort_max').innerHTML = buildEffortOptionsHtml(currentMap.max || 'max', supportedEfforts);

      // Separate custom entries
      currentModalCustomMap = {};
      Object.entries(currentMap).forEach(([k, v]) => {
        if (!standardKeys.includes(k)) {
          currentModalCustomMap[k] = v;
        }
      });

      newCustomEffortVal.innerHTML = buildEffortOptionsHtml('max', supportedEfforts);
      renderCustomEffortRows(supportedEfforts);

      effortModal.style.display = 'flex';
    }

    // Add custom effort level in modal (e.g. ultracode)
    addCustomEffortBtn.addEventListener('click', () => {
      const key = newCustomEffortKey.value.trim().toLowerCase();
      const val = newCustomEffortVal.value;
      if (!key) {
        showToast('Lütfen özel seviye adı yazın (örn: ultracode).', true);
        return;
      }
      currentModalCustomMap[key] = val;
      newCustomEffortKey.value = '';
      const targetModel = activeEffortRow?.querySelector('.row-target')?.value?.trim() || '';
      const modelInfo = availableModels.find(m => m.id === targetModel);
      renderCustomEffortRows(modelInfo?.efforts || ['low', 'high', 'max']);
    });

    function closeEffortModal() {
      effortModal.style.display = 'none';
      activeEffortRow = null;
      currentModalCustomMap = {};
    }

    closeEffortModalBtn.addEventListener('click', closeEffortModal);
    cancelEffortModalBtn.addEventListener('click', closeEffortModal);

    applyEffortModalBtn.addEventListener('click', async () => {
      if (!activeEffortRow) return;
      const map = {
        unspecified: document.getElementById('effort_unspecified').value,
        none: document.getElementById('effort_none').value,
        minimal: document.getElementById('effort_minimal').value,
        low: document.getElementById('effort_low').value,
        medium: document.getElementById('effort_medium').value,
        high: document.getElementById('effort_high').value,
        xhigh: document.getElementById('effort_xhigh').value,
        max: document.getElementById('effort_max').value,
        ...currentModalCustomMap
      };
      activeEffortRow.dataset.effortMap = JSON.stringify(map);
      const effortBtn = activeEffortRow.querySelector('.btn-effort');
      effortBtn.classList.add('has-custom');
      closeEffortModal();
      showToast('Effort eşlemesi uygulandı ve kaydedildi.');
      await saveAllConfig();
    });

    // Save Configuration
    async function saveAllConfig() {
      const newModels = {};

      // Claude Rows
      claudeRowsTbody.querySelectorAll('tr').forEach(r => {
        const alias = r.querySelector('.row-alias').value.trim();
        const target = r.querySelector('.row-target').value.trim();
        let map = null;
        try { map = JSON.parse(r.dataset.effortMap); } catch {}
        if (alias) {
          newModels[alias] = {
            upstream: target,
            clientCategory: 'claude',
            defaultEffort: 'high',
            maxOutputTokens: 64000,
            effortMap: map,
            supportsImages: true,
            supportsTools: true,
            billsReasoningTokens: true,
            streamsReasoningText: false
          };
        }
      });

      // Codex Rows
      codexRowsTbody.querySelectorAll('tr').forEach(r => {
        const alias = r.querySelector('.row-alias').value.trim();
        const target = r.querySelector('.row-target').value.trim();
        let map = null;
        try { map = JSON.parse(r.dataset.effortMap); } catch {}
        if (alias) {
          newModels[alias] = {
            upstream: target,
            clientCategory: 'codex',
            defaultEffort: 'high',
            maxOutputTokens: 64000,
            effortMap: map,
            supportsImages: true,
            supportsTools: true,
            billsReasoningTokens: true,
            streamsReasoningText: false
          };
        }
      });

      const apiKey = apiKeyInput.value.trim();

      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            apiKey,
            models: newModels
          })
        });
        if (res.ok) {
          showToast('Tüm ayarlar kaydedildi ve aktif!');
        } else {
          showToast('Kaydetme hatası!', true);
        }
      } catch (err) {
        showToast('Ağ hatası: ' + err.message, true);
      }
    }

    saveTopBtn.addEventListener('click', saveAllConfig);

    // Initial boot
    (async () => {
      await loadConfig();
      await loadModels(apiKeyInput.value.trim());
    })();
  </script>
</body>
</html>`;
}
