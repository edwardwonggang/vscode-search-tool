(() => {
  const state = { skip: 0, limit: 50, hasMore: false, selectedHash: '', selectedProject: '' };
  const repositoryPath = document.getElementById('repositoryPath');
  const projectSelect = document.getElementById('projectSelect');
  const branchValue = document.getElementById('branchValue');
  const headValue = document.getElementById('headValue');
  const refsValue = document.getElementById('refsValue');
  const commitCount = document.getElementById('commitCount');
  const commitList = document.getElementById('commitList');
  const loadMoreButton = document.getElementById('loadMoreButton');
  const refreshButton = document.getElementById('refreshButton');
  const detailTitle = document.getElementById('detailTitle');
  const detailMeta = document.getElementById('detailMeta');
  const detailAuthor = document.getElementById('detailAuthor');
  const changedFiles = document.getElementById('changedFiles');
  const diff = document.getElementById('diff');
  const errorBox = document.getElementById('errorBox');

  async function getJson(path) {
    const response = await fetch(path);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  }

  function projectQuery() {
    return `project=${encodeURIComponent(state.selectedProject)}`;
  }

  function showError(error) {
    errorBox.textContent = error instanceof Error ? error.message : String(error);
    errorBox.hidden = false;
  }

  function clearError() {
    errorBox.hidden = true;
    errorBox.textContent = '';
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }

  function renderSummary(summary) {
    repositoryPath.textContent = summary.repository;
    branchValue.textContent = summary.branch || 'detached';
    headValue.textContent = summary.head ? summary.head.slice(0, 12) : 'No commits';
    refsValue.textContent = String(summary.refs.length);
  }

  function renderProjects(projects) {
    projectSelect.replaceChildren();
    projects.forEach((project) => {
      const option = document.createElement('option');
      option.value = project.id;
      option.textContent = project.name;
      projectSelect.appendChild(option);
    });
    projectSelect.disabled = projects.length === 0;
    if (!state.selectedProject || !projects.some((project) => project.id === state.selectedProject)) {
      state.selectedProject = projects[0]?.id || '';
    }
    projectSelect.value = state.selectedProject;
    if (!state.selectedProject) repositoryPath.textContent = 'No local projects registered';
  }

  function createCommitButton(commit) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `commit${commit.hash === state.selectedHash ? ' selected' : ''}`;
    const subject = document.createElement('span');
    subject.className = 'commit-subject';
    subject.textContent = commit.subject || '(no subject)';
    const meta = document.createElement('span');
    meta.className = 'commit-meta';
    meta.textContent = `${commit.shortHash} · ${commit.author} · ${formatDate(commit.date)}`;
    button.append(subject, meta);
    button.addEventListener('click', () => selectCommit(commit.hash));
    return button;
  }

  function renderCommits(commits, replace) {
    if (replace) commitList.replaceChildren();
    commits.forEach((commit) => commitList.appendChild(createCommitButton(commit)));
    commitCount.textContent = `${commitList.children.length} loaded`;
  }

  async function loadCommits(replace) {
    const skip = replace ? 0 : state.skip;
    const data = await getJson(`/api/commits?${projectQuery()}&skip=${skip}&limit=${state.limit}`);
    state.skip = data.skip + data.commits.length;
    state.hasMore = data.hasMore;
    renderCommits(data.commits, replace);
    loadMoreButton.hidden = !state.hasMore;
    if (replace && data.commits[0]) await selectCommit(data.commits[0].hash);
  }

  async function selectCommit(hash) {
    state.selectedHash = hash;
    detailTitle.textContent = 'Loading commit...';
    try {
      const data = await getJson(`/api/commit/${encodeURIComponent(hash)}?${projectQuery()}`);
      detailTitle.textContent = data.commit.subject || '(no subject)';
      detailMeta.textContent = `${data.commit.shortHash} · ${formatDate(data.commit.date)}`;
      detailAuthor.textContent = `${data.commit.author} <${data.commit.email}>`;
      changedFiles.textContent = data.files.join('\n') || 'No changed files';
      diff.textContent = data.diff || 'No diff';
      Array.from(commitList.children).forEach((item) => item.classList.remove('selected'));
      const selected = Array.from(commitList.children).find((item) => item.textContent.includes(hash.slice(0, 7)));
      selected?.classList.add('selected');
    } catch (error) {
      showError(error);
    }
  }

  async function refreshProject() {
    state.skip = 0;
    state.selectedHash = '';
    commitList.replaceChildren();
    if (!state.selectedProject) return;
    renderSummary(await getJson(`/api/summary?${projectQuery()}`));
    await loadCommits(true);
  }

  async function refresh() {
    clearError();
    try {
      const data = await getJson('/api/projects');
      renderProjects(data.projects);
      await refreshProject();
    } catch (error) {
      showError(error);
    }
  }

  loadMoreButton.addEventListener('click', () => void loadCommits(false).catch(showError));
  refreshButton.addEventListener('click', () => void refresh());
  projectSelect.addEventListener('change', () => {
    state.selectedProject = projectSelect.value;
    void refreshProject().catch(showError);
  });
  void refresh();
})();
