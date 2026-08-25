/* ACE Skills Development Center — Lead & Student Register (offline app) */

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

let state = {
  records: [],
  sources: [...DEFAULT_SOURCES],
  courses: [...DEFAULT_COURSES],
  search: "",
  courseFilter: "All",
  statusFilter: "All",
  sourceFilter: "All",
  tutorFilter: "All",
  editing: null,
  confirmDeleteId: null,
};

function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) || `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function emptyRecord() {
  return {
    id: uid(), name: "", contact: "", email: "", leadSource: state.sources[0] || "", courseInterest: state.courses[0] || "",
    feeOffered: "", feedback: "", followedUp: "Pending", status: "New Lead",
    classMode: "Offline", classTiming: "", classType: "Group",
    joiningDate: "", renewalDate: "", notes: "", createdAt: new Date().toISOString().slice(0, 10),
    createdBy: null, createdByName: null,
  };
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
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function waLink(contact) {
  const digits = String(contact || "").replace(/\D/g, "");
  if (!digits) return null;
  const withCountry = digits.length === 10 ? `91${digits}` : digits;
  return `https://wa.me/${withCountry}`;
}
function showError(msg) {
  const el = document.getElementById("saveError");
  el.textContent = msg;
  el.style.background = "linear-gradient(120deg,#FFE1E8,#FFD0DC)";
  el.style.borderColor = "var(--brick)";
  el.style.color = "#8A1235";
  el.style.display = "block";
}
function showNotice(msg) {
  const el = document.getElementById("saveError");
  el.textContent = msg;
  el.style.background = "linear-gradient(120deg,#D6F5EE,#C4EEE3)";
  el.style.borderColor = "#12A594";
  el.style.color = "#0B5A4C";
  el.style.display = "block";
}
function clearError() {
  document.getElementById("saveError").style.display = "none";
}

/* ---------- persistence: local device + shared team cloud backup ---------- */
let cloudEnabled = false;
let currentUser = null;
let unsubRecords = null;
let unsubSettings = null;
let unsubSchedule = null;
let scheduleSlots = [];
let unsubAttendance = null;
let attendanceToday = [];

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/* Only the tutor who created a record can edit or delete it. When the app
   is connected to the shared team database, nobody can touch anything
   until they're signed in with an approved account — no more silent
   local-only editing for people who never signed in. */
function canEdit(r) {
  if (!cloudEnabled) return true; // no Firebase configured at all: plain offline app
  if (!currentUser) return false; // must be signed in with an approved account
  if (!r.createdBy) return true; // legacy entries with no recorded owner
  return r.createdBy === currentUser.uid;
}
function canAdd() {
  return !cloudEnabled || !!currentUser;
}

function initCloud() {
  if (typeof firebaseConfig === "undefined" || !firebaseConfig.apiKey || firebaseConfig.apiKey.indexOf("PASTE") === 0) {
    cloudEnabled = false;
    renderAuthUI();
    return;
  }
  try {
    firebase.initializeApp(firebaseConfig);
    cloudEnabled = true;
    firebase.auth().onAuthStateChanged((user) => {
      currentUser = user;
      renderAuthUI();
      if (unsubRecords) { unsubRecords(); unsubRecords = null; }
      if (unsubSettings) { unsubSettings(); unsubSettings = null; }
      if (unsubSchedule) { unsubSchedule(); unsubSchedule = null; }
      if (unsubAttendance) { unsubAttendance(); unsubAttendance = null; }
      if (user) {
        subscribeSharedRecords();
        subscribeSharedSettings();
        subscribeSchedule();
        subscribeAttendance();
      } else {
        scheduleSlots = [];
        attendanceToday = [];
        load();
        render();
      }
    });
  } catch (e) {
    cloudEnabled = false;
    renderAuthUI();
  }
}

function signIn() {
  const provider = new firebase.auth.GoogleAuthProvider();
  firebase.auth().signInWithPopup(provider).catch((err) => {
    if (err && (err.code === "auth/popup-blocked" || err.code === "auth/operation-not-supported-in-this-environment")) {
      firebase.auth().signInWithRedirect(provider);
      return;
    }
    if (err && err.code === "auth/popup-closed-by-user") return;
    showError("Google sign-in didn't go through — please try again.");
  });
}
function signOutUser() {
  firebase.auth().signOut();
}

function handleShareError(err) {
  if (err && err.code === "permission-denied") {
    showError("This Google account isn't authorized for ACE Register. Ask the admin to add your email, or sign in with an approved account.");
    firebase.auth().signOut();
    return true;
  }
  return false;
}

/* Shared team register: every student/lead is its own document, tagged with
   who created it. Everyone signed in sees everyone's entries live, but only
   the creator (or anyone when offline) can edit or delete a given one. */
function subscribeSharedRecords() {
  unsubRecords = firebase.firestore().collection("ace_records")
    .onSnapshot((snap) => {
      state.records = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderRenewalBanner(); renderStats(); renderToolbar(); renderRecords(); renderModal();
      maybeNotifyRenewals();
      clearError();
    }, (err) => {
      if (handleShareError(err)) return;
      showError("Couldn't reach the shared team data — showing what's saved on this device.");
      load(); render();
    });
}

function subscribeSharedSettings() {
  unsubSettings = firebase.firestore().collection("ace_shared").doc("settings")
    .onSnapshot((snap) => {
      if (snap.exists) {
        const data = snap.data();
        state.sources = data.sources?.length ? data.sources : [...DEFAULT_SOURCES];
        state.courses = data.courses?.length ? data.courses : [...DEFAULT_COURSES];
      } else {
        pushSharedSettings();
      }
      renderToolbar(); renderRecords(); renderSettings();
    }, (err) => {
      if (handleShareError(err)) return;
    });
}

function pushSharedSettings() {
  firebase.firestore().collection("ace_shared").doc("settings").set({
    sources: state.sources, courses: state.courses,
    updatedAt: new Date().toISOString(),
    updatedBy: currentUser ? (currentUser.displayName || currentUser.email) : "device",
  }).catch(() => showError("Couldn't sync this change to the team — try again."));
}

/* ---------- shared tutor schedule board ---------- */
/* Every tutor manages their own slots (day, time, filled/empty, student
   name). Everyone on the team can view the whole board to see who's free
   when — but only the tutor who owns a slot can edit or delete it. */
function subscribeSchedule() {
  unsubSchedule = firebase.firestore().collection("ace_schedule")
    .onSnapshot((snap) => {
      scheduleSlots = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (scheduleOpen) renderSchedule();
    }, (err) => {
      if (handleShareError(err)) return;
    });
}
function canEditSlot(s) {
  if (!cloudEnabled) return true;
  if (!currentUser) return false;
  if (!s.tutorUid) return true;
  return s.tutorUid === currentUser.uid;
}
function writeSlot(slot, isNew) {
  if (!cloudEnabled || !currentUser) {
    const exists = scheduleSlots.some((x) => x.id === slot.id);
    scheduleSlots = exists ? scheduleSlots.map((x) => (x.id === slot.id ? slot : x)) : [slot, ...scheduleSlots];
    renderSchedule();
    return;
  }
  if (isNew) {
    slot.tutorUid = currentUser.uid;
    if (!slot.tutorName || !slot.tutorName.trim()) slot.tutorName = currentUser.displayName || currentUser.email;
  }
  firebase.firestore().collection("ace_schedule").doc(slot.id).set(slot)
    .catch((err) => {
      if (handleShareError(err)) return;
      showError(isNew ? "Couldn't save this slot — try again." : "You can only edit your own slots.");
    });
}
function deleteSlot(id) {
  if (!cloudEnabled || !currentUser) {
    scheduleSlots = scheduleSlots.filter((x) => x.id !== id);
    renderSchedule();
    return;
  }
  firebase.firestore().collection("ace_schedule").doc(id).delete()
    .catch((err) => {
      if (handleShareError(err)) return;
      showError("You can only delete your own slots.");
    });
}

