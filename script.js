// Local (file:// or localhost) -> backend on localhost:4000.
// Deployed on a real domain    -> same server, so a relative '/api' works.
const API_BASE = (location.protocol === 'file:' || ['localhost', '127.0.0.1'].includes(location.hostname))
  ? 'http://localhost:4000/api'
  : '/api';

let token = localStorage.getItem('svToken') || null;
let currentUser = JSON.parse(localStorage.getItem('svUser') || 'null');

let coursesFlat = [];       // raw course list from API
let syllabusCache = {};     // grouped by year -> semester -> [courses]
let teacherCourseIds = new Set(); // courses this teacher is assigned to (if role === 'teacher')

let currentPath = [];       // [year, semester, course]  (course = full course object)
let activeFilter = 'all';
let currentCourseResources = [];
let expandedResources = new Set();      // resource ids whose discussion panel is open
let resourceComments = {};              // resourceId -> array of comments (lazy-loaded)

let contribMode = 'create'; // 'create' | 'edit'
let contribEditId = null;
let contribTargetCourse = null;

/* ================= API helper ================= */
async function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    logout();
    throw new Error('Session expired. Please log in again.');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Something went wrong.');
  }
  return data;
}

/* ================= Auth screen ================= */
function switchAuthTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('tabLogin').classList.toggle('active', isLogin);
  document.getElementById('tabRegister').classList.toggle('active', !isLogin);
  document.getElementById('loginForm').style.display = isLogin ? 'block' : 'none';
  document.getElementById('registerForm').style.display = isLogin ? 'none' : 'block';
}

async function handleLogin(event) {
  event.preventDefault();
  const errorEl = document.getElementById('loginError');
  errorEl.style.display = 'none';

  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;

  try {
    const data = await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    setSession(data.token, data.user);
    await initApp();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
  }
}

async function handleRegister(event) {
  event.preventDefault();
  const errorEl = document.getElementById('registerError');
  errorEl.style.display = 'none';

  const name = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;

  try {
    const data = await apiFetch('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name, email, password })
    });
    setSession(data.token, data.user);
    await initApp();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
  }
}

function setSession(newToken, user) {
  token = newToken;
  currentUser = user;
  localStorage.setItem('svToken', token);
  localStorage.setItem('svUser', JSON.stringify(user));
}

function logout() {
  token = null;
  currentUser = null;
  localStorage.removeItem('svToken');
  localStorage.removeItem('svUser');
  document.getElementById('app').style.display = 'none';
  document.getElementById('auth-page').style.display = 'flex';
  document.getElementById('loginForm').reset();
}

/* ================= App bootstrap ================= */
window.addEventListener('DOMContentLoaded', () => {
  if (token && currentUser) {
    initApp().catch(() => logout());
  }
});

async function initApp() {
  document.getElementById('auth-page').style.display = 'none';
  document.getElementById('app').style.display = 'block';

  const roleLabel = { chairman: 'Chairman', teacher: 'Teacher', student: 'Student' }[currentUser.role];
  document.getElementById('userLabel').textContent = `Hi, ${currentUser.name} (${roleLabel})`;

  buildRoleNav();
  await loadCourses();

  if (currentUser.role === 'teacher') {
    const assigned = await apiFetch('/assignments/mine');
    teacherCourseIds = new Set(assigned.map(a => a.course_id));
  }

  backToHome();
}

function buildRoleNav() {
  const nav = document.getElementById('roleNav');
  nav.innerHTML = '';

  if (currentUser.role === 'chairman') {
    nav.innerHTML = `
      <button onclick="openTeachersModal()">👤 Manage Teachers</button>
      <button onclick="openAssignModal()">🗂️ Course Assignments</button>`;
  } else if (currentUser.role === 'teacher') {
    nav.innerHTML = `<button onclick="openPendingModal()">✅ Pending Approvals</button>`;
  }
}

function canManageCourse(course) {
  if (!currentUser) return false;
  if (currentUser.role === 'chairman') return true;
  if (currentUser.role === 'teacher') return teacherCourseIds.has(course.id);
  return false;
}

