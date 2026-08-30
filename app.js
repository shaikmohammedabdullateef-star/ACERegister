/* ACE Skills Development Center — Register (Supabase-backed) */

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const DEFAULT_SOURCES = ["Instagram", "Facebook", "WhatsApp", "Referral", "Walk-in", "Google", "JustDial"];
const DEFAULT_COURSES = ["IELTS", "PTE", "Spoken English"];
const STATUSES = ["New Lead", "Enrolled", "Not Interested", "Dropped"];
const FOLLOWUPS = ["Yes", "Pending", "No"];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const STATUS_COLOR = { "New Lead": "#4C4CFF", "Enrolled": "#12A594", "Not Interested": "#8378B0", "Dropped": "#E64A6B" };
const FOLLOW_COLOR = { Yes: "#12A594", Pending: "#F5A623", No: "#E64A6B" };
const FOLLOW_LABEL = { Yes: "Followed up", Pending: "Pending", No: "Not followed up" };
const COURSE_PALETTE = ["#4C4CFF", "#FF6B4A", "#12A594", "#EC4899", "#8B5CF6", "#0EA5E9", "#F5A623", "#22C55E"];
function courseColor(name) {
  let h = 0;
  for (let i = 0; i < (name || "").length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return COURSE_PALETTE[h % COURSE_PALETTE.length];
}
function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function todayStr() { return new Date().toISOString().slice(0, 10); }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.round((d - now) / 86400000);
}
function fmtDate(dateStr) {
  if (!dateStr) return "—";
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}
function waLink(contact) {
  const digits = String(contact || "").replace(/\D/g, "");
  if (!digits) return null;
  return `https://wa.me/${digits.length === 10 ? "91" + digits : digits}`;
}
function showError(msg) {
  const el = document.getElementById("saveError");
  el.textContent = msg;
  el.style.background = "linear-gradient(120deg,#FFE1E8,#FFD0DC)";
  el.style.borderColor = "var(--brick)"; el.style.color = "#8A1235";
  el.style.display = "block";
}
function showNotice(msg) {
  const el = document.getElementById("saveError");
  el.textContent = msg;
  el.style.background = "linear-gradient(120deg,#D6F5EE,#C4EEE3)";
  el.style.borderColor = "#12A594"; el.style.color = "#0B5A4C";
  el.style.display = "block";
}

/* ---------- offline queue (IndexedDB) ---------- */
const IDB_NAME = "ace_offline_queue", IDB_STORE = "queue";
function openQueueDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE, { keyPath: "qid", autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function queueWrite(table, action, payload) {
  const db = await openQueueDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).add({ table, action, payload, queuedAt: new Date().toISOString() });
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
async function getQueued() {
  const db = await openQueueDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).getAll();
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
}
async function clearQueued(qid) {
  const db = await openQueueDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(qid);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
async function performWrite(table, action, payload) {
  if (action === "upsert") {
    const onConflict = table === "targets" ? "tutor_name,month" : "id";
    const { error } = await sb.from(table).upsert(payload, { onConflict });
    if (error) throw error;
  } else if (action === "delete") {
    const { error } = await sb.from(table).delete().eq("id", payload.id);
    if (error) throw error;
  }
}
async function writeWithOfflineFallback(table, action, payload) {
  if (!navigator.onLine) {
    await queueWrite(table, action, payload);
    updateOfflineBadge();
    return { queued: true };
  }
  try {
    await performWrite(table, action, payload);
    return { queued: false };
  } catch (e) {
    await queueWrite(table, action, payload);
    updateOfflineBadge();
    showNotice("Couldn't reach the server just now — saved on this device and will sync automatically.");
    return { queued: true };
  }
}
async function flushOfflineQueue() {
  if (!navigator.onLine) return;
  const items = await getQueued();
  if (!items.length) { updateOfflineBadge(); return; }
  let synced = 0;
  for (const item of items) {
    try {
      await performWrite(item.table, item.action, item.payload);
      await clearQueued(item.qid);
      synced++;
    } catch (e) { break; } // stop at first failure, retry on next online event
  }
  updateOfflineBadge();
  if (synced) {
    showNotice(`Synced ${synced} offline change${synced > 1 ? "s" : ""}.`);
    fetchStudents(); fetchAttendance(); fetchSlots(); fetchTargets();
  }
}
async function updateOfflineBadge() {
  const badge = document.getElementById("offlineBadge");
  const items = await getQueued().catch(() => []);
  if (!navigator.onLine) {
    badge.style.display = "flex";
    badge.className = "offline-badge";
    badge.textContent = `\u{1F4E1} Offline${items.length ? ` — ${items.length} pending` : ""}`;
  } else if (items.length) {
    badge.style.display = "flex";
    badge.className = "offline-badge";
    badge.style.background = "#F5A623";
    badge.textContent = `\u23F3 Syncing ${items.length}...`;
  } else {
    badge.style.display = "none";
  }
}
window.addEventListener("online", flushOfflineQueue);
window.addEventListener("offline", updateOfflineBadge);

/* ---------- state ---------- */
let state = {
  records: [], sources: [...DEFAULT_SOURCES], courses: [...DEFAULT_COURSES],
  search: "", courseFilter: "All", statusFilter: "All", sourceFilter: "All", tutorFilter: "All",
  view: "directory", editing: null, confirmDeleteId: null,
};
let currentUser = null;
let currentProfile = null; // { id, email, full_name, role }
let isAuthorized = false;
let attendanceFeed = [];
let slotList = [];
let targetList = [];

function profileName() {
  return currentProfile?.full_name || currentUser?.email || "Someone";
}
function isAdmin() { return currentProfile?.role === "admin"; }
function canEdit(r) {
  if (!isAuthorized) return false;
  if (isAdmin()) return true;
  if (!r.createdBy) return true;
  return r.createdBy === currentUser.id;
}
function canAdd() { return isAuthorized; }

/* ---------- auth ---------- */
async function initAuth() {
  const { data: { session } } = await sb.auth.getSession();
  await handleSession(session);
  sb.auth.onAuthStateChange(async (_event, session) => { await handleSession(session); });
}
async function handleSession(session) {
  currentUser = session?.user || null;
  if (!currentUser) {
    isAuthorized = false; currentProfile = null;
    state.records = []; attendanceFeed = []; slotList = []; targetList = [];
    renderAuthUI(); render();
    return;
  }
  const { data, error } = await sb.from("profiles").select("*").eq("id", currentUser.id).maybeSingle();
  if (error || !data) {
    showError("This Google account isn't authorized for ACE Register. Ask the admin to add your email.");
    await sb.auth.signOut();
    return;
  }
  currentProfile = data;
  isAuthorized = true;
  renderAuthUI();
  fetchStudents(); fetchAttendance(); fetchSlots(); fetchTargets();
  subscribeRealtime();
}
function signIn() {
  sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.href.split("#")[0] } });
}
function signOutUser() { sb.auth.signOut(); }
function renderAuthUI() {
  const host = document.getElementById("authArea");
  if (currentUser && isAuthorized) {
    host.innerHTML = `<button class="btn btn-ghost-dark" id="signOutBtn" title="${esc(currentUser.email)}">&#9729;&#65039; ${esc(profileName().split(" ")[0])} · Sign out</button>`;
    document.getElementById("signOutBtn").addEventListener("click", signOutUser);
  } else {
    host.innerHTML = `<button class="btn btn-ghost-dark" id="signInBtn">&#128231; Sign in with Google</button>`;
    document.getElementById("signInBtn").addEventListener("click", signIn);
  }
}