/* ---------- shared tutor attendance (punch in/out + leave) ---------- */
function subscribeAttendance() {
  unsubAttendance = firebase.firestore().collection("ace_attendance")
    .where("date", "==", todayStr())
    .onSnapshot((snap) => {
      attendanceToday = snap.docs.map((d) => d.data()).sort((a, b) => (a.punchInTime || "").localeCompare(b.punchInTime || ""));
      if (attendanceOpen && !reportView) renderAttendance();
    }, (err) => { if (handleShareError(err)) return; });
}
function punchIn() {
  if (!currentUser) return;
  const id = `${todayStr()}_${currentUser.uid}`;
  firebase.firestore().collection("ace_attendance").doc(id).set({
    uid: currentUser.uid, name: currentUser.displayName || currentUser.email,
    date: todayStr(), punchInTime: new Date().toISOString(), punchOutTime: null, status: "present",
  }, { merge: true }).then(playSuccess);
}
function punchOut() {
  if (!currentUser) return;
  const id = `${todayStr()}_${currentUser.uid}`;
  firebase.firestore().collection("ace_attendance").doc(id).set({
    punchOutTime: new Date().toISOString(),
  }, { merge: true }).then(playSuccess);
}
function markLeave() {
  if (!currentUser) return;
  const id = `${todayStr()}_${currentUser.uid}`;
  firebase.firestore().collection("ace_attendance").doc(id).set({
    uid: currentUser.uid, name: currentUser.displayName || currentUser.email,
    date: todayStr(), punchInTime: null, punchOutTime: null, status: "leave",
  }, { merge: true }).then(playSuccess);
}
function fmtTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

let reportView = false;
let reportLoading = false;
let reportData = []; // [{uid, name, present, leave}]
function monthBounds() {
  const now = new Date();
  const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  return { start, end: todayStr() };
}
function loadMonthlyAttendanceReport() {
  if (!cloudEnabled) return;
  reportLoading = true;
  renderAttendance();
  const { start, end } = monthBounds();
  firebase.firestore().collection("ace_attendance")
    .where("date", ">=", start).where("date", "<=", end)
    .get()
    .then((snap) => {
      const byUser = {};
      snap.docs.forEach((d) => {
        const a = d.data();
        if (!byUser[a.uid]) byUser[a.uid] = { uid: a.uid, name: a.name, present: 0, leave: 0 };
        if (a.status === "leave") byUser[a.uid].leave += 1;
        else if (a.punchInTime) byUser[a.uid].present += 1;
      });
      reportData = Object.values(byUser).sort((a, b) => b.present - a.present);
      reportLoading = false;
      renderAttendance();
    })
    .catch(() => { reportLoading = false; renderAttendance(); });
}

/* Writes a single record document. Ownership fields are only ever set on
   create and are never touched by an edit, so the original tutor stays the
   owner for the life of the entry. */
function writeRecord(record, isNew) {
  if (!cloudEnabled || !currentUser) {
    const exists = state.records.some((x) => x.id === record.id);
    state.records = exists ? state.records.map((x) => (x.id === record.id ? record : x)) : [record, ...state.records];
    render();
    return;
  }
  if (isNew) {
    record.createdBy = currentUser.uid; // ownership always ties to the real signed-in account
    if (!record.createdByName || !record.createdByName.trim()) {
      record.createdByName = currentUser.displayName || currentUser.email; // fallback only
    }
  }
  firebase.firestore().collection("ace_records").doc(record.id).set(record)
    .catch((err) => {
      if (handleShareError(err)) return;
      showError(isNew ? "Couldn't add this entry — try again." : "You can only edit entries you added.");
    });
}

function deleteRecordRemote(id) {
  if (!cloudEnabled || !currentUser) {
    state.records = state.records.filter((x) => x.id !== id);
    render();
    return;
  }
  firebase.firestore().collection("ace_records").doc(id).delete()
    .catch((err) => {
      if (handleShareError(err)) return;
      showError("You can only delete entries you added.");
    });
}

function renderAuthUI() {
  const host = document.getElementById("authArea");
  if (!host) return;
  if (!cloudEnabled) { host.innerHTML = ""; return; }
  if (currentUser) {
    host.innerHTML = `<button class="btn btn-ghost-dark" id="signOutBtn" title="${esc(currentUser.email || "")}">&#9729;&#65039; ${esc(currentUser.displayName ? currentUser.displayName.split(" ")[0] : "Signed in")} · Sign out</button>`;
    document.getElementById("signOutBtn").addEventListener("click", signOutUser);
  } else {
    host.innerHTML = `<button class="btn btn-ghost-dark" id="signInBtn">&#128231; Sign in with Google</button>`;
    document.getElementById("signInBtn").addEventListener("click", signIn);
  }
}

function save() {
  try {
    localStorage.setItem("ace_records", JSON.stringify(state.records));
    localStorage.setItem("ace_settings", JSON.stringify({ sources: state.sources, courses: state.courses }));
  } catch (e) {
    showError("Couldn't save on this device just now — your last change may not have persisted.");
  }
}
function load() {
  try {
    const r = localStorage.getItem("ace_records");
    if (r) state.records = JSON.parse(r);
  } catch (e) {}
  try {
    const s = localStorage.getItem("ace_settings");
    if (s) {
      const p = JSON.parse(s);
      if (p.sources?.length) state.sources = p.sources;
      if (p.courses?.length) state.courses = p.courses;
    }
  } catch (e) {}
}

/* ---------- derived ---------- */
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
  const names = new Set(state.records.map((r) => r.createdByName || "Unassigned"));
  return Array.from(names).sort();
}
function computeStats() {
  return {
    total: state.records.length,
    enrolled: state.records.filter((r) => r.status === "Enrolled").length,
    pending: state.records.filter((r) => r.followedUp !== "Yes").length,
    renewals: state.records.filter((r) => {
      const d = daysUntil(r.renewalDate);
      return d !== null && d <= 30 && r.status === "Enrolled";
    }).length,
  };
}

/* ---------- scroll reveal animation for record cards ---------- */
let revealObserver = null;
function observeReveal() {
  if (!("IntersectionObserver" in window)) {
    document.querySelectorAll(".record").forEach((el) => el.classList.add("in-view"));
    return;
  }
  if (!revealObserver) {
    revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in-view");
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08 });
  }
  document.querySelectorAll(".record:not(.in-view)").forEach((el) => revealObserver.observe(el));
}

/* ---------- renewal reminders ---------- */
let bannerDismissed = false;
function upcomingRenewals() {
  return state.records
    .filter((r) => r.status === "Enrolled" && r.renewalDate)
    .map((r) => ({ r, days: daysUntil(r.renewalDate) }))
    .filter((x) => x.days !== null && x.days <= 7)
    .sort((a, b) => a.days - b.days);
}

