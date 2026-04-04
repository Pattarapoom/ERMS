/* ============================================================
   app.js — Main Application Controller (Clean UI version)
   ============================================================ */

// ──────────────── State ────────────────
let scheduler = null;
let currentMonth = new Date().getMonth();     // 0-indexed
let currentYear = new Date().getFullYear();
let isAdmin = false;
let currentUser = null; // null or 'admin' or nurseId
let requests = []; // { id, type, senderId, targetId, data, status, createdAt }
let currentTab = 'calendar';  // 'calendar' | 'stats' | 'swapHistory' | 'settings'
let currentSettingsTab = 'nurses';
let selectedSwap = { nurseId: null, dateStr: null, shift: null };
let pendingRole = null;
let bellTab = 'alerts';
let isSidebarCollapsed = false;

// Global configurations (Defaults from data.js)
let activeNurses = [];
let activeQuota = {};
let activeRoleMins = {};
let activeRoleLabels = {};
let activeLeaveLimits = {};
let firebaseDb = null;
let firebaseReady = false;
let monthScheduleUnsubscribe = null;
let requestsUnsubscribe = null;
let lastMobileTodayFocusKey = null;
let suppressFirebaseSync = false; // Prevent Firebase echo from overwriting fresh local writes
const FIREBASE_SOURCE_OF_TRUTH = true;

function normalizeNurses(list) {
    if (!Array.isArray(list)) return [];
    const cleaned = [];
    list.forEach((n) => {
        if (!n || typeof n !== 'object') return;
        const id = String(n.id || n.code || '').trim();
        if (!id) return;
        const name = String(n.name || n.fullName || id).trim();
        let roles = Array.isArray(n.roles) ? n.roles.filter(Boolean) : [];
        if (roles.length === 0 && typeof n.role === 'string' && n.role.trim()) {
            roles = [n.role.trim()];
        }
        if (roles.length === 0) roles = ['Med'];
        const headCode = Number.isFinite(Number(n.headCode)) ? Number(n.headCode) : 5;
        const level = Number.isFinite(Number(n.level)) ? Number(n.level) : 1;
        const isAdminFlag = !!n.isAdmin;
        cleaned.push({
            ...n,
            id,
            name,
            roles,
            headCode,
            level,
            isAdmin: isAdminFlag
        });
    });
    return cleaned;
}

// ──────────────── Init ────────────────
document.addEventListener('DOMContentLoaded', async () => {
    initFirebase();
    
    // Restore user session from localStorage
    const savedUser = localStorage.getItem('erms_user');
    const savedIsAdmin = localStorage.getItem('erms_is_admin');
    if (savedUser) {
        currentUser = savedUser;
        isAdmin = (savedIsAdmin === 'true');
    }
    
    bindEvents(); // Bind events immediately so buttons work!

    if (firebaseReady) {
        // Ensure Firebase is the source of truth before loading local caches
        await syncInitialDataFromFirebase();
    }

    initSettings();
    loadFromStorage();
    loadRequests();
    renderMonthLabel();
    renderUserProfile();

    // Auto-Sync if Global Database is empty but scheduler has nurses (post-restore case)
    if (activeNurses.length === 0 && scheduler && scheduler.nurses && scheduler.nurses.length > 0) {
        activeNurses = JSON.parse(JSON.stringify(scheduler.nurses));
        saveGlobalSettings();
    }

    renderAll();

    if (firebaseReady) {
        subscribeMonthSchedule(currentYear, currentMonth);
        subscribeRequests();
    }
});

// ──────────────── Firebase Sync ────────────────
function initFirebase() {
    try {
        if (typeof firebase === 'undefined' || typeof firebaseConfig === 'undefined') {
            console.warn('[ERMS] Firebase SDK/config not found, using localStorage only.');
            return;
        }
        if (!firebase.apps || firebase.apps.length === 0) {
            firebase.initializeApp(firebaseConfig);
        }
        firebaseDb = firebase.database();
        firebaseReady = true;
    } catch (err) {
        console.error('[ERMS] Firebase init failed:', err);
        firebaseReady = false;
    }
}

function getFirebaseSchedulePath(year = currentYear, month = currentMonth) {
    return `erms/schedules/${year}_${month}`;
}

async function firebaseGet(path) {
    if (!firebaseReady || !firebaseDb) return null;
    try {
        const snapshot = await firebaseDb.ref(path).once('value');
        return snapshot.val();
    } catch (err) {
        console.error(`[ERMS] Firebase read failed at ${path}:`, err);
        return null;
    }
}

async function firebaseSet(path, value) {
    if (!firebaseReady || !firebaseDb) return false;
    try {
        // Add a 5-second timeout to prevent UI hanging
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000));
        await Promise.race([firebaseDb.ref(path).set(value), timeout]);
        return true;
    } catch (err) {
        console.warn(`[ERMS] Firebase write failed or timed out at ${path}, but local copy is safe.`);
        return false;
    }
}

async function firebaseRemove(path) {
    if (!firebaseReady || !firebaseDb) return false;
    try {
        await firebaseDb.ref(path).remove();
        return true;
    } catch (err) {
        console.error(`[ERMS] Firebase remove failed at ${path}:`, err);
        return false;
    }
}

async function syncInitialDataFromFirebase() {
    const [remoteSettings, remoteRequests, remoteSchedule] = await Promise.all([
        firebaseGet('erms/settings'),
        firebaseGet('erms/requests'),
        firebaseGet(getFirebaseSchedulePath())
    ]);

    if (remoteSettings && typeof remoteSettings === 'object') {
        if (Array.isArray(remoteSettings.nurses)) {
            localStorage.setItem('erms_nurses', JSON.stringify(remoteSettings.nurses));
        }
        if (remoteSettings.config && typeof remoteSettings.config === 'object') {
            localStorage.setItem('erms_config', JSON.stringify(remoteSettings.config));
        }
    } else {
        const payload = {
            nurses: (typeof NURSES_REAL !== 'undefined' && Array.isArray(NURSES_REAL) && NURSES_REAL.length > 0)
                ? JSON.parse(JSON.stringify(NURSES_REAL))
                : JSON.parse(JSON.stringify(SAMPLE_NURSES)),
            config: {
                quota: SHIFT_QUOTA,
                roleMins: ROLE_MINIMUMS,
                roleLabels: ROLE_LABELS,
                leaveLimits: LEAVE_LIMITS_BY_LEVEL
            },
            updatedAt: new Date().toISOString()
        };
        localStorage.setItem('erms_nurses', JSON.stringify(payload.nurses));
        localStorage.setItem('erms_config', JSON.stringify(payload.config));
        if (FIREBASE_SOURCE_OF_TRUTH) {
            void firebaseSet('erms/settings', payload);
        }
    }

    if (Array.isArray(remoteRequests)) {
        localStorage.setItem('erms_requests', JSON.stringify(remoteRequests));
    } else {
        localStorage.setItem('erms_requests', JSON.stringify([]));
        if (FIREBASE_SOURCE_OF_TRUTH) {
            void firebaseSet('erms/requests', []);
        }
    }

    if (remoteSchedule && typeof remoteSchedule === 'object') {
        localStorage.setItem(getStorageKey(), JSON.stringify(remoteSchedule));
    } else {
        // Firebase is source of truth; clear any stale local cache for this month
        localStorage.removeItem(getStorageKey());
    }
}

async function syncMonthFromFirebase(year = currentYear, month = currentMonth) {
    const remoteSchedule = await firebaseGet(getFirebaseSchedulePath(year, month));
    if (remoteSchedule && typeof remoteSchedule === 'object') {
        localStorage.setItem(getStorageKey(year, month), JSON.stringify(remoteSchedule));
    }
}

function saveSettingsToFirebase() {
    const payload = {
        nurses: activeNurses,
        config: {
            quota: activeQuota,
            roleMins: activeRoleMins,
            roleLabels: activeRoleLabels,
            leaveLimits: activeLeaveLimits
        },
        updatedAt: new Date().toISOString()
    };
    void firebaseSet('erms/settings', payload);
}

function subscribeMonthSchedule(year = currentYear, month = currentMonth) {
    if (!firebaseReady || !firebaseDb) return;
    if (monthScheduleUnsubscribe) {
        monthScheduleUnsubscribe();
        monthScheduleUnsubscribe = null;
    }

    const path = getFirebaseSchedulePath(year, month);
    const ref = firebaseDb.ref(path);
    const handler = (snapshot) => {
        // Skip if we just wrote data locally — prevent Firebase echo from overwriting
        if (suppressFirebaseSync) return;

        const data = snapshot.val();
        if (!data || typeof data !== 'object') return;
        localStorage.setItem(getStorageKey(year, month), JSON.stringify(data));
        if (year === currentYear && month === currentMonth) {
            loadFromStorage();
            renderAll();
        }
    };
    ref.on('value', handler);
    monthScheduleUnsubscribe = () => ref.off('value', handler);
}

function subscribeRequests() {
    if (!firebaseReady || !firebaseDb) return;
    if (requestsUnsubscribe) {
        requestsUnsubscribe();
        requestsUnsubscribe = null;
    }

    const ref = firebaseDb.ref('erms/requests');
    let isFirstSnapshot = true;
    const handler = (snapshot) => {
        const prevIds = new Set(requests.map(r => r.id));
        const data = snapshot.val();
        requests = Array.isArray(data) ? data : [];
        localStorage.setItem('erms_requests', JSON.stringify(requests));

        if (!isFirstSnapshot && isAdmin) {
            const newPending = requests.filter(r =>
                !prevIds.has(r.id) && typeof r.status === 'string' && r.status.includes('pending')
            );
            if (newPending.length > 0) {
                showToast('info', `มีคำขอใหม่ ${newPending.length} รายการ`);
            }
        }
        isFirstSnapshot = false;

        if (currentTab === 'requestStatus') renderRequestStatus();
        if (currentTab === 'approval') renderApprovalView();
        renderAll();
    };

    ref.on('value', handler);
    requestsUnsubscribe = () => ref.off('value', handler);
}

// ──────────────── Settings Persistence ────────────────
function initSettings() {
    const nurses = localStorage.getItem('erms_nurses');
    if (nurses) {
        try {
            activeNurses = JSON.parse(nurses);
        } catch (e) {
            activeNurses = [];
        }
    }
    if (!Array.isArray(activeNurses) || activeNurses.length === 0) {
        if (typeof NURSES_REAL !== 'undefined' && Array.isArray(NURSES_REAL) && NURSES_REAL.length > 0) {
            activeNurses = JSON.parse(JSON.stringify(NURSES_REAL));
        } else {
            activeNurses = JSON.parse(JSON.stringify(SAMPLE_NURSES));
        }
        // Auto-save to localStorage for next time
        localStorage.setItem('erms_nurses', JSON.stringify(activeNurses));
    }

    activeNurses = normalizeNurses(activeNurses);
    localStorage.setItem('erms_nurses', JSON.stringify(activeNurses));

    const config = localStorage.getItem('erms_config');
    if (config) {
        const c = JSON.parse(config);
        activeQuota = c.quota || SHIFT_QUOTA;
        activeRoleMins = c.roleMins || ROLE_MINIMUMS;
        activeRoleLabels = c.roleLabels || ROLE_LABELS;
        activeLeaveLimits = c.leaveLimits || LEAVE_LIMITS_BY_LEVEL;

        // Sync with global constants for scheduler
        Object.assign(SHIFT_QUOTA, activeQuota);
        Object.assign(ROLE_MINIMUMS, activeRoleMins);
        Object.assign(ROLE_LABELS, activeRoleLabels);
    } else {
        activeQuota = { ...SHIFT_QUOTA };
        activeRoleMins = { ...ROLE_MINIMUMS };
        activeRoleLabels = { ...ROLE_LABELS };
        activeLeaveLimits = { ...LEAVE_LIMITS_BY_LEVEL };
    }

    if (!activeLeaveLimits || typeof activeLeaveLimits !== 'object') {
        activeLeaveLimits = { ...LEAVE_LIMITS_BY_LEVEL };
    }
}

function saveGlobalSettings() {
    activeNurses = normalizeNurses(activeNurses);
    localStorage.setItem('erms_nurses', JSON.stringify(activeNurses));
    localStorage.setItem('erms_config', JSON.stringify({
        quota: activeQuota,
        roleMins: activeRoleMins,
        roleLabels: activeRoleLabels,
        leaveLimits: activeLeaveLimits
    }));
    saveSettingsToFirebase();
}

// ──────────────── User Identity ────────────────
function renderUserProfile() {
    const sidebarProfile = document.getElementById('sidebarUserProfile');
    const actionArea = document.getElementById('authActionArea');
    if (!sidebarProfile || !actionArea) return;

    if (!currentUser) {
        sidebarProfile.innerHTML = '';
        sidebarProfile.classList.add('hidden');

        // Super prominent login button
        actionArea.innerHTML = `
            <button class="btn-login-trigger-prominent" onclick="openLoginOverlay()">
                <span class="material-symbols-rounded">login</span>
                <span>เข้าสู่ระบบ</span>
            </button>`;
    } else {
        let name = currentUser;
        let role = 'เจ้าหน้าที่พยาบาล';
        const nurse = activeNurses.find(n => n.id === currentUser);

        if (currentUser === 'admin') {
            name = 'ผู้ดูแลระบบ (Root Admin)';
            role = 'Administrator';
        } else if (nurse) {
            name = nurse.name;
            if (isAdmin) {
                role = 'พยาบาล (สิทธิ์ดูแลระบบ)';
            }
        }

        // Render Name and Role in SIDEBAR
        sidebarProfile.classList.remove('hidden');
        sidebarProfile.innerHTML = `
            <div class="sidebar-user-card">
                <div class="user-avatar-small">
                    <span class="material-symbols-rounded">${isAdmin ? 'admin_panel_settings' : 'account_circle'}</span>
                </div>
                <div class="user-details">
                    <div class="user-name-sidebar">${escHtml(name)}</div>
                    <div class="user-role-sidebar">${role}</div>
                </div>
            </div>`;

        // Render Logout button at the far right of header
        actionArea.innerHTML = `
            <button class="btn-logout-prominent" onclick="userLogout()">
                <span class="material-symbols-rounded">logout</span>
                <span>ออกจากระบบ</span>
            </button>`;
    }
}

function openLoginOverlay() {
    // Clear inputs
    const userIn = document.getElementById('loginUsername');
    const passIn = document.getElementById('loginPassword');
    if (userIn) userIn.value = '';
    if (passIn) passIn.value = '';

    // Mobile: bring viewport to top before opening login modal
    if (window.matchMedia('(max-width: 900px)').matches) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    openModal('loginModal');
}

function handleLogin() {
    const user = document.getElementById('loginUsername').value.trim();
    const pass = document.getElementById('loginPassword').value;

    if (!user || !pass) {
        showToast('error', 'กรุณาระบุรหัสผู้ใช้งานและรหัสผ่าน');
        return;
    }

    let success = false;
    let targetRole = null;

    if (user.toLowerCase() === 'admin' && pass === ADMIN_PASSWORD) {
        success = true;
        targetRole = 'admin';
        isAdmin = true;
    } else {
        // Find nurse by ID
        const nurse = activeNurses.find(n => n.id.toLowerCase() === user.toLowerCase());
        if (nurse && pass === nurse.id) {
            success = true;
            targetRole = nurse.id;
            // Admin if explicitly marked OR has 'Head' role
            isAdmin = !!nurse.isAdmin || (nurse.roles && nurse.roles.includes('Head'));
        }
    }

    if (success) {
        currentUser = targetRole;
        // Persist session so page refresh doesn't log out
        localStorage.setItem('erms_user', currentUser);
        localStorage.setItem('erms_is_admin', isAdmin ? 'true' : 'false');

        updateVisibility();
        closeModal('loginModal');
        renderAll();

        const name = isAdmin ? 'หัวหน้าเวร' : (activeNurses.find(n => n.id === currentUser)?.name || currentUser);
        showToast('success', `ยินดีต้อนรับ: ${name}`);
    } else {
        showToast('error', 'ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง');
    }
}

