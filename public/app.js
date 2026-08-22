// CloudObjectIQ Enterprise Frontend Logic

// ── Web Crypto & randomUUID Polyfill ─────────────────────────
(function () {
    try {
        if (typeof window !== 'undefined') {
            if (!window.crypto) {
                window.crypto = window.msCrypto || {};
            }
            if (!window.crypto.getRandomValues) {
                window.crypto.getRandomValues = function (arr) {
                    for (let i = 0; i < arr.length; i++) {
                        arr[i] = Math.floor(Math.random() * 256);
                    }
                    return arr;
                };
            }
            if (!window.crypto.randomUUID) {
                window.crypto.randomUUID = function () {
                    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
                        const r = (Math.random() * 16) | 0;
                        const v = c === 'x' ? r : (r & 0x3) | 0x8;
                        return v.toString(16);
                    });
                };
            }
            if (typeof globalThis !== 'undefined' && !globalThis.crypto) {
                globalThis.crypto = window.crypto;
            }
        }
    } catch (e) {
        console.warn('Crypto polyfill initialization warning:', e);
    }
})();

// --- OAuth Interceptor ---
const _urlParams = new URLSearchParams(window.location.search);
if (_urlParams.get('token')) {
    localStorage.setItem('ciq_token', _urlParams.get('token'));
    fetch('/api/auth/me', { headers: { 'Authorization': `Bearer ${_urlParams.get('token')}` } })
        .then(r => r.json())
        .then(d => {
            if (d.success) localStorage.setItem('ciq_user', JSON.stringify(d.user));
            window.location.href = '/';
        });
}
if (_urlParams.get('error')) {
    setTimeout(() => alert('OAuth Login Failed: ' + _urlParams.get('error').replace(/_/g, ' ')), 500);
}
// -------------------------
let _token = null;
let _user = null;
let _targets = [];
let _activeTargetId = null;
let _allFiles = [];
let _activeTypeFilter = 'all';
let _currentSchema = [];
let chartInstance = null;
let _pinnedItems = [];

let _currentResultData = [];
let _filteredData = [];
let _activeSlicers = {};

// Restore notebooks from localStorage
const _savedNotebooks = localStorage.getItem('ciq_notebooks');
const _savedTabIdx    = parseInt(localStorage.getItem('ciq_activeTabIdx') || '0', 10);
let _notebooks = _savedNotebooks ? JSON.parse(_savedNotebooks) : [{ id: 'tab_main', name: 'Main Query', sql: '', results: null }];
let _activeTabIdx = (!isNaN(_savedTabIdx) && _savedTabIdx < _notebooks.length) ? _savedTabIdx : 0;

function saveNotebooks() {
    const toSave = _notebooks.map(t => ({ id: t.id, name: t.name, sql: t.sql || '' }));
    localStorage.setItem('ciq_notebooks', JSON.stringify(toSave));
    localStorage.setItem('ciq_activeTabIdx', String(_activeTabIdx));
}

// ── Global Status / Notification Engine ───────────────────────
window.showStatus = (msg, type = 'info') => {
    console.log(`[Status] ${type}: ${msg}`);
    const container = document.getElementById('status-notifications') || createStatusContainer();
    const el = document.createElement('div');
    el.className = `status-toast ${type}`;
    el.style.cssText = `
        padding: 12px 20px;
        margin-bottom: 10px;
        border-radius: 8px;
        background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6'};
        color: white;
        font-size: 0.85rem;
        font-weight: 600;
        box-shadow: 0 10px 25px rgba(0,0,0,0.3);
        animation: toast-in 0.3s ease-out;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 15px;
    `;
    el.innerHTML = `<span>${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'} ${msg}</span>`;
    container.appendChild(el);
    setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(-20px)';
        el.style.transition = '0.5s';
        setTimeout(() => el.remove(), 500);
    }, 4000);
};

function createStatusContainer() {
    const div = document.createElement('div');
    div.id = 'status-notifications';
    div.style.cssText = 'position:fixed; top:20px; right:20px; z-index:100000; display:flex; flex-direction:column; align-items:flex-end;';
    document.body.appendChild(div);
    return div;
}

window.onload = () => {
    const savedToken = localStorage.getItem('ciq_token');
    const savedUser  = localStorage.getItem('ciq_user');

    if (savedToken && savedUser) {
        _token = savedToken;
        _user  = JSON.parse(savedUser);
        
        document.getElementById('login-overlay').style.display = 'none';
        document.getElementById('app-container').style.display = 'block';
        document.getElementById('user-profile').innerText = `👤 ${_user.email}`;
        
        if (_user.role === 'admin') renderAdminButton();
        
        loadTargets();
        renderNotebookTabs();

        const editor = document.getElementById('query-editor');
        if (editor) {
            editor.addEventListener('input', () => {
                if (_notebooks[_activeTabIdx]) {
                    _notebooks[_activeTabIdx].sql = editor.value;
                    saveNotebooks();
                }
            });
        }
    } else {
        document.getElementById('login-overlay').style.display = 'flex';
    }
};

window.renderNotebookTabs = () => {
    const container = document.getElementById('notebook-tabs');
    const editor = document.getElementById('query-editor');
    container.innerHTML = '';
    
    _notebooks.forEach((tab, idx) => {
        const btn = document.createElement('button');
        btn.className = `notebook-tab ${idx === _activeTabIdx ? 'active' : ''}`;
        btn.innerHTML = `<span>📑</span> ${tab.name} ${idx > 0 ? `<small onclick="closeTab(${idx}, event)" style="margin-left:8px; opacity:0.6;">✕</small>` : ''}`;
        btn.onclick = () => switchToTab(idx);
        container.appendChild(btn);
    });
    
    const addBtn = document.createElement('button');
    addBtn.className = 'notebook-tab';
    addBtn.style.background = 'rgba(16,185,129,0.1)';
    addBtn.style.color = '#10b981';
    addBtn.innerText = '+ New';
    addBtn.onclick = addNotebookTab;
    container.appendChild(addBtn);

    if (_notebooks[_activeTabIdx]) editor.value = _notebooks[_activeTabIdx].sql;
};

window.addNotebookTab = () => {
    _notebooks.push({ id: `tab_${Date.now()}`, name: `Query ${_notebooks.length}`, sql: '', results: null });
    _activeTabIdx = _notebooks.length - 1;
    saveNotebooks();
    renderNotebookTabs();
};

window.switchToTab = (idx) => {
    _notebooks[_activeTabIdx].sql = document.getElementById('query-editor').value;
    saveNotebooks();
    _activeTabIdx = idx;
    saveNotebooks();
    renderNotebookTabs();
    if (_notebooks[idx].results) renderResults(_notebooks[idx].results, false);
};

window.closeTab = (idx, e) => {
    if (e) e.stopPropagation();
    _notebooks.splice(idx, 1);
    if (_activeTabIdx >= _notebooks.length) _activeTabIdx = _notebooks.length - 1;
    saveNotebooks();
    renderNotebookTabs();
};