function renderRenewalBanner() {
  const host = document.getElementById("bannerHost");
  if (!host) return;
  if (bannerDismissed) { host.innerHTML = ""; return; }
  const list = upcomingRenewals();
  if (list.length === 0) { host.innerHTML = ""; return; }
  const overdue = list.filter((x) => x.days < 0);
  const cls = overdue.length ? "banner-overdue" : "banner-renew";
  const names = list.slice(0, 4).map((x) => `${esc(x.r.name)} (${x.days < 0 ? `${Math.abs(x.days)}d overdue` : x.days === 0 ? "today" : `in ${x.days}d`})`).join(", ");
  const more = list.length > 4 ? ` +${list.length - 4} more` : "";
  host.innerHTML = `<div class="banner ${cls}">
    <span style="font-size:16px">${overdue.length ? "&#128680;" : "&#128276;"}</span>
    <span><b>${list.length} renewal${list.length > 1 ? "s" : ""} due soon:</b> ${names}${more}</span>
    <button class="banner-close" id="bannerCloseBtn">&#10005; Dismiss</button>
  </div>`;
  document.getElementById("bannerCloseBtn").addEventListener("click", () => { bannerDismissed = true; renderRenewalBanner(); });
}

let notifiedToday = false;
function maybeNotifyRenewals() {
  if (notifiedToday) return;
  if (!("Notification" in window)) return;
  const list = upcomingRenewals();
  if (list.length === 0) return;
  const key = "ace_last_notify_" + todayStr();
  if (localStorage.getItem(key)) { notifiedToday = true; return; }
  const show = () => {
    try {
      new Notification("ACE Register — Renewals due", {
        body: `${list.length} student${list.length > 1 ? "s" : ""} have renewals coming up soon.`,
        icon: "./icon-192.png",
      });
    } catch (e) {}
    localStorage.setItem(key, "1");
    notifiedToday = true;
  };
  if (Notification.permission === "granted") {
    show();
  } else if (Notification.permission !== "denied") {
    Notification.requestPermission().then((perm) => { if (perm === "granted") show(); });
  }
}

/* ---------- render ---------- */
function render() {
  renderRenewalBanner();
  renderStats();
  renderToolbar();
  renderRecords();
  renderModal();
  renderSettings();
  save();
  maybeNotifyRenewals();
}

function renderStats() {
  const s = computeStats();
  document.getElementById("statsRow").innerHTML = `
    <div class="stat-card" style="--grad:linear-gradient(135deg,#5B5BFF,#4C4CFF)"><div class="stat-label">&#128101; Total Leads</div><div class="stat-value" data-count="${s.total}">0</div></div>
    <div class="stat-card" style="--grad:linear-gradient(135deg,#17C0AC,#12A594)"><div class="stat-label">&#9989; Enrolled</div><div class="stat-value" data-count="${s.enrolled}">0</div></div>
    <div class="stat-card" style="--grad:linear-gradient(135deg,#FF7A5C,#E64A6B)"><div class="stat-label">&#128276; Follow-up Pending</div><div class="stat-value" data-count="${s.pending}">0</div></div>
    <div class="stat-card" style="--grad:linear-gradient(135deg,#FFC157,#F5A623)"><div class="stat-label">&#9203; Renewals Due (30d)</div><div class="stat-value" data-count="${s.renewals}">0</div></div>
  `;
  animateCounts();
}