function updateVisibility() {
    const isLogged = !!currentUser;
    document.body.classList.toggle('is-admin', !!isAdmin);

    // Toggle login-only elements
    document.querySelectorAll('.login-only').forEach(el => {
        el.classList.toggle('hidden', !isLogged);
    });

    // Toggle admin-only elements
    document.querySelectorAll('.admin-only').forEach(el => {
        el.classList.toggle('hidden', !isAdmin);
    });

    // Toggle FAB
    const fab = document.getElementById('fabLeave');
    if (fab) fab.classList.toggle('hidden', !isLogged);
}

function userLogout() {
    if (!confirm('ยืนยันออกจากระบบ?')) return;
    currentUser = null;
    isAdmin = false;
    localStorage.removeItem('erms_user');
    localStorage.removeItem('erms_is_admin');

    updateVisibility();
    switchTab('calendar');

    renderAll();
    showToast('info', 'ออกจากระบบเรียบร้อยแล้ว');
}

// ──────────────── Requests ────────────────
function loadRequests() {
    const raw = localStorage.getItem('erms_requests');
    requests = raw ? JSON.parse(raw) : [];
}

function saveRequests() {
    localStorage.setItem('erms_requests', JSON.stringify(requests));
    void firebaseSet('erms/requests', requests);
}

function addRequest(type, data) {
    if (!currentUser) {
        showToast('warning', 'กรุณาเข้าสู่ระบบก่อนทำรายการ');
        openLoginOverlay();
        return;
    }
    const nurse = activeNurses.find(n => n.id === currentUser);
    const req = {
        id: Date.now().toString(),
        type,
        senderId: currentUser,
        senderName: isAdmin ? 'Admin' : (nurse ? nurse.name : currentUser),
        targetId: type === 'swap' ? data.targetNurseId : 'admin',
        data,
        status: type === 'leave' ? 'pending_admin' : 'pending_target',
        createdAt: new Date().toISOString()
    };
    requests.push(req);
    saveRequests();
    renderAll();
    showToast('success', 'ส่งคำขอเรียบร้อยแล้ว');
}

// ──────────────── LocalStorage ────────────────
function getStorageKey(year = currentYear, month = currentMonth) {
    return `erms_${year}_${month}`;
}

async function saveToStorage() {
    if (!scheduler) return;
    const data = scheduler.toJSON();
    data.nurses = activeNurses; // Save current set of nurses
    localStorage.setItem(getStorageKey(), JSON.stringify(data));

    // Suppress Firebase echo — prevent our own write from triggering a reload
    suppressFirebaseSync = true;
    setTimeout(() => { suppressFirebaseSync = false; }, 5000);

    if (firebaseReady) {
        return await firebaseSet(getFirebaseSchedulePath(), data);
    }
    return true;
}

function loadFromStorage() {
    const raw = localStorage.getItem(getStorageKey());
    if (raw) {
        try {
            const data = JSON.parse(raw);
            // Use saved nurses in data or the global set
            const nurseData = normalizeNurses(data.nurses || activeNurses);
            scheduler = new NurseScheduler(nurseData, currentMonth, currentYear);
            scheduler.loadFromJSON(data);
        } catch (e) {
            scheduler = null;
        }
    } else {
        scheduler = null;
    }
}

// ──────────────── Events ────────────────
function bindEvents() {
    document.getElementById('prevMonth').addEventListener('click', () => changeMonth(-1));
    document.getElementById('nextMonth').addEventListener('click', () => changeMonth(1));
    // adminLogin listener removed (moved to handleLogin in HTML)
    document.getElementById('fabLeave').addEventListener('click', () => openLeaveModal());
    document.getElementById('leaveSubmit').addEventListener('click', submitLeave);
    document.getElementById('swapConfirm').addEventListener('click', confirmSwap);

    // Close modals
    document.querySelectorAll('.modal-close').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const modal = e.target.closest('.modal-overlay');
            if (modal) modal.classList.remove('active');
        });
    });

    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.classList.remove('active');
        });
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
            closeBellDropdown();
        }
    });

    // Close bell dropdown on click outside
    document.addEventListener('click', (e) => {
        const wrapper = document.getElementById('bellWrapper');
        if (wrapper && !wrapper.contains(e.target) && !e.target.closest('#navAlerts')) {
            closeBellDropdown();
        }
    });
}

// ──────────────── Sidebar ────────────────
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const layout = document.querySelector('.app-layout');
    if (!sidebar) return;

    if (window.matchMedia('(max-width: 900px)').matches) {
        sidebar.classList.toggle('open');
        return;
    }

    // Desktop: force full menu (no collapsed icon-only mode)
    isSidebarCollapsed = false;
    localStorage.setItem('erms_sidebar_collapsed', 'false');
    sidebar.classList.remove('collapsed');
    if (layout) layout.classList.remove('sidebar-collapsed');
}

// ──────────────── Month Navigation ────────────────
function setCurrentMonthYear(year, monthIndex) {
    currentYear = year;
    currentMonth = monthIndex;

    // Update UI immediately from local data
    renderMonthLabel();
    loadFromStorage();
    renderAll();

    // Background sync
    if (firebaseReady) {
        syncMonthFromFirebase(currentYear, currentMonth); // No await, let it happen background
        subscribeMonthSchedule(currentYear, currentMonth);
    }
}

async function changeMonth(delta) {
    currentMonth += delta;
    if (currentMonth > 11) { currentMonth = 0; currentYear++; }
    if (currentMonth < 0) { currentMonth = 11; currentYear--; }

    setCurrentMonthYear(currentYear, currentMonth);
}

const THAI_MONTHS = [
    'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
    'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'
];

const DAY_NAMES_TH = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
const DAY_NAMES_SHORT = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];

function renderMonthLabel() {
    const thaiYear = currentYear + 543;
    document.getElementById('monthLabel').textContent = `${THAI_MONTHS[currentMonth]} ${thaiYear}`;
}

// ──────────────── Tab Switching ────────────────
function switchTab(tab) {
    currentTab = tab;

    // Update sidebar active
    document.getElementById('navCalendar').classList.toggle('active', tab === 'calendar');
    document.getElementById('navStats').classList.toggle('active', tab === 'stats');
    const navNurseSummary = document.getElementById('navNurseSummary');
    if (navNurseSummary) navNurseSummary.classList.toggle('active', tab === 'nurseSummary');
    const navSwap = document.getElementById('navSwapHistory');
    if (navSwap) navSwap.classList.toggle('active', tab === 'swapHistory');
    const navRequest = document.getElementById('navRequestStatus');
    if (navRequest) navRequest.classList.toggle('active', tab === 'requestStatus');
    const navApproval = document.getElementById('navApproval');
    if (navApproval) navApproval.classList.toggle('active', tab === 'approval');
    const navSet = document.getElementById('navSettings');
    if (navSet) navSet.classList.toggle('active', tab === 'settings');

    // Update views
    document.getElementById('calendarView').classList.toggle('hidden', tab !== 'calendar');
    document.getElementById('statsView').classList.toggle('hidden', tab !== 'stats');
    const nsView = document.getElementById('nurseSummaryView');
    if (nsView) nsView.classList.toggle('hidden', tab !== 'nurseSummary');
    document.getElementById('swapHistoryView').classList.toggle('hidden', tab !== 'swapHistory');
    document.getElementById('requestStatusView').classList.toggle('hidden', tab !== 'requestStatus');
    document.getElementById('approvalView').classList.toggle('hidden', tab !== 'approval');
    document.getElementById('settingsView').classList.toggle('hidden', tab !== 'settings');

    // Toggle Toolbar (only show on calendar/stats)
    const toolbar = document.getElementById('pageToolbar');
    if (toolbar) {
        toolbar.classList.toggle('hidden', !['calendar', 'stats'].includes(tab));
    }

    // Update page title
    const pageInfo = {
        calendar: { icon: 'calendar_month', text: 'ตารางเวรพยาบาล' },
        stats: { icon: 'analytics', text: 'สถิติการทำงาน' },
        nurseSummary: { icon: 'person_search', text: 'สรุปเวรรายบุคคล' },
        swapHistory: { icon: 'history', text: 'ประวัติสลับเวร' },
        requestStatus: { icon: 'fact_check', text: 'สถานะคำขอ' },
        approval: { icon: 'rule_settings', text: 'อนุมัติคำขอ (Admin/Head)' },
        settings: { icon: 'database', text: 'จัดการฐานข้อมูล' }
    };

    const info = pageInfo[tab];
    if (info) {
        const h2 = document.getElementById('pageTitle');
        if (h2) h2.innerHTML = `<span class="material-symbols-rounded">${info.icon}</span> ${info.text}`;

        const breadcrumb = document.getElementById('headerPageTitle');
        if (breadcrumb) breadcrumb.textContent = info.text;
    }

    // Render content
    if (tab === 'stats' && scheduler && scheduler.locked) renderStats();
    if (tab === 'nurseSummary') renderNurseSummary();
    if (tab === 'swapHistory') renderSwapHistory();
    if (tab === 'requestStatus') renderRequestStatus();
    if (tab === 'approval') renderApprovalView();
    if (tab === 'settings') renderSettings();
    // Close sidebar on mobile
    document.getElementById('sidebar').classList.remove('open');
}

function scrollToAlerts() {
    toggleBellDropdown();
}

// ──────────────── Generate Schedule ────────────────
async function generateSchedule() {
    if (!isAdmin) {
        showToast('error', 'เฉพาะหัวหน้าเวรเท่านั้นที่สามารถสร้างตารางได้ (รักษาสิทธิ์ Admin)');
        return;
    }

    try {
        const prevMonth = currentMonth === 0 ? 11 : currentMonth - 1;
        const prevYear = currentMonth === 0 ? currentYear - 1 : currentYear;
        const prevKey = getStorageKey(prevYear, prevMonth);
        const prevDataRaw = localStorage.getItem(prevKey);
        let prevSchedule = {};
        let hasPrev = false;

        if (prevDataRaw) {
            const prevData = JSON.parse(prevDataRaw);
            prevSchedule = prevData.schedule || {};
            hasPrev = true;
        }

    // AUTO-RECOVERY for nurses
    if (!activeNurses || activeNurses.length === 0) {
        const raw = localStorage.getItem('erms_nurses');
        if (raw) {
            try {
                activeNurses = JSON.parse(raw);
            } catch (e) {
                activeNurses = [];
            }
        }
        if (!Array.isArray(activeNurses) || activeNurses.length === 0) {
            if (typeof NURSES_REAL !== 'undefined' && Array.isArray(NURSES_REAL) && NURSES_REAL.length > 0) {
                activeNurses = JSON.parse(JSON.stringify(NURSES_REAL));
            } else if (typeof SAMPLE_NURSES !== 'undefined') {
                activeNurses = JSON.parse(JSON.stringify(SAMPLE_NURSES));
            }
        }
    }

    activeNurses = normalizeNurses(activeNurses);

        if (!activeNurses || activeNurses.length === 0) {
            showToast('error', 'ไม่พบข้อมูลพยาบาลในระบบ กรุณาตรวจสอบการตั้งค่าพยาบาลก่อน');
            return;
        }

        scheduler = new NurseScheduler(activeNurses, currentMonth, currentYear, prevSchedule);
        scheduler.generate();
        
        saveToStorage(); 
        renderAll();
        
        const count = activeNurses.length;
        const msg = hasPrev ? `สร้างตารางพยาบาล ${count} คน สำเร็จ! (ดึงเงื่อนไขต่อจากเดือนที่แล้วเรียบร้อย)` : `สร้างตารางพยาบาล ${count} คน สำเร็จ! (เริ่มตารางใหม่)`;
        showToast('success', msg);
    } catch (err) {
        console.error(err);
        showToast('error', 'เกิดข้อผิดพลาด: ' + err.message);
    }
}

function regenerateSchedule() {
    if (!isAdmin) {
        showToast('error', 'เฉพาะหัวหน้าเวรเท่านั้นที่สามารถสร้างตารางได้');
        return;
    }
    if (!confirm('ต้องการสร้างตารางเวรใหม่หรือไม่?\nข้อมูลการลาและสลับเวรของเดือนนี้จะถูกรีเซ็ต')) return;
    generateSchedule();
}

function clearSchedule() {
    if (!isAdmin) {
        showToast('error', 'เฉพาะหัวหน้าเวรเท่านั้นที่สามารถล้างตารางได้');
        return;
    }
    if (!confirm(`คุณต้องการล้างตารางเวรเดือน ${document.getElementById('monthLabel').innerText} ทั้งหมดใช่หรือไม่?\nข้อมูลจะไม่สามารถกู้คืนได้`)) return;

    localStorage.removeItem(getStorageKey());
    void firebaseRemove(getFirebaseSchedulePath());
    scheduler = null;
    renderAll();
    showToast('success', 'ล้างตารางเวรเรียบร้อยแล้ว');
}