function renderAdminButton() {
    const container = document.getElementById('admin-btn-container');
    if (!container || document.getElementById('admin-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'admin-btn';
    btn.className = 'settings-btn';
    btn.innerText = '🛡️ Admin Center';
    btn.onclick = () => {
        document.getElementById('admin-overlay').style.display = 'flex';
        showAdminTab('users');
    };
    container.appendChild(btn);
}

window.showAdminTab = async function(tab) {
    const container = document.getElementById('admin-content');
    container.innerHTML = '<div style="padding:40px; text-align:center; color:var(--text-muted);">⌛ Loading enterprise data...</div>';
    
    try {
        if (tab === 'users') {
            const data = await apiFetch('/api/admin/users');
            if (data.success) {
                window._adminUsers = data.users;
                container.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                        <h3 style="margin:0;">User Management</h3>
                        <p style="font-size:0.75rem; color:var(--text-muted);">Configure enterprise access and system roles.</p>
                    </div>

                    <!-- ➕ User Creation Form -->
                    <div style="background:var(--glass-heavy); border:1px solid var(--border); padding:20px; border-radius:12px; margin-bottom:25px; box-shadow: 0 10px 30px rgba(0,0,0,0.2);">
                        <h4 style="margin:0 0 15px 0; font-size:0.85rem; color:var(--text);">Create New Platform User</h4>
                        <div style="display:flex; gap:12px;">
                            <input type="email" id="new-user-email" placeholder="Corporate Email" class="cfg-input" style="flex:1;">
                            <input type="password" id="new-user-pass" placeholder="Secure Password" class="cfg-input" style="flex:1;">
                            <select id="new-user-role" class="cfg-input" style="width:130px;">
                                <option value="viewer">Viewer</option>
                                <option value="editor">Editor</option>
                                <option value="admin">Admin</option>
                            </select>
                            <button class="btn btn-primary" onclick="window.createNewUser()" style="padding:0 25px; font-size:0.75rem;">Create User</button>
                        </div>
                    </div>

                    <table class="dashboard-table">
                        <thead><tr><th>Email</th><th>Role</th><th>Actions</th></tr></thead>
                        <tbody>${data.users.map(u => `
                            <tr>
                                <td>${u.email}</td>
                                <td>
                                    <select id="role-sel-${u.user_id}" class="ghost-btn" style="background:rgba(0,0,0,0.3); padding:4px 8px;">
                                        <option value="viewer" ${u.role==='viewer'?'selected':''}>Viewer</option>
                                        <option value="editor" ${u.role==='editor'?'selected':''}>Editor</option>
                                        <option value="admin" ${u.role==='admin'?'selected':''}>Admin</option>
                                    </select>
                                </td>
                                 <td>
                                    <button class="ghost-btn" onclick="window.saveUserRole('${u.user_id}')">Update</button>
                                    <button class="ghost-btn" onclick="window.deleteUser('${u.user_id}')">Delete</button>
                                 </td>
                             </tr>`).join('')}
                        </tbody>
                    </table>`;
            } else { container.innerHTML = `<div style="color:var(--error); padding:20px;">Error: ${data.error}</div>`; }
        } else if (tab === 'targets') {
            const data = await apiFetch('/api/admin/targets');
            if (data.success) {
                container.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                        <h3 style="margin:0;">Cloud Targets</h3>
                        <button class="btn btn-primary" onclick="window.openTargetEditor()" style="font-size:0.75rem;">➕ New Target</button>
                    </div>
                    <table class="dashboard-table">
                        <thead><tr><th>Name</th><th>Provider</th><th>Bucket</th><th>Actions</th></tr></thead>
                        <tbody>${data.targets.map(t => `
                            <tr>
                                <td>${t.target_name}</td>
                                <td>${t.provider_type}</td>
                                <td>${t.bucket}</td>
                                <td>
                                    <button class="ghost-btn" style="padding:2px 8px; font-size:0.65rem;" onclick="window.openTargetEditor('${t.target_id}')">Edit</button>
                                    <button class="ghost-btn" style="padding:2px 8px; font-size:0.65rem;" onclick="window.deleteTarget('${t.target_id}')">Del</button>
                                </td>
                            </tr>`).join('')}
                        </tbody>
                    </table>`;
            } else { container.innerHTML = `<div style="color:var(--error); padding:20px;">Error: ${data.error}</div>`; }
        } else if (tab === 'perms') {
             const data = await apiFetch('/api/admin/permissions');
             if (data.success) {
                container.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                        <h3 style="margin:0;">Access Control Matrix</h3>
                        <p style="font-size:0.7rem; color:var(--text-muted);">Manage granular permissions for each user and cloud target.</p>
                    </div>
                    <table class="dashboard-table">
                        <thead><tr><th>User</th><th>Target</th><th>Read</th><th>Write</th><th>Delete</th><th>Action</th></tr></thead>
                        <tbody>${data.permissions.map(p => `
                            <tr id="perm-row-${p.user_id}-${p.target_id}">
                                <td>${p.email}</td>
                                <td>${p.target_name}</td>
                                <td><input type="checkbox" ${p.can_read ? 'checked' : ''} class="perm-chk" data-type="read"></td>
                                <td><input type="checkbox" ${p.can_write ? 'checked' : ''} class="perm-chk" data-type="write"></td>
                                <td><input type="checkbox" ${p.can_delete ? 'checked' : ''} class="perm-chk" data-type="delete"></td>
                                <td><button class="ghost-btn" style="padding:2px 10px; font-size:0.65rem;" onclick="window.savePermission('${p.user_id}', '${p.target_id}')">Update</button></td>
                            </tr>`).join('')}
                        </tbody>
                    </table>`;
            }
        } else if (tab === 'catalog') {
            const data = await apiFetch('/api/admin/catalog');
            if (data.success) {
                container.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                        <h3 style="margin:0;">Metadata Catalog</h3>
                        <div style="display:flex; gap:10px;">
                            <select id="catalog-target-scan" class="ghost-btn" style="background:rgba(255,255,255,0.05); padding:8px 12px; border-radius:8px;">
                                <option value="">Select Target to Scan</option>
                                ${_targets.map(t => `<option value="${t.target_id}">${t.target_name}</option>`).join('')}
                            </select>
                            <button class="btn btn-primary" onclick="window.startMetadataScan()" id="scan-btn" style="font-size:0.75rem;">🔍 Start Deep Scan</button>
                        </div>
                    </div>
                    <p style="font-size:0.75rem; color:var(--text-muted); margin-bottom:20px;">Aggregated metadata from across all attached cloud lakes. Searchable and ready for discovery.</p>
                    
                    <table class="dashboard-table">
                        <thead><tr><th>Source Target</th><th>Object Path</th><th>Format</th><th>Size</th><th>Schema</th></tr></thead>
                        <tbody>${data.catalog.length === 0 ? '<tr><td colspan="5" style="text-align:center; padding:30px;">No metadata cataloged yet. Start a scan above.</td></tr>' : data.catalog.map(c => `
                            <tr>
                                <td style="color:#818cf8; font-weight:700;">${c.target_name}</td>
                                <td>${c.file_path}</td>
                                <td><span style="background:rgba(255,255,255,0.05); padding:2px 6px; border-radius:4px; font-size:0.6rem;">${c.format}</span></td>
                                <td>${(c.file_size / 1024).toFixed(1)} KB</td>
                                <td>${c.schema_json ? '✅ Ready' : '<span style="opacity:0.5;">-</span>'}</td>
                            </tr>`).join('')}
                        </tbody>
                    </table>`;
            } else { container.innerHTML = `<div style="color:var(--error); padding:20px;">Error: ${data.error}</div>`; }
        } else if (tab === 'analytics') {
            const data = await apiFetch('/api/admin/logs');
            if (data.success) {
                container.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                        <h3 style="margin:0;">📊 Log Analytics (Security & Performance)</h3>
                        <p style="font-size:0.75rem; color:var(--text-muted);">Real-time monitoring of data egress, query costs, and enterprise access patterns.</p>
                    </div>

                    <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:20px; margin-bottom:25px;">
                        <div style="background:var(--glass-heavy); padding:15px; border-radius:12px; border:1px solid var(--border); text-align:center;">
                            <p style="margin:0; font-size:0.7rem; color:var(--text-muted); text-transform:uppercase;">Total Managed Egress</p>
                            <h2 style="margin:5px 0 0;">${(data.logs.reduce((acc, l) => acc + (l.data_scanned_bytes || 0), 0) / (1024 * 1024)).toFixed(1)} MB</h2>
                        </div>
                        <div style="background:var(--glass-heavy); padding:15px; border-radius:12px; border:1px solid var(--border); text-align:center;">
                            <p style="margin:0; font-size:0.7rem; color:var(--text-muted); text-transform:uppercase;">Estimated Cloud Cost</p>
                            <h2 style="margin:5px 0 0; color:#fbbf24;">$${data.logs.reduce((acc, l) => acc + (l.calculated_cost_usd || 0), 0).toFixed(4)}</h2>
                        </div>
                        <div style="background:var(--glass-heavy); padding:15px; border-radius:12px; border:1px solid var(--border); text-align:center;">
                            <p style="margin:0; font-size:0.7rem; color:var(--text-muted); text-transform:uppercase;">Enterprise Query Count</p>
                            <h2 style="margin:5px 0 0; color:var(--accent);">${data.logs.length}</h2>
                        </div>
                    </div>

                    <table class="dashboard-table">
                        <thead><tr><th>Timestamp</th><th>User</th><th>Target</th><th>Status</th><th>Scan Price</th><th>SQL Preview</th></tr></thead>
                        <tbody>${data.logs.map(l => `
                            <tr>
                                <td style="font-size:0.6rem;">${new Date(l.timestamp).toLocaleString()}</td>
                                <td style="font-weight:700;">${l.email || 'System'}</td>
                                <td>${l.target_name || '-'}</td>
                                <td><span style="color:${l.status === 'success' ? '#10b981' : '#ef4444'}">${l.status}</span></td>
                                <td style="color:#fbbf24;">$${(l.calculated_cost_usd || 0).toFixed(6)}</td>
                                <td style="font-family:monospace; font-size:0.6rem; opacity:0.8;" title="${l.query_text}">${l.query_text.substring(0, 40)}...</td>
                            </tr>`).join('')}
                        </tbody>
                    </table>`;
            } else { container.innerHTML = `<div style="color:var(--error); padding:20px;">Error: ${data.error}</div>`; }
        } else if (tab === 'spark') {
            container.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                    <h3 style="margin:0;">✨ Spark Jobs (On-Prem / Cloud)</h3>
                    <p style="font-size:0.75rem; color:var(--text-muted);">Securely submit distributed compute jobs to Spark or Hadoop YARN clusters.</p>
                </div>

                <div style="background:var(--glass-heavy); border:1px solid var(--border); padding:25px; border-radius:15px; box-shadow: 0 10px 40px rgba(0,0,0,0.3);">
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:20px; margin-bottom:20px;">
                        <div style="grid-column: span 2;">
                            <label class="cfg-lbl">Compute Target (Auth Inheritance)</label>
                            <select id="spark-target" class="cfg-input" style="height:44px; width:102%">
                                <option value="">None (Universal)</option>
                                ${_targets.map(t => `<option value="${t.target_id}">${t.target_name} (${t.provider_type})</option>`).join('')}
                            </select>
                        </div>
                        <div>
                            <label class="cfg-lbl">Main Class</label>
                            <input id="spark-class" class="cfg-input" placeholder="e.g. com.cloud.AnalyticJob">
                        </div>
                        <div>
                            <label class="cfg-lbl">Application JAR Path</label>
                            <input id="spark-jar" class="cfg-input" placeholder="s3://datalake/jobs/app.jar">
                        </div>
                    </div>
                    
                    <div style="margin-bottom:20px;">
                        <label class="cfg-lbl">Arguments (One per line)</label>
                        <textarea id="spark-args" class="cfg-input" rows="3" placeholder="--source s3://input --target s3://output"></textarea>
                    </div>

                    <div style="display:flex; justify-content:flex-end;">
                        <button class="btn btn-primary" onclick="window.submitSparkJob()" id="spark-submit-btn">🚀 Submit Spark Job</button>
                    </div>
                </div>

                <div id="spark-logs" style="margin-top:25px; background:#020617; border:1px solid var(--border); border-radius:12px; padding:20px; font-family:'Menlo', monospace; font-size:0.75rem; color:#10b981; max-height:300px; overflow-y:auto; display:none;">
                    <div style="color:var(--text-muted); margin-bottom:10px;">[Spark] Engine initialized. Waiting for task logs...</div>
                </div>
            `;
        } else if (tab === 'rag') {
            container.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                    <h3 style="margin:0;">🧠 Unstructured RAG Engine</h3>
                    <p style="font-size:0.75rem; color:var(--text-muted);">Index unstructured files (PDF, TXT) into Milvus and query them with AI.</p>
                </div>
                
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:20px;">
                    <div style="background:var(--glass-heavy); padding:20px; border-radius:15px; border:1px solid var(--border);">
                        <h3 style="margin-top:0; color:var(--accent);">1. Index Document</h3>
                        <div class="field-group">
                            <label class="cfg-lbl">Target Storage</label>
                            <select id="rag-target" class="cfg-input">
                                <option value="">Select Target</option>
                                ${_targets.map(t => `<option value="${t.target_id}">${t.target_name} (${t.provider_type})</option>`).join('')}
                            </select>
                        </div>
                        <div class="field-group">
                            <label class="cfg-lbl">File Path (e.g. data.pdf)</label>
                            <input id="rag-file" class="cfg-input" placeholder="path/to/file.pdf">
                        </div>
                        <div class="field-group">
                            <label class="cfg-lbl">PDF Password (Optional)</label>
                            <input type="password" id="rag-password" class="cfg-input" placeholder="Enter password if encrypted">
                        </div>
                        <button id="rag-index-btn" class="btn btn-primary" style="width:100%; height:40px; margin-bottom: 10px;" onclick="window.indexRagFile()">📥 Index from Storage</button>

                        <div style="text-align: center; margin: 15px 0; position: relative;">
                            <hr style="border: none; border-top: 1px solid var(--border); position: absolute; width: 100%; top: 50%; z-index: 1;">
                            <span style="background: var(--glass-heavy); padding: 0 10px; position: relative; z-index: 2; color: var(--text-muted); font-size: 0.75rem; font-weight: 600;">OR</span>
                        </div>

                        <div class="field-group">
                            <label class="cfg-lbl">Upload Local File (Any File)</label>
                            <div style="display:flex; gap:10px; align-items:center;">
                                <input type="file" id="rag-upload-file" class="cfg-input" accept=".pdf,.txt,.csv,.json,.parquet,.orc" style="flex:1; padding: 6px;">
                                <button id="rag-upload-btn" class="btn btn-secondary" style="height:36px; white-space:nowrap; border-color: var(--accent); color: var(--accent);" onclick="window.uploadAndIndexRagFile()">📤 Upload & Index</button>
                            </div>
                        </div>
                        <div id="rag-index-status" style="margin-top:10px; font-size:0.8rem; color:#10b981;"></div>
                    </div>
                    
                    <div style="background:var(--glass-heavy); padding:20px; border-radius:15px; border:1px solid var(--border); display:flex; flex-direction:column;">
                        <h3 style="margin-top:0; color:#a78bfa;">2. Chat / Query</h3>
                        <div id="rag-chat-history" style="flex:1; background:#0f172a; border-radius:8px; padding:10px; overflow-y:auto; font-size:0.85rem; margin-bottom:10px; border:1px solid var(--border); min-height: 200px; color:#cbd5e1;">
                            <div style="color:#94a3b8; font-style:italic;">Ask questions against your indexed documents...</div>
                        </div>
                        <div style="display:flex; gap:10px;">
                            <input id="rag-query-input" class="cfg-input" style="flex:1;" placeholder="What does the document say about..." onkeydown="if(event.key==='Enter') window.queryRag()">
                            <button id="rag-query-btn" class="btn" style="background:#8b5cf6; color:white; border:none;" onclick="window.queryRag()">Send</button>
                        </div>
                    </div>
                </div>
            `;
        }
    } catch (err) {
        container.innerHTML = `<div style="color:var(--error); padding:20px;">Failed to fetch admin data.</div>`;
    }
};

window.switchMainMode = (mode) => {
    const sqlBtn = document.getElementById('mode-sql-btn');
    const ragBtn = document.getElementById('mode-rag-btn');
    const ingestBtn = document.getElementById('mode-ingest-btn');
    const sqlWorkspace = document.getElementById('sql-workspace');
    const ragWorkspace = document.getElementById('rag-workspace');
    const ingestWorkspace = document.getElementById('ingest-workspace');

    // Reset all
    [sqlBtn, ragBtn, ingestBtn].filter(Boolean).forEach(btn => {
        btn.classList.remove('active');
        btn.style.background = 'rgba(255, 255, 255, 0.05)';
        btn.style.color = 'var(--text-muted)';
    });
    [sqlWorkspace, ragWorkspace, ingestWorkspace].filter(Boolean).forEach(ws => {
        ws.style.display = 'none';
    });

    if (mode === 'sql') {
        sqlBtn.classList.add('active');
        sqlBtn.style.background = '';
        sqlBtn.style.color = '';
        sqlWorkspace.style.display = 'block';
    } else if (mode === 'rag') {
        ragBtn.classList.add('active');
        ragBtn.style.background = '';
        ragBtn.style.color = '';
        ragWorkspace.style.display = 'block';

        const targetSelect = document.getElementById('main-rag-target');
        if (targetSelect && targetSelect.children.length <= 1) {
            targetSelect.innerHTML = `<option value="">Select Target</option>` + 
                _targets.map(t => `<option value="${t.target_id}">${t.target_name} (${t.provider_type})</option>`).join('');
        }
    } else if (mode === 'ingest') {
        if (ingestBtn) {
            ingestBtn.classList.add('active');
            ingestBtn.style.background = '';
            ingestBtn.style.color = '';
        }
        if (ingestWorkspace) ingestWorkspace.style.display = 'block';

        const targetSelect = document.getElementById('ingest-target');
        if (targetSelect && targetSelect.children.length <= 1) {
            targetSelect.innerHTML = `<option value="">Select Target</option>` + 
                _targets.map(t => `<option value="${t.target_id}">${t.target_name} (${t.provider_type})</option>`).join('');
        }
    }
};


window.handleIngestTypeChange = (type) => {
    const hostLabel = document.getElementById('ingest-host-label');
    const hostInput = document.getElementById('ingest-host');
    const portInput = document.getElementById('ingest-port');
    const userInput = document.getElementById('ingest-user');
    const passInput = document.getElementById('ingest-pass');
    const pathInput = document.getElementById('ingest-source-path');

    if (type === 'gdrive') {
        if (hostLabel) hostLabel.innerText = 'Google Drive Folder ID (or root)';
        if (hostInput) { hostInput.placeholder = 'root (or folder ID)'; hostInput.value = hostInput.value || 'root'; }
        if (portInput) { portInput.disabled = true; portInput.value = ''; }
        if (userInput) userInput.placeholder = 'Service Account / Client ID (Optional)';
        if (passInput) passInput.placeholder = 'Private Key / Secret (Optional)';
        if (pathInput) pathInput.placeholder = 'customer_churn_analysis.csv';
    } else {
        if (hostLabel) hostLabel.innerText = 'Host Address';
        if (hostInput) hostInput.placeholder = 'ftp.example.com';
        if (portInput) portInput.disabled = false;
        if (userInput) userInput.placeholder = 'admin';
        if (passInput) passInput.placeholder = '••••••••';
        if (pathInput) pathInput.placeholder = '/data/exports/daily_dump.csv';
    }
};

window.startIngestion = async () => {
    const type = document.getElementById('ingest-type').value;
    const host = document.getElementById('ingest-host').value || (type === 'gdrive' ? 'root' : '');
    const port = document.getElementById('ingest-port').value;
    const user = document.getElementById('ingest-user').value || (type === 'gdrive' ? 'demo_gdrive_user' : '');
    const password = document.getElementById('ingest-pass').value || (type === 'gdrive' ? 'demo_gdrive_key' : '');
    const sourcePath = document.getElementById('ingest-source-path').value;
    const targetId = document.getElementById('ingest-target').value;
    const targetFolder = document.getElementById('ingest-target-folder').value;
    const status = document.getElementById('ingest-status');

    if (!host || !sourcePath || !targetId || (type !== 'gdrive' && (!user || !password))) {
        status.innerHTML = '<span style="color:var(--error);">Please fill out required fields (Source Host/Folder, File Path, Target Object Storage).</span>';
        return;
    }

    status.innerHTML = '<span style="color:var(--accent);">⌛ Connecting to Source & Streaming to Cloud Object Storage...</span>';
    
    try {
        const payload = {
            sourceConfig: { type, host, port, user, password, sourcePath },
            targetId, targetFolder
        };
        const data = await apiFetch('/api/ingestion/start', {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        if (data.success) {
            status.innerHTML = `<span style="color:#10b981;">✅ Success! Streamed file to Object Storage at ${data.result.key}.</span>`;
        } else {
            status.innerHTML = `<span style="color:var(--error);">❌ Ingestion Failed: ${data.error}</span>`;
        }
    } catch (e) {
        status.innerHTML = `<span style="color:var(--error);">❌ Network Error: Could not start ingestion</span>`;
    }
};

window.indexRagFile = async (isMain = false) => {
    const prefix = isMain ? 'main-rag-' : 'rag-';
    const targetId = document.getElementById(prefix + 'target').value;
    const fileName = document.getElementById(prefix + 'file').value;
    const password = document.getElementById(prefix + 'password')?.value || '';
    const vectorDb = document.getElementById(prefix + 'vector-db')?.value || 'milvus';
    const status = document.getElementById(prefix + 'index-status');
    if (!targetId || !fileName) return showStatus('Select target and enter file path', 'error');
    
    status.innerText = 'Indexing document...';
    try {
        const data = await apiFetch('/api/rag/index', { method: 'POST', body: JSON.stringify({ targetId, fileName, password, vectorDb }) });
        if (data.success) {
            status.innerText = '✅ Document indexed successfully.';
            window._lastIndexedRagFile = fileName;
            const delBtn = document.getElementById(prefix + 'delete-btn');
            if (delBtn) delBtn.style.display = 'inline-block';
        } else {
            status.innerText = '❌ ' + (data.error || 'Indexing failed');
        }
    } catch (e) {
        status.innerText = '❌ Request failed';
    }
};

// ── AIRBYTE INTEGRATION LOGIC ─────────────────────────────────

window.switchIngestTab = (tab) => {
    const ftpBtn = document.getElementById('ingest-tab-ftp');
    const abBtn = document.getElementById('ingest-tab-airbyte');
    const ftpPanel = document.getElementById('ingest-panel-ftp');
    const abPanel = document.getElementById('ingest-panel-airbyte');

    if (tab === 'ftp') {
        ftpBtn.style.background = 'var(--accent)';
        ftpBtn.style.color = 'white';
        ftpBtn.style.border = 'none';
        
        abBtn.style.background = 'transparent';
        abBtn.style.color = 'var(--text-muted)';
        abBtn.style.border = '1px solid var(--border)';
        
        ftpPanel.style.display = 'block';
        abPanel.style.display = 'none';
    } else {
        abBtn.style.background = 'var(--accent)';
        abBtn.style.color = 'white';
        abBtn.style.border = 'none';
        
        ftpBtn.style.background = 'transparent';
        ftpBtn.style.color = 'var(--text-muted)';
        ftpBtn.style.border = '1px solid var(--border)';
        
        ftpPanel.style.display = 'none';
        abPanel.style.display = 'block';

        // Initialize Airbyte panel
        checkAirbyteStatus();
        window.refreshAirbyteJobs();

        // Populate targets for Airbyte
        const abTargetSelect = document.getElementById('airbyte-minio-target');
        if (abTargetSelect && abTargetSelect.children.length <= 1) {
            abTargetSelect.innerHTML = `<option value="">Select MinIO/S3 Target</option>` + 
                _targets.filter(t => t.provider_type === 'minio' || t.provider_type === 's3')
                .map(t => `<option value="${t.target_id}">${t.target_name} (${t.provider_type})</option>`).join('');
        }
    }
};

async function checkAirbyteStatus() {
    const statusEl = document.getElementById('airbyte-server-status');
    if (!statusEl) return;
    try {
        const res = await apiFetch('/api/airbyte/status');
        if (res.success && res.status.online) {
            statusEl.innerText = '🟢 Online';
            statusEl.style.color = '#10b981';
            statusEl.style.background = 'rgba(16, 185, 129, 0.1)';
        } else {
            statusEl.innerText = '🔴 Offline';
            statusEl.style.color = '#ef4444';
            statusEl.style.background = 'rgba(239, 68, 68, 0.1)';
        }
    } catch (e) {
        statusEl.innerText = '🔴 Unreachable';
    }
}

window.setupAirbyteDestination = async () => {
    const targetId = document.getElementById('airbyte-minio-target').value;
    const status = document.getElementById('airbyte-setup-status');
    if (!targetId) {
        status.innerHTML = '<span style="color:var(--error);">Please select a target first.</span>';
        return;
    }
    
    status.innerHTML = '<span style="color:var(--accent);">⌛ Provisioning Airbyte Destination...</span>';
    try {
        const res = await apiFetch('/api/airbyte/setup-destination', {
            method: 'POST',
            body: JSON.stringify({ targetId })
        });
        if (res.success) {
            status.innerHTML = `<span style="color:#10b981;">✅ Destination successfully created in Airbyte!</span>`;
        } else {
            status.innerHTML = `<span style="color:var(--error);">❌ Setup Failed: ${res.error}</span>`;
        }
    } catch (e) {
        status.innerHTML = `<span style="color:var(--error);">❌ Network Error</span>`;
    }
};

window.refreshAirbyteJobs = async () => {
    const list = document.getElementById('airbyte-jobs-list');
    if (!list) return;
    try {
        const res = await apiFetch('/api/airbyte/jobs');
        if (res.success && res.jobs.connections.length > 0) {
            list.innerHTML = res.jobs.connections.map(c => `
                <div style="padding:10px; border-bottom:1px solid rgba(255,255,255,0.05); display:flex; justify-content:space-between;">
                    <div><strong>${c.name}</strong></div>
                    <div style="color:${c.status === 'active' ? '#10b981' : '#f59e0b'};">${c.status.toUpperCase()}</div>
                </div>
            `).join('');
        } else {
            list.innerHTML = '<div style="padding:10px; text-align:center;">No sync connections found in Airbyte.</div>';
        }
    } catch (e) {
        list.innerHTML = '<div style="color:var(--error); padding:10px;">Failed to load sync history.</div>';
    }
};

window.uploadAndIndexRagFile = async (isMain = false) => {
    const prefix = isMain ? 'main-rag-' : 'rag-';
    const fileInput = document.getElementById(prefix + 'upload-file');
    const password = document.getElementById(prefix + 'password')?.value || '';
    const vectorDb = document.getElementById(prefix + 'vector-db')?.value || 'milvus';
    const status = document.getElementById(prefix + 'index-status');
    if (!fileInput.files || fileInput.files.length === 0) return showStatus('Select a file to upload', 'error');
    
    const file = fileInput.files[0];
    const formData = new FormData();
    if (password) formData.append('password', password);
    formData.append('vectorDb', vectorDb);
    formData.append('file', file);
    
    status.innerText = 'Uploading and indexing document...';
    try {
        const res = await fetch('/api/rag/upload_and_index', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('ciq_token') },
            body: formData
        });
        const data = await res.json();
        if (data.success) {
            status.innerText = '✅ Document uploaded and indexed successfully.';
            window._lastIndexedRagFile = file.name;
            const delBtn = document.getElementById(prefix + 'delete-btn');
            if (delBtn) delBtn.style.display = 'inline-block';
        } else {
            status.innerText = '❌ ' + (data.error || 'Upload failed');
        }
    } catch (e) {
        status.innerText = '❌ Request failed';
    }
};

window.deleteRagDocument = async (isMain = true) => {
    const modal = document.getElementById('delete-rag-modal');
    const select = document.getElementById('delete-rag-select');
    
    if (modal && select) {
        modal.style.display = 'flex';
        select.innerHTML = '<option value="">Loading documents...</option>';
        
        try {
            const res = await fetch('/api/rag/documents', {
                headers: { 'Authorization': 'Bearer ' + localStorage.getItem('ciq_token') }
            });
            const data = await res.json();
            
            if (data.success && data.sources && data.sources.length > 0) {
                select.innerHTML = data.sources.map(s => `<option value="${s.replace(/"/g, '&quot;')}">${s}</option>`).join('');
                if (window._lastIndexedRagFile) {
                    select.value = window._lastIndexedRagFile;
                }
            } else {
                select.innerHTML = '<option value="">No documents found</option>';
            }
        } catch (e) {
            select.innerHTML = '<option value="">Failed to load documents</option>';
        }
    }
};