function animateCounts() {
  document.querySelectorAll(".stat-value[data-count]").forEach((el) => {
    const target = parseInt(el.dataset.count, 10) || 0;
    if (target === 0) { el.textContent = "0"; return; }
    const duration = 600;
    const start = performance.now();
    function tick(now) {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(eased * target);
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

function renderToolbar() {
  const statusOpts = ["All", ...STATUSES].map((o) => `<option value="${esc(o)}" ${state.statusFilter === o ? "selected" : ""}>${o === "All" ? "Status: All" : esc(o)}</option>`).join("");
  const sourceOpts = ["All", ...state.sources].map((o) => `<option value="${esc(o)}" ${state.sourceFilter === o ? "selected" : ""}>${o === "All" ? "Source: All" : esc(o)}</option>`).join("");
  const tutors = distinctTutors();
  const tutorOpts = ["All", ...tutors].map((o) => `<option value="${esc(o)}" ${state.tutorFilter === o ? "selected" : ""}>${o === "All" ? "Tutor: All" : esc(o)}</option>`).join("");
  const tabs = ["All", ...state.courses].map((c) => {
    const active = state.courseFilter === c;
    const bg = c === "All" ? "var(--ink)" : courseColor(c);
    return `<button class="tab ${active ? "active" : ""}" style="${active ? `background:${bg}` : ""}" data-course-tab="${esc(c)}">${esc(c)}</button>`;
  }).join("");
  document.getElementById("toolbar").innerHTML = `
    <div class="toolbar-row">
      <div class="search-wrap"><span class="search-icon">&#128269;</span>
        <input id="searchInput" placeholder="Search by name or contact number…" value="${esc(state.search)}" />
      </div>
      <select class="filter-select" id="statusFilter">${statusOpts}</select>
      <select class="filter-select" id="sourceFilter">${sourceOpts}</select>
      ${tutors.length > 1 ? `<select class="filter-select" id="tutorFilter">${tutorOpts}</select>` : ""}
    </div>
    <div class="tabs">${tabs}</div>
  `;
  document.getElementById("searchInput").addEventListener("input", (e) => { state.search = e.target.value; renderRecords(); });
  document.getElementById("statusFilter").addEventListener("change", (e) => { state.statusFilter = e.target.value; renderRecords(); });
  document.getElementById("sourceFilter").addEventListener("change", (e) => { state.sourceFilter = e.target.value; renderRecords(); });
  document.getElementById("tutorFilter")?.addEventListener("change", (e) => { state.tutorFilter = e.target.value; renderRecords(); });
  document.querySelectorAll("[data-course-tab]").forEach((btn) => {
    btn.addEventListener("click", () => { state.courseFilter = btn.dataset.courseTab; renderToolbar(); renderRecords(); });
  });
}

function renderRecords() {
  const list = filteredRecords();
  const wrap = document.getElementById("recordsWrap");
  if (list.length === 0) {
    wrap.innerHTML = `<div class="empty"><div style="font-size:26px;opacity:.5">&#128214;</div>
      <p>${!canAdd() ? "Sign in with an approved Google account to view and manage the shared register." : state.records.length === 0 ? "The register is empty. Add your first lead to begin." : "No entries match these filters."}</p></div>`;
    return;
  }
  wrap.innerHTML = `<div class="records">${list.map((r, i) => recordCardHTML(r, i)).join("")}</div>`;

  list.forEach((r) => {
    document.getElementById(`edit-${r.id}`)?.addEventListener("click", () => openEdit(r.id));
    document.getElementById(`del-${r.id}`)?.addEventListener("click", () => { state.confirmDeleteId = r.id; renderRecords(); });
    document.getElementById(`delyes-${r.id}`)?.addEventListener("click", () => {
      deleteRecordRemote(r.id);
      playDelete();
      state.confirmDeleteId = null;
    });
    document.getElementById(`delno-${r.id}`)?.addEventListener("click", () => { state.confirmDeleteId = null; renderRecords(); });
  });
  observeReveal();
}

function recordCardHTML(r, i) {
  const sc = STATUS_COLOR[r.status] || "#4C4CFF";
  const fc = FOLLOW_COLOR[r.followedUp] || "#F5A623";
  const cc = courseColor(r.courseInterest);
  const renewIn = daysUntil(r.renewalDate);
  const renewSoon = renewIn !== null && renewIn <= 30 && r.status === "Enrolled";
  const renewColor = renewIn < 0 ? "#E64A6B" : "#F5A623";
  const editable = canEdit(r);
  const delay = Math.min(i || 0, 8) * 0.06;

  let actions;
  if (state.confirmDeleteId === r.id) {
    actions = `<button class="icon-btn" id="delyes-${r.id}" style="color:#E64A6B;border-color:#E64A6B33">&#10003;</button>
       <button class="icon-btn" id="delno-${r.id}" style="color:#8378B0;border-color:#8378B033">&#10005;</button>`;
  } else if (editable) {
    actions = `<button class="icon-btn" id="edit-${r.id}" style="color:#4C4CFF;border-color:#4C4CFF33">&#9998;</button>
       <button class="icon-btn" id="del-${r.id}" style="color:#E64A6B;border-color:#E64A6B33">&#128465;</button>`;
  } else {
    actions = `<span class="icon-btn" style="color:#8378B0;border-color:#8378B033;cursor:default" title="Only ${esc(r.createdByName || "the tutor who added this")} can edit this entry">&#128274;</span>`;
  }

  const ownerNote = (cloudEnabled && r.createdByName) ? `<span class="meta-item" style="opacity:.75">&#128100; Added by ${esc(r.createdByName)}</span>` : "";

  return `<div class="record" style="--course-color:${cc};transition-delay:${delay}s">
    <div class="record-top">
      <div style="flex:1 1 240px">
        <div class="record-name-row">
          <span class="record-name">${esc(r.name)}</span>
          <span class="stamp" style="color:${sc};border-color:${sc}">${esc(r.status)}</span>
        </div>
        <div class="meta-row">
          <span class="meta-item">&#128222; ${esc(r.contact)}</span>
          ${waLink(r.contact) ? `<a class="meta-item" href="${waLink(r.contact)}" target="_blank" rel="noopener" style="color:#12A594;text-decoration:none;font-weight:600" title="Chat on WhatsApp">&#128172; WhatsApp</a>` : ""}
          ${r.email ? `<span class="meta-item">&#9993;&#65039; ${esc(r.email)}</span>` : ""}
          <span class="meta-item">&#127991;&#65039; ${esc(r.leadSource)}</span>
          <span class="meta-item course-tag" style="--course-color:${cc}">&#128214; ${esc(r.courseInterest)}</span>
          ${r.classMode ? `<span class="meta-item">${r.classMode === "Online" ? "&#128421;&#65039;" : "&#127963;&#65039;"} ${esc(r.classMode)}</span>` : ""}
          ${r.classType ? `<span class="meta-item">${r.classType === "Group" ? "&#128101;" : "&#128100;"} ${esc(r.classType)}</span>` : ""}
          ${r.classTiming ? `<span class="meta-item">&#128337; ${esc(r.classTiming)}</span>` : ""}
          ${r.feeOffered ? `<span class="meta-item">&#8377; ${esc(r.feeOffered)}</span>` : ""}
          ${ownerNote}
        </div>
        ${r.feedback ? `<div class="feedback-row">&#128172; <span>${esc(r.feedback)}</span></div>` : ""}
      </div>
      <div class="record-right">
        <span class="follow-badge" style="color:${fc}"><span class="dot" style="background:${fc}"></span>${FOLLOW_LABEL[r.followedUp] || "Pending"}</span>
        ${r.joiningDate ? `<span class="date-note">&#128197; Joined ${fmtDate(r.joiningDate)}</span>` : ""}
        ${r.renewalDate ? `<span class="renew-note" style="color:${renewSoon ? renewColor : "#8a8470"}">Renewal ${fmtDate(r.renewalDate)}${renewSoon ? (renewIn < 0 ? " · overdue" : ` · in ${renewIn}d`) : ""}</span>` : ""}
        <div class="row-actions">${actions}</div>
      </div>
    </div>
  </div>`;
}

/* ---------- add/edit modal ---------- */
function openAdd() {
  if (!canAdd()) {
    showError("Please sign in with an approved Google account before adding entries.");
    return;
  }
  state.editing = emptyRecord();
  renderModal();
}
function openEdit(id) {
  const r = state.records.find((x) => x.id === id);
  if (!r || !canEdit(r)) return;
  state.editing = { ...r };
  renderModal();
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

  host.innerHTML = `<div class="overlay" id="modalOverlay">
    <div class="modal">
      <div class="modal-head"><h2>${isNew ? "New Register Entry" : `Edit — ${esc(r.name || "Entry")}`}</h2>
        <button class="icon-btn" id="modalClose" style="border-color:#8a847033;color:#8a8470">&#10005;</button></div>
      <div class="form-grid">
        ${isNew && cloudEnabled ? `<label class="field span2">Your name (shown as who added this)<input id="f_addedby" value="${esc(currentUser && currentUser.displayName ? currentUser.displayName : "")}" placeholder="e.g. Shahrukh" /></label>` : ""}
        <label class="field">Full name *<input id="f_name" value="${esc(r.name)}" placeholder="e.g. Priya Sharma" /></label>
        <label class="field">Contact number *<input id="f_contact" value="${esc(r.contact)}" placeholder="10-digit mobile" /></label>
        <label class="field">Email (Gmail etc.)<input id="f_email" type="email" value="${esc(r.email || "")}" placeholder="name@gmail.com" /></label>
        <label class="field">Lead source<select id="f_source">${sourceOpts}</select></label>
        <label class="field">Course interest<select id="f_course">${courseOpts}</select></label>
        <label class="field">Class mode<select id="f_classmode">
          <option value="Offline" ${r.classMode === "Offline" ? "selected" : ""}>Offline (in-person)</option>
          <option value="Online" ${r.classMode === "Online" ? "selected" : ""}>Online</option>
        </select></label>
        <label class="field">Class type<select id="f_classtype">
          <option value="Group" ${r.classType === "Group" ? "selected" : ""}>Group</option>
          <option value="One-on-One" ${r.classType === "One-on-One" ? "selected" : ""}>One-on-One</option>
        </select></label>
        <label class="field">Class timing<input id="f_timing" value="${esc(r.classTiming || "")}" placeholder="e.g. 10:00 AM – 11:00 AM" /></label>
        <label class="field">Fee offered (₹)<input id="f_fee" type="number" value="${esc(r.feeOffered)}" placeholder="e.g. 4500" /></label>
        <label class="field">Status<select id="f_status">${statusOpts}</select></label>
        <label class="field">Followed up?<select id="f_follow">${followOpts}</select></label>
        <label class="field">Lead received on<input id="f_created" type="date" value="${esc(r.createdAt)}" /></label>
        <label class="field">Joining date<input id="f_joining" type="date" value="${esc(r.joiningDate)}" /></label>
        <label class="field">Renewal due date<input id="f_renewal" type="date" value="${esc(r.renewalDate)}" /></label>
        <label class="field span2">Feedback<textarea id="f_feedback" rows="2" placeholder="What did they say about the demo class / call?">${esc(r.feedback)}</textarea></label>
        <label class="field span2">Notes<textarea id="f_notes" rows="2" placeholder="Anything else worth remembering">${esc(r.notes)}</textarea></label>
      </div>
      <div class="modal-actions">
        <button class="btn btn-light" id="modalCancel">Cancel</button>
        <button class="btn btn-brass" id="modalSave">&#10003; Save Entry</button>
      </div>
    </div>
  </div>`;

  document.getElementById("modalOverlay").addEventListener("mousedown", (e) => { if (e.target.id === "modalOverlay") closeModal(); });
  document.getElementById("modalClose").addEventListener("click", closeModal);
  document.getElementById("modalCancel").addEventListener("click", closeModal);
  document.getElementById("modalSave").addEventListener("click", () => {
    const name = document.getElementById("f_name").value.trim();
    const contact = document.getElementById("f_contact").value.trim();
    if (!name || !contact) return;
    const addedByInput = document.getElementById("f_addedby");
    const updated = {
      ...r, name, contact,
      email: document.getElementById("f_email").value.trim(),
      leadSource: document.getElementById("f_source").value,
      courseInterest: document.getElementById("f_course").value,
      classMode: document.getElementById("f_classmode").value,
      classType: document.getElementById("f_classtype").value,
      classTiming: document.getElementById("f_timing").value.trim(),
      feeOffered: document.getElementById("f_fee").value,
      status: document.getElementById("f_status").value,
      followedUp: document.getElementById("f_follow").value,
      createdAt: document.getElementById("f_created").value,
      joiningDate: document.getElementById("f_joining").value,
      renewalDate: document.getElementById("f_renewal").value,
      feedback: document.getElementById("f_feedback").value,
      notes: document.getElementById("f_notes").value,
    };
    if (addedByInput) updated.createdByName = addedByInput.value.trim();
    if (isNew) {
      const dupe = state.records.find((x) => x.contact.trim() === contact && x.id !== updated.id);
      if (dupe && !window.confirm(`A student with this number is already in the register (${dupe.name}, added by ${dupe.createdByName || "someone"}).\n\nAdd this as a new entry anyway?`)) {
        return;
      }
    }
    writeRecord(updated, isNew);
    playSuccess();
    state.editing = null;
    renderModal();
  });
}

/* ---------- settings ---------- */
let settingsOpen = false;
let newSourceVal = "", newCourseVal = "";

function renderSettings() {
  const host = document.getElementById("settingsHost");
  if (!settingsOpen) { host.innerHTML = ""; return; }
  const sourceChips = state.sources.map((s) => `<span class="chip">${esc(s)}<button data-rm-source="${esc(s)}">&#10005;</button></span>`).join("");
  const courseChips = state.courses.map((c) => `<span class="chip">${esc(c)}<button data-rm-course="${esc(c)}">&#10005;</button></span>`).join("");
  host.innerHTML = `<div class="overlay" id="settingsOverlay">
    <div class="modal" style="max-width:420px">
      <div class="modal-head"><h2>Customize Register</h2><button class="icon-btn" id="settingsClose" style="border-color:#8a847033;color:#8a8470">&#10005;</button></div>
      <p style="font-size:12px;color:#8a8470;margin-top:0">Add your own lead platforms or course names, or remove ones you don't use. Shared with the whole team.</p>
      <div style="font-size:12.5px;font-weight:700;color:#5c5648;margin-bottom:6px">Lead sources</div>
      <div class="chips">${sourceChips}</div>
      <div class="add-row"><input id="newSourceInput" value="${esc(newSourceVal)}" placeholder="e.g. YouTube" /><button class="btn btn-light" id="addSourceBtn">+</button></div>
      <div style="height:14px"></div>
      <div style="font-size:12.5px;font-weight:700;color:#5c5648;margin-bottom:6px">Courses</div>
      <div class="chips">${courseChips}</div>
      <div class="add-row"><input id="newCourseInput" value="${esc(newCourseVal)}" placeholder="e.g. Business English" /><button class="btn btn-light" id="addCourseBtn">+</button></div>
      <div style="height:16px;border-top:1px solid var(--surface-line)"></div>
      <div style="font-size:12.5px;font-weight:700;color:var(--text-muted);margin-bottom:6px">Backup &amp; Restore</div>
      <p style="font-size:11.5px;color:var(--text-faint);margin:0 0 8px">Download every student, lead source, and course as one file — useful as a safety copy, or to move data if something ever goes wrong.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-light" id="backupExportBtn">&#11015;&#65039; Download Full Backup</button>
        <label class="btn btn-light" style="cursor:pointer">&#11014;&#65039; Restore from Backup<input type="file" id="backupRestoreInput" accept="application/json" style="display:none" /></label>
      </div>
      <div class="modal-actions"><button class="btn btn-brass" id="settingsDone">Done</button></div>
    </div>
  </div>`;

  document.getElementById("settingsOverlay").addEventListener("mousedown", (e) => { if (e.target.id === "settingsOverlay") { settingsOpen = false; renderSettings(); } });
  document.getElementById("settingsClose").addEventListener("click", () => { settingsOpen = false; renderSettings(); });
  document.getElementById("settingsDone").addEventListener("click", () => { settingsOpen = false; renderSettings(); });
  document.getElementById("newSourceInput").addEventListener("input", (e) => newSourceVal = e.target.value);
  document.getElementById("newCourseInput").addEventListener("input", (e) => newCourseVal = e.target.value);
  document.getElementById("addSourceBtn").addEventListener("click", () => {
    const v = newSourceVal.trim();
    if (v && !state.sources.includes(v)) state.sources.push(v);
    newSourceVal = ""; commitSettings();
  });
  document.getElementById("addCourseBtn").addEventListener("click", () => {
    const v = newCourseVal.trim();
    if (v && !state.courses.includes(v)) state.courses.push(v);
    newCourseVal = ""; commitSettings();
  });
  document.querySelectorAll("[data-rm-source]").forEach((b) => b.addEventListener("click", () => {
    state.sources = state.sources.filter((s) => s !== b.dataset.rmSource); commitSettings();
  }));
  document.querySelectorAll("[data-rm-course]").forEach((b) => b.addEventListener("click", () => {
    state.courses = state.courses.filter((c) => c !== b.dataset.rmCourse); commitSettings();
  }));
  document.getElementById("backupExportBtn").addEventListener("click", exportFullBackup);
  document.getElementById("backupRestoreInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) restoreFromBackup(file);
    e.target.value = "";
  });
}

function exportFullBackup() {
  const backup = {
    exportedAt: new Date().toISOString(),
    records: state.records,
    sources: state.sources,
    courses: state.courses,
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `ace_register_backup_${todayStr()}.json`; a.click();
  URL.revokeObjectURL(url);
}

function restoreFromBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let backup;
    try { backup = JSON.parse(reader.result); } catch (e) {
      showError("That file doesn't look like a valid ACE Register backup.");
      return;
    }
    if (!Array.isArray(backup.records)) { showError("That file doesn't look like a valid ACE Register backup."); return; }
    if (!window.confirm(`Restore ${backup.records.length} student record(s) from this backup? This adds them into the current register (existing entries are kept, not replaced).`)) return;

    if (backup.sources?.length) { backup.sources.forEach((s) => { if (!state.sources.includes(s)) state.sources.push(s); }); }
    if (backup.courses?.length) { backup.courses.forEach((c) => { if (!state.courses.includes(c)) state.courses.push(c); }); }
    commitSettings();

    if (!cloudEnabled || !currentUser) {
      backup.records.forEach((r) => { if (!state.records.some((x) => x.id === r.id)) state.records.push(r); });
      render();
    } else {
      const col = firebase.firestore().collection("ace_records");
      backup.records.forEach((r) => {
        col.doc(r.id).set(r).catch(() => {});
      });
    }
    playSuccess();
    showNotice(`Restored ${backup.records.length} record(s) from backup.`);
  };
  reader.readAsText(file);
}

function commitSettings() {
  save();
  if (cloudEnabled && currentUser) pushSharedSettings();
  settingsOpen = true;
  renderToolbar(); renderRecords(); renderSettings();
}

/* ---------- schedule board ---------- */
let scheduleOpen = false;
let scheduleTutorFilter = "All";
let scheduleEditing = null; // slot being added/edited, or null
let scheduleConfirmDeleteId = null;

function emptySlot() {
  return { id: uid(), day: WEEKDAYS[0], time: "", status: "Empty", studentName: "", tutorUid: null, tutorName: "" };
}
function scheduleTutors() {
  const names = new Set(scheduleSlots.map((s) => s.tutorName || "Unassigned"));
  return Array.from(names).sort();
}
function openScheduleBtn() {
  if (!canAdd()) { showError("Please sign in with an approved Google account to view the schedule."); return; }
  scheduleOpen = true;
  renderSchedule();
}
function closeSchedule() { scheduleOpen = false; scheduleEditing = null; renderSchedule(); }

function renderSchedule() {
  const host = document.getElementById("scheduleHost");
  if (!scheduleOpen) { host.innerHTML = ""; return; }

  if (scheduleEditing) { renderSlotForm(); return; }

  const tutors = scheduleTutors();
  const filtered = scheduleTutorFilter === "All" ? scheduleSlots : scheduleSlots.filter((s) => (s.tutorName || "Unassigned") === scheduleTutorFilter);
  const tutorOpts = ["All", ...tutors].map((t) => `<option value="${esc(t)}" ${scheduleTutorFilter === t ? "selected" : ""}>${t === "All" ? "Tutor: All" : esc(t)}</option>`).join("");

  const byDay = {};
  WEEKDAYS.forEach((d) => (byDay[d] = []));
  filtered.forEach((s) => { (byDay[s.day] = byDay[s.day] || []).push(s); });

  const dayBlocks = WEEKDAYS.map((day) => {
    const slots = (byDay[day] || []).slice().sort((a, b) => (a.time || "").localeCompare(b.time || ""));
    if (slots.length === 0) return "";
    const rows = slots.map((s) => {
      const filled = s.status === "Filled";
      const color = filled ? "#E64A6B" : "#12A594";
      const editable = canEditSlot(s);
      let actions;
      if (scheduleConfirmDeleteId === s.id) {
        actions = `<button class="icon-btn" id="slotdelyes-${s.id}" style="color:#E64A6B;border-color:#E64A6B33">&#10003;</button>
          <button class="icon-btn" id="slotdelno-${s.id}" style="color:#8378B0;border-color:#8378B033">&#10005;</button>`;
      } else if (editable) {
        actions = `<button class="icon-btn" id="slotedit-${s.id}" style="color:#4C4CFF;border-color:#4C4CFF33">&#9998;</button>
          <button class="icon-btn" id="slotdel-${s.id}" style="color:#E64A6B;border-color:#E64A6B33">&#128465;</button>`;
      } else {
        actions = `<span class="icon-btn" style="color:#8378B0;border-color:#8378B033;cursor:default" title="Only ${esc(s.tutorName || "the tutor")} can edit this slot">&#128274;</span>`;
      }
      return `<div class="record" style="--course-color:${color};padding:10px 13px">
        <div class="record-top">
          <div style="flex:1 1 200px">
            <div class="record-name-row">
              <span class="record-name" style="font-size:14px">${esc(s.time || "No time set")}</span>
              <span class="stamp" style="color:${color};border-color:${color}">${filled ? "Filled" : "Empty"}</span>
            </div>
            <div class="meta-row">
              <span class="meta-item">&#128100; ${esc(s.tutorName || "Unassigned")}</span>
              ${filled && s.studentName ? `<span class="meta-item">&#127891; ${esc(s.studentName)}</span>` : ""}
            </div>
          </div>
          <div class="row-actions">${actions}</div>
        </div>
      </div>`;
    }).join("");
    return `<div style="margin-bottom:14px">
      <div style="font-family:var(--font-display);font-weight:700;font-size:13.5px;color:#5c5386;margin-bottom:6px">${day}</div>
      <div style="display:flex;flex-direction:column;gap:6px">${rows}</div>
    </div>`;
  }).join("");

  const hasAny = filtered.length > 0;

  const host2 = document.getElementById("scheduleHost");
  host2.innerHTML = `<div class="overlay" id="scheduleOverlay">
    <div class="modal" style="max-width:560px">
      <div class="modal-head"><h2>Tutor Schedule</h2><button class="icon-btn" id="scheduleClose" style="border-color:#8a847033;color:#8a8470">&#10005;</button></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center">
        ${tutors.length > 1 ? `<select class="filter-select" id="scheduleTutorFilter">${tutorOpts}</select>` : ""}
        <button class="btn btn-brass" id="addSlotBtn" style="margin-left:auto">&#65291; Add Slot</button>
      </div>
      ${hasAny ? dayBlocks : `<div class="empty" style="padding:30px"><p>No slots yet ${scheduleTutorFilter !== "All" ? `for ${esc(scheduleTutorFilter)}` : ""}. Add one to get started.</p></div>`}
      <div class="modal-actions"><button class="btn btn-light" id="scheduleDone">Close</button></div>
    </div>
  </div>`;

  document.getElementById("scheduleOverlay").addEventListener("mousedown", (e) => { if (e.target.id === "scheduleOverlay") closeSchedule(); });
  document.getElementById("scheduleClose").addEventListener("click", closeSchedule);
  document.getElementById("scheduleDone").addEventListener("click", closeSchedule);
  document.getElementById("scheduleTutorFilter")?.addEventListener("change", (e) => { scheduleTutorFilter = e.target.value; renderSchedule(); });
  document.getElementById("addSlotBtn").addEventListener("click", () => {
    if (!canAdd()) { showError("Please sign in with an approved Google account to add a slot."); return; }
    scheduleEditing = emptySlot();
    renderSchedule();
  });
  filtered.forEach((s) => {
    document.getElementById(`slotedit-${s.id}`)?.addEventListener("click", () => {
      if (!canEditSlot(s)) return;
      scheduleEditing = { ...s };
      renderSchedule();
    });
    document.getElementById(`slotdel-${s.id}`)?.addEventListener("click", () => { scheduleConfirmDeleteId = s.id; renderSchedule(); });
    document.getElementById(`slotdelyes-${s.id}`)?.addEventListener("click", () => {
      deleteSlot(s.id); playDelete(); scheduleConfirmDeleteId = null;
    });
    document.getElementById(`slotdelno-${s.id}`)?.addEventListener("click", () => { scheduleConfirmDeleteId = null; renderSchedule(); });
  });
}

function renderSlotForm() {
  const s = scheduleEditing;
  const isNew = !scheduleSlots.some((x) => x.id === s.id);
  const dayOpts = WEEKDAYS.map((d) => `<option value="${esc(d)}" ${s.day === d ? "selected" : ""}>${d}</option>`).join("");
  const host = document.getElementById("scheduleHost");
  host.innerHTML = `<div class="overlay" id="slotFormOverlay">
    <div class="modal" style="max-width:440px">
      <div class="modal-head"><h2>${isNew ? "Add Slot" : "Edit Slot"}</h2><button class="icon-btn" id="slotFormClose" style="border-color:#8a847033;color:#8a8470">&#10005;</button></div>
      <div class="form-grid">
        ${isNew && cloudEnabled ? `<label class="field span2">Tutor name<input id="s_tutorname" value="${esc(currentUser && currentUser.displayName ? currentUser.displayName : "")}" placeholder="e.g. Shahrukh" /></label>` : ""}
        <label class="field">Day<select id="s_day">${dayOpts}</select></label>
        <label class="field">Time<input id="s_time" value="${esc(s.time || "")}" placeholder="e.g. 10:00–11:00 AM" /></label>
        <label class="field">Status<select id="s_status">
          <option value="Empty" ${s.status === "Empty" ? "selected" : ""}>Empty (free)</option>
          <option value="Filled" ${s.status === "Filled" ? "selected" : ""}>Filled</option>
        </select></label>
        <label class="field">Student name<input id="s_student" value="${esc(s.studentName || "")}" placeholder="only if filled" /></label>
      </div>
      <div class="modal-actions">
        <button class="btn btn-light" id="slotFormCancel">Cancel</button>
        <button class="btn btn-brass" id="slotFormSave">&#10003; Save Slot</button>
      </div>
    </div>
  </div>`;

  const back = () => { scheduleEditing = null; renderSchedule(); };
  document.getElementById("slotFormOverlay").addEventListener("mousedown", (e) => { if (e.target.id === "slotFormOverlay") back(); });
  document.getElementById("slotFormClose").addEventListener("click", back);
  document.getElementById("slotFormCancel").addEventListener("click", back);
  document.getElementById("slotFormSave").addEventListener("click", () => {
    const tutorInput = document.getElementById("s_tutorname");
    const updated = {
      ...s,
      day: document.getElementById("s_day").value,
      time: document.getElementById("s_time").value.trim(),
      status: document.getElementById("s_status").value,
      studentName: document.getElementById("s_student").value.trim(),
    };
    if (tutorInput) updated.tutorName = tutorInput.value.trim();
    writeSlot(updated, isNew);
    playSuccess();
    scheduleEditing = null;
    renderSchedule();
  });
}

/* ---------- attendance UI ---------- */
let attendanceOpen = false;

function openAttendanceBtn() {
  if (!canAdd()) { showError("Please sign in with an approved Google account to view attendance."); return; }
  attendanceOpen = true;
  reportView = false;
  renderAttendance();
}
function closeAttendance() { attendanceOpen = false; renderAttendance(); }

function pieGradient(presentPct) {
  return `conic-gradient(#12A594 0% ${presentPct}%, #E64A6B ${presentPct}% 100%)`;
}

function renderAttendance() {
  const host = document.getElementById("attendanceHost");
  if (!attendanceOpen) { host.innerHTML = ""; return; }
  const mine = currentUser ? attendanceToday.find((a) => a.uid === currentUser.uid) : null;

  const todayRows = attendanceToday.map((a) => `
    <div class="record" style="padding:9px 12px">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px">
        <span style="font-weight:700">${esc(a.name)}</span>
        ${a.status === "leave"
          ? `<span class="stamp" style="color:#8B5CF6;border-color:#8B5CF6">On Leave</span>`
          : `<span style="font-size:12px;color:#5c5386">In: <b>${fmtTime(a.punchInTime)}</b> &nbsp; Out: <b>${fmtTime(a.punchOutTime)}</b></span>`}
      </div>
    </div>`).join("") || `<div class="empty" style="padding:24px"><p>No punches yet today.</p></div>`;

  const monthLabel = new Date().toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const reportRows = reportLoading
    ? `<div class="empty" style="padding:24px"><p>Loading report…</p></div>`
    : (reportData.map((u) => {
        const tracked = u.present + u.leave;
        const pct = tracked ? Math.round((u.present / tracked) * 100) : 0;
        return `<div class="record" style="padding:12px 14px">
          <div style="display:flex;gap:14px;align-items:center">
            <div style="width:64px;height:64px;border-radius:50%;background:${pieGradient(pct)};flex-shrink:0;box-shadow:0 3px 10px rgba(30,21,71,0.15)"></div>
            <div style="flex:1">
              <div style="font-weight:700;margin-bottom:3px">${esc(u.name)}</div>
              <div style="font-size:12px;color:#5c5386">
                <span style="color:#12A594;font-weight:700">&#9679;</span> ${u.present} present &nbsp;
                <span style="color:#E64A6B;font-weight:700">&#9679;</span> ${u.leave} leave${u.leave === 1 ? "" : "s"} &nbsp;
                <b>${pct}%</b> attendance
              </div>
            </div>
          </div>
        </div>`;
      }).join("") || `<div class="empty" style="padding:24px"><p>No attendance recorded this month yet.</p></div>`);

  host.innerHTML = `<div class="overlay" id="attendanceOverlay">
    <div class="modal" style="max-width:480px">
      <div class="modal-head"><h2>Tutor Attendance</h2><button class="icon-btn" id="attendanceClose" style="border-color:#8a847033;color:#8a8470">&#10005;</button></div>

      <div class="tabs" style="margin-bottom:12px">
        <button class="tab ${!reportView ? "active" : ""}" style="${!reportView ? "background:var(--ink)" : ""}" id="tabToday">Today</button>
        <button class="tab ${reportView ? "active" : ""}" style="${reportView ? "background:var(--ink)" : ""}" id="tabReport">Monthly Report</button>
      </div>

      ${!reportView ? `
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <button class="btn btn-brass" id="punchInBtn" style="flex:1;justify-content:center;padding:10px" ${mine && (mine.punchInTime || mine.status === "leave") ? "disabled" : ""}>&#9203; Punch In</button>
          <button class="btn btn-light" id="punchOutBtn" style="flex:1;justify-content:center;padding:10px" ${!mine || !mine.punchInTime || mine.punchOutTime ? "disabled" : ""}>&#128683; Punch Out</button>
        </div>
        <button class="btn btn-light" id="leaveBtn" style="width:100%;justify-content:center;padding:8px;margin-bottom:14px" ${mine && (mine.punchInTime || mine.status === "leave") ? "disabled" : ""}>&#127796; Mark Today as Leave</button>
        <div style="font-size:12px;font-weight:700;color:#5c5386;margin-bottom:6px">Today's log (shared, all tutors)</div>
        <div style="display:flex;flex-direction:column;gap:6px">${todayRows}</div>
      ` : `
        <div style="font-size:12px;font-weight:700;color:#5c5386;margin-bottom:10px">${monthLabel} — present vs leave per tutor</div>
        <div style="display:flex;flex-direction:column;gap:8px">${reportRows}</div>
      `}

      <div class="modal-actions"><button class="btn btn-brass" id="attendanceDone">Done</button></div>
    </div>
  </div>`;

  document.getElementById("attendanceOverlay").addEventListener("mousedown", (e) => { if (e.target.id === "attendanceOverlay") closeAttendance(); });
  document.getElementById("attendanceClose").addEventListener("click", closeAttendance);
  document.getElementById("attendanceDone").addEventListener("click", closeAttendance);
  document.getElementById("tabToday").addEventListener("click", () => { reportView = false; renderAttendance(); });
  document.getElementById("tabReport").addEventListener("click", () => { reportView = true; loadMonthlyAttendanceReport(); });
  if (!reportView) {
    document.getElementById("punchInBtn").addEventListener("click", punchIn);
    document.getElementById("punchOutBtn").addEventListener("click", punchOut);
    document.getElementById("leaveBtn").addEventListener("click", markLeave);
  }
}

/* ---------- business dashboard ---------- */
let dashboardOpen = false;

function openDashboardBtn() {
  if (!canAdd()) { showError("Please sign in with an approved Google account to view the dashboard."); return; }
  dashboardOpen = true;
  renderDashboard();
}
function closeDashboard() { dashboardOpen = false; renderDashboard(); }

function groupConversion(field) {
  const groups = {};
  state.records.forEach((r) => {
    const key = r[field] || "Unspecified";
    if (!groups[key]) groups[key] = { total: 0, enrolled: 0 };
    groups[key].total += 1;
    if (r.status === "Enrolled") groups[key].enrolled += 1;
  });
  return Object.entries(groups)
    .map(([name, g]) => ({ name, total: g.total, enrolled: g.enrolled, pct: g.total ? Math.round((g.enrolled / g.total) * 100) : 0 }))
    .sort((a, b) => b.total - a.total);
}
function monthlyEnrollments() {
  const counts = {};
  state.records.forEach((r) => {
    if (r.status !== "Enrolled" || !r.joiningDate) return;
    const key = r.joiningDate.slice(0, 7); // YYYY-MM
    counts[key] = (counts[key] || 0) + 1;
  });
  return Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0])).slice(-6);
}
function monthLabel(ym) {
  const [y, m] = ym.split("-");
  return new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1).toLocaleDateString("en-IN", { month: "short", year: "2-digit" });
}

function renderDashboard() {
  const host = document.getElementById("dashboardHost");
  if (!dashboardOpen) { host.innerHTML = ""; return; }

  const totalRevenue = state.records
    .filter((r) => r.status === "Enrolled")
    .reduce((sum, r) => sum + (parseFloat(r.feeOffered) || 0), 0);

  const bySource = groupConversion("leadSource");
  const byCourse = groupConversion("courseInterest");
  const months = monthlyEnrollments();
  const maxMonth = Math.max(1, ...months.map((m) => m[1]));

  const barRow = (label, total, enrolled, pct, color) => `
    <div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:3px">
        <span style="font-weight:600">${esc(label)}</span>
        <span style="color:var(--text-muted)">${enrolled}/${total} enrolled · <b style="color:${color}">${pct}%</b></span>
      </div>
      <div style="background:var(--surface-line);border-radius:999px;height:8px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:${color};border-radius:999px;transition:width .6s var(--ease)"></div>
      </div>
    </div>`;

  const sourceRows = bySource.map((g) => barRow(g.name, g.total, g.enrolled, g.pct, courseColor(g.name))).join("") || `<p style="color:var(--text-faint);font-size:13px">No leads yet.</p>`;
  const courseRows = byCourse.map((g) => barRow(g.name, g.total, g.enrolled, g.pct, courseColor(g.name))).join("") || `<p style="color:var(--text-faint);font-size:13px">No leads yet.</p>`;

  const monthBars = months.length ? `
    <div style="display:flex;align-items:flex-end;gap:10px;height:110px;padding-top:10px">
      ${months.map(([ym, count]) => `
        <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:5px">
          <div style="font-size:11px;font-weight:700;color:var(--inkwell)">${count}</div>
          <div style="width:100%;max-width:34px;height:${Math.max(6, (count / maxMonth) * 80)}px;background:linear-gradient(180deg,#5B5BFF,#4C4CFF);border-radius:6px 6px 2px 2px"></div>
          <div style="font-size:10.5px;color:var(--text-faint)">${monthLabel(ym)}</div>
        </div>`).join("")}
    </div>` : `<p style="color:var(--text-faint);font-size:13px">No enrollments with a joining date yet.</p>`;

  host.innerHTML = `<div class="overlay" id="dashboardOverlay">
    <div class="modal" style="max-width:560px">
      <div class="modal-head"><h2>Business Dashboard</h2><button class="icon-btn" id="dashboardClose" style="border-color:#8a847033;color:#8a8470">&#10005;</button></div>

      <div class="stat-card" style="--grad:linear-gradient(135deg,#17C0AC,#12A594);margin-bottom:16px;animation:none;opacity:1;transform:none">
        <div class="stat-label">&#8377; Total Revenue (Enrolled Students)</div>
        <div class="stat-value">₹${totalRevenue.toLocaleString("en-IN")}</div>
      </div>

      <div style="font-family:var(--font-display);font-weight:700;font-size:14px;margin-bottom:8px">Conversion by Lead Source</div>
      ${sourceRows}

      <div style="font-family:var(--font-display);font-weight:700;font-size:14px;margin:16px 0 8px">Conversion by Course</div>
      ${courseRows}

      <div style="font-family:var(--font-display);font-weight:700;font-size:14px;margin:16px 0 4px">Enrollment Trend (last 6 months)</div>
      ${monthBars}

      <div class="modal-actions"><button class="btn btn-brass" id="dashboardDone">Close</button></div>
    </div>
  </div>`;

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
  const a = document.createElement("a");
  a.href = url; a.download = "ace_register.csv"; a.click();
  URL.revokeObjectURL(url);
}

/* ---------- premium sound design ---------- */
/* All sounds are synthesized in-browser (tiny sine/square blips with a
   soft envelope) so there's nothing to download and it works offline. */
let audioCtx = null;
let soundOn = true;

function loadSoundPref() {
  try {
    const v = localStorage.getItem("ace_sound");
    if (v !== null) soundOn = v === "1";
  } catch (e) {}
}
function getAudioCtx() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}
function tone(freq, dur, type, vol, delay) {
  if (!soundOn) return;
  const ctx = getAudioCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime + (delay || 0);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type || "sine";
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}
function playClick() { tone(760, 0.055, "sine", 0.045); }
function playType() { tone(1350 + Math.random() * 220, 0.018, "square", 0.018); }
function playSuccess() { tone(660, 0.09, "sine", 0.05); tone(990, 0.12, "sine", 0.05, 0.09); }
function playDelete() { tone(320, 0.12, "sawtooth", 0.035); }

function renderSoundBtn() {
  const btn = document.getElementById("soundBtn");
  if (!btn) return;
  btn.innerHTML = soundOn ? "&#128266; Sound" : "&#128263; Muted";
  btn.style.opacity = soundOn ? "1" : ".65";
}
function toggleSound() {
  soundOn = !soundOn;
  try { localStorage.setItem("ace_sound", soundOn ? "1" : "0"); } catch (e) {}
  renderSoundBtn();
  if (soundOn) playClick();
}

function initSoundUI() {
  loadSoundPref();
  renderSoundBtn();
  document.getElementById("soundBtn").addEventListener("click", toggleSound);
  // Soft click on every button-like control, anywhere in the app (delegated,
  // so it also covers buttons rendered later inside modals/cards).
  document.addEventListener("click", (e) => {
    const t = e.target.closest(".btn, .icon-btn, .tab");
    if (t) playClick();
  });
  // Gentle key-tap while typing in any field.
  document.addEventListener("keydown", (e) => {
    const tag = e.target.tagName;
    if ((tag === "INPUT" || tag === "TEXTAREA") && e.key.length === 1) playType();
  });
}

/* ---------- theme system (Default / Light / Dark) ---------- */
function applyTheme(name) {
  document.documentElement.setAttribute("data-theme", name);
  try { localStorage.setItem("ace_theme", name); } catch (e) {}
  ["Default", "Light", "Dark"].forEach((n) => {
    document.getElementById(`theme${n}`)?.classList.toggle("active", n.toLowerCase() === name);
  });
}
function initThemeUI() {
  let saved = "default";
  try { saved = localStorage.getItem("ace_theme") || "default"; } catch (e) {}
  applyTheme(saved);
  document.getElementById("themeDefault").addEventListener("click", () => applyTheme("default"));
  document.getElementById("themeLight").addEventListener("click", () => applyTheme("light"));
  document.getElementById("themeDark").addEventListener("click", () => applyTheme("dark"));
}

/* ---------- init ---------- */
document.addEventListener("DOMContentLoaded", () => {
  load();
  initSoundUI();
  initThemeUI();
  document.getElementById("addBtn").addEventListener("click", openAdd);
  document.getElementById("exportBtn").addEventListener("click", exportCSV);
  document.getElementById("scheduleBtn").addEventListener("click", openScheduleBtn);
  document.getElementById("attendanceBtn").addEventListener("click", openAttendanceBtn);
  document.getElementById("dashboardBtn").addEventListener("click", openDashboardBtn);
  document.getElementById("customizeBtn").addEventListener("click", () => {
    if (!canAdd()) { showError("Please sign in with an approved Google account to customize the register."); return; }
    settingsOpen = true; renderSettings();
  });
  render();
  initCloud();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
});