async function copyScheduleFromPreviousMonth() {
    if (!isAdmin) {
        showToast('error', 'เฉพาะหัวหน้าเวรเท่านั้นที่สามารถคัดลอกตารางได้');
        return;
    }

    const prevMonth = currentMonth === 0 ? 11 : currentMonth - 1;
    const prevYear = currentMonth === 0 ? currentYear - 1 : currentYear;
    const prevLabel = `${THAI_MONTHS[prevMonth]} ${prevYear + 543}`;

    if (!confirm(`คัดลอกตารางเวรจากเดือน ${prevLabel} มาเดือนนี้ใช่หรือไม่?\nระบบจะคัดลอกเฉพาะตารางเวร (ไม่รวมลา/สลับเวร)`)) {
        return;
    }

    if (firebaseReady) {
        await syncMonthFromFirebase(prevYear, prevMonth);
    }

    const prevRaw = localStorage.getItem(getStorageKey(prevYear, prevMonth));
    if (!prevRaw) {
        showToast('warning', `ไม่พบข้อมูลเดือน ${prevLabel} ให้คัดลอก`);
        return;
    }

    let prevData;
    try {
        prevData = JSON.parse(prevRaw);
    } catch (err) {
        showToast('error', 'ข้อมูลเดือนก่อนหน้าเสียหาย ไม่สามารถคัดลอกได้');
        return;
    }

    if (!prevData || typeof prevData.schedule !== 'object') {
        showToast('warning', `ข้อมูลเดือน ${prevLabel} ยังไม่มีตารางเวร`);
        return;
    }

    scheduler = new NurseScheduler(activeNurses, currentMonth, currentYear);

    const nurseMap = new Map(activeNurses.map(n => [n.id, n]));
    const pad = (n) => String(n).padStart(2, '0');
    const prevPrefix = `${prevYear}-${pad(prevMonth + 1)}-`;

    let copiedDays = 0;
    let copiedAssignments = 0;
    let skippedUnknownNurse = 0;

    for (let day = 1; day <= scheduler.daysInMonth; day++) {
        const currDateStr = scheduler.dateStr(day);
        const prevDateStr = `${prevPrefix}${pad(day)}`;
        const prevDay = prevData.schedule[prevDateStr];

        scheduler.schedule[currDateStr] = { M: [], A: [], N: [] };
        if (!prevDay) continue;

        let hasCopiedThisDay = false;
        for (const shift of ['M', 'A', 'N']) {
            const srcAssignments = Array.isArray(prevDay[shift]) ? prevDay[shift] : [];
            srcAssignments.forEach(a => {
                if (!a || (a.nurseId == null && !a.isShortage)) return;

                if (a.isShortage) {
                    scheduler.schedule[currDateStr][shift].push({
                        nurseId: null,
                        nurseName: '(ขาดคน)',
                        role: a.role || 'Med',
                        roleLabel: ROLE_LABELS[a.role] || a.role || ROLE_LABELS['Med'] || 'Med',
                        isLeave: false,
                        isShortage: true
                    });
                    hasCopiedThisDay = true;
                    copiedAssignments++;
                    return;
                }

                const nurse = nurseMap.get(a.nurseId);
                if (!nurse) {
                    skippedUnknownNurse++;
                    return;
                }

                const role = a.role || 'Med';
                scheduler.schedule[currDateStr][shift].push({
                    nurseId: nurse.id,
                    nurseName: nurse.name,
                    role,
                    roleLabel: ROLE_LABELS[role] || role,
                    isLeave: false,
                    isShortage: !!a.isShortage
                });
                hasCopiedThisDay = true;
                copiedAssignments++;
            });
        }

        if (hasCopiedThisDay) copiedDays++;
    }

    scheduler.leaves = {};
    scheduler.swaps = [];
    scheduler.locked = true;
    scheduler.rebuildCounters();

    saveToStorage();
    renderAll();

    if (copiedAssignments === 0) {
        showToast('warning', `ไม่พบเวรที่คัดลอกได้จากเดือน ${prevLabel}`);
        return;
    }

    const skipMsg = skippedUnknownNurse > 0 ? ` (ข้าม ${skippedUnknownNurse} รายการ: ไม่พบรหัสพยาบาล)` : '';
    showToast('success', `คัดลอกเวรแล้ว ${copiedDays} วัน / ${copiedAssignments} รายการ${skipMsg}`);
}

// ──────────────── Main Render ────────────────
function renderAll() {
    // Apply sidebar state immediately
    const sidebar = document.getElementById('sidebar');
    const layout = document.querySelector('.app-layout');
    if (sidebar && layout) {
        sidebar.classList.toggle('collapsed', isSidebarCollapsed);
        layout.classList.toggle('sidebar-collapsed', isSidebarCollapsed);
    }

    updateVisibility();
    renderStatus(); // Keep renderStatus here as it updates buttons based on scheduler state
    renderUserProfile(); // Update profile area
    if (scheduler) {
        renderCalendar();
        focusTodayOnMobile();
        if (currentTab === 'stats') renderStats(); // Only render stats if scheduler exists and is locked (handled by renderStats itself)
        renderNotifications();
        updateAlertBadge();
    } else {
        renderEmptyState();
    }
}

function focusTodayOnMobile() {
    if (!scheduler) return;
    if (!window.matchMedia('(max-width: 900px)').matches) return;
    if (currentTab !== 'calendar') return;

    const now = new Date();
    if (currentYear !== now.getFullYear() || currentMonth !== now.getMonth()) return;

    const key = `${currentYear}_${currentMonth}`;
    if (lastMobileTodayFocusKey === key) return;

    const todayCard = document.querySelector('.day-card.today');
    if (!todayCard) return;

    setTimeout(() => {
        todayCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
        lastMobileTodayFocusKey = key;
    }, 50);
}

function renderStatus() {
    const statusEl = document.getElementById('statusBadges');
    const btnGen = document.getElementById('btnGenerate');
    const btnRegen = document.getElementById('btnRegenerate');
    const btnDel = document.getElementById('btnDelete');

    // btnExport is now handled via navExport in sidebar, but if there's a floating one:
    const btnExport = document.getElementById('btnExport');

    if (!scheduler || !scheduler.locked) {
        statusEl.innerHTML = `<span class="status-badge badge-unlocked"><span class="material-symbols-rounded" style="font-size:16px">lock_open</span> ยังไม่ถูกจัด</span>`;
        if (btnExport) btnExport.disabled = true;
        if (btnRegen) btnRegen.classList.add('hidden');
        if (btnGen) btnGen.classList.toggle('hidden', !isAdmin);
        if (btnDel) btnDel.classList.add('hidden');
    } else {
        statusEl.innerHTML = `
      <span class="status-badge badge-locked"><span class="material-symbols-rounded" style="font-size:16px">lock_clock</span> ตารางพร้อม</span>
      <span class="status-badge badge-workforce"><span class="material-symbols-rounded" style="font-size:16px">people</span> ${scheduler.nurses.length} คน</span>
    `;
        if (btnExport) btnExport.disabled = false;
        if (btnRegen) btnRegen.classList.toggle('hidden', !isAdmin);
        if (btnGen) btnGen.classList.add('hidden');
        if (btnDel) btnDel.classList.toggle('hidden', !isAdmin);
    }

    // Additional security: Hide Gen/Regen/Del completely from nurses
    if (!isAdmin) {
        if (btnGen) btnGen.classList.add('hidden');
        if (btnRegen) btnRegen.classList.add('hidden');
        if (btnDel) btnDel.classList.add('hidden');
    }

    // Firebase Status Badge
    const fbStatus = firebaseReady ? 
        `<span class="status-badge" style="background:#e8f5e9; color:#2e7d32; border:1px solid #c8e6c9"><span class="material-symbols-rounded" style="font-size:16px">cloud_done</span> Cloud Sync</span>` :
        `<span class="status-badge" style="background:#ffebee; color:#c62828; border:1px solid #ffcdd2"><span class="material-symbols-rounded" style="font-size:16px">cloud_off</span> Local Only</span>`;
    statusEl.innerHTML += fbStatus;
}

function renderEmptyState() {
    const cal = document.getElementById('calendarView');
    const mLabel = document.getElementById('monthLabel').innerText;

    let adminAction = '';
    if (isAdmin) {
        adminAction = `
            <button class="btn btn-primary" onclick="generateSchedule()" style="margin-top:20px; padding:12px 24px; font-size:16px">
                <span class="material-symbols-rounded">bolt</span> สร้างตารางเวรเดือน${mLabel}
            </button>
        `;
    }

    cal.innerHTML = `
    <div class="empty-state">
      <span class="material-symbols-rounded empty-icon" style="font-size:80px; color:var(--gray-300)">calendar_today</span>
      <h2 style="margin-top:16px">เดือน${mLabel} ยังไม่ถูกจัด</h2>
      <p style="color:var(--text-muted)">ยังไม่มีข้อมูลการจัดตารางเวรสำหรับเดือนนี้ในระบบ</p>
      ${adminAction}
    </div>
  `;
}

// ──────────────── Calendar Render ────────────────
function renderCalendar() {
    // Guard: if no schedule data, show empty state instead of crashing
    if (!scheduler || !scheduler.schedule) {
        renderEmptyState();
        return;
    }

    const cal = document.getElementById('calendarView');
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    let html = '';

    // Day headers (Sun-Sat)
    html += '<div class="calendar-header-grid">';
    DAY_NAMES_SHORT.forEach(name => {
        html += `<div class="calendar-header-day">${name}</div>`;
    });
    html += '</div>';

    html += '<div class="calendar-grid">';

    // Padding for first day of month (0 is Sunday)
    const firstDayDow = scheduler.getDayOfWeek(1);
    for (let i = 0; i < firstDayDow; i++) {
        html += '<div class="day-card empty"></div>';
    }

    for (let day = 1; day <= scheduler.daysInMonth; day++) {
        const ds = scheduler.dateStr(day);
        const isToday = ds === todayStr;
        const isWknd = scheduler.isWeekend(day);
        const dow = scheduler.getDayOfWeek(day);
        const daySchedule = scheduler.schedule[ds];
        const dayLeaves = ((scheduler.leaves || {}))[ds] || [];

        // Pending Request Indicators
        const dayPendingSwaps = requests.filter(r =>
            r.type === 'swap' && r.status.includes('pending') && r.data.dateStr === ds
        );
        const dayPendingLeaves = requests.filter(r =>
            r.type === 'leave' && r.status === 'pending_admin' &&
            ds >= r.data.startDate && ds <= r.data.endDate
        );

        html += `<div class="day-card ${isToday ? 'today' : ''} ${isWknd ? 'weekend' : ''}" data-date="${ds}">`;

        // Header
        html += `
            <div class="day-card-header">
                <div class="day-info">
                    <span class="day-num">${day}</span>
                    <span class="day-name">${DAY_NAMES_SHORT[dow]}</span>
                </div>
            </div>`;

        // Leave box (Condensed for grid)
        if (dayLeaves.length > 0) {
            html += `<div class="leave-box mini">
                <div class="leave-list mini">`;
            dayLeaves.forEach(l => {
                const cls = (l.urgent ? 'leave-urgent' : 'leave-normal') + (isAdmin || l.nurseId === currentUser ? ' clickable' : '');
                const onclick = (isAdmin || l.nurseId === currentUser) ? `onclick="removeLeaveManually('${l.nurseId}', '${ds}')"` : '';
                html += `<span class="leave-tag mini ${cls}" title="ลา: ${escAttr(l.nurseName)}" ${onclick}>${escHtml(l.nurseName.split(' ')[0])}</span>`;
            });
            html += `</div></div>`;
        }

        // Shifts
        if (daySchedule) {
            for (const shift of ['M', 'A', 'N']) {
                const assignments = daySchedule[shift] || [];
                if (assignments.length === 0) continue;

                const working = assignments.filter(a => !a.isLeave && !a.isShortage);

                html += `<div class="shift-mini-section shift-${shift}">
                    <div class="shift-mini-header">
                        <span class="shift-label-icon">${shift}</span>
                        <span class="shift-mini-count">${working.length}</span>
                    </div>
                    <div class="nurse-mini-list">`;

                assignments.forEach(a => {
                    const hasPendingSwap = dayPendingSwaps.some(r => r.data.originalNurseId === a.nurseId && r.data.shift === shift);
                    const hasPendingLeave = dayPendingLeaves.some(r => r.data.nurseId === a.nurseId);

                    const clickable = !a.isShortage ? 'clickable' : '';
                    const onclick = !a.isShortage ? `onclick="openSwapModal('${a.nurseId}', '${ds}', '${shift}')"` : '';
                    const leaveCls = a.isLeave ? 'on-leave' : (hasPendingLeave ? 'pending-leave' : '');
                    const pendingDot = hasPendingSwap ? '<span class="pending-dot-mini"></span>' : '';

                    // Role Tag Mapping
                    const roleMapping = {
                        'Head': { short: 'H', color: '#b45309' }, // Amber-700
                        'Incharge1': { short: 'IC1', color: '#7c3aed' }, // Violet-600
                        'Incharge_team': { short: 'ICT', color: '#4338ca' }, // Indigo-700
                        'Fast_track': { short: 'FT', color: '#059669' }, // Emerald-600
                        'Triage': { short: 'TR', color: '#2563eb' }, // Blue-600
                        'Med': { short: 'M', color: '#64748b' }, // Slate-500
                        'Inc_proc': { short: 'IP', color: '#0d9488' }, // Teal-600
                        'Med_proc': { short: 'MP', color: '#0891b2' }, // Cyan-600
                        'Screen_center': { short: 'SC', color: '#ea580c' }, // Orange-600
                        'Screen_6_8': { short: 'S68', color: '#ca8a04' }, // Yellow-600
                        'Proc_16_20': { short: 'P16', color: '#db2777' }, // Pink-600
                        'Preceptor': { short: 'ช+', color: '#7c3aed' } // Violet-600 (morning+)
                    };
                    const rTag = roleMapping[a.role] || { short: a.role.substring(0, 2).toUpperCase(), color: '#94a3b8' };

                    // Clean "พว." prefix and show cleaned name (safe even if nurseName missing)
                    const rawName = a.nurseName || (activeNurses.find(n => n.id === a.nurseId)?.name) || a.nurseId || '';
                    const cleanName = String(rawName).replace(/^(พว\.|พว|พ\.ว\.|พ\.ว|พยาบาล)\s*/, '');

                    html += `<div class="nurse-tag-mini ${leaveCls} ${clickable}" ${onclick}>
                        ${pendingDot}
                        <span class="role-badge-mini" style="background:${rTag.color}">${rTag.short}</span>
                        ${escHtml(cleanName)}
                    </div>`;
                });

                html += `</div></div>`;
            }
        }

        html += `</div>`;
    }

    html += '</div>';
    cal.innerHTML = html;
}










// ──────────────── Notifications (Bell Dropdown) ────────────────
function switchBellTab(tab) {
    bellTab = tab;
    document.getElementById('bTabAlerts').classList.toggle('active', tab === 'alerts');
    document.getElementById('bTabRequests').classList.toggle('active', tab === 'requests');
    renderNotifications();
}

function renderNotifications() {
    const body = document.getElementById('bellBody');
    const reqCountEl = document.getElementById('reqCount');

    // Safety exit if notification elements are removed from UI
    if (!body) return;

    // Authority check: Admin flag or Head role
    const isAuthorized = isAdmin; // isAdmin already includes 'Head' role check from handleLogin

    // Actionable requests for current user
    const actionable = requests.filter(r => {
        if (isAuthorized) return r.status === 'pending_admin';
        return r.targetId === currentUser && r.status === 'pending_target';
    });

    // My sent requests that are still pending
    const mySent = requests.filter(r => r.senderId === currentUser && (r.status === 'pending_admin' || r.status === 'pending_target'));

    if (reqCountEl) reqCountEl.innerText = actionable.length;

    let alerts = [];
    if (scheduler && scheduler.locked) {
        for (let day = 1; day <= scheduler.daysInMonth; day++) {
            const ds = scheduler.dateStr(day);
            const a = scheduler.getAlerts(ds);
            a.forEach(item => alerts.push({ ...item, date: ds, day }));
        }
    }

    // Update Badge
    const bellCountBadge = document.getElementById('bellCount');
    const sidebarBadge = document.getElementById('alertBadgeSidebar');
    const totalCount = alerts.length + actionable.length;

    if (totalCount > 0) {
        const label = totalCount > 99 ? '99+' : totalCount;
        if (bellCountBadge) {
            bellCountBadge.innerText = label;
            bellCountBadge.style.display = 'flex';
        }
        if (sidebarBadge) {
            sidebarBadge.innerText = label;
            sidebarBadge.style.display = 'block';
        }
    } else {
        if (bellCountBadge) bellCountBadge.style.display = 'none';
        if (sidebarBadge) sidebarBadge.style.display = 'none';
    }

    if (bellTab === 'alerts') {
        if (alerts.length === 0) {
            body.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:32px;font-size:13px">✨ ยอดเยี่ยม! ไม่มีการขาดเวร</div>';
        } else {
            body.innerHTML = alerts.map(a => `
                <div class="request-item">
                    <div class="request-header">
                        <div class="request-title"><span class="material-symbols-rounded" style="color:var(--error);font-size:18px">warning</span> ${a.type}</div>
                        <span class="request-badge" style="background:#fee2e2;color:#991b1b">ขาดเวร</span>
                    </div>
                    <div class="request-details">
                        <strong>วันที่ ${a.day} ${THAI_MONTHS[currentMonth]}</strong><br>
                        ${escHtml(a.msg)}
                    </div>
                </div>
            `).join('');
        }
    } else {
        // Render Requests
        let html = '';
        if (actionable.length > 0) {
            html += `<div style="padding:12px 16px 4px;font-size:11px;font-weight:800;color:var(--primary);text-transform:uppercase;letter-spacing:1px">คำขอที่ต้องจัดการ (${actionable.length})</div>`;
            html += actionable.map(r => renderRequestItem(r, true)).join('');
        }
        if (mySent.length > 0) {
            html += `<div style="padding:12px 16px 4px;font-size:11px;font-weight:800;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px">คำขอที่คุณส่ง (${mySent.length})</div>`;
            html += mySent.map(r => renderRequestItem(r, false)).join('');
        }
        if (actionable.length === 0 && mySent.length === 0) {
            html = '<div style="text-align:center;color:var(--text-muted);padding:32px;font-size:13px">ไม่มีคำขอที่ค้างอยู่</div>';
        }
        body.innerHTML = html;
    }
}

