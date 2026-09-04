export const controlPanelHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>GPT Repo MCP 控制面板</title>
<style>
:root{color-scheme:light}*{box-sizing:border-box}body{font-family:Segoe UI,Microsoft YaHei,Arial,sans-serif;margin:0;background:#f6f8fb;color:#111827}main{max-width:1180px;margin:0 auto;padding:28px}.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:18px;margin:16px 0;box-shadow:0 1px 2px rgba(15,23,42,.06)}h1{margin:0 0 8px;font-size:26px;color:#111827}h2{margin:0 0 14px;font-size:18px;color:#111827}.muted{color:#64748b}input,select{background:#fff;color:#111827;border:1px solid #cbd5e1;border-radius:8px;padding:10px;width:100%}label{display:block;font-size:13px;color:#1d4ed8;margin:0 0 6px}input[type="checkbox"]{width:auto}.checkline{display:flex;align-items:center;gap:8px;min-height:39px}.checkline label{margin:0;color:#111827}.grid{display:grid;grid-template-columns:2fr 120px 120px 120px;gap:12px;align-items:end}.port-grid{display:grid;grid-template-columns:1fr auto auto;gap:12px;align-items:end}.nowrap{white-space:nowrap}button{background:#2563eb;color:white;border:0;border-radius:8px;padding:10px 13px;cursor:pointer;white-space:nowrap}button.secondary{background:#e2e8f0;color:#0f172a}button.danger{background:#dc2626;color:white}button:disabled{cursor:not-allowed;opacity:.5}table{width:100%;border-collapse:collapse;font-size:14px;background:#fff}th,td{border-bottom:1px solid #e5e7eb;padding:12px;text-align:left;vertical-align:top}code{background:#f8fafc;border:1px solid #e2e8f0;border-radius:7px;padding:3px 6px;word-break:break-all;color:#0f172a}.ok{color:#16a34a}.warn{color:#d97706}.off{color:#dc2626}.row-actions{display:flex;gap:8px;flex-wrap:wrap}.funnel-control{display:flex;align-items:center;justify-content:space-between;gap:18px}.status-line{margin-top:5px;white-space:normal}.small{font-size:12px}.url{max-width:520px}.url-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.url-text{word-break:break-all;color:#0f172a}.code{max-width:280px}@media(max-width:900px){main{padding:16px}.grid,.port-grid{grid-template-columns:1fr}table{display:block;overflow:auto}}

main{max-width:1280px}.instance-table{table-layout:fixed;width:100%}.instance-table th,.instance-table td{overflow:hidden}.instance-table th:nth-child(1),.instance-table td:nth-child(1){width:14%}.instance-table th:nth-child(2),.instance-table td:nth-child(2){width:24%}.instance-table th:nth-child(3),.instance-table td:nth-child(3){width:7%;white-space:nowrap}.instance-table th:nth-child(4),.instance-table td:nth-child(4){width:35%}.instance-table th:nth-child(5),.instance-table td:nth-child(5){width:20%}.instance-table .repo-path{display:block;max-width:100%;white-space:normal;word-break:break-all;color:#0f172a}.instance-table .url-line{display:block}.instance-table .url-text{display:block;line-height:1.45;word-break:break-all}.instance-table .url-line .secondary{margin-top:8px;width:86px;padding:8px 10px}.instance-table .row-actions{display:flex;gap:8px;flex-wrap:wrap}.instance-table td:nth-child(5) .small{margin-top:8px;max-width:100%;word-break:break-all}.instance-table td:nth-child(1) b{white-space:nowrap}.secret{filter:blur(5px);transition:filter .15s ease;cursor:default}.secret:hover,.secret:focus{filter:none}.secret-inline{display:inline-block}.secret-block{display:block}
.mcp-test-grid{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:end;margin-bottom:14px}.mcp-test-call{grid-template-columns:minmax(0,1fr) auto;margin-top:14px}.mcp-test-grid .row-actions{align-items:end}textarea{width:100%;resize:vertical;background:#fff;color:#111827;border:1px solid #cbd5e1;border-radius:8px;padding:10px;font:13px/1.5 Consolas,monospace}.mcp-test-output{min-height:140px;max-height:420px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:#0f172a;color:#e2e8f0;border-radius:8px;padding:12px;font:13px/1.5 Consolas,monospace}@media(max-width:900px){.mcp-test-grid,.mcp-test-call{grid-template-columns:1fr}}
</style>
</head>
<body>
<main>
  <h1>GPT Repo MCP 控制面板</h1>
  <div id="state" class="muted">正在加载...</div>

  <section class="card">
    <div class="funnel-control">
      <div>
        <h2>Funnel 访问控制</h2>
        <div id="funnelStatus" class="muted">正在读取 Funnel 状态...</div>
      </div>
      <div class="row-actions">
        <button id="startFunnelBtn" type="button" onclick="startFunnel()">开启 Funnel</button>
        <button id="stopFunnelBtn" type="button" class="secondary" onclick="stopFunnel()">关闭 Funnel</button>
      </div>
    </div>
    <div class="muted small" style="margin-top:10px">关闭 Funnel 只会断开 ChatGPT 使用的公网入口，不会停止下面正在运行的 MCP 服务器。</div>
  </section>

  <section class="card">
    <h2>Node.js 端口监控</h2>
    <div class="muted small">仅显示 Node.js 进程监听的业务端口，8790 和 8800 已屏蔽，避免误触。</div>
    <div id="portsStatus" class="muted small" style="margin-top:10px">正在加载 Node.js 端口...</div>
    <table id="portTable" style="display:none">
      <thead><tr><th>端口</th><th>PID</th><th>进程</th><th>协议状态</th><th>地址</th><th>操作</th></tr></thead>
      <tbody id="portRows"></tbody>
    </table>
  </section>

  <section class="card">
    <h2>添加实例</h2>
    <div class="grid">
      <div><label for="repoPath">仓库路径</label><input id="repoPath" placeholder="D:\\projects\\your_project" /></div>
      <div><label for="repoMode">模式</label><select id="repoMode"><option value="read">只读</option><option value="write" selected>可写</option><option value="ship">发布</option></select></div>
      <div><label for="localPort">本地端口</label><input id="localPort" placeholder="自动" /></div>
      <div><button type="button" onclick="addInstance()">添加</button></div>
    </div>
  </section>

  <section class="card">
    <h2>实例列表</h2>
    <table class="instance-table">
      <thead><tr><th>状态</th><th>仓库</th><th>端口</th><th>URL</th><th>操作</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </section>

  <section class="card">
    <h2>本机 MCP 手动测试</h2>
    <p class="muted small">不经过 ChatGPT 或 Funnel，直接通过 127.0.0.1 对已启动实例完成 MCP 初始化、读取工具列表和工具调用。工具仍受实例的 read / write / ship 权限约束。</p>
    <div class="mcp-test-grid">
      <div><label for="mcpTestInstance">运行中的实例</label><select id="mcpTestInstance"></select></div>
      <div class="row-actions">
        <button id="mcpInitializeBtn" type="button" onclick="initializeMcpTest()">重新初始化</button>
        <button id="mcpListToolsBtn" type="button" class="secondary" onclick="listMcpTools()">读取工具</button>
      </div>
    </div>
    <div class="mcp-test-grid mcp-test-call">
      <div><label for="mcpToolName">工具</label><select id="mcpToolName"><option value="">请先读取工具列表</option></select></div>
      <div><button id="mcpCallToolBtn" type="button" onclick="callMcpTool()">调用工具</button></div>
    </div>
    <div><label for="mcpToolArguments">参数（JSON 对象）</label><textarea id="mcpToolArguments" rows="8" spellcheck="false">{}</textarea></div>
    <div id="mcpTestStatus" class="muted small" role="status" aria-live="polite">请选择一个已启动实例。</div>
    <pre id="mcpTestOutput" class="mcp-test-output" aria-label="MCP 响应">等待操作...</pre>
  </section>
</main>
<script>
async function api(path, options){
  options = options || {};
  var res = await fetch(path, Object.assign({ headers: { 'content-type': 'application/json' } }, options));
  var text = await res.text();
  var data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    var error = new Error(data.error || data.message || text || '请求失败');
    error.data = data;
    error.status = res.status;
    throw error;
  }
  return data;
}
function text(value){ return value == null ? '' : String(value); }
function setCell(row, value, className){
  var cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = text(value);
  row.appendChild(cell);
  return cell;
}
function makeCode(value){
  var code = document.createElement('code');
  code.textContent = text(value);
  return code;
}
function makeSecret(value, block){
  var span = document.createElement('span');
  span.className = block ? 'secret secret-block' : 'secret secret-inline';
  span.tabIndex = 0;
  span.textContent = text(value);
  return span;
}
function copyText(value){
  if (!value) return;
  var clip = navigator['clip' + 'board'];
  if (clip && clip['write' + 'Text']) clip['write' + 'Text'](value).catch(function(){});
}
function setStatus(message, isError){
  var stateEl = document.getElementById('state');
  stateEl.textContent = message;
  stateEl.className = isError ? 'off' : 'muted';
}
function setProxyStatus(data){
  var stateEl = document.getElementById('state');
  var funnelStarted = Boolean(data.proxy && data.proxy.funnelStarted);
  stateEl.replaceChildren();
  stateEl.className = 'muted';
  stateEl.appendChild(document.createTextNode('面板：'));
  stateEl.appendChild(makeSecret('http://' + data.panel.host + ':' + data.panel.port, false));
  stateEl.appendChild(document.createTextNode(' ｜ 本地代理：'));
  stateEl.appendChild(makeSecret('http://' + data.proxy.host + ':' + data.proxy.port, false));

  var funnelStatus = document.getElementById('funnelStatus');
  funnelStatus.textContent = funnelStarted
    ? 'Funnel 已开启，公网入口当前可用。'
    : 'Funnel 已关闭，公网 URL 当前不可访问。MCP 服务器可以继续在本机运行。';
  funnelStatus.className = funnelStarted ? 'ok' : 'warn';

  document.getElementById('startFunnelBtn').disabled = funnelStarted;
  document.getElementById('stopFunnelBtn').disabled = !funnelStarted;
}
function setPortsStatus(message, isError){
  var stateEl = document.getElementById('portsStatus');
  stateEl.textContent = message;
  stateEl.className = isError ? 'off small' : 'muted small';
}
function clearPorts(message){
  document.getElementById('portRows').replaceChildren();
  document.getElementById('portTable').style.display = 'none';
  setPortsStatus(message || 'Enter a port or range to query.', false);
}
function renderPorts(data){
  var rows = document.getElementById('portRows');
  rows.replaceChildren();
  document.getElementById('portTable').style.display = '';
  var items = data.ports || [];
  if (!items.length) {
    var row = document.createElement('tr');
    var cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'muted';
    cell.textContent = '没有发现 Node.js 业务端口。';
    row.appendChild(cell);
    rows.appendChild(row);
    return;
  }
  items.forEach(function(item){
    var row = document.createElement('tr');
    setCell(row, item.port, 'nowrap');
    setCell(row, item.pid || '未知', 'nowrap');
    setCell(row, item.processName || '未知');
    setCell(row, item.protocol + ' ' + item.state, 'nowrap');
    var addrCell = document.createElement('td');
    addrCell.appendChild(makeCode(item.localAddress));
    row.appendChild(addrCell);
    var actionCell = document.createElement('td');
    if (item.pid) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'danger';
      btn.dataset.pid = item.pid;
      btn.dataset.port = item.port;
      btn.textContent = '结束进程';
      actionCell.appendChild(btn);
    } else {
      actionCell.textContent = '无法获取 PID';
    }
    row.appendChild(actionCell);
    rows.appendChild(row);
  });
}
async function refreshPorts(){
  if (window.__portsRefreshInFlight) return;
  window.__portsRefreshInFlight = true;

  try {
    var data = await api('/api/node-ports');
    var ports = Array.isArray(data.ports) ? data.ports : [];
    var cacheLabel = data.cached ? '（缓存）' : '';

    setPortsStatus(
      '已检查到 ' + ports.length +
      ' 条 Node.js 端口记录' + cacheLabel +
      '，时间：' + (data.checkedAt || '未知时间') +
      '，平台：' + (data.platform || '未知平台') + '。',
      false
    );

    renderPorts(Object.assign({}, data, { ports: ports }));
  } catch (error) {
    setPortsStatus(
      'Node.js 端口刷新失败：' + (error && error.message ? error.message : error),
      true
    );
  } finally {
    window.__portsRefreshInFlight = false;
  }
}
async function killPortPid(pid, port){
  if (!confirm('确认结束占用端口 ' + port + ' 的 PID ' + pid + '？')) return;
  try {
    setPortsStatus('正在结束 PID ' + pid + ' ...', false);
    await api('/api/node-ports/' + encodeURIComponent(pid) + '/kill', { method: 'POST', body: JSON.stringify({ port: Number(port) }) });
    await refreshPorts();
  } catch (error) {
    try { await refreshPorts(); } catch {}
    setPortsStatus('结束进程失败：' + (error && error.message ? error.message : error), true);
  }
}
function renderRows(items){
  var rows = document.getElementById('rows');
  rows.replaceChildren();
  if (!items.length) {
    var row = document.createElement('tr');
    var cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'muted';
    cell.textContent = '还没有实例。';
    row.appendChild(cell);
    rows.appendChild(row);
    return;
  }
  items.forEach(function(item){
    var row = document.createElement('tr');

    var statusCell = document.createElement('td');
    var status = document.createElement('b');
    status.className = item.available ? 'ok' : (item.processRunning || item.funnelRunning ? 'warn' : 'off');
    status.textContent = item.available ? '连接可用' : '连接不可用';
    statusCell.appendChild(status);

    var mcpState = document.createElement('div');
    mcpState.className = (item.mcpReady ? 'ok' : (item.processRunning ? 'warn' : 'off')) + ' small status-line';
    mcpState.textContent = 'MCP：' + (item.mcpReady ? '已就绪' : (item.processRunning ? '启动中' : '已停止'));
    statusCell.appendChild(mcpState);

    var funnelState = document.createElement('div');
    funnelState.className = (item.funnelRunning ? 'ok' : 'warn') + ' small status-line';
    funnelState.textContent = 'Funnel：' + (item.funnelRunning ? '已开启' : '已关闭');
    statusCell.appendChild(funnelState);

    if (item.lastError) {
      var err = document.createElement('div');
      err.className = 'off small status-line';
      err.textContent = item.lastError;
      statusCell.appendChild(err);
    }
    row.appendChild(statusCell);

    var pathCell = document.createElement('td');
    var repoPath = document.createElement('span');
    repoPath.className = 'repo-path';
    repoPath.textContent = item.repoPath;
    pathCell.appendChild(repoPath);
    var id = document.createElement('div');
    id.className = 'muted small';
    id.textContent = item.id;
    pathCell.appendChild(id);
    row.appendChild(pathCell);

    setCell(row, item.localPort);

    var urlCell = document.createElement('td');
    urlCell.className = 'url';
    if (item.available && item.url) {
      var urlLine = document.createElement('div');
      urlLine.className = 'url-line';
      var urlText = document.createElement('span');
      urlText.className = 'url-text secret secret-block';
      urlText.textContent = item.url;
      var copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'secondary';
      copyBtn.textContent = '复制 URL';
      copyBtn.addEventListener('click', function(){ copyText(item.url); });
      urlLine.appendChild(urlText);
      urlLine.appendChild(copyBtn);
      urlCell.appendChild(urlLine);
    } else if (item.mcpRunning && !item.funnelRunning) {
      urlCell.textContent = 'Funnel 已关闭，公网 URL 当前已失效。';
    } else if (!item.mcpRunning && item.funnelRunning) {
      urlCell.textContent = 'Funnel 已开启，但 MCP 服务器未运行。';
    } else {
      urlCell.textContent = 'MCP 服务器和 Funnel 均未运行。';
    }
    row.appendChild(urlCell);

    var actionCell = document.createElement('td');
    var actions = document.createElement('div');
    actions.className = 'row-actions';
    [['start','启动',''], ['stop','停止','secondary'], ['remove','删除','danger']].forEach(function(spec){
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.action = spec[0];
      btn.dataset.id = item.id;
      btn.textContent = spec[1];
      if (spec[2]) btn.className = spec[2];
      actions.appendChild(btn);
    });
    actionCell.appendChild(actions);
    var log = document.createElement('div');
    log.className = 'muted small';
    log.textContent = '日志：' + text(item.logPath);
    actionCell.appendChild(log);
    row.appendChild(actionCell);

    rows.appendChild(row);
  });
}
async function refresh(){
  try {
    var data = await api('/api/state');
    var suggested = [data.panel && data.panel.port, data.proxy && data.proxy.port].concat((data.instances || []).map(function(item){ return item.localPort; }));
    window.__suggestedPorts = suggested.filter(function(port, index, all){ return port && all.indexOf(port) === index; });
    setProxyStatus(data);
    renderRows(data.instances || []);
    syncMcpTesterInstances(data.instances || []);
  } catch (error) {
    setStatus('刷新失败：' + (error && error.message ? error.message : error), true);
    document.getElementById('rows').replaceChildren();
  }
}
function setupRepoPathPicker(){
  var input = document.getElementById('repoPath');
  if (!input) return;
  input.placeholder = '请选择或粘贴本地项目路径';
  if (document.getElementById('chooseRepoFolderBtn')) return;

  var wrapper = document.createElement('div');
  wrapper.style.display = 'grid';
  wrapper.style.gridTemplateColumns = '1fr auto';
  wrapper.style.gap = '8px';
  wrapper.style.alignItems = 'center';

  var button = document.createElement('button');
  button.id = 'chooseRepoFolderBtn';
  button.type = 'button';
  button.className = 'secondary';
  button.textContent = '选择文件夹';
  button.style.height = '39px';
  button.addEventListener('click', chooseRepoFolder);

  input.parentNode.insertBefore(wrapper, input);
  wrapper.appendChild(input);
  wrapper.appendChild(button);
}

async function chooseRepoFolder(){
  try {
    setStatus('正在打开文件夹选择窗口 ...', false);
    var data = await api('/api/select-folder', { method: 'POST', body: '{}' });
    if (data && data.path) {
      document.getElementById('repoPath').value = data.path;
      setStatus('已选择仓库路径。', false);
      return;
    }
    setStatus('已取消选择文件夹。', false);
  } catch (error) {
    var message = error && error.message ? error.message : String(error);
    setStatus('选择文件夹失败：' + message, true);
    window.alert('选择文件夹失败：' + message + '\\n\\n可以手动复制文件夹路径到输入框。');
  }
}

var mcpTestToolMetadata = {};
function selectedMcpTestInstance(){
  return document.getElementById('mcpTestInstance').value;
}
function setMcpTestStatus(message, isError){
  var element = document.getElementById('mcpTestStatus');
  element.textContent = message;
  element.className = isError ? 'off small' : 'muted small';
}
function showMcpTestOutput(value){
  document.getElementById('mcpTestOutput').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
function setMcpTestBusy(busy){
  var hasInstance = Boolean(selectedMcpTestInstance());
  document.getElementById('mcpInitializeBtn').disabled = busy || !hasInstance;
  document.getElementById('mcpListToolsBtn').disabled = busy || !hasInstance;
  document.getElementById('mcpCallToolBtn').disabled = busy || !hasInstance || !document.getElementById('mcpToolName').value;
}
function syncMcpTesterInstances(items){
  var select = document.getElementById('mcpTestInstance');
  var previous = select.value;
  var running = items.filter(function(item){ return item.mcpRunning; });
  select.replaceChildren();
  running.forEach(function(item){
    var option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.repoPath + ' (' + item.localPort + ')';
    select.appendChild(option);
  });
  if (running.some(function(item){ return item.id === previous; })) select.value = previous;
  if (!running.length) {
    var empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '没有运行中的实例';
    select.appendChild(empty);
  }
  if (select.value !== previous) {
    renderMcpTools([]);
    setMcpTestStatus(select.value ? '请选择“读取工具”开始测试。' : '请选择一个已启动实例。', false);
  }
  setMcpTestBusy(false);
}
function renderMcpTools(tools){
  var items = Array.isArray(tools) ? tools : [];
  var select = document.getElementById('mcpToolName');
  mcpTestToolMetadata = {};
  select.replaceChildren();
  if (!items.length) {
    var empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '请先读取工具列表';
    select.appendChild(empty);
  } else {
    items.forEach(function(tool){
      mcpTestToolMetadata[tool.name] = tool;
      var option = document.createElement('option');
      option.value = tool.name;
      option.textContent = tool.name + (tool.annotations && tool.annotations.readOnlyHint ? '（只读）' : '');
      select.appendChild(option);
    });
  }
  setMcpTestBusy(false);
}
async function initializeMcpTest(){
  var id = selectedMcpTestInstance();
  if (!id) return;
  setMcpTestBusy(true);
  setMcpTestStatus('正在建立本机 MCP session ...', false);
  try {
    var data = await api('/api/mcp-test/' + encodeURIComponent(id) + '/initialize', { method: 'POST', body: '{}' });
    renderMcpTools([]);
    setMcpTestStatus('初始化成功。现在可以读取工具列表。', false);
    showMcpTestOutput(data);
  } catch (error) {
    setMcpTestStatus('初始化失败：' + (error && error.message ? error.message : error), true);
    showMcpTestOutput(error && error.data ? error.data : String(error));
  } finally {
    setMcpTestBusy(false);
  }
}
async function listMcpTools(){
  var id = selectedMcpTestInstance();
  if (!id) return;
  setMcpTestBusy(true);
  setMcpTestStatus('正在读取 MCP 工具列表 ...', false);
  try {
    var data = await api('/api/mcp-test/' + encodeURIComponent(id) + '/tools', { method: 'POST', body: '{}' });
    renderMcpTools(data.tools);
    setMcpTestStatus('已读取 ' + data.tools.length + ' 个工具。', false);
    showMcpTestOutput(data);
  } catch (error) {
    renderMcpTools([]);
    setMcpTestStatus('读取工具失败：' + (error && error.message ? error.message : error), true);
    showMcpTestOutput(error && error.data ? error.data : String(error));
  } finally {
    setMcpTestBusy(false);
  }
}
async function callMcpTool(){
  var id = selectedMcpTestInstance();
  var toolName = document.getElementById('mcpToolName').value;
  if (!id || !toolName) return;

  var args;
  try {
    args = JSON.parse(document.getElementById('mcpToolArguments').value || '{}');
    if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('参数必须是 JSON 对象。');
  } catch (error) {
    setMcpTestStatus('参数错误：' + (error && error.message ? error.message : error), true);
    return;
  }

  var tool = mcpTestToolMetadata[toolName];
  if (!(tool && tool.annotations && tool.annotations.readOnlyHint)) {
    if (!window.confirm('这是非只读工具，可能修改仓库或 Git 状态。确认调用 ' + toolName + '？')) return;
  }

  setMcpTestBusy(true);
  setMcpTestStatus('正在调用 ' + toolName + ' ...', false);
  try {
    var data = await api('/api/mcp-test/' + encodeURIComponent(id) + '/call', {
      method: 'POST',
      body: JSON.stringify({ toolName: toolName, arguments: args })
    });
    setMcpTestStatus('工具调用完成。', false);
    showMcpTestOutput(data);
  } catch (error) {
    setMcpTestStatus('工具调用失败：' + (error && error.message ? error.message : error), true);
    showMcpTestOutput(error && error.data ? error.data : String(error));
  } finally {
    setMcpTestBusy(false);
  }
}

async function startFunnel(){
  try {
    setStatus('正在开启 Funnel ...', false);
    await api('/api/funnel/start', { method: 'POST' });
    await refresh();
    setStatus('Funnel 已开启。', false);
  } catch (error) {
    try { await refresh(); } catch {}
    window.alert('开启 Funnel 失败：' + (error && error.message ? error.message : error));
    setStatus('开启 Funnel 失败：' + (error && error.message ? error.message : error), true);
  }
}

async function stopFunnel(){
  if (!confirm('确认关闭 Funnel？MCP 服务器会继续运行，但 ChatGPT 将无法通过公网 URL 访问它们。')) return;
  try {
    setStatus('正在关闭 Funnel ...', false);
    await api('/api/funnel/stop', { method: 'POST' });
    await refresh();
    setStatus('Funnel 已关闭，MCP 服务器仍保持原状态。', false);
  } catch (error) {
    try { await refresh(); } catch {}
    window.alert('关闭 Funnel 失败：' + (error && error.message ? error.message : error));
    setStatus('关闭 Funnel 失败：' + (error && error.message ? error.message : error), true);
  }
}

async function addInstance(){
  var body = {
    repoPath: document.getElementById('repoPath').value,
    repoMode: document.getElementById('repoMode').value,
    localPort: document.getElementById('localPort').value ? Number(document.getElementById('localPort').value) : undefined,
    disableToolGate: true
  };
  try {
    setStatus('正在保存实例配置 ...', false);
    await api('/api/instances', { method: 'POST', body: JSON.stringify(body) });
    document.getElementById('repoPath').value = '';
    document.getElementById('localPort').value = '';
    await refresh();
  } catch (error) {
    try { await refresh(); } catch {}
    setStatus('保存失败：' + (error && error.message ? error.message : error), true);
  }
}
async function startInstance(id){
  try {
    setStatus('正在启动实例 ' + id + ' ...', false);
    await api('/api/instances/' + encodeURIComponent(id) + '/start', { method: 'POST' });
    await refresh();
    await refreshPorts();
  } catch (error) {
    try { await refresh(); } catch {}
    window.alert('启动失败：' + (error && error.message ? error.message : error));
    setStatus('启动失败：' + (error && error.message ? error.message : error), true);
  }
}
async function stopInstance(id){
  try {
    setStatus('正在停止实例 ' + id + ' ...', false);
    await api('/api/instances/' + encodeURIComponent(id) + '/stop', { method: 'POST' });
    await refresh();
    await refreshPorts();
  } catch (error) {
    try { await refresh(); } catch {}
    setStatus('停止失败：' + (error && error.message ? error.message : error), true);
  }
}
async function removeInstance(id){
  if (!confirm('确认删除这个实例配置？')) return;
  try {
    setStatus('正在删除实例 ' + id + ' ...', false);
    await api('/api/instances/' + encodeURIComponent(id), { method: 'DELETE' });
    await refresh();
  } catch (error) {
    try { await refresh(); } catch {}
    setStatus('删除失败：' + (error && error.message ? error.message : error), true);
  }
}
document.getElementById('rows').addEventListener('click', function(event){
  var btn = event.target.closest('button[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'start') startInstance(btn.dataset.id);
  if (btn.dataset.action === 'stop') stopInstance(btn.dataset.id);
  if (btn.dataset.action === 'remove') removeInstance(btn.dataset.id);
});
document.getElementById('mcpTestInstance').addEventListener('change', function(){
  renderMcpTools([]);
  setMcpTestStatus(selectedMcpTestInstance() ? '实例已切换，请读取工具列表。' : '请选择一个已启动实例。', false);
});
document.getElementById('mcpToolName').addEventListener('change', function(){ setMcpTestBusy(false); });
document.getElementById('portRows').addEventListener('click', function(event){
  var btn = event.target.closest('button[data-pid][data-port]');
  if (!btn) return;
  killPortPid(btn.dataset.pid, btn.dataset.port);
});
window.addEventListener('error', function(event){
  setStatus('界面错误：' + event.message, true);
});
setupRepoPathPicker();
refresh();
refreshPorts();
setInterval(refresh, 3000);
setInterval(refreshPorts, 5000);
</script>
</body>
</html>`;