window.confirmDeleteRagDocument = async (isMain = true) => {
    const prefix = isMain ? 'main-rag-' : 'rag-';
    const status = document.getElementById(prefix + 'index-status');
    const select = document.getElementById('delete-rag-select');
    
    if (!select || !select.value) {
        alert("Please select a document to delete.");
        return;
    }
    
    const fileName = select.value;
    
    document.getElementById('delete-rag-modal').style.display = 'none';
    status.innerText = 'Deleting document from index...';
    
    try {
        const res = await fetch(`/api/rag/document/${encodeURIComponent(fileName)}`, {
            method: 'DELETE',
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('ciq_token') }
        });
        const data = await res.json();
        
        if (data.success) {
            status.innerText = `✅ Document ${fileName} deleted successfully.`;
            if (window._lastIndexedRagFile === fileName) {
                window._lastIndexedRagFile = null;
            }
        } else {
            status.innerText = '❌ ' + (data.error || 'Delete failed');
        }
    } catch (e) {
        status.innerText = '❌ Request failed';
    }
};

window.queryRag = async (isMain = false) => {
    const prefix = isMain ? 'main-rag-' : 'rag-';
    const queryInput = document.getElementById(prefix + 'query-input');
    const question = queryInput.value.trim();
    if (!question) return;
    
    let mode = 'hybrid';
    const modeSelect = document.getElementById(prefix + 'search-mode');
    if (modeSelect) mode = modeSelect.value;
    
    const history = document.getElementById(prefix + 'chat-history');
    history.innerHTML += `<div style="margin-bottom: 10px; color: #3b82f6;"><strong>You:</strong> ${question}</div>`;
    queryInput.value = '';
    
    try {
        const data = await apiFetch('/api/rag/query', { method: 'POST', body: JSON.stringify({ question, mode }) });
        let responseText = 'No response';
        if (data.success && data.answer) {
            responseText = data.answer;
        } else if (data.error) {
            responseText = 'Error: ' + String(data.error).replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
        history.innerHTML += `<div style="margin-bottom: 10px; color: #10b981; white-space: pre-wrap;"><strong>Engine:</strong> ${responseText}</div>`;
        history.scrollTop = history.scrollHeight;
    } catch (e) {
        history.innerHTML += `<div style="margin-bottom: 10px; color: #ef4444;"><strong>Error:</strong> Request failed</div>`;
    }
};

let bulkIndexInterval = null;

window.startBulkIndex = async () => {
    const btn = document.getElementById('main-rag-bulk-btn');
    const statusDiv = document.getElementById('main-rag-bulk-status');
    
    btn.disabled = true;
    statusDiv.style.display = 'block';
    statusDiv.innerText = 'Starting bulk indexing...';
    
    try {
        const data = await apiFetch('/api/rag/bulk_index/start', { method: 'POST' });
        if (data.success) {
            if (bulkIndexInterval) clearInterval(bulkIndexInterval);
            bulkIndexInterval = setInterval(window.pollBulkIndexStatus, 2000);
        } else {
            statusDiv.innerText = '❌ ' + (data.error || 'Failed to start');
            btn.disabled = false;
        }
    } catch (e) {
        statusDiv.innerText = '❌ Request failed';
        btn.disabled = false;
    }
};

window.pollBulkIndexStatus = async () => {
    try {
        const data = await apiFetch('/api/rag/bulk_index/status');
        const statusDiv = document.getElementById('main-rag-bulk-status');
        const btn = document.getElementById('main-rag-bulk-btn');
        
        if (data) {
            let text = data.currentFile;
            if (data.totalFiles > 0) {
                text += `\nIndexed ${data.indexedFiles} out of ${data.totalFiles} files.`;
            }
            if (data.errors && data.errors.length > 0) {
                text += `\n⚠️ Errors: ${data.errors.length} (Check server logs)`;
            }
            statusDiv.innerText = text;
            
            if (!data.isRunning) {
                if (bulkIndexInterval) clearInterval(bulkIndexInterval);
                btn.disabled = false;
                if (data.currentFile === 'Completed!') {
                    statusDiv.innerHTML = `✅ <strong>Finished!</strong> Indexed ${data.indexedFiles} files.`;
                }
            }
        }
    } catch (e) {
        console.error('Failed to poll status', e);
    }
};

window.executeQuery = async function() {
    const sql = document.getElementById('query-editor').value;
    const status = document.getElementById('exec-status');
    const tableHead = document.getElementById('table-head');
    const tableBody = document.getElementById('table-body');
    if (!sql) return;

    status.innerText = '📡 Execution in progress...';
    try {
        const data = await apiFetch(`/api/query/${_activeTargetId}`, {
            method: 'POST',
            body: JSON.stringify({ sql })
        });

        if (data.offloaded) {
            showStatus(data.message, 'success');
            window.showAdminTab('spark'); // Open Spark Jobs tab
            document.getElementById('admin-overlay').style.display = 'flex';
            setTimeout(() => {
                const argsEl = document.getElementById('spark-args');
                const classEl = document.getElementById('spark-class');
                const jarEl = document.getElementById('spark-jar');
                const targetEl = document.getElementById('spark-target');
                
                // Switch to Python SQL Bridge for maximum compatibility
                if (classEl) classEl.value = ''; // Not needed for Python
                if (jarEl) jarEl.value = '/app/sql_bridge.py'; 
                if (argsEl) argsEl.value = `--sql "${sql.replace(/"/g, '\\"')}"`;
                if (targetEl && _activeTargetId) targetEl.value = _activeTargetId;
            }, 600);
            status.innerText = '⚡ [Auto-Translate] Redirected to Spark';
            return;
        }

        if (data.success) {
            status.innerText = `✅ Success: ${data.data.length} rows returned. (${data.meta.duration}ms)`;
            
            // 🎬 Show Live Burn
            const meter = document.getElementById('live-burn-meter');
            const burnVal = document.getElementById('current-burn-val');
            const scanVal = document.getElementById('current-scan-val');
            if (meter && burnVal && scanVal) {
                meter.style.display = 'flex';
                burnVal.innerText = (data.meta.estimatedCost || 0).toFixed(6);
                scanVal.innerText = ((data.meta.estimatedScan || 0) / (1024 * 1024)).toFixed(1);
            }

            _notebooks[_activeTabIdx].results = data.data;
            _notebooks[_activeTabIdx].sql = sql;
            saveNotebooks();
            window.renderResults(data.data);
        } else {
            document.getElementById('live-burn-meter').style.display = 'none';
            status.innerText = `❌ Error: ${data.error}`;
        }
    } catch (err) {
        document.getElementById('live-burn-meter').style.display = 'none';
        status.innerText = `❌ Request failed`;
    }
};

window.renderResults = function(data, updateStore = true) {
    const tableHead = document.getElementById('table-head');
    const tableBody = document.getElementById('table-body');
    if (!data || data.length === 0) return;

    if (updateStore) {
       _currentResultData = data;
       _filteredData = [...data];
    }
    
    document.getElementById('export-btns').style.display = 'flex';
    const chartToggle = document.getElementById('chart-toggle-btn');
    if(chartToggle) chartToggle.style.display = 'inline-flex';

    const cols = Object.keys(data[0]);
    tableHead.innerHTML = `<tr>${cols.map(c=>`<th>${c}</th>`).join('')}</tr>`;
    tableBody.innerHTML = data.slice(0, 50).map(row => `<tr>${cols.map(c=>`<td>${row[c]}</td>`).join('')}</tr>`).join('');

    if (document.getElementById('chart-panel').style.display === 'block') window.initPowerBI();
};

// ── Target & File Management ──
async function loadTargets() {
    try {
        const data = await apiFetch('/api/targets');
        if (data.success) {
            _targets = data.targets;
            renderTargets();
            if (_targets.length > 0 && !_activeTargetId) selectTarget(_targets[0].target_id);
        }
    } catch (err) {
        console.error('Failed to load targets:', err);
    }
}

function renderTargets() {
    const list = document.getElementById('target-list');
    if (!list) return;
    list.innerHTML = '';
    _targets.forEach(t => {
        const li = document.createElement('li');
        li.className = 'browser-item';
        li.style.listStyle = 'none';

        // Use orange for MinIO and Azure, Google branding for Google Drive, R2 for Cloudflare
        const type = (t.provider_type || '').toLowerCase();
        const isOrange = ['minio', 'azure', 'adls', 'blob'].includes(type);
        const isGDrive = ['gdrive', 'googledrive', 'drive'].includes(type);
        const isR2 = ['r2', 'cloudflare'].includes(type);

        let bgStyle = isOrange ? 'background:var(--orange);' : 'background:var(--primary);';
        let badgeContent = (t.provider_type || 'S')[0].toUpperCase();

        if (isGDrive) {
            bgStyle = 'background: linear-gradient(135deg, #4285F4 0%, #34A853 45%, #FBBC05 75%, #EA4335 100%); box-shadow: 0 2px 8px rgba(66, 133, 244, 0.4);';
            badgeContent = '📁';
        } else if (isR2) {
            bgStyle = 'background: #F38020; box-shadow: 0 2px 8px rgba(243, 128, 32, 0.4);';
            badgeContent = 'R2';
        }

        li.innerHTML = `
            <div class="target-card ${t.target_id === _activeTargetId ? 'active' : ''}" onclick="window.selectTarget('${t.target_id}')" style="cursor:pointer; padding:12px; border-radius:12px; border:1px solid var(--border); display:flex; gap:12px; align-items:center; margin-bottom:8px; background:var(--glass);">
                <div style="width:32px; height:32px; border-radius:8px; ${bgStyle} color:white; display:flex; align-items:center; justify-content:center; font-weight:700; font-size: 1rem;">${badgeContent}</div>
                <div style="flex:1;">
                    <p style="margin:0; font-size:0.85rem; font-weight:700;">${t.target_name}</p>
                    <div style="display:flex; align-items:center; gap:5px;">
                        <span style="width:6px; height:6px; background:${t.is_active ? '#10b981' : '#ef4444'}; border-radius:10px;"></span>
                        <small style="font-size:0.65rem; color:var(--text-muted);">${t.is_active ? (isGDrive ? 'Google Drive Active' : 'Online') : 'Offline'}</small>
                    </div>
                </div>
            </div>`;
        list.appendChild(li);
    });
}

window.selectTarget = (id) => { _activeTargetId = id; renderTargets(); loadFiles(); };

async function loadFiles() {
    const list = document.getElementById('browser-list');
    if (!list) return;
    list.innerHTML = '<li style="text-align:center; padding:15px; color:var(--text-muted);">⌛ Scanning...</li>';
    try {
        const data = await apiFetch(`/api/files/${_activeTargetId}`);
        if (data.success) {
            _allFiles = data.files;
            renderFileList(_allFiles);
        }
    } catch (err) {
        list.innerHTML = '<li style="color:var(--error); padding:10px;">Access Error</li>';
    }
}

function renderFileList(files) {
    const list = document.getElementById('browser-list');
    
    // Apply extension filter
    let filtered = files;
    if (_activeTypeFilter !== 'all') {
        filtered = files.filter(f => f.name.toLowerCase().endsWith('.' + _activeTypeFilter));
    }

    if (filtered.length === 0) {
        list.innerHTML = `<li style="padding:15px; color:var(--text-muted); font-size:0.75rem; text-align:center;">No ${_activeTypeFilter.toUpperCase()} files found</li>`;
        return;
    }

    list.innerHTML = filtered.map(f => {
        const ext = f.name.split('.').pop().toLowerCase();
        let icon = '📄';
        if (ext === 'parquet') icon = '✨';
        if (ext === 'orc') icon = '🐘';
        if (ext === 'csv') icon = '📊';
        if (ext === 'json') icon = '📦';
        
        return `<li style="padding:10px 12px; font-size:0.8rem; border-radius:8px; display:flex; gap:10px; align-items:center; justify-content: space-between; border-bottom:1px solid var(--border);">
            <div onclick="window.selectFileForQuery('${f.name}')" style="display:flex; gap:10px; align-items:center; cursor:pointer; flex-grow: 1;">
                <span style="font-size:1rem;">${icon}</span> <span style="word-break: break-all;">${f.name}</span>
            </div>
            <button onclick="window.downloadFile(event, '${f.name}')" style="padding: 4px 8px; border-radius: 4px; background: transparent; border: 1px solid var(--border); color: inherit; cursor:pointer;" title="Download File">📥</button>
        </li>`;
    }).join('');
}

window.downloadFile = function(e, fileName) {
    e.stopPropagation();
    if (!_activeTargetId) return;
    const url = `/api/download/${_activeTargetId}?fileName=${encodeURIComponent(fileName)}`;
    
    fetch(url, {
        headers: {
            'Authorization': 'Bearer ' + localStorage.getItem('ciq_token')
        }
    })
    .then(async res => {
        if(!res.ok) {
            let msg = 'Download failed';
            try { const err = await res.json(); msg = err.error || msg; } catch(e){}
            throw new Error(msg);
        }
        return res.blob();
    })
    .then(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
    })
    .catch(err => {
        console.error("Download error:", err);
        alert("Error downloading file: " + err.message);
    });
};