function renderRequestItem(r, canAction) {
    const d = r.data;
    const isLeave = r.type === 'leave';
    const title = isLeave ? 'ขอลาหยุด' : 'ขอสลับเวร';
    const icon = isLeave ? 'description' : 'swap_horiz';

    const statusLabels = {
        'pending_target': 'รอคนแลกตอบตกลง',
        'pending_admin': 'รอหัวหน้าอนุมัติ',
        'approved': 'อนุมัติแล้ว',
        'rejected': 'ถูกปฏิเสธ'
    };
    const statusLabel = statusLabels[r.status] || r.status;
    const badgeColor = r.status.includes('pending') ? '#fef3c7;color:#92400e' : (r.status === 'approved' ? '#d1fae5;color:#065f46' : '#fee2e2;color:#991b1b');

    let details = '';
    const senderName = r.senderName || activeNurses.find(n => n.id === r.senderId)?.name || r.senderId || 'Unknown User';

    if (isLeave) {
        const leaveLabel = LEAVE_TYPES[d.leaveType]?.label || d.leaveType;
        details = `<strong>${escHtml(senderName)}</strong> ขอลา (${leaveLabel})<br>${d.startDate} ถึง ${d.endDate}`;
        if (d.reason) details += `<br><i style="font-size:11px;color:var(--text-muted)">" ${escHtml(d.reason)} "</i>`;
        if (r.rejectReason) details += `<br><span style="font-size:11px;color:var(--error);font-weight:700">❌ เหตุผลที่ไม่รับ: ${escHtml(r.rejectReason)}</span>`;
    } else {
        const dayNum = d.dateStr.split('-')[2];
        const shiftLabel = SHIFT_LABELS[d.shift] || d.shift;
        if (canAction && !isAdmin) {
            details = `<strong>${escHtml(senderName)}</strong> ขอสลับเวรกะ ${shiftLabel} กับคุณ<br>ในวันที่ ${dayNum} ${THAI_MONTHS[currentMonth]}`;
        } else {
            const targetName = d.targetNurseName || activeNurses.find(n => n.id === d.targetNurseId)?.name || d.targetNurseId || 'Unknown Nurse';
            details = `<strong>${escHtml(senderName)}</strong> ขอสลับเวรกะ ${shiftLabel} กับ <strong>${escHtml(targetName)}</strong><br>ในวันที่ ${dayNum} ${THAI_MONTHS[currentMonth]}`;

            if (d.isEmergency) {
                details += `<div style="margin-top:8px; padding:8px; background:#fff7ed; border:1px solid #ffedd5; border-radius:6px; color:#c2410c; font-size:11px;">
                    <strong style="display:block; margin-bottom:2px;">⚠️ รายการนี้มาจากการอนุโลมกฎ (Emergency):</strong>
                    ${d.violations.map(v => `• ${v}`).join('<br>')}
                </div>`;
            }
        }
        if (r.rejectReason) details += `<br><span style="font-size:11px;color:var(--error);font-weight:700">❌ เหตุผลที่ไม่รับ: ${escHtml(r.rejectReason)}</span>`;
    }

    let actionsHtml = '';
    if (canAction) {
        actionsHtml = `
            <div class="request-actions">
                <button class="req-btn req-btn-approve" onclick="handleRequest('${r.id}', 'approve')">ตกลง / อนุมัติ</button>
                <button class="req-btn req-btn-reject" onclick="handleRequest('${r.id}', 'reject')">ปฏิเสธ</button>
            </div>
        `;
    } else {
        actionsHtml = `<div class="req-status-msg" style="font-size:11px;color:var(--text-muted);text-align:center">สถานะ: ${statusLabel}</div>`;
    }

    return `
        <div class="request-item ${canAction ? 'new' : ''}">
            <div class="request-header">
                <div class="request-title"><span class="material-symbols-rounded" style="font-size:18px">${icon}</span> ${title}</div>
                <span class="request-badge" style="background:${badgeColor}">${statusLabel}</span>
            </div>
            <div class="request-details">${details}</div>
            ${actionsHtml}
        </div>
    `;
}

async function handleRequest(id, action) {
    const r = requests.find(item => item.id === id);
    if (!r) return;

    if (action === 'reject') {
        document.getElementById('rejectRequestId').value = id;
        document.getElementById('rejectReason').value = '';
        openModal('rejectModal');
        return;
    }

    if (r.type === 'leave') {
        const d = r.data;
        const cap = validateLeaveCapacity(d.nurseId, d.startDate, d.endDate);
        if (!cap.ok) {
            showToast('error', `ระดับ ${cap.level} วันที่ ${cap.dateStr} ลาเกินโควต้า (${cap.current}/${cap.limit}) กรุณาคุยกันเองก่อน`);
            return;
        }
        const fmt = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        let applied = 0;
        for (let day = new Date(d.startDate); day <= new Date(d.endDate); day.setDate(day.getDate() + 1)) {
            const ds = fmt(day);
            if (day.getMonth() === currentMonth && day.getFullYear() === currentYear) {
                if (scheduler.addLeave(d.nurseId, ds, d.leaveType, d.urgent, d.reason)) applied++;
            } else {
                if (saveCrossMonthLeave(ds, d.nurseId, d.leaveType, d.urgent, d.reason)) applied++;
            }
        }
        r.status = 'approved';
        await saveToStorage();
        showToast('success', `อนุมัติการลาสำเร็จ (${applied} วัน)`);
    } else if (r.type === 'swap') {
        const isTarget = r.targetId === currentUser;
        const isHead = isAdmin;

        if (r.status === 'pending_target') {
            if (isTarget) {
                r.status = 'pending_admin';
                showToast('success', 'คุณยอมรับการแลกเวรแล้ว (รอหัวหน้าอนุมัติขั้นสุดท้าย)');
            } else if (isHead) {
                // Head Overrides
                const d = r.data;
                const res = scheduler.executeSwap(d.originalNurseId, d.targetNurseId, d.dateStr, d.shift);
                if (res.success) {
                    r.status = 'approved';
                    await saveToStorage();
                    showToast('success', 'หัวหน้าอนุมัติการสลับเวรแทนให้แล้ว (Override)');
                } else {
                    showToast('error', res.error || 'เกิดข้อผิดพลาดในการสลับเวร');
                    return;
                }
            }
        } else if (r.status === 'pending_admin') {
            if (isHead) {
                const d = r.data;
                const res = scheduler.executeSwap(d.originalNurseId, d.targetNurseId, d.dateStr, d.shift);
                if (res.success) {
                    r.status = 'approved';
                    saveToStorage();
                    showToast('success', 'อนุมัติการสลับเวรสำเร็จ!');
                } else {
                    showToast('error', res.error || 'เกิดข้อผิดพลาดในการสลับเวร');
                    return;
                }
            }
        }
    }

    saveRequests();
    renderAll();
}

function submitRejection() {
    const id = document.getElementById('rejectRequestId').value;
    const reason = document.getElementById('rejectReason').value.trim();

    const r = requests.find(item => item.id === id);
    if (r) {
        r.status = 'rejected';
        r.rejectReason = reason || ''; // Optional
        saveRequests();
        closeModal('rejectModal');
        closeBellDropdown();
        renderAll();
        showToast('info', 'ปฏิเสธคำขอเรียบร้อยแล้ว');
    }
}

function updateBellDropdown(alerts) {
    const bellCount = document.getElementById('bellCount');
    const bellTotal = document.getElementById('bellTotal');
    const bellBody = document.getElementById('bellBody');
    const alertBadgeSidebar = document.getElementById('alertBadgeSidebar');

    // Update badge
    if (alerts.length === 0) {
        bellCount.style.display = 'none';
        if (alertBadgeSidebar) alertBadgeSidebar.style.display = 'none';
        bellBody.innerHTML = `<div style="text-align:center;color:var(--text-muted);padding:32px;display:flex;flex-direction:column;align-items:center;gap:8px">
        <span class="material-symbols-rounded" style="font-size:48px;color:var(--primary)">check_circle</span>
        <span>ยอดเยี่ยม! ไม่มีการขาดเวร</span>
        </div>`;
        bellTotal.innerHTML = '0 รายการ';
    } else {
        const label = alerts.length > 99 ? '99+' : alerts.length;
        bellCount.textContent = label;
        bellCount.style.display = '';
        if (alertBadgeSidebar) {
            alertBadgeSidebar.textContent = label;
            alertBadgeSidebar.style.display = '';
        }
        bellTotal.textContent = `${alerts.length} รายการ`;

        let html = '';
        alerts.slice(0, 20).forEach(a => {
            const icon = a.severity === 'error' ? 'error' : 'warning';
            const color = a.severity === 'error' ? 'var(--error)' : 'var(--accent)';
            html += `<div class="bell-alert-item severity-${a.severity}">
                <span class="bell-alert-icon"><span class="material-symbols-rounded" style="color:${color}">${icon}</span></span>
                <div class="bell-alert-content">
                    <div class="bell-alert-date">วันที่ ${a.day} ${DAY_NAMES_SHORT[scheduler.getDayOfWeek(a.day)]}</div>
                    <div class="bell-alert-msg">${a.message}</div>
                </div>
            </div>`;
        });
        if (alerts.length > 20) {
            html += `<div class="bell-dropdown-footer"><span>... อีก ${alerts.length - 20} รายการ</span></div>`;
        }
        bellBody.innerHTML = html;
    }
}

function toggleBellDropdown() {
    const dropdown = document.getElementById('bellDropdown');
    if (dropdown) {
        dropdown.classList.toggle('open');
    }
    // Close sidebar on mobile
    document.getElementById('sidebar').classList.remove('open');
}

function closeBellDropdown() {
    const dropdown = document.getElementById('bellDropdown');
    if (dropdown) dropdown.classList.remove('open');
}

function updateAlertBadge() {
    // Now handled by renderNotifications → updateBellDropdown
}

// ──────────────── Stats Render ────────────────
// ──────────────── Stats Render ────────────────
function renderStats() {
    if (!scheduler || !scheduler.locked) return;

    const stats = scheduler.getStats();
    const container = document.getElementById('statsContent');

    // Calculate Department Totals
    const totals = {
        M: 0, A: 0, N: 0, totalShifts: 0,
        sick: 0, personal: 0, vacation: 0, training: 0, preceptor: 0, totalLeaves: 0
    };

    Object.values(stats).forEach(s => {
        totals.M += s.shifts.M;
        totals.A += s.shifts.A;
        totals.N += s.shifts.N;
        totals.totalShifts += s.shifts.total;
        totals.sick += s.leaves.sick || 0;
        totals.personal += s.leaves.personal || 0;
        totals.vacation += s.leaves.vacation || 0;
        totals.training += s.leaves.training || 0;
        totals.preceptor += s.leaves.preceptor || 0;
        totals.totalLeaves += s.leaves.total;
    });

    let html = `
    <div class="stats-summary-dashboard" style="display:grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap:20px; margin-bottom:24px;">
        <div class="summary-card" style="background:white; padding:20px; border-radius:12px; box-shadow:0 2px 8px rgba(0,0,0,0.05); border-left:4px solid var(--primary);">
            <div class="summary-label" style="font-size:14px; color:var(--text-muted); margin-bottom:8px;">ภาระงานรวมเดือน${document.getElementById('monthLabel').innerText} (ทุกเวร)</div>
            <div class="summary-value" style="font-size:32px; font-weight:800; color:var(--primary); line-height:1;">${totals.totalShifts} <small style="font-size:14px; font-weight:400">เวร</small></div>
            <div class="summary-sub" style="margin-top:12px; font-size:13px; color:var(--text-secondary); display:flex; gap:12px;">
               <span><b style="color:var(--primary)">M:</b> ${totals.M}</span>
               <span><b style="color:var(--primary)">A:</b> ${totals.A}</span>
               <span><b style="color:var(--primary)">N:</b> ${totals.N}</span>
            </div>
        </div>
        <div class="summary-card" style="background:white; padding:20px; border-radius:12px; box-shadow:0 2px 8px rgba(0,0,0,0.05); border-left:4px solid #f43f5e;">
            <div class="summary-label" style="font-size:14px; color:var(--text-muted); margin-bottom:8px;">สถิติการลาหยุด (รวมทุกประเภท)</div>
            <div class="summary-value" style="font-size:32px; font-weight:800; color:#f43f5e; line-height:1;">${totals.totalLeaves} <small style="font-size:14px; font-weight:400">วัน</small></div>
            <div class="summary-sub" style="margin-top:12px; font-size:13px; color:var(--text-secondary); display:grid; grid-template-columns:1fr 1fr; gap:4px 12px;">
                <span>ป่วย: <b>${totals.sick}</b></span>
                <span>กิจ: <b>${totals.personal}</b></span>
                <span>พักผ่อน: <b>${totals.vacation}</b></span>
                <span>อบรม: <b>${totals.training}</b></span>
                <span>Preceptor: <b>${totals.preceptor}</b></span>
            </div>
        </div>
    </div>

    <div class="stats-container">
        <div style="padding:16px 20px; background:#f8fafc; border-bottom:1px solid var(--gray-200); border-radius:12px 12px 0 0; display:flex; justify-content:space-between; align-items:center;">
            <h3 style="margin:0; font-size:16px"><span class="material-symbols-rounded" style="vertical-align:middle; font-size:20px">list_alt</span> รายละเอียดสถิติรายสิบ - ${document.getElementById('monthLabel').innerText}</h3>
            <span style="font-size:12px; color:var(--text-muted)">* ข้อมูลแยกตามเดือนที่เลือก</span>
        </div>
        <table class="stats-table">
          <thead>
            <tr>
              <th>รหัส</th>
              <th>ชื่อ-สกุล</th>
              <th>HC</th>
              <th>Lv</th>
              <th>เช้า (M)</th>
              <th>บ่าย (A)</th>
              <th>ดึก (N)</th>
              <th>รวมเวร</th>
              <th>ลาป่วย</th>
              <th>ลากิจ</th>
              <th>ลาพักผ่อน</th>
              <th>ลาอบรม</th>
              <th>Preceptor</th>
              <th>รวมลา</th>
            </tr>
          </thead>
          <tbody>`;

    Object.values(stats)
        .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
        .forEach(s => {
            html += `<tr>
        <td style="font-family:var(--font-en);font-size:12px;color:var(--text-muted)">${s.id}</td>
        <td class="name-cell">${escHtml(s.name)}</td>
        <td><span class="hc-badge hc-${s.headCode}">${s.headCode}</span></td>
        <td class="num-cell" style="color:var(--text-muted)">${s.level}</td>
        <td class="num-cell stat-m">${s.shifts.M}</td>
        <td class="num-cell stat-a">${s.shifts.A}</td>
        <td class="num-cell stat-n">${s.shifts.N}</td>
        <td class="num-cell stat-total">${s.shifts.total}</td>
        <td class="num-cell stat-leave">${s.leaves.sick || 0}</td>
        <td class="num-cell stat-leave">${s.leaves.personal || 0}</td>
        <td class="num-cell stat-leave">${s.leaves.vacation || 0}</td>
        <td class="num-cell stat-leave">${s.leaves.training || 0}</td>
        <td class="num-cell stat-leave">${s.leaves.preceptor || 0}</td>
        <td class="num-cell stat-leave" style="font-weight:700">${s.leaves.total}</td>
      </tr>`;
        });

    html += `</tbody></table></div>`;
    container.innerHTML = html;
}