/* ---------- realtime (refetch-on-change, simple and robust) ---------- */
let realtimeSubscribed = false;
function subscribeRealtime() {
  if (realtimeSubscribed) return;
  realtimeSubscribed = true;
  sb.channel("students-rt").on("postgres_changes", { event: "*", schema: "public", table: "students" }, fetchStudents).subscribe();
  sb.channel("attendance-rt").on("postgres_changes", { event: "*", schema: "public", table: "attendance_log" }, fetchAttendance).subscribe();
  sb.channel("slots-rt").on("postgres_changes", { event: "*", schema: "public", table: "tutor_slots" }, fetchSlots).subscribe();
  sb.channel("targets-rt").on("postgres_changes", { event: "*", schema: "public", table: "targets" }, fetchTargets).subscribe();
}

/* ---------- students ---------- */
function mapStudentRow(row) {
  return {
    id: row.id, name: row.name, contact: row.contact, email: row.email || "",
    leadSource: row.lead_source, courseInterest: row.course_interest,
    classMode: row.class_mode, classType: row.class_type, classTiming: row.class_timing || "",
    feeOffered: row.fee_offered ?? "", status: row.status, followedUp: row.followed_up,
    feedback: row.feedback || "", joiningDate: row.joining_date || "", renewalDate: row.renewal_date || "",
    notes: row.notes || "", createdBy: row.created_by, createdByName: row.created_by_name,
    createdAt: row.created_at ? row.created_at.slice(0, 10) : todayStr(),
  };
}
function studentToRow(r) {
  return {
    id: r.id, name: r.name, contact: r.contact, email: r.email || null,
    lead_source: r.leadSource, course_interest: r.courseInterest,
    class_mode: r.classMode, class_type: r.classType, class_timing: r.classTiming || null,
    fee_offered: r.feeOffered !== "" && r.feeOffered != null ? parseFloat(r.feeOffered) : null,
    status: r.status, followed_up: r.followedUp, feedback: r.feedback || null,
    joining_date: r.joiningDate || null, renewal_date: r.renewalDate || null, notes: r.notes || null,
    created_by: r.createdBy, created_by_name: r.createdByName,
  };
}
async function fetchStudents() {
  if (!isAuthorized) return;
  const { data, error } = await sb.from("students").select("*").order("created_at", { ascending: false });
  if (error) { showError("Couldn't load students right now."); return; }
  state.records = (data || []).map(mapStudentRow);
  render();
}
async function writeRecord(record, isNew) {
  if (isNew) {
    record.createdBy = currentUser.id;
    if (!record.createdByName || !record.createdByName.trim()) record.createdByName = profileName();
  }
  const exists = state.records.some((x) => x.id === record.id);
  state.records = exists ? state.records.map((x) => (x.id === record.id ? record : x)) : [record, ...state.records];
  renderToolbar(); renderRecords();
  await writeWithOfflineFallback("students", "upsert", studentToRow(record));
}
async function deleteRecordRemote(id) {
  state.records = state.records.filter((x) => x.id !== id);
  renderRecords();
  await writeWithOfflineFallback("students", "delete", { id });
}

/* ---------- attendance ---------- */
async function fetchAttendance() {
  if (!isAuthorized) return;
  const { data, error } = await sb.from("attendance_log").select("*").order("entry_time", { ascending: false }).limit(300);
  if (error) return;
  attendanceFeed = data || [];
  if (attendanceOpen) renderAttendance();
}
function timeStrToISO(timeStr) {
  const [h, m] = (timeStr || "00:00").split(":").map(Number);
  const d = new Date(); d.setHours(h || 0, m || 0, 0, 0);
  return d.toISOString();
}
function nowAsTimeInput() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
async function postAttendance(type, timeStr) {
  const row = {
    id: uid(), tutor_id: currentUser.id, tutor_name: profileName(),
    entry_type: type, entry_date: todayStr(), entry_time: timeStrToISO(timeStr), note: null,
  };
  attendanceFeed.unshift({ ...row, created_at: new Date().toISOString() });
  renderAttendance();
  await writeWithOfflineFallback("attendance_log", "upsert", row);
}
async function deleteAttendanceEntry(id) {
  attendanceFeed = attendanceFeed.filter((a) => a.id !== id);
  renderAttendance();
  await writeWithOfflineFallback("attendance_log", "delete", { id });
}

/* ---------- tutor slots ---------- */
async function fetchSlots() {
  if (!isAuthorized) return;
  const { data, error } = await sb.from("tutor_slots").select("*").order("day_of_week").order("start_time");
  if (error) return;
  slotList = data || [];
  if (scheduleOpen) renderSchedule();
}
async function writeSlot(slot, isNew) {
  if (isNew) { slot.tutor_id = currentUser.id; if (!slot.tutor_name) slot.tutor_name = profileName(); }
  const exists = slotList.some((x) => x.id === slot.id);
  slotList = exists ? slotList.map((x) => (x.id === slot.id ? slot : x)) : [...slotList, slot];
  renderSchedule();
  await writeWithOfflineFallback("tutor_slots", "upsert", slot);
}
async function deleteSlot(id) {
  slotList = slotList.filter((x) => x.id !== id);
  renderSchedule();
  await writeWithOfflineFallback("tutor_slots", "delete", { id });
}
function distinctSlotTutors() {
  return Array.from(new Set(slotList.map((s) => s.tutor_name || "Unassigned"))).sort();
}

/* ---------- targets ---------- */
async function fetchTargets() {
  if (!isAuthorized) return;
  const { data, error } = await sb.from("targets").select("*");
  if (error) return;
  targetList = data || [];
  if (targetsOpen) renderTargets();
}
async function setTarget(tutorName, monthYm, value) {
  const row = { tutor_name: tutorName, month: `${monthYm}-01`, target_count: value, updated_by: profileName() };
  const idx = targetList.findIndex((t) => t.tutor_name === tutorName && t.month === row.month);
  if (idx >= 0) targetList[idx] = { ...targetList[idx], ...row }; else targetList.push(row);
  renderTargets();
  await writeWithOfflineFallback("targets", "upsert", row);
}
function actualForTutorMonth(tutorName, month) {
  return state.records.filter((r) => (r.createdByName || "Unassigned") === tutorName && r.status === "Enrolled" && r.joiningDate && r.joiningDate.slice(0, 7) === month).length;
}