window.filterByType = function(type) {
    _activeTypeFilter = type;
    
    // Update UI chips
    const chips = document.querySelectorAll('.type-chip');
    chips.forEach(c => {
        if (c.innerText.toLowerCase().includes(type)) c.classList.add('active');
        else if (type === 'all' && c.innerText === 'All') c.classList.add('active');
        else c.classList.remove('active');
    });

    renderFileList(_allFiles);
}

window.selectFileForQuery = (name) => {
    const target = _targets.find(t => t.target_id === _activeTargetId);
    const prefix = target ? (target.base_uri || '') : '';
    const ext = name.split('.').pop().toLowerCase();
    let sql = `SELECT * FROM '${prefix}${name}' LIMIT 100;`;
    if (ext === 'parquet') sql = `SELECT * FROM read_parquet('${prefix}${name}') LIMIT 100;`;
    else if (ext === 'csv') sql = `SELECT * FROM read_csv_auto('${prefix}${name}') LIMIT 100;`;
    else if (ext === 'json') sql = `SELECT * FROM read_json_auto('${prefix}${name}') LIMIT 100;`;
    else if (ext === 'orc') {
        showStatus('ORC direct SQL requires extra engine components. Use Spark Jobs for ORC processing.', 'info');
        sql = `SELECT * FROM read_orc('${prefix}${name}') LIMIT 100;`;
    }
    document.getElementById('query-editor').value = sql;
    window.inspectFile(name, _activeTargetId);
};