// ──────────────── Nurse Summary (Individual Detailed View) ────────────────
function renderNurseSummary(targetNurseId = null) {
    const container = document.getElementById('nurseSummaryContent');
    if (!container) return;

    if (!currentUser) {
        container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">กรุณาเข้าสู่ระบบเพื่อดูสรุปเวร</div>';
        return;
    }

    if (!scheduler || !scheduler.locked) {
        container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">ยังไม่มีข้อมูลตารางเวรในเดือนนี้</div>';
        return;
    }

    // Determine which nurse to show
    let nurseId = targetNurseId;
    if (!nurseId) {
        nurseId = isAdmin ? 'admin_select' : currentUser;
    }

    let html = `
    <div style="max-width:900px; margin:0 auto; padding:20px;">
        <div class="summary-header-box" style="background:white; padding:24px; border-radius:16px; border:1px solid var(--border-light); box-shadow:0 4px 12px rgba(0,0,0,0.05); margin-bottom:24px;">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px;">
                <div>
                    <h2 style="margin:0; font-size:20px; color:var(--primary-dark)">สรุปงานรายเดือน</h2>
                    <p style="margin:4px 0 0; font-size:14px; color:var(--text-muted)">ตรวจสอบรายละเอียดเวรและประวัติการสลับเพื่อเช็คยอดรายได้</p>
                </div>
                ${isAdmin ? `
                <div class="form-group" style="margin:0; min-width:240px;">
                    <label style="font-size:12px; font-weight:700; color:var(--text-secondary); margin-bottom:4px; display:block;">เลือกพยาบาลที่ต้องการดู</label>
                    <select class="form-control" onchange="renderNurseSummary(this.value)" style="border-radius:10px; border:1px solid var(--primary-light); background:var(--primary-light); color:var(--primary-dark); font-weight:600;">
                        <option value="">-- เลือกรายชื่อ --</option>
                        ${activeNurses.map(n => `<option value="${n.id}" ${nurseId === n.id ? 'selected' : ''}>${n.id}: ${n.name}</option>`).join('')}
                    </select>
                </div>
                ` : ''}
            </div>
        </div>
    `;

    if (nurseId === 'admin_select') {
        html += `
            <div style="text-align:center; padding:60px; background:var(--gray-50); border-radius:16px; border:2px dashed var(--gray-200);">
                <span class="material-symbols-rounded" style="font-size:48px; color:var(--gray-300);">person_search</span>
                <p style="margin-top:16px; color:var(--text-secondary); font-weight:600;">กรุณาเลือกรายชื่อพยาบาลจากเมนูเพื่อดูข้อมูล</p>
            </div>
        </div>`;
        container.innerHTML = html;
        return;
    }

    const nurse = activeNurses.find(n => n.id === nurseId);
    if (!nurse) {
        container.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted)">ไม่พบข้อมูลพยาบาล ${nurseId}</div>`;
        return;
    }

    // Get shifts and swaps for this nurse
    const shifts = []; // { dateStr, shift, role, status, note }
    
    // 1. Current Assignments
    for (let day = 1; day <= scheduler.daysInMonth; day++) {
        const ds = scheduler.dateStr(day);
        const daySchedule = scheduler.schedule[ds];
        if (!daySchedule) continue;

        for (const s of ['M', 'A', 'N']) {
            const assignment = daySchedule[s].find(a => a.nurseId === nurseId);
            if (assignment) {
                let status = 'ปกติ';
                let note = '';
                if (assignment.isLeave) {
                    status = 'แจ้งลา';
                    note = `${assignment.leaveType === 'sick' ? 'ลาป่วย' : assignment.leaveType === 'personal' ? 'ลากิจ' : assignment.leaveType === 'vacation' ? 'ลาพักผ่อน' : assignment.leaveType === 'preceptor' ? 'ลา Preceptor' : 'ลาอบรม'}${assignment.urgent ? ' (ฉุกเฉิน)' : ''}`;
                } else if (assignment.swappedFrom) {
                    const original = activeNurses.find(n => n.id === assignment.swappedFrom);
                    status = 'ขึ้นแทน';
                    note = `รับสลับจาก ${original ? original.name : assignment.swappedFrom}`;
                }
                
                shifts.push({ 
                    day, 
                    dateStr: ds, 
                    shift: s, 
                    role: assignment.role, 
                    roleLabel: assignment.roleLabel || ROLE_LABELS[assignment.role] || assignment.role,
                    status, 
                    note,
                    type: 'work' 
                });
            }
        }
    }

    // 2. Swapped Out
    scheduler.swaps.forEach(swap => {
        if (swap.originalNurseId === nurseId) {
            const day = parseInt(swap.date.split('-')[2]);
            shifts.push({
                day,
                dateStr: swap.date,
                shift: swap.shift,
                role: swap.role,
                roleLabel: ROLE_LABELS[swap.role] || swap.role,
                status: 'สลับออก',
                note: `สลับให้ ${swap.replacementNurseName}`,
                type: 'swap-out'
            });
        }
    });

    // Sort by day then shift (M < A < N)
    const shiftOrder = { M: 1, A: 2, N: 3 };
    shifts.sort((a, b) => {
        if (a.day !== b.day) return a.day - b.day;
        return shiftOrder[a.shift] - shiftOrder[b.shift];
    });

    // Totals for payroll check
    const totals = { M: 0, A: 0, N: 0, total: 0 };
    shifts.forEach(s => {
        if (s.type === 'work' && s.status !== 'แจ้งลา') {
            totals[s.shift]++;
            totals.total++;
        }
    });

    html += `
        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap:16px; margin-bottom:24px;">
            <div class="summary-mini-card" style="background:#f0f9ff; padding:16px; border-radius:12px; border:1px solid #bae6fd;">
                <div style="font-size:12px; color:#0369a1; font-weight:700; text-transform:uppercase;">กะเช้า (M)</div>
                <div style="font-size:24px; font-weight:800; color:#0c4a6e;">${totals.M} <small style="font-size:12px; font-weight:400">เวร</small></div>
            </div>
            <div class="summary-mini-card" style="background:#fff7ed; padding:16px; border-radius:12px; border:1px solid #ffedd5;">
                <div style="font-size:12px; color:#c2410c; font-weight:700; text-transform:uppercase;">กะบ่าย (A)</div>
                <div style="font-size:24px; font-weight:800; color:#7c2d12;">${totals.A} <small style="font-size:12px; font-weight:400">เวร</small></div>
            </div>
            <div class="summary-mini-card" style="background:#f5f3ff; padding:16px; border-radius:12px; border:1px solid #ddd6fe;">
                <div style="font-size:12px; color:#6d28d9; font-weight:700; text-transform:uppercase;">กะดึก (N)</div>
                <div style="font-size:24px; font-weight:800; color:#4c1d95;">${totals.N} <small style="font-size:12px; font-weight:400">เวร</small></div>
            </div>
            <div class="summary-mini-card" style="background:var(--primary-light); padding:16px; border-radius:12px; border:1px solid var(--primary-border);">
                <div style="font-size:12px; color:var(--primary-dark); font-weight:700; text-transform:uppercase;">รวมปฏิบัติงานจริง</div>
                <div style="font-size:24px; font-weight:800; color:var(--primary-dark);">${totals.total} <small style="font-size:12px; font-weight:400">เวร</small></div>
            </div>
        </div>

        <div class="stats-container" style="background:white; border-radius:16px; overflow:hidden; border:1px solid var(--border-light); box-shadow:0 4px 12px rgba(0,0,0,0.05);">
            <div style="padding:16px 20px; border-bottom:1px solid var(--border-light); font-weight:800; color:var(--text-secondary); display:flex; align-items:center; gap:8px;">
                <span class="material-symbols-rounded">list</span> รายละเอียดเวรรายวัน / ยอดรายชื่อ
            </div>
            <table class="stats-table">
                <thead>
                    <tr>
                        <th style="width:100px">วันที่</th>
                        <th style="width:80px; text-align:center">กะ</th>
                        <th style="width:140px">ตำแหน่ง</th>
                        <th style="width:100px; text-align:center">สถานะ</th>
                        <th>หมายเหตุ / รายละเอียดการสลับ</th>
                    </tr>
                </thead>
                <tbody>
                    ${shifts.map(s => {
                        let statusColor = 'var(--text-primary)';
                        let bg = 'white';
                        if (s.status === 'แจ้งลา') { statusColor = 'var(--error)'; bg = '#fff1f2'; }
                        else if (s.status === 'ขึ้นแทน') { statusColor = 'var(--success)'; bg = '#f0fdf4'; }
                        else if (s.status === 'สลับออก') { statusColor = 'var(--text-muted)'; bg = '#f8fafc'; }

                        const dayName = DAY_NAMES_SHORT[new Date(scheduler.year, scheduler.month, s.day).getDay()];

                        return `
                            <tr style="background:${bg}">
                                <td style="font-weight:700">${s.day} ${THAI_MONTHS[currentMonth].substring(0,3)} (${dayName})</td>
                                <td style="text-align:center">
                                    <span class="shift-count" style="background:var(--shift-${s.shift.toLowerCase()}-badge)">${s.shift}</span>
                                </td>
                                <td>${s.roleLabel}</td>
                                <td style="text-align:center">
                                    <span style="font-size:12px; font-weight:800; color:${statusColor}">${s.status}</span>
                                </td>
                                <td style="font-size:12px; color:var(--text-secondary)">${s.note || '-'}</td>
                            </tr>
                        `;
                    }).join('')}
                    ${shifts.length === 0 ? '<tr><td colspan="5" style="text-align:center; padding:40px; color:var(--text-muted)">ไม่มีรายการเวรในเดือนนี้</td></tr>' : ''}
                </tbody>
            </table>
        </div>
        
        <div style="margin-top:20px; padding:16px; background:#fef3c7; border-radius:12px; border:1px solid #fde68a; color:#92400e; font-size:13px; display:flex; gap:12px; align-items:flex-start;">
            <span class="material-symbols-rounded">info</span>
            <div>
                <b>หมายเหตุสำหรับการตรวจสอบรายได้:</b>
                <ul style="margin:4px 0 0 20px; padding:0">
                    <li><b>สถานะปกติ/ขึ้นแทน:</b> นับเป็นเวรปฏิบัติงานจริง นำไปรวมยอดเงินได้</li>
                    <li><b>สถานะแจ้งลา/สลับออก:</b> ไม่นับเป็นเวรปฏิบัติงานในยอดสรุปนี้</li>
                    <li>หากข้อมูลไม่ถูกต้อง กรุณาติดต่อหัวหน้าเวรเพื่อตรวจสอบประวัติการอนุมัติในระบบ</li>
                </ul>
            </div>
        </div>
    </div>`;

    container.innerHTML = html;
}

// ──────────────── Swap History ────────────────
function showSwapHistory() {
    switchTab('swapHistory');
}

function renderSwapHistory() {
    const container = document.getElementById('swapHistoryContent');
    if (!scheduler || scheduler.swaps.length === 0) {
        container.innerHTML = `
      <div class="empty-state" style="min-height:30vh">
        <span class="material-symbols-rounded empty-icon">history</span>
        <h2>ยังไม่มีประวัติสลับเวร</h2>
        <p>เมื่อ Admin ทำการสลับเวร จะแสดงประวัติที่นี่</p>
      </div>`;
        return;
    }

    let html = `<div class="stats-container">
    <table class="stats-table">
      <thead>
        <tr>
          <th>วันที่</th>
          <th>กะ</th>
          <th>บทบาท</th>
          <th>คนเดิม</th>
          <th></th>
          <th>คนแทน</th>
          <th>เวลาที่สลับ</th>
        </tr>
      </thead>
      <tbody>`;

    scheduler.swaps.forEach(s => {
        const day = parseInt(s.date.split('-')[2]);
        html += `<tr>
      <td>${day} ${THAI_MONTHS[currentMonth].substring(0, 3)}</td>
      <td><span class="shift-count" style="background:var(--shift-${s.shift.toLowerCase()}-badge)">${s.shift}</span></td>
      <td>${ROLE_LABELS[s.role] || s.role}</td>
      <td class="name-cell">${escHtml(s.originalNurseName)}</td>
      <td style="text-align:center;color:var(--primary);font-weight:700"><span class="material-symbols-rounded" style="font-size:18px;vertical-align:middle">arrow_forward</span></td>
      <td class="name-cell">${escHtml(s.replacementNurseName)}</td>
      <td style="font-size:12px;color:var(--text-muted)">${new Date(s.timestamp).toLocaleString('th-TH')}</td>
    </tr>`;
    });

    html += `</tbody></table></div>`;
    container.innerHTML = html;
}