/* ---------- derived / filtering ---------- */
function filteredRecords() {
  return state.records.filter((r) => {
    if (state.courseFilter !== "All" && r.courseInterest !== state.courseFilter) return false;
    if (state.statusFilter !== "All" && r.status !== state.statusFilter) return false;
    if (state.sourceFilter !== "All" && r.leadSource !== state.sourceFilter) return false;
    if (state.tutorFilter !== "All" && (r.createdByName || "Unassigned") !== state.tutorFilter) return false;
    if (state.search.trim()) {
      const q = state.search.toLowerCase();
      if (!r.name.toLowerCase().includes(q) && !r.contact.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}
function distinctTutors() {
  return Array.from(new Set(state.records.map((r) => r.createdByName || "Unassigned"))).sort();
}
function computeStats() {
  return {
    total: state.records.length,
    enrolled: state.records.filter((r) => r.status === "Enrolled").length,
    pending: state.records.filter((r) => r.followedUp !== "Yes").length,
    renewals: state.records.filter((r) => { const d = daysUntil(r.renewalDate); return d !== null && d <= 30 && r.status === "Enrolled"; }).length,
  };
}

/* ---------- scroll reveal (main page list only) ---------- */
let revealObserver = null;
function observeReveal() {
  if (!("IntersectionObserver" in window)) { document.querySelectorAll(".record").forEach((el) => el.classList.add("in-view")); return; }
  if (!revealObserver) {
    revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in-view"); revealObserver.unobserve(e.target); } });
    }, { threshold: 0.05 });
  }
  document.querySelectorAll(".record:not(.in-view)").forEach((el) => revealObserver.observe(el));
}

/* ---------- renewal reminders ---------- */
let bannerDismissed = false;
function upcomingRenewals() {
  return state.records.filter((r) => r.status === "Enrolled" && r.renewalDate)
    .map((r) => ({ r, days: daysUntil(r.renewalDate) })).filter((x) => x.days !== null && x.days <= 7)
    .sort((a, b) => a.days - b.days);
}
function renderRenewalBanner() {
  const host = document.getElementById("bannerHost");
  if (bannerDismissed) { host.innerHTML = ""; return; }
  const list = upcomingRenewals();
  if (!list.length) { host.innerHTML = ""; return; }
  const overdue = list.filter((x) => x.days < 0);
  const cls = overdue.length ? "banner-overdue" : "banner-renew";
  const names = list.slice(0, 4).map((x) => `${esc(x.r.name)} (${x.days < 0 ? `${Math.abs(x.days)}d overdue` : x.days === 0 ? "today" : `in ${x.days}d`})`).join(", ");
  host.innerHTML = `<div class="banner ${cls}"><span>${overdue.length ? "\u{1F6A8}" : "\u{1F514}"}</span>
    <span><b>${list.length} renewal${list.length > 1 ? "s" : ""} due soon:</b> ${names}${list.length > 4 ? ` +${list.length - 4} more` : ""}</span>
    <button class="banner-close" id="bannerCloseBtn">&#10005; Dismiss</button></div>`;
  document.getElementById("bannerCloseBtn").addEventListener("click", () => { bannerDismissed = true; renderRenewalBanner(); });
}

/* ---------- main render ---------- */
function render() {
  renderRenewalBanner(); renderStats(); renderToolbar(); renderRecords(); renderModal();
}
function renderStats() {
  const s = computeStats();
  document.getElementById("statsRow").innerHTML = `
    <div class="stat-card" style="--grad:linear-gradient(135deg,#5B5BFF,#4C4CFF)"><div class="stat-label">&#128101; Total Leads</div><div class="stat-value">${s.total}</div></div>
    <div class="stat-card" style="--grad:linear-gradient(135deg,#17C0AC,#12A594)"><div class="stat-label">&#9989; Enrolled</div><div class="stat-value">${s.enrolled}</div></div>
    <div class="stat-card" style="--grad:linear-gradient(135deg,#FF7A5C,#E64A6B)"><div class="stat-label">&#128276; Follow-up Pending</div><div class="stat-value">${s.pending}</div></div>
    <div class="stat-card" style="--grad:linear-gradient(135deg,#FFC157,#F5A623)"><div class="stat-label">&#9203; Renewals Due (30d)</div><div class="stat-value">${s.renewals}</div></div>`;
}
function renderToolbar() {
  const host = document.getElementById("toolbar");
  if (state.view !== "list") { host.innerHTML = ""; return; }
  const statusOpts = ["All", ...STATUSES].map((o) => `<option value="${esc(o)}" ${state.statusFilter === o ? "selected" : ""}>${o === "All" ? "Status: All" : esc(o)}</option>`).join("");
  const sourceOpts = ["All", ...state.sources].map((o) => `<option value="${esc(o)}" ${state.sourceFilter === o ? "selected" : ""}>${o === "All" ? "Source: All" : esc(o)}</option>`).join("");
  const tutors = distinctTutors();
  const tutorOpts = ["All", ...tutors].map((o) => `<option value="${esc(o)}" ${state.tutorFilter === o ? "selected" : ""}>${o === "All" ? "Tutor: All" : esc(o)}</option>`).join("");
  const tabs = ["All", ...state.courses].map((c) => {
    const active = state.courseFilter === c; const bg = c === "All" ? "var(--ink)" : courseColor(c);
    return `<button class="tab ${active ? "active" : ""}" style="${active ? `background:${bg}` : ""}" data-course-tab="${esc(c)}">${esc(c)}</button>`;
  }).join("");
  host.innerHTML = `<div class="toolbar-row">
      <button class="btn btn-light" id="backToTutorsBtn">&#8592; All Tutors</button>
      <div class="search-wrap"><span class="search-icon">&#128269;</span><input id="searchInput" placeholder="Search by name or contact number…" value="${esc(state.search)}" /></div>
      <select class="filter-select" id="statusFilter">${statusOpts}</select>
      <select class="filter-select" id="sourceFilter">${sourceOpts}</select>
      ${tutors.length > 1 ? `<select class="filter-select" id="tutorFilter">${tutorOpts}</select>` : ""}
    </div><div class="tabs">${tabs}</div>`;
  document.getElementById("backToTutorsBtn").addEventListener("click", () => { state.view = "directory"; state.tutorFilter = "All"; state.search = ""; render(); });
  document.getElementById("searchInput").addEventListener("input", (e) => { state.search = e.target.value; renderRecords(); });
  document.getElementById("statusFilter").addEventListener("change", (e) => { state.statusFilter = e.target.value; renderRecords(); });
  document.getElementById("sourceFilter").addEventListener("change", (e) => { state.sourceFilter = e.target.value; renderRecords(); });
  document.getElementById("tutorFilter")?.addEventListener("change", (e) => { state.tutorFilter = e.target.value; renderRecords(); });
  document.querySelectorAll("[data-course-tab]").forEach((btn) => btn.addEventListener("click", () => { state.courseFilter = btn.dataset.courseTab; renderToolbar(); renderRecords(); }));
}
function tutorStats(name) {
  const mine = state.records.filter((r) => (r.createdByName || "Unassigned") === name);
  return { total: mine.length, enrolled: mine.filter((r) => r.status === "Enrolled").length, pending: mine.filter((r) => r.followedUp !== "Yes").length };
}
function openTutorView(name) { state.tutorFilter = name; state.view = "list"; state.search = ""; render(); }
function renderTutorDirectory() {
  const wrap = document.getElementById("recordsWrap");
  const tutors = distinctTutors();
  if (!tutors.length) {
    wrap.innerHTML = `<div class="empty"><div style="font-size:26px;opacity:.5">&#128101;</div><p>${!canAdd() ? "Sign in with an approved Google account to view the tutor directory." : "No tutors have added students yet."}</p></div>`;
    return;
  }
  wrap.innerHTML = `<div class="records">${tutors.map((name) => {
    const s = tutorStats(name); const color = courseColor(name);
    return `<div class="record tutor-card" data-tutor="${esc(name)}" style="--course-color:${color};cursor:pointer;opacity:1;transform:none">
      <div class="record-top"><div style="flex:1 1 200px">
        <div class="record-name-row"><span class="record-name">&#128100; ${esc(name)}</span></div>
        <div class="meta-row"><span class="meta-item">&#128101; ${s.total} student${s.total === 1 ? "" : "s"}</span>
          <span class="meta-item" style="color:#12A594;font-weight:700">&#9989; ${s.enrolled} enrolled</span>
          ${s.pending ? `<span class="meta-item" style="color:#E64A6B;font-weight:700">&#128276; ${s.pending} pending</span>` : ""}</div>
      </div><div class="record-right"><span class="icon-btn" style="color:${color};border-color:${color}33">&#8594;</span></div></div>
    </div>`;
  }).join("")}</div>`;
  document.querySelectorAll(".tutor-card").forEach((el) => el.addEventListener("click", () => openTutorView(el.dataset.tutor)));
}
function renderRecords() {
  if (state.view !== "list") { renderTutorDirectory(); return; }
  const list = filteredRecords();
  const wrap = document.getElementById("recordsWrap");
  if (!list.length) {
    wrap.innerHTML = `<div class="empty"><div style="font-size:26px;opacity:.5">&#128214;</div><p>${state.records.length === 0 ? "The register is empty. Add your first lead to begin." : "No entries match these filters."}</p></div>`;
    return;
  }
  wrap.innerHTML = `<div class="records">${list.map(recordCardHTML).join("")}</div>`;
  list.forEach((r) => {
    document.getElementById(`edit-${r.id}`)?.addEventListener("click", () => openEdit(r.id));
    document.getElementById(`del-${r.id}`)?.addEventListener("click", () => { state.confirmDeleteId = r.id; renderRecords(); });
    document.getElementById(`delyes-${r.id}`)?.addEventListener("click", () => { deleteRecordRemote(r.id); state.confirmDeleteId = null; });
    document.getElementById(`delno-${r.id}`)?.addEventListener("click", () => { state.confirmDeleteId = null; renderRecords(); });
  });
  observeReveal();
}
function recordCardHTML(r) {
  const sc = STATUS_COLOR[r.status] || "#4C4CFF", fc = FOLLOW_COLOR[r.followedUp] || "#F5A623", cc = courseColor(r.courseInterest);
  const renewIn = daysUntil(r.renewalDate);
  const renewSoon = renewIn !== null && renewIn <= 30 && r.status === "Enrolled";
  const renewColor = renewIn < 0 ? "#E64A6B" : "#F5A623";
  const editable = canEdit(r);
  let actions;
  if (state.confirmDeleteId === r.id) {
    actions = `<button class="icon-btn" id="delyes-${r.id}" style="color:#E64A6B;border-color:#E64A6B33">&#10003;</button><button class="icon-btn" id="delno-${r.id}" style="color:#8378B0;border-color:#8378B033">&#10005;</button>`;
  } else if (editable) {
    actions = `<button class="icon-btn" id="edit-${r.id}" style="color:#4C4CFF;border-color:#4C4CFF33">&#9998;</button><button class="icon-btn" id="del-${r.id}" style="color:#E64A6B;border-color:#E64A6B33">&#128465;</button>`;
  } else {
    actions = `<span class="icon-btn" style="color:#8378B0;border-color:#8378B033;cursor:default" title="Only ${esc(r.createdByName || "the tutor")} can edit this">&#128274;</span>`;
  }
  return `<div class="record" style="--course-color:${cc}"><div class="record-top"><div style="flex:1 1 240px">
      <div class="record-name-row"><span class="record-name">${esc(r.name)}</span><span class="stamp" style="color:${sc};border-color:${sc}">${esc(r.status)}</span></div>
      <div class="meta-row"><span class="meta-item">&#128222; ${esc(r.contact)}</span>
        ${waLink(r.contact) ? `<a class="meta-item" href="${waLink(r.contact)}" target="_blank" rel="noopener" style="color:#12A594;text-decoration:none;font-weight:600">&#128172; WhatsApp</a>` : ""}
        ${r.email ? `<span class="meta-item">&#9993;&#65039; ${esc(r.email)}</span>` : ""}
        <span class="meta-item">&#127991;&#65039; ${esc(r.leadSource)}</span>
        <span class="meta-item course-tag" style="--course-color:${cc}">&#128214; ${esc(r.courseInterest)}</span>
        ${r.classMode ? `<span class="meta-item">${r.classMode === "Online" ? "&#128421;&#65039;" : "&#127963;&#65039;"} ${esc(r.classMode)}</span>` : ""}
        ${r.classType ? `<span class="meta-item">${r.classType === "Group" ? "&#128101;" : "&#128100;"} ${esc(r.classType)}</span>` : ""}
        ${r.classTiming ? `<span class="meta-item">&#128337; ${esc(r.classTiming)}</span>` : ""}
        ${r.feeOffered ? `<span class="meta-item">&#8377; ${esc(r.feeOffered)}</span>` : ""}
        ${r.createdByName ? `<span class="meta-item" style="opacity:.75">&#128100; Added by ${esc(r.createdByName)}</span>` : ""}</div>
      ${r.feedback ? `<div class="feedback-row">&#128172; <span>${esc(r.feedback)}</span></div>` : ""}</div>
    <div class="record-right"><span class="follow-badge" style="color:${fc}"><span class="dot" style="background:${fc}"></span>${FOLLOW_LABEL[r.followedUp] || "Pending"}</span>
      ${r.joiningDate ? `<span class="date-note">&#128197; Joined ${fmtDate(r.joiningDate)}</span>` : ""}
      ${r.renewalDate ? `<span class="renew-note" style="color:${renewSoon ? renewColor : "#8a8470"}">Renewal ${fmtDate(r.renewalDate)}${renewSoon ? (renewIn < 0 ? " · overdue" : ` · in ${renewIn}d`) : ""}</span>` : ""}
      <div class="row-actions">${actions}</div></div></div></div>`;
}

/* ---------- add/edit modal ---------- */
function emptyRecord() {
  return { id: uid(), name: "", contact: "", email: "", leadSource: state.sources[0] || "", courseInterest: state.courses[0] || "",
    classMode: "Offline", classType: "Group", classTiming: "", feeOffered: "", feedback: "", followedUp: "Pending", status: "New Lead",
    joiningDate: "", renewalDate: "", notes: "", createdAt: todayStr(), createdBy: null, createdByName: null };
}
function openAdd() {
  if (!canAdd()) { showError("Please sign in with an approved Google account before adding entries."); return; }
  state.editing = emptyRecord(); renderModal();
}
function openEdit(id) {
  const r = state.records.find((x) => x.id === id);
  if (!r || !canEdit(r)) return;
  state.editing = { ...r }; renderModal();
}
function closeModal() { state.editing = null; renderModal(); }
function renderModal() {
  const host = document.getElementById("modalHost");
  if (!state.editing) { host.innerHTML = ""; return; }
  const r = state.editing;
  const sourceOpts = state.sources.map((s) => `<option value="${esc(s)}" ${r.leadSource === s ? "selected" : ""}>${esc(s)}</option>`).join("");
  const courseOpts = state.courses.map((c) => `<option value="${esc(c)}" ${r.courseInterest === c ? "selected" : ""}>${esc(c)}</option>`).join("");
  const statusOpts = STATUSES.map((s) => `<option value="${esc(s)}" ${r.status === s ? "selected" : ""}>${esc(s)}</option>`).join("");
  const followOpts = FOLLOWUPS.map((f) => `<option value="${esc(f)}" ${r.followedUp === f ? "selected" : ""}>${esc(f)}</option>`).join("");
  const isNew = !state.records.some((x) => x.id === r.id);
  host.innerHTML = `<div class="overlay" id="modalOverlay"><div class="modal">
    <div class="modal-head"><h2>${isNew ? "New Register Entry" : `Edit — ${esc(r.name || "Entry")}`}</h2><button class="icon-btn" id="modalClose" style="border-color:#8a847033;color:#8a8470">&#10005;</button></div>
    <div class="form-grid">
      ${isNew ? `<label class="field span2">Your name (shown as who added this)<input id="f_addedby" value="${esc(profileName())}" /></label>` : ""}
      <label class="field">Full name *<input id="f_name" value="${esc(r.name)}" placeholder="e.g. Priya Sharma" /></label>
      <label class="field">Contact number *<input id="f_contact" value="${esc(r.contact)}" placeholder="10-digit mobile" /></label>
      <label class="field">Email<input id="f_email" type="email" value="${esc(r.email || "")}" /></label>
      <label class="field">Lead source<select id="f_source">${sourceOpts}</select></label>
      <label class="field">Course interest<select id="f_course">${courseOpts}</select></label>
      <label class="field">Class mode<select id="f_classmode"><option value="Offline" ${r.classMode === "Offline" ? "selected" : ""}>Offline</option><option value="Online" ${r.classMode === "Online" ? "selected" : ""}>Online</option></select></label>
      <label class="field">Class type<select id="f_classtype"><option value="Group" ${r.classType === "Group" ? "selected" : ""}>Group</option><option value="One-on-One" ${r.classType === "One-on-One" ? "selected" : ""}>One-on-One</option></select></label>
      <label class="field">Class timing<input id="f_timing" value="${esc(r.classTiming || "")}" placeholder="e.g. 10–11 AM" /></label>
      <label class="field">Fee offered (₹)<input id="f_fee" type="number" value="${esc(r.feeOffered)}" /></label>
      <label class="field">Status<select id="f_status">${statusOpts}</select></label>
      <label class="field">Followed up?<select id="f_follow">${followOpts}</select></label>
      <label class="field">Joining date<input id="f_joining" type="date" value="${esc(r.joiningDate)}" /></label>
      <label class="field">Renewal due date<input id="f_renewal" type="date" value="${esc(r.renewalDate)}" /></label>
      <label class="field span2">Feedback<textarea id="f_feedback" rows="2">${esc(r.feedback)}</textarea></label>
      <label class="field span2">Notes<textarea id="f_notes" rows="2">${esc(r.notes)}</textarea></label>
    </div>
    <div class="modal-actions"><button class="btn btn-light" id="modalCancel">Cancel</button><button class="btn btn-brass" id="modalSave">&#10003; Save Entry</button></div>
  </div></div>`;
  document.getElementById("modalOverlay").addEventListener("mousedown", (e) => { if (e.target.id === "modalOverlay") closeModal(); });
  document.getElementById("modalClose").addEventListener("click", closeModal);
  document.getElementById("modalCancel").addEventListener("click", closeModal);
  document.getElementById("modalSave").addEventListener("click", () => {
    const name = document.getElementById("f_name").value.trim();
    const contact = document.getElementById("f_contact").value.trim();
    if (!name || !contact) return;
    if (isNew) {
      const dupe = state.records.find((x) => x.contact.trim() === contact);
      if (dupe && !window.confirm(`A student with this number is already registered (${dupe.name}, added by ${dupe.createdByName || "someone"}).\n\nAdd anyway?`)) return;
    }
    const addedByInput = document.getElementById("f_addedby");
    const updated = { ...r, name, contact, email: document.getElementById("f_email").value.trim(),
      leadSource: document.getElementById("f_source").value, courseInterest: document.getElementById("f_course").value,
      classMode: document.getElementById("f_classmode").value, classType: document.getElementById("f_classtype").value,
      classTiming: document.getElementById("f_timing").value.trim(), feeOffered: document.getElementById("f_fee").value,
      status: document.getElementById("f_status").value, followedUp: document.getElementById("f_follow").value,
      joiningDate: document.getElementById("f_joining").value, renewalDate: document.getElementById("f_renewal").value,
      feedback: document.getElementById("f_feedback").value, notes: document.getElementById("f_notes").value };
    if (addedByInput) updated.createdByName = addedByInput.value.trim();
    writeRecord(updated, isNew);
    if (isNew) { state.view = "list"; state.tutorFilter = updated.createdByName || profileName(); }
    state.editing = null; renderModal();
  });
}

/* ---------- settings (customize) ---------- */
let settingsOpen = false, newSourceVal = "", newCourseVal = "";
function renderSettings() {
  const host = document.getElementById("settingsHost");
  if (!settingsOpen) { host.innerHTML = ""; return; }
  const sourceChips = state.sources.map((s) => `<span class="chip">${esc(s)}<button data-rm-source="${esc(s)}">&#10005;</button></span>`).join("");
  const courseChips = state.courses.map((c) => `<span class="chip">${esc(c)}<button data-rm-course="${esc(c)}">&#10005;</button></span>`).join("");
  host.innerHTML = `<div class="overlay" id="settingsOverlay"><div class="modal" style="max-width:420px">
    <div class="modal-head"><h2>Customize Register</h2><button class="icon-btn" id="settingsClose" style="border-color:#8a847033;color:#8a8470">&#10005;</button></div>
    <div style="font-size:12.5px;font-weight:700;color:var(--text-muted);margin-bottom:6px">Lead sources</div><div class="chips">${sourceChips}</div>
    <div class="add-row"><input id="newSourceInput" value="${esc(newSourceVal)}" placeholder="e.g. YouTube" /><button class="btn btn-light" id="addSourceBtn">+</button></div>
    <div style="height:14px"></div>
    <div style="font-size:12.5px;font-weight:700;color:var(--text-muted);margin-bottom:6px">Courses</div><div class="chips">${courseChips}</div>
    <div class="add-row"><input id="newCourseInput" value="${esc(newCourseVal)}" placeholder="e.g. Business English" /><button class="btn btn-light" id="addCourseBtn">+</button></div>
    <div class="modal-actions"><button class="btn btn-brass" id="settingsDone">Done</button></div>
  </div></div>`;
  document.getElementById("settingsOverlay").addEventListener("mousedown", (e) => { if (e.target.id === "settingsOverlay") { settingsOpen = false; renderSettings(); } });
  document.getElementById("settingsClose").addEventListener("click", () => { settingsOpen = false; renderSettings(); });
  document.getElementById("settingsDone").addEventListener("click", () => { settingsOpen = false; renderSettings(); });
  document.getElementById("addSourceBtn").addEventListener("click", () => { const v = document.getElementById("newSourceInput").value.trim(); if (v && !state.sources.includes(v)) state.sources.push(v); newSourceVal = ""; renderToolbar(); renderSettings(); });
  document.getElementById("addCourseBtn").addEventListener("click", () => { const v = document.getElementById("newCourseInput").value.trim(); if (v && !state.courses.includes(v)) state.courses.push(v); newCourseVal = ""; renderToolbar(); renderSettings(); });
  document.querySelectorAll("[data-rm-source]").forEach((b) => b.addEventListener("click", () => { state.sources = state.sources.filter((s) => s !== b.dataset.rmSource); renderToolbar(); renderSettings(); }));
  document.querySelectorAll("[data-rm-course]").forEach((b) => b.addEventListener("click", () => { state.courses = state.courses.filter((c) => c !== b.dataset.rmCourse); renderToolbar(); renderSettings(); }));
}

/* ---------- attendance UI (WhatsApp-style shared feed) ---------- */
let attendanceOpen = false;
function openAttendanceBtn() {
  if (!canAdd()) { showError("Please sign in with an approved Google account to view attendance."); return; }
  attendanceOpen = true; fetchAttendance(); renderAttendance();
}
function closeAttendance() { attendanceOpen = false; renderAttendance(); }
function renderAttendance() {
  const host = document.getElementById("attendanceHost");
  if (!attendanceOpen) { host.innerHTML = ""; return; }
  const groups = {};
  attendanceFeed.forEach((a) => { (groups[a.entry_date] = groups[a.entry_date] || []).push(a); });
  const days = Object.keys(groups).sort().reverse();
  const feedHTML = days.length ? days.map((day) => {
    const items = groups[day].sort((a, b) => new Date(b.entry_time) - new Date(a.entry_time));
    const label = day === todayStr() ? "Today" : new Date(day + "T00:00:00").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" });
    const bubbles = items.map((a) => {
      const time = new Date(a.entry_time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
      const actionLabel = a.entry_type === "login" ? "Logged in" : a.entry_type === "logout" ? "Logged out" : "On leave";
      const mine = currentUser && a.tutor_id === currentUser.id;
      const delBtn = (mine || isAdmin()) ? `<button data-del-att="${a.id}" style="border:none;background:none;color:var(--brick);cursor:pointer;font-size:11px">Delete</button>` : "";
      return `<div class="feed-bubble ${a.entry_type}"><div class="feed-name">${esc(a.tutor_name)}</div><div class="feed-action">${actionLabel} · ${time}</div><div class="feed-time">posted ${new Date(a.created_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}<span>${delBtn}</span></div></div>`;
    }).join("");
    return `<div class="day-group-label">${label}</div>${bubbles}`;
  }).join("") : `<div class="empty" style="padding:24px"><p>No entries yet. Post your login below.</p></div>`;

  host.innerHTML = `<div class="overlay" id="attendanceOverlay"><div class="modal" style="max-width:480px">
    <div class="modal-head"><h2>Tutor Attendance</h2><button class="icon-btn" id="attendanceClose" style="border-color:#8a847033;color:#8a8470">&#10005;</button></div>
    <div style="font-size:12px;font-weight:700;color:var(--text-muted);margin-bottom:8px">Type your time, then post — visible to the whole team instantly</div>
    <div style="display:flex;gap:8px;margin-bottom:8px;align-items:center">
      <input type="time" id="loginTimeInput" value="${nowAsTimeInput()}" style="padding:8px;border:1px solid var(--surface-line);border-radius:9px;font-size:13px;background:var(--surface-solid);color:var(--text-main);flex:1" />
      <button class="btn btn-brass" id="postLoginBtn" style="padding:9px 14px">&#9203; Log In</button>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center">
      <input type="time" id="logoutTimeInput" value="${nowAsTimeInput()}" style="padding:8px;border:1px solid var(--surface-line);border-radius:9px;font-size:13px;background:var(--surface-solid);color:var(--text-main);flex:1" />
      <button class="btn btn-light" id="postLogoutBtn" style="padding:9px 14px">&#128683; Log Out</button>
    </div>
    <button class="btn btn-light" id="postLeaveBtn" style="width:100%;justify-content:center;padding:8px;margin-bottom:14px">&#127796; Mark Today as Leave</button>
    <div style="font-size:12px;font-weight:700;color:var(--text-muted);margin-bottom:6px">Shared feed — everyone's entries, most recent first</div>
    <div style="max-height:340px;overflow-y:auto">${feedHTML}</div>
    <div class="modal-actions"><button class="btn btn-brass" id="attendanceDone">Close</button></div>
  </div></div>`;
  document.getElementById("attendanceOverlay").addEventListener("mousedown", (e) => { if (e.target.id === "attendanceOverlay") closeAttendance(); });
  document.getElementById("attendanceClose").addEventListener("click", closeAttendance);
  document.getElementById("attendanceDone").addEventListener("click", closeAttendance);
  document.getElementById("postLoginBtn").addEventListener("click", () => postAttendance("login", document.getElementById("loginTimeInput").value));
  document.getElementById("postLogoutBtn").addEventListener("click", () => postAttendance("logout", document.getElementById("logoutTimeInput").value));
  document.getElementById("postLeaveBtn").addEventListener("click", () => postAttendance("leave", nowAsTimeInput()));
  document.querySelectorAll("[data-del-att]").forEach((b) => b.addEventListener("click", () => deleteAttendanceEntry(b.dataset.delAtt)));
}

/* ---------- tutor slots UI ---------- */
let scheduleOpen = false, scheduleTutorFilter = "All", scheduleEditing = null, scheduleConfirmDeleteId = null;
function emptySlot() { return { id: uid(), day_of_week: WEEKDAYS[0], start_time: "09:00", end_time: "10:00", mode: "Offline", slot_type: "Group", student_names: [], tutor_id: null, tutor_name: "" }; }
function openScheduleBtn() {
  if (!canAdd()) { showError("Please sign in with an approved Google account to view slots."); return; }
  scheduleOpen = true; fetchSlots(); renderSchedule();
}
function closeSchedule() { scheduleOpen = false; scheduleEditing = null; renderSchedule(); }
function canEditSlot(s) { if (!isAuthorized) return false; if (isAdmin()) return true; return s.tutor_id === currentUser.id; }
function renderSchedule() {
  const host = document.getElementById("scheduleHost");
  if (!scheduleOpen) { host.innerHTML = ""; return; }
  if (scheduleEditing) { renderSlotForm(); return; }
  const tutors = distinctSlotTutors();
  const tutorOpts = ["All", ...tutors].map((t) => `<option value="${esc(t)}" ${scheduleTutorFilter === t ? "selected" : ""}>${t === "All" ? "Tutor: All" : esc(t)}</option>`).join("");
  const filtered = scheduleTutorFilter === "All" ? slotList : slotList.filter((s) => (s.tutor_name || "Unassigned") === scheduleTutorFilter);
  const byDay = {}; WEEKDAYS.forEach((d) => (byDay[d] = []));
  filtered.forEach((s) => { (byDay[s.day_of_week] = byDay[s.day_of_week] || []).push(s); });
  const dayBlocks = WEEKDAYS.map((day) => {
    const slots = (byDay[day] || []).slice().sort((a, b) => (a.start_time || "").localeCompare(b.start_time || ""));
    if (!slots.length) return "";
    const rows = slots.map((s) => {
      const filled = s.student_names && s.student_names.length > 0;
      const editable = canEditSlot(s);
      let actions;
      if (scheduleConfirmDeleteId === s.id) {
        actions = `<button class="icon-btn" id="slotdelyes-${s.id}" style="color:#E64A6B;border-color:#E64A6B33">&#10003;</button><button class="icon-btn" id="slotdelno-${s.id}" style="color:#8378B0;border-color:#8378B033">&#10005;</button>`;
      } else if (editable) {
        actions = `<button class="icon-btn" id="slotedit-${s.id}" style="color:#4C4CFF;border-color:#4C4CFF33">&#9998;</button><button class="icon-btn" id="slotdel-${s.id}" style="color:#E64A6B;border-color:#E64A6B33">&#128465;</button>`;
      } else {
        actions = `<span class="icon-btn" style="color:#8378B0;border-color:#8378B033;cursor:default" title="Only ${esc(s.tutor_name)} can edit">&#128274;</span>`;
      }
      return `<div class="slot-card ${filled ? "filled" : "empty"}">
        <div><div class="slot-time">${s.start_time?.slice(0, 5)}–${s.end_time?.slice(0, 5)}</div>
          <div class="slot-meta"><span>&#128100; ${esc(s.tutor_name)}</span>
            <span>${s.mode === "Online" ? "&#128421;&#65039; Online" : "&#127963;&#65039; Offline"}</span>
            <span>${s.slot_type === "Group" ? "&#128101; Group" : "&#128100; 1-on-1"}</span>
            ${filled ? `<span style="color:#E64A6B;font-weight:700">${esc(s.student_names.join(", "))}</span>` : `<span style="color:#12A594;font-weight:700">Empty — available</span>`}
          </div></div>
        <div class="row-actions">${actions}</div></div>`;
    }).join("");
    return `<div style="margin-bottom:14px"><div style="font-family:var(--font-display);font-weight:700;font-size:13.5px;color:var(--text-muted);margin-bottom:6px">${day}</div>${rows}</div>`;
  }).join("");
  const hasAny = filtered.length > 0;
  host.innerHTML = `<div class="overlay" id="scheduleOverlay"><div class="modal" style="max-width:580px">
    <div class="modal-head"><h2>Tutor Slots</h2><button class="icon-btn" id="scheduleClose" style="border-color:#8a847033;color:#8a8470">&#10005;</button></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center">
      ${tutors.length > 1 ? `<select class="filter-select" id="scheduleTutorFilter">${tutorOpts}</select>` : ""}
      <button class="btn btn-brass" id="addSlotBtn" style="margin-left:auto">&#65291; Add Slot</button></div>
    ${hasAny ? dayBlocks : `<div class="empty" style="padding:30px"><p>No slots yet${scheduleTutorFilter !== "All" ? ` for ${esc(scheduleTutorFilter)}` : ""}. Add one to see your availability at a glance.</p></div>`}
    <div class="modal-actions"><button class="btn btn-light" id="scheduleDone">Close</button></div>
  </div></div>`;
  document.getElementById("scheduleOverlay").addEventListener("mousedown", (e) => { if (e.target.id === "scheduleOverlay") closeSchedule(); });
  document.getElementById("scheduleClose").addEventListener("click", closeSchedule);
  document.getElementById("scheduleDone").addEventListener("click", closeSchedule);
  document.getElementById("scheduleTutorFilter")?.addEventListener("change", (e) => { scheduleTutorFilter = e.target.value; renderSchedule(); });
  document.getElementById("addSlotBtn").addEventListener("click", () => { if (!canAdd()) { showError("Please sign in to add a slot."); return; } scheduleEditing = emptySlot(); renderSchedule(); });
  filtered.forEach((s) => {
    document.getElementById(`slotedit-${s.id}`)?.addEventListener("click", () => { if (canEditSlot(s)) { scheduleEditing = { ...s }; renderSchedule(); } });
    document.getElementById(`slotdel-${s.id}`)?.addEventListener("click", () => { scheduleConfirmDeleteId = s.id; renderSchedule(); });
    document.getElementById(`slotdelyes-${s.id}`)?.addEventListener("click", () => { deleteSlot(s.id); scheduleConfirmDeleteId = null; });
    document.getElementById(`slotdelno-${s.id}`)?.addEventListener("click", () => { scheduleConfirmDeleteId = null; renderSchedule(); });
  });
}
function renderSlotForm() {
  const s = scheduleEditing;
  const isNew = !slotList.some((x) => x.id === s.id);
  const dayOpts = WEEKDAYS.map((d) => `<option value="${esc(d)}" ${s.day_of_week === d ? "selected" : ""}>${d}</option>`).join("");
  const host = document.getElementById("scheduleHost");
  host.innerHTML = `<div class="overlay" id="slotFormOverlay"><div class="modal" style="max-width:440px">
    <div class="modal-head"><h2>${isNew ? "Add Slot" : "Edit Slot"}</h2><button class="icon-btn" id="slotFormClose" style="border-color:#8a847033;color:#8a8470">&#10005;</button></div>
    <div class="form-grid">
      ${isNew ? `<label class="field span2">Tutor name<input id="s_tutorname" value="${esc(profileName())}" /></label>` : ""}
      <label class="field">Day<select id="s_day">${dayOpts}</select></label>
      <label class="field">Mode<select id="s_mode"><option value="Offline" ${s.mode === "Offline" ? "selected" : ""}>Offline</option><option value="Online" ${s.mode === "Online" ? "selected" : ""}>Online</option></select></label>
      <label class="field">Start time<input type="time" id="s_start" value="${s.start_time?.slice(0, 5) || "09:00"}" /></label>
      <label class="field">End time<input type="time" id="s_end" value="${s.end_time?.slice(0, 5) || "10:00"}" /></label>
      <label class="field">Class type<select id="s_type"><option value="Group" ${s.slot_type === "Group" ? "selected" : ""}>Group</option><option value="One-on-One" ${s.slot_type === "One-on-One" ? "selected" : ""}>One-on-One</option></select></label>
      <label class="field span2">Student name(s) — comma-separated, leave empty if this slot is free<input id="s_students" value="${esc((s.student_names || []).join(", "))}" placeholder="e.g. Farhan, Zaid" /></label>
    </div>
    <div class="modal-actions"><button class="btn btn-light" id="slotFormCancel">Cancel</button><button class="btn btn-brass" id="slotFormSave">&#10003; Save Slot</button></div>
  </div></div>`;
  const back = () => { scheduleEditing = null; renderSchedule(); };
  document.getElementById("slotFormOverlay").addEventListener("mousedown", (e) => { if (e.target.id === "slotFormOverlay") back(); });
  document.getElementById("slotFormClose").addEventListener("click", back);
  document.getElementById("slotFormCancel").addEventListener("click", back);
  document.getElementById("slotFormSave").addEventListener("click", () => {
    const tutorInput = document.getElementById("s_tutorname");
    const names = document.getElementById("s_students").value.split(",").map((n) => n.trim()).filter(Boolean);
    const updated = { ...s, day_of_week: document.getElementById("s_day").value, mode: document.getElementById("s_mode").value,
      start_time: document.getElementById("s_start").value, end_time: document.getElementById("s_end").value,
      slot_type: document.getElementById("s_type").value, student_names: names };
    if (tutorInput) updated.tutor_name = tutorInput.value.trim();
    writeSlot(updated, isNew);
    scheduleEditing = null; renderSchedule();
  });
}

/* ---------- targets UI ---------- */
let targetsOpen = false, targetsMonth = todayStr().slice(0, 7);
function monthOptions() {
  const opts = []; const now = new Date();
  for (let i = -2; i <= 3; i++) { const d = new Date(now.getFullYear(), now.getMonth() + i, 1); const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; opts.push({ ym, label: d.toLocaleDateString("en-IN", { month: "long", year: "numeric" }) }); }
  return opts;
}
function openTargetsBtn() { if (!canAdd()) { showError("Please sign in to view targets."); return; } targetsOpen = true; fetchTargets(); renderTargets(); }
function closeTargets() { targetsOpen = false; renderTargets(); }
function renderTargets() {
  const host = document.getElementById("targetsHost");
  if (!targetsOpen) { host.innerHTML = ""; return; }
  const tutors = distinctTutors();
  const monthOpts = monthOptions().map((o) => `<option value="${o.ym}" ${targetsMonth === o.ym ? "selected" : ""}>${o.label}</option>`).join("");
  const rows = tutors.map((name) => {
    const monthDate = `${targetsMonth}-01`;
    const tDoc = targetList.find((t) => t.tutor_name === name && t.month === monthDate);
    const target = tDoc ? tDoc.target_count : 0;
    const actual = actualForTutorMonth(name, targetsMonth);
    const pct = target ? Math.min(150, Math.round((actual / target) * 100)) : 0;
    const barColor = pct >= 100 ? "#12A594" : pct >= 60 ? "#F5A623" : "#E64A6B";
    return `<div style="margin-bottom:14px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;flex-wrap:wrap;gap:6px">
      <span style="font-weight:700;font-size:13px">${esc(name)}</span>
      <span style="font-size:12px;color:var(--text-muted)">${actual} / <input type="number" min="0" class="target-input" data-tutor="${esc(name)}" value="${target}" style="width:52px;padding:3px 5px;border:1px solid var(--surface-line);border-radius:6px;font-size:12px;background:var(--surface-solid);color:var(--text-main)" /> target</span></div>
      <div style="background:var(--surface-line);border-radius:999px;height:10px;overflow:hidden"><div style="width:${Math.min(100, pct)}%;height:100%;background:${barColor};border-radius:999px"></div></div></div>`;
  }).join("") || `<p style="color:var(--text-faint);font-size:13px">No tutors yet.</p>`;
  const totalTarget = tutors.reduce((sum, name) => { const t = targetList.find((x) => x.tutor_name === name && x.month === `${targetsMonth}-01`); return sum + (t ? t.target_count : 0); }, 0);
  const totalActual = tutors.reduce((sum, name) => sum + actualForTutorMonth(name, targetsMonth), 0);
  const totalPct = totalTarget ? Math.round((totalActual / totalTarget) * 100) : 0;
  host.innerHTML = `<div class="overlay" id="targetsOverlay"><div class="modal" style="max-width:540px">
    <div class="modal-head"><h2>Tutor Targets</h2><button class="icon-btn" id="targetsClose" style="border-color:#8a847033;color:#8a8470">&#10005;</button></div>
    <select class="filter-select" id="targetsMonthSelect" style="margin-bottom:14px">${monthOpts}</select>
    <div class="stat-card" style="--grad:linear-gradient(135deg,#5B5BFF,#4C4CFF);margin-bottom:16px;opacity:1;transform:none">
      <div class="stat-label">&#127919; Team Total: ${totalActual} / ${totalTarget} enrolled (${totalPct}%)</div>
      <div style="background:rgba(255,255,255,0.25);border-radius:999px;height:10px;overflow:hidden;margin-top:6px"><div style="width:${Math.min(100, totalPct)}%;height:100%;background:#fff;border-radius:999px"></div></div></div>
    <div style="font-family:var(--font-display);font-weight:700;font-size:14px;margin-bottom:10px">Per Tutor — actual vs target (editable)</div>${rows}
    <div class="modal-actions"><button class="btn btn-brass" id="targetsDone">Close</button></div>
  </div></div>`;
  document.getElementById("targetsOverlay").addEventListener("mousedown", (e) => { if (e.target.id === "targetsOverlay") closeTargets(); });
  document.getElementById("targetsClose").addEventListener("click", closeTargets);
  document.getElementById("targetsDone").addEventListener("click", closeTargets);
  document.getElementById("targetsMonthSelect").addEventListener("change", (e) => { targetsMonth = e.target.value; renderTargets(); });
  document.querySelectorAll(".target-input").forEach((inp) => inp.addEventListener("change", (e) => setTarget(e.target.dataset.tutor, targetsMonth, Math.max(0, parseInt(e.target.value, 10) || 0))));
}

/* ---------- dashboard ---------- */
let dashboardOpen = false;
function openDashboardBtn() { if (!canAdd()) { showError("Please sign in to view the dashboard."); return; } dashboardOpen = true; renderDashboard(); }
function closeDashboard() { dashboardOpen = false; renderDashboard(); }
function groupConversion(field) {
  const groups = {};
  state.records.forEach((r) => { const key = r[field] || "Unspecified"; if (!groups[key]) groups[key] = { total: 0, enrolled: 0 }; groups[key].total++; if (r.status === "Enrolled") groups[key].enrolled++; });
  return Object.entries(groups).map(([name, g]) => ({ name, total: g.total, enrolled: g.enrolled, pct: g.total ? Math.round((g.enrolled / g.total) * 100) : 0 })).sort((a, b) => b.total - a.total);
}
function renderDashboard() {
  const host = document.getElementById("dashboardHost");
  if (!dashboardOpen) { host.innerHTML = ""; return; }
  const totalRevenue = state.records.filter((r) => r.status === "Enrolled").reduce((sum, r) => sum + (parseFloat(r.feeOffered) || 0), 0);
  const bySource = groupConversion("leadSource"), byCourse = groupConversion("courseInterest");
  const barRow = (label, total, enrolled, pct, color) => `<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:3px"><span style="font-weight:600">${esc(label)}</span><span style="color:var(--text-muted)">${enrolled}/${total} · <b style="color:${color}">${pct}%</b></span></div><div style="background:var(--surface-line);border-radius:999px;height:8px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${color};border-radius:999px"></div></div></div>`;
  const sourceRows = bySource.map((g) => barRow(g.name, g.total, g.enrolled, g.pct, courseColor(g.name))).join("") || `<p style="color:var(--text-faint);font-size:13px">No leads yet.</p>`;
  const courseRows = byCourse.map((g) => barRow(g.name, g.total, g.enrolled, g.pct, courseColor(g.name))).join("") || `<p style="color:var(--text-faint);font-size:13px">No leads yet.</p>`;
  host.innerHTML = `<div class="overlay" id="dashboardOverlay"><div class="modal" style="max-width:560px">
    <div class="modal-head"><h2>Business Dashboard</h2><button class="icon-btn" id="dashboardClose" style="border-color:#8a847033;color:#8a8470">&#10005;</button></div>
    <div class="stat-card" style="--grad:linear-gradient(135deg,#17C0AC,#12A594);margin-bottom:16px;opacity:1;transform:none">
      <div class="stat-label">&#8377; Total Revenue (Enrolled)</div><div class="stat-value">₹${totalRevenue.toLocaleString("en-IN")}</div></div>
    <div style="font-family:var(--font-display);font-weight:700;font-size:14px;margin-bottom:8px">Conversion by Lead Source</div>${sourceRows}
    <div style="font-family:var(--font-display);font-weight:700;font-size:14px;margin:16px 0 8px">Conversion by Course</div>${courseRows}
    <div class="modal-actions"><button class="btn btn-brass" id="dashboardDone">Close</button></div>
  </div></div>`;
  document.getElementById("dashboardOverlay").addEventListener("mousedown", (e) => { if (e.target.id === "dashboardOverlay") closeDashboard(); });
  document.getElementById("dashboardClose").addEventListener("click", closeDashboard);
  document.getElementById("dashboardDone").addEventListener("click", closeDashboard);
}

/* ---------- CSV export ---------- */
function exportCSV() {
  const headers = ["Name", "Contact", "Email", "Lead Source", "Course", "Class Mode", "Class Type", "Class Timing", "Fee Offered", "Status", "Followed Up", "Feedback", "Joining Date", "Renewal Date", "Lead Date", "Notes", "Added By"];
  const rows = state.records.map((r) => [r.name, r.contact, r.email, r.leadSource, r.courseInterest, r.classMode, r.classType, r.classTiming, r.feeOffered, r.status, r.followedUp, r.feedback, r.joiningDate, r.renewalDate, r.createdAt, r.notes, r.createdByName || ""]);
  const csv = [headers, ...rows].map((row) => row.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = "ace_register.csv"; a.click(); URL.revokeObjectURL(url);
}

/* ---------- sound + theme (kept from previous version) ---------- */
let audioCtx = null, soundOn = true;
function loadSoundPref() { try { const v = localStorage.getItem("ace_sound"); if (v !== null) soundOn = v === "1"; } catch (e) {} }
function getAudioCtx() { if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } } if (audioCtx.state === "suspended") audioCtx.resume(); return audioCtx; }
function tone(freq, dur, type, vol, delay) { if (!soundOn) return; const ctx = getAudioCtx(); if (!ctx) return; const t0 = ctx.currentTime + (delay || 0); const osc = ctx.createOscillator(); const gain = ctx.createGain(); osc.type = type || "sine"; osc.frequency.setValueAtTime(freq, t0); gain.gain.setValueAtTime(0.0001, t0); gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.006); gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); osc.connect(gain).connect(ctx.destination); osc.start(t0); osc.stop(t0 + dur + 0.03); }
function playClick() { tone(760, 0.055, "sine", 0.045); }
function playSuccess() { tone(660, 0.09, "sine", 0.05); tone(990, 0.12, "sine", 0.05, 0.09); }
function initSoundUI() { loadSoundPref(); document.addEventListener("click", (e) => { if (e.target.closest(".btn, .icon-btn, .tab")) playClick(); }); }
function applyTheme(name) { document.documentElement.setAttribute("data-theme", name); try { localStorage.setItem("ace_theme", name); } catch (e) {} ["Default", "Light", "Dark"].forEach((n) => document.getElementById(`theme${n}`)?.classList.toggle("active", n.toLowerCase() === name)); }
function initThemeUI() { let saved = "default"; try { saved = localStorage.getItem("ace_theme") || "default"; } catch (e) {} applyTheme(saved); document.getElementById("themeDefault").addEventListener("click", () => applyTheme("default")); document.getElementById("themeLight").addEventListener("click", () => applyTheme("light")); document.getElementById("themeDark").addEventListener("click", () => applyTheme("dark")); }

/* ---------- init ---------- */
document.addEventListener("DOMContentLoaded", async () => {
  initSoundUI(); initThemeUI();
  document.getElementById("addBtn").addEventListener("click", openAdd);
  document.getElementById("exportBtn").addEventListener("click", exportCSV);
  document.getElementById("customizeBtn").addEventListener("click", () => { if (!canAdd()) { showError("Please sign in to customize the register."); return; } settingsOpen = true; renderSettings(); });
  document.getElementById("scheduleBtn").addEventListener("click", openScheduleBtn);
  document.getElementById("attendanceBtn").addEventListener("click", openAttendanceBtn);
  document.getElementById("dashboardBtn").addEventListener("click", openDashboardBtn);
  document.getElementById("targetsBtn").addEventListener("click", openTargetsBtn);

  render();
  await initAuth();
  updateOfflineBadge();
  flushOfflineQueue();

  setTimeout(() => document.getElementById("splashScreen")?.remove(), 2200);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
});