/* ================= Courses ================= */
async function loadCourses() {
  coursesFlat = await apiFetch('/courses');
  syllabusCache = {};

  coursesFlat.forEach(c => {
    if (!syllabusCache[c.year]) syllabusCache[c.year] = { semesters: {} };
    if (!syllabusCache[c.year].semesters[c.semester]) {
      syllabusCache[c.year].semesters[c.semester] = { courses: [] };
    }
    syllabusCache[c.year].semesters[c.semester].courses.push(c);
  });
}

function ordinal(n) {
  return { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' }[n] || `${n}th`;
}
function yearName(y) { return `${ordinal(Number(y))} Year`; }
function semName(s) { return `${ordinal(Number(s))} Semester`; }

/* ================= Resource categorisation ================= */
function categoryMeta(cat) {
  return {
    yt: { icon: '🎥', label: 'YouTube' },
    drive: { icon: '📁', label: 'Drive / Notes' },
    link: { icon: '🔗', label: 'Article / Link' }
  }[cat] || { icon: '🔗', label: 'Link' };
}

/* ================= Breadcrumbs ================= */
function renderBreadcrumbs(crumbs) {
  const bc = document.getElementById('breadcrumbs');
  if (!crumbs || crumbs.length === 0) {
    bc.style.display = 'none';
    bc.innerHTML = '';
    return;
  }
  bc.style.display = 'flex';
  bc.innerHTML = crumbs.map((c, i) => {
    const sep = i < crumbs.length - 1 ? '<span class="crumb-sep">›</span>' : '';
    const el = c.onclick
      ? `<span class="crumb-link" onclick="${c.onclick}">${c.label}</span>`
      : `<span class="crumb-current">${c.label}</span>`;
    return el + sep;
  }).join('');
}

/* ================= Navigation ================= */
function backToHome() {
  document.getElementById('searchInput').value = '';
  currentPath = [];
  renderBreadcrumbs([]);
  document.getElementById('year-page').style.display = 'block';
  document.getElementById('content').style.display = 'none';
}

function showYear(year) {
  currentPath = [year];
  renderBreadcrumbs([
    { label: 'Home', onclick: 'backToHome()' },
    { label: yearName(year) }
  ]);

  const yearData = syllabusCache[year];
  let html = `<button class="back-btn" onclick="backToHome()">← Back to Home</button>`;
  html += `<h2>${yearName(year)}</h2><div class="grid">`;

  if (yearData) {
    Object.keys(yearData.semesters).sort().forEach(sem => {
      html += `<div class="year-card" onclick="showSemester(${year}, ${sem})">${semName(sem)}</div>`;
    });
  } else {
    html += `<p class="empty-note">No courses found for this year yet.</p>`;
  }

  html += `</div>`;
  document.getElementById('content').innerHTML = html;
  document.getElementById('year-page').style.display = 'none';
  document.getElementById('content').style.display = 'block';
}

function showSemester(year, sem) {
  currentPath = [year, sem];
  renderBreadcrumbs([
    { label: 'Home', onclick: 'backToHome()' },
    { label: yearName(year), onclick: `showYear(${year})` },
    { label: semName(sem) }
  ]);

  const courses = syllabusCache[year].semesters[sem].courses;
  let html = `<button class="back-btn" onclick="showYear(${year})">← Back to ${yearName(year)}</button>`;
  html += `<h2>${semName(sem)}</h2><div class="grid">`;

  courses.forEach(course => {
    html += `
      <div class="card" onclick="showCourse(${year}, ${sem}, ${course.id})">
        <strong>${course.code}</strong><br>${course.title}
      </div>`;
  });

  html += `</div>`;
  document.getElementById('content').innerHTML = html;
}

async function showCourse(year, sem, courseId) {
  const course = syllabusCache[year].semesters[sem].courses.find(c => c.id === courseId);
  currentPath = [year, sem, course];
  activeFilter = 'all';
  expandedResources = new Set();
  resourceComments = {};

  renderBreadcrumbs([
    { label: 'Home', onclick: 'backToHome()' },
    { label: yearName(year), onclick: `showYear(${year})` },
    { label: semName(sem), onclick: `showSemester(${year}, ${sem})` },
    { label: course.code }
  ]);

  document.getElementById('content').innerHTML = `<p class="empty-note">Loading…</p>`;

  try {
    currentCourseResources = await apiFetch(`/resources?course_id=${course.id}`);
    document.getElementById('content').innerHTML = renderCourseHTML(year, sem, course);
  } catch (err) {
    document.getElementById('content').innerHTML = `<p class="empty-note">${err.message}</p>`;
  }
}

function renderCourseHTML(year, sem, course) {
  const manageable = canManageCourse(course);

  let html = `<button class="back-btn" onclick="showSemester(${year}, ${sem})">← Back to Semester</button>`;
  html += `
    <div class="course-header-row">
      <h2>${course.code} - ${course.title}</h2>
      <button class="add-resource-btn" onclick="openContribModal(${course.id})">➕ Add Resource</button>
    </div>
    <h3>Resources</h3>`;

  if (currentCourseResources.length === 0) {
    html += `<p class="empty-note">No approved resources yet. Be the first to contribute!</p>`;
  } else {
    html += `<div class="filter-bar">`;
    html += `<button class="filter-btn ${activeFilter === 'all' ? 'active' : ''}" onclick="setFilter('all')">All</button>`;
    ['yt', 'drive', 'link'].forEach(cat => {
      const meta = categoryMeta(cat);
      html += `<button class="filter-btn ${activeFilter === cat ? 'active' : ''}" onclick="setFilter('${cat}')">${meta.icon} ${meta.label}</button>`;
    });
    html += `</div><div id="resourceList">`;

    currentCourseResources.forEach(r => {
      html += renderResourceBlock(r, manageable);
    });

    html += `</div>`;
  }

  return html;
}

function renderResourceBlock(r, manageable) {
  const meta = categoryMeta(r.type);
  const hidden = (activeFilter !== 'all' && activeFilter !== r.type) ? 'hidden' : '';
  const badge = r.submitted_by_name && r.submitted_by_name !== currentUser.name
    ? `<span class="resource-badge">By ${r.submitted_by_name}</span>` : '';

  const isOpen = expandedResources.has(r.id);

  let html = `<div class="resource-block ${hidden}" data-restype="${r.type}">
    <div class="resource">
      <span>${meta.icon} <a href="${r.link}" target="_blank">${r.title}</a></span>
      <div class="resource-actions">
        ${renderResourceRatingBadge(r)}
        <button class="icon-btn" onclick="toggleResourcePanel(${r.id})">💬 ${r.comment_count || 0}</button>
        ${badge}
        ${manageable ? `
          <button class="icon-btn" onclick="openEditModal(${r.id})">✏️</button>
          <button class="icon-btn delete" onclick="deleteResource(${r.id})">🗑️</button>
        ` : ''}
      </div>
    </div>
    <div class="resource-panel" id="resourcePanel-${r.id}" style="display:${isOpen ? 'block' : 'none'};">
      ${isOpen ? renderResourcePanelContent(r) : ''}
    </div>
  </div>`;

  return html;
}

function renderResourceRatingBadge(r) {
  if (currentUser.role === 'student') {
    return renderInlineStarPicker(r);
  }
  if (!r.rating_count || r.rating_count === 0) {
    return `<span class="rating-summary small empty-rating">☆☆☆☆☆</span>`;
  }
  const stars = starString(Math.round(Number(r.avg_rating)));
  return `<span class="rating-summary small">${stars} ${r.avg_rating} <span class="rating-count">(${r.rating_count})</span></span>`;
}

function renderInlineStarPicker(r) {
  const my = r.my_rating;
  let stars = '';
  for (let i = 1; i <= 5; i++) {
    const filled = my && i <= my;
    stars += `<span class="star-pick inline ${filled ? 'filled' : ''}" title="Rate ${i}" onclick="event.stopPropagation(); rateResource(${r.id}, ${i})">${filled ? '★' : '☆'}</span>`;
  }
  const summary = r.rating_count > 0
    ? ` <span class="rating-count">${r.avg_rating} (${r.rating_count})</span>`
    : ` <span class="rating-count">Rate this</span>`;
  return `<span class="stars-row inline">${stars}</span>${summary}`;
}

function renderResourcePanelContent(r) {
  let html = '';
  html += renderCommentsSection(r);
  return html;
}

async function toggleResourcePanel(resourceId) {
  const panel = document.getElementById(`resourcePanel-${resourceId}`);
  const resource = currentCourseResources.find(r => r.id === resourceId);

  if (expandedResources.has(resourceId)) {
    expandedResources.delete(resourceId);
    panel.style.display = 'none';
    return;
  }

  expandedResources.add(resourceId);
  panel.style.display = 'block';

  if (!resourceComments[resourceId]) {
    panel.innerHTML = `<p class="empty-note">Loading…</p>`;
    try {
      resourceComments[resourceId] = await apiFetch(`/comments?resource_id=${resourceId}`);
    } catch (err) {
      panel.innerHTML = `<p class="empty-note">${err.message}</p>`;
      return;
    }
  }
  panel.innerHTML = renderResourcePanelContent(resource);
}

function setFilter(cat) {
  activeFilter = cat;
  const [year, sem, course] = currentPath;
  document.getElementById('content').innerHTML = renderCourseHTML(year, sem, course);
}

// Refetches resources for the current course and re-renders just the list,
// preserving which resource panels are expanded and their cached comments.
async function refreshResourceList() {
  const [, , course] = currentPath;
  currentCourseResources = await apiFetch(`/resources?course_id=${course.id}`);
  const manageable = canManageCourse(course);
  const listEl = document.getElementById('resourceList');
  if (listEl) {
    listEl.innerHTML = currentCourseResources.map(r => renderResourceBlock(r, manageable)).join('');
  }
}

/* ================= Ratings (per resource) ================= */
function starString(filledCount) {
  return '★'.repeat(filledCount) + '☆'.repeat(5 - filledCount);
}

async function rateResource(resourceId, value) {
  try {
    await apiFetch('/ratings', {
      method: 'POST',
      body: JSON.stringify({ resource_id: resourceId, rating: value })
    });
    showToast('⭐ Thanks for rating!');
    expandedResources.add(resourceId); // keep the panel open through the refresh
    await refreshResourceList();
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

/* ================= Comments (Q&A, per resource) ================= */
function buildCommentTree(flat) {
  const byId = {};
  flat.forEach(c => { byId[c.id] = { ...c, replies: [] }; });
  const roots = [];
  flat.forEach(c => {
    if (c.parent_id && byId[c.parent_id]) {
      byId[c.parent_id].replies.push(byId[c.id]);
    } else if (!c.parent_id) {
      roots.push(byId[c.id]);
    }
  });
  return roots;
}

function roleTag(role) {
  if (role === 'teacher') return `<span class="role-tag teacher">Teacher</span>`;
  if (role === 'chairman') return `<span class="role-tag chairman">Chairman</span>`;
  return '';
}

function renderCommentsSection(r) {
  const comments = resourceComments[r.id] || [];
  const tree = buildCommentTree(comments);

  let html = `<div class="comments-section">
    <h4>💬 Questions about this resource (${comments.length})</h4>
    <form class="comment-form" onsubmit="postComment(event, ${r.id}, null)">
      <textarea id="newCommentBox-${r.id}" placeholder="Ask a question about this resource..." required></textarea>
      <button type="submit" class="btn-primary">Post</button>
    </form>
    <div id="commentsList-${r.id}">`;

  if (tree.length === 0) {
    html += `<p class="empty-note">No questions yet. Be the first to ask!</p>`;
  } else {
    tree.forEach(node => { html += renderCommentNode(node, r.id); });
  }

  html += `</div></div>`;
  return html;
}

function renderCommentNode(comment, resourceId, depth = 0) {
  const canDelete = currentUser.role === 'chairman' || comment.user_id === currentUser.id;
  const when = new Date(comment.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  let html = `<div class="comment ${depth > 0 ? 'comment-reply' : ''}">
    <div class="comment-head">
      <strong>${comment.user_name}</strong> ${roleTag(comment.user_role)}
      <span class="comment-date">${when}</span>
    </div>
    <div class="comment-body">${escapeHtml(comment.content)}</div>
    <div class="comment-actions">
      ${depth === 0 ? `<button class="link-btn small" onclick="toggleReplyBox(${comment.id})">Reply</button>` : ''}
      ${canDelete ? `<button class="link-btn small danger" onclick="deleteComment(${comment.id}, ${resourceId})">Delete</button>` : ''}
    </div>
    <form class="reply-form" id="replyForm-${comment.id}" style="display:none;" onsubmit="postComment(event, ${resourceId}, ${comment.id})">
      <textarea id="replyBox-${comment.id}" placeholder="Write a reply..." required></textarea>
      <button type="submit" class="btn-primary">Reply</button>
    </form>`;

  comment.replies.forEach(rep => { html += renderCommentNode(rep, resourceId, depth + 1); });

  html += `</div>`;
  return html;
}

function toggleReplyBox(commentId) {
  const box = document.getElementById(`replyForm-${commentId}`);
  box.style.display = box.style.display === 'none' ? 'block' : 'none';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function postComment(event, resourceId, parentId) {
  event.preventDefault();
  const boxId = parentId ? `replyBox-${parentId}` : `newCommentBox-${resourceId}`;
  const content = document.getElementById(boxId).value.trim();
  if (!content) return;

  try {
    await apiFetch('/comments', {
      method: 'POST',
      body: JSON.stringify({ resource_id: resourceId, content, parent_id: parentId })
    });
    resourceComments[resourceId] = await apiFetch(`/comments?resource_id=${resourceId}`);
    expandedResources.add(resourceId);
    await refreshResourceList();
    showToast(parentId ? '💬 Reply posted.' : '💬 Question posted.');
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

async function deleteComment(id, resourceId) {
  if (!confirm('Delete this comment?')) return;
  try {
    await apiFetch(`/comments/${id}`, { method: 'DELETE' });
    resourceComments[resourceId] = await apiFetch(`/comments?resource_id=${resourceId}`);
    expandedResources.add(resourceId);
    await refreshResourceList();
    showToast('🗑️ Comment deleted.');
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

/* ================= Search ================= */
function searchCourses() {
  const query = document.getElementById('searchInput').value.trim().toLowerCase();
  if (!query) { backToHome(); return; }

  const results = coursesFlat.filter(c =>
    c.code.toLowerCase().includes(query) || c.title.toLowerCase().includes(query)
  );
  renderSearchResults(results, query);
}

function renderSearchResults(results, query) {
  document.getElementById('year-page').style.display = 'none';
  document.getElementById('content').style.display = 'block';

  renderBreadcrumbs([
    { label: 'Home', onclick: 'backToHome()' },
    { label: `Search: "${query}"` }
  ]);

  let html = `<button class="back-btn" onclick="backToHome()">← Back to Home</button>`;
  html += `<h2>Search Results</h2>`;

  if (results.length === 0) {
    html += `<p class="empty-note">No courses matched "${query}".</p>`;
  } else {
    html += `<div class="grid">`;
    results.forEach(course => {
      html += `
        <div class="card" onclick="showCourse(${course.year}, ${course.semester}, ${course.id})">
          <strong>${course.code}</strong><br>${course.title}
        </div>`;
    });
    html += `</div>`;
  }

  document.getElementById('content').innerHTML = html;
}

/* ================= Dark mode ================= */
function toggleDarkMode() {
  document.body.classList.toggle('dark');
  const btn = document.getElementById('themeToggle');
  btn.textContent = document.body.classList.contains('dark') ? '☀️ Light Mode' : '🌙 Dark Mode';
}

/* ================= Toast ================= */
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

/* ================= Resource contribution / edit ================= */
function openContribModal(courseId) {
  const course = coursesFlat.find(c => c.id === courseId);
  contribMode = 'create';
  contribEditId = null;
  contribTargetCourse = course;

  const isDirect = canManageCourse(course);
  document.getElementById('contribModalTitle').textContent = isDirect ? '➕ Add Resource' : '➕ Contribute a Resource';
  document.getElementById('contribSubmitBtn').textContent = isDirect ? 'Add Resource' : 'Submit for Approval';
  document.getElementById('contribCourseLabel').textContent = `${isDirect ? 'Adding to' : 'Submitting to'} ${course.code} - ${course.title}`;

  document.getElementById('contribForm').reset();
  document.getElementById('contribError').style.display = 'none';
  document.getElementById('contribModalOverlay').style.display = 'flex';
  document.getElementById('contribTitle').focus();
}

function openEditModal(resourceId) {
  const resource = currentCourseResources.find(r => r.id === resourceId);
  if (!resource) return;

  contribMode = 'edit';
  contribEditId = resourceId;
  contribTargetCourse = currentPath[2];

  document.getElementById('contribModalTitle').textContent = '✏️ Edit Resource';
  document.getElementById('contribSubmitBtn').textContent = 'Save Changes';
  document.getElementById('contribCourseLabel').textContent = `Editing resource in ${contribTargetCourse.code}`;

  document.getElementById('contribTitle').value = resource.title;
  document.getElementById('contribLink').value = resource.link;
  document.getElementById('contribError').style.display = 'none';
  document.getElementById('contribModalOverlay').style.display = 'flex';
}

function closeContribModal() {
  document.getElementById('contribModalOverlay').style.display = 'none';
}

async function submitContribution(event) {
  event.preventDefault();
  const errorEl = document.getElementById('contribError');
  errorEl.style.display = 'none';

  const title = document.getElementById('contribTitle').value.trim();
  const link = document.getElementById('contribLink').value.trim();

  try {
    if (contribMode === 'edit') {
      await apiFetch(`/resources/${contribEditId}`, {
        method: 'PUT',
        body: JSON.stringify({ title, link })
      });
      showToast('✅ Resource updated.');
    } else {
      const data = await apiFetch('/resources', {
        method: 'POST',
        body: JSON.stringify({ course_id: contribTargetCourse.id, title, link })
      });
      showToast(data.status === 'pending'
        ? '📩 Submitted! A teacher will review it before it goes public.'
        : '✅ Resource added.');
    }

    closeContribModal();
    if (currentPath.length === 3 && currentPath[2].id === contribTargetCourse.id) {
      await showCourse(currentPath[0], currentPath[1], contribTargetCourse.id);
    }
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
  }
}

async function deleteResource(resourceId) {
  if (!confirm('Remove this resource?')) return;
  try {
    await apiFetch(`/resources/${resourceId}`, { method: 'DELETE' });
    showToast('🗑️ Resource removed.');
    const [year, sem, course] = currentPath;
    await showCourse(year, sem, course.id);
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

/* ================= Teacher: Pending Approvals ================= */
async function openPendingModal() {
  document.getElementById('pendingModalOverlay').style.display = 'flex';
  await refreshPendingList();
}

function closePendingModal() {
  document.getElementById('pendingModalOverlay').style.display = 'none';
}

async function refreshPendingList() {
  const list = document.getElementById('pendingList');
  list.innerHTML = `<p class="empty-note">Loading…</p>`;

  try {
    const pending = await apiFetch('/resources/pending/mine');
    if (pending.length === 0) {
      list.innerHTML = `<p class="empty-note">No pending submissions right now. 🎉</p>`;
      return;
    }

    list.innerHTML = pending.map(r => `
      <div class="list-row">
        <div>
          <strong>${r.title}</strong>
          <div class="meta">${r.course_code} · submitted by ${r.submitted_by_name || 'Unknown'}</div>
          <a href="${r.link}" target="_blank">${r.link}</a>
        </div>
        <div class="resource-actions">
          <button class="icon-btn approve" onclick="reviewResource(${r.id}, 'approve')">✔ Approve</button>
          <button class="icon-btn reject" onclick="reviewResource(${r.id}, 'reject')">✕ Reject</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    list.innerHTML = `<p class="empty-note">${err.message}</p>`;
  }
}

async function reviewResource(id, action) {
  try {
    await apiFetch(`/resources/${id}/${action}`, { method: 'PUT' });
    showToast(action === 'approve' ? '✅ Resource approved.' : '🚫 Resource rejected.');
    await refreshPendingList();
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

/* ================= Chairman: Manage Teachers ================= */
async function openTeachersModal() {
  document.getElementById('teachersModalOverlay').style.display = 'flex';
  document.getElementById('addTeacherForm').reset();
  document.getElementById('teacherFormError').style.display = 'none';
  await refreshTeachersList();
}

function closeTeachersModal() {
  document.getElementById('teachersModalOverlay').style.display = 'none';
}

async function refreshTeachersList() {
  const list = document.getElementById('teachersList');
  list.innerHTML = `<p class="empty-note">Loading…</p>`;

  try {
    const teachers = await apiFetch('/teachers');
    if (teachers.length === 0) {
      list.innerHTML = `<p class="empty-note">No teachers added yet.</p>`;
      return;
    }

    list.innerHTML = teachers.map(t => `
      <div class="list-row">
        <div>
          <strong>${t.name}</strong>
          <div class="meta">${t.email} · ${t.courses.length ? t.courses.map(c => c.code).join(', ') : 'No courses assigned'}</div>
        </div>
        <button class="icon-btn delete" onclick="removeTeacher(${t.id})">🗑️ Remove</button>
      </div>
    `).join('');
  } catch (err) {
    list.innerHTML = `<p class="empty-note">${err.message}</p>`;
  }
}

async function handleAddTeacher(event) {
  event.preventDefault();
  const errorEl = document.getElementById('teacherFormError');
  errorEl.style.display = 'none';

  const name = document.getElementById('newTeacherName').value.trim();
  const email = document.getElementById('newTeacherEmail').value.trim();
  const password = document.getElementById('newTeacherPassword').value;

  try {
    await apiFetch('/teachers', {
      method: 'POST',
      body: JSON.stringify({ name, email, password })
    });
    showToast('✅ Teacher account created.');
    document.getElementById('addTeacherForm').reset();
    await refreshTeachersList();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
  }
}

async function removeTeacher(id) {
  if (!confirm('Remove this teacher? Their course assignments will also be removed.')) return;
  try {
    await apiFetch(`/teachers/${id}`, { method: 'DELETE' });
    showToast('🗑️ Teacher removed.');
    await refreshTeachersList();
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

/* ================= Chairman: Course Assignments ================= */
async function openAssignModal() {
  document.getElementById('assignModalOverlay').style.display = 'flex';
  document.getElementById('assignFormError').style.display = 'none';
  await populateAssignSelects();
  await refreshAssignmentsList();
}

function closeAssignModal() {
  document.getElementById('assignModalOverlay').style.display = 'none';
}

async function populateAssignSelects() {
  const courseSelect = document.getElementById('assignCourseSelect');
  const teacherSelect = document.getElementById('assignTeacherSelect');

  courseSelect.innerHTML = coursesFlat.map(c => `<option value="${c.id}">${c.code} - ${c.title}</option>`).join('');

  try {
    const teachers = await apiFetch('/teachers');
    if (teachers.length === 0) {
      teacherSelect.innerHTML = `<option value="">No teachers yet</option>`;
    } else {
      teacherSelect.innerHTML = teachers.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
    }
  } catch (err) {
    teacherSelect.innerHTML = `<option value="">Could not load teachers</option>`;
  }
}

async function refreshAssignmentsList() {
  const list = document.getElementById('assignmentsList');
  list.innerHTML = `<p class="empty-note">Loading…</p>`;

  try {
    const assignments = await apiFetch('/assignments');
    if (assignments.length === 0) {
      list.innerHTML = `<p class="empty-note">No courses assigned yet.</p>`;
      return;
    }

    list.innerHTML = assignments.map(a => `
      <div class="list-row">
        <div>
          <strong>${a.code}</strong> - ${a.title}
          <div class="meta">Assigned to ${a.teacher_name}</div>
        </div>
        <button class="icon-btn delete" onclick="removeAssignment(${a.id})">🗑️ Remove</button>
      </div>
    `).join('');
  } catch (err) {
    list.innerHTML = `<p class="empty-note">${err.message}</p>`;
  }
}

async function handleAssign(event) {
  event.preventDefault();
  const errorEl = document.getElementById('assignFormError');
  errorEl.style.display = 'none';

  const course_id = document.getElementById('assignCourseSelect').value;
  const teacher_id = document.getElementById('assignTeacherSelect').value;

  if (!teacher_id) {
    errorEl.textContent = 'Add a teacher first before assigning courses.';
    errorEl.style.display = 'block';
    return;
  }

  try {
    await apiFetch('/assignments', {
      method: 'POST',
      body: JSON.stringify({ course_id, teacher_id })
    });
    showToast('✅ Course assigned.');
    await refreshAssignmentsList();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
  }
}

async function removeAssignment(id) {
  if (!confirm('Remove this assignment?')) return;
  try {
    await apiFetch(`/assignments/${id}`, { method: 'DELETE' });
    showToast('🗑️ Assignment removed.');
    await refreshAssignmentsList();
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}