window.inspectFile = async (fileName, targetId) => {
    const panel = document.getElementById('schema-panel');
    const loading = document.getElementById('schema-loading');
    const columns = document.getElementById('schema-columns');
    const queryBtn = document.getElementById('schema-query-btn');
    if (!panel) return;
    panel.style.display = 'block';
    loading.style.display = 'block';
    columns.style.display = 'none';
    queryBtn.style.display = 'none';
    document.getElementById('schema-file-name').innerText = fileName;
    try {
        const data = await apiFetch(`/api/schema/${targetId}?fileName=${encodeURIComponent(fileName)}`);
        if (data.success) {
            loading.style.display = 'none';
            columns.style.display = 'block';
            queryBtn.style.display = 'block';
            document.getElementById('schema-row-count').innerText = data.rowCount.toLocaleString();
            document.getElementById('schema-col-count').innerText = data.stats.totalColumns;
            document.getElementById('schema-col-list').innerHTML = data.columns.map(c => `<div style="display:grid; grid-template-columns:1fr auto; padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.03);"><span style="font-weight:600; font-size:0.75rem;">${c.name}</span><span style="color:var(--text-muted); font-size:0.65rem;">${c.type}</span></div>`).join('');
        }
    } catch (err) { loading.innerHTML = 'Error loading schema'; }
};

