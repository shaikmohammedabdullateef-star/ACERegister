/* ACE Skills Development Center — Lead & Student Register (offline app) */

const DEFAULT_SOURCES = ["Instagram", "Facebook", "WhatsApp", "Referral", "Walk-in", "Google", "JustDial"];
const DEFAULT_COURSES = ["IELTS", "PTE", "Spoken English"];
const STATUSES = ["New Lead", "Enrolled", "Not Interested", "Dropped"];
const FOLLOWUPS = ["Yes", "Pending", "No"];

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
function showError(msg) {
  const el = document.getElementById("saveError");
  el.textContent = msg;
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

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/* Only the tutor who created a record — or anyone when the app is running
   in local/offline mode — can edit or delete it. */
function canEdit(r) {
  if (!cloudEnabled || !currentUser) return true;
  if (!r.createdBy) return true; // legacy/local entries with no recorded owner
  return r.createdBy === currentUser.uid;
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
      if (user) {
        subscribeSharedRecords();
        subscribeSharedSettings();
      } else {
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
    record.createdBy = currentUser.uid;
    record.createdByName = currentUser.displayName || currentUser.email;
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
    if (state.search.trim()) {
      const q = state.search.toLowerCase();
      if (!r.name.toLowerCase().includes(q) && !r.contact.toLowerCase().includes(q)) return false;
    }
    return true;
  });
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
    <div class="stat-card" style="--grad:linear-gradient(135deg,#5B5BFF,#4C4CFF)"><div class="stat-label">&#128101; Total Leads</div><div class="stat-value">${s.total}</div></div>
    <div class="stat-card" style="--grad:linear-gradient(135deg,#17C0AC,#12A594)"><div class="stat-label">&#9989; Enrolled</div><div class="stat-value">${s.enrolled}</div></div>
    <div class="stat-card" style="--grad:linear-gradient(135deg,#FF7A5C,#E64A6B)"><div class="stat-label">&#128276; Follow-up Pending</div><div class="stat-value">${s.pending}</div></div>
    <div class="stat-card" style="--grad:linear-gradient(135deg,#FFC157,#F5A623)"><div class="stat-label">&#9203; Renewals Due (30d)</div><div class="stat-value">${s.renewals}</div></div>
  `;
}

function renderToolbar() {
  const statusOpts = ["All", ...STATUSES].map((o) => `<option value="${esc(o)}" ${state.statusFilter === o ? "selected" : ""}>${o === "All" ? "Status: All" : esc(o)}</option>`).join("");
  const sourceOpts = ["All", ...state.sources].map((o) => `<option value="${esc(o)}" ${state.sourceFilter === o ? "selected" : ""}>${o === "All" ? "Source: All" : esc(o)}</option>`).join("");
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
    </div>
    <div class="tabs">${tabs}</div>
  `;
  document.getElementById("searchInput").addEventListener("input", (e) => { state.search = e.target.value; renderRecords(); });
  document.getElementById("statusFilter").addEventListener("change", (e) => { state.statusFilter = e.target.value; renderRecords(); });
  document.getElementById("sourceFilter").addEventListener("change", (e) => { state.sourceFilter = e.target.value; renderRecords(); });
  document.querySelectorAll("[data-course-tab]").forEach((btn) => {
    btn.addEventListener("click", () => { state.courseFilter = btn.dataset.courseTab; renderToolbar(); renderRecords(); });
  });
}

function renderRecords() {
  const list = filteredRecords();
  const wrap = document.getElementById("recordsWrap");
  if (list.length === 0) {
    wrap.innerHTML = `<div class="empty"><div style="font-size:26px;opacity:.5">&#128214;</div>
      <p>${state.records.length === 0 ? "The register is empty. Add your first lead to begin." : "No entries match these filters."}</p></div>`;
    return;
  }
  wrap.innerHTML = `<div class="records">${list.map(recordCardHTML).join("")}</div>`;

  list.forEach((r) => {
    document.getElementById(`edit-${r.id}`)?.addEventListener("click", () => openEdit(r.id));
    document.getElementById(`del-${r.id}`)?.addEventListener("click", () => { state.confirmDeleteId = r.id; renderRecords(); });
    document.getElementById(`delyes-${r.id}`)?.addEventListener("click", () => {
      deleteRecordRemote(r.id);
      state.confirmDeleteId = null;
    });
    document.getElementById(`delno-${r.id}`)?.addEventListener("click", () => { state.confirmDeleteId = null; renderRecords(); });
  });
  observeReveal();
}