// ──────────────── Request Status (User View) ────────────────
function renderRequestStatus() {
    const container = document.getElementById('requestStatusContent');
    if (!container) return;

    if (!currentUser) {
        container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">กรุณาเข้าสู่ระบบเพื่อดูสถานะคำขอ</div>';
        return;
    }

    // Filter requests sent by me OR where I am the target (for swaps)
    const myRequests = requests.filter(r => r.senderId === currentUser || (r.type === 'swap' && r.targetId === currentUser));

    if (myRequests.length === 0) {
        container.innerHTML = `
            <div style="text-align:center;padding:80px 20px;background:white;border-radius:16px;border:1px dashed var(--border-medium)">
                <span class="material-symbols-rounded" style="font-size:48px;color:var(--gray-300);margin-bottom:16px">history</span>
                <div style="color:var(--text-secondary);font-weight:600">ไม่พบประวัติคำขอของคุณ</div>
                <div style="color:var(--text-muted);font-size:13px;margin-top:8px">คำขอลาหรือสลับเวรของคุณจะแสดงที่นี่</div>
            </div>`;
        return;
    }

    // Sort by newest first
    const sorted = [...myRequests].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    const statusMap = {
        'pending_target': { label: 'Pending', class: 'status-pending' },
        'pending_admin': { label: 'Pending', class: 'status-pending' },
        'approved': { label: 'Complete', class: 'status-complete' },
        'rejected': { label: 'Cancel', class: 'status-cancel' }
    };

    const html = sorted.map(r => {
        const s = statusMap[r.status] || { label: r.status, class: '' };
        const isSwap = r.type === 'swap';
        const title = isSwap ? 'ขอสลับเวร' : 'แจ้งลาพยาบาล';
        const dateStr = isSwap ? r.data.dateStr : `${r.data.startDate} ถึง ${r.data.endDate}`;

        // Show context who sent/receiver
        let context = '';
        if (isSwap) {
            const sender = activeNurses.find(n => n.id === r.senderId);
            const target = activeNurses.find(n => n.id === r.targetId);
            if (r.senderId === currentUser) {
                context = `คุณเสนอแลกกับ ${target ? target.name : r.targetId}`;
            } else {
                context = `${sender ? sender.name : r.senderId} ขอแลกกับคุณ`;
            }
            if (r.data.isEmergency) {
                context += `<br><span style="color:var(--warning); font-size:10px;">⚠️ คำขอฉุกเฉิน: มีการผ่อนปรนกฎ</span>`;
            }
        } else {
            context = r.data.leaveType === 'off' ? 'ขอหยุด' : `ลา (${r.data.leaveType})`;
        }

        const canCancel = r.senderId === currentUser && r.status.includes('pending');

        return `
            <div class="request-card" style="background:white; margin-bottom:12px; border-radius:12px; border:1px solid var(--border-light); padding:16px; display:flex; flex-direction:column; gap:12px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div style="display:flex; gap:16px; align-items:center;">
                        <div style="width:40px; height:40px; border-radius:10px; background:var(--primary-light); display:flex; align-items:center; justify-content:center; color:var(--primary)">
                            <span class="material-symbols-rounded">${isSwap ? 'swap_horiz' : 'assignment_late'}</span>
                        </div>
                        <div>
                            <div style="font-weight:700; color:var(--text-primary); font-size:14px;">${title}</div>
                            <div style="font-size:12px; color:var(--text-muted); margin-top:2px;">${dateStr}</div>
                            <div style="font-size:11px; color:var(--info); font-weight:600; margin-top:4px;">${context}</div>
                        </div>
                    </div>
                    <div style="display:flex; flex-direction:column; align-items:flex-end; gap:8px;">
                        <div class="req-status-badge ${s.class}">${s.label}</div>
                        ${canCancel ? `<button class="mini-btn" onclick="cancelRequest('${r.id}')" style="color:var(--error); font-size:11px; font-weight:600; background:none; border:none; padding:0; cursor:pointer;">❌ ยกเลิกคำขอ</button>` : ''}
                    </div>
                </div>
                ${r.rejectReason ? `
                    <div style="background:#fff1f2; padding:10px; border-radius:8px; border:1px solid #ffe4e6;">
                        <div style="font-size:11px; font-weight:800; color:#e11d48; margin-bottom:4px; text-transform:uppercase;">🚫 เหตุผลที่ไม่อนุมัติ</div>
                        <div style="font-size:12px; color:#9f1239;">${escHtml(r.rejectReason)}</div>
                    </div>
                ` : ''}
            </div>`;
    }).join('');

    container.innerHTML = `
        <div style="max-width:800px; margin:0 auto; padding:20px;">
            <div style="margin-bottom:20px; color:var(--text-secondary); font-size:13px;">รวมทั้งหมด (${sorted.length} รายการ)</div>
            ${html}
        </div>`;
}

function cancelRequest(id) {
    if (!confirm('ยืนยันว่าต้องการยกเลิกคำขอนี้ใช่หรือไม่?')) return;

    const idx = requests.findIndex(r => r.id === id);
    if (idx !== -1) {
        const r = requests[idx];
        if (r.senderId !== currentUser) {
            showToast('error', 'คุณสามารถยกเลิกได้เฉพาะคำขอของคุณเอง');
            return;
        }

        // Remove from list
        requests.splice(idx, 1);
        saveRequests();
        renderAll();
        showToast('info', 'ยกเลิกคำขอเรียบร้อยแล้ว');
    }
}

// ──────────────── Approval View (Admin/Head) ────────────────
function renderApprovalView() {
    const container = document.getElementById('approvalContent');
    if (!container) return;

    if (!isAdmin) {
        container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">เฉพาะหัวหน้าเวรหรือผู้ดูแลระบบเท่านั้นที่สามารถเข้าถึงหน้านี้ได้</div>';
        return;
    }

    // For Admin/Head: See anything that is pending
    const actionableRequests = requests.filter(r => r.status.includes('pending'));

    if (actionableRequests.length === 0) {
        container.innerHTML = `
            <div style="text-align:center;padding:80px 20px;background:white;border-radius:16px;border:1px dashed var(--border-medium); max-width:800px; margin:20px auto;">
                <span class="material-symbols-rounded" style="font-size:48px;color:var(--gray-300);margin-bottom:16px">verified</span>
                <div style="color:var(--text-secondary);font-weight:600">ไม่มีคำขอที่รอการดำเนินการในขณะนี้</div>
                <div style="color:var(--text-muted);font-size:13px;margin-top:8px">คำขอลาหรือสลับเวรที่พยาบาลส่งมาจะปรากฏที่นี่</div>
            </div>`;
        return;
    }

    const html = actionableRequests.map(r => renderRequestItem(r, true)).join('');

    container.innerHTML = `
        <div style="max-width:850px; margin:0 auto; padding:20px;">
            <div style="margin-bottom:20px; color:var(--text-secondary); font-size:13px; font-weight:600;">📊 มีคำขอในระบบทั้งหมด ${actionableRequests.length} รายการ</div>
            <div class="approval-grid" style="display:grid; grid-template-columns:1fr; gap:16px;">
                ${html}
            </div>
        </div>`;
}

// adminLogin function removed (replaced by handleLogin)

// ──────────────── Leave System ────────────────
function getLeaveLimitForLevel(level) {
    const lim = (activeLeaveLimits && activeLeaveLimits[level] != null) ? activeLeaveLimits[level] : LEAVE_LIMITS_BY_LEVEL[level];
    const val = parseInt(lim, 10);
    return Number.isFinite(val) ? val : 0;
}

function getNurseLevelById(nurseId, nurseList) {
    const list = Array.isArray(nurseList) ? nurseList : activeNurses;
    const nurse = list.find(n => n.id === nurseId);
    const lv = nurse ? parseInt(nurse.level, 10) : 1;
    return Number.isFinite(lv) ? lv : 1;
}

function getMonthData(year, monthIndex) {
    if (scheduler && year === currentYear && monthIndex === currentMonth) {
        return { schedule: scheduler.schedule, leaves: scheduler.leaves, nurses: scheduler.nurses };
    }
    const raw = localStorage.getItem(getStorageKey(year, monthIndex));
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
}

function collectLeaveNurseIds(dateStr, monthData) {
    const ids = new Set();
    if (monthData && monthData.leaves && monthData.leaves[dateStr]) {
        monthData.leaves[dateStr].forEach(l => {
            if (l && l.nurseId) ids.add(l.nurseId);
        });
        return ids;
    }
    if (monthData && monthData.schedule && monthData.schedule[dateStr]) {
        ['M', 'A', 'N'].forEach(s => {
            (monthData.schedule[dateStr][s] || []).forEach(a => {
                if (a && a.isLeave && a.nurseId) ids.add(a.nurseId);
            });
        });
    }
    return ids;
}

function countLeavesByLevel(dateStr, monthData) {
    const ids = collectLeaveNurseIds(dateStr, monthData);
    const counts = {};
    ids.forEach(id => {
        const level = getNurseLevelById(id, monthData?.nurses);
        counts[level] = (counts[level] || 0) + 1;
    });
    return counts;
}

function validateLeaveCapacity(nurseId, startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const year = d.getFullYear();
        const monthIndex = d.getMonth();
        const dateStr = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

        const monthData = getMonthData(year, monthIndex) || { leaves: {}, schedule: {}, nurses: activeNurses };
        const leaveIds = collectLeaveNurseIds(dateStr, monthData);
        if (leaveIds.has(nurseId)) continue; // already off, no new slot consumed

        const level = getNurseLevelById(nurseId, monthData.nurses);
        const limit = getLeaveLimitForLevel(level);
        const counts = countLeavesByLevel(dateStr, monthData);
        const current = counts[level] || 0;
        if (current >= limit) {
            return { ok: false, dateStr, level, limit, current };
        }
    }
    return { ok: true };
}

function openLeaveModal() {
    if (!currentUser) {
        showToast('warning', 'กรุณาเข้าสู่ระบบก่อนทำรายการ');
        openLoginOverlay();
        return;
    }

    // Admins can add leaves even before schedule is locked/generated
    if (!isAdmin && (!scheduler || !scheduler.locked)) {
        showToast('warning', 'กรุณาสร้างตารางเวรก่อน');
        return;
    }

    const sel = document.getElementById('leaveNurse');
    sel.innerHTML = '<option value="">-- เลือกพยาบาล --</option>';
    
    // Always use activeNurses instead of scheduler.nurses to ensure everyone is available
    activeNurses.forEach(n => {
        sel.innerHTML += `<option value="${n.id}">${n.name}</option>`;
    });

    if (!isAdmin) {
        sel.value = currentUser;
        sel.disabled = true;
    } else {
        sel.disabled = false;
        sel.value = '';
    }

    const monthStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`;
    const startDate = document.getElementById('leaveStartDate');
    const endDate = document.getElementById('leaveEndDate');

    // Remove strict constraints to allow future bookings
    startDate.min = '';
    startDate.max = '';
    endDate.min = '';
    endDate.max = '';

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    startDate.value = todayStr;
    endDate.value = todayStr;

    // Sync logic (re-bind to ensure fresh state, or use named function to avoid duplicates)
    startDate.onchange = function () {
        endDate.min = startDate.value;
        if (endDate.value < startDate.value) {
            endDate.value = startDate.value;
        }
    };

    document.getElementById('leaveUrgent').checked = false;
    document.getElementById('leaveReason').value = '';

    openModal('leaveModal');
    // Close sidebar on mobile
    document.getElementById('sidebar').classList.remove('open');
}

function submitLeave() {
    const nurseId = isAdmin ? document.getElementById('leaveNurse').value : currentUser;
    const leaveType = document.getElementById('leaveType').value;
    const startDate = document.getElementById('leaveStartDate').value;
    const endDate = document.getElementById('leaveEndDate').value;
    const urgent = document.getElementById('leaveUrgent').checked;
    const reason = document.getElementById('leaveReason').value;

    if (!nurseId || !leaveType || !startDate || !endDate) {
        showToast('error', 'กรุณากรอกข้อมูลให้ครบ');
        return;
    }

    if (new Date(endDate) < new Date(startDate)) {
        showToast('error', 'วันสิ้นสุดต้องไม่ก่อนวันเริ่มต้น');
        return;
    }

    const capacityCheck = validateLeaveCapacity(nurseId, startDate, endDate);
    if (!capacityCheck.ok) {
        showToast('error', `ระดับ ${capacityCheck.level} วันที่ ${capacityCheck.dateStr} ลาเกินโควต้า (${capacityCheck.current}/${capacityCheck.limit}) กรุณาคุยกันเองก่อน`);
        return;
    }

    // If Admin is submitting for someone else, apply directly? 
    // User said "Everyone can submit... Head approves". 
    // I'll make it a request regardless, or if Admin, approve immediately.
    if (isAdmin) {
        let count = 0;
        const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        for (let d = new Date(startDate); d <= new Date(endDate); d.setDate(d.getDate() + 1)) {
            const ds = fmt(d);
            if (scheduler && d.getMonth() === currentMonth && d.getFullYear() === currentYear) {
                if (scheduler.addLeave(nurseId, ds, leaveType, urgent, reason)) count++;
            } else {
                if (saveCrossMonthLeave(ds, nurseId, leaveType, urgent, reason)) count++;
            }
        }
        if (count > 0) {
            saveToStorage();
            closeModal('leaveModal');
            renderAll();
            showToast('success', `บันทึกการลาสำเร็จ (${count} วัน)`);
        } else {
            showToast('warning', 'ไม่สามารถบันทึกได้ (อาจลาซ้ำรหัสเดิม)');
        }
    } else {
        // Create Request for Head
        addRequest('leave', {
            nurseId,
            leaveType,
            startDate,
            endDate,
            urgent,
            reason
        });
        closeModal('leaveModal');
    }
}

// ──────────────── Cross-Month Helper ────────────────
function saveCrossMonthLeave(dateStr, nurseId, leaveType, urgent, reason) {
    const parts = dateStr.split('-').map(Number); // [2026, 3, 5]
    const year = parts[0];
    const monthIndex = parts[1] - 1; // 0-based
    const key = `erms_${year}_${monthIndex}`;

    let dataStr = localStorage.getItem(key);
    let data;
    try {
        data = dataStr ? JSON.parse(dataStr) : null;
    } catch (e) {
        data = null;
    }

    // Init data if missing (New Month)
    if (!data) {
        data = {
            nurses: activeNurses,
            schedule: {},
            leaves: {}
        };
    }

    if (!data.leaves) data.leaves = {};
    if (!data.leaves[dateStr]) data.leaves[dateStr] = [];

    // Check duplicate
    if (!data.leaves[dateStr].some(l => l.nurseId === nurseId)) {
        const nurse = activeNurses.find(n => n.id === nurseId);
        data.leaves[dateStr].push({
            nurseId,
            nurseName: nurse ? nurse.name : nurseId,
            leaveType,
            urgent,
            reason
        });

        localStorage.setItem(key, JSON.stringify(data));
        void firebaseSet(getFirebaseSchedulePath(year, monthIndex), data);
        return true;
    }
    return false;
}

function removeLeaveManually(nurseId, dateStr) {
    if (!isAdmin && nurseId !== currentUser) {
        showToast('error', 'คุณไม่มีสิทธิ์ลบข้อมูลนี้');
        return;
    }

    if (!confirm('ต้องการลบข้อมูลการลานี้ใช่หรือไม่?')) return;

    const parts = dateStr.split('-').map(Number);
    const year = parts[0];
    const monthIndex = parts[1] - 1;

    // Handle current instance if it matches
    if (scheduler && year === currentYear && monthIndex === currentMonth) {
        scheduler.removeLeave(nurseId, dateStr);
        saveToStorage();
    } else {
        // Handle external storage
        const key = `erms_${year}_${monthIndex}`;
        let dataStr = localStorage.getItem(key);
        if (dataStr) {
            try {
                let data = JSON.parse(dataStr);
                if (data.leaves && data.leaves[dateStr]) {
                    data.leaves[dateStr] = data.leaves[dateStr].filter(l => l.nurseId !== nurseId);
                    localStorage.setItem(key, JSON.stringify(data));
                    void firebaseSet(getFirebaseSchedulePath(year, monthIndex), data);
                }
            } catch (e) {
                console.error('Failed to parse storage for leave removal', e);
            }
        }
    }

    renderAll();
    showToast('success', 'ลบข้อมูลการลาเรียบร้อยแล้ว');
}

// ──────────────── Swap System ────────────────
function openSwapFromLeave(nurseId, dateStr) {
    const shift = scheduler.findNurseShift(nurseId, dateStr);
    if (shift) openSwapModal(nurseId, dateStr, shift);
    else showToast('error', 'ไม่พบเวรของพยาบาลนี้');
}

function openSwapModal(nurseId, dateStr, shift, relaxed = false) {
    if (!currentUser) {
        showToast('warning', 'กรุณาเข้าสู่ระบบก่อนทำรายการ');
        openLoginOverlay();
        return;
    }

    if (!isAdmin && nurseId !== currentUser) {
        showToast('error', 'คุณสามารถสลับได้เฉพาะเวรของตัวเองเท่านั้น');
        return;
    }

    selectedSwap = { nurseId, dateStr, shift, violations: [] };
    const nurse = scheduler.nurses.find(n => n.id === nurseId);
    const dayStr = dateStr.split('-')[2];

    document.getElementById('swapInfo').innerHTML = `
    <div style="margin-bottom:12px;padding:12px;background:var(--gray-50);border-radius:var(--radius-sm);border:1px solid var(--border-light)">
      <strong style="color:var(--text-primary)">${escHtml(nurse?.name || nurseId)}</strong><br>
      <span style="color:var(--text-muted);font-size:13px">📅 วันที่ ${dayStr} ${THAI_MONTHS[currentMonth]} · ${SHIFT_LABELS[shift]}</span>
    </div>
  `;

    const options = scheduler.getReplacementOptions(nurseId, dateStr, shift, true); // Get all to categorize
    const list = document.getElementById('swapOptions');

    // Categorize
    const perfect = options.filter(o => o.violations.length === 0);
    const growth = options.filter(o => {
        if (o.violations.length === 0) return false;
        // If only violation is role/level mismatch and it's an "upward" move
        const hasRoleVio = o.violations.includes('บทบาท/ทักษะไม่ตรงกัน');
        const otherVios = o.violations.filter(v => v !== 'บทบาท/ทักษะไม่ตรงกัน').length;
        return hasRoleVio && otherVios === 0 && o.nurse.level <= (nurse?.level || 3);
    });
    const emergency = options.filter(o => {
        if (o.violations.length === 0) return false;
        const isGrowth = growth.some(g => g.nurse.id === o.nurse.id);
        return !isGrowth;
    });

    let html = '';

    const renderGroup = (title, items, icon, color, isGrowth) => {
        if (items.length === 0) return '';
        return `
            <div style="margin-top:16px; margin-bottom:8px; display:flex; align-items:center; gap:6px; font-size:12px; font-weight:700; color:${color}">
                <span class="material-symbols-rounded" style="font-size:16px">${icon}</span> ${title}
            </div>
            ${items.map(item => {
            const n = item.nurse;
            const v = item.violations;
            const c = scheduler.counters[n.id];
            const displayVios = isGrowth ? ['โอกาสเรียนรู้งาน / ฝึกทักษะตำแหน่งที่สูงขึ้น'] : v;

            return `
                <div class="replacement-option ${v.length > 0 ? 'has-violation' : ''}" 
                     data-id="${n.id}" 
                     data-vios='${JSON.stringify(v)}'
                     onclick="selectReplacement(this)">
                    <div style="flex:1">
                        <div class="replacement-name">
                            ${escHtml(n.name)} ${v.length > 0 ? '⚠️' : ''}
                            <span class="select-check material-symbols-rounded" style="display:none; color:var(--success); font-size:20px; vertical-align:middle; float:right;">check_circle</span>
                        </div>
                        <div style="font-size:11px;color:var(--text-muted)">Level ${n.level} · HeadCode ${n.headCode}</div>
                        ${v.length > 0 ? `<div style="font-size:10px;color:${isGrowth ? 'var(--info)' : 'var(--error)'};margin-top:4px;font-weight:600">
                            ${isGrowth ? '✨' : '❌'} ${displayVios.join(', ')}
                        </div>` : ''}
                    </div>
                    <div class="replacement-stats" style="text-align:right">
                        <div style="font-size:11px;font-weight:700">Σ ${c.total}</div>
                    </div>
                </div>`;
        }).join('')}
        `;
    };

    html += renderGroup('พยาบาลแนะนำ (ตรงตามเกณฑ์ 100%)', perfect, 'verified', 'var(--success)');
    html += renderGroup('โอกาสเรียนรู้งาน (Incharge Training / Growth)', growth, 'school', 'var(--info)', true);

    if (relaxed || perfect.length === 0) {
        html += renderGroup('รายชื่อกรณีฉุกเฉิน (มีข้อจำกัดบางประการ)', emergency, 'report_problem', 'var(--warning)');
    } else if (emergency.length > 0) {
        html += `
            <div style="text-align:center; padding:12px; margin-top:10px;">
                <button class="btn btn-sm" style="background:var(--gray-200); color:var(--text-secondary); border:none; border-radius:8px; font-size:11px;" 
                        onclick="this.parentElement.innerHTML = \`${renderGroup('รายชื่อกรณีฉุกเฉิน (มีข้อจำกัดบางประการ)', emergency, 'report_problem', 'var(--warning)')}\` ">
                    🔎 แสดงรายชื่อสำรองอื่นๆ (กรณีขาดคนจริงๆ)
                </button>
            </div>`;
    }

    if (!html) {
        html = `<div style="text-align:center;color:var(--text-muted);padding:40px">ไม่มีพยาบาลที่สามารถทำงานแทนได้เลยในขณะนี้</div>`;
    }

    list.innerHTML = html;
    document.getElementById('swapConfirm').disabled = true;
    openModal('swapModal');
}

function confirmSwap() {
    if (!selectedSwap.replacementId) return;

    const hasViolations = selectedSwap.violations && selectedSwap.violations.length > 0;
    const targetNurse = scheduler.nurses.find(n => n.id === selectedSwap.replacementId);

    // ALWAYS create a request from the calendar, never execute immediately.
    // This ensures it goes to "Request Status" and needs Head approval.
    addRequest('swap', {
        originalNurseId: selectedSwap.nurseId,
        targetNurseId: selectedSwap.replacementId,
        targetNurseName: targetNurse?.name,
        dateStr: selectedSwap.dateStr,
        shift: selectedSwap.shift,
        isEmergency: hasViolations,
        violations: selectedSwap.violations
    });

    closeModal('swapModal');
    showToast('info', hasViolations ? 'ส่งคำขอแลกเวรฉุกเฉินแล้ว ⚠️' : 'ส่งคำขอแลกเวรแล้ว');
}

function selectReplacement(element) {
    const id = element.dataset.id;
    const vios = JSON.parse(element.dataset.vios || '[]');

    selectedSwap.replacementId = id;
    selectedSwap.violations = vios;

    document.querySelectorAll('.replacement-option').forEach(el => {
        const isSelected = el.dataset.id === id;
        el.classList.toggle('selected', isSelected);

        // Toggle checkmark icon
        const checkIcon = el.querySelector('.select-check');
        if (checkIcon) checkIcon.style.display = isSelected ? 'block' : 'none';
    });

    document.getElementById('swapConfirm').disabled = false;
    const confirmBtn = document.getElementById('swapConfirm');
    if (confirmBtn) {
        confirmBtn.style.opacity = '1';
        confirmBtn.style.cursor = 'pointer';
    }
}


// ──────────────── Backup / Restore ────────────────
function backupData() {
    if (!scheduler || !scheduler.locked) {
        showToast('warning', 'ไม่มีข้อมูลตารางเวรให้ Backup');
        return;
    }

    const data = scheduler.toJSON();
    data.nurses = scheduler.nurses; // Include nurse data
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `ERMS_Backup_${THAI_MONTHS[currentMonth]}_${currentYear + 543}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('success', 'Backup ข้อมูลสำเร็จ');
}

