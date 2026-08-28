const STORAGE = {
  current: 'soccer_current_tournament_v18',
  archive: 'soccer_tournament_archive_v18',
  blog: 'soccer_blog_posts_v7',
  users: 'soccer_users_v14',
  admins: 'soccer_admin_v7',
  session: 'soccer_session_v13'
};

const POSITIONS = ['Forward', 'Midfielder', 'Defender', 'Goalkeeper'];
const MAX_LINEUP_SIZE = 11;
const TOURNAMENT_TYPES = ['Group Stage', 'Knockout'];
const KNOCKOUT_SIZES = [64, 32, 16, 8, 4, 2];
const MAX_PLAYERS_PER_DIVISION = 32;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB per image, keeps localStorage usage sane
const MAX_UPDATES_KEPT = 200; // trim the activity feed so it doesn't grow forever
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SAMPLE_ADMIN = { username: 'admin', password: 'admin123' };

const App = (() => {
  let currentPage = '';
  let state = loadCurrentTournament();
  let archive = loadArchive();
  let session = loadSession();
  let blogFilter = '';
  let adminTeamFilter = '';
  let challengeStatusFilter = 'all';
  let activeScoreChallengeId = null;
  let activeLineupChallengeId = null;
  let activeBracketLineupMatch = null; // { roundIndex, matchId }
  let editingPlayerId = null;
  let activeBracketMatch = null; // { roundIndex, matchId }
  let forgotPasswordKind = 'team'; // 'team' | 'admin'
  let editingBlogPostId = null;
  let pendingGuestTeams = []; // teams added directly on the create-tournament form, not yet saved

  function defaultState() {
    return {
      tournamentName: '',
      tournamentHost: '',
      tournamentNumber: '',
      tournamentInfo: '',
      tournamentType: '',
      knockoutSize: null,
      teams: [],
      players: [],
      matches: [],
      updates: [],
      challenges: [],
      bracket: null,
      playerStats: {}, // playerId -> { goals, yellow, red }
      hostPhoto: '',
      hostBio: ''
    };
  }

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function uid() {
    return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function loadCurrentTournament() {
    const loaded = readJSON(STORAGE.current, defaultState());
    if (!loaded.playerStats) loaded.playerStats = {};
    if (loaded.hostPhoto === undefined) loaded.hostPhoto = '';
    if (loaded.hostBio === undefined) loaded.hostBio = '';
    return loaded;
  }

  function loadArchive() {
    return readJSON(STORAGE.archive, []);
  }

  function loadSession() {
    return readJSON(STORAGE.session, {
      teamEmail: '',
      adminSignedIn: false
    });
  }

  function loadBlog() {
    return readJSON(STORAGE.blog, []);
  }

  function saveBlog(posts) {
    writeJSON(STORAGE.blog, posts);
  }

  function saveCurrentTournament() {
    writeJSON(STORAGE.current, state);
  }

  function saveArchive() {
    writeJSON(STORAGE.archive, archive);
  }

  function saveSession() {
    writeJSON(STORAGE.session, session);
  }

  function pushUpdate(update) {
    state.updates.push(update);
    if (state.updates.length > MAX_UPDATES_KEPT) {
      state.updates = state.updates.slice(state.updates.length - MAX_UPDATES_KEPT);
    }
  }

  // ---- Password hashing -----------------------------------------------
  // SHA-256 via SubtleCrypto when available (requires a secure context), with a
  // non-cryptographic fallback so the app still works over file:// or http://.
  async function hashPassword(password, salt) {
    const text = `${password}::${salt || ''}`;
    if (window.crypto?.subtle) {
      try {
        const buf = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      } catch {
        // fall through to fallback below
      }
    }
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
    }
    return 'fb' + hash.toString(16);
  }

  async function ensureAdmin() {
    let admin = readJSON(STORAGE.admins, null);
    if (!admin) {
      const passwordHash = await hashPassword(SAMPLE_ADMIN.password, SAMPLE_ADMIN.username);
      admin = { username: SAMPLE_ADMIN.username, passwordHash };
      writeJSON(STORAGE.admins, admin);
    } else if (admin.password && !admin.passwordHash) {
      const passwordHash = await hashPassword(admin.password, admin.username);
      admin = { username: admin.username, passwordHash };
      writeJSON(STORAGE.admins, admin);
    }
    return admin;
  }

  function getUsers() {
    return readJSON(STORAGE.users, []);
  }

  function persistUser(email, passwordHash, role) {
    const users = getUsers();
    if (!users.some(u => u.email === email && u.role === role)) {
      users.push({ email, passwordHash, role });
      writeJSON(STORAGE.users, users);
    }
  }

  function getTeamByEmail(email) {
    return state.teams.find(t => t.email === email) || null;
  }

  function getTeamById(id) {
    return state.teams.find(t => t.id === id) || null;
  }

  function getTeamByName(name) {
    return state.teams.find(t => t.name === name) || null;
  }

  function signedInTeam() {
    return session.teamEmail ? getTeamByEmail(session.teamEmail) : null;
  }

  function escapeHTML(str) {
    return String(str || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return escapeHTML(iso);
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function formatMatchWhen(dateStr, timeStr) {
    if (!dateStr && !timeStr) return '';
    if (!dateStr) return escapeHTML(timeStr);
    const d = new Date(`${dateStr}T${timeStr || '00:00'}`);
    if (isNaN(d.getTime())) return escapeHTML(dateStr);
    return timeStr
      ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
  }

  function fileToDataURL(file) {
    if (!file) return Promise.resolve('');
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = e => resolve(e.target.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  function fileToText(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = e => resolve(e.target.result);
      r.onerror = reject;
      r.readAsText(file);
    });
  }

  function checkImageSize(file, statusEl, label) {
    if (file && file.size > MAX_IMAGE_BYTES) {
      if (statusEl) {
        statusEl.textContent = `${label || 'Image'} must be smaller than 2MB.`;
        statusEl.className = 'status error';
      }
      return false;
    }
    return true;
  }

  function confirmAction(message) {
    return window.confirm(message);
  }

  function getBadgeFallback(name) {
    const letters = (name || 'T').slice(0, 2).toUpperCase();
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="100%" height="100%" rx="22" fill="#0d1628"/><text x="50%" y="54%" text-anchor="middle" font-family="Arial" font-size="34" fill="#39d98a" font-weight="700">${letters}</text></svg>`)}`;
  }

  function teamLogo(team) {
    return team?.badge || getBadgeFallback(team?.name);
  }

  function miniLogo(teamName) {
    const team = getTeamByName(teamName);
    return `<img class="mini-logo" src="${teamLogo(team)}" alt="" title="${escapeHTML(teamName || '')}">`;
  }

  // ---- Player stats (goals / cards) --------------------------------------
  function addPlayerStat(playerId, { goals = 0, yellow = 0, red = 0 } = {}) {
    if (!playerId || (!goals && !yellow && !red)) return;
    if (!state.playerStats[playerId]) state.playerStats[playerId] = { goals: 0, yellow: 0, red: 0 };
    state.playerStats[playerId].goals += goals;
    state.playerStats[playerId].yellow += yellow;
    state.playerStats[playerId].red += red;
  }

  function computeTopScorers() {
    return Object.entries(state.playerStats)
      .map(([playerId, stats]) => {
        const player = state.players.find(p => p.id === playerId);
        if (!player) return null;
        return { player, ...stats };
      })
      .filter(Boolean)
      .filter(row => row.goals > 0 || row.yellow > 0 || row.red > 0)
      .sort((a, b) => b.goals - a.goals || a.yellow - b.yellow || a.red - b.red)
      .slice(0, 15);
  }

  // Build the interactive goals/cards input rows shown inside a score modal.
  function scorerRowsHTML(players) {
    if (!players.length) return '<div class="muted-box">No eligible players found for these teams.</div>';
    return `
      <div class="scorer-head"><span>Player</span><span>Goals</span><span>Yellow</span><span>Red</span></div>
      <div class="scorer-list">
        ${players.map(p => `
          <div class="scorer-row" data-player-id="${p.id}">
            <span class="small">${escapeHTML(p.fullName)} <span class="muted">(${escapeHTML(p.teamName)})</span></span>
            <input type="number" min="0" value="0" class="scorer-goals" aria-label="Goals for ${escapeHTML(p.fullName)}">
            <input type="number" min="0" value="0" class="scorer-yellow" aria-label="Yellow cards for ${escapeHTML(p.fullName)}">
            <input type="number" min="0" value="0" class="scorer-red" aria-label="Red cards for ${escapeHTML(p.fullName)}">
          </div>
        `).join('')}
      </div>
    `;
  }

  // Reads the rows rendered by scorerRowsHTML back out of the DOM.
  function collectScorerInputs(containerEl) {
    if (!containerEl) return [];
    return Array.from(containerEl.querySelectorAll('.scorer-row')).map(row => {
      const playerId = row.getAttribute('data-player-id');
      const player = state.players.find(p => p.id === playerId);
      const goals = Number(row.querySelector('.scorer-goals')?.value || 0);
      const yellow = Number(row.querySelector('.scorer-yellow')?.value || 0);
      const red = Number(row.querySelector('.scorer-red')?.value || 0);
      return { playerId, fullName: player?.fullName || '', teamName: player?.teamName || '', goals, yellow, red };
    }).filter(row => row.goals > 0 || row.yellow > 0 || row.red > 0);
  }

  function applyScorers(scorers) {
    scorers.forEach(s => addPlayerStat(s.playerId, { goals: s.goals, yellow: s.yellow, red: s.red }));
  }

  function scorersSummaryHTML(scorers) {
    if (!scorers || !scorers.length) return '';
    return `<div class="small muted" style="margin-top:6px;">${scorers.map(s => {
      const bits = [];
      if (s.goals) bits.push(`&#9917;&times;${s.goals}`);
      if (s.yellow) bits.push(`&#128993;&times;${s.yellow}`);
      if (s.red) bits.push(`&#128308;&times;${s.red}`);
      return `${escapeHTML(s.fullName)} ${bits.join(' ')}`;
    }).join(' &middot; ')}</div>`;
  }

  // ---- Starting lineups ---------------------------------------------------
  function lineupCheckboxesHTML(players, selectedIds) {
    const selected = new Set(selectedIds || []);
    if (!players.length) return '<div class="muted-box">No players available to select.</div>';
    return `
      <div class="lineup-list">
        ${players.map(p => `
          <label class="lineup-item">
            <input type="checkbox" value="${p.id}" ${selected.has(p.id) ? 'checked' : ''}>
            <span>${escapeHTML(p.fullName)}${p.position ? ` <span class="muted small">(${escapeHTML(p.position)})</span>` : ''}</span>
          </label>
        `).join('')}
      </div>
    `;
  }

  function collectLineupSelections(containerEl) {
    if (!containerEl) return [];
    return Array.from(containerEl.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
  }

  function lineupNamesHTML(playerIds) {
    if (!playerIds || !playerIds.length) return '';
    const names = playerIds.map(id => state.players.find(p => p.id === id)?.fullName).filter(Boolean);
    if (!names.length) return '';
    return `<div class="small muted" style="margin-top:4px;">Starting XI: ${names.map(escapeHTML).join(', ')}</div>`;
  }

  // ---- Toasts -----------------------------------------------------------
  function ensureToastContainer() {
    let el = document.getElementById('toastContainer');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toastContainer';
      el.style.cssText = 'position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;';
      document.body.appendChild(el);
    }
    return el;
  }

  function showToast(message, type) {
    const container = ensureToastContainer();
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = `padding:10px 16px;border-radius:8px;color:#fff;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.35);background:${type === 'error' ? '#c0392b' : '#1e8e5a'};max-width:280px;`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.transition = 'opacity .4s';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 400);
    }, 3200);
  }

  // ---- CSV export ---------------------------------------------------------
  function toCSV(headers, rows) {
    const escapeCell = v => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.map(escapeCell).join(',')];
    rows.forEach(r => lines.push(r.map(escapeCell).join(',')));
    return lines.join('\n');
  }

  function downloadBlob(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function downloadCSV(filename, csvString) {
    downloadBlob(filename, csvString, 'text/csv;charset=utf-8;');
  }

  function exportStandingsCSVUI() {
    const groups = computeStandings();
    const rows = [];
    groups.forEach(({ division, rows: teamRows }) => {
      teamRows.forEach((r, i) => {
        rows.push([division, i + 1, r.teamName, r.played, r.won, r.drawn, r.lost, r.goalsFor, r.goalsAgainst, r.goalsFor - r.goalsAgainst, r.points]);
      });
    });
    if (!rows.length) {
      showToast('No standings to export yet.', 'error');
      return;
    }
    const csv = toCSV(['Division', 'Rank', 'Team', 'P', 'W', 'D', 'L', 'GF', 'GA', 'GD', 'Pts'], rows);
    downloadCSV(`standings-${(state.tournamentName || 'tournament').replace(/\s+/g, '_')}.csv`, csv);
  }

  function exportRosterCSVUI() {
    if (!state.players.length) {
      showToast('No players to export yet.', 'error');
      return;
    }
    const rows = state.players.map(p => [p.teamName, p.division, p.fullName, p.position || '', p.jerseyNumber, p.dob]);
    const csv = toCSV(['Team', 'Division', 'Player', 'Position', 'Jersey #', 'DOB'], rows);
    downloadCSV(`roster-${(state.tournamentName || 'tournament').replace(/\s+/g, '_')}.csv`, csv);
  }

  function printStandingsUI() {
    window.print();
  }

  // ---- Tournament PDF report -----------------------------------------------
  function tournamentChampionText(data) {
    if (data.tournamentType === 'Knockout' && data.bracket) {
      const finalRound = data.bracket.rounds?.[data.bracket.rounds.length - 1];
      const winner = finalRound?.[0]?.winnerName;
      return winner ? `Champion: ${winner}` : 'Champion: not yet decided (final not played)';
    }
    const groups = computeStandings(data.matches || []);
    if (!groups.length) return 'Champion: not yet decided (no results reported)';
    if (groups.length === 1) {
      const leader = groups[0].rows[0];
      return leader ? `Champion: ${leader.teamName}` : 'Champion: not yet decided';
    }
    return groups.map(g => `Division ${g.division} winner: ${g.rows[0] ? g.rows[0].teamName : 'TBD'}`).join('  |  ');
  }

  function buildTournamentPdf(data, filenamePrefix) {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      showToast('PDF library failed to load. Check your connection and try again.', 'error');
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();

    doc.setFontSize(20);
    doc.text(data.tournamentName || 'Tournament Report', 14, 20);
    doc.setFontSize(11);
    doc.setTextColor(90);
    doc.text(`Host: ${data.tournamentHost || 'N/A'}`, 14, 28);
    doc.text(`Format: ${data.tournamentType || 'N/A'}${data.tournamentType === 'Knockout' && data.knockoutSize ? ` (${data.knockoutSize} teams)` : ''}`, 14, 34);
    doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 40);

    doc.setTextColor(20);
    doc.setFontSize(13);
    doc.text(tournamentChampionText(data), 14, 50);

    const matches = [...(data.matches || [])].sort((a, b) => new Date(a.playedAt || 0) - new Date(b.playedAt || 0));
    const matchRows = matches.map(m => [
      formatDate(m.playedAt),
      m.division || '',
      `${m.homeTeamName} ${m.score?.home ?? ''} - ${m.score?.away ?? ''} ${m.awayTeamName}`,
      m.venue || ''
    ]);

    let nextY = 58;
    if (doc.autoTable) {
      doc.autoTable({
        startY: nextY,
        head: [['Date', 'Division', 'Result', 'Venue']],
        body: matchRows.length ? matchRows : [['No matches played yet.', '', '', '']],
        styles: { fontSize: 9 },
        headStyles: { fillColor: [30, 142, 90] }
      });
      nextY = doc.lastAutoTable.finalY + 10;
    } else {
      doc.setFontSize(10);
      matchRows.forEach(row => {
        doc.text(row.join('   '), 14, nextY);
        nextY += 6;
      });
      nextY += 6;
    }

    if (data.bracket) {
      doc.setFontSize(13);
      doc.text('Knockout Bracket', 14, nextY);
      nextY += 6;
      const bracketRows = [];
      data.bracket.rounds.forEach((round, ri) => {
        round.forEach(m => {
          bracketRows.push([
            `Round ${ri + 1}`,
            m.teamAName || 'TBD',
            m.scoreA ?? '',
            m.teamBName || 'TBD',
            m.scoreB ?? '',
            m.winnerName || ''
          ]);
        });
      });
      if (doc.autoTable) {
        doc.autoTable({
          startY: nextY,
          head: [['Round', 'Team A', 'Score', 'Team B', 'Score', 'Winner']],
          body: bracketRows,
          styles: { fontSize: 9 },
          headStyles: { fillColor: [30, 142, 90] }
        });
      }
    }

    doc.save(`${filenamePrefix || 'tournament'}-report.pdf`);
  }

  function downloadCurrentTournamentPdfUI() {
    buildTournamentPdf(state, (state.tournamentName || 'tournament').replace(/\s+/g, '_'));
  }

  function downloadArchivedTournamentPdfUI(archiveId) {
    const data = archive.find(a => a.id === archiveId);
    if (!data) return;
    buildTournamentPdf(data, (data.tournamentName || 'tournament').replace(/\s+/g, '_'));
  }

  // ---- Data backup / restore ----------------------------------------------
  function exportAllDataUI() {
    const payload = {
      exportedAt: new Date().toISOString(),
      version: 1,
      current: state,
      archive,
      blog: loadBlog(),
      users: getUsers(),
      admin: readJSON(STORAGE.admins, null)
    };
    downloadBlob(
      `soccer-tournament-backup-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(payload, null, 2),
      'application/json'
    );
    showToast('Backup downloaded.', 'ok');
  }

  async function importAllDataUI(file) {
    const status = document.getElementById('backupStatus');
    if (!file) return;
    if (!confirmAction('Importing a backup replaces all current teams, players, matches, and posts. Continue?')) return;

    try {
      const text = await fileToText(file);
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || !data.current) {
        throw new Error('This file does not look like a valid backup.');
      }

      state = { ...defaultState(), ...data.current };
      if (!state.playerStats) state.playerStats = {};
      archive = Array.isArray(data.archive) ? data.archive : [];
      saveCurrentTournament();
      saveArchive();
      if (Array.isArray(data.blog)) saveBlog(data.blog);
      if (Array.isArray(data.users)) writeJSON(STORAGE.users, data.users);
      if (data.admin) writeJSON(STORAGE.admins, data.admin);

      if (status) { status.textContent = 'Backup restored successfully.'; status.className = 'status ok'; }
      showToast('Backup restored.', 'ok');
      renderAdmin();
    } catch (err) {
      if (status) { status.textContent = `Import failed: ${err.message || 'invalid file.'}`; status.className = 'status error'; }
      showToast('Import failed.', 'error');
    }
  }

  function pageShell(active, inner) {
    const nav = [
      ['home', 'Home', 'index.html'],
      ['manager', 'Manager', 'manager.html'],
      ['blog', 'Blog', 'blog.html'],
      ['games', 'Upcoming Matches', 'games.html'],
      ['standings', 'Standings', 'standings.html'],
      ['players', 'Players', 'players.html'],
      ['history', 'History', 'history.html'],
      ['admin', 'Admin', 'admin.html']
    ].map(([key, text, href]) => `<a data-nav="${key}" href="${href}">${text}</a>`).join('');

    const tabs = [
      ['home', '&#127968;', 'Home', 'index.html'],
      ['manager', '&#128203;', 'Manager', 'manager.html'],
      ['games', '&#9917;', 'Matches', 'games.html'],
      ['standings', '&#127942;', 'Table', 'standings.html']
    ].map(([key, icon, label, href]) => `<a class="tab-item" data-nav="${key}" href="${href}"><span class="tab-icon">${icon}</span><span class="tab-label">${label}</span></a>`).join('');

    return `<header class="site-header no-print"><div class="header-inner"><a class="brand" href="index.html"><div class="brand-badge"></div><div><h1>Soccer Tournament</h1><small>Multi-page manager</small></div></a><button class="nav-toggle" onclick="App.toggleNav()">&#9776;</button><nav class="nav" id="mainNav">${nav}</nav>
</div>
</header>
<main class="container">${inner}</main><footer class="footer no-print">&copy; ${new Date().getFullYear()} ${escapeHTML(state.tournamentName || 'Soccer Tournament')}</footer>
<nav class="bottom-tabbar no-print">
${tabs}
<button class="tab-item tab-menu-btn" onclick="App.toggleNav()"><span class="tab-icon">&#9776;</span><span class="tab-label">More</span></button>
</nav>`;
  }

  function toggleNav() {
    document.getElementById('mainNav')?.classList.toggle('open');
  }

  function highlightNav() {
    document.querySelectorAll('[data-nav]').forEach(a => {
      a.classList.toggle('active', a.getAttribute('data-nav') === currentPage);
    });
  }

  function renderPage() {
    if (currentPage === 'home') renderHome();
    if (currentPage === 'manager') renderManagerLandingOrDashboard();
    if (currentPage === 'blog') renderBlog();
    if (currentPage === 'games') renderGames();
    if (currentPage === 'standings') renderStandings();
    if (currentPage === 'players') renderPlayers();
    if (currentPage === 'history') renderHistory();
    if (currentPage === 'admin') renderAdmin();
  }

  function tournamentSummaryCard() {
    if (!state.tournamentName) {
      return `<div class="muted-box">No tournament has been created yet. Check back soon.</div>`;
    }
    return `<div class="card"><h3>${escapeHTML(state.tournamentName)}</h3>
<div class="small">Hosted by ${escapeHTML(state.tournamentNumber || '')}</div>
<div class="small">Format: ${state.tournamentType === 'Knockout' && state.knockoutSize ? `${state.knockoutSize} teams` : ''}</div>${state.tournamentInfo ? `<p>${escapeHTML(state.tournamentInfo)}</p>` : ''}</div>`;
  }

  function hostProfileCardHTML() {
    if (!state.hostPhoto && !state.hostBio) return '';
    return `<div class="card" style="margin-top:16px;">
<h3>Meet Your Host</h3>
<div class="team-chip">
${state.hostPhoto ? `<img src="${state.hostPhoto}" alt="Tournament host" style="width:64px;height:64px;">` : ''}
<div>
<strong>${escapeHTML(state.tournamentHost || 'Tournament Host')}</strong>
${state.hostBio ? `<p style="margin-top:6px;">${escapeHTML(state.hostBio)}</p>` : ''}
</div>
</div>
</div>`;
  }

  function renderHome() {
    const recentUpdates = [...state.updates].reverse().slice(0, 6);
    document.getElementById('app').innerHTML = pageShell('home', `<section class="photo-hero">
<img class="photo-hero-img" src="images/hero-photo.jpg" alt="A player dribbling a soccer ball on the pitch" loading="lazy">
<div class="photo-hero-overlay"></div>
<div class="photo-hero-content">
<h2>Every Match Builds<br>The Table</h2>
<p>Register your team, schedule challenges, and track standings &mdash; all in one hub.</p>
<div class="btns">
<a class="btn-primary btn-link" href="manager.html">Register a Team</a>
<a class="btn-secondary btn-link btn-ghost" href="standings.html">View Standings</a>
</div>
</div>
</section>
<section class="grid cols-2" style="margin-top:16px;">
<div>
<h3>Current Tournament</h3>${tournamentSummaryCard()}
${hostProfileCardHTML()}
<div class="stat-row" style="margin-top:12px;">
<div class="stat"><strong>${state.players.length}</strong><span>Players</span></div>
<div class="stat"><strong>${state.teams.length}</strong><span>Teams</span></div>
</div>
</div>
<div>
<h3>Recent Activity</h3>
${recentUpdates.length ? recentUpdates.map(u => `<div class="update-row"><div>${escapeHTML(u.text)}</div><div class="small muted">${formatDate(u.createdAt)}</div></div>`).join('') : '<div class="muted-box">No activity yet.</div>'}
</div>
</div>
</section>
`);
  }

  function renderManagerLandingOrDashboard() {
    if (session.teamEmail) renderManagerDashboard();
    else renderManagerLanding();
  }

  function forgotPasswordModalHTML() {
    return `<div class="modal-backdrop" id="forgotPasswordBackdrop" style="display:none;">
<div class="modal">
<h3 id="forgotPasswordTitle">Reset Password</h3>
<div class="form-grid">
<div id="forgotEmailWrap"><input id="forgotEmail" type="email" placeholder="Account email"></div>
<input id="forgotNewPassword" type="password" placeholder="New password">
<input id="forgotConfirmPassword" type="password" placeholder="Confirm new password">
<div class="btns">
<button class="btn-primary" onclick="App.ui.submitPasswordReset()">Update Password</button>
<button class="btn-secondary" onclick="App.ui.closeForgotPassword()">Close</button>
</div>
<div class="status" id="forgotPasswordStatus"></div>
</div>
</div>
</div>`;
  }

  function openForgotPasswordUI(kind) {
    forgotPasswordKind = kind;
    const backdrop = document.getElementById('forgotPasswordBackdrop');
    if (backdrop) backdrop.style.display = 'flex';
    const title = document.getElementById('forgotPasswordTitle');
    if (title) title.textContent = kind === 'admin' ? 'Reset Admin Password' : 'Reset Team Password';
    const emailWrap = document.getElementById('forgotEmailWrap');
    if (emailWrap) emailWrap.style.display = kind === 'admin' ? 'none' : 'block';
    const status = document.getElementById('forgotPasswordStatus');
    if (status) { status.textContent = ''; status.className = 'status'; }
    const newPw = document.getElementById('forgotNewPassword');
    const confirmPw = document.getElementById('forgotConfirmPassword');
    if (newPw) newPw.value = '';
    if (confirmPw) confirmPw.value = '';
  }

  function closeForgotPasswordUI() {
    const backdrop = document.getElementById('forgotPasswordBackdrop');
    if (backdrop) backdrop.style.display = 'none';
  }

  async function submitPasswordResetUI() {
    const status = document.getElementById('forgotPasswordStatus');
    const newPassword = document.getElementById('forgotNewPassword')?.value.trim();
    const confirmPassword = document.getElementById('forgotConfirmPassword')?.value.trim();

    if (!newPassword || newPassword.length < 6) {
      if (status) { status.textContent = 'Password must be at least 6 characters.'; status.className = 'status error'; }
      return;
    }
    if (newPassword !== confirmPassword) {
      if (status) { status.textContent = 'Passwords do not match.'; status.className = 'status error'; }
      return;
    }

    if (forgotPasswordKind === 'admin') {
      const admin = await ensureAdmin();
      admin.passwordHash = await hashPassword(newPassword, admin.username);
      writeJSON(STORAGE.admins, admin);
      if (status) { status.textContent = 'Admin password updated. You can log in now.'; status.className = 'status ok'; }
    } else {
      const email = document.getElementById('forgotEmail')?.value.trim();
      const users = getUsers();
      const user = users.find(u => u.email === email && u.role === 'team');
      if (!user) {
        if (status) { status.textContent = 'No team account found for that email.'; status.className = 'status error'; }
        return;
      }
      user.passwordHash = await hashPassword(newPassword, email);
      writeJSON(STORAGE.users, users);
      if (status) { status.textContent = 'Password updated. You can log in now.'; status.className = 'status ok'; }
    }
    showToast('Password updated.', 'ok');
  }

  async function teamRegisterUI() {
    const name = document.getElementById('signupTeamName')?.value.trim();
    const email = document.getElementById('signupTeamEmail')?.value.trim();
    const password = document.getElementById('signupTeamPassword')?.value.trim();
    const contact = document.getElementById('signupTeamContact')?.value.trim();
    const logoFile = document.getElementById('signupTeamLogo')?.files?.[0];
    const coachName = document.getElementById('signupCoachName')?.value.trim();
    const coachDob = document.getElementById('signupCoachDob')?.value;
    const coachPhotoFile = document.getElementById('signupCoachPhoto')?.files?.[0];
    const divisionSelect = document.getElementById('signupTeamDivision');
    const divisions = Array.from(divisionSelect?.selectedOptions || []).map(o => o.value).filter(Boolean);
    const status = document.getElementById('teamSignupStatus');

    if (!name || !email || !password || !contact || !logoFile || !coachName || !coachDob || !coachPhotoFile || !divisions.length) {
      if (status) {
        status.textContent = 'Complete all team, coach, logo, and division fields.';
        status.className = 'status error';
      }
      return;
    }

    if (!EMAIL_PATTERN.test(email)) {
      if (status) {
        status.textContent = 'Enter a valid email address.';
        status.className = 'status error';
      }
      return;
    }

    if (password.length < 6) {
      if (status) {
        status.textContent = 'Password must be at least 6 characters.';
        status.className = 'status error';
      }
      return;
    }

    if (getUsers().some(u => u.email === email && u.role === 'team')) {
      if (status) {
        status.textContent = 'This team email is already registered.';
        status.className = 'status error';
      }
      return;
    }

    if (!checkImageSize(logoFile, status, 'Team logo') || !checkImageSize(coachPhotoFile, status, 'Coach photo')) return;

    const [badge, coachPhoto] = await Promise.all([fileToDataURL(logoFile), fileToDataURL(coachPhotoFile)]);
    const passwordHash = await hashPassword(password, email);

    state.teams.push({
      id: uid(),
      name,
      email,
      contact,
      badge,
      coachName,
      coachPhoto,
      coachDob,
      divisions,
      createdAt: new Date().toISOString()
    });
    persistUser(email, passwordHash, 'team');
    session.teamEmail = email;
    saveCurrentTournament();
    saveSession();
    pushUpdate({
      id: uid(),
      type: 'team_signup',
      teamName: name,
      teamEmail: email,
      badge,
      coachName,
      divisions,
      text: `New team ${name} joined.`,
      createdAt: new Date().toISOString()
    });
    saveCurrentTournament();
    window.location.href = 'manager.html';
  }

  async function teamLoginUI() {
    const email = document.getElementById('loginTeamEmail')?.value.trim();
    const password = document.getElementById('loginTeamPassword')?.value.trim();
    const status = document.getElementById('teamLoginStatus') || document.getElementById('teamAuthStatus');

    if (!email || !password) {
      if (status) { status.textContent = 'Enter email and password.'; status.className = 'status error'; }
      return;
    }

    const passwordHash = await hashPassword(password, email);
    const user = getUsers().find(u => u.email === email && u.passwordHash === passwordHash && u.role === 'team');

    if (!user) {
      if (status) {
        status.textContent = 'Invalid team login.';
        status.className = 'status error';
      }
      return;
    }

    session.teamEmail = email;
    saveSession();

    if (status) {
      status.textContent = 'Login successful.';
      status.className = 'status ok';
    }

    window.location.href = 'manager.html';
  }

  function teamSignOutUI() {
    session.teamEmail = '';
    saveSession();
    window.location.href = 'index.html';
  }

  function renderManagerLanding() {
    document.getElementById('app').innerHTML = pageShell('manager', `<section class="hero"><div><h2>Team Manager</h2><p>Create your team profile, coach profile, and divisions.</p></div></section>
<section class="grid cols-2" style="margin-top:16px;">
<div class="card">
<h3>Team Profile</h3>
<div class="form-grid">
<input id="signupTeamName" placeholder="Team name">
<input id="signupTeamEmail" type="email" placeholder="Team email">
<input id="signupTeamContact" placeholder="Team contact">
<input id="signupTeamLogo" type="file" accept="image/*">
<input id="signupCoachName" placeholder="Coach name">
<input id="signupCoachDob" type="date">
<input id="signupCoachPhoto" type="file" accept="image/*">
<select id="signupTeamDivision" multiple size="6">
<option value="11">Division 11</option><option value="13">Division 13</option><option value="15">Division 15</option><option value="17">Division 17</option><option value="19">Division 19</option><option value="21">Division 21</option>
</select>
<input id="signupTeamPassword" type="password" placeholder="Password (min 6 characters)">
<button class="btn-primary" onclick="App.ui.teamRegister()">Save Team</button>
<div class="status" id="teamSignupStatus"></div>
</div>
</div>
<div class="card">
<h3>Log In</h3>
<div class="form-grid">
<input id="loginTeamEmail" type="email" placeholder="Team email">
<input id="loginTeamPassword" type="password" placeholder="Password">
<button class="btn-primary" onclick="App.ui.teamLogin()">Log In</button>
<button class="btn-secondary" onclick="App.ui.teamSignOut()">Log Out</button>
<a href="#" class="small" onclick="App.ui.openForgotPassword('team');return false;">Forgot password?</a>
<div class="status" id="teamLoginStatus"></div>
</div>
</div>
</section>${forgotPasswordModalHTML()}`);
  }

  function renderManagerDashboard() {
    const team = signedInTeam();
    document.getElementById('app').innerHTML = pageShell('manager', `<section class="hero">
<div>
<h2>${escapeHTML(team?.name || 'Team')} Manager Dashboard</h2>
<p>Manage players, divisions, and challenges.</p>
</div>
</section>
<section class="card" style="margin-top:16px;">
<div class="team-chip">
<img src="${teamLogo(team)}" alt="team logo">
<div>
<strong>${escapeHTML(team?.name || '')}</strong>
<div class="small">Contact: ${escapeHTML(team?.contact || '')}</div>
<div class="small">Coach: ${escapeHTML(team?.coachName || '')}</div>
<div class="small">Divisions: ${(team?.divisions || []).join(', ')}</div>
</div>
</div>
</section>
<section class="grid cols-2" style="margin-top:16px;">
${renderEditTeamProfileForm(team)}
<div class="card">
<h3>Add Division</h3>
<div class="form-grid">
<input id="newDivisionInput" placeholder="Division name or number">
<button class="btn-primary" onclick="App.ui.addDivision()">Add Division</button>
<div class="status" id="divisionStatus"></div>
</div>
</div>
</section>
<section class="card" style="margin-top:16px;">
<h3>Challenge Another Team</h3>
<div class="form-grid">
<select id="challengeTeamSelect" onchange="App.ui.loadChallengeDivisions()">
<option value="">Select team</option>
</select>
<select id="challengeDivisionSelect">
<option value="">Select division</option>
</select>
<div class="grid cols-2">
<input id="challengeDate" type="date" placeholder="Match date">
<input id="challengeTime" type="time" placeholder="Kickoff time">
</div>
<input id="challengeVenue" placeholder="Venue (e.g. Riverside Field 2)">
<textarea id="challengeMessage" placeholder="Write your challenge message"></textarea>
<button class="btn-primary" onclick="App.ui.challengeTeam()">Send Challenge</button>
<div class="status" id="challengeStatus"></div>
</div>
</section>
<section class="card" style="margin-top:16px;"><h3>Add / Remove Players</h3><div id="managerRoster"></div></section>
<section class="card" style="margin-top:16px;">
<div class="row-between">
<h3>Incoming Challenges</h3>
<select id="challengeFilterSelect" onchange="App.ui.setChallengeFilter(this.value)">
<option value="all">All</option>
<option value="pending">Pending</option>
<option value="confirmed">Confirmed</option>
<option value="completed">Completed</option>
<option value="rejected">Rejected</option>
<option value="cancelled">Cancelled</option>
</select>
</div>
<div id="incomingChallenges"></div>
</section>
<section class="card" style="margin-top:16px;">
<h3>Sent Challenges</h3>
<div id="sentChallenges"></div>
</section>
<section class="card" style="margin-top:16px;"><button class="btn-secondary" onclick="App.ui.teamSignOut()">Log Out</button></section>

<div class="modal-backdrop" id="scoreModalBackdrop" style="display:none;">
<div class="modal modal-wide">
<h3>Report Score</h3>
<div class="form-grid">
<input id="scoreHome" type="number" min="0" placeholder="Home team goals">
<input id="scoreAway" type="number" min="0" placeholder="Away team goals">
<div id="scoreScorersList"></div>
<div class="btns">
<button class="btn-primary" onclick="App.ui.saveChallengeScore()">Save Score</button>
<button class="btn-secondary" onclick="App.ui.closeScoreModal()">Cancel</button>
</div>
<div class="status" id="scoreStatus"></div>
</div>
</div>
</div>

<div class="modal-backdrop" id="lineupModalBackdrop" style="display:none;">
<div class="modal modal-wide">
<h3>Starting Lineup</h3>
<p class="small">Select up to ${MAX_LINEUP_SIZE} players from your division roster who will start this match.</p>
<div class="form-grid">
<div id="lineupCheckboxes"></div>
<div class="btns">
<button class="btn-primary" onclick="App.ui.saveLineup()">Save Lineup</button>
<button class="btn-secondary" onclick="App.ui.closeLineupModal()">Cancel</button>
</div>
<div class="status" id="lineupStatus"></div>
</div>
</div>
</div>

<div class="modal-backdrop" id="editPlayerModalBackdrop" style="display:none;">
<div class="modal">
<h3>Edit Player</h3>
<div class="form-grid">
<input id="editPlayerName" placeholder="Player full name">
<input id="editPlayerDob" type="date">
<input id="editPlayerJersey" type="number" placeholder="Jersey number">
<select id="editPlayerPosition">
<option value="">Select position</option>
${POSITIONS.map(pos => `<option value="${pos}">${pos}</option>`).join('')}
</select>
<input id="editPlayerPhoto" type="file" accept="image/*">
<div class="btns">
<button class="btn-primary" onclick="App.ui.saveEditPlayer()">Save Changes</button>
<button class="btn-secondary" onclick="App.ui.closeEditPlayerModal()">Cancel</button>
</div>
<div class="status" id="editPlayerStatus"></div>
</div>
</div>
</div>
`);
    fillChallengeTeams();
    renderManagerRoster();
    renderIncomingChallenges();
    renderSentChallenges();
    const filterSelect = document.getElementById('challengeFilterSelect');
    if (filterSelect) filterSelect.value = challengeStatusFilter;
  }

  function renderEditTeamProfileForm(team) {
    if (!team) return '<div class="card"><div class="muted-box">Log in to edit your team profile.</div></div>';
    return `<div class="card"><h3>Edit Team Profile</h3><div class="form-grid">
<input id="editTeamName" placeholder="Team name" value="${escapeHTML(team.name || '')}">
<input id="editTeamContact" placeholder="Team contact" value="${escapeHTML(team.contact || '')}">
<input id="editCoachName" placeholder="Coach name" value="${escapeHTML(team.coachName || '')}">
<input id="editCoachDob" type="date" value="${escapeHTML(team.coachDob || '')}">
<input id="editTeamLogo" type="file" accept="image/*">
<input id="editCoachPhoto" type="file" accept="image/*">
<button class="btn-primary" onclick="App.ui.saveTeamProfile()">Save Changes</button>
<div class="status" id="editTeamStatus"></div></div></div>`;
  }

  async function saveTeamProfileUI() {
    const team = signedInTeam();
    if (!team) return;
    const status = document.getElementById('editTeamStatus');
    const name = document.getElementById('editTeamName')?.value.trim();
    const contact = document.getElementById('editTeamContact')?.value.trim();
    const coachName = document.getElementById('editCoachName')?.value.trim();
    const coachDob = document.getElementById('editCoachDob')?.value;
    const logoFile = document.getElementById('editTeamLogo')?.files?.[0];
    const coachPhotoFile = document.getElementById('editCoachPhoto')?.files?.[0];

    if (!name || !contact || !coachName || !coachDob) {
      if (status) { status.textContent = 'Name, contact, coach name, and DOB are required.'; status.className = 'status error'; }
      return;
    }
    if (!checkImageSize(logoFile, status, 'Logo') || !checkImageSize(coachPhotoFile, status, 'Coach photo')) return;

    if (logoFile) team.badge = await fileToDataURL(logoFile);
    if (coachPhotoFile) team.coachPhoto = await fileToDataURL(coachPhotoFile);
    team.name = name;
    team.contact = contact;
    team.coachName = coachName;
    team.coachDob = coachDob;

    // keep denormalized team-name copies in sync
    state.players.forEach(p => { if (p.teamEmail === team.email) p.teamName = name; });

    saveCurrentTournament();
    showToast('Team profile updated.', 'ok');
    renderManagerDashboard();
  }

  function ensureDivision(team, division) {
    if (!team.divisions.includes(division)) team.divisions.push(division);
  }

  function addDivisionUI() {
    const team = signedInTeam();
    if (!team) return;
    const value = document.getElementById('newDivisionInput')?.value.trim();
    const status = document.getElementById('divisionStatus');

    if (!value) {
      if (status) {
        status.textContent = 'Enter a division first.';
        status.className = 'status error';
      }
      return;
    }

    ensureDivision(team, value);
    saveCurrentTournament();

    if (status) {
      status.textContent = `Division ${value} added.`;
      status.className = 'status ok';
    }
    renderManagerDashboard();
  }

  function renderManagerRoster() {
    const team = signedInTeam();
    const holder = document.getElementById('managerRoster');
    if (!holder) return;

    if (!team) {
      holder.innerHTML = `<div class="muted-box">Please log in first.</div>`;
      return;
    }

    holder.innerHTML = (team.divisions || []).map(division => {
      const players = state.players.filter(p => p.teamEmail === team.email && String(p.division) === String(division));
      return `<div class="card" style="background:#0d1628;margin-bottom:14px;">
      <h4>Division ${escapeHTML(division)} <span class="small">(${players.length}/${MAX_PLAYERS_PER_DIVISION})</span></h4>
      <div>${players.length ? players.map(p => `
      <div class="team-chip" style="margin-top:10px;">
      <strong>${escapeHTML(p.fullName)}</strong>
      <div class="small">${p.position ? escapeHTML(p.position) + ' &middot; ' : ''}Jersey: ${escapeHTML(p.jerseyNumber)} | DOB: ${escapeHTML(p.dob)}</div>
      <button class="btn-secondary" onclick="App.ui.openEditPlayerModal('${p.id}')">Remove</button>
      </div>
      `).join('') : '<div class="muted-box">No players yet.</div>'}</div>
      <div class="form-grid" style="margin-top:12px;"><input id="playerFullName_${division}" placeholder="Player full name">
      <input id="playerDob_${division}" type="date" placeholder="Date of birth"><input id="playerJersey_${division}" type="number" placeholder="Jersey number">
      <select id="playerPosition_${division}"><option value="">Select position</option>${POSITIONS.map(pos => `<option value="${pos}">${pos}</option>`).join('')}</select>
      <input id="playerPhoto_${division}" type="file" accept="image/*"><button class="btn-primary" onclick="App.ui.addPlayerToDivision('${division}')">Add Player</button>
      </div>
      </div>`;
    }).join('');
  }

  function addPlayerToDivisionUI(division) {
    const team = signedInTeam();
    if (!team) return;

    const divisionPlayers = state.players.filter(
      p => p.teamEmail === team.email && String(p.division) === String(division)
    );

    const status = document.getElementById('challengeStatus');
    if (divisionPlayers.length >= MAX_PLAYERS_PER_DIVISION) {
      if (status) {
        status.textContent = `Division ${division} already has 32 players.`;
        status.className = 'status error';
      }
      return;
    }

    const fullName = document.getElementById(`playerFullName_${division}`)?.value.trim();
    const dob = document.getElementById(`playerDob_${division}`)?.value;
    const jerseyNumber = document.getElementById(`playerJersey_${division}`)?.value.trim();
    const position = document.getElementById(`playerPosition_${division}`)?.value;
    const photoFile = document.getElementById(`playerPhoto_${division}`)?.files?.[0];

    if (!fullName || !dob || !jerseyNumber || !position || !photoFile) {
      if (status) {
        status.textContent = 'Complete all player fields, including position.';
        status.className = 'status error';
      }
      return;
    }

    if (divisionPlayers.some(p => String(p.jerseyNumber) === String(jerseyNumber))) {
      if (status) {
        status.textContent = `Jersey number ${jerseyNumber} is already used in this division.`;
        status.className = 'status error';
      }
      return;
    }

    if (!checkImageSize(photoFile, status, 'Player photo')) return;

    fileToDataURL(photoFile).then(photo => {
      state.players.push({
        id: uid(),
        teamEmail: team.email,
        teamName: team.name,
        division: String(division),
        fullName,
        photo,
        jerseyNumber,
        position,
        dob,
        createdAt: new Date().toISOString()
      });

      pushUpdate({
        id: uid(),
        type: 'player_add',
        teamEmail: team.email,
        teamName: team.name,
        text: `${fullName} added to division ${division}.`,
        createdAt: new Date().toISOString()
      });

      saveCurrentTournament();
      showToast(`${fullName} added.`, 'ok');
      renderManagerDashboard();
    });
  }

  function removePlayerUI(playerId) {
    const idx = state.players.findIndex(p => p.id === playerId);
    if (idx === -1) return;
    const player = state.players[idx];
    if (!confirmAction(`Remove ${player.fullName} from the roster?`)) return;

    state.players.splice(idx, 1);
    pushUpdate({
      id: uid(),
      type: 'player_remove',
      teamEmail: player.teamEmail,
      teamName: player.teamName,
      text: `${player.fullName} removed from division ${player.division}.`,
      createdAt: new Date().toISOString()
    });

    saveCurrentTournament();
    showToast('Player removed.', 'ok');
    renderManagerDashboard();
  }

  function openEditPlayerModalUI(playerId) {
    editingPlayerId = playerId;
    const p = state.players.find(pl => pl.id === playerId);
    if (!p) return;
    const nameEl = document.getElementById('editPlayerName');
    const dobEl = document.getElementById('editPlayerDob');
    const jerseyEl = document.getElementById('editPlayerJersey');
    const positionEl = document.getElementById('editPlayerPosition');
    if (nameEl) nameEl.value = p.fullName;
    if (dobEl) dobEl.value = p.dob;
    if (jerseyEl) jerseyEl.value = p.jerseyNumber;
    if (positionEl) positionEl.value = p.position || '';
    const backdrop = document.getElementById('editPlayerModalBackdrop');
    if (backdrop) backdrop.style.display = 'flex';
    const status = document.getElementById('editPlayerStatus');
    if (status) { status.textContent = ''; status.className = 'status'; }
  }

  function closeEditPlayerModalUI() {
    editingPlayerId = null;
    const backdrop = document.getElementById('editPlayerModalBackdrop');
    if (backdrop) backdrop.style.display = 'none';
  }

  async function saveEditPlayerUI() {
    const p = state.players.find(pl => pl.id === editingPlayerId);
    const status = document.getElementById('editPlayerStatus');
    if (!p) return;

    const fullName = document.getElementById('editPlayerName')?.value.trim();
    const dob = document.getElementById('editPlayerDob')?.value;
    const jerseyNumber = document.getElementById('editPlayerJersey')?.value.trim();
    const position = document.getElementById('editPlayerPosition')?.value;
    const photoFile = document.getElementById('editPlayerPhoto')?.files?.[0];

    if (!fullName || !dob || !jerseyNumber) {
      if (status) { status.textContent = 'Name, DOB, and jersey number are required.'; status.className = 'status error'; }
      return;
    }

    const duplicate = state.players.some(pl =>
      pl.id !== p.id && pl.teamEmail === p.teamEmail &&
      String(pl.division) === String(p.division) &&
      String(pl.jerseyNumber) === String(jerseyNumber)
    );
    if (duplicate) {
      if (status) { status.textContent = `Jersey number ${jerseyNumber} is already used in this division.`; status.className = 'status error'; }
      return;
    }

    if (!checkImageSize(photoFile, status, 'Photo')) return;

    if (photoFile) p.photo = await fileToDataURL(photoFile);
    p.fullName = fullName;
    p.dob = dob;
    p.jerseyNumber = jerseyNumber;
    if (position) p.position = position;

    saveCurrentTournament();
    closeEditPlayerModalUI();
    showToast('Player updated.', 'ok');
    renderManagerDashboard();
  }

  function fillChallengeTeams() {
    const select = document.getElementById('challengeTeamSelect');
    if (!select) return;
    const team = signedInTeam();
    const options = state.teams
      .filter(t => t.email !== team?.email)
      .map(t => `<option value="${t.email}">${escapeHTML(t.name)}</option>`)
      .join('');
    select.innerHTML = `<option value="">Select team</option>${options}`;
  }

  function loadChallengeDivisionsUI() {
    const targetEmail = document.getElementById('challengeTeamSelect')?.value;
    const divisionSelect = document.getElementById('challengeDivisionSelect');
    if (!divisionSelect) return;

    const targetTeam = state.teams.find(t => t.email === targetEmail);
    const divisions = targetTeam?.divisions || [];

    divisionSelect.innerHTML = `<option value="">Select division</option>${divisions.map(d => `<option value="${escapeHTML(d)}">Division ${escapeHTML(d)}</option>`).join('')}`;
  }

  function sendChallengeUI() {
    const team = signedInTeam();
    const targetEmail = document.getElementById('challengeTeamSelect')?.value;
    const division = document.getElementById('challengeDivisionSelect')?.value;
    const message = document.getElementById('challengeMessage')?.value.trim();
    const matchDate = document.getElementById('challengeDate')?.value || '';
    const matchTime = document.getElementById('challengeTime')?.value || '';
    const venue = document.getElementById('challengeVenue')?.value.trim() || '';
    const status = document.getElementById('challengeStatus');

    if (!team || !targetEmail || !division || !message) {
      if (status) {
        status.textContent = 'Select a team, division, and write a message.';
        status.className = 'status error';
      }
      return;
    }

    const targetTeam = getTeamByEmail(targetEmail);
    if (!targetTeam || !targetTeam.divisions.includes(division)) {
      if (status) {
        status.textContent = 'That team does not have this division.';
        status.className = 'status error';
      }
      return;
    }

    state.challenges.push({
      id: uid(),
      fromTeamEmail: team.email,
      fromTeamName: team.name,
      toTeamEmail: targetEmail,
      toTeamName: targetTeam.name,
      division,
      message,
      matchDate,
      matchTime,
      venue,
      status: 'pending',
      score: null,
      createdAt: new Date().toISOString(),
      respondedAt: ''
    });
    saveCurrentTournament();

    if (status) {
      status.textContent = 'Challenge sent.';
      status.className = 'status ok';
    }
    showToast('Challenge sent.', 'ok');

    renderManagerDashboard();
  }

  function setChallengeFilterUI(value) {
    challengeStatusFilter = value || 'all';
    renderIncomingChallenges();
  }

  function challengeWhenVenueHTML(ch) {
    const when = formatMatchWhen(ch.matchDate, ch.matchTime);
    const bits = [];
    if (when) bits.push(when);
    if (ch.venue) bits.push(escapeHTML(ch.venue));
    return bits.length ? `<div class="small muted">&#128197; ${bits.join(' &middot; ')}</div>` : '';
  }

  function renderIncomingChallenges() {
    const holder = document.getElementById('incomingChallenges');
    if (!holder) return;
    const team = signedInTeam();

    if (!team) {
      holder.innerHTML = '<div class="muted-box">Log in to see challenges.</div>';
      return;
    }

    let incoming = state.challenges.filter(c => c.toTeamEmail === team.email);
    if (challengeStatusFilter !== 'all') {
      incoming = incoming.filter(c => c.status === challengeStatusFilter);
    }

    holder.innerHTML = incoming.length ? incoming.map(ch => `
      <div class="card" style="background:#0d1628;margin-bottom:10px;">
        <div><strong>From:</strong> ${miniLogo(ch.fromTeamName)}${escapeHTML(ch.fromTeamName)}</div>
        <div><strong>Division:</strong> ${escapeHTML(ch.division)}</div>
        <div><strong>Message:</strong> ${escapeHTML(ch.message)}</div>
        <div><strong>Status:</strong> ${escapeHTML(ch.status)}</div>
        ${challengeWhenVenueHTML(ch)}
        ${ch.score ? `<div><strong>Score:</strong> ${ch.score.home} - ${ch.score.away}</div>` : ''}
        ${ch.status === 'pending' ? `
          <div class="btns" style="margin-top:10px;">
            <button class="btn-primary" onclick="App.ui.respondChallenge('${ch.id}','confirmed')">Accept</button>
            <button class="btn-secondary" onclick="App.ui.respondChallenge('${ch.id}','rejected')">Reject</button>
          </div>
        ` : ''}
        ${ch.status === 'confirmed' ? `
          <div class="small muted" style="margin-top:8px;">${(ch.lineups || {})[team.email] ? '&#9989; Your lineup is set' : '&#9888; Your lineup is not set yet'}</div>
          <div class="btns" style="margin-top:10px;">
            <button class="btn-secondary" onclick="App.ui.openLineupModal('${ch.id}')">${(ch.lineups || {})[team.email] ? 'Edit Lineup' : 'Set Lineup'}</button>
            <button class="btn-primary" onclick="App.ui.openScoreModal('${ch.id}')">Report Score</button>
            <button class="btn-secondary" onclick="App.ui.cancelChallenge('${ch.id}')">Cancel Match</button>
          </div>
        ` : ''}
        ${ch.status === 'completed' ? '<div class="status ok" style="margin-top:10px;">Score already reported.</div>' : ''}
      </div>
    `).join('') : '<div class="muted-box">No challenges in this view.</div>';
  }

  function renderSentChallenges() {
    const holder = document.getElementById('sentChallenges');
    if (!holder) return;
    const team = signedInTeam();
    if (!team) {
      holder.innerHTML = '<div class="muted-box">Log in to see challenges.</div>';
      return;
    }

    const sent = state.challenges.filter(c => c.fromTeamEmail === team.email);
    holder.innerHTML = sent.length ? sent.map(ch => `
      <div class="card" style="background:#0d1628;margin-bottom:10px;">
        <div><strong>To:</strong> ${miniLogo(ch.toTeamName)}${escapeHTML(ch.toTeamName)}</div>
        <div><strong>Division:</strong> ${escapeHTML(ch.division)}</div>
        <div><strong>Status:</strong> ${escapeHTML(ch.status)}</div>
        ${challengeWhenVenueHTML(ch)}
        ${ch.score ? `<div><strong>Score:</strong> ${ch.score.home} - ${ch.score.away}</div>` : ''}
        ${ch.status === 'confirmed' ? `<div class="small muted" style="margin-top:8px;">${(ch.lineups || {})[team.email] ? '&#9989; Your lineup is set' : '&#9888; Your lineup is not set yet'}</div>` : ''}
        ${(ch.status === 'pending' || ch.status === 'confirmed') ? `
          <div class="btns" style="margin-top:10px;">
            ${ch.status === 'confirmed' ? `<button class="btn-secondary" onclick="App.ui.openLineupModal('${ch.id}')">${(ch.lineups || {})[team.email] ? 'Edit Lineup' : 'Set Lineup'}</button>` : ''}
            <button class="btn-secondary" onclick="App.ui.cancelChallenge('${ch.id}')">Cancel</button>
          </div>
        ` : ''}
      </div>
    `).join('') : '<div class="muted-box">No challenges sent yet.</div>';
  }

  function respondChallengeUI(challengeId, response) {
    const ch = state.challenges.find(c => c.id === challengeId);
    const team = signedInTeam();
    if (!ch || !team || ch.toTeamEmail !== team.email) return;
    if (response === 'rejected' && !confirmAction('Reject this challenge?')) return;
    ch.status = response;
    ch.respondedAt = new Date().toISOString();
    pushUpdate({
      id: uid(),
      type: 'challenge_response',
      text: `${ch.fromTeamName} challenge ${response}.`,
      createdAt: new Date().toISOString()
    });
    saveCurrentTournament();
    renderManagerDashboard();
  }

  function cancelChallengeUI(challengeId) {
    const ch = state.challenges.find(c => c.id === challengeId);
    const team = signedInTeam();
    if (!ch || !team) return;
    if (ch.fromTeamEmail !== team.email && ch.toTeamEmail !== team.email) return;
    if (!confirmAction('Cancel this match?')) return;

    ch.status = 'cancelled';
    ch.respondedAt = new Date().toISOString();
    pushUpdate({
      id: uid(),
      type: 'challenge_cancelled',
      text: `Match between ${ch.fromTeamName} and ${ch.toTeamName} cancelled.`,
      createdAt: new Date().toISOString()
    });
    saveCurrentTournament();
    showToast('Match cancelled.', 'ok');
    renderManagerDashboard();
  }

  function openScoreModalUI(challengeId) {
    activeScoreChallengeId = challengeId;
    const ch = state.challenges.find(c => c.id === challengeId);
    const backdrop = document.getElementById('scoreModalBackdrop');
    if (backdrop) backdrop.style.display = 'flex';
    const status = document.getElementById('scoreStatus');
    if (status) { status.textContent = ''; status.className = 'status'; }
    const homeEl = document.getElementById('scoreHome');
    const awayEl = document.getElementById('scoreAway');
    if (homeEl) homeEl.value = '';
    if (awayEl) awayEl.value = '';

    const scorersList = document.getElementById('scoreScorersList');
    if (scorersList && ch) {
      const eligible = state.players.filter(p =>
        (p.teamEmail === ch.fromTeamEmail || p.teamEmail === ch.toTeamEmail) &&
        String(p.division) === String(ch.division)
      );
      scorersList.innerHTML = scorerRowsHTML(eligible);
    }
  }

  function closeScoreModalUI() {
    activeScoreChallengeId = null;
    const backdrop = document.getElementById('scoreModalBackdrop');
    if (backdrop) backdrop.style.display = 'none';
  }

  function openLineupModalUI(challengeId) {
    const ch = state.challenges.find(c => c.id === challengeId);
    const team = signedInTeam();
    if (!ch || !team) return;
    activeLineupChallengeId = challengeId;

    const backdrop = document.getElementById('lineupModalBackdrop');
    if (backdrop) backdrop.style.display = 'flex';
    const status = document.getElementById('lineupStatus');
    if (status) { status.textContent = ''; status.className = 'status'; }

    const eligible = state.players.filter(p => p.teamEmail === team.email && String(p.division) === String(ch.division));
    const existing = (ch.lineups || {})[team.email] || [];
    const holder = document.getElementById('lineupCheckboxes');
    if (holder) holder.innerHTML = lineupCheckboxesHTML(eligible, existing);
  }

  function closeLineupModalUI() {
    activeLineupChallengeId = null;
    const backdrop = document.getElementById('lineupModalBackdrop');
    if (backdrop) backdrop.style.display = 'none';
  }

  function saveLineupUI() {
    const ch = state.challenges.find(c => c.id === activeLineupChallengeId);
    const team = signedInTeam();
    const status = document.getElementById('lineupStatus');
    if (!ch || !team) return;

    const selected = collectLineupSelections(document.getElementById('lineupCheckboxes'));
    if (!selected.length) {
      if (status) { status.textContent = 'Select at least one starting player.'; status.className = 'status error'; }
      return;
    }
    if (selected.length > MAX_LINEUP_SIZE) {
      if (status) { status.textContent = `Select at most ${MAX_LINEUP_SIZE} starting players.`; status.className = 'status error'; }
      return;
    }

    if (!ch.lineups) ch.lineups = {};
    ch.lineups[team.email] = selected;
    saveCurrentTournament();
    closeLineupModalUI();
    showToast('Starting lineup saved.', 'ok');
    renderManagerDashboard();
  }

  function saveChallengeScoreUI() {
    const ch = state.challenges.find(c => c.id === activeScoreChallengeId);
    const status = document.getElementById('scoreStatus');
    const home = document.getElementById('scoreHome')?.value;
    const away = document.getElementById('scoreAway')?.value;

    if (!ch) return;
    if (home === '' || away === '' || home == null || away == null) {
      if (status) {
        status.textContent = 'Enter both scores.';
        status.className = 'status error';
      }
      return;
    }

    const scorers = collectScorerInputs(document.getElementById('scoreScorersList'));

    ch.status = 'completed';
    ch.score = { home: Number(home), away: Number(away) };
    ch.completedAt = new Date().toISOString();

    state.matches.push({
      id: uid(),
      challengeId: ch.id,
      homeTeamName: ch.toTeamName,
      awayTeamName: ch.fromTeamName,
      division: ch.division,
      score: ch.score,
      venue: ch.venue || '',
      scorers,
      lineupHome: (ch.lineups || {})[ch.toTeamEmail] || [],
      lineupAway: (ch.lineups || {})[ch.fromTeamEmail] || [],
      playedAt: ch.completedAt
    });

    applyScorers(scorers);

    pushUpdate({
      id: uid(),
      type: 'score_reported',
      text: `${ch.toTeamName} ${ch.score.home} - ${ch.score.away} ${ch.fromTeamName} (Division ${ch.division}).`,
      createdAt: new Date().toISOString()
    });

    saveCurrentTournament();
    closeScoreModalUI();
    showToast('Score saved.', 'ok');
    renderManagerDashboard();
  }

  // ---- Knockout bracket ---------------------------------------------------
  function propagateBracketWinners(rounds) {
    for (let r = 0; r < rounds.length - 1; r++) {
      rounds[r].forEach((match, i) => {
        if (match.winnerName) {
          const nextMatch = rounds[r + 1][Math.floor(i / 2)];
          const slot = i % 2 === 0 ? 'A' : 'B';
          nextMatch[`team${slot}Name`] = match.winnerName;
          nextMatch[`team${slot}Email`] = match.teamAName === match.winnerName ? match.teamAEmail : match.teamBEmail;
        }
      });
    }
  }

  function generateBracketUI() {
    if (!session.adminSignedIn) return;
    const status = document.getElementById('bracketStatus');
    if (state.tournamentType !== 'Knockout' || !state.knockoutSize) {
      if (status) { status.textContent = 'Set tournament type to Knockout with a bracket size first.'; status.className = 'status error'; }
      return;
    }
    if (state.teams.length < 2) {
      if (status) { status.textContent = 'Need at least 2 registered teams to generate a bracket.'; status.className = 'status error'; }
      return;
    }
    if (state.bracket && !confirmAction('A bracket already exists. Regenerate and discard current bracket progress?')) return;

    const size = state.knockoutSize;
    const shuffled = [...state.teams].sort(() => Math.random() - 0.5).slice(0, size);

    let bracketSlots = 1;
    while (bracketSlots < shuffled.length) bracketSlots *= 2;
    const entrants = [...shuffled];
    while (entrants.length < bracketSlots) entrants.push(null); // bye slot

    const firstRound = [];
    for (let i = 0; i < entrants.length; i += 2) {
      const a = entrants[i], b = entrants[i + 1];
      const match = {
        id: uid(),
        teamAName: a ? a.name : null,
        teamBName: b ? b.name : null,
        teamAEmail: a ? a.email : null,
        teamBEmail: b ? b.email : null,
        scoreA: null,
        scoreB: null,
        scorers: [],
        winnerName: null
      };
      if (match.teamAName && !match.teamBName) match.winnerName = match.teamAName;
      firstRound.push(match);
    }

    const rounds = [firstRound];
    let currentRoundSize = firstRound.length;
    while (currentRoundSize > 1) {
      const nextRound = [];
      for (let i = 0; i < currentRoundSize / 2; i++) {
        nextRound.push({ id: uid(), teamAName: null, teamBName: null, teamAEmail: null, teamBEmail: null, scoreA: null, scoreB: null, scorers: [], winnerName: null });
      }
      rounds.push(nextRound);
      currentRoundSize = nextRound.length;
    }

    propagateBracketWinners(rounds);

    state.bracket = { size: bracketSlots, rounds };
    pushUpdate({
      id: uid(),
      type: 'bracket_generated',
      text: `Knockout bracket generated with ${shuffled.length} teams.`,
      createdAt: new Date().toISOString()
    });
    saveCurrentTournament();
    if (status) { status.textContent = 'Bracket generated.'; status.className = 'status ok'; }
    showToast('Bracket generated.', 'ok');
    renderAdmin();
  }

  function resetBracketUI() {
    if (!session.adminSignedIn) return;
    if (!confirmAction('Reset the current bracket? This cannot be undone.')) return;
    state.bracket = null;
    saveCurrentTournament();
    showToast('Bracket reset.', 'ok');
    renderAdmin();
  }

  function renderBracketAdminSection() {
    if (state.tournamentType !== 'Knockout') return '';
    return `
      <h3>Knockout Bracket</h3>
      <div class="btns">
        <button class="btn-primary" onclick="App.ui.generateBracket()">${state.bracket ? 'Regenerate Bracket' : 'Generate Bracket'}</button>
        ${state.bracket ? `<button class="btn-secondary" onclick="App.ui.resetBracket()">Reset Bracket</button>` : ''}
      </div>
      <div class="status" id="bracketStatus"></div>
    `;
  }

  function renderBracketRounds() {
    if (!state.bracket) return '';
    const team = signedInTeam();
    return `
      <section style="margin-top:24px;">
        <h3>Knockout Bracket</h3>
        <div style="display:flex;gap:16px;overflow-x:auto;">
          ${state.bracket.rounds.map((round, ri) => `
            <div style="min-width:220px;">
              <div class="small muted" style="margin-bottom:8px;">Round ${ri + 1}</div>
              ${round.map(match => `
                <div class="card" style="margin-bottom:12px;background:#0d1628;">
                  <div class="small">
                    ${match.teamAName ? miniLogo(match.teamAName) + escapeHTML(match.teamAName) : 'TBD'}
                    ${match.scoreA !== null ? `<strong>${match.scoreA}</strong>` : ''}
                  </div>
                  <div class="small">
                    ${match.teamBName ? miniLogo(match.teamBName) + escapeHTML(match.teamBName) : 'TBD'}
                    ${match.scoreB !== null ? `<strong>${match.scoreB}</strong>` : ''}
                  </div>
                  ${match.winnerName ? `<div class="small" style="color:#39d98a;margin-top:4px;">Winner: ${escapeHTML(match.winnerName)}</div>` : ''}
                  ${scorersSummaryHTML(match.scorers)}
                  ${match.winnerName ? lineupNamesHTML(match.lineups?.[getTeamByName(match.teamAName)?.email]) : ''}
                  ${match.winnerName ? lineupNamesHTML(match.lineups?.[getTeamByName(match.teamBName)?.email]) : ''}
                  ${(!match.winnerName && match.teamAName && match.teamBName && team && (team.email === match.teamAEmail || team.email === match.teamBEmail)) ? `
                    <div class="small muted" style="margin-top:8px;">${match.lineups?.[team.email] ? '&#9989; Your lineup is set' : '&#9888; Your lineup is not set yet'}</div>
                    <div class="btns" style="margin-top:8px;">
                      <button class="btn-secondary" onclick="App.ui.openBracketLineupModal(${ri}, '${match.id}')">${match.lineups?.[team.email] ? 'Edit Lineup' : 'Set Lineup'}</button>
                    </div>
                  ` : ''}
                  ${(!match.winnerName && match.teamAName && match.teamBName && (session.adminSignedIn || (team && (team.email === match.teamAEmail || team.email === match.teamBEmail)))) ? `
                    <div class="btns" style="margin-top:8px;">
                      <button class="btn-secondary" onclick="App.ui.openBracketScoreModal(${ri}, '${match.id}')">Report Score</button>
                    </div>
                  ` : ''}
                </div>
              `).join('')}
            </div>
          `).join('')}
        </div>
      </section>
      <div class="modal-backdrop" id="bracketScoreModalBackdrop" style="display:none;">
        <div class="modal modal-wide">
          <h3>Report Bracket Score</h3>
          <div class="form-grid">
            <input id="bracketScoreA" type="number" min="0" placeholder="Team A goals">
            <input id="bracketScoreB" type="number" min="0" placeholder="Team B goals">
            <div id="bracketScorersList"></div>
            <div class="btns">
              <button class="btn-primary" onclick="App.ui.saveBracketScore()">Save Score</button>
              <button class="btn-secondary" onclick="App.ui.closeBracketScoreModal()">Cancel</button>
            </div>
            <div class="status" id="bracketScoreStatus"></div>
          </div>
        </div>
      </div>
      <div class="modal-backdrop" id="bracketLineupModalBackdrop" style="display:none;">
        <div class="modal modal-wide">
          <h3>Starting Lineup</h3>
          <p class="small">Select up to ${MAX_LINEUP_SIZE} players from your squad who will start this match.</p>
          <div class="form-grid">
            <div id="bracketLineupCheckboxes"></div>
            <div class="btns">
              <button class="btn-primary" onclick="App.ui.saveBracketLineup()">Save Lineup</button>
              <button class="btn-secondary" onclick="App.ui.closeBracketLineupModal()">Cancel</button>
            </div>
            <div class="status" id="bracketLineupStatus"></div>
          </div>
        </div>
      </div>
    `;
  }

  function openBracketScoreModalUI(roundIndex, matchId) {
    activeBracketMatch = { roundIndex: Number(roundIndex), matchId };
    const backdrop = document.getElementById('bracketScoreModalBackdrop');
    if (backdrop) backdrop.style.display = 'flex';
    const status = document.getElementById('bracketScoreStatus');
    if (status) { status.textContent = ''; status.className = 'status'; }

    const match = state.bracket?.rounds?.[Number(roundIndex)]?.find(m => m.id === matchId);
    const scorersList = document.getElementById('bracketScorersList');
    if (scorersList && match) {
      const eligible = state.players.filter(p => p.teamEmail === match.teamAEmail || p.teamEmail === match.teamBEmail);
      scorersList.innerHTML = scorerRowsHTML(eligible);
    }
  }

  function closeBracketScoreModalUI() {
    activeBracketMatch = null;
    const backdrop = document.getElementById('bracketScoreModalBackdrop');
    if (backdrop) backdrop.style.display = 'none';
  }

  function openBracketLineupModalUI(roundIndex, matchId) {
    const team = signedInTeam();
    const match = state.bracket?.rounds?.[Number(roundIndex)]?.find(m => m.id === matchId);
    if (!team || !match) return;
    activeBracketLineupMatch = { roundIndex: Number(roundIndex), matchId };

    const backdrop = document.getElementById('bracketLineupModalBackdrop');
    if (backdrop) backdrop.style.display = 'flex';
    const status = document.getElementById('bracketLineupStatus');
    if (status) { status.textContent = ''; status.className = 'status'; }

    const eligible = state.players.filter(p => p.teamEmail === team.email);
    const existing = (match.lineups || {})[team.email] || [];
    const holder = document.getElementById('bracketLineupCheckboxes');
    if (holder) holder.innerHTML = lineupCheckboxesHTML(eligible, existing);
  }

  function closeBracketLineupModalUI() {
    activeBracketLineupMatch = null;
    const backdrop = document.getElementById('bracketLineupModalBackdrop');
    if (backdrop) backdrop.style.display = 'none';
  }

  function saveBracketLineupUI() {
    if (!activeBracketLineupMatch || !state.bracket) return;
    const { roundIndex, matchId } = activeBracketLineupMatch;
    const match = state.bracket.rounds[roundIndex]?.find(m => m.id === matchId);
    const team = signedInTeam();
    const status = document.getElementById('bracketLineupStatus');
    if (!match || !team) return;

    const selected = collectLineupSelections(document.getElementById('bracketLineupCheckboxes'));
    if (!selected.length) {
      if (status) { status.textContent = 'Select at least one starting player.'; status.className = 'status error'; }
      return;
    }
    if (selected.length > MAX_LINEUP_SIZE) {
      if (status) { status.textContent = `Select at most ${MAX_LINEUP_SIZE} starting players.`; status.className = 'status error'; }
      return;
    }

    if (!match.lineups) match.lineups = {};
    match.lineups[team.email] = selected;
    saveCurrentTournament();
    closeBracketLineupModalUI();
    showToast('Starting lineup saved.', 'ok');
    renderGames();
  }

  function saveBracketScoreUI() {
    if (!activeBracketMatch || !state.bracket) return;
    const { roundIndex, matchId } = activeBracketMatch;
    const round = state.bracket.rounds[roundIndex];
    const match = round?.find(m => m.id === matchId);
    const status = document.getElementById('bracketScoreStatus');
    const a = document.getElementById('bracketScoreA')?.value;
    const b = document.getElementById('bracketScoreB')?.value;

    if (!match) return;
    if (a === '' || b === '' || a == null || b == null) {
      if (status) { status.textContent = 'Enter both scores.'; status.className = 'status error'; }
      return;
    }
    if (Number(a) === Number(b)) {
      if (status) { status.textContent = 'Knockout matches cannot end in a draw. Enter a winning score.'; status.className = 'status error'; }
      return;
    }

    const scorers = collectScorerInputs(document.getElementById('bracketScorersList'));

    match.scoreA = Number(a);
    match.scoreB = Number(b);
    match.scorers = scorers;
    match.winnerName = match.scoreA > match.scoreB ? match.teamAName : match.teamBName;

    applyScorers(scorers);
    propagateBracketWinners(state.bracket.rounds);

    pushUpdate({
      id: uid(),
      type: 'bracket_score',
      text: `${match.teamAName} ${match.scoreA} - ${match.scoreB} ${match.teamBName} (Bracket).`,
      createdAt: new Date().toISOString()
    });

    saveCurrentTournament();
    closeBracketScoreModalUI();
    showToast('Score saved.', 'ok');
    renderGames();
  }

  function renderGames() {
    const upcoming = [...state.challenges.filter(c => c.status === 'confirmed')]
      .sort((a, b) => `${a.matchDate || '9999'}${a.matchTime || '99:99'}`.localeCompare(`${b.matchDate || '9999'}${b.matchTime || '99:99'}`));
    const completed = [...state.matches].reverse();

    document.getElementById('app').innerHTML = pageShell('games', `
      <section class="hero">
        <div>
          <h2>Upcoming Matches</h2>
          <p>Confirmed challenges waiting to be played, and recent results.</p>
        </div>
      </section>
      <section style="margin-top:16px;">
        <h3>Confirmed &amp; Upcoming</h3>
        <div class="grid cols-2">
          ${upcoming.length ? upcoming.map(ch => `
            <div class="card">
              <div class="row-between">
                <strong>${miniLogo(ch.toTeamName)}${escapeHTML(ch.toTeamName)} vs ${miniLogo(ch.fromTeamName)}${escapeHTML(ch.fromTeamName)}</strong>
                <span class="pill">Division ${escapeHTML(ch.division)}</span>
              </div>
              ${challengeWhenVenueHTML(ch)}
              <div class="small muted">Confirmed ${formatDate(ch.respondedAt)}</div>
              <div class="small muted" style="margin-top:4px;">Lineups: ${(ch.lineups || {})[ch.toTeamEmail] ? '&#9989;' : '&#9888;'} ${escapeHTML(ch.toTeamName)} &middot; ${(ch.lineups || {})[ch.fromTeamEmail] ? '&#9989;' : '&#9888;'} ${escapeHTML(ch.fromTeamName)}</div>
            </div>
          `).join('') : '<div class="muted-box">No confirmed matches yet.</div>'}
        </div>
      </section>
      <section style="margin-top:24px;">
        <h3>Recent Results</h3>
        <div class="grid cols-2">
          ${completed.length ? completed.map(m => `
            <div class="card">
              <div class="row-between">
                <strong>${miniLogo(m.homeTeamName)}${escapeHTML(m.homeTeamName)} ${m.score.home} - ${m.score.away} ${escapeHTML(m.awayTeamName)}${miniLogo(m.awayTeamName)}</strong>
                <span class="pill">Division ${escapeHTML(m.division)}</span>
              </div>
              ${m.venue ? `<div class="small muted">&#128205; ${escapeHTML(m.venue)}</div>` : ''}
              <div class="small muted">${formatDate(m.playedAt)}</div>
              ${scorersSummaryHTML(m.scorers)}
              ${lineupNamesHTML(m.lineupHome)}
              ${lineupNamesHTML(m.lineupAway)}
            </div>
          `).join('') : '<div class="muted-box">No results reported yet.</div>'}
        </div>
      </section>
      ${renderBracketRounds()}
    `);
  }

  function computeStandings(matches) {
    const table = {}; // division -> teamName -> row
    const matchList = matches || state.matches;

    function ensureRow(division, teamName) {
      if (!table[division]) table[division] = {};
      if (!table[division][teamName]) {
        table[division][teamName] = {
          teamName, played: 0, won: 0, drawn: 0, lost: 0,
          goalsFor: 0, goalsAgainst: 0, points: 0
        };
      }
      return table[division][teamName];
    }

    matchList.forEach(m => {
      const division = m.division || 'Unassigned';
      const home = ensureRow(division, m.homeTeamName);
      const away = ensureRow(division, m.awayTeamName);
      const hg = Number(m.score?.home ?? 0);
      const ag = Number(m.score?.away ?? 0);

      home.played += 1; away.played += 1;
      home.goalsFor += hg; home.goalsAgainst += ag;
      away.goalsFor += ag; away.goalsAgainst += hg;

      if (hg > ag) { home.won += 1; home.points += 3; away.lost += 1; }
      else if (hg < ag) { away.won += 1; away.points += 3; home.lost += 1; }
      else { home.drawn += 1; away.drawn += 1; home.points += 1; away.points += 1; }
    });

    const divisions = Object.keys(table).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return divisions.map(division => {
      const rows = Object.values(table[division]).sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        const gdA = a.goalsFor - a.goalsAgainst;
        const gdB = b.goalsFor - b.goalsAgainst;
        if (gdB !== gdA) return gdB - gdA;
        return b.goalsFor - a.goalsFor;
      });
      return { division, rows };
    });
  }

  function renderTopScorersSection() {
    const rows = computeTopScorers();
    if (!rows.length) return '<div class="muted-box">No goals or cards recorded yet.</div>';
    return `
      <div class="table-wrap">
        <table class="standings-table">
          <thead>
            <tr><th>#</th><th>Player</th><th>Team</th><th>Goals</th><th>Yellow</th><th>Red</th></tr>
          </thead>
          <tbody>
            ${rows.map((r, i) => `
              <tr class="${i === 0 && r.goals > 0 ? 'standings-lead' : ''}">
                <td>${i + 1}</td>
                <td>${escapeHTML(r.player.fullName)}</td>
                <td>${miniLogo(r.player.teamName)}${escapeHTML(r.player.teamName)}</td>
                <td><strong>${r.goals}</strong></td>
                <td>${r.yellow}</td>
                <td>${r.red}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderStandings() {
    const groups = computeStandings();

    document.getElementById('app').innerHTML = pageShell('standings', `<section class="hero"><div><h2>Standings</h2><p>Points, goal difference, and form by division, computed from reported match results.</p></div></section>
<div class="print-only">
  <h2>${escapeHTML(state.tournamentName || 'Tournament Standings')}</h2>
  <div class="small">Printed ${formatDate(new Date().toISOString())}</div>
</div>
<section style="margin-top:16px;">
<div class="btns no-print"><button class="btn-secondary" onclick="App.ui.exportStandings()">Export CSV</button><button class="btn-secondary" onclick="App.ui.printStandings()">Print Standings</button><button class="btn-secondary" onclick="App.ui.downloadCurrentTournamentPdf()">Download Tournament PDF</button></div>
</section>
<section id="standingsGroups" style="margin-top:16px;"></section>
<section class="card" style="margin-top:16px;">
<h3>Top Scorers &amp; Cards</h3>
<div id="topScorersSection">${renderTopScorersSection()}</div>
</section>
<section class="card no-print" style="margin-top:16px;">
<h3>Head-to-Head</h3>
<div class="form-grid">
<select id="h2hTeam1" onchange="App.ui.headToHead()">
<option value="">Select team</option>${state.teams.map(t => `<option value="${escapeHTML(t.name)}">${escapeHTML(t.name)}</option>`).join('')}
</select>
<select id="h2hTeam2" onchange="App.ui.headToHead()">
<option value="">Select team</option>
${state.teams.map(t => `<option value="${escapeHTML(t.name)}">${escapeHTML(t.name)}</option>`).join('')}
</select>
</div>
<div id="h2hResults" style="margin-top:12px;"></div>
</section>
`);

    const holder = document.getElementById('standingsGroups');
    if (!groups.length) {
      holder.innerHTML = '<div class="muted-box">No results reported yet. Standings will appear once matches are played.</div>';
    } else {
      holder.innerHTML = groups.map(({ division, rows }) => `
        <div class="card" style="margin-bottom:18px;">
          <h3>Division ${escapeHTML(division)}</h3>
          <div class="table-wrap">
            <table class="standings-table">
              <thead>
                <tr>
                  <th>#</th><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>GD</th><th>Pts</th>
                </tr>
              </thead>
              <tbody>
                ${rows.map((r, i) => `
                  <tr class="${i === 0 ? 'standings-lead' : ''}">
                    <td>${i + 1}</td>
                    <td>${miniLogo(r.teamName)}${escapeHTML(r.teamName)}</td>
                    <td>${r.played}</td>
                    <td>${r.won}</td>
                    <td>${r.drawn}</td>
                    <td>${r.lost}</td>
                    <td>${r.goalsFor}</td>
                    <td>${r.goalsAgainst}</td>
                    <td>${r.goalsFor - r.goalsAgainst}</td>
                    <td><strong>${r.points}</strong></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `).join('');
    }

    const h2h = document.getElementById('h2hResults');
    if (h2h) h2h.innerHTML = '<div class="muted-box">Select two teams to compare.</div>';
  }

  function renderHeadToHeadUI() {
    const t1 = document.getElementById('h2hTeam1')?.value;
    const t2 = document.getElementById('h2hTeam2')?.value;
    const holder = document.getElementById('h2hResults');
    if (!holder) return;

    if (!t1 || !t2 || t1 === t2) {
      holder.innerHTML = '<div class="muted-box">Select two different teams.</div>';
      return;
    }

    const matches = state.matches.filter(m =>
      (m.homeTeamName === t1 && m.awayTeamName === t2) ||
      (m.homeTeamName === t2 && m.awayTeamName === t1)
    );

    if (!matches.length) {
      holder.innerHTML = '<div class="muted-box">No matches played between these teams yet.</div>';
      return;
    }

    let t1Wins = 0, t2Wins = 0, draws = 0;
    matches.forEach(m => {
      const homeIsT1 = m.homeTeamName === t1;
      const hg = m.score.home, ag = m.score.away;
      if (hg === ag) draws++;
      else if ((hg > ag && homeIsT1) || (ag > hg && !homeIsT1)) t1Wins++;
      else t2Wins++;
    });

    holder.innerHTML = `
      <div class="stat-row" style="margin-bottom:10px;">
        <div class="stat"><strong>${t1Wins}</strong><span>${escapeHTML(t1)} wins</span></div>
        <div class="stat"><strong>${draws}</strong><span>Draws</span></div>
        <div class="stat"><strong>${t2Wins}</strong><span>${escapeHTML(t2)} wins</span></div>
      </div>
      ${matches.map(m => `
        <div class="update-row">
          <div>${escapeHTML(m.homeTeamName)} ${m.score.home} - ${m.score.away} ${escapeHTML(m.awayTeamName)}</div>
          <div class="small muted">${formatDate(m.playedAt)}</div>
        </div>
      `).join('')}
    `;
  }

  function renderPlayers() {
    const divisions = [...new Set(state.players.map(p => String(p.division)))].sort();
    document.getElementById('app').innerHTML = pageShell(
      'players',
      `
        <section class="hero">
          <div><h2>Players</h2><p>Browse every registered player by division.</p></div>
        </section>
        <section class="card" style="margin-top:16px;">
          <div class="form-grid">
            <input id="playerSearchInput" placeholder="Search by name or team" oninput="App.ui.filterPlayers()">
            <div class="grid cols-2">
              <select id="playerDivisionFilter" onchange="App.ui.filterPlayers()">
                <option value="">All divisions</option>
                ${divisions.map(d => `<option value="${escapeHTML(d)}">Division ${escapeHTML(d)}</option>`).join('')}
              </select>
              <select id="playerPositionFilter" onchange="App.ui.filterPlayers()">
                <option value="">All positions</option>
                ${POSITIONS.map(pos => `<option value="${pos}">${pos}</option>`).join('')}
              </select>
            </div>
            <button class="btn-secondary" onclick="App.ui.exportRoster()">Export CSV</button>
          </div>
        </section>
        <section id="playersList" style="margin-top:16px;"></section>
      `
    );
    filterPlayersUI();
  }

  function filterPlayersUI() {
    const holder = document.getElementById('playersList');
    if (!holder) return;

    const query = (document.getElementById('playerSearchInput')?.value || '').toLowerCase();
    const division = document.getElementById('playerDivisionFilter')?.value || '';
    const position = document.getElementById('playerPositionFilter')?.value || '';

    const filtered = state.players.filter(p => {
      const matchesQuery = !query || p.fullName.toLowerCase().includes(query) || (p.teamName || '').toLowerCase().includes(query);
      const matchesDivision = !division || String(p.division) === division;
      const matchesPosition = !position || p.position === position;
      return matchesQuery && matchesDivision && matchesPosition;
    });

    holder.innerHTML = filtered.length
      ? `
          <div class="grid cols-3">
            ${filtered.map(p => {
              const stats = state.playerStats[p.id];
              return `
              <div class="card">
                <div class="team-chip">
                  <img src="${p.photo || getBadgeFallback(p.fullName)}" alt="">
                  <div>
                    <strong>${escapeHTML(p.fullName)}</strong>
                    <div class="small">${miniLogo(p.teamName)}${escapeHTML(p.teamName)}</div>
                  </div>
                </div>
                <div class="small" style="margin-top:8px;">${p.position ? `<span class="pill">${escapeHTML(p.position)}</span> ` : ''}Division ${escapeHTML(p.division)} &middot; #${escapeHTML(p.jerseyNumber)}</div>
                ${stats && (stats.goals || stats.yellow || stats.red) ? `<div class="small muted" style="margin-top:6px;">&#9917; ${stats.goals} goals${stats.yellow ? ` &middot; &#128993; ${stats.yellow}` : ''}${stats.red ? ` &middot; &#128308; ${stats.red}` : ''}</div>` : ''}
              </div>
            `;}).join('')}
          </div>
        `
      : '<div class="muted-box">No players match your search.</div>';
  }

  function renderHistory() {
    document.getElementById('app').innerHTML = pageShell('history', `
      <section class="hero">
        <div>
          <h2>Tournament History</h2>
          <p>Archived tournaments and their final rosters.</p>
        </div>
      </section>
      <section class="grid cols-2" style="margin-top:16px;">
        <div>
          <h3>Archive</h3>
          <div id="historyList" class="card"></div>
        </div>
        <div>
          <h3>Details</h3>
          <div id="historyDetail" class="card">Select a tournament to view details.</div>
        </div>
      </section>
    `);

    const list = document.getElementById('historyList');
    list.innerHTML = archive.length
      ? archive.map(t => `
          <div class="update-row" style="cursor:pointer;" onclick="App.ui.loadHistory('${t.id}')">
            <div><strong>${escapeHTML(t.tournamentName)}</strong></div>
            <div class="small muted">${formatDate(t.createdAt)}</div>
          </div>
        `).join('')
      : '<div class="muted-box">No archived tournaments yet.</div>';
  }

  function loadHistoryUI(id) {
    const detail = document.getElementById('historyDetail');
    if (!detail) return;
    const t = archive.find(a => a.id === id);
    if (!t) {
      detail.innerHTML = '<div class="muted-box">Tournament not found.</div>';
      return;
    }

    detail.innerHTML = `
      <h4>${escapeHTML(t.tournamentName)}</h4>
      <div class="small">Hosted by ${escapeHTML(t.tournamentNumber)}</div>
      <div class="small">Format: ${t.tournamentType === 'Knockout' && t.knockoutSize ? `${t.knockoutSize} teams` : ''}</div>
      ${t.tournamentInfo ? `<p>${escapeHTML(t.tournamentInfo)}</p>` : ''}
      <div class="small muted">Archived ${formatDate(t.createdAt)}</div>
      <div class="btns" style="margin-top:10px;"><button class="btn-secondary" onclick="App.ui.downloadArchivedTournamentPdf('${t.id}')">Download PDF</button></div>
      <hr class="divider">
      <div><strong>Teams</strong></div>
      <div>${(t.teams || []).map(team => `<span class="pill" style="margin:4px 4px 0 0;display:inline-block;">${escapeHTML(team.name)}</span>`).join('') || '<div class="muted-box">No teams recorded.</div>'}</div>
    `;
  }

  function renderBlog() {
    document.getElementById('app').innerHTML = pageShell('blog', `
      <section class="hero">
        <div>
          <h2>Blog</h2>
          <p>News, recaps, and announcements.</p>
        </div>
      </section>
      <section class="card" style="margin-top:16px;">
        <div class="form-grid">
          <input id="blogSearchInput" placeholder="Search posts" oninput="App.ui.searchBlog()" value="${escapeHTML(blogFilter)}">
        </div>
      </section>
      <section id="blogFeed" style="margin-top:16px;"></section>
    `);

    renderBlogFeed(blogFilter);
  }

  function renderBlogFeed(query) {
    const holder = document.getElementById('blogFeed');
    if (!holder) return;

    const posts = [...loadBlog()].reverse();
    const q = (query || '').toLowerCase();
    const filtered = posts.filter(p =>
      !q ||
      (p.title || '').toLowerCase().includes(q) ||
      (p.body || '').toLowerCase().includes(q)
    );

    holder.innerHTML = filtered.length
      ? filtered.map(p => `
          <article class="card" style="margin-bottom:14px;">
            <h3>${escapeHTML(p.title)}</h3>
            <div class="small muted">${formatDate(p.createdAt)}${p.author ? ` &middot; ${escapeHTML(p.author)}` : ''}${p.updatedAt ? ' &middot; edited' : ''}</div>
            <p>${escapeHTML(p.body)}</p>
          </article>
        `).join('')
      : '<div class="muted-box">No posts found.</div>';
  }

  function searchBlogUI() {
    blogFilter = document.getElementById('blogSearchInput')?.value || '';
    renderBlogFeed(blogFilter);
  }

  function publishBlogPostUI() {
    if (!session.adminSignedIn) return;
    const title = document.getElementById('newBlogTitle')?.value.trim();
    const body = document.getElementById('newBlogBody')?.value.trim();
    const status = document.getElementById('blogAdminStatus');

    if (!title || !body) {
      if (status) {
        status.textContent = 'Title and body are required.';
        status.className = 'status error';
      }
      return;
    }

    const posts = loadBlog();

    if (editingBlogPostId) {
      const post = posts.find(p => p.id === editingBlogPostId);
      if (post) {
        post.title = title;
        post.body = body;
        post.updatedAt = new Date().toISOString();
      }
      editingBlogPostId = null;
      if (status) { status.textContent = 'Post updated.'; status.className = 'status ok'; }
      showToast('Post updated.', 'ok');
    } else {
      posts.push({ id: uid(), title, body, author: 'Admin', createdAt: new Date().toISOString() });
      if (status) { status.textContent = 'Post published.'; status.className = 'status ok'; }
      showToast('Post published.', 'ok');
    }

    saveBlog(posts);
    renderAdmin();
  }

  function editBlogPostUI(postId) {
    const post = loadBlog().find(p => p.id === postId);
    if (!post) return;
    editingBlogPostId = postId;
    renderAdmin();
    const titleEl = document.getElementById('newBlogTitle');
    const bodyEl = document.getElementById('newBlogBody');
    if (titleEl) titleEl.value = post.title;
    if (bodyEl) bodyEl.value = post.body;
    titleEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function cancelEditBlogPostUI() {
    editingBlogPostId = null;
    renderAdmin();
  }

  function deleteBlogPostUI(postId) {
    if (!confirmAction('Delete this post? This cannot be undone.')) return;
    const posts = loadBlog().filter(p => p.id !== postId);
    saveBlog(posts);
    if (editingBlogPostId === postId) editingBlogPostId = null;
    showToast('Post deleted.', 'ok');
    renderAdmin();
  }

  async function adminSignInUI() {
    const admin = await ensureAdmin();
    const username = document.getElementById('adminUser')?.value.trim();
    const password = document.getElementById('adminPass')?.value.trim();
    const status = document.getElementById('adminStatus');

    if (!username || !password) {
      if (status) { status.textContent = 'Enter username and password.'; status.className = 'status error'; }
      return;
    }

    const passwordHash = await hashPassword(password, admin.username);

    if (username === admin.username && passwordHash === admin.passwordHash) {
      session.adminSignedIn = true;
      saveSession();
      if (status) {
        status.textContent = 'Signed in as admin.';
        status.className = 'status ok';
      }
      renderAdmin();
    } else {
      if (status) {
        status.textContent = 'Invalid admin credentials.';
        status.className = 'status error';
      }
    }
  }

  function adminSignOutUI() {
    session.adminSignedIn = false;
    saveSession();
    renderAdmin();
  }

  function renderAdmin() {
    document.getElementById('app').innerHTML = pageShell('admin', `
      <section class="grid cols-2">
        <div class="card">
          <h2>Admin Login</h2>
          <div class="form-grid">
            <input id="adminUser" placeholder="Admin username">
            <input id="adminPass" type="password" placeholder="Admin password">
            <div class="btns">
              <button class="btn-primary" onclick="App.ui.adminSignIn()">Log In</button>
              <button class="btn-secondary" onclick="App.ui.adminSignOut()">Log Out</button>
            </div>
            <a href="#" class="small" onclick="App.ui.openForgotPassword('admin');return false;">Forgot password?</a>
            <div class="status" id="adminStatus"></div>
          </div>
        </div>
        <div class="card">
          <h2>Registered Teams</h2>
          <input id="adminTeamSearch" placeholder="Search teams or coaches" oninput="App.ui.filterAdminTeams()" style="margin-bottom:10px;" value="${escapeHTML(adminTeamFilter)}">
          <div id="adminTeams" class="team-list"></div>
        </div>
      </section>
      <section class="card" style="margin-top:16px;"><div id="adminTournamentSection"></div></section>
      <section class="card" style="margin-top:16px;"><div id="adminHostSection"></div></section>
      <section class="card" style="margin-top:16px;"><div id="adminBracketSection"></div></section>
      <section class="card" style="margin-top:16px;"><div id="adminRecordMatchSection"></div></section>
      <section class="card" style="margin-top:16px;"><div id="adminBackupSection"></div></section>
      <section class="card" style="margin-top:16px;"><div id="adminBlogSection"></div></section>
      ${forgotPasswordModalHTML()}
    `);

    renderAdminTeamsList();

    document.getElementById('adminTournamentSection').innerHTML = session.adminSignedIn
      ? renderCreateTournamentForm()
      : '<div class="muted-box">Please log in as admin first.</div>';

    document.getElementById('adminHostSection').innerHTML = (session.adminSignedIn && state.tournamentName)
      ? renderHostProfileForm()
      : '';

    document.getElementById('adminBracketSection').innerHTML = (session.adminSignedIn && state.tournamentType === 'Knockout')
      ? renderBracketAdminSection()
      : '';

    document.getElementById('adminRecordMatchSection').innerHTML = (session.adminSignedIn && state.teams.length >= 2)
      ? renderAdminRecordMatchForm()
      : '';

    document.getElementById('adminBackupSection').innerHTML = session.adminSignedIn
      ? renderAdminBackupSection()
      : '';

    document.getElementById('adminBlogSection').innerHTML = session.adminSignedIn
      ? renderAdminBlogSection()
      : '';
  }

  function filterAdminTeamsUI() {
    adminTeamFilter = document.getElementById('adminTeamSearch')?.value || '';
    renderAdminTeamsList();
  }

  function renderAdminTeamsList() {
    const holder = document.getElementById('adminTeams');
    if (!holder) return;

    const q = (adminTeamFilter || '').toLowerCase();
    const filtered = state.teams.filter(team =>
      !q ||
      (team.name || '').toLowerCase().includes(q) ||
      ((team.coachName || '').toLowerCase().includes(q))
    );

    holder.innerHTML = filtered.length
      ? filtered.map(team => `
          <div class="team-chip">
            <img src="${teamLogo(team)}" alt="">
            <div>
              <strong>${escapeHTML(team.name || 'Team')}</strong>
              <div class="small">${escapeHTML(team.contact || '')}</div>
              <div class="small">Coach: ${escapeHTML(team.coachName || 'N/A')}</div>
            </div>
          </div>
        `).join('')
      : `<div class="muted-box">${state.teams.length ? 'No teams match your search.' : 'No teams registered yet.'}</div>`;
  }

  function renderHostProfileForm() {
    return `
      <h2>Host Profile</h2>
      <p class="small">Upload a photo and short bio for the tournament host, shown on the Home page.</p>
      <div class="form-grid">
        ${state.hostPhoto ? `<img src="${state.hostPhoto}" alt="Current host photo" style="width:88px;height:88px;border-radius:10px;object-fit:cover;border:1px solid var(--border-strong);">` : ''}
        <input id="hostPhotoInput" type="file" accept="image/*">
        <textarea id="hostBioInput" placeholder="Short bio about the host">${escapeHTML(state.hostBio || '')}</textarea>
        <div class="btns"><button class="btn-primary" onclick="App.ui.saveHostProfile()">Save Host Profile</button></div>
        <div class="status" id="hostProfileStatus"></div>
      </div>
    `;
  }

  async function saveHostProfileUI() {
    const status = document.getElementById('hostProfileStatus');
    const photoFile = document.getElementById('hostPhotoInput')?.files?.[0];
    const bio = document.getElementById('hostBioInput')?.value.trim() || '';

    if (!checkImageSize(photoFile, status, 'Host photo')) return;

    if (photoFile) state.hostPhoto = await fileToDataURL(photoFile);
    state.hostBio = bio;

    saveCurrentTournament();
    if (status) { status.textContent = 'Host profile saved.'; status.className = 'status ok'; }
    showToast('Host profile saved.', 'ok');
    renderAdmin();
  }

  function renderAdminRecordMatchForm() {
    const teamOptions = state.teams.map(t => `<option value="${t.email}">${escapeHTML(t.name)}${t.guest ? ' (guest)' : ''}</option>`).join('');
    return `
      <h2>Record Match Result</h2>
      <p class="small">Log a result directly between any two teams — skips the challenge/accept flow, so it works for guest teams and registered teams alike.</p>
      <div class="form-grid">
        <div class="grid cols-2">
          <select id="recordMatchTeamA" onchange="App.ui.onRecordMatchTeamsChange()">
            <option value="">Select Team A</option>${teamOptions}
          </select>
          <select id="recordMatchTeamB" onchange="App.ui.onRecordMatchTeamsChange()">
            <option value="">Select Team B</option>${teamOptions}
          </select>
        </div>
        <input id="recordMatchDivision" placeholder="Division" list="recordMatchDivisionOptions">
        <datalist id="recordMatchDivisionOptions"></datalist>
        <div class="grid cols-2">
          <input id="recordMatchScoreA" type="number" min="0" placeholder="Team A goals">
          <input id="recordMatchScoreB" type="number" min="0" placeholder="Team B goals">
        </div>
        <div class="grid cols-2">
          <input id="recordMatchDate" type="date">
          <input id="recordMatchTime" type="time">
        </div>
        <input id="recordMatchVenue" placeholder="Venue (optional)">
        <div id="recordMatchScorersList"></div>
        <div class="btns"><button class="btn-primary" onclick="App.ui.recordMatchResult()">Record Result</button></div>
        <div class="status" id="recordMatchStatus"></div>
      </div>
    `;
  }

  function onRecordMatchTeamsChangeUI() {
    const emailA = document.getElementById('recordMatchTeamA')?.value;
    const emailB = document.getElementById('recordMatchTeamB')?.value;
    const teamA = getTeamByEmail(emailA);
    const teamB = getTeamByEmail(emailB);

    const datalist = document.getElementById('recordMatchDivisionOptions');
    if (datalist) {
      const divisions = [...new Set([...(teamA?.divisions || []), ...(teamB?.divisions || [])])];
      datalist.innerHTML = divisions.map(d => `<option value="${escapeHTML(d)}">`).join('');
    }

    const scorersList = document.getElementById('recordMatchScorersList');
    if (scorersList) {
      const eligible = state.players.filter(p => p.teamEmail === emailA || p.teamEmail === emailB);
      scorersList.innerHTML = scorerRowsHTML(eligible);
    }
  }

  function recordMatchResultUI() {
    const status = document.getElementById('recordMatchStatus');
    const emailA = document.getElementById('recordMatchTeamA')?.value;
    const emailB = document.getElementById('recordMatchTeamB')?.value;
    const division = document.getElementById('recordMatchDivision')?.value.trim();
    const scoreA = document.getElementById('recordMatchScoreA')?.value;
    const scoreB = document.getElementById('recordMatchScoreB')?.value;
    const date = document.getElementById('recordMatchDate')?.value;
    const time = document.getElementById('recordMatchTime')?.value;
    const venue = document.getElementById('recordMatchVenue')?.value.trim() || '';

    const teamA = getTeamByEmail(emailA);
    const teamB = getTeamByEmail(emailB);

    if (!teamA || !teamB || emailA === emailB) {
      if (status) { status.textContent = 'Select two different teams.'; status.className = 'status error'; }
      return;
    }
    if (!division) {
      if (status) { status.textContent = 'Enter a division.'; status.className = 'status error'; }
      return;
    }
    if (scoreA === '' || scoreB === '' || scoreA == null || scoreB == null) {
      if (status) { status.textContent = 'Enter both scores.'; status.className = 'status error'; }
      return;
    }

    const playedAt = date ? new Date(`${date}T${time || '00:00'}`).toISOString() : new Date().toISOString();
    const scorers = collectScorerInputs(document.getElementById('recordMatchScorersList'));

    state.matches.push({
      id: uid(),
      challengeId: null,
      homeTeamName: teamA.name,
      awayTeamName: teamB.name,
      division,
      score: { home: Number(scoreA), away: Number(scoreB) },
      venue,
      scorers,
      lineupHome: [],
      lineupAway: [],
      playedAt
    });

    applyScorers(scorers);

    pushUpdate({
      id: uid(),
      type: 'score_reported',
      text: `${teamA.name} ${scoreA} - ${scoreB} ${teamB.name} (Division ${division}, recorded by admin).`,
      createdAt: new Date().toISOString()
    });

    saveCurrentTournament();
    showToast('Match result recorded.', 'ok');
    renderAdmin();
  }

  function renderAdminBackupSection() {
    return `
      <h2>Data Backup</h2>
      <p class="small">Everything lives in this browser's storage. Export a backup regularly, or before switching devices.</p>
      <div class="btns">
        <button class="btn-primary" onclick="App.ui.exportAllData()">Export Backup (JSON)</button>
        <button class="btn-secondary" onclick="document.getElementById('importDataFile').click()">Import Backup</button>
        <input type="file" id="importDataFile" accept="application/json" style="display:none" onchange="App.ui.importAllData(this.files[0])">
      </div>
      <div class="status" id="backupStatus"></div>
    `;
  }

  function renderAdminBlogSection() {
    const posts = [...loadBlog()].reverse();
    return `
      <h2>${editingBlogPostId ? 'Edit Post' : 'Publish Blog Post'}</h2>
      <div class="form-grid">
        <input id="newBlogTitle" placeholder="Post title">
        <textarea id="newBlogBody" placeholder="Post content"></textarea>
        <div class="btns">
          <button class="btn-primary" onclick="App.ui.publishBlogPost()">${editingBlogPostId ? 'Save Changes' : 'Publish'}</button>
          ${editingBlogPostId ? `<button class="btn-secondary" onclick="App.ui.cancelEditBlogPost()">Cancel Edit</button>` : ''}
        </div>
        <div class="status" id="blogAdminStatus"></div>
      </div>
      <hr class="divider">
      <h3>Manage Posts</h3>
      ${posts.length ? posts.map(p => `
        <div class="update-row">
          <div>
            <strong>${escapeHTML(p.title)}</strong>
            <div class="small muted">${formatDate(p.createdAt)}</div>
          </div>
          <div class="btns">
            <button class="btn-secondary" onclick="App.ui.editBlogPost('${p.id}')">Edit</button>
            <button class="btn-secondary" onclick="App.ui.deleteBlogPost('${p.id}')">Delete</button>
          </div>
        </div>
      `).join('') : '<div class="muted-box">No posts yet.</div>'}
    `;
  }

  function carryOverTeamsSectionHTML() {
    if (!state.teams.length) return '';
    return `
      <hr class="divider">
      <h3>Carry Over Teams</h3>
      <p class="small">Select which currently registered teams (and their rosters) should carry into the new tournament. Unselected teams, and all match history, stay behind in the archive.</p>
      <div class="btns" style="margin-bottom:8px;">
        <button type="button" class="btn-secondary" onclick="App.ui.setCarryOverTeams(true)">Select All</button>
        <button type="button" class="btn-secondary" onclick="App.ui.setCarryOverTeams(false)">Select None</button>
      </div>
      <div class="lineup-list" id="carryOverTeamsList">
        ${state.teams.map(t => `
          <label class="lineup-item">
            <input type="checkbox" value="${t.id}" checked>
            <img class="mini-logo" src="${teamLogo(t)}" alt="">
            <span>${escapeHTML(t.name)}</span>
          </label>
        `).join('')}
      </div>
    `;
  }

  function setCarryOverTeamsUI(checked) {
    document.querySelectorAll('#carryOverTeamsList input[type="checkbox"]').forEach(cb => { cb.checked = checked; });
  }

  function guestTeamsSectionHTML() {
    return `
      <hr class="divider">
      <h3>Add Teams Not Yet Registered</h3>
      <p class="small">These teams skip the full sign-up (no email/login) and will only play in this tournament. Add players for them afterward from the Admin team list, or via a Manager login if you set one up separately.</p>
      <div class="grid cols-2">
        <input id="guestTeamName" placeholder="Team name">
        <input id="guestTeamDivisions" placeholder="Division(s), comma-separated">
      </div>
      <input id="guestTeamLogo" type="file" accept="image/*">
      <div class="btns" style="margin:8px 0;"><button type="button" class="btn-secondary" onclick="App.ui.addGuestTeam()">+ Add Team to This Tournament</button></div>
      <div class="status" id="guestTeamStatus"></div>
      ${pendingGuestTeams.length ? `
        <div class="lineup-list" style="margin-top:8px;">
          ${pendingGuestTeams.map(g => `
            <div class="lineup-item" style="justify-content:space-between;">
              <span style="display:flex;align-items:center;gap:8px;">
                <img class="mini-logo" src="${g.badge || getBadgeFallback(g.name)}" alt="">
                ${escapeHTML(g.name)} ${g.divisions.length ? `<span class="muted small">(Div ${g.divisions.map(escapeHTML).join(', ')})</span>` : ''}
              </span>
              <button type="button" class="btn-secondary" onclick="App.ui.removeGuestTeam('${g.id}')">Remove</button>
            </div>
          `).join('')}
        </div>
      ` : ''}
    `;
  }

  function refreshGuestTeamsSection() {
    const container = document.getElementById('guestTeamsSection');
    if (container) container.innerHTML = guestTeamsSectionHTML();
  }

  async function addGuestTeamUI() {
    const status = document.getElementById('guestTeamStatus');
    const name = document.getElementById('guestTeamName')?.value.trim();
    const divisionsRaw = document.getElementById('guestTeamDivisions')?.value.trim();
    const logoFile = document.getElementById('guestTeamLogo')?.files?.[0];

    if (!name) {
      if (status) { status.textContent = 'Enter a team name.'; status.className = 'status error'; }
      return;
    }
    if (pendingGuestTeams.some(g => g.name.toLowerCase() === name.toLowerCase()) ||
        state.teams.some(t => t.name.toLowerCase() === name.toLowerCase())) {
      if (status) { status.textContent = 'A team with this name already exists.'; status.className = 'status error'; }
      return;
    }
    if (!checkImageSize(logoFile, status, 'Team logo')) return;

    const divisions = divisionsRaw ? divisionsRaw.split(',').map(d => d.trim()).filter(Boolean) : [];
    const badge = logoFile ? await fileToDataURL(logoFile) : '';

    pendingGuestTeams.push({ id: uid(), name, divisions, badge });
    // Refresh only this section so the tournament name/host/etc fields
    // the admin already typed elsewhere on the form aren't wiped out.
    refreshGuestTeamsSection();
  }

  function removeGuestTeamUI(id) {
    pendingGuestTeams = pendingGuestTeams.filter(g => g.id !== id);
    refreshGuestTeamsSection();
  }

  function renderCreateTournamentForm() {
    return `
      <h2>Create New Tournament</h2>
      <div class="form-grid">
        <input id="newTournamentName" placeholder="Tournament name">
        <input id="newTournamentHost" placeholder="Host name">
        <input id="newTournamentNumber" placeholder="Host / contact number">
        <textarea id="newTournamentInfo" placeholder="Additional tournament information"></textarea>
        <select id="newTournamentType" onchange="App.ui.toggleKnockoutSize()">
          <option value="">Select tournament type</option>
          <option value="Group Stage">Group Stage</option>
          <option value="Knockout">Knockout</option>
        </select>
        <select id="newTournamentKnockoutSize" style="display:none;">
          <option value="">Select knockout size</option>
          <option value="64">64 Teams</option>
          <option value="32">32 Teams</option>
          <option value="16">16 Teams</option>
          <option value="8">8 Teams</option>
          <option value="4">4 Teams</option>
          <option value="2">Final (2 Teams)</option>
        </select>
        ${carryOverTeamsSectionHTML()}
        <div id="guestTeamsSection">${guestTeamsSectionHTML()}</div>
        <div class="btns"><button class="btn-primary" onclick="App.ui.createTournament()">Create Tournament</button></div>
        <div class="status" id="tournamentAdminStatus"></div>
      </div>
    `;
  }

  function validateTournamentPayload(payload) {
    const errors = [];
    if (!payload.tournamentName?.trim()) errors.push('Tournament name is required.');
    if (!payload.tournamentHost?.trim()) errors.push('Host name is required.');
    if (!payload.tournamentNumber?.trim()) errors.push('Host/contact number is required.');
    if (!TOURNAMENT_TYPES.includes(payload.tournamentType)) errors.push('Select a valid tournament type.');
    if (payload.tournamentType === 'Knockout' && !KNOCKOUT_SIZES.includes(Number(payload.knockoutSize))) {
      errors.push('Select a valid knockout size.');
    }
    return { ok: errors.length === 0, errors };
  }

  function createTournamentFromAdminForm() {
    if (!session.adminSignedIn) return { ok: false, message: 'Admin login required.' };

    const payload = {
      tournamentName: document.getElementById('newTournamentName')?.value.trim(),
      tournamentHost: document.getElementById('newTournamentHost')?.value.trim(),
      tournamentNumber: document.getElementById('newTournamentNumber')?.value.trim(),
      tournamentInfo: document.getElementById('newTournamentInfo')?.value.trim(),
      tournamentType: document.getElementById('newTournamentType')?.value,
      knockoutSize: document.getElementById('newTournamentKnockoutSize')?.value
        ? Number(document.getElementById('newTournamentKnockoutSize').value)
        : null
    };

    const res = validateTournamentPayload(payload);
    if (!res.ok) return { ok: false, message: res.errors[0] };

    // Capture which teams (and their rosters) should carry over BEFORE the
    // state reset wipes them — the checkboxes still reflect the old state.
    // Deep-clone so the new tournament's copies are independent of the
    // objects now sitting in the archive (saveTournamentHistory below keeps
    // references to the current state.teams/players).
    const carryOverIds = collectLineupSelections(document.getElementById('carryOverTeamsList'));
    const selectedTeams = state.teams.filter(t => carryOverIds.includes(t.id));
    const selectedPlayers = state.players.filter(p => selectedTeams.some(t => t.email === p.teamEmail));
    const carriedTeams = JSON.parse(JSON.stringify(selectedTeams));
    const carriedPlayers = JSON.parse(JSON.stringify(selectedPlayers));

    if (state.tournamentName) {
      saveTournamentHistory();
    }

    // Build full team records for guest teams staged on the form — no login
    // account, just enough to appear in standings/bracket/players like any
    // other team for this tournament.
    const newGuestTeams = pendingGuestTeams.map(g => ({
      id: g.id,
      name: g.name,
      email: `guest-${g.id}@tournament.local`,
      contact: '',
      badge: g.badge || '',
      coachName: '',
      coachPhoto: '',
      coachDob: '',
      divisions: g.divisions,
      guest: true,
      createdAt: new Date().toISOString()
    }));

    state = defaultState();
    state.tournamentName = payload.tournamentName;
    state.tournamentHost = payload.tournamentHost;
    state.tournamentNumber = payload.tournamentNumber;
    state.tournamentInfo = payload.tournamentInfo;
    state.tournamentType = payload.tournamentType;
    state.knockoutSize = payload.tournamentType === 'Knockout' ? payload.knockoutSize : null;
    state.teams = [...carriedTeams, ...newGuestTeams];
    state.players = carriedPlayers;

    const guestNote = newGuestTeams.length ? `, ${newGuestTeams.length} new team${newGuestTeams.length === 1 ? '' : 's'} added` : '';
    pushUpdate({
      id: uid(),
      type: 'tournament_create',
      text: carriedTeams.length || newGuestTeams.length
        ? `Tournament ${payload.tournamentName} created with ${carriedTeams.length} team${carriedTeams.length === 1 ? '' : 's'} carried over${guestNote}.`
        : `Tournament ${payload.tournamentName} created.`,
      createdAt: new Date().toISOString()
    });

    pendingGuestTeams = [];
    saveCurrentTournament();
    return { ok: true, message: 'Tournament created successfully.' };
  }

  function saveTournamentUI() {
    const status = document.getElementById('tournamentAdminStatus');
    const res = createTournamentFromAdminForm();
    if (status) {
      status.textContent = res.message;
      status.className = res.ok ? 'status ok' : 'status error';
    }
    if (res.ok) {
      showToast('Tournament created.', 'ok');
      renderAdmin();
    }
  }

  function toggleKnockoutSizeUI() {
    const type = document.getElementById('newTournamentType')?.value;
    const box = document.getElementById('newTournamentKnockoutSize');
    if (box) box.style.display = type === 'Knockout' ? 'block' : 'none';
  }

  function saveTournamentHistory() {
    if (!state.tournamentName) return;
    archive.unshift({ id: uid(), ...state, createdAt: new Date().toISOString() });
    saveArchive();
  }

  function init(page) {
    currentPage = page;
    highlightNav();
    renderPage();
  }

  return {
    init,
    toggleNav,
    ui: {
      teamRegister: teamRegisterUI,
      teamLogin: teamLoginUI,
      teamSignOut: teamSignOutUI,
      addDivision: addDivisionUI,
      addPlayerToDivision: addPlayerToDivisionUI,
      removePlayer: removePlayerUI,
      openEditPlayerModal: openEditPlayerModalUI,
      closeEditPlayerModal: closeEditPlayerModalUI,
      saveEditPlayer: saveEditPlayerUI,
      saveTeamProfile: saveTeamProfileUI,
      loadChallengeDivisions: loadChallengeDivisionsUI,
      challengeTeam: sendChallengeUI,
      respondChallenge: respondChallengeUI,
      cancelChallenge: cancelChallengeUI,
      setChallengeFilter: setChallengeFilterUI,
      openScoreModal: openScoreModalUI,
      closeScoreModal: closeScoreModalUI,
      saveChallengeScore: saveChallengeScoreUI,
      openLineupModal: openLineupModalUI,
      closeLineupModal: closeLineupModalUI,
      saveLineup: saveLineupUI,
      generateBracket: generateBracketUI,
      resetBracket: resetBracketUI,
      openBracketScoreModal: openBracketScoreModalUI,
      closeBracketScoreModal: closeBracketScoreModalUI,
      saveBracketScore: saveBracketScoreUI,
      openBracketLineupModal: openBracketLineupModalUI,
      closeBracketLineupModal: closeBracketLineupModalUI,
      saveBracketLineup: saveBracketLineupUI,
      adminSignIn: adminSignInUI,
      adminSignOut: adminSignOutUI,
      createTournament: saveTournamentUI,
      setCarryOverTeams: setCarryOverTeamsUI,
      addGuestTeam: addGuestTeamUI,
      removeGuestTeam: removeGuestTeamUI,
      toggleKnockoutSize: toggleKnockoutSizeUI,
      saveHostProfile: saveHostProfileUI,
      onRecordMatchTeamsChange: onRecordMatchTeamsChangeUI,
      recordMatchResult: recordMatchResultUI,
      searchBlog: searchBlogUI,
      publishBlogPost: publishBlogPostUI,
      editBlogPost: editBlogPostUI,
      cancelEditBlogPost: cancelEditBlogPostUI,
      deleteBlogPost: deleteBlogPostUI,
      loadHistory: loadHistoryUI,
      filterPlayers: filterPlayersUI,
      filterAdminTeams: filterAdminTeamsUI,
      exportStandings: exportStandingsCSVUI,
      exportRoster: exportRosterCSVUI,
      printStandings: printStandingsUI,
      downloadCurrentTournamentPdf: downloadCurrentTournamentPdfUI,
      downloadArchivedTournamentPdf: downloadArchivedTournamentPdfUI,
      exportAllData: exportAllDataUI,
      importAllData: importAllDataUI,
      headToHead: renderHeadToHeadUI,
      openForgotPassword: openForgotPasswordUI,
      closeForgotPassword: closeForgotPasswordUI,
      submitPasswordReset: submitPasswordResetUI
    }
  };
})();

window.App = App;

// ---- PWA: register service worker for installability + offline app shell --
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Registration can fail on file:// or unsupported browsers; the app
      // still works fully online without it.
    });
  });
}