window.closeSchemaPanel = () => document.getElementById('schema-panel').style.display = 'none';
window.insertSchemaQuery = (isNew) => { if (isNew) window.addNotebookTab(); window.executeQuery(); };

// ── Analytics Engine ──
window.applySlicers = (col, val) => {
    if (val) _activeSlicers[col] = val;
    else delete _activeSlicers[col];
    _filteredData = _currentResultData.filter(row => Object.entries(_activeSlicers).every(([k, v]) => row[k] == v));
    window.renderPowerBI();
};

window.renderPowerBI = () => {
    const chartCanvas = document.getElementById('results-chart');
    const helper      = document.getElementById('results-helper');
    if (!chartCanvas || !helper) return;
    if (typeof Chart === 'undefined') {
        helper.innerHTML = '🚫 Chart Engine failed to load.';
        return;
    }
    if (_filteredData.length === 0) {
        helper.style.display = 'flex';
        chartCanvas.style.visibility = 'hidden';
        return;
    }
    helper.style.display = 'none';
    chartCanvas.style.visibility = 'visible';
    
    // 🧠 Smart Cardinality & Manual Override
    const chartType = document.getElementById('pbi-chart-type').value || 'bar';
    const groupCol  = document.getElementById('pbi-group-col').value;
    const numericCol = document.getElementById('pbi-numeric-col').value;
    
    const ctx = chartCanvas.getContext('2d');
    if (chartInstance) chartInstance.destroy();
    
    const agg = {};
    _filteredData.forEach(r => {
        const key = r[groupCol] || '(Blank)';
        const val = (numericCol && numericCol !== 'count') ? parseFloat(r[numericCol] || 0) : 1;
        agg[key] = (agg[key] || 0) + val;
    });

    const sorted = Object.entries(agg).sort((a,b) => b[1]-a[1]).slice(0, 15);
    chartInstance = new Chart(ctx, {
        type: chartType,
        data: {
            labels: sorted.map(i=>i[0]),
            datasets: [{ 
                label: (numericCol && numericCol !== 'count') ? numericCol : 'Record Count', 
                data: sorted.map(i=>i[1]), 
                backgroundColor: ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#7c3aed', '#06b6d4', '#f97316', '#ec4899', '#14b8a6', '#4338ca', '#8b5cf6', '#dc2626', '#d946ef', '#10b981', '#1e293b'],
                borderWidth: 0,
                borderRadius: (chartType === 'bar') ? 6 : 0
            }]
        },
        options: { 
            responsive: true, 
            maintainAspectRatio: false, 
            plugins: { 
                legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, font: { family: 'Outfit' } } },
                tooltip: { backgroundColor: '#1e293b', titleFont: { family: 'Outfit' }, bodyFont: { family: 'Outfit' } }
            }, 
            barPercentage: 0.6 
        }
    });
};

window.initPowerBI = () => {
    if (!_currentResultData || _currentResultData.length === 0) return;
    const cols = Object.keys(_currentResultData[0]);
    
    // 🧪 Smart Cardinality Sensing
    const dimensionSelect = document.getElementById('pbi-group-col');
    const measureSelect = document.getElementById('pbi-numeric-col');
    
    // Find best categorical dimension (Must have > 1 unique value to be color-diverse)
    const candidates = cols.filter(c => {
        const uniqueCount = new Set(_currentResultData.map(r => r[c])).size;
        return uniqueCount > 1; 
    });
    
    dimensionSelect.innerHTML = candidates.map(c => `<option value="${c}">${c}</option>`).join('') || 
                               cols.map(c => `<option value="${c}">${c}</option>`).join('');
    
    // Find numeric measures
    const numericCols = cols.filter(c => typeof _currentResultData[0][c] === 'number');
    measureSelect.innerHTML = `<option value="count">Record Count</option>` + 
                              numericCols.map(c => `<option value="${c}">Sum of ${c}</option>`).join('');

    // Default Smart Pick
    const bestDim = candidates.find(c => typeof _currentResultData[0][c] === 'string' && !c.toLowerCase().includes('id')) || candidates[0] || cols[0];
    dimensionSelect.value = bestDim;
    
    const categorical = cols.filter(c => new Set(_currentResultData.map(r=>r[c])).size < 20 && typeof _currentResultData[0][c] === 'string');
    const filterContainer = document.getElementById('pbi-filters');
    if (filterContainer) {
        filterContainer.innerHTML = categorical.map(c => `<div style="margin-bottom:12px;"><label style="font-size:0.75rem; font-weight:800;">${c}</label><select style="width:100%; padding:8px; border-radius:8px; border:1px solid var(--border); background:var(--glass);" onchange="window.applySlicers('${c}', this.value)"><option value="">All</option>${Array.from(new Set(_currentResultData.map(r=>r[c]))).map(v=>`<option value="${v}">${v}</option>`).join('')}</select></div>`).join('');
    }
    window.renderPowerBI();
};

window.switchView = (view) => {
    document.getElementById('view-tab-table').classList.toggle('active', view === 'table');
    document.getElementById('view-tab-chart').classList.toggle('active', view === 'chart');
    document.getElementById('table-container').style.display = view === 'table' ? 'block' : 'none';
    document.getElementById('chart-panel').style.display = view === 'chart' ? 'block' : 'none';
    if (view === 'chart') window.initPowerBI();
};