function restoreData(input) {
    const file = input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const json = JSON.parse(e.target.result);
            if (!json.schedule || (!json.nurses && !json.activeNurses)) {
                showToast('error', 'ไฟล์ไม่ถูกต้อง (Missing schedule/nurses)');
                return;
            }

            // Also restore global nurse list if found
            const backupNurses = json.nurses || json.activeNurses;
            if (backupNurses && Array.isArray(backupNurses)) {
                activeNurses = JSON.parse(JSON.stringify(backupNurses));
                saveGlobalSettings();
            }

            scheduler = new NurseScheduler(activeNurses, currentMonth, currentYear);
            scheduler.loadFromJSON(json);
            saveToStorage();
            renderAll();
            showToast('success', 'Restore ข้อมูลสำเร็จ และซิงค์ขึ้น Cloud เรียบร้อย!');
        } catch (err) {
            console.error(err);
            showToast('error', 'ไฟล์ไม่ถูกต้อง (Invalid JSON)');
        }
    };
    reader.readAsText(file);
    input.value = ''; // Reset input
}

// ──────────────── Export ────────────────
function exportData() {
    if (!scheduler || !scheduler.locked) return;

    let csv, filename;
    if (currentTab === 'stats') {
        csv = scheduler.exportStatsCSV();
        filename = `สถิติเวร_${THAI_MONTHS[currentMonth]}_${currentYear + 543}.csv`;
    } else {
        csv = scheduler.exportCalendarCSV();
        filename = `ตารางเวร_${THAI_MONTHS[currentMonth]}_${currentYear + 543}.csv`;
    }

    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    showToast('success', `ส่งออก ${filename} สำเร็จ`);
}

// ──────────────── Modal Helpers ────────────────
function openModal(id) {
    document.getElementById(id).classList.add('active');
}

function closeModal(id) {
    document.getElementById(id).classList.remove('active');
}