function recordCardHTML(r) {
  const sc = STATUS_COLOR[r.status] || "#4C4CFF";
  const fc = FOLLOW_COLOR[r.followedUp] || "#F5A623";
  const cc = courseColor(r.courseInterest);
  const renewIn = daysUntil(r.renewalDate);
  const renewSoon = renewIn !== null && renewIn <= 30 && r.status === "Enrolled";
  const renewColor = renewIn < 0 ? "#E64A6B" : "#F5A623";
  const editable = canEdit(r);

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

  return `<div class="record" style="--course-color:${cc}">
    <div class="record-top">
      <div style="flex:1 1 240px">
        <div class="record-name-row">
          <span class="record-name">${esc(r.name)}</span>
          <span class="stamp" style="color:${sc};border-color:${sc}">${esc(r.status)}</span>
        </div>
        <div class="meta-row">
          <span class="meta-item">&#128222; ${esc(r.contact)}</span>
          ${r.email ? `<span class="meta-item">&#9993;&#65039; ${esc(r.email)}</span>` : ""}
          <span class="meta-item">&#127991;&#65039; ${esc(r.leadSource)}</span>
          <span class="meta-item course-tag" style="--course-color:${cc}">&#128214; ${esc(r.courseInterest)}</span>
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
function openAdd() { state.editing = emptyRecord(); renderModal(); }
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
        <label class="field">Full name *<input id="f_name" value="${esc(r.name)}" placeholder="e.g. Priya Sharma" /></label>
        <label class="field">Contact number *<input id="f_contact" value="${esc(r.contact)}" placeholder="10-digit mobile" /></label>
        <label class="field">Email (Gmail etc.)<input id="f_email" type="email" value="${esc(r.email || "")}" placeholder="name@gmail.com" /></label>
        <label class="field">Lead source<select id="f_source">${sourceOpts}</select></label>
        <label class="field">Course interest<select id="f_course">${courseOpts}</select></label>
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
    const updated = {
      ...r, name, contact,
      email: document.getElementById("f_email").value.trim(),
      leadSource: document.getElementById("f_source").value,
      courseInterest: document.getElementById("f_course").value,
      feeOffered: document.getElementById("f_fee").value,
      status: document.getElementById("f_status").value,
      followedUp: document.getElementById("f_follow").value,
      createdAt: document.getElementById("f_created").value,
      joiningDate: document.getElementById("f_joining").value,
      renewalDate: document.getElementById("f_renewal").value,
      feedback: document.getElementById("f_feedback").value,
      notes: document.getElementById("f_notes").value,
    };
    writeRecord(updated, isNew);
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
}

function commitSettings() {
  save();
  if (cloudEnabled && currentUser) pushSharedSettings();
  settingsOpen = true;
  renderToolbar(); renderRecords(); renderSettings();
}

/* ---------- CSV export ---------- */
function exportCSV() {
  const headers = ["Name", "Contact", "Email", "Lead Source", "Course", "Fee Offered", "Status", "Followed Up", "Feedback", "Joining Date", "Renewal Date", "Lead Date", "Notes", "Added By"];
  const rows = state.records.map((r) => [r.name, r.contact, r.email, r.leadSource, r.courseInterest, r.feeOffered, r.status, r.followedUp, r.feedback, r.joiningDate, r.renewalDate, r.createdAt, r.notes, r.createdByName || ""]);
  const csv = [headers, ...rows].map((row) => row.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "ace_register.csv"; a.click();
  URL.revokeObjectURL(url);
}

/* ---------- init ---------- */
document.addEventListener("DOMContentLoaded", () => {
  load();
  document.getElementById("addBtn").addEventListener("click", openAdd);
  document.getElementById("exportBtn").addEventListener("click", exportCSV);
  document.getElementById("customizeBtn").addEventListener("click", () => { settingsOpen = true; renderSettings(); });
  render();
  initCloud();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
});