// ── Export Results ──
window.exportResults = (format) => {
    if (!_filteredData || _filteredData.length === 0) return alert("No results to export");
    const cols = Object.keys(_filteredData[0]);
    if (format === 'csv') {
        const content = [cols.join(','), ..._filteredData.map(r => cols.map(c => `"${String(r[c] || '').replace(/"/g, '""')}"`).join(','))].join('\n');
        const blob = new Blob([content], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `Report_${Date.now()}.csv`; a.click();
    } else if (format === 'pdf') {
        const printWindow = window.open('', '_blank');
        const targetName = _targets.find(t => t.target_id === _activeTargetId)?.target_name || 'Cloud Storage';
        const html = `<html><head><title>Report</title><style>body { font-family: sans-serif; padding: 30px; } header { border-bottom: 2px solid #6366f1; padding-bottom: 15px; margin-bottom: 25px; } table { width:100%; border-collapse:collapse; } th { text-align:left; padding:10px; border-bottom:2px solid #ddd; } td { padding:10px; border-bottom:1px solid #eee; font-size:0.8rem; }</style></head><body><header><h1>CloudObjectIQ Report</h1><p>Source: ${targetName} | Generated: ${new Date().toLocaleString()}</p></header><table><thead><tr>${cols.map(c=>`<th>${c}</th>`).join('')}</tr></thead><tbody>${_filteredData.slice(0, 200).map(r=>`<tr>${cols.map(c=>`<td>${r[c]||''}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`;
        printWindow.document.write(html); printWindow.document.close(); printWindow.print();
    }
};

// ── Auth & Helpers ──
async function login() {
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const data = await res.json();
    if (data.success) { localStorage.setItem('ciq_token', data.token); localStorage.setItem('ciq_user', JSON.stringify(data.user)); location.reload(); }
}
async function apiFetch(path, options={}) {
    const res = await fetch(path, { ...options, headers: { 'Authorization': `Bearer ${localStorage.getItem('ciq_token')}`, 'Content-Type': 'application/json', ...options.headers } });
    if (res.status === 401 || res.status === 403) { localStorage.clear(); location.reload(); return { success: false }; }
    return res.json();
}
window.logout = () => { localStorage.clear(); location.reload(); };
window.closeProfile = () => document.getElementById('profile-modal').style.display = 'none';

window.filterBrowser = (query) => {
    if (!_allFiles) return;
    const q = query.toLowerCase();
    const filtered = _allFiles.filter(f => f.name.toLowerCase().includes(q) || (f.format && f.format.toLowerCase().includes(q)));
    renderFileList(filtered);
};

window.filterSavedQueries = (query) => {
    const list = document.getElementById('saved-queries-list');
    const q = query.toLowerCase();
    const items = list.querySelectorAll('.saved-query-card');
    items.forEach(item => {
        const text = item.innerText.toLowerCase();
        item.style.display = text.includes(q) ? 'flex' : 'none';
    });
};

window.filterByType = (type) => { renderFileList(type === 'all' ? _allFiles : _allFiles.filter(f => f.name.toLowerCase().endsWith('.' + type))); };

// ── Settings & Connection Management ──
window.openSettings = () => {
    loadSettingsFromStorage();
    document.getElementById('settings-modal').style.display = 'flex';
};
window.closeSettings = () => document.getElementById('settings-modal').style.display = 'none';
window.closeSettingsModal = (e) => { if (e.target.id === 'settings-modal') window.closeSettings(); };

window.switchSettingsTab = (tab) => {
    ['minio', 'minio2', 's3', 'azure', 'adls'].forEach(t => {
        const el = document.getElementById('settings-tab-' + t);
        if (el) el.style.display = t === tab ? (t === 'azure' || t === 'adls' ? 'flex' : 'grid') : 'none';
        document.getElementById('tab-btn-' + t)?.classList.toggle('active', t === tab);
    });
};

const CFG_KEY = 'ciq_connection_cfg';
function loadSettingsFromStorage() {
    try {
        const s = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
        const set = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
        set('cfg-minio-endpoint', s.minio?.endpoint);
        set('cfg-minio-access', s.minio?.access);
        set('cfg-minio-secret', s.minio?.secret);
        set('cfg-minio-region', s.minio?.region);
        set('cfg-minio-bucket', s.minio?.bucket);
        set('cfg-azure-connstr', s.azure?.connstr);
        set('cfg-azure-container', s.azure?.container);
        set('cfg-adls-connstr', s.adls?.connstr);
        set('cfg-adls-container', s.adls?.container);
    } catch(e) {}
}

window.saveSettings = async () => {
    const cfg = {
        minio: {
            endpoint: document.getElementById('cfg-minio-endpoint')?.value,
            access: document.getElementById('cfg-minio-access')?.value,
            secret: document.getElementById('cfg-minio-secret')?.value,
            region: document.getElementById('cfg-minio-region')?.value,
            bucket: document.getElementById('cfg-minio-bucket')?.value,
        },
        azure: {
            connstr: document.getElementById('cfg-azure-connstr')?.value,
            container: document.getElementById('cfg-azure-container')?.value,
        },
        adls: {
            connstr: document.getElementById('cfg-adls-connstr')?.value,
            container: document.getElementById('cfg-adls-container')?.value,
        }
    };
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    // Implementation for saving to server if needed
    window.closeSettings();
    loadTargets();
};

window.testConnection = async () => {
    const btn = document.getElementById('test-conn-btn');
    btn.disabled = true;
    btn.innerText = '⏳ Testing...';
    try {
        // Simple test against the active tab's config
        const data = await apiFetch('/api/admin/test-connection', {
            method: 'POST',
            body: JSON.stringify({ type: 'azure', endpoint: document.getElementById('cfg-azure-connstr').value, bucket: document.getElementById('cfg-azure-container').value })
        });
        alert(data.success ? "✅ Connection Successful!" : "❌ Connection Failed: " + data.error);
    } catch (err) { alert("❌ Request Failed"); }
    finally { btn.disabled = false; btn.innerText = '🔌 Test Connection'; }
};

// ── Profile & History ──
window.openProfile = async () => {
    document.getElementById('profile-modal').style.display = 'flex';
    try {
        const data = await apiFetch('/api/user/profile');
        if (data.success) {
            document.getElementById('prof-email').innerText = data.user.email;
            document.getElementById('prof-role').innerText = data.user.role;
            document.getElementById('prof-stat-queries').innerText = data.stats.queries;
            document.getElementById('prof-stat-compute').innerText = (data.stats.computeMs / 1000).toFixed(1) + 's';
            document.getElementById('prof-stat-scanned').innerText = (data.stats.totalScannedMB || 0) + ' MB';
            document.getElementById('prof-stat-burn').innerText = '$' + (data.stats.totalBurnUsd || '0.000000');
            document.getElementById('prof-stat-active').innerText = data.stats.lastActive;
            
            const history = document.getElementById('prof-history');
            history.innerHTML = data.history.map(h => `
                <div style="background:rgba(255,255,255,0.03); padding:12px; border-radius:10px; border:1px solid var(--border);">
                    <code style="display:block; margin-bottom:5px; font-size:0.75rem;">${h.sql_query.substring(0, 100)}...</code>
                    <div style="display:flex; justify-content:space-between; font-size:0.65rem; color:var(--text-muted);">
                        <span>📊 ${h.row_count} rows | ⏱️ ${h.duration}ms</span>
                        <span>${new Date(h.timestamp).toLocaleString()}</span>
                    </div>
                </div>
            `).join('');
        }
    } catch (err) { console.error('Profile load error', err); }
};

// ── File Uploads ──
window.uploadFiles = async (files) => {
    if (!files || files.length === 0) return;
    const status = document.getElementById('upload-status');
    status.innerText = `⏳ Uploading ${files.length} file(s)...`;
    
    const formData = new FormData();
    for (const f of files) formData.append('files', f);

    try {
        const res = await fetch(`/api/upload/${_activeTargetId}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('ciq_token')}` },
            body: formData
        });
        const data = await res.json();
        if (data.success) {
            status.innerText = `✅ Uploaded ${data.uploaded.length} file(s)`;
            loadFiles();
        } else {
            status.innerText = `❌ Error: ${data.error}`;
        }
    } catch (err) { status.innerText = '❌ Request failed'; }
    finally { setTimeout(() => status.innerText = '', 5000); }
};

// ── AI Assistant ──
window.aiSuggest = async () => {
    const prompt = document.getElementById('ai-prompt').value;
    if (!prompt) return;
    const btn = document.getElementById('ai-btn');
    btn.disabled = true;
    btn.innerText = '⏳ Thinking...';
    try {
        const data = await apiFetch(`/api/ai-suggest/${_activeTargetId}`, {
            method: 'POST',
            body: JSON.stringify({ prompt })
        });
        if (data.success) {
            document.getElementById('query-editor').value = data.sql;
            if (_notebooks[_activeTabIdx]) _notebooks[_activeTabIdx].sql = data.sql;
            saveNotebooks();
        }
    } finally { btn.disabled = false; btn.innerText = 'Ask AI'; }
};

window.clearEditor = () => {
    document.getElementById('query-editor').value = '';
    if (_notebooks[_activeTabIdx]) {
        _notebooks[_activeTabIdx].sql = '';
        saveNotebooks();
    }
};

window.openSaveDialog = () => document.getElementById('save-query-bar').style.display = 'flex';
window.closeSaveDialog = () => document.getElementById('save-query-bar').style.display = 'none';
window.confirmSaveQuery = () => { alert("Query Saved (Local Session)"); window.closeSaveDialog(); };

window.openSavedQueries = () => alert("Query Library is empty.");
window.closeSavedQueries = () => {};

window.pinCurrentTable = () => alert("Table Pinned to Dashboard");
window.clearDashboard = () => { document.getElementById('main-dashboard').style.display = 'none'; };

window.closeAuditModal = (e) => { if (e.target.id === 'audit-modal') window.closeAuditLog(); };
window.closeAuditLog = () => document.getElementById('audit-modal').style.display = 'none';

// ── Target Administration ──
window.openTargetEditor = async (targetId = null) => {
    const container = document.getElementById('admin-content');
    let target = { target_name: '', provider_type: 'minio', endpoint: '', bucket: '', region: '', access_key: '', secret_key: '' };
    
    if (targetId) {
        const data = await apiFetch('/api/admin/targets');
        target = data.targets.find(t => t.target_id === targetId) || target;
    }

    container.innerHTML = `
        <div style="background:var(--glass-heavy); padding:20px; border-radius:15px; border:1px solid var(--border);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                <h3 style="margin:0;">${targetId ? '📝 Edit Target' : '➕ Add New Target'}</h3>
                ${!targetId ? '<button class="ghost-btn" style="border-color:#4285F4; color:#4285F4; font-size:0.75rem;" onclick="window.fillDemoGDrive()">✨ Fast Fill Google Drive Demo</button>' : ''}
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:15px;">
                <div><label class="cfg-lbl">Target Name</label><input id="tgt-name" class="cfg-input" value="${target.target_name || ''}"></div>
                <div><label class="cfg-lbl">Provider</label>
                    <select id="tgt-type" class="cfg-input" style="height:44px; width:104%" onchange="window.handleTargetTypeChange(this.value)">
                        <option value="gdrive" ${target.provider_type === 'gdrive' || target.provider_type === 'googledrive' ? 'selected':''}>📁 Google Drive</option>
                        <option value="r2" ${target.provider_type === 'r2' || target.provider_type === 'cloudflare' ? 'selected':''}>🟠 Cloudflare R2</option>
                        <option value="minio" ${target.provider_type === 'minio'?'selected':''}>MinIO</option>
                        <option value="s3" ${target.provider_type === 's3'?'selected':''}>S3 / MinIO</option>
                        <option value="azure" ${target.provider_type === 'azure'?'selected':''}>Azure Blob</option>
                        <option value="adls" ${target.provider_type === 'adls'?'selected':''}>Azure Data Lake (ADLS)</option>
                        <option value="hdfs" ${target.provider_type === 'hdfs'?'selected':''}>HDFS / On-Prem</option>
                        <option value="local" ${target.provider_type === 'local'?'selected':''}>Local Filesystem</option>
                        <option value="databricks" ${target.provider_type === 'databricks'?'selected':''}>Databricks (DBFS)</option>
                    </select>
                </div>
                <div><label class="cfg-lbl" id="lbl-endpoint">Endpoint URL</label><input id="tgt-endpoint" class="cfg-input" placeholder="https://<ACCOUNT_ID>.r2.cloudflarestorage.com" value="${target.endpoint || ''}"></div>
                <div id="krb-fields-edit" style="display:${target.provider_type==='hdfs'?'block':'none'}; border-top:1px solid var(--border); padding-top:10px; margin-top:10px;">
                     <div><label class="cfg-lbl" style="color:#fbbf24;">Kerberos Principal</label><input id="tgt-principal" class="cfg-input" value="${target.krb_principal || ''}"></div>
                     <div><label class="cfg-lbl" style="color:#fbbf24;">Kerberos Keytab Path</label><input id="tgt-keytab" class="cfg-input" value="${target.krb_keytab || ''}"></div>
                </div>
                <div><label class="cfg-lbl" id="lbl-bucket">Bucket / Folder ID</label><input id="tgt-bucket" class="cfg-input" placeholder="bucket-name" value="${target.bucket || ''}"></div>
                <div><label class="cfg-lbl" id="lbl-access">Access Key ID / Account Email</label><input id="tgt-access" class="cfg-input" value="${target.access_key || ''}"></div>
                <div><label class="cfg-lbl" id="lbl-secret">Secret Access Key / Private Key (Optional)</label><input id="tgt-secret" class="cfg-input" type="password" value="${target.secret_key || ''}"></div>
                <div><label class="cfg-lbl">Region</label><input id="tgt-region" class="cfg-input" placeholder="auto" value="${target.region || ''}"></div>
            </div>
            <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:20px;">
                <button class="btn btn-secondary" onclick="window.showAdminTab('targets')">Cancel</button>
                <button class="btn btn-primary" onclick="window.saveTarget('${targetId || ''}')">💾 ${targetId ? 'Update' : 'Create'} Target</button>
            </div>
        </div>
    `;
};

window.handleTargetTypeChange = (type) => {
    const krb = document.getElementById('krb-fields-edit');
    if (krb) krb.style.display = type === 'hdfs' ? 'block' : 'none';
    const endpointInput = document.getElementById('tgt-endpoint');
    const bucketLabel = document.getElementById('lbl-bucket');
    const bucketInput = document.getElementById('tgt-bucket');
    const regionInput = document.getElementById('tgt-region');

    if (type === 'gdrive') {
        if (endpointInput && !endpointInput.value) endpointInput.value = 'https://www.googleapis.com/drive/v3';
        if (bucketLabel) bucketLabel.innerText = 'Folder ID (or root)';
        if (bucketInput && !bucketInput.value) bucketInput.value = 'root';
    } else if (type === 'r2' || type === 'cloudflare') {
        if (endpointInput) endpointInput.placeholder = 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com';
        if (bucketLabel) bucketLabel.innerText = 'R2 Bucket Name';
        if (regionInput && !regionInput.value) regionInput.value = 'auto';
    } else {
        if (bucketLabel) bucketLabel.innerText = 'Bucket / Container';
    }
};

window.fillDemoGDrive = () => {
    document.getElementById('tgt-name').value = 'Enterprise Google Drive Lake';
    document.getElementById('tgt-type').value = 'gdrive';
    document.getElementById('tgt-endpoint').value = 'https://www.googleapis.com/drive/v3';
    document.getElementById('tgt-bucket').value = 'root';
    document.getElementById('tgt-access').value = 'demo-service-account@google-drive-lake.iam.gserviceaccount.com';
    document.getElementById('tgt-secret').value = 'demo-private-key';
    document.getElementById('tgt-region').value = 'global';
};

window.saveTarget = async (id) => {
    const payload = {
        target_name: document.getElementById('tgt-name').value,
        provider_type: document.getElementById('tgt-type').value,
        endpoint: document.getElementById('tgt-endpoint').value,
        bucket: document.getElementById('tgt-bucket').value,
        credentials: `${document.getElementById('tgt-access').value}:${document.getElementById('tgt-secret').value}`,
        region: document.getElementById('tgt-region').value,
        krb_principal: document.getElementById('tgt-principal')?.value || '',
        krb_keytab: document.getElementById('tgt-keytab')?.value || ''
    };

    try {
        const url = id ? `/api/admin/targets/${id}` : '/api/admin/targets';
        const method = id ? 'PUT' : 'POST';
        const data = await apiFetch(url, { method, body: JSON.stringify(payload) });
        if (data.success) {
            window.showAdminTab('targets');
            loadTargets(); // refresh sidebar
        } else { alert("Error: " + data.error); }
    } catch (e) { alert("Save failed"); }
};

window.deleteTarget = async (id) => {
    if (!confirm("Are you sure you want to remove this target? This action is irreversible.")) return;
    try {
        const data = await apiFetch(`/api/admin/targets/${id}`, { method: 'DELETE' });
        if (data.success) {
            window.showAdminTab('targets');
            loadTargets();
        }
    } catch (err) { alert("Delete failed"); }
};

// ── Permission Management ──
window.savePermission = async (userId, targetId) => {
    const row = document.getElementById(`perm-row-${userId}-${targetId}`);
    const can_read = row.querySelector('.perm-chk[data-type="read"]').checked ? 1 : 0;
    const can_write = row.querySelector('.perm-chk[data-type="write"]').checked ? 1 : 0;
    const can_delete = row.querySelector('.perm-chk[data-type="delete"]').checked ? 1 : 0;

    try {
        const data = await apiFetch('/api/admin/permissions', {
            method: 'POST',
            body: JSON.stringify({ subject_id: userId, subject_type: 'user', target_id: targetId, can_read, can_write, can_delete })
        });
        if (data.success) {
            alert("✅ Permission updated successfully!");
        } else {
            alert("❌ Update failed: " + data.error);
        }
    } catch (err) {
        alert("❌ Request failed");
    }
};

window.saveUserRole = async (userId) => {
    const role = document.getElementById(`role-sel-${userId}`).value;
    const data = await apiFetch(`/api/admin/users/${userId}`, { method: 'PUT', body: JSON.stringify({ role }) });
    if (data.success) {
        showStatus('User role updated successfully', 'success');
        window.showAdminTab('users');
    }
};

window.createNewUser = async () => {
    const email = document.getElementById('new-user-email').value;
    const password = document.getElementById('new-user-pass').value;
    const role = document.getElementById('new-user-role').value;

    if (!email || !password) {
        showStatus('Email and password required', 'error');
        return;
    }

    try {
        const data = await apiFetch('/api/admin/users', {
            method: 'POST',
            body: JSON.stringify({ email, password, role })
        });

        if (data.success) {
            showStatus(`User ${email} created successfully`, 'success');
            window.showAdminTab('users'); // Refresh list
        } else {
            showStatus(data.error || 'Failed to create user', 'error');
        }
    } catch (err) {
        showStatus('Error creating user', 'error');
    }
};

window.deleteUser = async (userId) => {
    // Immediate lookup from global sync state
    const user = (window._adminUsers || []).find(u => u.user_id === userId);
    const email = user ? user.email : 'this user';

    if (!confirm(`Are you sure you want to delete user ${email}?`)) return;
    try {
        const res = await apiFetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
        if (res.success) {
            showStatus(`User ${email} deleted`, 'success');
            window.showAdminTab('users');
        } else {
            showStatus(res.error || 'Delete failed', 'error');
        }
    } catch (err) {
        showStatus('Error deleting user', 'error');
    }
};
window.startMetadataScan = async () => {
    const targetId = document.getElementById('catalog-target-scan').value;
    if (!targetId) return showStatus('Please select a target to scan', 'error');

    const btn = document.getElementById('scan-btn');
    btn.disabled = true;
    btn.innerText = '⌛ Scanning Storage...';
    
    try {
        const data = await apiFetch(`/api/admin/catalog/scan/${targetId}`, { method: 'POST' });
        if (data.success) {
            showStatus(data.message, 'success');
            window.showAdminTab('catalog');
        } else {
            showStatus(data.error || 'Scan failed', 'error');
        }
    } catch (err) {
        showStatus('Error during scanning', 'error');
    } finally {
        btn.disabled = false;
        btn.innerText = '🔍 Start Deep Scan';
    }
};

window.submitSparkJob = async () => {
    const btn = document.getElementById('spark-submit-btn');
    const logs = document.getElementById('spark-logs');
    const params = {
        targetId: document.getElementById('spark-target').value,
        className: document.getElementById('spark-class').value,
        jarPath: document.getElementById('spark-jar').value,
        args: document.getElementById('spark-args').value
    };

    btn.disabled = true;
    btn.innerText = '⌛ Submitting Spark Job...';
    logs.style.display = 'block';
    logs.innerHTML = '<div style="color:#fbbf24;">[System] Initiating spark-submit...</div>';

    try {
        const data = await apiFetch('/api/admin/spark/submit', {
            method: 'POST',
            body: JSON.stringify(params)
        });

        if (data.success) {
            logs.innerHTML += `<div style="color:#10b981; margin-top:10px;">✅ SUCCESS: ${data.message}</div>`;
            logs.innerHTML += `<pre style="margin-top:10px; color:#cbd5e1; white-space:pre-wrap;">${data.output || 'No output'}</pre>`;
            
            if (data.data && Array.isArray(data.data)) {
                if (typeof window.renderResults === 'function') {
                    window.renderResults(data.data);
                }
                const statusEl = document.getElementById('status');
                if (statusEl) {
                    statusEl.innerText = `✅ Spark Success: ${data.data.length} rows returned.`;
                }
                setTimeout(() => {
                    const overlay = document.getElementById('admin-overlay');
                    if (overlay) overlay.style.display = 'none';
                }, 1500);
            }
        } else {
            logs.innerHTML += `<div style="color:#ef4444; margin-top:10px;">❌ FAILED: ${data.message}</div>`;
            logs.innerHTML += `<pre style="margin-top:10px; color:#f87171; white-space:pre-wrap;">${data.output || 'No output'}</pre>`;
        }
    } catch (err) {
        logs.innerHTML += `<div style="color:#ef4444; margin-top:10px;">❌ Error: Request failed.</div>`;
    } finally {
        btn.disabled = false;
        btn.innerText = '🚀 Submit Spark Job';
        logs.scrollTop = logs.scrollHeight;
    }
};