// ──────────────── Toast ────────────────
function showToast(type, message) {
    const container = document.getElementById('toastContainer');
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
    <span class="toast-icon">${icons[type] || 'ℹ️'}</span>
    <span class="toast-msg">${escHtml(message)}</span>
  `;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(30px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

// ──────────────── Security Helpers ────────────────
function escHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function escAttr(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ──────────────── Click Outside to Close Bell ────────────────
document.addEventListener('click', (e) => {
    const bellBtn = document.getElementById('bellBtn');
    const bellDropdown = document.getElementById('bellDropdown');
    if (bellBtn && bellDropdown) {
        if (!bellBtn.contains(e.target) && !bellDropdown.contains(e.target)) {
            bellDropdown.classList.remove('open');
        }
    }
});

// ──────────────── Settings Management ────────────────

function switchSettingsTab(tab) {
    currentSettingsTab = tab;
    const btnNurses = document.getElementById('sTabNurses');
    const btnRoles = document.getElementById('sTabRoles');
    if (btnNurses) btnNurses.classList.toggle('active', tab === 'nurses');
    if (btnRoles) btnRoles.classList.toggle('active', tab === 'roles');

    const divNurses = document.getElementById('settingsNurses');
    const divRoles = document.getElementById('settingsRoles');
    if (divNurses) divNurses.classList.toggle('hidden', tab !== 'nurses');
    if (divRoles) divRoles.classList.toggle('hidden', tab !== 'roles');

    renderSettings();
}

function renderSettings() {
    if (currentSettingsTab === 'nurses') {
        renderNurseList();
    } else {
        renderQuotaSettings();
    }
}

function renderNurseList() {
    const container = document.getElementById('nurseLayout');
    if (!container) return;

    // Log for debugging (User can report if still failing)
    console.log('[ERMS] Rendering Nurse List. Active Count:', activeNurses.length);

    if (!activeNurses || activeNurses.length === 0) {
        if (scheduler && scheduler.nurses && scheduler.nurses.length > 0) {
            container.innerHTML = `
                <div class="empty-state" style="grid-column: 1 / -1; padding: 40px; border: 2px dashed var(--primary-light); text-align:center;">
                    <span class="material-symbols-rounded" style="font-size:48px; color:var(--primary)">group_add</span>
                    <h3 style="margin-top:12px">ฐานข้อมูลหลักว่างเปล่า</h3>
                    <p style="color:var(--text-muted); margin-bottom:16px">พบรายชื่อพยาบาล ${scheduler.nurses.length} คนในตารางเวรคุณต้องการนำเข้าหรือไม่?</p>
                    <button class="btn btn-primary" onclick="importNursesFromScheduler()">
                        นำเข้ารายชื่อทั้งหมด (${scheduler.nurses.length} คน)
                    </button>
                </div>
            `;
        } else {
            container.innerHTML = `<div class="empty-state" style="grid-column:1/-1; padding:40px; text-align:center;">ไม่พบรายชื่อพยาบาล กรุณาเพิ่มรายชื่อ</div>`;
        }
        return;
    }

    container.innerHTML = activeNurses.map(n => {
        // Defensive checks to prevent crash
        if (!n) return '';
        const roles = Array.isArray(n.roles) ? n.roles : [];
        const rolesHtml = roles.map(r => {
            const role = (activeRoleLabels && activeRoleLabels[r]) ? activeRoleLabels[r] : r;
            let shortLabel = role;
            if (r === 'Incharge1') shortLabel = 'IC1';
            else if (r === 'Incharge_team') shortLabel = 'ICT';
            else if (r === 'Fast_track') shortLabel = 'FT';
            else if (r === 'Triage') shortLabel = 'TR';
            else if (r === 'Screen_center') shortLabel = 'SC';
            return `<span class="badge" style="font-size:10px; background:var(--bg-body); color:var(--text-secondary); border:1px solid var(--border-medium)">${shortLabel}</span>`;
        }).join('');

        const headCodeLabel = {
            '5': 'ทุกเวร',
            '7': 'ห้ามดึก/เวรบ่าย(จ-ศ)',
            '8': 'เช้าเท่านั้น/IC(ส-อา)',
            '9': 'เช้าเท่านั้น'
        }[n.headCode] || 'ปกติ';

        return `
            <div class="nurse-card">
                <div class="nurse-info">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <h4 style="margin:0; font-size:16px;">${escHtml(n.name || 'ไม่มีชื่อ')}</h4>
                        ${n.isAdmin ? '<span class="badge" style="background:#4338ca; color:white; font-size:9px;">ADMIN</span>' : ''}
                    </div>
                    <div style="font-size:12px; color:var(--text-muted); margin-top:4px;">
                        ID: <span style="color:var(--text-primary); font-weight:600">${n.id || '-'}</span> · 
                        HC: <span style="color:var(--primary-dark); font-weight:600">${n.headCode || '5'}</span>
                    </div>
                    <div style="margin-top:10px; display:flex; gap:4px; flex-wrap:wrap;">
                        ${rolesHtml}
                    </div>
                </div>
                <div class="nurse-actions">
                    <button class="mini-btn" onclick="openEditNurseModal('${n.id}')">
                        <span class="material-symbols-rounded" style="font-size:20px">edit</span>
                    </button>
                    <button class="mini-btn" onclick="deleteNurse('${n.id}')" style="color:var(--error)">
                        <span class="material-symbols-rounded" style="font-size:20px">delete</span>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

function importNursesFromScheduler() {
    if (!scheduler || !scheduler.nurses || scheduler.nurses.length === 0) {
        showToast('error', 'ไม่มีข้อมูลรายชื่อในตารางเวรปัจจุบัน');
        return;
    }

    if (!confirm(`ต้องการนำเข้ารายชื่อทั้งหมด ${scheduler.nurses.length} คน เข้าสู่ฐานข้อมูลหลักใช่หรือไม่?`)) return;

    activeNurses = JSON.parse(JSON.stringify(scheduler.nurses));
    saveGlobalSettings();
    renderAll();
    showToast('success', 'นำเข้ารายชื่อพยาบาลเรียบร้อยแล้ว');
}

function openAddNurseModal() {
    document.getElementById('nurseModalTitle').textContent = '👤 เพิ่มพยาบาลใหม่';
    document.getElementById('nurseEditId').value = '';
    document.getElementById('nurseName').value = '';
    document.getElementById('nurseCode').value = '';
    setNurseLevel(1);
    document.getElementById('nurseHeadCode').value = '5';
    document.getElementById('nurseIsAdmin').checked = false;
    renderRoleCheckboxes([]);
    openModal('nurseModal');
}

function openEditNurseModal(id) {
    const n = activeNurses.find(x => x.id === id);
    if (!n) return;

    document.getElementById('nurseModalTitle').textContent = '👤 แก้ไขข้อมูลพยาบาล';
    document.getElementById('nurseEditId').value = n.id;
    document.getElementById('nurseName').value = n.name;
    document.getElementById('nurseCode').value = n.id;
    setNurseLevel(n.level);
    document.getElementById('nurseHeadCode').value = n.headCode;
    document.getElementById('nurseIsAdmin').checked = !!n.isAdmin;
    renderRoleCheckboxes(n.roles);
    openModal('nurseModal');
}

function selectNurseLevel(el) {
    document.querySelectorAll('#nurseLevelGroup input').forEach(input => {
        if (input !== el) input.checked = false;
    });
}

function setNurseLevel(level) {
    const inputs = document.querySelectorAll('#nurseLevelGroup input');
    inputs.forEach(input => {
        input.checked = parseInt(input.value, 10) === parseInt(level, 10);
    });
}

function getSelectedNurseLevel() {
    const checked = document.querySelector('#nurseLevelGroup input:checked');
    return checked ? parseInt(checked.value, 10) : null;
}

function renderRoleCheckboxes(selectedRoles) {
    const container = document.getElementById('nurseRolesList');
    if (!container) return;
    container.innerHTML = Object.entries(activeRoleLabels).map(([key, label]) => `
        <label class="checkbox-field" style="padding:8px; font-size:13px;">
            <input type="checkbox" value="${key}" ${selectedRoles.includes(key) ? 'checked' : ''}>
            ${label}
        </label>
    `).join('');
}

function saveNurse() {
    const editId = document.getElementById('nurseEditId').value;
    const name = document.getElementById('nurseName').value;
    const code = document.getElementById('nurseCode').value;
    const level = getSelectedNurseLevel();
    const headCodeStr = document.getElementById('nurseHeadCode').value;

    const headCode = parseInt(headCodeStr);
    const isAdminFlag = document.getElementById('nurseIsAdmin').checked;

    const roleChecks = document.querySelectorAll('#nurseRolesList input:checked');
    const roles = Array.from(roleChecks).map(c => c.value);

    if (!name || !code) {
        showToast('error', 'กรุณากรอกชื่อและรหัส');
        return;
    }
    if (!level) {
        showToast('error', 'กรุณาเลือกระดับ (1-4)');
        return;
    }

    const nurseObj = { id: code, name, headCode, level, roles, isAdmin: isAdminFlag };

    if (editId) {
        const idx = activeNurses.findIndex(n => n.id === editId);
        if (idx !== -1) activeNurses[idx] = nurseObj;
    } else {
        if (activeNurses.some(n => n.id === code)) {
            showToast('error', 'รหัสพยาบาลซ้ำ');
            return;
        }
        activeNurses.push(nurseObj);
    }

    saveGlobalSettings();
    closeModal('nurseModal');
    renderSettings();
    showToast('success', 'บันทึกข้อมูลพยาบาลเรียบร้อย');

    if (scheduler) {
        scheduler.nurses = activeNurses;
    }
}

function deleteNurse(id) {
    if (!confirm(`ยืนยันการลบ ${id}?`)) return;
    activeNurses = activeNurses.filter(n => n.id !== id);
    saveGlobalSettings();
    renderSettings();
    showToast('success', 'ลบข้อมูลสำเร็จ');
}

function renderQuotaSettings() {
    const container = document.getElementById('quotaSettingsContent');
    if (!container) return;
    let html = '';

    const shifts = ['M', 'A', 'N'];
    shifts.forEach(s => {
        html += `
            <div style="margin-bottom:24px; padding:20px; background:var(--gray-50); border-radius:12px;">
                <h4 style="margin-bottom:12px; color:var(--primary-dark); display:flex; justify-content:space-between; align-items:center;">
                    ${SHIFT_LABELS[s]}
                    <div style="font-size:14px;">โควต้ารวม: 
                        <input type="number" class="form-control" style="width:70px; display:inline-block;" 
                            value="${activeQuota[s]}" onchange="updateQuota('${s}', this.value)">
                    </div>
                </h4>
                <table class="config-table">
                    <thead>
                        <tr><th>ตำแหน่ง</th><th>จำนวนขั้นต่ำ</th></tr>
                    </thead>
                    <tbody>
        `;

        const roles = activeRoleMins[s] || [];
        roles.forEach((r, idx) => {
            html += `
                <tr>
                    <td>${activeRoleLabels[r.role] || r.role}</td>
                    <td>
                        <input type="number" class="form-control" style="width:70px;" value="${r.count}" 
                            onchange="updateRoleMin('${s}', ${idx}, this.value)">
                    </td>
                </tr>
            `;
        });

        html += `</tbody></table></div>`;
    });

    html += `
        <div style="margin-bottom:24px; padding:20px; background:var(--gray-50); border-radius:12px;">
            <h4 style="margin-bottom:12px; color:var(--primary-dark); display:flex; justify-content:space-between; align-items:center;">
                โควต้าการลา (ต่อระดับ)
                <span style="font-size:12px; color:var(--text-muted)">จำกัดจำนวนคนลาพร้อมกัน</span>
            </h4>
            <table class="config-table">
                <thead>
                    <tr><th>Level</th><th>จำนวนสูงสุด</th></tr>
                </thead>
                <tbody>
                    ${[1, 2, 3, 4].map(lv => `
                        <tr>
                            <td>Level ${lv}</td>
                            <td>
                                <input type="number" class="form-control" style="width:70px;" min="0"
                                    value="${activeLeaveLimits[lv] != null ? activeLeaveLimits[lv] : (LEAVE_LIMITS_BY_LEVEL[lv] || 0)}"
                                    onchange="updateLeaveLimit(${lv}, this.value)">
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;

    container.innerHTML = html;
}

function updateQuota(shift, val) {
    activeQuota[shift] = parseInt(val);
    saveGlobalSettings();

    // Dynamically update global for scheduler
    SHIFT_QUOTA[shift] = activeQuota[shift];

    showToast('success', `อัปเดตโควต้าเวร ${shift} แล้ว`);
}

function updateRoleMin(shift, idx, val) {
    activeRoleMins[shift][idx].count = parseInt(val);
    saveGlobalSettings();

    // Dynamically update global for scheduler
    ROLE_MINIMUMS[shift][idx].count = activeRoleMins[shift][idx].count;

    showToast('success', 'อัปเดตจำนวนขั้นต่ำแล้ว');
}

function updateLeaveLimit(level, val) {
    const v = parseInt(val, 10);
    activeLeaveLimits[level] = Number.isFinite(v) ? Math.max(0, v) : 0;
    saveGlobalSettings();
    showToast('success', `อัปเดตโควต้าลาระดับ ${level} แล้ว`);
}

function syncNursesRealToFirebase() {
    if (!firebaseReady || !firebaseDb) {
        showToast('error', 'ยังไม่เชื่อมต่อ Firebase');
        return;
    }
    if (typeof NURSES_REAL === 'undefined' || !Array.isArray(NURSES_REAL) || NURSES_REAL.length === 0) {
        showToast('error', 'ไม่พบข้อมูล NURSES_REAL ในไฟล์');
        return;
    }
    const ok = confirm('ยืนยันอัปเดตรายชื่อพยาบาลจากไฟล์ nurses-real.js ไปยัง Firebase?');
    if (!ok) return;

    activeNurses = normalizeNurses(JSON.parse(JSON.stringify(NURSES_REAL)));
    saveGlobalSettings();

    if (scheduler) {
        scheduler.nurses = activeNurses;
    }
    renderSettings();
    renderAll();
    showToast('success', 'อัปเดตข้อมูลไป Firebase เรียบร้อยแล้ว');
}

function resetToSourceData() {
    if (!confirm('ยืนยันระบบจะรีเซ็ตรายชื่อพยาบาลและเงื่อนไขทั้งหมดกลับไปใช้ค่าเริ่มต้นจากไฟล์ข้อมูล (ข้อมูลที่แก้ไขไว้จะหายไป)?')) return;

    localStorage.removeItem('erms_nurses');
    localStorage.removeItem('erms_quota');
    localStorage.removeItem('erms_role_mins');
    localStorage.removeItem('erms_config');
    void firebaseRemove('erms/settings');

    showToast('info', 'กำลังรีเซ็ตและโหลดข้อมูลใหม่...');
    setTimeout(() => {
        window.location.reload();
    }, 1000);
}

// ──────────────── Import ────────────────
function handleCSVImport(input) {
    const file = input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function (e) {
        let text = e.target.result;
        // Remove Byte Order Mark (BOM) if exists
        if (text.charCodeAt(0) === 0xFEFF) {
            text = text.substring(1);
        }

        try {
            // Ask target month/year for import (default: current view)
            const defaultYM = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`;
            const promptValue = window.prompt('นำเข้าเดือน/ปี (รูปแบบ YYYY-MM), เว้นว่างเพื่อใช้เดือนที่เลือกอยู่', defaultYM);
            if (promptValue === null) return; // user cancelled

            const parseYearMonth = (val) => {
                const trimmed = (val || '').trim();
                if (!trimmed) return { year: currentYear, monthIndex: currentMonth };
                let m = trimmed.match(/^(\d{4})[-\/](\d{1,2})$/);
                if (m) {
                    const y = parseInt(m[1], 10);
                    const mo = parseInt(m[2], 10);
                    if (mo >= 1 && mo <= 12) return { year: y, monthIndex: mo - 1 };
                }
                m = trimmed.match(/^(\d{1,2})[-\/](\d{4})$/);
                if (m) {
                    const mo = parseInt(m[1], 10);
                    const y = parseInt(m[2], 10);
                    if (mo >= 1 && mo <= 12) return { year: y, monthIndex: mo - 1 };
                }
                return null;
            };

            const target = parseYearMonth(promptValue);
            if (!target) {
                showToast('error', 'รูปแบบเดือนไม่ถูกต้อง (ใช้ YYYY-MM เช่น 2026-05)');
                return;
            }

            if (target.year !== currentYear || target.monthIndex !== currentMonth) {
                setCurrentMonthYear(target.year, target.monthIndex);
            }

            const rows = text.split('\n').filter(r => r.trim() !== '');
            if (rows.length < 2) throw new Error('ไฟล์ CSV ไม่ถูกต้อง');

            const header = rows[0].split(',');
            const dayColumns = header.slice(2).map(v => parseInt(v)).filter(v => !isNaN(v));

            if (dayColumns.length === 0) throw new Error('ไม่พบข้อมูลวันที่ในหัวตาราง');

            // Initialize new scheduler state
            const newSchedule = {};
            const newLeaves = {};
            const dateHelper = new NurseScheduler(activeNurses, currentMonth, currentYear);
            // Pre-fill days
            for (let d of dayColumns) {
                const ds = dateHelper.dateStr(d);
                newSchedule[ds] = { M: [], A: [], N: [] };
            }

            // Process data rows
            const dataRows = rows.slice(1);
            dataRows.forEach(row => {
                // Better CSV parsing to handle spaces in names
                const cells = row.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
                if (cells.length < 2) return;

                const nurseId = cells[0].replace(/"/g, '').trim();

                // Map days
                dayColumns.forEach((day, idx) => {
                    const ds = dateHelper.dateStr(day);
                    const cellValue = cells[idx + 2]?.replace(/"/g, '').trim() || '-';

                    if (cellValue === '-') return;

                    // Support multiple shifts e.g. M:Head/A:Med
                    const shiftParts = cellValue.split('/');
                    shiftParts.forEach(part => {
                        let token = part.trim();
                        if (!token) return;

                        const nurse = activeNurses.find(n => n.id === nurseId);
                        const nurseName = nurse ? nurse.name : nurseId;

                        const leaveMap = {
                            'ป': 'sick',
                            'ก': 'personal',
                            'ผ': 'vacation',
                            'V': 'vacation',
                            'อ': 'training',
                            'ชพ': 'preceptor',
                            'ชP': 'preceptor',
                            'ช+': 'preceptor'
                        };

                        // New compact codes: ช, บ, ด (+ i) and leave codes
                        if (leaveMap[token]) {
                            const leaveType = leaveMap[token];
                            const shiftLabel = 'M'; // default for leave-only code
                            const role = leaveType === 'preceptor' ? 'Preceptor' : 'Med';
                            const roleLabel = leaveType === 'preceptor' ? 'Preceptor+' : ROLE_LABELS['Med'];
                            newSchedule[ds][shiftLabel].push({
                                nurseId,
                                nurseName,
                                role,
                                roleLabel,
                                isLeave: true,
                                leaveType,
                                isLeavePlaceholder: leaveType === 'preceptor'
                            });
                            return;
                        }

                        if (token.startsWith('ช') || token.startsWith('บ') || token.startsWith('ด')) {
                            const isIncharge = token.toLowerCase().endsWith('i') || token.endsWith('อ');
                            const shiftLabel = token.startsWith('ช') ? 'M' : (token.startsWith('บ') ? 'A' : 'N');
                            const role = isIncharge ? 'Incharge1' : 'Med';
                            const roleLabel = ROLE_LABELS[role] || role;
                            newSchedule[ds][shiftLabel].push({
                                nurseId,
                                nurseName,
                                role,
                                roleLabel,
                                isLeave: false
                            });
                            return;
                        }

                        let [shiftLabel, role] = token.split(':');
                        let isLeave = false;
                        let leaveType = null;

                        if (shiftLabel.startsWith('ลา(')) {
                            isLeave = true;
                            shiftLabel = shiftLabel.replace('ลา(', '').replace(')', '');
                        }

                        if (['M', 'A', 'N'].includes(shiftLabel)) {
                            const roleLabel = ROLE_LABELS[role || 'Med'] || role || 'Med';
                            newSchedule[ds][shiftLabel].push({
                                nurseId,
                                nurseName,
                                role: role || 'Med', // Default role if missing
                                roleLabel,
                                isLeave,
                                leaveType
                            });
                        }
                    });
                });
            });

            // Apply to scheduler
            if (!scheduler) {
                scheduler = new NurseScheduler(activeNurses, currentMonth, currentYear);
            }
            scheduler.schedule = newSchedule;
            // Build leave list from schedule
            Object.entries(newSchedule).forEach(([dateStr, day]) => {
                ['M', 'A', 'N'].forEach((s) => {
                    (day[s] || []).forEach(a => {
                        if (!a.isLeave) return;
                        if (!newLeaves[dateStr]) newLeaves[dateStr] = [];
                        newLeaves[dateStr].push({
                            nurseId: a.nurseId,
                            nurseName: a.nurseName || a.nurseId,
                            leaveType: a.leaveType || 'personal',
                            urgent: false,
                            reason: ''
                        });
                    });
                });
            });
            scheduler.leaves = newLeaves;
            scheduler.locked = true;
            scheduler.rebuildCounters();

            saveToStorage(); // Fire and forget or background sync for responsive UI
            renderAll();
            showToast('success', 'นำเข้าตารางเวรสำเร็จ! (ระบบกำลังบันทึกเข้า Cloud เบื้องหลัง)');
        } catch (err) {
            console.error(err);
            showToast('error', 'เกิดข้อผิดพลาดในการอ่านไฟล์ CSV: ' + err.message);
        }
    };
    reader.onerror = function () {
        showToast('error', 'ไม่สามารถอ่านไฟล์ได้');
    };
    reader.readAsText(file);
    input.value = ''; // Reset for next time
}
